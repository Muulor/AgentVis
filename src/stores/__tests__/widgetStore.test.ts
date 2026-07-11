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

import { useWidgetStore } from '../widgetStore';

function resetWidgetStore() {
  useWidgetStore.setState({
    pendingAction: null,
    selections: new Map(),
    pendingUndo: null,
    bubbleSelections: new Map(),
    submittedExtraTexts: new Map(),
  });
}

describe('widgetStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWidgetStore();
  });

  it('reopens a submitted bubble without dropping existing widget selections', () => {
    const store = useWidgetStore.getState();
    store.setBubbleWidgetSelection('msg-1', 'tree:msg-1:Decision', ['A -> Realtime']);
    store.setBubbleWidgetSelection('msg-1', 'choices:msg-1:Scope', ['Uploaded only']);
    store.setSubmittedExtraText('msg-1', 'old note');
    store.markBubbleSubmitted('msg-1');

    useWidgetStore.getState().reopenBubbleSelectionsAndUndo('msg-1', 'ctx-1');

    const state = useWidgetStore.getState();
    const selections = state.bubbleSelections.get('msg-1');
    expect(state.isBubbleSubmitted('msg-1')).toBe(false);
    expect(state.pendingUndo).toEqual({ contextId: 'ctx-1', widgetBubbleId: 'msg-1' });
    expect(selections?.get('tree:msg-1:Decision')).toEqual(['A -> Realtime']);
    expect(selections?.get('choices:msg-1:Scope')).toEqual(['Uploaded only']);
    expect(state.submittedExtraTexts.has('msg-1')).toBe(false);
  });

  it('restores submitted bubble selections and extra text from a persisted snapshot', () => {
    const store = useWidgetStore.getState();

    store.restoreBubbleSubmittedState(
      'msg-1',
      [
        {
          widgetKey: 'choices:msg-1:Scope',
          labels: ['Uploaded only'],
        },
      ],
      'restore note'
    );

    const state = useWidgetStore.getState();
    expect(state.isBubbleSubmitted('msg-1')).toBe(true);
    expect(state.bubbleSelections.get('msg-1')?.get('choices:msg-1:Scope')).toEqual([
      'Uploaded only',
    ]);
    expect(state.submittedExtraTexts.get('msg-1')).toBe('restore note');
  });
});
