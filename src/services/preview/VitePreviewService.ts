/**
 * VitePreviewService - isolated Project Preview lifecycle.
 *
 * Agent files are treated as untrusted input: paths and dependencies are
 * validated, source and asset reads cross bounded native no-follow boundaries,
 * files are materialized in an owned app-cache staging directory. Snippets use
 * an AgentVis-owned server configuration; complete projects may load their
 * staged Vite toolchain configuration behind AgentVis-owned server boundaries.
 * Every server process is tracked by PID and health token and is stopped when
 * superseded or closed.
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import {
  analyzeHtmlImports,
  collectBareImportPackageRoots,
  collectModuleSpecifiers,
  normalizeImportMapImports,
  normalizeImportMapScopes,
  resolveImportMapSpecifierForReferrer,
  shouldUseStaticImportMapPreview,
  type HtmlImportMapAnalysis,
} from './importMapAnalysis';
import { portAllocator } from './PortAllocator';
import { copySafePreviewAssets } from './previewAssetCopier';
import {
  buildPreviewPackageJson,
  getDeclaredPackageNames,
  getExtraDependencies,
  getTemplatePackageNames,
  getUnsupportedPreviewBuildTool,
  parsePreviewDependencies,
  type PreviewDependencies,
} from './previewDependencyPolicy';
import {
  PreviewServiceError,
  createPreviewInstallError,
  extractPreviewHttpErrorDetail,
  isPreviewCancellation,
} from './previewErrors';
import {
  analyzePreviewProjectEntry,
  buildPreviewProjectPlan,
  type PreviewProjectEntryAnalysis,
} from './previewProjectPlan';
import {
  MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
  enforcePreviewSourceBudgets,
  isSafePreviewSourcePath,
} from './previewSourcePolicy';
import {
  ProjectPathValidationError,
  normalizeProjectFiles,
  normalizeProjectRelativePath,
} from './projectPathPolicy';
import { templateManager, type TemplateInstallExecution } from './TemplateManager';
import { extractSafeTailwindTheme, type SafeTailwindTheme } from './tailwindThemePolicy';
import { buildStaticPreviewServerScript, buildTrustedViteConfig } from './trustedPreviewRuntime';
import type { ProjectFile, TemplateConfig, TemplateId, ViteServerState } from './types';

const logger = getLogger('VitePreviewService');

const MIN_NODE_MAJOR_VERSION = 18;
const START_TIMEOUT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 250;
const PROCESS_MONITOR_INTERVAL_MS = 750;
const INSTALL_TIMEOUT_SECS = 300;
const ERROR_DETAIL_LIMIT = 2_000;
const STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_WORKSPACES_PER_SWEEP = 128;
const MAX_CLEANUP_BACKLOG_SIZE = 128;
const MAX_TRACKED_STALE_RECOVERIES = 128;
const MAX_CLEANUP_RETRIES_PER_MAINTENANCE = 4;
const MAX_AUTOMATIC_CLEANUP_RETRIES = 3;
const MAX_STALE_SWEEP_ATTEMPTS_PER_ACTIVATION = 3;
const CLEANUP_BACKLOG_RETRY_DELAY_MS = 5_000;
const STALE_SWEEP_PAGE_RETRY_DELAY_MS = 1_000;
const STALE_SWEEP_REFUSED_RETRY_DELAY_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MODULE_URL_ORIGIN = 'https://agentvis-preview.invalid';
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const DRIVE_QUALIFIED_PATH = /^[a-z]:/i;

interface ShellExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  pid?: number;
}

interface BackgroundProcessStatus {
  pid: number;
  status: 'running' | 'exited';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncatedBytes: number;
  stderrTruncatedBytes: number;
}

interface PreviewRequest {
  deliverableDir: string;
  projectName: string;
  templateId: TemplateId;
  files: ProjectFile[];
  projectPackageJson?: string;
  assetDestinationPrefix: string;
  projectRequestId: number | null;
  completeProject: boolean;
  omittedEnvironmentFiles: number;
}

interface PreviewRun {
  id: string;
  generation: number;
  projectRequestId: number | null;
  mode: 'static' | 'vite';
  workspaceDir: string | null;
  ownerToken: string | null;
  port: number | null;
  pid: number | null;
  healthToken: string;
  installExecutionIds: Set<string>;
  cancellation: Promise<void>;
  signalCancellation: () => void;
  lastHeartbeatAt: number;
  stopping: boolean;
}

interface PreviewWorkspaceCreateResult {
  workspace: string;
  runId: string;
  ownerToken: string;
}

interface PreviewWorkspaceCleanupResult {
  status: 'removed' | 'not-found' | 'refused';
  reason?: string;
  quarantinedWorkspace?: string;
}

interface PreviewStaleWorkspacesCleanupResult {
  removed: number;
  refused: number;
  notFound: number;
  hasMore: boolean;
  results: Array<{
    runId: string;
    status: 'removed' | 'not-found' | 'refused';
    reason?: string;
    quarantinedWorkspace?: string;
  }>;
}

interface PreviewCleanupBacklogEntry {
  workspace: string;
  runId: string;
  ownerToken: string;
}

interface PreparedProject {
  validationPaths: string[];
  projectViteConfigPath: string | null;
  usesProjectCssConfig: boolean;
}

function createOpaqueId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function cloneRequest(request: PreviewRequest): PreviewRequest {
  return {
    ...request,
    files: request.files.map((file) => ({ ...file })),
  };
}

function createCancellationGate(): { promise: Promise<void>; signal: () => void } {
  let signal = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}

function tail(value: string | null | undefined, limit = ERROR_DETAIL_LIMIT): string {
  const normalized = value?.trim() ?? '';
  return normalized.length <= limit ? normalized : `…${normalized.slice(-limit)}`;
}

function getModulePathExtension(specifier: string): string {
  const path = specifier.split(/[?#]/u, 1)[0]?.toLowerCase() ?? '';
  const match = /(?:^|\/)(?:[^/]+)(\.[^./]+)$/u.exec(path);
  return match?.[1] ?? '';
}

function isBareBrowserModuleSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('\\') &&
    !DRIVE_QUALIFIED_PATH.test(specifier) &&
    !URL_SCHEME.test(specifier)
  );
}

function sanitizeCssForTailwindV3(css: string): string {
  return css
    .replace(
      /^@import\s+["']tailwindcss["']\s*;?\s*$/gm,
      '@tailwind base;\n@tailwind components;\n@tailwind utilities;'
    )
    .replace(
      /^@import\s+["']tailwindcss\/[^"']+["']\s*;?\s*$/gm,
      '/* [AgentVis Preview] unsupported Tailwind v4 sub-import removed */'
    )
    .replace(/@theme\s*\{([^}]*)\}/gs, ':root {$1}');
}

function getProcessFailureDetail(status: BackgroundProcessStatus): string {
  const output = tail(status.stderr || status.stdout);
  const truncation = status.stderrTruncatedBytes || status.stdoutTruncatedBytes;
  const prefix = `exit=${status.exitCode ?? 'unknown'}${truncation ? `, truncated=${truncation}` : ''}`;
  return output ? `${prefix}\n${output}` : prefix;
}

class VitePreviewService {
  private state: ViteServerState = {
    status: 'idle',
    url: null,
    pid: null,
    projectDir: null,
    templateId: null,
    error: null,
  };

