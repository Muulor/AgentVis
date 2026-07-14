/** Template cache installation concurrency and command-policy regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  writeTextFile: vi.fn(),
}));

interface InstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function mockNativeCommands(install: InstallResult | Promise<InstallResult>): void {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'preview_acquire_template_lock') return Promise.resolve('template-lease');
    if (command === 'preview_release_template_lock') return Promise.resolve(undefined);
    if (command === 'shell_execute') return Promise.resolve(install);
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
}

function invokeCalls(command: string): unknown[][] {
  return mocks.invoke.mock.calls.filter(([candidate]) => candidate === command);
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => 'C:/app-data'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  mkdir: mocks.mkdir,
  readTextFile: mocks.readTextFile,
  remove: mocks.remove,
  writeTextFile: mocks.writeTextFile,
}));

describe('TemplateManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(false);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.writeTextFile.mockResolvedValue(undefined);
    mockNativeCommands({ exitCode: 0, stdout: 'installed', stderr: '' });
  });

  it('shares one npm install when warmup and preview request the same template concurrently', async () => {
    let resolveInstall!: (value: InstallResult) => void;
    const install = new Promise<InstallResult>((resolve) => {
      resolveInstall = resolve;
    });
    mockNativeCommands(install);
    const { templateManager } = await import('./TemplateManager');
    const releasePreviewExecution = vi.fn();
    const acquirePreviewExecution = vi.fn(() => ({
      executionId: 'preview-install-execution',
      release: releasePreviewExecution,
    }));

    const warmup = templateManager.ensureTemplateReady('vanilla');
    const previewPreparation = templateManager.beginTemplatePreparation(
      'vanilla',
      undefined,
      acquirePreviewExecution
    );
    const preview = previewPreparation.readiness;

    await vi.waitFor(() => expect(invokeCalls('shell_execute')).toHaveLength(1));
    expect(previewPreparation.joinedExistingPreparation).toBe(true);
    expect(templateManager.isTemplatePreparationInFlight('vanilla')).toBe(true);
    const invocation = invokeCalls('shell_execute')[0]?.[1] as {
      command?: string;
      executionId?: string;
    };
    expect(invocation.command).toContain('--ignore-scripts');
    expect(invocation.command).toContain('--no-audit');
    expect(invocation.executionId).toBeUndefined();
    expect(acquirePreviewExecution).not.toHaveBeenCalled();

    resolveInstall({ exitCode: 0, stdout: 'installed', stderr: '' });

    await expect(Promise.all([warmup, preview])).resolves.toEqual([
      'C:/app-data/preview-templates/vanilla',
      'C:/app-data/preview-templates/vanilla',
    ]);
    expect(templateManager.isTemplatePreparationInFlight('vanilla')).toBe(false);
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      'C:/app-data/preview-templates/vanilla/.agentvis-install-complete',
      expect.any(String)
    );
    expect(invokeCalls('preview_acquire_template_lock')).toHaveLength(1);
    expect(invokeCalls('preview_release_template_lock')).toHaveLength(1);
    expect(releasePreviewExecution).not.toHaveBeenCalled();
  });

  it('acquires and releases an execution only when the caller owns an actual install', async () => {
    const { templateManager } = await import('./TemplateManager');
    const release = vi.fn();
    const acquire = vi.fn(() => ({ executionId: 'owned-template-install', release }));

    const preparation = templateManager.beginTemplatePreparation('vanilla', undefined, acquire);

    expect(preparation.joinedExistingPreparation).toBe(false);
    await expect(preparation.readiness).resolves.toBe('C:/app-data/preview-templates/vanilla');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      'shell_execute',
      expect.objectContaining({ executionId: 'owned-template-install' })
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(templateManager.isTemplatePreparationInFlight('vanilla')).toBe(false);
  });

  it('does not allocate an execution when the owned readiness check finds a warm template', async () => {
    mocks.exists.mockResolvedValue(true);
    const { templateManager } = await import('./TemplateManager');
    const config = templateManager.getTemplateConfig('vanilla');
    mocks.readTextFile.mockResolvedValue(
      JSON.stringify(
        {
          name: 'preview-template-vanilla',
          version: '1.0.0',
          private: true,
          type: 'module',
          dependencies: config.dependencies,
          devDependencies: config.devDependencies,
        },
        null,
        2
      )
    );
    const acquire = vi.fn(() => ({ executionId: 'unused', release: vi.fn() }));

    await expect(templateManager.ensureTemplateReady('vanilla', undefined, acquire)).resolves.toBe(
      'C:/app-data/preview-templates/vanilla'
    );

    expect(acquire).not.toHaveBeenCalled();
    expect(invokeCalls('shell_execute')).toHaveLength(0);
    expect(invokeCalls('preview_acquire_template_lock')).toHaveLength(1);
    expect(invokeCalls('preview_release_template_lock')).toHaveLength(1);
  });

  it('repairs a cache whose manifest changed before the previous marker was invalidated', async () => {
    mocks.exists.mockResolvedValue(true);
    const { templateManager } = await import('./TemplateManager');
    const config = templateManager.getTemplateConfig('vanilla');
    const expectedPackage = JSON.stringify(
      {
        name: 'preview-template-vanilla',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: config.dependencies,
        devDependencies: config.devDependencies,
      },
      null,
      2
    );
    mocks.readTextFile.mockImplementation(async (path: string) =>
      path.endsWith('/.agentvis-install-complete') ? '{"stale":true}' : expectedPackage
    );

    await expect(templateManager.ensureTemplateReady('vanilla')).resolves.toBe(
      'C:/app-data/preview-templates/vanilla'
    );

    expect(invokeCalls('shell_execute')).toHaveLength(1);
    expect(mocks.remove).toHaveBeenCalledWith(
      'C:/app-data/preview-templates/vanilla/.agentvis-install-complete'
    );
    const packageWriteIndex = mocks.writeTextFile.mock.calls.findIndex(([path]) =>
      String(path).endsWith('/package.json')
    );
    expect(packageWriteIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeTextFile.mock.invocationCallOrder[packageWriteIndex] ?? Number.MAX_SAFE_INTEGER
    );
  });

  it('releases the cross-process template lease when installation fails', async () => {
    mockNativeCommands({ exitCode: 1, stdout: '', stderr: 'install failed' });
    const { templateManager } = await import('./TemplateManager');

    await expect(templateManager.ensureTemplateReady('vanilla')).rejects.toThrow('install failed');

    expect(invokeCalls('preview_release_template_lock')).toEqual([
      ['preview_release_template_lock', { leaseToken: 'template-lease' }],
    ]);
  });
});
