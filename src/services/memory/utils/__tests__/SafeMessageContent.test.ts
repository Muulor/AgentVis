import { describe, expect, it } from 'vitest';
import { getMemorySafeMessageContent, stripMemoryVisualCodeBlocks } from '../SafeMessageContent';

describe('getMemorySafeMessageContent', () => {
  it('prefers assistant metadata.persistContent over enhanced content', () => {
    const content = getMemorySafeMessageContent({
      role: 'assistant',
      content: '增强版\n```widget-choices\n{"title":"选项","options":[]}\n```',
      metadata: JSON.stringify({
        persistContent: '原始回答：这里是纯文本。',
      }),
    });

    expect(content).toBe('原始回答：这里是纯文本。');
  });

  it('strips visual code blocks when persistContent is missing', () => {
    const content = getMemorySafeMessageContent({
      role: 'assistant',
      content: [
        '下面是选择：',
        '```widget-choices',
        '{"title":"方向","options":[{"label":"A","description":"第一项"}]}',
        '```',
      ].join('\n'),
    });

    expect(content).not.toContain('```widget-choices');
    expect(content).not.toContain('"options"');
    expect(content).toContain('方向');
    expect(content).toContain('A');
  });

  it('leaves user content unchanged', () => {
    const content = getMemorySafeMessageContent({
      role: 'user',
      content: '```widget-choices\n{"title":"用户贴的代码"}\n```',
    });

    expect(content).toContain('```widget-choices');
  });

  it('strips arbitrary memory text before prompt injection', () => {
    const content = stripMemoryVisualCodeBlocks(
      ['历史摘要', '```mermaid', 'graph LR', 'A-->B', '```'].join('\n')
    );

    expect(content).not.toContain('```mermaid');
    expect(content).toContain('[Diagram: view in the client]');
  });
});
