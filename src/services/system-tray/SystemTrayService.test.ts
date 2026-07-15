/** Native tray request/ACK, localization, and lifecycle regression tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlistenExit: vi.fn(),
  unlistenHidden: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import {
  cancelSystemTrayExitRequest,
  exitApplication,
  listenForSystemTrayEvents,
  resolveSystemTrayExitAction,
  SYSTEM_TRAY_EXIT_REQUESTED_EVENT,
  updateSystemTrayLabels,
} from './SystemTrayService';

type NativeEventHandler = (event: { payload: unknown }) => void;

function createTauriWindow(): EventTarget & { __TAURI__: object } {
  return Object.assign(new EventTarget(), { __TAURI__: {} });
}

function createVisibleDocument(): EventTarget & { visibilityState: 'visible' } {
  return Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SystemTrayService', () => {
  const nativeHandlers = new Map<string, NativeEventHandler>();
  let activeRequestId: number | null;
  let hiddenPending: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    nativeHandlers.clear();
    activeRequestId = null;
    hiddenPending = false;
    vi.stubGlobal('window', createTauriWindow());
    vi.stubGlobal('document', createVisibleDocument());
    tauri.listen.mockImplementation(async (eventName: string, handler: NativeEventHandler) => {
      nativeHandlers.set(eventName, handler);
      return eventName === SYSTEM_TRAY_EXIT_REQUESTED_EVENT
        ? tauri.unlistenExit
        : tauri.unlistenHidden;
    });
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          case 'get_active_system_tray_exit_request':
            return activeRequestId;
          case 'acknowledge_system_tray_exit_request':
            return args?.requestId === activeRequestId;
          case 'cancel_system_tray_exit_request':
            if (args?.requestId !== activeRequestId) return false;
            activeRequestId = null;
            return true;
          case 'get_pending_main_window_hidden_event':
            return hiddenPending;
          case 'acknowledge_main_window_hidden_event': {
            const wasPending = hiddenPending;
            hiddenPending = false;
            return wasPending;
          }
          default:
            return undefined;
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves active-task confirmation to tray Exit only', () => {
    expect(
      resolveSystemTrayExitAction({
        sendingContextCount: 0,
        executingCronJobCount: 0,
        activeImTaskCount: 0,
      })
    ).toBe('exit');
    expect(
      resolveSystemTrayExitAction({
        sendingContextCount: 0,
        executingCronJobCount: 1,
        activeImTaskCount: 0,
      })
    ).toBe('confirm');
    expect(
      resolveSystemTrayExitAction({
        sendingContextCount: 0,
        executingCronJobCount: 0,
        activeImTaskCount: 1,
      })
    ).toBe('confirm');
  });

  it('accepts a retained Exit request before acknowledging it', async () => {
    const order: string[] = [];
    activeRequestId = 41;
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (command === 'get_pending_main_window_hidden_event') return false;
        if (command === 'get_active_system_tray_exit_request') return activeRequestId;
        if (command === 'acknowledge_system_tray_exit_request') {
          order.push('ack');
          return args?.requestId === activeRequestId;
        }
        return undefined;
      }
    );

    const stopListening = await listenForSystemTrayEvents({
      onExitRequested: (requestId) => {
        order.push(`handle:${requestId}`);
      },
      onMainWindowHidden: vi.fn(),
    });

    await vi.waitFor(() => expect(order).toEqual(['handle:41', 'ack']));
    stopListening();
    expect(tauri.unlistenExit).toHaveBeenCalledOnce();
    expect(tauri.unlistenHidden).toHaveBeenCalledOnce();
  });

  it('uses focus and visibility recovery for an Exit event missed while hidden', async () => {
    const onExitRequested = vi.fn();
    const stopListening = await listenForSystemTrayEvents({
      onExitRequested,
      onMainWindowHidden: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('get_active_system_tray_exit_request');
    });

    activeRequestId = 72;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(onExitRequested).toHaveBeenCalledWith(72));
    stopListening();
  });

  it('coalesces duplicate live events for the same request id', async () => {
    const onExitRequested = vi.fn();
    const stopListening = await listenForSystemTrayEvents({
      onExitRequested,
      onMainWindowHidden: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('get_active_system_tray_exit_request');
    });

    activeRequestId = 83;
    nativeHandlers.get(SYSTEM_TRAY_EXIT_REQUESTED_EVENT)?.({ payload: { requestId: 83 } });
    nativeHandlers.get(SYSTEM_TRAY_EXIT_REQUESTED_EVENT)?.({ payload: { requestId: 83 } });

    await vi.waitFor(() => expect(onExitRequested).toHaveBeenCalledOnce());
    expect(onExitRequested).toHaveBeenCalledWith(83);
    stopListening();
  });

  it('does not lose an in-flight request when a StrictMode listener is cleaned up', async () => {
    const firstRead = deferred<number | null>();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    activeRequestId = 97;
    let activeReadCount = 0;
    tauri.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === 'get_pending_main_window_hidden_event') return false;
      if (command === 'get_active_system_tray_exit_request') {
        activeReadCount += 1;
        return activeReadCount === 1 ? firstRead.promise : activeRequestId;
      }
      if (command === 'acknowledge_system_tray_exit_request') return true;
      return undefined;
    });

    const stopFirst = await listenForSystemTrayEvents({
      onExitRequested: firstHandler,
      onMainWindowHidden: vi.fn(),
    });
    await vi.waitFor(() => expect(activeReadCount).toBe(1));
    stopFirst();
    firstRead.resolve(activeRequestId);
    await Promise.resolve();
    expect(firstHandler).not.toHaveBeenCalled();

    const stopSecond = await listenForSystemTrayEvents({
      onExitRequested: secondHandler,
      onMainWindowHidden: vi.fn(),
    });
    await vi.waitFor(() => expect(secondHandler).toHaveBeenCalledWith(97));
    stopSecond();
  });

  it('reconciles a retained hidden event before the next window activation', async () => {
    const onMainWindowHidden = vi.fn();
    const stopListening = await listenForSystemTrayEvents({
      onExitRequested: vi.fn(),
      onMainWindowHidden,
    });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('get_pending_main_window_hidden_event');
    });

    hiddenPending = true;
    window.dispatchEvent(new Event('pageshow'));

    await vi.waitFor(() => expect(onMainWindowHidden).toHaveBeenCalledOnce());
    expect(tauri.invoke).toHaveBeenCalledWith('acknowledge_main_window_hidden_event');
    stopListening();
  });

  it('localizes labels and uses request-scoped cancel/exit commands', async () => {
    activeRequestId = 109;
    await updateSystemTrayLabels('打开 AgentVis', '退出');
    await cancelSystemTrayExitRequest(109);
    await exitApplication(109);

    expect(tauri.invoke).toHaveBeenCalledWith('set_system_tray_labels', {
      openLabel: '打开 AgentVis',
      exitLabel: '退出',
    });
    expect(tauri.invoke).toHaveBeenCalledWith('cancel_system_tray_exit_request', {
      requestId: 109,
    });
    expect(tauri.invoke).toHaveBeenCalledWith('exit_application_from_system_tray', {
      requestId: 109,
    });
  });
});
