/**
 * Project Preview in-memory source budgets.
 *
 * These limits are shared by UI file collection and the service boundary so a
 * large deliverable is rejected before concurrent reads can exhaust memory.
 */

import { PreviewServiceError } from './previewErrors';
import type { ProjectFile } from './types';

const RESERVED_PATH_SEGMENTS = new Set([
  '.agentvis',
  '.git',
  'agent-log',
  'build',
  'dist',
  'node_modules',
  'vite_preview',
]);

const ROOT_BUILD_CONFIG =
  /^(?:babel|commitlint|cypress|eslint|esbuild|jest|playwright|postcss|prettier|rollup|stylelint|tailwind|vite|vitest|webpack)\.config\.[^.]+$/i;
const ROOT_PREVIEW_TOOLCHAIN_CONFIG = /^(?:postcss|tailwind|vite)\.config\.[^.]+$/i;
const ROOT_DOTFILE_CONFIG = /^\.(?:babelrc|eslintrc|prettierrc|stylelintrc)(?:\.[^.]+)?$/i;
const ROOT_TYPESCRIPT_CONFIG = /^(?:js|ts)config(?:\.[^.]+)?\.json$/i;
const ROOT_PACKAGE_METADATA =
  /^(?:bun\.lockb?|npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

export const MAX_PREVIEW_SOURCE_FILES = 500;
export const MAX_PREVIEW_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PREVIEW_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_PREVIEW_SOURCE_SCAN_ENTRIES = 10_000;
export const MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH = 24;

export interface PreviewSourcePathOptions {
  /** Complete projects may retain the configuration required to reproduce their Vite build. */
  allowProjectToolchainConfig?: boolean;
}

/** Keep unrelated build/lint metadata available for analysis without staging it as runtime source. */
export function isSafePreviewSourcePath(
  path: string,
  options: PreviewSourcePathOptions = {}
): boolean {
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment))) return false;
  if (segments.length !== 1) return true;

  const fileName = segments[0];
  if (!fileName) return false;
  if (
    options.allowProjectToolchainConfig &&
    (ROOT_PREVIEW_TOOLCHAIN_CONFIG.test(fileName) || ROOT_TYPESCRIPT_CONFIG.test(fileName))
  ) {
    return true;
  }
  return !(
    fileName === 'package.json' ||
    ROOT_BUILD_CONFIG.test(fileName) ||
    ROOT_DOTFILE_CONFIG.test(fileName) ||
    ROOT_TYPESCRIPT_CONFIG.test(fileName) ||
    ROOT_PACKAGE_METADATA.test(fileName)
  );
}

export function getPreviewSourceByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function enforcePreviewSourceBudgets(files: readonly ProjectFile[]): void {
  if (files.length > MAX_PREVIEW_SOURCE_FILES) {
    throw new PreviewServiceError('asset-budget-exceeded', 'source-file-count');
  }

  let totalBytes = 0;
  for (const file of files) {
    const bytes = getPreviewSourceByteLength(file.content);
    if (bytes > MAX_PREVIEW_SOURCE_FILE_BYTES) {
      throw new PreviewServiceError('asset-budget-exceeded', `source-file: ${file.path}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PREVIEW_SOURCE_TOTAL_BYTES) {
      throw new PreviewServiceError('asset-budget-exceeded', 'source-total');
    }
  }
}
