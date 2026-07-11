/**
 * 飞书卡片构建器单元测试
 *
 * 覆盖平台无关 IM 卡片到飞书 interactive card 的核心转换规则。
 */

import { describe, expect, it } from 'vitest';
import { buildFeishuCard } from '../feishuCardBuilder';
import type { ImCardContent } from '../../types';

function getActionElements(cardJson: Record<string, unknown>): Array<Record<string, unknown>> {
  const elements = cardJson.elements;
  if (!Array.isArray(elements)) return [];
  return elements.filter((element): element is Record<string, unknown> => {
    return (
      Boolean(element) &&
      typeof element === 'object' &&
      (element as { tag?: unknown }).tag === 'action'
    );
  });
}

describe('buildFeishuCard', () => {
  it('filters delete-message actions while keeping task abort actions', () => {
    const card: ImCardContent = {
      title: 'Agent running',
      sections: [
        {
          content: 'Working',
        },
      ],
      actions: [
        {
          text: 'Delete message',
          style: 'default',
          actionId: 'delete_message',
        },
        {
          text: 'Stop task',
          style: 'danger',
          actionId: 'abort_task',
          value: { task_id: 'task-1' },
        },
      ],
    };

    const cardJson = buildFeishuCard(card);
    const [actionElement] = getActionElements(cardJson);

    expect(actionElement).toBeDefined();
    expect(actionElement?.actions).toEqual([
      expect.objectContaining({
        tag: 'button',
        type: 'danger',
        value: {
          action_id: 'abort_task',
          task_id: 'task-1',
        },
      }),
    ]);
  });

  it('omits the action block when only delete-message actions are present', () => {
    const card: ImCardContent = {
      title: 'Agent message',
      sections: [
        {
          content: 'models.zip',
        },
      ],
      actions: [
        {
          text: 'Delete message',
          style: 'default',
          actionId: 'delete_message',
        },
      ],
    };

    const cardJson = buildFeishuCard(card);

    expect(getActionElements(cardJson)).toEqual([]);
  });
});
