import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore } from '../agentStore';
import { CURRENT_HUB_STORAGE_KEY, useHubStore } from '../hubStore';

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

describe('hubStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    useHubStore.setState({
      hubs: [],
      currentHubId: null,
      isLoading: false,
      error: null,
    });
    useAgentStore.setState({
      agents: [],
      currentAgentId: null,
      agentHubMap: new Map(),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the selected hub id', () => {
    useHubStore.getState().setCurrentHubId('hub-2');

    expect(useHubStore.getState().currentHubId).toBe('hub-2');
    expect(localStorage.getItem(CURRENT_HUB_STORAGE_KEY)).toBe('hub-2');
  });

  it('clears the persisted hub id when the selection is cleared', () => {
    useHubStore.getState().setCurrentHubId('hub-2');
    useHubStore.getState().setCurrentHubId(null);

    expect(useHubStore.getState().currentHubId).toBeNull();
    expect(localStorage.getItem(CURRENT_HUB_STORAGE_KEY)).toBeNull();
  });

  it('clears the selected agent when removing its hub', () => {
    useHubStore.setState({
      hubs: [createHub('hub-1'), createHub('hub-2')],
      currentHubId: 'hub-1',
    });
    localStorage.setItem(CURRENT_HUB_STORAGE_KEY, 'hub-1');
    useAgentStore.setState({
      agents: [createAgent('agent-1', 'hub-1'), createAgent('agent-2', 'hub-2')],
      currentAgentId: 'agent-1',
      agentHubMap: new Map([
        ['agent-1', 'hub-1'],
        ['agent-2', 'hub-2'],
      ]),
    });

    useHubStore.getState().removeHub('hub-1');

    expect(useHubStore.getState().hubs.map((hub) => hub.id)).toEqual(['hub-2']);
    expect(useHubStore.getState().currentHubId).toBeNull();
    expect(useAgentStore.getState().currentAgentId).toBeNull();
    expect(useAgentStore.getState().agents.map((agent) => agent.id)).toEqual(['agent-2']);
    expect(useAgentStore.getState().agentHubMap.has('agent-1')).toBe(false);
    expect(useAgentStore.getState().agentHubMap.get('agent-2')).toBe('hub-2');
    expect(localStorage.getItem(CURRENT_HUB_STORAGE_KEY)).toBeNull();
  });

  it('keeps the selected agent when removing a different hub', () => {
    useHubStore.setState({
      hubs: [createHub('hub-1'), createHub('hub-2')],
      currentHubId: 'hub-1',
    });
    useAgentStore.setState({
      agents: [createAgent('agent-1', 'hub-1'), createAgent('agent-2', 'hub-2')],
      currentAgentId: 'agent-1',
      agentHubMap: new Map([
        ['agent-1', 'hub-1'],
        ['agent-2', 'hub-2'],
      ]),
    });

    useHubStore.getState().removeHub('hub-2');

    expect(useHubStore.getState().hubs.map((hub) => hub.id)).toEqual(['hub-1']);
    expect(useHubStore.getState().currentHubId).toBe('hub-1');
    expect(useAgentStore.getState().currentAgentId).toBe('agent-1');
    expect(useAgentStore.getState().agents.map((agent) => agent.id)).toEqual(['agent-1']);
    expect(useAgentStore.getState().agentHubMap.get('agent-1')).toBe('hub-1');
    expect(useAgentStore.getState().agentHubMap.has('agent-2')).toBe(false);
  });
});
