/**
 * Native, bounded source collection for Project Preview.
 *
 * Deliverable files are enumerated and read through a root-relative, no-follow
 * native boundary. Renderer code validates every returned relative path and
 * reapplies byte budgets so a changed file cannot escape the list-time limits.
 */

import { invoke } from '@tauri-apps/api/core';
import { MAX_PREVIEW_PACKAGE_JSON_BYTES } from './previewDependencyPolicy';
import { PreviewServiceError } from './previewErrors';
import {
  MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
  MAX_PREVIEW_SOURCE_FILE_BYTES,
  MAX_PREVIEW_SOURCE_FILES,
  MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
  MAX_PREVIEW_SOURCE_TOTAL_BYTES,
  getPreviewSourceByteLength,
} from './previewSourcePolicy';
import { normalizeProjectRelativePath, ProjectPathValidationError } from './projectPathPolicy';
import { PREVIEWABLE_EXTENSIONS } from './templateInference';
import type { ProjectFile } from './types';

const PREVIEW_SOURCE_EXTENSIONS = new Set([
  ...PREVIEWABLE_EXTENSIONS,
  'cjs',
  'cts',
  'json',
  'mjs',
  'mts',
]);

const PREVIEW_SOURCE_SKIP_DIRECTORIES = [
  '.agentvis-importing',
  '.git',
  'agent-log',
  'build',
  'dist',
  'node_modules',
  'vite_preview',
] as const;

const PREVIEW_STAGING_ERROR = /^PREVIEW_STAGING_(BUDGET|UNSAFE|NOT_FOUND|IO):(.*)$/su;

export interface PreviewSourceEntry {
  /** Relative path used in the isolated staging workspace. */
  path: string;
  /** Physical path relative to projectRoot, used only by the native read boundary. */
  sourcePath: string;
  size: number;
}

export interface PreviewSourceTree {
  projectRoot: string;
  projectRootRelative: string;
  sourcePrefix: string;
  hasPackageJson: boolean;
  entries: PreviewSourceEntry[];
  scannedEntries: number;
  totalBytes: number;
  skippedLinks: number;
  omittedEnvironmentFiles: number;
}

type NativePreviewSourceTree = PreviewSourceTree;

interface NativePreviewTextFile {
  path: string;
  content: string;
  size: number;
}

interface PreviewSourceReadOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  assertActive?: () => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

export function mapNativePreviewStagingError(
  error: unknown,
  context: 'source' | 'asset' = 'source'
): PreviewServiceError {
  if (error instanceof PreviewServiceError) return error;
  const message = getErrorMessage(error);
  const match = PREVIEW_STAGING_ERROR.exec(message);
  if (!match) return new PreviewServiceError('server-start-failed', 'preview-source-io');

  const [, kind, rawDetail] = match;
  const nativeDetail = (rawDetail ?? '').trim().slice(0, 512) || 'preview-source';
  const detail =
    context === 'asset'
      ? nativeDetail
          .replace(/^file(?=:|-count$)/u, 'asset-file')
          .replace(/^source-total$/u, 'asset-total')
      : nativeDetail.replace(/^file(?=:|-count$)/u, 'source-file');
  if (kind === 'BUDGET') return new PreviewServiceError('asset-budget-exceeded', detail);
  if (kind === 'UNSAFE' || kind === 'NOT_FOUND') {
    return new PreviewServiceError('unsafe-path', detail);
  }
  return new PreviewServiceError('server-start-failed', 'preview-source-io');
}

function requireSafeInteger(value: number, detail: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PreviewServiceError('unsafe-path', detail);
  }
  return value;
}

function normalizeOptionalRelativePath(path: string): string {
  return path === '' ? '' : normalizeProjectRelativePath(path);
}

function normalizeNativePath(path: string, detail: string): string {
  try {
    return normalizeProjectRelativePath(path);
  } catch (error) {
    if (error instanceof ProjectPathValidationError) {
      throw new PreviewServiceError('unsafe-path', `${detail}:${error.code}`);
    }
    throw error;
  }
}

function normalizeNativeOptionalPath(path: string, detail: string): string {
  if (path === '') return '';
  return normalizeNativePath(path, detail);
}

