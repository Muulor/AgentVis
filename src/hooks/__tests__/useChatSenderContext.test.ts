/**
 * Chat request context-selection regression tests.
 */

import { describe, expect, it } from 'vitest';
import { selectChatHistoryMessages } from '../useChatSenderContext';

describe('selectChatHistoryMessages', () => {
  it('excludes the persisted current user message before it is appended explicitly', () => {
    const messages = [
      { id: 'system', role: 'system', content: 'rules' },
      { id: 'old-user', role: 'user', content: 'older question' },
      { id: 'old-assistant', role: 'assistant', content: 'older answer' },
      { id: 'current-user', role: 'user', content: 'current question' },
    ];

    expect(selectChatHistoryMessages(messages, 'current-user')).toEqual([messages[1], messages[2]]);
  });

  it('keeps ordinary historical messages without IDs', () => {
    const message = { role: 'assistant', content: 'restored history' };
    expect(selectChatHistoryMessages([message], 'current-user')).toEqual([message]);
  });
});
