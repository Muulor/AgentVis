/**
 * SlackChannel 纯函数单元测试
 *
 * 覆盖 Socket Mode 入站文本进入 Agent 前的 mention 清理规则。
 */

import { describe, expect, it } from 'vitest';
import {
  extractSlackBlockText,
  shouldHandleSlackMessageEvent,
  slackBlocksMentionUser,
  slackTextMentionsUser,
  stripSlackMention,
} from '../SlackChannel';

describe('stripSlackMention', () => {
  it('removes the configured bot mention and decodes Slack text entities', () => {
    expect(stripSlackMention('<@U123BOT> please read A &amp; B &lt; C', 'U123BOT')).toBe(
      'please read A & B < C'
    );
  });

  it('removes generic Slack mentions when bot user id is unavailable', () => {
    expect(stripSlackMention('<@U999|agent> summarize this')).toBe('summarize this');
  });

  it('removes mentions for both Slack bot user id and bot id', () => {
    expect(stripSlackMention('<@B123BOT> chat with me', ['U123USER', 'B123BOT'])).toBe(
      'chat with me'
    );
  });
});

describe('slack mention detection', () => {
  it('detects bot mentions with Slack display labels', () => {
    expect(slackTextMentionsUser('<@U123BOT|agentvis> summarize this', 'U123BOT')).toBe(true);
  });

  it('detects bot id mentions from channel message text', () => {
    expect(slackTextMentionsUser('<@B123BOT> chat with me', ['U123USER', 'B123BOT'])).toBe(true);
  });

  it('detects bot mentions inside rich text blocks', () => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'user', user_id: 'U123BOT' },
              { type: 'text', text: ' summarize this' },
            ],
          },
        ],
      },
    ];

    expect(slackBlocksMentionUser(blocks, 'U123BOT')).toBe(true);
    expect(extractSlackBlockText(blocks, 'U123BOT')).toBe('summarize this');
  });

  it('detects and removes bot id mentions inside rich text blocks', () => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'user', user_id: 'B123BOT' },
              { type: 'text', text: ' chat with me' },
            ],
          },
        ],
      },
    ];

    expect(slackBlocksMentionUser(blocks, ['U123USER', 'B123BOT'])).toBe(true);
    expect(extractSlackBlockText(blocks, ['U123USER', 'B123BOT'])).toBe('chat with me');
  });
});

describe('shouldHandleSlackMessageEvent', () => {
  it('only handles fresh user message events and file shares', () => {
    expect(shouldHandleSlackMessageEvent('message', undefined)).toBe(true);
    expect(shouldHandleSlackMessageEvent('message', 'file_share')).toBe(true);
    expect(shouldHandleSlackMessageEvent('message', 'message_deleted')).toBe(false);
    expect(shouldHandleSlackMessageEvent('message', 'message_changed')).toBe(false);
    expect(shouldHandleSlackMessageEvent('app_mention', undefined)).toBe(true);
  });
});
