/**
 * useMessageActions 撤回生命周期回归测试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from '@/types/message';

const mocks = vi.hoisted(() => ({
  reactStates: [] as unknown[],
  invoke: vi.fn(),
  addQuote: vi.fn(),
  setMessages: vi.fn(),
  resetDiffContext: vi.fn(),
  clearDocumentPreview: vi.fn(),
  clearContextAttachments: vi.fn(),
  triggerClearPreview: vi.fn(),
  cancelVisualEnhancement: vi.fn(),
  destroyAgentService: vi.fn(),
  getOrCreateAgentService: vi.fn(() => ({ resetSession: vi.fn() })),
  messagesByAgent: new Map<string, UIMessage[]>(),
}));

vi.mock('react', () => ({
  useState: (initialValue: unknown) => {
    const index = mocks.reactStates.length;
    mocks.reactStates.push(initialValue);
    return [
      initialValue,
      (nextValue: unknown) => {
        mocks.reactStates[index] =
          typeof nextValue === 'function'
            ? (nextValue as (value: unknown) => unknown)(mocks.reactStates[index])
            : nextValue;
      },
    ];
  },
  useCallback: <T>(callback: T) => callback,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@stores/chatStore', () => {
  const store = {
    addQuote: mocks.addQuote,
    messagesByAgent: mocks.messagesByAgent,
    setMessages: mocks.setMessages,
    enterMultiSelect: vi.fn(),
  };
  const useChatStore = Object.assign(
    (selector: (state: typeof store) => unknown) => selector(store),
    { getState: () => store }
  );

  return { useChatStore };
});

vi.mock('@stores/diffStore', () => ({
  useDiffStore: {
    getState: () => ({ resetContext: mocks.resetDiffContext }),
  },
}));

vi.mock('@stores/attachmentViewerStore', () => ({
  useAttachmentViewerStore: {
    getState: () => ({
      clearDocumentPreview: mocks.clearDocumentPreview,
      clearContextAttachments: mocks.clearContextAttachments,
      triggerClearPreview: mocks.triggerClearPreview,
    }),
  },
}));

vi.mock('@services/planning/AgentService', () => ({
  destroyAgentService: mocks.destroyAgentService,
  getOrCreateAgentService: mocks.getOrCreateAgentService,
}));

vi.mock('@services/planning/visual-enhancer/VisualEnhancementJobManager', () => ({
  visualEnhancementJobManager: { cancel: mocks.cancelVisualEnhancement },
}));

vi.mock('@services/logger', () => ({
  getLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@utils/quoteContent', () => ({
  getMessageQuoteContent: (message: UIMessage) => message.content,
}));

vi.mock('@utils/messageReload', () => ({
  refreshAgentMessagesFromDb: vi.fn(),
  refreshHubMessagesFromDb: vi.fn(),
}));

import { useMessageActions, type ActionConfirmDialogState } from '../useMessageActions';

describe('useMessageActions revoke lifecycle', () => {
  const retainedMessage: UIMessage = {
    id: 'user-1',
    agentId: 'agent-1',
    role: 'user',
    content: '保留的消息',
    createdAt: 1,
  };
  const revokedMessage: UIMessage = {
    id: 'user-2',
    agentId: 'agent-1',
    role: 'user',
    content: '撤回的消息',
    createdAt: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reactStates.length = 0;
    mocks.messagesByAgent.clear();
    mocks.messagesByAgent.set('agent-1', [retainedMessage, revokedMessage]);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'diff_record_get_by_message') return [];
      if (command === 'memory_delete_by_source_ids') return 0;
      return undefined;
    });
  });

  it('撤回消息时不查找、创建或重置 Planning AgentService', async () => {
    const actions = useMessageActions({
      contextType: 'agent',
      contextId: 'agent-1',
      messages: [retainedMessage, revokedMessage],
    });

    await actions.handleMessageAction('user-2', 'revoke');
    const confirmState = mocks.reactStates[2] as ActionConfirmDialogState;
    expect(confirmState.isOpen).toBe(true);
    expect(confirmState.onConfirm).not.toBeNull();

    await confirmState.onConfirm?.();

    expect(mocks.setMessages).toHaveBeenCalledWith('agent-1', [retainedMessage]);
    expect(mocks.getOrCreateAgentService).not.toHaveBeenCalled();
    expect(mocks.destroyAgentService).not.toHaveBeenCalled();
  });
});
