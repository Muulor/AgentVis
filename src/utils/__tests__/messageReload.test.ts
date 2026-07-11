import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const memoryStorage: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => memoryStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage[key] = value;
    },
    removeItem: (key: string) => {
      Reflect.deleteProperty(memoryStorage, key);
    },
    clear: () => {
      Object.keys(memoryStorage).forEach((key) => Reflect.deleteProperty(memoryStorage, key));
    },
    get length() {
      return Object.keys(memoryStorage).length;
    },
    key: (index: number) => Object.keys(memoryStorage)[index] ?? null,
  } as Storage;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { useWidgetStore } from '@stores/widgetStore';
import { mapPersistedMessages, restoreWidgetSubmissionsFromMessages } from '../messageReload';

function resetWidgetStore() {
  useWidgetStore.setState({
    pendingAction: null,
    selections: new Map(),
    pendingUndo: null,
    bubbleSelections: new Map(),
    submittedExtraTexts: new Map(),
  });
}

describe('messageReload', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWidgetStore();
  });

  it('maps persisted messages with stable ordering and quotedFrom metadata', () => {
    const messages = mapPersistedMessages([
      {
        id: 'b-message',
        agentId: 'agent-1',
        role: 'assistant',
        content: 'second',
        metadata: null,
        createdAt: 1_000,
      },
      {
        id: 'a-message',
        agentId: 'agent-1',
        role: 'user',
        content: 'first',
        metadata: JSON.stringify({
          quotedFrom: [
            {
              content: 'raw quote',
              contextContent: 'context quote',
              agentName: 'Solar',
            },
          ],
        }),
        createdAt: 1_000,
      },
    ]);

    expect(messages.map((message) => message.id)).toEqual(['a-message', 'b-message']);
    expect(messages[0]?.quotedFrom).toEqual([
      {
        content: 'context quote',
        agentName: 'Solar',
      },
    ]);
  });

  it('restores widget submitted state from reloaded hidden widget messages', () => {
    const restoredCount = restoreWidgetSubmissionsFromMessages([
      {
        id: 'widget-message',
        agentId: 'agent-1',
        role: 'user',
        content: 'submitted widget payload',
        createdAt: 1_000,
        metadata: {
          source: 'widget',
          widgetBubbleId: 'bubble-1',
          widgetSelections: [
            {
              widgetKey: 'choices:bubble-1:Scope',
              labels: ['Uploaded only'],
            },
          ],
          widgetExtraText: 'restore note',
        },
      },
    ]);

    const state = useWidgetStore.getState();
    expect(restoredCount).toBe(1);
    expect(state.isBubbleSubmitted('bubble-1')).toBe(true);
    expect(state.bubbleSelections.get('bubble-1')?.get('choices:bubble-1:Scope')).toEqual([
      'Uploaded only',
    ]);
    expect(state.submittedExtraTexts.get('bubble-1')).toBe('restore note');
  });
});
