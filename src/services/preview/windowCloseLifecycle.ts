/**
 * Window-close lifecycle coordinator for Project Preview.
 *
 * Invalidates renderer request generations synchronously, bounds asynchronous
 * cleanup, and makes a failed native destroy retryable instead of latching the
 * window in a permanently intercepted state.
 */

const DEFAULT_PREVIEW_CLOSE_TIMEOUT_MS = 5_000;

export interface WindowCloseGuard {
  current: boolean;
}

export interface WindowCloseLifecycleOptions {
  guard: WindowCloseGuard;
  invalidatePreviewRequest: () => void;
  cleanupPreview: () => Promise<void>;
  destroyWindow: () => Promise<void>;
  onCleanupTimeout: () => void;
  onCleanupError: (error: unknown) => void;
  onDestroyError: (error: unknown) => void;
  cleanupTimeoutMs?: number;
}

/** Run the close sequence at most once unless native window destruction fails. */
export async function closeWindowWithPreviewCleanup(
  options: WindowCloseLifecycleOptions
): Promise<void> {
  if (options.guard.current) return;
  options.guard.current = true;

  // This must happen before the first await so a pending source scan cannot submit
  // a new service request while close cleanup is already in progress.
  try {
    options.invalidatePreviewRequest();
  } catch (error) {
    options.onCleanupError(error);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const cleanupResult = await Promise.race([
      options.cleanupPreview().then(() => 'cleaned' as const),
      new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve('timeout');
        }, options.cleanupTimeoutMs ?? DEFAULT_PREVIEW_CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (cleanupResult === 'timeout') options.onCleanupTimeout();
  } catch (error) {
    options.onCleanupError(error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  try {
    await options.destroyWindow();
  } catch (error) {
    // CloseRequested remains intercepted while the renderer is alive. Release the
    // guard so a transient IPC failure cannot make every later close a no-op.
    options.guard.current = false;
    options.onDestroyError(error);
  }
}
