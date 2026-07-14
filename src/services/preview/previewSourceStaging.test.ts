/** Native Project Preview source collection boundary regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
  MAX_PREVIEW_SOURCE_FILE_BYTES,
  MAX_PREVIEW_SOURCE_FILES,
  MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
  MAX_PREVIEW_SOURCE_TOTAL_BYTES,
} from './previewSourcePolicy';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readDir: vi.fn(),
  lstat: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir,
  lstat: mocks.lstat,
  readTextFile: mocks.readTextFile,
}));

import {
  listPreviewSourceTree,
  readPreviewPackageJson,
  readPreviewSourceFiles,
} from './previewSourceStaging';
import { PreviewServiceError } from './previewErrors';

const deliverableRoot = 'C:/app/deliverables/Hub/Agent';
const projectRoot = `${deliverableRoot}/project`;

describe('previewSourceStaging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists through the bounded native command and normalizes native relative paths', async () => {
    mocks.invoke.mockResolvedValue({
      projectRoot,
      projectRootRelative: 'project',
      sourcePrefix: 'src/',
      hasPackageJson: false,
      entries: [{ path: 'src\\App.tsx', sourcePath: 'App.tsx', size: 18 }],
      scannedEntries: 2,
      totalBytes: 18,
      skippedLinks: 1,
      omittedEnvironmentFiles: 2,
    });

    await expect(listPreviewSourceTree(deliverableRoot, 'project/src')).resolves.toMatchObject({
      projectRoot,
      projectRootRelative: 'project',
      sourcePrefix: 'src/',
      entries: [{ path: 'src/App.tsx', sourcePath: 'App.tsx', size: 18 }],
      omittedEnvironmentFiles: 2,
    });

    expect(mocks.invoke).toHaveBeenCalledWith('preview_list_source_tree', {
      request: {
        root: deliverableRoot,
        currentRelative: 'project/src',
        maxDepth: MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
        maxEntries: MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
        maxFiles: MAX_PREVIEW_SOURCE_FILES,
        maxFileBytes: MAX_PREVIEW_SOURCE_FILE_BYTES,
        maxTotalBytes: MAX_PREVIEW_SOURCE_TOTAL_BYTES,
        extensions: [
          'cjs',
          'css',
          'cts',
          'html',
          'js',
          'json',
          'jsx',
          'mjs',
          'mts',
          'ts',
          'tsx',
          'vue',
        ],
        skipDirectories: [
          '.agentvis-importing',
          '.git',
          'agent-log',
          'build',
          'dist',
          'node_modules',
          'vite_preview',
        ],
      },
    });
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.lstat).not.toHaveBeenCalled();
  });

  it('passes the shrinking remaining budget to each no-follow native read', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ path: 'a.js', content: '1234567', size: 7 })
      .mockResolvedValueOnce({ path: 'b.js', content: '12345', size: 5 });

    await expect(
      readPreviewSourceFiles(
        projectRoot,
        [
          { path: 'a.js', sourcePath: 'a.js', size: 7 },
          { path: 'b.js', sourcePath: 'b.js', size: 5 },
        ],
        { maxFileBytes: 10, maxTotalBytes: 12 }
      )
    ).resolves.toEqual([
      { path: 'a.js', content: '1234567' },
      { path: 'b.js', content: '12345' },
    ]);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'preview_read_text_file', {
      request: { root: projectRoot, relativePath: 'a.js', maxBytes: 10 },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'preview_read_text_file', {
      request: { root: projectRoot, relativePath: 'b.js', maxBytes: 5 },
    });
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain('file_read_content');
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });

  it('checks request activity around each native read and stops before the next file', async () => {
    mocks.invoke.mockResolvedValue({ path: 'a.js', content: 'a', size: 1 });
    let checks = 0;

    await expect(
      readPreviewSourceFiles(
        projectRoot,
        [
          { path: 'a.js', sourcePath: 'a.js', size: 1 },
          { path: 'b.js', sourcePath: 'b.js', size: 1 },
        ],
        {
          assertActive: () => {
            checks += 1;
            if (checks === 3) throw new PreviewServiceError('cancelled');
          },
        }
      )
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['PREVIEW_STAGING_BUDGET:source-total', 'asset-budget-exceeded'],
    ['PREVIEW_STAGING_UNSAFE:source root escaped', 'unsafe-path'],
    ['PREVIEW_STAGING_NOT_FOUND:main.ts', 'unsafe-path'],
  ])('maps native refusal %s to %s', async (nativeError, expectedCode) => {
    mocks.invoke.mockRejectedValue(nativeError);

    await expect(
      readPreviewSourceFiles(projectRoot, [{ path: 'main.ts', sourcePath: 'main.ts', size: 1 }])
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it('rejects a native path mismatch instead of trusting the returned file', async () => {
    mocks.invoke.mockResolvedValue({ path: '../outside.js', content: 'x', size: 1 });

    await expect(
      readPreviewSourceFiles(projectRoot, [{ path: 'main.js', sourcePath: 'main.js', size: 1 }])
    ).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('reads a src-triggered file by its physical path but preserves its staging prefix', async () => {
    mocks.invoke.mockResolvedValue({ path: 'App.tsx', content: 'export default 1', size: 16 });

    await expect(
      readPreviewSourceFiles(projectRoot, [
        { path: 'src/App.tsx', sourcePath: 'App.tsx', size: 16 },
      ])
    ).resolves.toEqual([{ path: 'src/App.tsx', content: 'export default 1' }]);
    expect(mocks.invoke).toHaveBeenCalledWith('preview_read_text_file', {
      request: {
        root: projectRoot,
        relativePath: 'App.tsx',
        maxBytes: MAX_PREVIEW_SOURCE_FILE_BYTES,
      },
    });
  });

  it('rejects a native response that maps one physical file onto another staging path', async () => {
    mocks.invoke.mockResolvedValue({
      projectRoot,
      projectRootRelative: 'project/src',
      sourcePrefix: 'src/',
      hasPackageJson: false,
      entries: [{ path: 'src/Other.tsx', sourcePath: 'App.tsx', size: 1 }],
      scannedEntries: 1,
      totalBytes: 1,
      skippedLinks: 0,
      omittedEnvironmentFiles: 0,
    });

    await expect(listPreviewSourceTree(deliverableRoot, 'project/src')).rejects.toMatchObject({
      code: 'unsafe-path',
      detail: 'source-path-map:src/Other.tsx',
    });
  });

  it('reads package.json through the bounded command and maps its budget separately', async () => {
    mocks.invoke.mockResolvedValueOnce({
      path: 'package.json',
      content: '{"dependencies":{}}',
      size: 19,
    });

    await expect(readPreviewPackageJson(projectRoot)).resolves.toBe('{"dependencies":{}}');
    expect(mocks.invoke).toHaveBeenCalledWith('preview_read_text_file', {
      request: {
        root: projectRoot,
        relativePath: 'package.json',
        maxBytes: expect.any(Number),
      },
    });

    mocks.invoke.mockRejectedValueOnce('PREVIEW_STAGING_BUDGET:package.json');
    await expect(readPreviewPackageJson(projectRoot)).rejects.toMatchObject({
      code: 'invalid-package',
    });
  });

  it('treats a manifest removed after listing as absent without an unsafe fallback read', async () => {
    mocks.invoke.mockRejectedValue('PREVIEW_STAGING_NOT_FOUND:package.json');

    await expect(readPreviewPackageJson(projectRoot)).resolves.toBeUndefined();
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });
});
