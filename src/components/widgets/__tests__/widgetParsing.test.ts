import { describe, expect, it } from 'vitest';
import {
    containsChoicesWidgetBlock,
    extractCodeLanguage,
    extractFencedCodeBlocks,
    parseWidgetLanguage,
    resolveWidgetType,
    shouldDeferTreeWidgetSubmit,
} from '../widgetParsing';

const userWidgetOutput = [
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
    '',
    '💡 **提示**：核心文档已定位，可随时读取任一文件进行深入分析。',
].join('\n');

describe('widgetParsing', () => {
    it('keeps hyphenated markdown code block languages intact', () => {
        expect(extractCodeLanguage('language-widget-choices')).toBe('widget-choices');
        expect(extractCodeLanguage('hljs language-widget-chart')).toBe('widget-chart');
    });

    it('normalizes singular choice widget language as choices', () => {
        expect(parseWidgetLanguage('widget-choice')).toEqual({
            isWidget: true,
            explicitType: 'choices',
        });
    });

    it('resolves the screenshot widget-choices payload as choices', () => {
        const blocks = extractFencedCodeBlocks(userWidgetOutput);
        expect(blocks[0]?.language).toBe('widget-choices');

        const parsedPayload = JSON.parse(blocks[0]?.code ?? '{}') as Record<string, unknown>;
        expect(resolveWidgetType(blocks[0]?.language ?? '', parsedPayload)).toBe('choices');
        expect(containsChoicesWidgetBlock(userWidgetOutput)).toBe(true);
    });

    it('detects bare widget fences that infer choices from options', () => {
        const markdown = '```widget\n{"title":"Pick","options":[{"label":"A"}]}\n```';

        expect(containsChoicesWidgetBlock(markdown)).toBe(true);
    });

    it('defers tree submit when the same bubble also contains choices', () => {
        const markdown = [
            '```widget-tree',
            '{"title":"Decision","tree":{"question":"Pick","options":[{"label":"A"}]}}',
            '```',
            '',
            '```widget-choices',
            '{"title":"Scope","options":[{"label":"Local"}]}',
            '```',
        ].join('\n');

        expect(shouldDeferTreeWidgetSubmit(markdown)).toBe(true);
    });

    it('keeps standalone tree widgets on the immediate submit path', () => {
        const markdown = [
            '```widget-tree',
            '{"title":"Decision","tree":{"question":"Pick","options":[{"label":"A"}]}}',
            '```',
        ].join('\n');

        expect(shouldDeferTreeWidgetSubmit(markdown)).toBe(false);
    });
});
