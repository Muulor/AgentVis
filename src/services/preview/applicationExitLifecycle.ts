/**
 * Application exit lifecycle coordinator for Project Preview.
 *
 * Invalidates renderer request generations synchronously, bounds asynchronous
 * cleanup, and makes a failed native exit retryable instead of latching the
 * application in a permanently intercepted state.
 */

const DEFAULT_PREVIEW_EXIT_TIMEOUT_MS = 5_000;

export interface ApplicationExitGuard {
  currentRequestId: number | null;
}

export interface ApplicationExitAttempt {
  requestId: number;
  forceExit: boolean;
}

export type ApplicationExitLifecycleResult = 'busy' | 'deferred' | 'failed' | 'exiting';

export interface ApplicationExitQueue {
  enqueue: (attempt: ApplicationExitAttempt) => void;
  clearPending: () => void;
}

export interface ApplicationExitLifecycleOptions {
  requestId: number;
  guard: ApplicationExitGuard;
  invalidatePreviewRequest: () => void;
  cleanupPreview: () => Promise<void>;
  canExitAfterCleanup: () => boolean;
  onExitDeferred: () => void;
  exitApplication: () => Promise<void>;
  onCleanupTimeout: () => void;
  onCleanupError: (error: unknown) => void;
  onExitError: (error: unknown) => void;
  cleanupTimeoutMs?: number;
}

/**
 * Keeps only the latest request while one asynchronous exit attempt is running.
 * A successful native exit stops the queue because the process is terminating.
 */
export function createApplicationExitQueue(
  runAttempt: (attempt: ApplicationExitAttempt) => Promise<ApplicationExitLifecycleResult>
): ApplicationExitQueue {
  let queuedAttempt: ApplicationExitAttempt | null = null;
  let isRunning = false;

  const drain = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      while (queuedAttempt !== null) {
        const attempt = queuedAttempt;
        queuedAttempt = null;
        const result = await runAttempt(attempt);
        if (result === 'exiting') {
          queuedAttempt = null;
          return;
        }
      }
    } finally {
      isRunning = false;
      if (queuedAttempt !== null) void drain();
    }
  };

  return {
    enqueue(attempt) {
      queuedAttempt = attempt;
      void drain();
    },
    clearPending() {
      queuedAttempt = null;
    },
  };
}

/** Run one request-owned exit sequence unless another request still owns cleanup. */
export async function exitApplicationWithPreviewCleanup(
  options: ApplicationExitLifecycleOptions
): Promise<ApplicationExitLifecycleResult> {
  if (options.guard.currentRequestId !== null) return 'busy';
  options.guard.currentRequestId = options.requestId;

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
        }, options.cleanupTimeoutMs ?? DEFAULT_PREVIEW_EXIT_TIMEOUT_MS);
      }),
    ]);
    if (cleanupResult === 'timeout') options.onCleanupTimeout();
  } catch (error) {
    options.onCleanupError(error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (!options.canExitAfterCleanup()) {
    if (options.guard.currentRequestId === options.requestId) {
      options.guard.currentRequestId = null;
    }
    options.onExitDeferred();
    return 'deferred';
  }

  try {
    await options.exitApplication();
    return 'exiting';
  } catch (error) {
    // Release the guard so a transient IPC failure cannot make every later tray
    // Exit request a no-op.
    if (options.guard.currentRequestId === options.requestId) {
      options.guard.currentRequestId = null;
    }
    options.onExitError(error);
    return 'failed';
  }
}
