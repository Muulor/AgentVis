/**
 * Slack Block Kit 构建器单元测试
 *
 * 覆盖平台无关 IM 卡片到 Slack blocks 的核心转换规则。
 */

import { describe, expect, it } from 'vitest';
import { buildSlackMessagePayload } from '../slackBlockBuilder';
import type { ImCardContent } from '../../types';

describe('buildSlackMessagePayload', () => {
  it('builds fallback text and Block Kit sections from an IM card', () => {
    const card: ImCardContent = {
      title: 'Agent running',
      sections: [
        {
          header: 'Status',
          content: '✅ **MASTER_DECISION**',
        },
        {
          content: '💡 Send **/stop** to terminate',
        },
      ],
      actions: [
        {
          text: 'Stop',
          style: 'danger',
          actionId: 'stop_task',
          value: { taskId: 'task-1' },
        },
      ],
    };

    const payload = buildSlackMessagePayload(card);

    expect(payload.text).toContain('Agent running');
    expect(payload.text).toContain('MASTER_DECISION');
    expect(payload.blocks[0]).toMatchObject({
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Agent running',
      },
    });
    expect(payload.blocks).toContainEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Status*',
      },
    });
    expect(payload.blocks).toContainEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '✅ *MASTER_DECISION*',
      },
    });
    expect(payload.blocks.at(-1)).toMatchObject({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'stop_task',
          style: 'danger',
        },
      ],
    });
  });
});
