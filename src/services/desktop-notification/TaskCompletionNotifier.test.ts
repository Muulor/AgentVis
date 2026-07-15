/** Interactive task-completion notification delivery and fallback regressions. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  isFocused: vi.fn(),
  isMinimized: vi.fn(),
  isVisible: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: mocks.isFocused,
    isMinimized: mocks.isMinimized,
    isVisible: mocks.isVisible,
  }),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
}));
vi.mock('@services/logger', () => ({
  getLogger: () => ({
    debug: mocks.debug,
    warn: mocks.warn,
  }),
}));

import { useSettingsStore } from '@stores/settingsStore';
import {
  notifyTaskCompleted,
  type TaskCompletionNotificationPayload,
} from './TaskCompletionNotifier';

function createPayload(id: string): TaskCompletionNotificationPayload {
  return {
    id,
    contextType: 'agent',
    contextId: 'agent-2',
    agentId: 'agent-2',
    agentName: 'Cleo',
    hubId: 'hub-2',
    content: 'The requested work is complete.',
    source: 'manual',
    mode: 'planning',
    createdAt: 123,
  };
}

describe('task completion notification delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      __TAURI__: {},
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
    useSettingsStore.setState({
      taskCompletionNotificationsEnabled: true,
      taskCompletionNotificationsBackgroundOnly: true,
      taskCompletionNotificationContentMode: 'summary',
    });
    mocks.isFocused.mockResolvedValue(false);
    mocks.isMinimized.mockResolvedValue(true);
    mocks.isVisible.mockResolvedValue(true);
    mocks.isPermissionGranted.mockResolvedValue(true);
    mocks.invoke.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the interactive native command with the complete navigation target', async () => {
    await notifyTaskCompleted(createPayload('interactive-message'));

    expect(mocks.isFocused).toHaveBeenCalledOnce();
    expect(mocks.isPermissionGranted).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('show_task_completion_notification', {
      request: expect.objectContaining({
        actionLabel: expect.any(String),
        target: {
          messageId: 'interactive-message',
          contextType: 'agent',
          contextId: 'agent-2',
          agentId: 'agent-2',
          hubId: 'hub-2',
        },
      }),
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('falls back to the basic desktop notification on unsupported platforms', async () => {
    mocks.invoke.mockResolvedValue(false);

    await notifyTaskCompleted(createPayload('unsupported-message'));

    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Cleo'),
        body: 'The requested work is complete.',
      })
    );
  });

  it('falls back to the basic desktop notification when the native command fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('WinRT unavailable'));

    await notifyTaskCompleted(createPayload('failed-native-message'));

    expect(mocks.sendNotification).toHaveBeenCalledOnce();
  });
});
