/** Project Preview materialization and shell-command cancellation regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreviewDependencies } from './previewDependencyPolicy';
import type { ProjectFile, TemplateConfig } from './types';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ join: tauri.join }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: tauri.mkdir,
  writeTextFile: tauri.writeTextFile,
}));

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

interface CancellationInternals {
  generation: number;
  activeRun: TestRun | null;
  materializeProject(
    run: TestRun,
    files: readonly ProjectFile[],
    templateConfig: TemplateConfig,
    dependencies: PreviewDependencies,
    templatePath: string | null
  ): Promise<unknown>;
  createTemplateJunction(run: TestRun, templatePath: string): Promise<void>;
  cancelCurrentActivity(): Promise<void>;
}

const templateConfig: TemplateConfig = {
  id: 'vanilla',
  displayName: 'Cancellation test',
  dependencies: {},
  devDependencies: {},
  configFiles: {},
  entryFiles: {},
};

const extraDependencies: PreviewDependencies = {
  dependencies: { three: '^0.180.0' },
  devDependencies: {},
};

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
    workspaceDir: 'C:/preview-workspace',
    ownerToken: '22222222-2222-4222-8222-222222222222',
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

async function loadInternals(): Promise<CancellationInternals> {
  vi.resetModules();
  const { vitePreviewService } = await import('./VitePreviewService');
  return vitePreviewService as unknown as CancellationInternals;
}

function activateRun(service: CancellationInternals, run: TestRun): void {
  service.generation = run.generation;
  service.activeRun = run;
}

describe('VitePreviewService cancellation boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
    tauri.mkdir.mockResolvedValue(undefined);
    tauri.writeTextFile.mockResolvedValue(undefined);
  });

  it('does not write a package or start npm when cancelled by the final source write', async () => {
    const service = await loadInternals();
    const run = createRun();
    activateRun(service, run);
    tauri.writeTextFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/index.html')) service.generation += 1;
    });

    await expect(
      service.materializeProject(
        run,
        [{ path: 'index.html', content: '<main>preview</main>' }],
        templateConfig,
        extraDependencies,
        'C:/template'
      )
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(tauri.writeTextFile).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).not.toHaveBeenCalledWith('shell_execute', expect.anything());
  });

  it('does not start npm when cancelled by the package write', async () => {
    const service = await loadInternals();
    const run = createRun();
    activateRun(service, run);
    tauri.writeTextFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/package.json')) service.generation += 1;
    });

    await expect(
      service.materializeProject(
        run,
        [{ path: 'index.html', content: '<main>preview</main>' }],
        templateConfig,
        extraDependencies,
        'C:/template'
      )
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(tauri.writeTextFile).toHaveBeenCalledTimes(2);
    expect(tauri.invoke).not.toHaveBeenCalledWith('shell_execute', expect.anything());
  });

  it('registers and cancels an in-flight junction command without retaining its execution', async () => {
    let rejectJunction!: (reason: Error) => void;
    const junction = new Promise<never>((_resolve, reject) => {
      rejectJunction = reject;
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'shell_execute') return junction;
      if (command === 'shell_cancel') {
        rejectJunction(new Error('junction cancelled'));
        return 'cancelled';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadInternals();
    const run = createRun();
    activateRun(service, run);

    const outcome = service
      .createTemplateJunction(run, 'C:/template')
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        'shell_execute',
        expect.objectContaining({
          executionId: expect.stringMatching(/^preview-dependency-link-/),
        })
      )
    );
    const executionId = (
      tauri.invoke.mock.calls.find((call) => call[0] === 'shell_execute')?.[1] as {
        executionId: string;
      }
    ).executionId;
    expect(run.installExecutionIds).toEqual(new Set([executionId]));

    service.generation += 1;
    await service.cancelCurrentActivity();

    expect(tauri.invoke).toHaveBeenCalledWith('shell_cancel', { executionId });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(run.installExecutionIds.size).toBe(0);
  });
});
