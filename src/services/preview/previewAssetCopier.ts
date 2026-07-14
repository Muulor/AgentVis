/**
 * Safe asset staging for Project Preview.
 *
 * The renderer submits only an owned workspace identity and bounded policy. Native
 * code performs the root-contained no-follow traversal and copy in one command.
 */

import { invoke } from '@tauri-apps/api/core';
import { PreviewServiceError } from './previewErrors';
import { normalizeProjectRelativePath, ProjectPathValidationError } from './projectPathPolicy';
import { mapNativePreviewStagingError } from './previewSourceStaging';

const ASSET_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'csv',
  'eot',
  'exr',
  'gif',
  'glb',
  'gltf',
  'hdr',
  'ico',
  'jpeg',
  'jpg',
  'json',
  'mp3',
  'mp4',
  'mtl',
  'obj',
  'ogg',
  'otf',
  'png',
  'svg',
  'ttf',
  'wasm',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
]);

const SKIP_DIRECTORIES = new Set([
  '.agentvis-importing',
  '.git',
  'agent-log',
  'build',
  'dist',
  'node_modules',
  'vite_preview',
]);

const SKIP_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'jsconfig.json',
]);

export const MAX_PREVIEW_ASSET_FILES = 1_000;
export const MAX_PREVIEW_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_PREVIEW_SINGLE_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 24;
const MAX_SCANNED_ENTRIES = 10_000;

export interface PreviewAssetCopyResult {
  copiedFiles: number;
  copiedBytes: number;
  scannedEntries: number;
  skippedLinks: number;
  skippedExisting: number;
}

export interface PreviewAssetCopyRequest {
  sourceRoot: string;
  workspace: string;
  runId: string;
  ownerToken: string;
  destinationPrefix?: string;
}

export async function copySafePreviewAssets(
  request: PreviewAssetCopyRequest,
  assertActive?: () => void
): Promise<PreviewAssetCopyResult> {
  if (!request.sourceRoot || !request.workspace || !request.runId || !request.ownerToken) {
    throw new PreviewServiceError('unsafe-path', 'asset-owner-missing');
  }
  let destinationPrefix = '';
  try {
    if (request.destinationPrefix) {
      destinationPrefix = normalizeProjectRelativePath(
        request.destinationPrefix.replace(/\/+$/u, '')
      );
    }
  } catch (error) {
    if (error instanceof ProjectPathValidationError) {
      throw new PreviewServiceError('unsafe-path', `asset-prefix:${error.code}`);
    }
    throw error;
  }

  assertActive?.();
  let result: PreviewAssetCopyResult;
  try {
    result = await invoke<PreviewAssetCopyResult>('preview_copy_assets', {
      request: {
        sourceRoot: request.sourceRoot,
        workspace: request.workspace,
        runId: request.runId,
        ownerToken: request.ownerToken,
        destinationPrefix,
        limits: {
          maxDepth: MAX_DIRECTORY_DEPTH,
          maxEntries: MAX_SCANNED_ENTRIES,
          maxFiles: MAX_PREVIEW_ASSET_FILES,
          maxFileBytes: MAX_PREVIEW_SINGLE_ASSET_BYTES,
          maxTotalBytes: MAX_PREVIEW_ASSET_BYTES,
        },
        extensions: [...ASSET_EXTENSIONS].sort(),
        skipDirectories: [...SKIP_DIRECTORIES],
        skipFiles: [...SKIP_FILES],
      },
    });
  } catch (error) {
    throw mapNativePreviewStagingError(error, 'asset');
  }
  assertActive?.();

  for (const [name, value, limit] of [
    ['copiedFiles', result.copiedFiles, MAX_PREVIEW_ASSET_FILES],
    ['copiedBytes', result.copiedBytes, MAX_PREVIEW_ASSET_BYTES],
    ['scannedEntries', result.scannedEntries, MAX_SCANNED_ENTRIES],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PreviewServiceError('unsafe-path', `asset-result:${name}`);
    }
    if (value > limit) throw new PreviewServiceError('asset-budget-exceeded', name);
  }
  if (
    !Number.isSafeInteger(result.skippedLinks) ||
    result.skippedLinks < 0 ||
    !Number.isSafeInteger(result.skippedExisting) ||
    result.skippedExisting < 0
  ) {
    throw new PreviewServiceError('unsafe-path', 'asset-result:skipped');
  }

  return result;
}
