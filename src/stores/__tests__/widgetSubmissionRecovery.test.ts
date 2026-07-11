import { describe, expect, it } from 'vitest';
import { collectWidgetBubbleSubmissions } from '../widgetSubmissionRecovery';

describe('widgetSubmissionRecovery', () => {
  it('recovers legacy widget selections and extra text from hidden user message content', () => {
    const snapshots = collectWidgetBubbleSubmissions([
      {
        id: 'bubble-1',
        role: 'assistant',
        content: [
          '```widget-choices',
          '{',
          '  "title": "核心功能选择",',
          '  "mode": "multi",',
          '  "options": [{ "label": "对话交互" }, { "label": "工具调用" }]',
          '}',
          '```',
          '```widget-choices',
          '{',
          '  "title": "集成方式选择",',
          '  "mode": "single",',
          '  "options": [{ "label": "通过REST API" }, { "label": "WebSocket" }]',
          '}',
          '```',
        ].join('\n'),
      },
      {
        id: 'widget-user-1',
        role: 'user',
        content: [
          '核心功能选择：工具调用、对话交互',
          '集成方式选择：通过REST API',
          '',
          '补充说明: 初步配置读写本地文件的工具',
        ].join('\n'),
        metadata: {
          source: 'widget',
          widgetBubbleId: 'bubble-1',
        },
      },
    ]);

    expect(snapshots).toEqual([
      {
        bubbleId: 'bubble-1',
        selections: [
          {
            widgetKey: 'choices:bubble-1:核心功能选择',
            labels: ['工具调用', '对话交互'],
          },
          {
            widgetKey: 'choices:bubble-1:集成方式选择',
            labels: ['通过REST API'],
          },
        ],
        extraText: '初步配置读写本地文件的工具',
      },
    ]);
  });

  it('prefers structured metadata snapshots when available', () => {
    const snapshots = collectWidgetBubbleSubmissions([
      {
        id: 'widget-user-1',
        role: 'user',
        content: 'Legacy title: Legacy label',
        metadata: {
          source: 'widget',
          widgetBubbleId: 'bubble-1',
          widgetSelections: [
            {
              widgetKey: 'choices:bubble-1:Scope',
              labels: ['Uploaded only'],
            },
          ],
          widgetExtraText: 'structured note',
        },
      },
    ]);

    expect(snapshots).toEqual([
      {
        bubbleId: 'bubble-1',
        selections: [
          {
            widgetKey: 'choices:bubble-1:Scope',
            labels: ['Uploaded only'],
          },
        ],
        extraText: 'structured note',
      },
    ]);
  });
});
