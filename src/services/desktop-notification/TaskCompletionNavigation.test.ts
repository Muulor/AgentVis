/** Task-completion notification target navigation and recovery regressions. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import {
  listenForTaskCompletionNotificationNavigation,
  navigateToTaskCompletionTarget,
  type TaskCompletionNotificationTarget,
} from './TaskCompletionNavigation';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createTauriWindow(): EventTarget & { __TAURI__: object } {
  return Object.assign(new EventTarget(), { __TAURI__: {} });
}

function createAgent(id: string, hubId: string) {
  return {
    id,
    hubId,
    name: id,
    avatarColor: null,
    modelProvider: null,
    modelName: null,
    mbRulesFilePath: null,
    saRulesFilePath: null,
    mbRules: null,
    saRules: null,
    chatRules: null,
    knowledgePaths: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createHub(id: string) {
  return {
    id,
    name: id,
    createdAt: '1',
    updatedAt: '1',
  };
}

function createTarget(
  overrides: Partial<TaskCompletionNotificationTarget> = {}
): TaskCompletionNotificationTarget {
  return {
    messageId: 'message-1',
    contextType: 'agent',
    contextId: 'agent-2',
    agentId: 'agent-2',
    hubId: 'hub-2',
    ...overrides,
  };
}

describe('task completion notification navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createMemoryStorage());
    tauri.listen.mockResolvedValue(tauri.unlisten);
    tauri.invoke.mockResolvedValue(null);
    useHubStore.setState({
      hubs: [createHub('hub-1'), createHub('hub-2')],
      currentHubId: 'hub-1',
      isLoading: false,
      error: null,
    });
    useAgentStore.setState({
      // The current agents array only contains the visible Hub, while agentHubMap
      // intentionally retains navigation metadata for previously loaded Hubs.
      agents: [createAgent('agent-1', 'hub-1')],
      currentAgentId: 'agent-1',
      agentHubMap: new Map([
        ['agent-1', 'hub-1'],
        ['agent-2', 'hub-2'],
      ]),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switches across Hubs and selects the Agent that completed the task', () => {
    expect(navigateToTaskCompletionTarget(createTarget())).toBe(true);
    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
  });

  it('uses the retained Agent mapping instead of a stale payload Hub', () => {
    expect(navigateToTaskCompletionTarget(createTarget({ hubId: 'hub-1' }))).toBe(true);
    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
  });

  it('opens the Hub conversation for a Hub-scoped reply', () => {
    expect(
      navigateToTaskCompletionTarget(
        createTarget({
          contextType: 'hub',
          contextId: 'hub-2',
        })
      )
    ).toBe(true);
    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBeNull();
  });

  it('ignores a notification after its Agent has been removed', () => {
    useAgentStore.setState({
      agentHubMap: new Map([['agent-1', 'hub-1']]),
    });

    expect(navigateToTaskCompletionTarget(createTarget())).toBe(false);
    expect(useHubStore.getState().currentHubId).toBe('hub-1');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-1');
  });

  it('ignores a notification after its Hub has been removed', () => {
    useHubStore.setState({ hubs: [createHub('hub-1')] });

    expect(navigateToTaskCompletionTarget(createTarget())).toBe(false);
    expect(useHubStore.getState().currentHubId).toBe('hub-1');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-1');
  });

  it('retains an early activation until Hub and Agent data finish loading', async () => {
    const target = createTarget({ messageId: 'queued-message' });
    vi.stubGlobal('window', createTauriWindow());
    useHubStore.setState({ hubs: [], currentHubId: null });
    useAgentStore.setState({
      agents: [],
      currentAgentId: null,
      agentHubMap: new Map(),
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        return target;
      }
      if (command === 'agent_get') {
        return { id: 'agent-2', hubId: 'hub-2' };
      }
      return undefined;
    });

    const stopListening = await listenForTaskCompletionNotificationNavigation();
    expect(useAgentStore.getState().currentAgentId).toBeNull();

    await vi.waitFor(() => {
      expect(useAgentStore.getState().agentHubMap.get('agent-2')).toBe('hub-2');
    });
    useHubStore.setState({ hubs: [createHub('hub-1'), createHub('hub-2')] });

    await vi.waitFor(() => {
      expect(useHubStore.getState().currentHubId).toBe('hub-2');
      expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
      expect(tauri.invoke).toHaveBeenCalledWith(
        'clear_pending_task_completion_notification_target',
        {
          messageId: 'queued-message',
        }
      );
    });

    stopListening();
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it('acknowledges a retained notification whose Agent was deleted', async () => {
    const target = createTarget({ messageId: 'deleted-agent-message' });
    vi.stubGlobal('window', createTauriWindow());
    useAgentStore.setState({
      agents: [],
      currentAgentId: null,
      agentHubMap: new Map(),
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        return target;
      }
      return null;
    });

    const stopListening = await listenForTaskCompletionNotificationNavigation();

    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        'clear_pending_task_completion_notification_target',
        {
          messageId: 'deleted-agent-message',
        }
      );
    });
    expect(useHubStore.getState().currentHubId).toBe('hub-1');
    expect(useAgentStore.getState().currentAgentId).toBeNull();

    stopListening();
  });

  it('keeps a live activation when an older retained snapshot resolves later', async () => {
    type ActivationHandler = (event: { payload: TaskCompletionNotificationTarget }) => void;

    const retainedTarget = createTarget({
      messageId: 'retained-message',
      agentId: 'agent-1',
      contextId: 'agent-1',
      hubId: 'hub-1',
    });
    const liveTarget = createTarget({ messageId: 'live-message' });
    let activationHandler: ActivationHandler | undefined;
    let resolveRetained: (target: TaskCompletionNotificationTarget | null) => void = () =>
      undefined;
    const retainedPromise = new Promise<TaskCompletionNotificationTarget | null>((resolve) => {
      resolveRetained = resolve;
    });

    vi.stubGlobal('window', createTauriWindow());
    tauri.listen.mockImplementation(
      async (_eventName: string, handler: ActivationHandler): Promise<typeof tauri.unlisten> => {
        activationHandler = handler;
        return tauri.unlisten;
      }
    );
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        return retainedPromise;
      }
      return Promise.resolve(undefined);
    });

    const listening = listenForTaskCompletionNotificationNavigation();
    await vi.waitFor(() => {
      expect(activationHandler).toBeDefined();
      expect(tauri.invoke).toHaveBeenCalledWith('get_pending_task_completion_notification_target');
    });

    activationHandler?.({ payload: liveTarget });
    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');

    resolveRetained(retainedTarget);
    const stopListening = await listening;

    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
    stopListening();
  });

  it('does not let a cleaned-up resolver overwrite a newer listener activation', async () => {
    type ActivationHandler = (event: { payload: TaskCompletionNotificationTarget }) => void;

    const oldTarget = createTarget({
      messageId: 'old-listener-message',
      agentId: 'agent-3',
      contextId: 'agent-3',
      hubId: 'hub-1',
    });
    const liveTarget = createTarget({ messageId: 'new-listener-message' });
    const activationHandlers: ActivationHandler[] = [];
    let retainedReadCount = 0;
    let resolveAgentOwner: (owner: { id: string; hubId: string }) => void = () => undefined;
    const agentOwnerPromise = new Promise<{ id: string; hubId: string }>((resolve) => {
      resolveAgentOwner = resolve;
    });

    vi.stubGlobal('window', createTauriWindow());
    tauri.listen.mockImplementation(async (_eventName: string, handler: ActivationHandler) => {
      activationHandlers.push(handler);
      return vi.fn();
    });
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        retainedReadCount += 1;
        return Promise.resolve(retainedReadCount === 1 ? oldTarget : null);
      }
      if (command === 'agent_get') {
        return agentOwnerPromise;
      }
      return Promise.resolve(undefined);
    });

    const stopOldListener = await listenForTaskCompletionNotificationNavigation();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('agent_get', { id: 'agent-3' });
    });
    stopOldListener();

    const stopCurrentListener = await listenForTaskCompletionNotificationNavigation();
    activationHandlers[1]?.({ payload: liveTarget });
    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');

    resolveAgentOwner({ id: 'agent-3', hubId: 'hub-1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
    stopCurrentListener();
  });

  it('recovers a retained activation when focus resumes a hidden WebView', async () => {
    const target = createTarget({ messageId: 'hidden-window-message' });
    let retainedReadCount = 0;
    vi.stubGlobal('window', createTauriWindow());
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        retainedReadCount += 1;
        return Promise.resolve(retainedReadCount === 1 ? null : target);
      }
      return Promise.resolve(undefined);
    });

    const stopListening = await listenForTaskCompletionNotificationNavigation();
    await vi.waitFor(() => expect(retainedReadCount).toBe(1));

    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => {
      expect(useHubStore.getState().currentHubId).toBe('hub-2');
      expect(useAgentStore.getState().currentAgentId).toBe('agent-2');
      expect(tauri.invoke).toHaveBeenCalledWith(
        'clear_pending_task_completion_notification_target',
        { messageId: 'hidden-window-message' }
      );
    });
    stopListening();
  });

  it('does not navigate twice when focus rereads the just-handled live target', async () => {
    type ActivationHandler = (event: { payload: TaskCompletionNotificationTarget }) => void;

    const target = createTarget({ messageId: 'live-focus-message' });
    let activationHandler: ActivationHandler | undefined;
    let retainedTarget: TaskCompletionNotificationTarget | null = null;
    let retainedReadCount = 0;
    const originalSetCurrentHubId = useHubStore.getState().setCurrentHubId;
    const setCurrentHubId = vi.fn(originalSetCurrentHubId);
    useHubStore.setState({ setCurrentHubId });
    vi.stubGlobal('window', createTauriWindow());
    tauri.listen.mockImplementation(
      async (_eventName: string, handler: ActivationHandler): Promise<typeof tauri.unlisten> => {
        activationHandler = handler;
        return tauri.unlisten;
      }
    );
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_task_completion_notification_target') {
        retainedReadCount += 1;
        return Promise.resolve(retainedTarget);
      }
      return Promise.resolve(undefined);
    });

    const stopListening = await listenForTaskCompletionNotificationNavigation();
    await vi.waitFor(() => expect(retainedReadCount).toBe(1));

    activationHandler?.({ payload: target });
    expect(setCurrentHubId).toHaveBeenCalledOnce();

    retainedTarget = target;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(retainedReadCount).toBe(2));

    expect(setCurrentHubId).toHaveBeenCalledOnce();
    stopListening();
    useHubStore.setState({ setCurrentHubId: originalSetCurrentHubId });
  });
});
