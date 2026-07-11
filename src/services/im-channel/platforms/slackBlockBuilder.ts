/**
 * Slack Block Kit 构建器
 *
 * 将平台无关的 ImCardContent 转换为 Slack chat.postMessage/chat.update 所需的 blocks。
 */

import type { ImCardAction, ImCardContent } from '../types';

export interface SlackMessagePayload {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const MAX_BLOCKS = 50;
const MAX_MRKDWN_TEXT = 3000;

/**
 * 构建 Slack 消息 payload
 */
export function buildSlackMessagePayload(card: ImCardContent): SlackMessagePayload {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncatePlainText(card.title, 150),
        emoji: true,
      },
    },
  ];

  for (const section of card.sections) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (section.header) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${normalizeSlackMrkdwn(section.header)}*`,
        },
      });
    }
    if (blocks.length >= MAX_BLOCKS) break;
    const text = normalizeSlackMrkdwn(section.content).trim();
    if (text) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateMrkdwn(text),
        },
      });
    }
    if (blocks.length < MAX_BLOCKS) {
      blocks.push({ type: 'divider' });
    }
  }

  if (blocks.length > 0 && blocks[blocks.length - 1]?.type === 'divider') {
    blocks.pop();
  }

  const actions = card.actions ?? [];
  if (actions.length && blocks.length < MAX_BLOCKS) {
    blocks.push({
      type: 'actions',
      elements: actions.slice(0, 5).map(buildSlackButton),
    });
  }

  return {
    text: buildFallbackText(card),
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
}

function buildSlackButton(action: ImCardAction): Record<string, unknown> {
  const style =
    action.style === 'danger' ? 'danger' : action.style === 'primary' ? 'primary' : undefined;
  return {
    type: 'button',
    text: {
      type: 'plain_text',
      text: truncatePlainText(action.text, 75),
      emoji: true,
    },
    action_id: action.actionId,
    value: JSON.stringify({
      action_id: action.actionId,
      ...(action.value ?? {}),
    }),
    ...(style ? { style } : {}),
  };
}

function buildFallbackText(card: ImCardContent): string {
  const parts = [
    card.title,
    ...card.sections.map((section) =>
      [section.header, stripMarkdown(section.content)].filter(Boolean).join('\n')
    ),
  ];
  return truncatePlainText(parts.filter(Boolean).join('\n\n'), 4000);
}

function normalizeSlackMrkdwn(text: string): string {
  return text.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '*$1*');
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

function truncateMrkdwn(text: string): string {
  if (text.length <= MAX_MRKDWN_TEXT) return text;
  return `${text.slice(0, MAX_MRKDWN_TEXT - 20)}\n...(truncated)`;
}

function truncatePlainText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
