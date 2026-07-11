import { describe, expect, it } from 'vitest';
import { removeDuplicateWidgetHeadings } from '../VisualEnhancerPostProcess';

describe('removeDuplicateWidgetHeadings', () => {
  it('removes a Markdown heading that duplicates the following widget title', () => {
    const content = [
      '# 任务概要',
      '',
      '### 任务概要',
      '',
      '```widget-chart',
      '{',
      '  "title": "任务概要",',
      '  "type": "info",',
      '  "items": [{ "label": "测试命令数", "value": 57 }]',
      '}',
      '```',
    ].join('\n');

    const fixed = removeDuplicateWidgetHeadings(content);

    expect(fixed).toContain('# 任务概要');
    expect(fixed).toContain('"title": "任务概要"');
    expect(fixed).not.toContain('### 任务概要');
  });

  it('keeps parent section headings when the widget title is different', () => {
    const content = [
      '## 主要发现',
      '',
      '```widget-chart',
      '{',
      '  "title": "关键发现",',
      '  "type": "info",',
      '  "items": []',
      '}',
      '```',
    ].join('\n');

    expect(removeDuplicateWidgetHeadings(content)).toBe(content);
  });

  it('normalizes simple Markdown wrappers before comparing titles', () => {
    const content = [
      '### **交付物清单**',
      '',
      '```widget-tree',
      '{',
      '  "title": "交付物清单",',
      '  "tree": { "question": "查看哪一项？", "options": [] }',
      '}',
      '```',
    ].join('\n');

    const fixed = removeDuplicateWidgetHeadings(content);

    expect(fixed).not.toContain('### **交付物清单**');
    expect(fixed).toContain('"title": "交付物清单"');
  });

  it('keeps headings when the following widget JSON has no readable title', () => {
    const content = [
      '### 任务概要',
      '',
      '```widget-chart',
      '{ "type": "info", "items": [] }',
      '```',
    ].join('\n');

    expect(removeDuplicateWidgetHeadings(content)).toBe(content);
  });
});
