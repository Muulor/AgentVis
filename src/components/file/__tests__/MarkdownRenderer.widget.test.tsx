import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n';
import { MarkdownRenderer } from '../MarkdownRenderer';

const widgetChoicesOutput = [
  '### 🔍 下一步建议',
  '',
  '```widget-choices',
  '{',
  '  "title": "你想深入了解哪个方向？",',
  '  "options": [',
  '    { "label": "技术全景报告", "icon": "BookOpen", "description": "读取「智能体编排最新论文技术总结.md」，了解407行技术总结" },',
  '    { "label": "Google Antigravity", "icon": "Google", "description": "读取「Google_Antigravity_完整文档.md」，聚焦多智能体编排功能" },',
  '    { "label": "综合分析", "icon": "Layers", "description": "同时分析两份核心文档，输出对比报告" }',
  '  ]',
  '}',
  '```',
].join('\n');

describe('MarkdownRenderer widget fences', () => {
  it('renders widget-choices as a choices widget instead of a code block', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <MarkdownRenderer content={widgetChoicesOutput} contextId="ctx-1" messageId="msg-1" />
      </I18nProvider>
    );

    expect(html).toContain('你想深入了解哪个方向？');
    expect(html).toContain('技术全景报告');
    expect(html).toContain('Google Antigravity');
    expect(html).not.toContain('language-widget-choices');
  });
});