function normalizeNativeSourcePrefix(prefix: string): string {
  if (prefix === '') return '';
  const normalized = normalizeNativePath(prefix.replace(/\/+$/u, ''), 'source-prefix');
  return `${normalized}/`;
}

/** List the nearest preview project without renderer-side directory traversal. */
export async function listPreviewSourceTree(
  deliverableRoot: string,
  currentRelative: string
): Promise<PreviewSourceTree> {
  let result: NativePreviewSourceTree;
  try {
    result = await invoke<NativePreviewSourceTree>('preview_list_source_tree', {
      request: {
        root: deliverableRoot,
        currentRelative: normalizeOptionalRelativePath(currentRelative),
        maxDepth: MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
        maxEntries: MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
        maxFiles: MAX_PREVIEW_SOURCE_FILES,
        maxFileBytes: MAX_PREVIEW_SOURCE_FILE_BYTES,
        maxTotalBytes: MAX_PREVIEW_SOURCE_TOTAL_BYTES,
        extensions: [...PREVIEW_SOURCE_EXTENSIONS].sort(),
        skipDirectories: [...PREVIEW_SOURCE_SKIP_DIRECTORIES],
      },
    });
  } catch (error) {
    if (error instanceof ProjectPathValidationError) {
      throw new PreviewServiceError('unsafe-path', `current-relative:${error.code}`);
    }
    throw mapNativePreviewStagingError(error);
  }

  if (
    !result.projectRoot ||
    typeof result.hasPackageJson !== 'boolean' ||
    !Array.isArray(result.entries)
  ) {
    throw new PreviewServiceError('unsafe-path', 'invalid-source-tree');
  }

  const projectRootRelative = normalizeNativeOptionalPath(
    result.projectRootRelative,
    'project-root-relative'
  );
  const sourcePrefix = normalizeNativeSourcePrefix(result.sourcePrefix);
  const scannedEntries = requireSafeInteger(result.scannedEntries, 'source-scanned-entries');
  const totalBytes = requireSafeInteger(result.totalBytes, 'source-total-bytes');
  const skippedLinks = requireSafeInteger(result.skippedLinks, 'source-skipped-links');
  const omittedEnvironmentFiles = requireSafeInteger(
    result.omittedEnvironmentFiles,
    'source-omitted-environment-files'
  );
  if (scannedEntries > MAX_PREVIEW_SOURCE_SCAN_ENTRIES) {
    throw new PreviewServiceError('asset-budget-exceeded', 'scanned-entry-count');
  }
  if (result.entries.length > MAX_PREVIEW_SOURCE_FILES) {
    throw new PreviewServiceError('asset-budget-exceeded', 'source-file-count');
  }
  if (totalBytes > MAX_PREVIEW_SOURCE_TOTAL_BYTES) {
    throw new PreviewServiceError('asset-budget-exceeded', 'source-total');
  }

  const paths = new Set<string>();
  const sourcePaths = new Set<string>();
  let listedBytes = 0;
  const entries = result.entries.map((entry) => {
    const path = normalizeNativePath(entry.path, 'source-entry');
    const sourcePath = normalizeNativePath(entry.sourcePath, 'source-entry-physical');
    const size = requireSafeInteger(entry.size, `source-file-size:${path}`);
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    if (!PREVIEW_SOURCE_EXTENSIONS.has(extension)) {
      throw new PreviewServiceError('unsafe-path', `source-extension:${path}`);
    }
    if (path !== `${sourcePrefix}${sourcePath}`) {
      throw new PreviewServiceError('unsafe-path', `source-path-map:${path}`);
    }
    if (paths.has(path)) throw new PreviewServiceError('unsafe-path', `duplicate-source:${path}`);
    if (sourcePaths.has(sourcePath)) {
      throw new PreviewServiceError('unsafe-path', `duplicate-source-physical:${sourcePath}`);
    }
    paths.add(path);
    sourcePaths.add(sourcePath);
    if (size > MAX_PREVIEW_SOURCE_FILE_BYTES) {
      throw new PreviewServiceError('asset-budget-exceeded', `source-file: ${path}`);
    }
    listedBytes += size;
    if (listedBytes > MAX_PREVIEW_SOURCE_TOTAL_BYTES) {
      throw new PreviewServiceError('asset-budget-exceeded', 'source-total');
    }
    return { path, sourcePath, size };
  });
  if (listedBytes !== totalBytes || scannedEntries < entries.length) {
    throw new PreviewServiceError('unsafe-path', 'source-tree-totals');
  }

  return {
    projectRoot: result.projectRoot,
    projectRootRelative,
    sourcePrefix,
    hasPackageJson: result.hasPackageJson,
    entries,
    scannedEntries,
    totalBytes,
    skippedLinks,
    omittedEnvironmentFiles,
  };
}