  private generation = 0;
  private currentProjectRequestId: number | null = null;
  private activeRun: PreviewRun | null = null;
  private lastRequest: PreviewRequest | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private cleanupRegistered = false;
  private staleSweepCompleted = false;
  private readonly cleanupBacklog = new Map<string, PreviewCleanupBacklogEntry>();
  private readonly automaticCleanupRetriesRemaining = new Map<string, number>();
  private readonly staleRecoveryDueByRunId = new Map<string, number>();
  private staleRecoveryOverflowEarliestAt: number | null = null;
  private staleRecoveryOverflowLatestAt: number | null = null;
  private cleanupMaintenancePromise: Promise<void> | null = null;
  private explicitCleanupMaintenanceFollowUpRequested = false;
  private cleanupMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupMaintenanceTimerDueAt: number | null = null;
  private nextBacklogRetryAt: number | null = null;
  private staleSweepRetryAt: number | null = null;
  private staleSweepAttemptCount = 0;
  private staleSweepRetryPaused = false;
  private cleanupMaintenanceStopped = false;

  getState(): Readonly<ViteServerState> {
    return { ...this.state };
  }

  /** Start a fresh isolated preview. projectName is metadata, never a disk path. */
  startProject(
    deliverableDir: string,
    projectName: string,
    templateId: TemplateId,
    files: ProjectFile[],
    projectPackageJson?: string,
    assetDestinationPrefix = '',
    projectRequestId: number | null = null,
    completeProject = false,
    omittedEnvironmentFiles = 0
  ): Promise<string> {
    const request = cloneRequest({
      deliverableDir,
      projectName,
      templateId,
      files,
      projectPackageJson,
      assetDestinationPrefix,
      projectRequestId,
      completeProject,
      omittedEnvironmentFiles,
    });
    this.lastRequest = cloneRequest(request);
    this.currentProjectRequestId = request.projectRequestId;

    const generation = ++this.generation;
    const cancellation = this.cancelCurrentActivity();
    this.registerCleanupOnClose();

    const startPromise = this.enqueue(async () => {
      await cancellation;
      this.assertCurrent(generation);
      if (this.activeRun) await this.cleanupRun(this.activeRun);
      return this.startProjectLocked(request, generation);
    });

    return startPromise.catch((error: unknown) => {
      const normalizedError = this.addRequestErrorHints(
        this.normalizeStartError(error, generation),
        request
      );
      if (generation === this.generation && !isPreviewCancellation(normalizedError)) {
        this.updateState(
          {
            status: 'error',
            url: null,
            pid: null,
            projectDir: null,
            templateId: request.templateId,
            error: normalizedError.message,
          },
          request.projectRequestId
        );
      }
      throw normalizedError;
    });
  }

  /** Retry the last explicit start request after fully replacing its runtime. */
  retryLastProject(expectedProjectRequestId?: number): Promise<string> {
    if (!this.lastRequest) {
      return Promise.reject(new PreviewServiceError('retry-unavailable'));
    }
    if (
      expectedProjectRequestId !== undefined &&
      this.lastRequest.projectRequestId !== expectedProjectRequestId
    ) {
      return Promise.reject(new PreviewServiceError('cancelled'));
    }
    const request = cloneRequest(this.lastRequest);
    return this.startProject(
      request.deliverableDir,
      request.projectName,
      request.templateId,
      request.files,
      request.projectPackageJson,
      request.assetDestinationPrefix,
      request.projectRequestId,
      request.completeProject,
      request.omittedEnvironmentFiles
    );
  }

  /** Cancel startup immediately, then serialize owned resource cleanup. */
  async stopProject(expectedProjectRequestId?: number): Promise<void> {
    if (
      expectedProjectRequestId !== undefined &&
      this.currentProjectRequestId !== expectedProjectRequestId
    ) {
      return;
    }
    this.currentProjectRequestId = null;
    ++this.generation;
    const cancellation = this.cancelCurrentActivity();
    await this.enqueue(async () => {
      await cancellation;
      if (this.activeRun) await this.cleanupRun(this.activeRun);
      this.updateState(
        {
          status: 'idle',
          url: null,
          pid: null,
          projectDir: null,
          templateId: null,
          error: null,
        },
        null
      );
    });
  }

