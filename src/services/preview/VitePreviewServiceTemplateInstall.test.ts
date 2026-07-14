/** Project Preview template-install ownership and cancellation regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => 'C:/app-data'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: tauri.exists,
  mkdir: tauri.mkdir,
  readTextFile: tauri.readTextFile,
  remove: tauri.remove,
  writeTextFile: tauri.writeTextFile,
}));

interface InstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TestRun {
  id: string;
  generation: number;
  projectRequestId: number | null;
  mode: 'vite';
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

interface TemplateInstallInternals {
  generation: number;
  activeRun: TestRun | null;
  ensureTemplateReady(templateId: 'vanilla', run: TestRun): Promise<string>;
  cancelCurrentActivity(): Promise<void>;
}

function createRun(generation = 1): TestRun {
  let signalCancellation = (): void => undefined;
  const cancellation = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  return {
    id: 'project-preview-11111111-1111-4111-8111-111111111111',
    generation,
    projectRequestId: null,
    mode: 'vite',
    workspaceDir: null,
    ownerToken: null,
    port: null,
    pid: null,
    healthToken: 'health-token',
    installExecutionIds: new Set(),
    cancellation,
    signalCancellation,
    lastHeartbeatAt: 0,
    stopping: false,
  };
}

async function loadInternals(): Promise<{
  service: TemplateInstallInternals;
  templateManager: typeof import('./TemplateManager').templateManager;
}> {
  vi.resetModules();
  const [{ vitePreviewService }, { templateManager }] = await Promise.all([
    import('./VitePreviewService'),
    import('./TemplateManager'),
  ]);
  return {
    service: vitePreviewService as unknown as TemplateInstallInternals,
    templateManager,
  };
}

function activateRun(service: TemplateInstallInternals, run: TestRun): void {
  service.generation = run.generation;
  service.activeRun = run;
}

describe('VitePreviewService template install ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.exists.mockResolvedValue(false);
    tauri.mkdir.mockResolvedValue(undefined);
    tauri.remove.mockResolvedValue(undefined);
    tauri.writeTextFile.mockResolvedValue(undefined);
  });

  it('registers and cancels the execution owned by the current preview run', async () => {
    let rejectInstall!: (reason: Error) => void;
    const install = new Promise<InstallResult>((_resolve, reject) => {
      rejectInstall = reject;
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_acquire_template_lock') return 'template-lease';
      if (command === 'preview_release_template_lock') return undefined;
      if (command === 'shell_execute') return install;
      if (command === 'shell_cancel') {
        rejectInstall(new Error('template install cancelled'));
        return 'cancelled';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { service } = await loadInternals();
    const run = createRun();
    activateRun(service, run);

    const outcome = service.ensureTemplateReady('vanilla', run).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        'shell_execute',
        expect.objectContaining({
          executionId: expect.stringMatching(/^preview-template-install-/),
        })
      )
    );
    const installArgs = tauri.invoke.mock.calls.find(
      (call) => call[0] === 'shell_execute'
    )?.[1] as {
      executionId: string;
    };
    expect(run.installExecutionIds).toEqual(new Set([installArgs.executionId]));

    service.generation += 1;
    await service.cancelCurrentActivity();

    expect(tauri.invoke).toHaveBeenCalledWith('shell_cancel', {
      executionId: installArgs.executionId,
    });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(run.installExecutionIds.size).toBe(0);
  });

  it('does not cancel a Shell warmup execution that the preview only joined', async () => {
    let resolveInstall!: (result: InstallResult) => void;
    const install = new Promise<InstallResult>((resolve) => {
      resolveInstall = resolve;
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_acquire_template_lock') return 'template-lease';
      if (command === 'preview_release_template_lock') return undefined;
      if (command === 'shell_execute') return install;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { service, templateManager } = await loadInternals();
    const warmup = templateManager.ensureTemplateReady('vanilla');
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        'shell_execute',
        expect.objectContaining({ executionId: undefined })
      )
    );

    const run = createRun();
    activateRun(service, run);
    const previewOutcome = service
      .ensureTemplateReady('vanilla', run)
      .catch((error: unknown) => error);
    expect(run.installExecutionIds.size).toBe(0);

    service.generation += 1;
    await service.cancelCurrentActivity();

    expect(await previewOutcome).toMatchObject({ code: 'cancelled' });
    expect(tauri.invoke.mock.calls.some((call) => call[0] === 'shell_cancel')).toBe(false);
    resolveInstall({ exitCode: 0, stdout: 'installed', stderr: '' });
    await expect(warmup).resolves.toBe('C:/app-data/preview-templates/vanilla');
  });

  it('transfers ownership to a joined preview when the shared owner fails', async () => {
    let rejectFirstInstall!: (reason: Error) => void;
    let resolveSecondInstall!: (result: InstallResult) => void;
    const firstInstall = new Promise<InstallResult>((_resolve, reject) => {
      rejectFirstInstall = reject;
    });
    const secondInstall = new Promise<InstallResult>((resolve) => {
      resolveSecondInstall = resolve;
    });
    let installCount = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_acquire_template_lock') return `template-lease-${installCount + 1}`;
      if (command === 'preview_release_template_lock') return undefined;
      if (command !== 'shell_execute') throw new Error(`Unexpected command: ${command}`);
      installCount += 1;
      return installCount === 1 ? firstInstall : secondInstall;
    });
    const { service, templateManager } = await loadInternals();
    const warmupOutcome = templateManager
      .ensureTemplateReady('vanilla')
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(installCount).toBe(1));

    const run = createRun();
    activateRun(service, run);
    const preview = service.ensureTemplateReady('vanilla', run);
    rejectFirstInstall(new Error('warmup install failed'));

    expect(await warmupOutcome).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(installCount).toBe(2));
    const installCalls = tauri.invoke.mock.calls.filter((call) => call[0] === 'shell_execute');
    expect(installCalls[0]?.[1]).toEqual(expect.objectContaining({ executionId: undefined }));
    const retryExecutionId = (installCalls[1]?.[1] as { executionId: string }).executionId;
    expect(retryExecutionId).toMatch(/^preview-template-install-/);
    expect(run.installExecutionIds).toEqual(new Set([retryExecutionId]));

    resolveSecondInstall({ exitCode: 0, stdout: 'installed', stderr: '' });
    await expect(preview).resolves.toBe('C:/app-data/preview-templates/vanilla');
    expect(run.installExecutionIds.size).toBe(0);
  });
});