/** Read listed source files sequentially with a shrinking total-byte allowance. */
export async function readPreviewSourceFiles(
  projectRoot: string,
  entries: readonly PreviewSourceEntry[],
  options: PreviewSourceReadOptions = {}
): Promise<ProjectFile[]> {
  const maxFileBytes = options.maxFileBytes ?? MAX_PREVIEW_SOURCE_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_PREVIEW_SOURCE_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    maxFileBytes > MAX_PREVIEW_SOURCE_FILE_BYTES ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes <= 0 ||
    maxTotalBytes > MAX_PREVIEW_SOURCE_TOTAL_BYTES
  ) {
    throw new PreviewServiceError('asset-budget-exceeded', 'source-read-limits');
  }
  let totalBytes = 0;
  const files: ProjectFile[] = [];

  for (const entry of entries) {
    options.assertActive?.();
    const stagingPath = normalizeNativePath(entry.path, 'source-entry');
    const sourcePath = normalizeNativePath(entry.sourcePath, 'source-entry-physical');
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      throw new PreviewServiceError('asset-budget-exceeded', 'source-total');
    }
    const maxBytes = Math.min(maxFileBytes, remainingBytes);

    let result: NativePreviewTextFile;
    try {
      result = await invoke<NativePreviewTextFile>('preview_read_text_file', {
        request: { root: projectRoot, relativePath: sourcePath, maxBytes },
      });
    } catch (error) {
      throw mapNativePreviewStagingError(error);
    }
    options.assertActive?.();

    const returnedPath = normalizeNativePath(result.path, 'source-read');
    if (returnedPath !== sourcePath) {
      throw new PreviewServiceError('unsafe-path', `source-read-mismatch:${sourcePath}`);
    }
    requireSafeInteger(result.size, `source-read-size:${sourcePath}`);
    const actualBytes = getPreviewSourceByteLength(result.content);
    if (result.size !== actualBytes) {
      throw new PreviewServiceError('unsafe-path', `source-read-size-mismatch:${sourcePath}`);
    }
    if (actualBytes > maxBytes) {
      throw new PreviewServiceError('asset-budget-exceeded', `source-file: ${stagingPath}`);
    }

    totalBytes += actualBytes;
    files.push({ path: stagingPath, content: result.content });
  }

  return files;
}

/** Read package.json through the same no-follow root-relative boundary. */
export async function readPreviewPackageJson(projectRoot: string): Promise<string | undefined> {
  let result: NativePreviewTextFile;
  try {
    result = await invoke<NativePreviewTextFile>('preview_read_text_file', {
      request: {
        root: projectRoot,
        relativePath: 'package.json',
        maxBytes: MAX_PREVIEW_PACKAGE_JSON_BYTES,
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.startsWith('PREVIEW_STAGING_NOT_FOUND:')) return undefined;
    const mapped = mapNativePreviewStagingError(error);
    if (mapped.code === 'asset-budget-exceeded') {
      throw new PreviewServiceError('invalid-package', 'package.json');
    }
    throw mapped;
  }

  const returnedPath = normalizeNativePath(result.path, 'package-read');
  const actualBytes = getPreviewSourceByteLength(result.content);
  requireSafeInteger(result.size, 'package-read-size');
  if (returnedPath !== 'package.json' || result.size !== actualBytes) {
    throw new PreviewServiceError('unsafe-path', 'package-read-mismatch');
  }
  if (actualBytes > MAX_PREVIEW_PACKAGE_JSON_BYTES) {
    throw new PreviewServiceError('invalid-package', 'package.json');
  }
  return result.content;
}
