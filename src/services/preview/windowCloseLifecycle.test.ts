/** Window-close request invalidation, timeout, and retry regression tests. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWindowWithPreviewCleanup, type WindowCloseGuard } from './windowCloseLifecycle';

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

describe('closeWindowWithPreviewCleanup', () => {
  it('invalidates the renderer request before awaiting service cleanup', async () => {
    const cleanup = deferred();
    const events: string[] = [];
    const guard: WindowCloseGuard = { current: false };
    const closing = closeWindowWithPreviewCleanup({
      guard,
      invalidatePreviewRequest: () => events.push('invalidate'),
      cleanupPreview: () => {
        events.push('cleanup');
        return cleanup.promise;
      },
      destroyWindow: async () => {
        events.push('destroy');
      },
      onCleanupTimeout: vi.fn(),
      onCleanupError: vi.fn(),
      onDestroyError: vi.fn(),
    });

    expect(events).toEqual(['invalidate', 'cleanup']);
    expect(guard.current).toBe(true);
    cleanup.resolve();
    await closing;
    expect(events).toEqual(['invalidate', 'cleanup', 'destroy']);
  });

  it('continues to destroy after a bounded cleanup timeout', async () => {
    vi.useFakeTimers();
    const guard: WindowCloseGuard = { current: false };
    const onCleanupTimeout = vi.fn();
    const destroyWindow = vi.fn(async () => undefined);
    const closing = closeWindowWithPreviewCleanup({
      guard,
      invalidatePreviewRequest: vi.fn(),
      cleanupPreview: () => new Promise<void>(() => undefined),
      destroyWindow,
      onCleanupTimeout,
      onCleanupError: vi.fn(),
      onDestroyError: vi.fn(),
      cleanupTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await closing;
    expect(onCleanupTimeout).toHaveBeenCalledOnce();
    expect(destroyWindow).toHaveBeenCalledOnce();
  });

  it('releases the close guard when native destruction fails', async () => {
    const guard: WindowCloseGuard = { current: false };
    const onDestroyError = vi.fn();
    const destroyWindow = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient destroy failure'))
      .mockResolvedValueOnce(undefined);
    const options = {
      guard,
      invalidatePreviewRequest: vi.fn(),
      cleanupPreview: vi.fn(async () => undefined),
      destroyWindow,
      onCleanupTimeout: vi.fn(),
      onCleanupError: vi.fn(),
      onDestroyError,
    };

    await closeWindowWithPreviewCleanup(options);
    expect(guard.current).toBe(false);
    expect(onDestroyError).toHaveBeenCalledOnce();

    await closeWindowWithPreviewCleanup(options);
    expect(destroyWindow).toHaveBeenCalledTimes(2);
    expect(options.invalidatePreviewRequest).toHaveBeenCalledTimes(2);
    expect(guard.current).toBe(true);
  });
});