  /** Kept for compatibility; Preview never kills processes merely for owning a port. */
  cleanupOrphanedProcesses(): Promise<void> {
    logger.debug(
      '[VitePreviewService] Orphan port scanning is disabled; only owned PIDs are managed'
    );
    return Promise.resolve();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async startProjectLocked(request: PreviewRequest, generation: number): Promise<string> {
    if (
      !Number.isSafeInteger(request.omittedEnvironmentFiles) ||
      request.omittedEnvironmentFiles < 0 ||
      request.omittedEnvironmentFiles > MAX_PREVIEW_SOURCE_SCAN_ENTRIES
    ) {
      throw new PreviewServiceError('unsafe-path', 'environment-file-count');
    }
    let normalizedInputFiles: ProjectFile[];
    try {
      normalizedInputFiles = normalizeProjectFiles(request.files);
    } catch (error) {
      if (error instanceof ProjectPathValidationError) {
        throw new PreviewServiceError('unsafe-path', `${error.code}: ${tail(error.input, 240)}`);
      }
      throw error;
    }

    const tailwindTheme =
      request.templateId === 'vanilla' || request.completeProject
        ? null
        : await extractSafeTailwindTheme(normalizedInputFiles);
    if (tailwindTheme) {
      logger.debug('[VitePreviewService] Applied safely parsed Tailwind theme data');
    }
    const normalizedFiles = normalizedInputFiles.filter((file) => {
      const accepted = isSafePreviewSourcePath(file.path, {
        allowProjectToolchainConfig: request.completeProject,
      });
      if (!accepted) logger.warn('[VitePreviewService] Ignored untrusted preview path:', file.path);
      return accepted;
    });

    enforcePreviewSourceBudgets(normalizedFiles);
    const dependencies = parsePreviewDependencies(request.projectPackageJson);
    const templateConfig = templateManager.getTemplateConfig(request.templateId);
    const entryAnalysis = analyzePreviewProjectEntry(normalizedFiles);
    if (request.completeProject) this.assertCompleteProjectEntry(entryAnalysis, dependencies);

    const effectiveHtmlEntry = entryAnalysis.providedIndex ?? entryAnalysis.standaloneHtmlEntry;
    const importMapAnalysis = effectiveHtmlEntry
      ? analyzeHtmlImports(effectiveHtmlEntry.content)
      : null;
    const staticCandidate =
      request.projectPackageJson === undefined &&
      request.templateId === 'vanilla' &&
      importMapAnalysis?.hasImportMap === true;
    const useStaticMode = staticCandidate && shouldUseStaticImportMapPreview(normalizedFiles);
    if (staticCandidate && !useStaticMode) {
      throw new PreviewServiceError('compile-failed', 'invalid-import-map');
    }
    if (useStaticMode) {
      this.assertStaticImportMapCompatible(normalizedFiles, importMapAnalysis);
    }
    if (!useStaticMode) this.assertImportsDeclared(normalizedFiles, dependencies, templateConfig);

    const cancellationGate = createCancellationGate();
    const run: PreviewRun = {
      id: createOpaqueId('project-preview'),
      generation,
      projectRequestId: request.projectRequestId,
      mode: useStaticMode ? 'static' : 'vite',
      workspaceDir: null,
      ownerToken: null,
      port: null,
      pid: null,
      healthToken: createOpaqueId('health'),
      installExecutionIds: new Set(),
      cancellation: cancellationGate.promise,
      signalCancellation: cancellationGate.signal,
      lastHeartbeatAt: 0,
      stopping: false,
    };
    this.activeRun = run;

    this.updateState(
      {
        status: useStaticMode ? 'starting' : 'installing',
        url: null,
        pid: null,
        projectDir: null,
        templateId: request.templateId,
        error: null,
      },
      run.projectRequestId
    );

    try {
      await this.checkNodeEnvironment(run);
      this.assertCurrent(generation);

      await this.maintainPreviewCache();
      this.assertCurrent(generation);

      const createdWorkspace = await this.createWorkspace(run.id);
      run.workspaceDir = createdWorkspace.workspace;
      run.ownerToken = createdWorkspace.ownerToken;
      await this.touchRunHeartbeat(run);
      this.assertCurrent(generation);
      this.updateState({ projectDir: run.workspaceDir }, run.projectRequestId);

      await this.copyProjectAssets(request.deliverableDir, request.assetDestinationPrefix, run);
      this.assertCurrent(generation);

      let templatePath: string | null = null;
      if (!useStaticMode) {
        templatePath = await this.ensureTemplateReady(request.templateId, run);
        this.assertCurrent(generation);
      }

      const prepared = await this.materializeProject(
        run,
        normalizedFiles,
        templateConfig,
        dependencies,
        templatePath,
        request.completeProject
      );
      this.assertCurrent(generation);

      this.updateState({ status: 'starting' }, run.projectRequestId);
      run.port = await portAllocator.allocate();
      this.assertCurrent(generation);
      await this.writeTrustedRuntime(
        run,
        request.templateId,
        templatePath,
        tailwindTheme,
        prepared.projectViteConfigPath,
        prepared.usesProjectCssConfig
      );
      this.assertCurrent(generation);
      run.pid = await this.startServerProcess(run);
      this.assertCurrent(generation);
      this.updateState({ pid: run.pid }, run.projectRequestId);

      const url = `http://localhost:${run.port}`;
      await this.waitForServerReady(run, url);
      await this.verifyProjectResponses(url, prepared.validationPaths);
      this.assertCurrent(generation);

      this.updateState({ status: 'running', url, error: null }, run.projectRequestId);
      void this.monitorProcess(run);
      logger.debug('[VitePreviewService] Preview ready:', {
        mode: run.mode,
        projectName: request.projectName,
        url,
      });
      return url;
    } catch (error) {
      const normalizedError = this.addRequestErrorHints(
        this.normalizeStartError(error, generation),
        request
      );
      await this.cleanupRun(run);

      if (generation === this.generation && !isPreviewCancellation(normalizedError)) {
        this.updateState(
          {
            status: 'error',
            url: null,
            pid: null,
            projectDir: null,
            error: normalizedError.message,
          },
          run.projectRequestId
        );
      }
      throw normalizedError;
    }
  }

  private assertCompleteProjectEntry(
    analysis: PreviewProjectEntryAnalysis,
    dependencies: PreviewDependencies
  ): void {
    if (analysis.providedIndex || analysis.standaloneHtmlEntry) return;
    if (analysis.rootHtmlFiles.length > 1) {
      throw new PreviewServiceError(
        'ambiguous-entry',
        analysis.rootHtmlFiles
          .slice(0, 8)
          .map((file) => file.path)
          .join(', ')
      );
    }
    if (analysis.providedEntryPath || analysis.projectViteConfigPath) return;

    const unsupportedBuildTool = getUnsupportedPreviewBuildTool(dependencies);
    if (unsupportedBuildTool) {
      throw new PreviewServiceError('unsupported-project', `build-tool: ${unsupportedBuildTool}`);
    }
    if (analysis.nestedProjectRoots.length > 0) {
      throw new PreviewServiceError(
        'nested-project',
        analysis.nestedProjectRoots.slice(0, 8).join(', ')
      );
    }
    throw new PreviewServiceError('entry-not-found');
  }

  private assertStaticImportMapCompatible(
    files: readonly ProjectFile[],
    analysis: HtmlImportMapAnalysis
  ): void {
    const transformedFile = files.find((file) => /\.(?:cjs|jsx|ts|tsx|vue)$/i.test(file.path));
    if (transformedFile) {
      throw new PreviewServiceError(
        'compile-failed',
        `import-map-native-js-only: ${transformedFile.path}`
      );
    }

    const nativeModuleExtensions = new Set(['.js', '.mjs']);
    const unsupportedModuleExtensions = new Set(['.cjs', '.css', '.jsx', '.ts', '.tsx', '.vue']);
    const sourceFiles = new Map(
      files
        .filter((file) => nativeModuleExtensions.has(getModulePathExtension(file.path)))
        .map((file) => [file.path, file.content] as const)
    );
    let documentBaseUrl: string;
    try {
      documentBaseUrl = new URL(
        analysis.baseHref ?? '/index.html',
        `${MODULE_URL_ORIGIN}/index.html`
      ).href;
    } catch (error) {
      throw new PreviewServiceError('compile-failed', 'invalid-base-url', { cause: error });
    }
    const normalizedImportMap = normalizeImportMapImports(analysis.imports, documentBaseUrl);
    const normalizedImportMapScopes = normalizeImportMapScopes(analysis.scopes, documentBaseUrl);
    if (normalizedImportMap === null || normalizedImportMapScopes === null) {
      throw new PreviewServiceError('compile-failed', 'invalid-import-map-address');
    }
    const queuedPaths = new Set<string>();
    const queue: { baseUrl: string; label: string; source: string }[] = [];
    const unmapped = new Set<string>();

    const enqueuePath = (path: string, requestedBy: string): void => {
      if (!nativeModuleExtensions.has(getModulePathExtension(path))) {
        throw new PreviewServiceError(
          'compile-failed',
          `import-map-native-js-only: ${requestedBy} -> ${path}`
        );
      }
      const source = sourceFiles.get(path);
      if (source === undefined) {
        throw new PreviewServiceError(
          'compile-failed',
          `missing-local-module: ${requestedBy} -> ${path}`
        );
      }
      if (queuedPaths.has(path)) return;
      queuedPaths.add(path);
      queue.push({ baseUrl: new URL(`/${path}`, MODULE_URL_ORIGIN).href, label: path, source });
    };

    for (const entry of analysis.moduleEntries) {
      const path = this.resolveStaticLocalModulePath(entry, documentBaseUrl);
      if (path !== null) enqueuePath(path, 'index.html');
    }

    queue.push(
      ...analysis.inlineModuleSources.map((source, index) => ({
        baseUrl: documentBaseUrl,
        label: `index.html#module-${index + 1}`,
        source,
      }))
    );

    for (const module of queue) {
      for (const specifier of collectModuleSpecifiers(module.source)) {
        const mappedAddress = resolveImportMapSpecifierForReferrer(
          specifier,
          normalizedImportMap,
          module.baseUrl,
          normalizedImportMapScopes
        );
        if (mappedAddress === null && isBareBrowserModuleSpecifier(specifier)) {
          unmapped.add(specifier);
          continue;
        }

        const address = mappedAddress ?? specifier;
        if (unsupportedModuleExtensions.has(getModulePathExtension(address))) {
          throw new PreviewServiceError(
            'compile-failed',
            `import-map-native-js-only: ${module.label} -> ${address}`
          );
        }
        const path = this.resolveStaticLocalModulePath(
          address,
          mappedAddress === null ? module.baseUrl : documentBaseUrl
        );
        if (path !== null) enqueuePath(path, module.label);
      }
    }

    if (unmapped.size > 0) {
      throw new PreviewServiceError(
        'compile-failed',
        `unmapped-import-map-specifiers: ${[...unmapped].sort().join(', ')}`
      );
    }
  }

  private resolveStaticLocalModulePath(address: string, baseUrl: string): string | null {
    let resolved: URL;
    try {
      resolved = new URL(address, baseUrl);
    } catch (error) {
      throw new PreviewServiceError('compile-failed', `invalid-module-url: ${address}`, {
        cause: error,
      });
    }

    if (resolved.origin !== MODULE_URL_ORIGIN) {
      if (['blob:', 'data:', 'http:', 'https:'].includes(resolved.protocol)) return null;
      throw new PreviewServiceError('compile-failed', `unsupported-module-url: ${address}`);
    }

    try {
      return normalizeProjectRelativePath(
        decodeURIComponent(resolved.pathname).replace(/^\/+/, '')
      );
    } catch (error) {
      throw new PreviewServiceError('compile-failed', `invalid-local-module: ${address}`, {
        cause: error,
      });
    }
  }

  private assertImportsDeclared(
    files: readonly ProjectFile[],
    dependencies: PreviewDependencies,
    templateConfig: TemplateConfig
  ): void {
    const available = new Set([
      ...getTemplatePackageNames(templateConfig),
      ...getDeclaredPackageNames(dependencies),
    ]);
    const missing = new Set<string>();

    for (const file of files) {
      // The lightweight scanner deliberately handles only non-JSX JavaScript/TypeScript.
      // JSX/TSX/Vue templates can contain ordinary `from "text"` markup and are validated
      // by the trusted Vite transform requests before the preview is marked running.
      if (!/\.(?:cjs|cts|js|mjs|mts|ts)$/i.test(file.path)) continue;
      for (const packageName of collectBareImportPackageRoots(file.content)) {
        if (!available.has(packageName)) missing.add(packageName);
      }
    }

    if (missing.size > 0) {
      throw new PreviewServiceError('missing-dependencies', [...missing].sort().join(', '));
    }
  }

  private async createWorkspace(runId: string): Promise<PreviewWorkspaceCreateResult> {
    const result = await invoke<PreviewWorkspaceCreateResult>('preview_create_workspace', {
      runId,
    });
    if (result.runId !== runId || !result.workspace || !result.ownerToken) {
      throw new PreviewServiceError('unsafe-path', 'preview-workspace-owner-mismatch');
    }
    return result;
  }

  private async touchRunHeartbeat(run: PreviewRun): Promise<void> {
    if (!run.workspaceDir || !run.ownerToken) return;
    const now = Date.now();
    if (now - run.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    run.lastHeartbeatAt = now;
    const { join } = await import('@tauri-apps/api/path');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(
      await join(run.workspaceDir, '.agentvis', 'active'),
      JSON.stringify({ id: run.id, ownerToken: run.ownerToken, updatedAtMs: now })
    );
  }

  private maintainPreviewCache(automatic = false): Promise<void> {
    if (this.cleanupMaintenancePromise) {
      if (automatic) return this.cleanupMaintenancePromise;
      this.explicitCleanupMaintenanceFollowUpRequested = true;
      return this.cleanupMaintenancePromise.then(
        async () => {
          if (!this.explicitCleanupMaintenanceFollowUpRequested) return;
          this.explicitCleanupMaintenanceFollowUpRequested = false;
          await this.maintainPreviewCache(false);
        },
        (error: unknown) => {
          this.explicitCleanupMaintenanceFollowUpRequested = false;
          throw error;
        }
      );
    }

    if (!automatic && this.staleSweepRetryPaused) {
      this.staleSweepRetryPaused = false;
      this.staleSweepAttemptCount = 0;
    }
    this.clearCleanupMaintenanceTimer();
    const maintenance = (async () => {
      try {
        await this.performPreviewCacheMaintenance(automatic);
      } finally {
        this.cleanupMaintenancePromise = null;
        this.scheduleNextCleanupMaintenance();
      }
    })();
    this.cleanupMaintenancePromise = maintenance;
    return maintenance;
  }

  private async performPreviewCacheMaintenance(automatic: boolean): Promise<void> {
    await this.drainCleanupBacklog(automatic);
    const now = Date.now();
    const staleRecoveryIsDue =
      !this.staleSweepRetryPaused &&
      ([...this.staleRecoveryDueByRunId.values()].some((eligibleAt) => eligibleAt <= now) ||
        (this.staleRecoveryOverflowEarliestAt !== null &&
          this.staleRecoveryOverflowEarliestAt <= now));
    const staleSweepRetryIsDue =
      !this.staleSweepRetryPaused &&
      this.staleSweepRetryAt !== null &&
      this.staleSweepRetryAt <= now;
    const initialSweepIsDue =
      !this.staleSweepRetryPaused && !this.staleSweepCompleted && this.staleSweepRetryAt === null;
    if (!initialSweepIsDue && !staleRecoveryIsDue && !staleSweepRetryIsDue) return;

    this.staleSweepAttemptCount += 1;
    try {
      const result = await invoke<PreviewStaleWorkspacesCleanupResult>(
        'preview_cleanup_stale_workspaces',
        {
          staleBeforeMs: Date.now() - STALE_WORKSPACE_AGE_MS,
          limit: MAX_STALE_WORKSPACES_PER_SWEEP,
        }
      );
      for (const item of result.results) {
        if (item.status === 'removed' || item.status === 'not-found') {
          this.markStaleRunResolved(item.runId);
        }
      }
      if (!result.hasMore && result.refused === 0) {
        for (const [runId, eligibleAt] of [...this.staleRecoveryDueByRunId]) {
          if (eligibleAt <= now) this.markStaleRunResolved(runId);
        }
        if (
          this.staleRecoveryOverflowEarliestAt !== null &&
          this.staleRecoveryOverflowEarliestAt <= now
        ) {
          if (
            this.staleRecoveryOverflowLatestAt !== null &&
            this.staleRecoveryOverflowLatestAt > now
          ) {
            this.staleRecoveryOverflowEarliestAt = this.staleRecoveryOverflowLatestAt;
          } else {
            this.staleRecoveryOverflowEarliestAt = null;
            this.staleRecoveryOverflowLatestAt = null;
          }
        }
      }

      this.staleSweepCompleted = !result.hasMore && result.refused === 0;
      if (result.hasMore || result.refused > 0) {
        if (this.staleSweepAttemptCount >= MAX_STALE_SWEEP_ATTEMPTS_PER_ACTIVATION) {
          this.staleSweepRetryAt = null;
          this.staleSweepRetryPaused = true;
          logger.warn(
            '[VitePreviewService] Paused automatic stale-workspace sweeps after the bounded attempt budget',
            { hasMore: result.hasMore, refused: result.refused }
          );
        } else {
          this.staleSweepRetryAt =
            now +
            (result.hasMore ? STALE_SWEEP_PAGE_RETRY_DELAY_MS : STALE_SWEEP_REFUSED_RETRY_DELAY_MS);
        }
      } else {
        this.staleSweepAttemptCount = 0;
        this.staleSweepRetryPaused = false;
        this.staleSweepRetryAt = null;
      }
      if (result.refused > 0) {
        logger.warn('[VitePreviewService] Native stale-workspace sweep refused candidates:', {
          refused: result.refused,
          candidates: result.results
            .filter((item) => item.status === 'refused')
            .slice(0, 8)
            .map((item) => ({ runId: item.runId, reason: item.reason })),
        });
      }
    } catch (error) {
      this.staleSweepCompleted = false;
      if (this.staleSweepAttemptCount >= MAX_STALE_SWEEP_ATTEMPTS_PER_ACTIVATION) {
        this.staleSweepRetryAt = null;
        this.staleSweepRetryPaused = true;
        logger.warn(
          '[VitePreviewService] Paused automatic stale-workspace sweeps after repeated failures'
        );
      } else {
        this.staleSweepRetryAt = now + STALE_SWEEP_REFUSED_RETRY_DELAY_MS;
      }
      logger.warn('[VitePreviewService] Failed to sweep stale preview workspaces:', error);
    }
  }

  private async drainCleanupBacklog(automatic = false): Promise<void> {
    const retries = [...this.cleanupBacklog.values()]
      .filter(
        (entry) =>
          !automatic || (this.automaticCleanupRetriesRemaining.get(entry.workspace) ?? 0) > 0
      )
      .slice(0, MAX_CLEANUP_RETRIES_PER_MAINTENANCE);
    this.nextBacklogRetryAt = null;
    for (const entry of retries) {
      // Remove before retrying so another refusal is appended at the tail. This keeps
      // a permanently busy prefix from starving later cleanup entries.
      this.cleanupBacklog.delete(entry.workspace);
      if (automatic) {
        const remaining = this.automaticCleanupRetriesRemaining.get(entry.workspace) ?? 0;
        this.automaticCleanupRetriesRemaining.set(entry.workspace, Math.max(0, remaining - 1));
      }
      await this.cleanupWorkspace(entry.workspace, entry.runId, entry.ownerToken, automatic);
    }
    if (this.hasAutomaticCleanupRetries()) {
      this.nextBacklogRetryAt = Date.now() + CLEANUP_BACKLOG_RETRY_DELAY_MS;
    }
  }

  private async copyProjectAssets(
    sourceRoot: string,
    destinationPrefix: string,
    run: PreviewRun
  ): Promise<void> {
    if (!run.workspaceDir || !run.ownerToken) {
      throw new PreviewServiceError('unsafe-path', 'preview-workspace-owner-missing');
    }
    const result = await copySafePreviewAssets(
      {
        sourceRoot,
        workspace: run.workspaceDir,
        runId: run.id,
        ownerToken: run.ownerToken,
        destinationPrefix,
      },
      () => this.assertCurrent(run.generation)
    );
    logger.debug('[VitePreviewService] Staged safe assets:', result);
  }

  private async ensureTemplateReady(templateId: TemplateId, run: PreviewRun): Promise<string> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const preparation = templateManager.beginTemplatePreparation(
          templateId,
          (message) => logger.debug('[VitePreviewService] Template:', message),
          () => this.acquireTemplateInstallExecution(run)
        );
        try {
          return await Promise.race([
            preparation.readiness,
            run.cancellation.then(() => {
              throw new PreviewServiceError('cancelled');
            }),
          ]);
        } catch (error) {
          this.assertCurrent(run.generation);
          if (!preparation.joinedExistingPreparation || attempt === 1) throw error;
          logger.warn(
            '[VitePreviewService] Shared template preparation failed; retrying once for the active preview'
          );
        }
      }
      throw new PreviewServiceError('install-failed', 'template-preparation');
    } catch (error) {
      this.assertCurrent(run.generation);
      if (isPreviewCancellation(error)) throw error;
      const detail =
        error instanceof PreviewServiceError
          ? tail(error.detail ?? error.message)
          : tail(this.errorMessage(error));
      throw createPreviewInstallError(detail, { cause: error });
    }
  }

  private async materializeProject(
    run: PreviewRun,
    files: readonly ProjectFile[],
    templateConfig: TemplateConfig,
    dependencies: PreviewDependencies,
    templatePath: string | null,
    completeProject = false
  ): Promise<PreparedProject> {
    if (!run.workspaceDir) throw new PreviewServiceError('server-start-failed', 'workspace');
    const workspace = run.workspaceDir;
    const plan = buildPreviewProjectPlan(files, templateConfig, run.mode, completeProject);
    const stagedFiles = plan.stagedFiles;

    if (!completeProject) {
      for (const [path, content] of stagedFiles) {
        if (path.toLowerCase().endsWith('.css')) {
          stagedFiles.set(path, sanitizeCssForTailwindV3(content));
        }
      }
    }

    const { join } = await import('@tauri-apps/api/path');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    for (const [relativePath, content] of stagedFiles) {
      this.assertCurrent(run.generation);
      await this.ensureParentDirectory(workspace, relativePath);
      this.assertCurrent(run.generation);
      const destinationPath = await join(workspace, ...relativePath.split('/'));
      this.assertCurrent(run.generation);
      await writeTextFile(destinationPath, content);
    }
    this.assertCurrent(run.generation);

    const indexHtml = plan.indexHtmlPath ? stagedFiles.get(plan.indexHtmlPath) : undefined;
    if (!indexHtml && !(completeProject && plan.projectViteConfigPath)) {
      throw new PreviewServiceError('compile-failed', 'index.html is missing');
    }

    if (run.mode === 'vite') {
      if (!templatePath) throw new PreviewServiceError('server-start-failed', 'template-path');
      const extras = completeProject
        ? dependencies
        : getExtraDependencies(dependencies, templateConfig);
      const packagePath = await join(workspace, 'package.json');
      this.assertCurrent(run.generation);
      await writeTextFile(
        packagePath,
        buildPreviewPackageJson(
          templateConfig,
          extras,
          completeProject ? (dependencies.packageType ?? 'commonjs') : 'module'
        )
      );
      this.assertCurrent(run.generation);
      if (Object.keys(extras.dependencies).length || Object.keys(extras.devDependencies).length) {
        this.assertCurrent(run.generation);
        await this.installProjectDependencies(run);
      } else {
        this.assertCurrent(run.generation);
        await this.createTemplateJunction(run, templatePath);
      }
      this.assertCurrent(run.generation);
    }

    return {
      validationPaths: plan.validationPaths,
      projectViteConfigPath: plan.projectViteConfigPath,
      usesProjectCssConfig: plan.usesProjectCssConfig,
    };
  }

  private async ensureParentDirectory(basePath: string, relativePath: string): Promise<void> {
    const parentSegments = relativePath.split('/').slice(0, -1);
    if (parentSegments.length === 0) return;
    const { join } = await import('@tauri-apps/api/path');
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    await mkdir(await join(basePath, ...parentSegments), { recursive: true });
  }

  /** Register cancellation only when this run owns the actual shared template install. */
  private acquireTemplateInstallExecution(run: PreviewRun): TemplateInstallExecution {
    if (!this.isRunCurrent(run)) throw new PreviewServiceError('cancelled');

    const executionId = createOpaqueId('preview-template-install');
    run.installExecutionIds.add(executionId);
    let released = false;
    return {
      executionId,
      release: () => {
        if (released) return;
        released = true;
        run.installExecutionIds.delete(executionId);
      },
    };
  }

  private async installProjectDependencies(run: PreviewRun): Promise<void> {
    if (!run.workspaceDir) throw new PreviewServiceError('install-failed', 'workspace');
    this.assertCurrent(run.generation);
    const executionId = createOpaqueId('preview-project-install');
    run.installExecutionIds.add(executionId);
    this.updateState({ status: 'installing' }, run.projectRequestId);
    try {
      const result = await invoke<ShellExecuteResult>('shell_execute', {
        command: 'npm install --ignore-scripts --no-audit --no-fund --package-lock=false',
        workdir: run.workspaceDir,
        timeoutSecs: INSTALL_TIMEOUT_SECS,
        background: false,
        env: null,
        sandboxLevel: 'installer',
        subjectType: 'installer',
        subjectId: 'project-preview-install',
        executionId,
      });
      this.assertCurrent(run.generation);
      if (result.exitCode !== 0) {
        throw createPreviewInstallError(tail(result.stderr || result.stdout));
      }
    } catch (error) {
      this.assertCurrent(run.generation);
      if (error instanceof PreviewServiceError) throw error;
      throw createPreviewInstallError(tail(this.errorMessage(error)), { cause: error });
    } finally {
      run.installExecutionIds.delete(executionId);
    }
  }

  private async createTemplateJunction(run: PreviewRun, templatePath: string): Promise<void> {
    if (!run.workspaceDir) throw new PreviewServiceError('server-start-failed', 'workspace');
    this.assertCurrent(run.generation);
    const { join } = await import('@tauri-apps/api/path');
    this.assertCurrent(run.generation);
    const target = await join(templatePath, 'node_modules');
    this.assertCurrent(run.generation);
    await this.writeDependencyLinkHelper(run);
    this.assertCurrent(run.generation);

    const executionId = createOpaqueId('preview-dependency-link');
    run.installExecutionIds.add(executionId);
    let result: ShellExecuteResult;
    try {
      result = await invoke<ShellExecuteResult>('shell_execute', {
        command: 'node ".agentvis/link-dependencies.mjs"',
        workdir: run.workspaceDir,
        timeoutSecs: 20,
        background: false,
        env: { AGENTVIS_NODE_MODULES: target },
        sandboxLevel: 'preview',
        subjectType: 'preview',
        subjectId: 'project-preview-dependency-link',
        executionId,
      });
      this.assertCurrent(run.generation);
    } catch (error) {
      this.assertCurrent(run.generation);
      throw new PreviewServiceError('server-start-failed', tail(this.errorMessage(error)), {
        cause: error,
      });
    } finally {
      run.installExecutionIds.delete(executionId);
    }

    if (result.exitCode !== 0) {
      throw new PreviewServiceError(
        'server-start-failed',
        tail(result.stderr || result.stdout || 'dependency-link-not-created')
      );
    }
  }

  private async writeDependencyLinkHelper(run: PreviewRun): Promise<void> {
    if (!run.workspaceDir) throw new PreviewServiceError('server-start-failed', 'workspace');
    this.assertCurrent(run.generation);
    const { join } = await import('@tauri-apps/api/path');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    this.assertCurrent(run.generation);
    const helperDirectory = await join(run.workspaceDir, '.agentvis');
    this.assertCurrent(run.generation);
    const helperPath = await join(helperDirectory, 'link-dependencies.mjs');
    this.assertCurrent(run.generation);
    await writeTextFile(
      helperPath,
      `import { symlinkSync } from 'node:fs';\nconst target = process.env.AGENTVIS_NODE_MODULES;\nif (!target) throw new Error('Missing dependency target');\nsymlinkSync(target, 'node_modules', 'junction');\n`
    );
    this.assertCurrent(run.generation);
  }

  private async writeTrustedRuntime(
    run: PreviewRun,
    templateId: TemplateId,
    templatePath: string | null,
    tailwindTheme: SafeTailwindTheme | null,
    projectViteConfigPath: string | null,
    usesProjectCssConfig: boolean
  ): Promise<void> {
    if (!run.workspaceDir) throw new PreviewServiceError('server-start-failed', 'workspace');
    this.assertCurrent(run.generation);
    const { join } = await import('@tauri-apps/api/path');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    this.assertCurrent(run.generation);
    const runtimePath =
      run.mode === 'static'
        ? await join(run.workspaceDir, '.agentvis', 'static-server.mjs')
        : await join(run.workspaceDir, '.agentvis', 'vite.config.mjs');
    this.assertCurrent(run.generation);
    const source =
      run.mode === 'static'
        ? buildStaticPreviewServerScript(run.healthToken)
        : buildTrustedViteConfig(
            templateId,
            run.healthToken,
            templatePath ?? run.workspaceDir,
            tailwindTheme,
            { projectConfigPath: projectViteConfigPath, usesProjectCssConfig }
          );
    await writeTextFile(runtimePath, source);
    this.assertCurrent(run.generation);
  }

  private async startServerProcess(run: PreviewRun): Promise<number> {
    if (!run.workspaceDir || run.port === null) {
      throw new PreviewServiceError('server-start-failed', 'runtime-not-prepared');
    }
    this.assertCurrent(run.generation);
    const command =
      run.mode === 'static'
        ? 'node ".agentvis/static-server.mjs"'
        : `node "node_modules/vite/bin/vite.js" --config ".agentvis/vite.config.mjs" --port ${run.port} --strictPort --host 127.0.0.1`;
    const env = run.mode === 'static' ? { AGENTVIS_PREVIEW_PORT: String(run.port) } : null;

    const result = await invoke<ShellExecuteResult>('shell_execute', {
      command,
      workdir: run.workspaceDir,
      timeoutSecs: null,
      background: true,
      env,
      sandboxLevel: 'preview',
      processLifecycle: 'backgroundManaged',
      subjectType: 'preview',
      subjectId: `project-preview-${run.mode}-server`,
    });
    if (result.pid === undefined) {
      throw new PreviewServiceError('server-start-failed', tail(result.stderr || result.stdout));
    }
    // Record ownership before the post-await cancellation check so cleanup can
    // always terminate a process that raced with stop/replacement.
    run.pid = result.pid;
    this.assertCurrent(run.generation);
    return result.pid;
  }

  private async waitForServerReady(run: PreviewRun, url: string): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertCurrent(run.generation);
      const status = await this.getBackgroundStatus(run);
      if (status.status === 'exited') {
        const settledStatus = await this.settleExitedStatus(run, status);
        throw new PreviewServiceError('process-exited', getProcessFailureDetail(settledStatus));
      }

      try {
        const response = await fetch(`${url}/.agentvis/health`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) {
          const body = (await response.json()) as { token?: unknown };
          if (body.token === run.healthToken) return;
        }
      } catch {
        // The owned process is still running; wait for its listener to become ready.
      }
      await this.sleep(STATUS_POLL_INTERVAL_MS);
    }

    const status = await this.getBackgroundStatus(run).catch(() => null);
    throw new PreviewServiceError(
      'server-start-failed',
      status ? getProcessFailureDetail(status) : 'health-check-timeout'
    );
  }

  private async verifyProjectResponses(
    url: string,
    relativePaths: readonly string[]
  ): Promise<void> {
    const paths = new Set(['', ...relativePaths]);
    for (const path of paths) {
      const encodedPath = path
        ? `/${path
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/')}`
        : '/';
      let response: Response;
      try {
        response = await fetch(new URL(encodedPath, url), {
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        throw new PreviewServiceError('compile-failed', tail(this.errorMessage(error)), {
          cause: error,
        });
      }
      if (!response.ok) {
        const detail = extractPreviewHttpErrorDetail(
          await response.text().catch(() => ''),
          ERROR_DETAIL_LIMIT
        );
        throw new PreviewServiceError(
          'compile-failed',
          `${path || 'index.html'}: HTTP ${response.status}${detail ? `\n${detail}` : ''}`
        );
      }
      void response.body?.cancel();
    }
  }

  private async getBackgroundStatus(run: PreviewRun): Promise<BackgroundProcessStatus> {
    if (run.pid === null) throw new PreviewServiceError('server-start-failed', 'missing-pid');
    return invoke<BackgroundProcessStatus>('shell_background_status', { pid: run.pid });
  }

  private async settleExitedStatus(
    run: PreviewRun,
    initialStatus: BackgroundProcessStatus
  ): Promise<BackgroundProcessStatus> {
    await this.sleep(100);
    return this.getBackgroundStatus(run).catch(() => initialStatus);
  }

  private async monitorProcess(run: PreviewRun): Promise<void> {
    while (this.isRunCurrent(run)) {
      await this.sleep(PROCESS_MONITOR_INTERVAL_MS);
      if (!this.isRunCurrent(run)) return;

      let status: BackgroundProcessStatus;
      try {
        status = await this.getBackgroundStatus(run);
      } catch (error) {
        logger.warn(
          '[VitePreviewService] Background status check failed:',
          tail(this.errorMessage(error))
        );
        continue;
      }

      if (status.status === 'running') {
        await this.touchRunHeartbeat(run).catch((error: unknown) => {
          logger.warn(
            '[VitePreviewService] Preview heartbeat update failed:',
            tail(this.errorMessage(error))
          );
        });
        continue;
      }

      try {
        const settledStatus = await this.settleExitedStatus(run, status);
        const error = new PreviewServiceError(
          'process-exited',
          getProcessFailureDetail(settledStatus)
        );
        await this.enqueue(async () => {
          if (run.stopping || run !== this.activeRun || run.generation !== this.generation) return;
          await this.cleanupRun(run);
          this.updateState(
            {
              status: 'error',
              url: null,
              pid: null,
              projectDir: null,
              error: error.message,
            },
            run.projectRequestId
          );
        });
        return;
      } catch (error) {
        logger.warn(
          '[VitePreviewService] Background status check failed:',
          tail(this.errorMessage(error))
        );
      }
    }
  }

  private async cancelCurrentActivity(): Promise<void> {
    const run = this.activeRun;
    if (!run) return;
    run.stopping = true;

    await Promise.allSettled([
      ...[...run.installExecutionIds].map((executionId) =>
        invoke<string>('shell_cancel', { executionId })
      ),
      ...(run.pid !== null ? [invoke<string>('shell_kill', { pid: run.pid })] : []),
    ]);
    run.signalCancellation();
  }

  private async cleanupRun(run: PreviewRun): Promise<void> {
    run.stopping = true;

    if (run.pid !== null) {
      await invoke<string>('shell_kill', { pid: run.pid }).catch((error: unknown) => {
        logger.debug('[VitePreviewService] Owned preview process was already stopped:', error);
      });
      run.pid = null;
    }

    if (run.port !== null) {
      portAllocator.release(run.port);
      run.port = null;
    }

    if (run.workspaceDir && run.ownerToken) {
      await this.cleanupWorkspace(run.workspaceDir, run.id, run.ownerToken);
      run.workspaceDir = null;
      run.ownerToken = null;
    } else if (run.workspaceDir) {
      logger.error(
        '[VitePreviewService] Cannot request native workspace cleanup without an owner token'
      );
      run.workspaceDir = null;
    }

    if (this.activeRun === run) this.activeRun = null;
  }

  private enqueueCleanup(entry: PreviewCleanupBacklogEntry, rearmAutomaticRetry = true): void {
    this.recordStaleRecovery(entry.runId);
    const retriesRemaining = rearmAutomaticRetry
      ? MAX_AUTOMATIC_CLEANUP_RETRIES
      : (this.automaticCleanupRetriesRemaining.get(entry.workspace) ?? 0);
    if (!this.cleanupBacklog.has(entry.workspace)) {
      while (this.cleanupBacklog.size >= MAX_CLEANUP_BACKLOG_SIZE) {
        const oldestWorkspace = this.cleanupBacklog.keys().next().value;
        if (!oldestWorkspace) break;
        this.cleanupBacklog.delete(oldestWorkspace);
        this.automaticCleanupRetriesRemaining.delete(oldestWorkspace);
        logger.warn(
          '[VitePreviewService] Cleanup backlog reached its bound; native stale cleanup will reclaim the oldest workspace later'
        );
      }
    }
    this.cleanupBacklog.set(entry.workspace, entry);
    this.automaticCleanupRetriesRemaining.set(entry.workspace, retriesRemaining);
    if (retriesRemaining > 0) {
      const retryAt = Date.now() + CLEANUP_BACKLOG_RETRY_DELAY_MS;
      this.nextBacklogRetryAt =
        this.nextBacklogRetryAt === null ? retryAt : Math.min(this.nextBacklogRetryAt, retryAt);
    } else if (!this.hasAutomaticCleanupRetries()) {
      this.nextBacklogRetryAt = null;
      logger.warn(
        '[VitePreviewService] Parked workspace cleanup after the automatic retry budget; explicit maintenance can retry it'
      );
    }
    this.scheduleNextCleanupMaintenance();
  }

  private async cleanupWorkspace(
    workspace: string,
    runId: string,
    ownerToken: string,
    fromAutomaticMaintenance = false
  ): Promise<boolean> {
    try {
      const result = await invoke<PreviewWorkspaceCleanupResult>('preview_cleanup_workspace', {
        workspace,
        expectedRunId: runId,
        expectedOwnerToken: ownerToken,
        staleBeforeMs: null,
      });
      if (result.status === 'removed' || result.status === 'not-found') {
        this.markCleanupResolved(workspace, runId);
        return true;
      }
      if (result.quarantinedWorkspace) {
        this.cleanupBacklog.delete(workspace);
        this.automaticCleanupRetriesRemaining.delete(workspace);
        if (!this.hasAutomaticCleanupRetries()) this.nextBacklogRetryAt = null;
        this.recordStaleRecovery(runId);
        logger.warn(
          '[VitePreviewService] Native cleanup left a receipted quarantine for stale recovery:',
          result.reason
        );
        return false;
      }
      this.enqueueCleanup({ workspace, runId, ownerToken }, !fromAutomaticMaintenance);
      logger.warn('[VitePreviewService] Native workspace cleanup was refused:', result.reason);
      return false;
    } catch (error) {
      this.enqueueCleanup({ workspace, runId, ownerToken }, !fromAutomaticMaintenance);
      logger.warn('[VitePreviewService] Native workspace cleanup failed:', error);
      return false;
    }
  }

  private markCleanupResolved(workspace: string, runId: string): void {
    this.cleanupBacklog.delete(workspace);
    this.automaticCleanupRetriesRemaining.delete(workspace);
    this.staleRecoveryDueByRunId.delete(runId);
    if (!this.hasAutomaticCleanupRetries()) this.nextBacklogRetryAt = null;
    this.scheduleNextCleanupMaintenance();
  }

  private recordStaleRecovery(runId: string): void {
    const eligibleAt = Date.now() + STALE_WORKSPACE_AGE_MS;
    const currentEligibleAt = this.staleRecoveryDueByRunId.get(runId);
    let registeredNewRecovery = false;
    if (currentEligibleAt !== undefined) {
      if (eligibleAt < currentEligibleAt) this.staleRecoveryDueByRunId.set(runId, eligibleAt);
    } else if (this.staleRecoveryDueByRunId.size < MAX_TRACKED_STALE_RECOVERIES) {
      this.staleRecoveryDueByRunId.set(runId, eligibleAt);
      registeredNewRecovery = true;
    } else {
      this.staleRecoveryOverflowEarliestAt =
        this.staleRecoveryOverflowEarliestAt === null
          ? eligibleAt
          : Math.min(this.staleRecoveryOverflowEarliestAt, eligibleAt);
      this.staleRecoveryOverflowLatestAt =
        this.staleRecoveryOverflowLatestAt === null
          ? eligibleAt
          : Math.max(this.staleRecoveryOverflowLatestAt, eligibleAt);
      registeredNewRecovery = true;
    }
    if (registeredNewRecovery) {
      this.staleSweepAttemptCount = 0;
      this.staleSweepRetryPaused = false;
    }
    this.scheduleNextCleanupMaintenance();
  }

  private markStaleRunResolved(runId: string): void {
    this.staleRecoveryDueByRunId.delete(runId);
    for (const [workspace, entry] of this.cleanupBacklog) {
      if (entry.runId !== runId) continue;
      this.cleanupBacklog.delete(workspace);
      this.automaticCleanupRetriesRemaining.delete(workspace);
    }
    if (!this.hasAutomaticCleanupRetries()) this.nextBacklogRetryAt = null;
  }

  private hasAutomaticCleanupRetries(): boolean {
    return [...this.cleanupBacklog.keys()].some(
      (workspace) => (this.automaticCleanupRetriesRemaining.get(workspace) ?? 0) > 0
    );
  }

  private scheduleNextCleanupMaintenance(): void {
    if (this.cleanupMaintenanceStopped) {
      this.clearCleanupMaintenanceTimer();
      return;
    }

    if (!this.hasAutomaticCleanupRetries()) this.nextBacklogRetryAt = null;
    let nextDueAt = this.nextBacklogRetryAt;
    if (!this.staleSweepRetryPaused) {
      if (this.staleSweepRetryAt !== null) {
        nextDueAt =
          nextDueAt === null ? this.staleSweepRetryAt : Math.min(nextDueAt, this.staleSweepRetryAt);
      }
      for (const eligibleAt of this.staleRecoveryDueByRunId.values()) {
        nextDueAt = nextDueAt === null ? eligibleAt : Math.min(nextDueAt, eligibleAt);
      }
      if (this.staleRecoveryOverflowEarliestAt !== null) {
        nextDueAt =
          nextDueAt === null
            ? this.staleRecoveryOverflowEarliestAt
            : Math.min(nextDueAt, this.staleRecoveryOverflowEarliestAt);
      }
    }

    if (nextDueAt === null) {
      this.clearCleanupMaintenanceTimer();
      return;
    }
    if (
      this.cleanupMaintenanceTimer !== null &&
      this.cleanupMaintenanceTimerDueAt !== null &&
      this.cleanupMaintenanceTimerDueAt <= nextDueAt
    ) {
      return;
    }

    this.clearCleanupMaintenanceTimer();
    this.cleanupMaintenanceTimerDueAt = nextDueAt;
    this.cleanupMaintenanceTimer = setTimeout(
      () => {
        this.cleanupMaintenanceTimer = null;
        this.cleanupMaintenanceTimerDueAt = null;
        if (this.cleanupMaintenanceStopped) return;
        void this.maintainPreviewCache(true).catch((error: unknown) => {
          logger.warn('[VitePreviewService] Scheduled cache maintenance failed:', error);
        });
      },
      Math.max(0, nextDueAt - Date.now())
    );
  }

  private clearCleanupMaintenanceTimer(): void {
    if (this.cleanupMaintenanceTimer !== null) {
      clearTimeout(this.cleanupMaintenanceTimer);
      this.cleanupMaintenanceTimer = null;
    }
    this.cleanupMaintenanceTimerDueAt = null;
  }

  private stopCleanupMaintenanceScheduler(): void {
    this.cleanupMaintenanceStopped = true;
    this.explicitCleanupMaintenanceFollowUpRequested = false;
    this.nextBacklogRetryAt = null;
    this.staleSweepRetryAt = null;
    this.clearCleanupMaintenanceTimer();
  }

  private async checkNodeEnvironment(run: PreviewRun): Promise<void> {
    this.assertCurrent(run.generation);
    const executionId = createOpaqueId('preview-node-check');
    run.installExecutionIds.add(executionId);
    let result: ShellExecuteResult;
    try {
      result = await invoke<ShellExecuteResult>('shell_execute', {
        command: 'node --version',
        workdir: null,
        timeoutSecs: 10,
        background: false,
        env: null,
        sandboxLevel: 'preview',
        subjectType: 'preview',
        subjectId: 'project-preview-node-check',
        executionId,
      });
    } catch (error) {
      this.assertCurrent(run.generation);
      throw new PreviewServiceError('node-missing', undefined, { cause: error });
    } finally {
      run.installExecutionIds.delete(executionId);
    }
    this.assertCurrent(run.generation);

    const match = result.exitCode === 0 ? result.stdout.trim().match(/^v(\d+)/) : null;
    const major = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
    if (!Number.isFinite(major) || major < MIN_NODE_MAJOR_VERSION) {
      throw new PreviewServiceError(
        'node-missing',
        Number.isFinite(major) ? `v${major} (requires v${MIN_NODE_MAJOR_VERSION}+)` : undefined
      );
    }
  }

  private registerCleanupOnClose(): void {
    if (this.cleanupRegistered || typeof window === 'undefined') return;
    this.cleanupRegistered = true;
    window.addEventListener('beforeunload', () => {
      this.stopCleanupMaintenanceScheduler();
      ++this.generation;
      void this.cancelCurrentActivity();
    });
  }

  private normalizeStartError(error: unknown, generation: number): PreviewServiceError {
    if (generation !== this.generation) return new PreviewServiceError('cancelled');
    if (error instanceof PreviewServiceError) return error;
    return new PreviewServiceError('server-start-failed', tail(this.errorMessage(error)), {
      cause: error,
    });
  }

  private addRequestErrorHints(
    error: PreviewServiceError,
    request: PreviewRequest
  ): PreviewServiceError {
    if (
      request.omittedEnvironmentFiles === 0 ||
      !['compile-failed', 'process-exited', 'server-start-failed'].includes(error.code) ||
      error.hints.length > 0
    ) {
      return error;
    }
    return new PreviewServiceError(error.code, error.detail, { cause: error }, [
      { code: 'environment-files-omitted', count: request.omittedEnvironmentFiles },
    ]);
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new PreviewServiceError('cancelled');
  }

  private isRunCurrent(run: PreviewRun): boolean {
    return !run.stopping && run === this.activeRun && run.generation === this.generation;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private syncToStore(state: ViteServerState, projectRequestId: number | null): void {
    if (projectRequestId === null) return;
    void import('@stores/previewStore')
      .then(({ usePreviewStore }) => {
        const store = usePreviewStore.getState();
        if (!store.isProjectRequestCurrent(projectRequestId)) return;
        if (state.status === 'error') {
          store.setProjectStatus('error', state.error ?? undefined);
        } else {
          store.setProjectStatus(state.status);
        }
        if (state.status === 'running' && state.url && state.templateId) {
          store.setProjectUrl(state.url, state.templateId);
        }
      })
      .catch(() => undefined);
  }

  private updateState(partial: Partial<ViteServerState>, projectRequestId: number | null): void {
    this.state = { ...this.state, ...partial };
    this.syncToStore(this.state, projectRequestId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const vitePreviewService = new VitePreviewService();
