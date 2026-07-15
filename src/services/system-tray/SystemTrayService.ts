/**
 * System tray renderer bridge.
 *
 * Localizes the native menu and drains retained Exit requests after startup,
 * native activation, or restoration from a suspended hidden WebView.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getLogger } from '@services/logger';

const logger = getLogger('SystemTrayService');

export const SYSTEM_TRAY_EXIT_REQUESTED_EVENT = 'system-tray:exit-requested';
export const MAIN_WINDOW_HIDDEN_EVENT = 'system-tray:main-window-hidden';

interface SystemTrayEventHandlers {
  onExitRequested: (requestId: number) => void;
  onMainWindowHidden: () => void;
}

interface NativeExitRequestPayload {
  requestId: number;
}

const NATIVE_STATE_RETRY_DELAYS_MS = [100, 300, 900] as const;

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export interface ActiveTaskSources {
  sendingContextCount: number;
  executingCronJobCount: number;
  activeImTaskCount: number;
}

/** Maps all renderer task sources, including Cron/IM handoff, to the Exit action. */
export function resolveSystemTrayExitAction(sources: ActiveTaskSources): 'confirm' | 'exit' {
  const activeTaskCount =
    sources.sendingContextCount + sources.executingCronJobCount + sources.activeImTaskCount;
  return activeTaskCount > 0 ? 'confirm' : 'exit';
}

/** Keeps native tray labels in sync with the renderer language. */
export async function updateSystemTrayLabels(openLabel: string, exitLabel: string): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke('set_system_tray_labels', { openLabel, exitLabel });
}

/** Registers reliable Exit/hidden listeners for the renderer lifetime. */
export async function listenForSystemTrayEvents(
  handlers: SystemTrayEventHandlers
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => undefined;
  }

  const lifecycle = { disposed: false };
  const rendererDocument = typeof document === 'undefined' ? null : document;
  const refreshState = { inProgress: false, requestedAgain: false, retryAttempt: 0 };
  const isDisposed = (): boolean => lifecycle.disposed;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHandledExitRequestId: number | null = null;
  let queuedExitRequestId: number | null = null;
  let processingExitRequestId: number | null = null;
  let exitRequestInProgress = false;

  const scheduleNativeStateRetry = (): void => {
    if (isDisposed() || retryTimer !== undefined) return;
    const delay = NATIVE_STATE_RETRY_DELAYS_MS[refreshState.retryAttempt];
    if (delay === undefined) return;
    refreshState.retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void refreshNativeState();
    }, delay);
  };

  const processExitRequestQueue = async (): Promise<void> => {
    if (exitRequestInProgress || isDisposed()) return;
    exitRequestInProgress = true;
    try {
      while (queuedExitRequestId !== null && !isDisposed()) {
        const requestId = queuedExitRequestId;
        queuedExitRequestId = null;
        if (requestId === lastHandledExitRequestId) continue;
        processingExitRequestId = requestId;

        try {
          const activeRequestId = await invoke<number | null>(
            'get_active_system_tray_exit_request'
          );
          if (isDisposed() || activeRequestId !== requestId) continue;

          handlers.onExitRequested(requestId);
          const acknowledged = await invoke<boolean>('acknowledge_system_tray_exit_request', {
            requestId,
          });
          if (acknowledged) {
            lastHandledExitRequestId = requestId;
          } else {
            scheduleNativeStateRetry();
          }
        } catch (error) {
          if (!isDisposed()) {
            logger.warn('[SystemTrayService] Failed to handle a tray Exit request', error);
            scheduleNativeStateRetry();
          }
        } finally {
          processingExitRequestId = null;
        }
      }
    } finally {
      exitRequestInProgress = false;
      processingExitRequestId = null;
      if (queuedExitRequestId !== null && !isDisposed()) {
        void processExitRequestQueue();
      }
    }
  };

  const queueExitRequest = (requestId: number): void => {
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || isDisposed()) return;
    if (requestId === lastHandledExitRequestId) return;
    if (requestId === processingExitRequestId) return;
    if (queuedExitRequestId === requestId) return;
    queuedExitRequestId = requestId;
    void processExitRequestQueue();
  };

  const refreshNativeState = async (): Promise<void> => {
    if (isDisposed()) return;
    if (refreshState.inProgress) {
      refreshState.requestedAgain = true;
      return;
    }

    refreshState.inProgress = true;
    try {
      refreshState.requestedAgain = false;
      const hiddenPending = await invoke<boolean>('get_pending_main_window_hidden_event');
      if (hiddenPending && !isDisposed()) {
        handlers.onMainWindowHidden();
        await invoke('acknowledge_main_window_hidden_event');
      }

      const activeRequestId = await invoke<number | null>('get_active_system_tray_exit_request');
      if (activeRequestId !== null && !isDisposed()) {
        queueExitRequest(activeRequestId);
      }
      refreshState.retryAttempt = 0;
    } catch (error) {
      if (!isDisposed()) {
        logger.warn('[SystemTrayService] Failed to reconcile native tray state', error);
        scheduleNativeStateRetry();
      }
    } finally {
      refreshState.inProgress = false;
      if (refreshState.requestedAgain && !isDisposed()) {
        refreshState.requestedAgain = false;
        void refreshNativeState();
      }
    }
  };

  const stopExitListening = await listen<NativeExitRequestPayload>(
    SYSTEM_TRAY_EXIT_REQUESTED_EVENT,
    ({ payload }) => {
      queueExitRequest(payload.requestId);
    }
  );
  let stopHiddenListening: UnlistenFn;
  try {
    stopHiddenListening = await listen(MAIN_WINDOW_HIDDEN_EVENT, () => {
      void refreshNativeState();
    });
  } catch (error) {
    stopExitListening();
    throw error;
  }

  // Restoring a suspended WebView focuses the native window. Draining on focus
  // covers an event emitted before WebView2 resumes JavaScript execution.
  const handleRendererResumed = (): void => {
    void refreshNativeState();
  };
  const handleVisibilityChange = (): void => {
    if (rendererDocument?.visibilityState === 'visible') handleRendererResumed();
  };
  window.addEventListener('focus', handleRendererResumed);
  window.addEventListener('pageshow', handleRendererResumed);
  rendererDocument?.addEventListener('visibilitychange', handleVisibilityChange);
  void refreshNativeState();

  return () => {
    lifecycle.disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    window.removeEventListener('focus', handleRendererResumed);
    window.removeEventListener('pageshow', handleRendererResumed);
    rendererDocument?.removeEventListener('visibilitychange', handleVisibilityChange);
    stopHiddenListening();
    stopExitListening();
  };
}

/** Requests true process exit after the renderer has completed cleanup. */
export async function cancelSystemTrayExitRequest(requestId: number): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke('cancel_system_tray_exit_request', { requestId });
}

/** Performs true process exit only for the still-authorized tray request. */
export async function exitApplication(requestId: number): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke('exit_application_from_system_tray', { requestId });
}
