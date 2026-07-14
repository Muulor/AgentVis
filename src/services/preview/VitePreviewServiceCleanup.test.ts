/** Project Preview native workspace-ownership and cleanup regression tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ join: tauri.join }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: tauri.writeTextFile }));

interface PreviewWorkspaceCreateResult {
  workspace: string;
  runId: string;
  ownerToken: string;
}

interface PreviewCleanupInternals {
  createWorkspace(runId: string): Promise<PreviewWorkspaceCreateResult>;
  cleanupWorkspace(
    workspace: string,
    runId: string,
    ownerToken: string,
    fromAutomaticMaintenance?: boolean
  ): Promise<boolean>;
  drainCleanupBacklog(automatic?: boolean): Promise<void>;
  maintainPreviewCache(automatic?: boolean): Promise<void>;
  enqueueCleanup(entry: { workspace: string; runId: string; ownerToken: string }): void;
  stopCleanupMaintenanceScheduler(): void;
  cleanupMaintenancePromise: Promise<void> | null;
  cleanupMaintenanceTimerDueAt: number | null;
  cleanupBacklog: Map<string, { workspace: string; runId: string; ownerToken: string }>;
  automaticCleanupRetriesRemaining: Map<string, number>;
  staleRecoveryDueByRunId: Map<string, number>;
  staleSweepRetryPaused: boolean;
  touchRunHeartbeat(run: {
    id: string;
    workspaceDir: string | null;
    ownerToken: string | null;
    lastHeartbeatAt: number;
  }): Promise<void>;
}

const runId = 'project-preview-11111111-1111-4111-8111-111111111111';
const ownerToken = '22222222-2222-4222-8222-222222222222';
const workspace = `C:/cache/project-preview/${runId}`;

const loadedServices: PreviewCleanupInternals[] = [];

async function loadCleanupInternals(): Promise<PreviewCleanupInternals> {
  vi.resetModules();
  const { vitePreviewService } = await import('./VitePreviewService');
  const service = vitePreviewService as unknown as PreviewCleanupInternals;
  loadedServices.push(service);
  return service;
}

describe('VitePreviewService native workspace lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.join.mockImplementation(async (...parts: string[]) =>
      parts.join('/').replace(/\/{2,}/g, '/')
    );
    tauri.writeTextFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const service of loadedServices.splice(0)) {
      service.stopCleanupMaintenanceScheduler();
    }
    vi.useRealTimers();
  });

  it('delegates workspace creation to the native ownership boundary', async () => {
    tauri.invoke.mockResolvedValue({ workspace, runId, ownerToken });
    const service = await loadCleanupInternals();

    await expect(service.createWorkspace(runId)).resolves.toEqual({ workspace, runId, ownerToken });
    expect(tauri.invoke).toHaveBeenCalledWith('preview_create_workspace', { runId });
  });

  it('rejects a native creation response for a different owner', async () => {
    tauri.invoke.mockResolvedValue({ workspace, runId: `${runId}-other`, ownerToken });
    const service = await loadCleanupInternals();

    await expect(service.createWorkspace(runId)).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('passes the exact workspace identity to native cleanup without a renderer-side delete', async () => {
    tauri.invoke.mockResolvedValue({ status: 'removed' });
    const service = await loadCleanupInternals();

    await expect(service.cleanupWorkspace(workspace, runId, ownerToken)).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith('preview_cleanup_workspace', {
      workspace,
      expectedRunId: runId,
      expectedOwnerToken: ownerToken,
      staleBeforeMs: null,
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('shell_execute', expect.anything());
  });

  it('retains refused cleanup with its owner identity and retries it later', async () => {
    tauri.invoke
      .mockResolvedValueOnce({ status: 'refused', reason: 'workspace is leased' })
      .mockResolvedValueOnce({ status: 'removed' });
    const service = await loadCleanupInternals();

    await expect(service.cleanupWorkspace(workspace, runId, ownerToken)).resolves.toBe(false);
    await service.drainCleanupBacklog();

    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(tauri.invoke).toHaveBeenLastCalledWith('preview_cleanup_workspace', {
      workspace,
      expectedRunId: runId,
      expectedOwnerToken: ownerToken,
      staleBeforeMs: null,
    });
  });

  it('leaves receipted quarantines to native stale recovery instead of retrying an old path', async () => {
    tauri.invoke.mockResolvedValue({
      status: 'refused',
      reason: 'partial quarantine',
      quarantinedWorkspace: 'C:/cache/project-preview/.trash-33333333-3333-4333-8333-333333333333',
    });
    const service = await loadCleanupInternals();

    await expect(service.cleanupWorkspace(workspace, runId, ownerToken)).resolves.toBe(false);
    tauri.invoke.mockClear();
    await service.drainCleanupBacklog();

    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('bounds cleanup retries per maintenance pass', async () => {
    tauri.invoke.mockResolvedValue({ status: 'refused', reason: 'busy' });
    const service = await loadCleanupInternals();

    for (let index = 0; index < 6; index += 1) {
      await service.cleanupWorkspace(
        `${workspace}-${index}`,
        `${runId}-${index}`,
        `${ownerToken}-${index}`
      );
    }

    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue({ status: 'removed' });
    await service.drainCleanupBacklog();
    expect(tauri.invoke).toHaveBeenCalledTimes(4);

    tauri.invoke.mockClear();
    await service.drainCleanupBacklog();
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
  });

  it('rotates refused cleanup entries so a busy prefix cannot starve later work', async () => {
    vi.useFakeTimers();
    let seedBacklog = true;
    tauri.invoke.mockImplementation(async (command: string, args?: { workspace?: string }) => {
      if (command !== 'preview_cleanup_workspace') {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (seedBacklog || args?.workspace !== `${workspace}-4`) {
        return { status: 'refused', reason: 'workspace is busy' };
      }
      return { status: 'removed' };
    });
    const service = await loadCleanupInternals();

    for (let index = 0; index < 5; index += 1) {
      await service.cleanupWorkspace(
        `${workspace}-${index}`,
        `${runId}-${index}`,
        `${ownerToken}-${index}`
      );
    }

    seedBacklog = false;
    tauri.invoke.mockClear();
    await service.drainCleanupBacklog();
    expect(
      tauri.invoke.mock.calls.map((call) => (call[1] as { workspace: string }).workspace)
    ).toEqual([`${workspace}-0`, `${workspace}-1`, `${workspace}-2`, `${workspace}-3`]);

    tauri.invoke.mockClear();
    await service.drainCleanupBacklog();
    expect(
      tauri.invoke.mock.calls.map((call) => (call[1] as { workspace: string }).workspace)
    ).toContain(`${workspace}-4`);
  });

  it('retries a Windows sharing violation on one bounded timer and clears it after success', async () => {
    vi.useFakeTimers();
    let cleanupAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_workspace') {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error(
            'The process cannot access the file because it is being used (os error 32)'
          );
        }
        return { status: 'removed' };
      }
      if (command === 'preview_cleanup_stale_workspaces') {
        return { removed: 0, refused: 0, notFound: 0, hasMore: false, results: [] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();

    await expect(service.cleanupWorkspace(workspace, runId, ownerToken)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;

    expect(cleanupAttempts).toBe(2);
    expect(service.cleanupBacklog.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('parks a permanently refused cleanup after bounded retries and re-arms it on explicit maintenance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
    const staleRecoveryAt = Date.now() + 24 * 60 * 60 * 1_000;
    let cleanupAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_workspace') {
        cleanupAttempts += 1;
        return { status: 'refused', reason: 'workspace is still leased' };
      }
      if (command === 'preview_cleanup_stale_workspaces') {
        return { removed: 0, refused: 0, notFound: 0, hasMore: false, results: [] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();

    await service.cleanupWorkspace(workspace, runId, ownerToken);
    for (let retry = 0; retry < 3; retry += 1) {
      await vi.advanceTimersToNextTimerAsync();
      if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    }

    expect(cleanupAttempts).toBe(4);
    expect(service.cleanupBacklog.has(workspace)).toBe(true);
    expect(service.automaticCleanupRetriesRemaining.get(workspace)).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(service.cleanupMaintenanceTimerDueAt).toBe(staleRecoveryAt);

    await service.maintainPreviewCache();

    expect(cleanupAttempts).toBe(5);
    expect(service.automaticCleanupRetriesRemaining.get(workspace)).toBe(3);
    expect(service.cleanupMaintenanceTimerDueAt).toBe(Date.now() + 5_000);
  });

  it('does not lose explicit maintenance when it overlaps an automatic sweep', async () => {
    let resolveStaleSweep!: (result: {
      removed: number;
      refused: number;
      notFound: number;
      hasMore: boolean;
      results: [];
    }) => void;
    const staleSweep = new Promise<{
      removed: number;
      refused: number;
      notFound: number;
      hasMore: boolean;
      results: [];
    }>((resolve) => {
      resolveStaleSweep = resolve;
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_stale_workspaces') return staleSweep;
      if (command === 'preview_cleanup_workspace') return { status: 'removed' };
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();
    service.cleanupBacklog.set(workspace, { workspace, runId, ownerToken });
    service.automaticCleanupRetriesRemaining.set(workspace, 0);

    const automaticMaintenance = service.maintainPreviewCache(true);
    const explicitMaintenance = service.maintainPreviewCache();
    resolveStaleSweep({ removed: 0, refused: 0, notFound: 0, hasMore: false, results: [] });
    await automaticMaintenance;
    await explicitMaintenance;

    expect(tauri.invoke).toHaveBeenCalledWith('preview_cleanup_workspace', {
      workspace,
      expectedRunId: runId,
      expectedOwnerToken: ownerToken,
      staleBeforeMs: null,
    });
    expect(service.cleanupBacklog.size).toBe(0);
  });

  it('keeps a project backlog entry when native stale cleanup reports a distinct trash receipt id', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_stale_workspaces') {
        return {
          removed: 1,
          refused: 0,
          notFound: 0,
          hasMore: false,
          results: [
            {
              runId: '.trash-33333333-3333-4333-8333-333333333333',
              status: 'removed',
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();
    service.cleanupBacklog.set(workspace, { workspace, runId, ownerToken });
    service.automaticCleanupRetriesRemaining.set(workspace, 0);
    service.staleRecoveryDueByRunId.set(runId, Date.now() + 24 * 60 * 60 * 1_000);

    await service.maintainPreviewCache(true);

    expect(service.cleanupBacklog.get(workspace)).toEqual({ workspace, runId, ownerToken });
    expect(service.automaticCleanupRetriesRemaining.get(workspace)).toBe(0);
    expect(service.staleRecoveryDueByRunId.has(runId)).toBe(true);
    expect(tauri.invoke).not.toHaveBeenCalledWith('preview_cleanup_workspace', expect.anything());
  });

  it('re-arms stale recovery for a new quarantine and retries a stale sharing violation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
    let staleAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_workspace') {
        return {
          status: 'refused',
          reason: 'partial cleanup hit os error 32',
          quarantinedWorkspace:
            'C:/cache/project-preview/.trash-33333333-3333-4333-8333-333333333333',
        };
      }
      if (command === 'preview_cleanup_stale_workspaces') {
        staleAttempts += 1;
        if (staleAttempts === 1) {
          return { removed: 0, refused: 0, notFound: 0, hasMore: false, results: [] };
        }
        if (staleAttempts === 2) {
          return {
            removed: 0,
            refused: 1,
            notFound: 0,
            hasMore: false,
            results: [
              {
                runId,
                status: 'refused',
                reason: 'file is still in use (os error 32)',
              },
            ],
          };
        }
        return {
          removed: 1,
          refused: 0,
          notFound: 0,
          hasMore: false,
          results: [{ runId, status: 'removed' }],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();

    await service.maintainPreviewCache();
    expect(staleAttempts).toBe(1);
    await expect(service.cleanupWorkspace(workspace, runId, ownerToken)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    expect(staleAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    expect(staleAttempts).toBe(3);
    expect(service.staleRecoveryDueByRunId.has(runId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an evicted backlog entry eligible for eventual native stale recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
    const oldestRunId = `${runId}-0`;
    let staleAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'preview_cleanup_workspace') return { status: 'removed' };
      if (command === 'preview_cleanup_stale_workspaces') {
        staleAttempts += 1;
        if (staleAttempts === 1) {
          return { removed: 0, refused: 0, notFound: 0, hasMore: false, results: [] };
        }
        return {
          removed: 1,
          refused: 0,
          notFound: 0,
          hasMore: false,
          results: [{ runId: oldestRunId, status: 'removed' }],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = await loadCleanupInternals();

    for (let index = 0; index < 129; index += 1) {
      service.enqueueCleanup({
        workspace: `${workspace}-${index}`,
        runId: `${runId}-${index}`,
        ownerToken: `${ownerToken}-${index}`,
      });
    }

    expect(service.cleanupBacklog.size).toBe(128);
    expect(service.staleRecoveryDueByRunId.size).toBeLessThanOrEqual(128);
    expect(service.cleanupBacklog.has(`${workspace}-0`)).toBe(false);
    expect(service.staleRecoveryDueByRunId.has(oldestRunId)).toBe(true);

    await vi.runAllTimersAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;

    expect(staleAttempts).toBe(2);
    expect(service.staleRecoveryDueByRunId.has(oldestRunId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels scheduled cleanup maintenance without awaiting retries during shutdown', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockRejectedValue(new Error('busy (os error 32)'));
    const service = await loadCleanupInternals();

    await service.cleanupWorkspace(workspace, runId, ownerToken);
    expect(vi.getTimerCount()).toBe(1);

    service.stopCleanupMaintenanceScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses bounded native stale sweeps and continues only while more work remains', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
    tauri.invoke
      .mockResolvedValueOnce({ removed: 128, refused: 0, notFound: 0, hasMore: true, results: [] })
      .mockResolvedValueOnce({ removed: 1, refused: 0, notFound: 0, hasMore: false, results: [] });
    const service = await loadCleanupInternals();
    const earliestStaleBefore = Date.now() - 24 * 60 * 60 * 1_000;

    await service.maintainPreviewCache();
    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    await service.maintainPreviewCache();

    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(tauri.invoke).toHaveBeenNthCalledWith(
      1,
      'preview_cleanup_stale_workspaces',
      expect.objectContaining({ limit: 128, staleBeforeMs: expect.any(Number) })
    );
    const firstArgs = tauri.invoke.mock.calls[0]?.[1] as { staleBeforeMs: number };
    const latestStaleBefore = Date.now() - 24 * 60 * 60 * 1_000;
    expect(firstArgs.staleBeforeMs).toBeGreaterThanOrEqual(earliestStaleBefore);
    expect(firstArgs.staleBeforeMs).toBeLessThanOrEqual(latestStaleBefore);
  });

  it('stops retrying a permanently refused stale candidate until explicit maintenance re-arms it', async () => {
    vi.useFakeTimers();
    let staleAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command !== 'preview_cleanup_stale_workspaces') {
        throw new Error(`Unexpected command: ${command}`);
      }
      staleAttempts += 1;
      return {
        removed: 0,
        refused: 1,
        notFound: 0,
        hasMore: false,
        results: [{ runId: 'malformed', status: 'refused', reason: 'invalid receipt' }],
      };
    });
    const service = await loadCleanupInternals();

    await service.maintainPreviewCache();
    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;

    expect(staleAttempts).toBe(3);
    expect(service.staleSweepRetryPaused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await service.maintainPreviewCache();

    expect(staleAttempts).toBe(4);
    expect(service.staleSweepRetryPaused).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('bounds stale has-more pagination so a fixed native prefix cannot spin forever', async () => {
    vi.useFakeTimers();
    let staleAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command !== 'preview_cleanup_stale_workspaces') {
        throw new Error(`Unexpected command: ${command}`);
      }
      staleAttempts += 1;
      return { removed: 128, refused: 0, notFound: 0, hasMore: true, results: [] };
    });
    const service = await loadCleanupInternals();

    await service.maintainPreviewCache();
    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;
    await vi.advanceTimersToNextTimerAsync();
    if (service.cleanupMaintenancePromise) await service.cleanupMaintenancePromise;

    expect(staleAttempts).toBe(3);
    expect(service.staleSweepRetryPaused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await service.maintainPreviewCache();
    expect(staleAttempts).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refreshes the exact native owner marker instead of replacing its identity', async () => {
    const service = await loadCleanupInternals();
    const run = { id: runId, workspaceDir: workspace, ownerToken, lastHeartbeatAt: 0 };

    await service.touchRunHeartbeat(run);

    expect(tauri.writeTextFile).toHaveBeenCalledWith(
      `${workspace}/.agentvis/active`,
      expect.stringContaining(`\"ownerToken\":\"${ownerToken}\"`)
    );
    expect(JSON.parse(tauri.writeTextFile.mock.calls[0]?.[1] as string)).toMatchObject({
      id: runId,
      ownerToken,
      updatedAtMs: expect.any(Number),
    });
  });
});
