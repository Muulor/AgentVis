/** Native Project Preview asset-copy ownership and budget regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copyFile: vi.fn(),
  readDir: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  copyFile: mocks.copyFile,
  readDir: mocks.readDir,
  lstat: mocks.lstat,
}));

import { copySafePreviewAssets } from './previewAssetCopier';

const owner = {
  sourceRoot: 'C:/app/deliverables/Hub/Agent/project',
  workspace: 'C:/app/cache/project-preview/project-preview-run',
  runId: 'project-preview-run',
  ownerToken: 'owner-token',
  destinationPrefix: 'src/',
};

describe('previewAssetCopier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies once through native with the exact workspace owner and policy', async () => {
    mocks.invoke.mockResolvedValue({
      copiedFiles: 2,
      copiedBytes: 30,
      scannedEntries: 4,
      skippedLinks: 1,
      skippedExisting: 1,
    });
    const assertActive = vi.fn();

    await expect(copySafePreviewAssets(owner, assertActive)).resolves.toMatchObject({
      copiedFiles: 2,
      copiedBytes: 30,
    });

    expect(mocks.invoke).toHaveBeenCalledWith('preview_copy_assets', {
      request: expect.objectContaining({
        ...owner,
        destinationPrefix: 'src',
        limits: {
          maxDepth: 24,
          maxEntries: 10_000,
          maxFiles: 1_000,
          maxFileBytes: 64 * 1024 * 1024,
          maxTotalBytes: 256 * 1024 * 1024,
        },
        extensions: expect.arrayContaining(['glb', 'png', 'svg', 'wasm', 'woff2']),
        skipDirectories: expect.arrayContaining(['.git', 'node_modules', 'vite_preview']),
        skipFiles: expect.arrayContaining([
          'package.json',
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'tsconfig.json',
          'jsconfig.json',
        ]),
      }),
    });
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.lstat).not.toHaveBeenCalled();
  });

  it.each([
    ['PREVIEW_STAGING_BUDGET:asset-total', 'asset-budget-exceeded'],
    ['PREVIEW_STAGING_UNSAFE:workspace owner mismatch', 'unsafe-path'],
  ])('maps native refusal %s to %s', async (nativeError, expectedCode) => {
    mocks.invoke.mockRejectedValue(nativeError);

    await expect(copySafePreviewAssets(owner)).rejects.toMatchObject({ code: expectedCode });
  });

  it('rejects a response outside the submitted budget', async () => {
    mocks.invoke.mockResolvedValue({
      copiedFiles: 1_001,
      copiedBytes: 1,
      scannedEntries: 1,
      skippedLinks: 0,
      skippedExisting: 0,
    });

    await expect(copySafePreviewAssets(owner)).rejects.toMatchObject({
      code: 'asset-budget-exceeded',
    });
  });

  it('rejects an unsafe destination prefix before invoking native copy', async () => {
    await expect(
      copySafePreviewAssets({ ...owner, destinationPrefix: '../outside' })
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
