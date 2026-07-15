/** Application exit invalidation, timeout, and retry regression tests. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApplicationExitQueue,
  exitApplicationWithPreviewCleanup,
  type ApplicationExitGuard,
  type ApplicationExitLifecycleResult,
} from './applicationExitLifecycle';

afterEach(() => {
  vi.useRealTimers();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('exitApplicationWithPreviewCleanup', () => {
  it('invalidates the renderer request before awaiting service cleanup', async () => {
    const cleanup = deferred();
    const events: string[] = [];
    const guard: ApplicationExitGuard = { currentRequestId: null };
    const closing = exitApplicationWithPreviewCleanup({
      requestId: 11,
      guard,
      invalidatePreviewRequest: () => events.push('invalidate'),
      cleanupPreview: () => {
        events.push('cleanup');
        return cleanup.promise;
      },
      canExitAfterCleanup: () => true,
      onExitDeferred: vi.fn(),
      exitApplication: async () => {
        events.push('exit');
      },
      onCleanupTimeout: vi.fn(),
      onCleanupError: vi.fn(),
      onExitError: vi.fn(),
    });

    expect(events).toEqual(['invalidate', 'cleanup']);
    expect(guard.currentRequestId).toBe(11);
    cleanup.resolve();
    await closing;
    expect(events).toEqual(['invalidate', 'cleanup', 'exit']);
  });

  it('continues to exit after a bounded cleanup timeout', async () => {
    vi.useFakeTimers();
    const guard: ApplicationExitGuard = { currentRequestId: null };
    const onCleanupTimeout = vi.fn();
    const exitApplication = vi.fn(async () => undefined);
    const closing = exitApplicationWithPreviewCleanup({
      requestId: 12,
      guard,
      invalidatePreviewRequest: vi.fn(),
      cleanupPreview: () => new Promise<void>(() => undefined),
      canExitAfterCleanup: () => true,
      onExitDeferred: vi.fn(),
      exitApplication,
      onCleanupTimeout,
      onCleanupError: vi.fn(),
      onExitError: vi.fn(),
      cleanupTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await closing;
    expect(onCleanupTimeout).toHaveBeenCalledOnce();
    expect(exitApplication).toHaveBeenCalledOnce();
  });

  it('releases the exit guard when the native exit request fails', async () => {
    const guard: ApplicationExitGuard = { currentRequestId: null };
    const onExitError = vi.fn();
    const exitApplication = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient exit failure'))
      .mockResolvedValueOnce(undefined);
    const options = {
      requestId: 13,
      guard,
      invalidatePreviewRequest: vi.fn(),
      cleanupPreview: vi.fn(async () => undefined),
      canExitAfterCleanup: () => true,
      onExitDeferred: vi.fn(),
      exitApplication,
      onCleanupTimeout: vi.fn(),
      onCleanupError: vi.fn(),
      onExitError,
    };

    await exitApplicationWithPreviewCleanup(options);
    expect(guard.currentRequestId).toBeNull();
    expect(onExitError).toHaveBeenCalledOnce();

    await exitApplicationWithPreviewCleanup(options);
    expect(exitApplication).toHaveBeenCalledTimes(2);
    expect(options.invalidatePreviewRequest).toHaveBeenCalledTimes(2);
    expect(guard.currentRequestId).toBe(13);
  });

  it('defers native exit when a task appears during cleanup', async () => {
    const guard: ApplicationExitGuard = { currentRequestId: null };
    const onExitDeferred = vi.fn();
    const exitApplication = vi.fn(async () => undefined);

    await exitApplicationWithPreviewCleanup({
      requestId: 14,
      guard,
      invalidatePreviewRequest: vi.fn(),
      cleanupPreview: vi.fn(async () => undefined),
      canExitAfterCleanup: () => false,
      onExitDeferred,
      exitApplication,
      onCleanupTimeout: vi.fn(),
      onCleanupError: vi.fn(),
      onExitError: vi.fn(),
    });

    expect(onExitDeferred).toHaveBeenCalledOnce();
    expect(exitApplication).not.toHaveBeenCalled();
    expect(guard.currentRequestId).toBeNull();
  });

  it('automatically runs the newest request after an older cleanup request is cancelled', async () => {
    let finishFirstAttempt!: (result: ApplicationExitLifecycleResult) => void;
    const firstAttempt = new Promise<ApplicationExitLifecycleResult>((resolve) => {
      finishFirstAttempt = resolve;
    });
    const runAttempt = vi.fn(
      (attempt: { requestId: number }): Promise<ApplicationExitLifecycleResult> =>
        attempt.requestId === 21 ? firstAttempt : Promise.resolve('exiting')
    );
    const queue = createApplicationExitQueue(runAttempt);

    queue.enqueue({ requestId: 21, forceExit: false });
    expect(runAttempt).toHaveBeenCalledWith({ requestId: 21, forceExit: false });

    // X cancels request 21 in native code; a new explicit tray Exit must wait
    // for its stale cleanup to fail and then continue without another click.
    queue.enqueue({ requestId: 22, forceExit: false });
    finishFirstAttempt('failed');

    await vi.waitFor(() => {
      expect(runAttempt).toHaveBeenLastCalledWith({ requestId: 22, forceExit: false });
    });
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it('discards a pending request when X cancels it before stale cleanup finishes', async () => {
    let finishFirstAttempt!: (result: ApplicationExitLifecycleResult) => void;
    const firstAttempt = new Promise<ApplicationExitLifecycleResult>((resolve) => {
      finishFirstAttempt = resolve;
    });
    const runAttempt = vi
      .fn<(attempt: { requestId: number }) => Promise<ApplicationExitLifecycleResult>>()
      .mockReturnValueOnce(firstAttempt)
      .mockResolvedValue('exiting');
    const queue = createApplicationExitQueue(runAttempt);

    queue.enqueue({ requestId: 31, forceExit: false });
    queue.enqueue({ requestId: 32, forceExit: false });
    queue.clearPending();
    finishFirstAttempt('failed');

    await Promise.resolve();
    await Promise.resolve();
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(runAttempt).toHaveBeenCalledWith({ requestId: 31, forceExit: false });
  });
});
