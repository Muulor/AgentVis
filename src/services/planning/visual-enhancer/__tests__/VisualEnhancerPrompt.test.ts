import { describe, expect, it } from 'vitest';
import {
    buildVisualEnhancerSystemPrompt,
    buildVisualEnhancerUserPrompt,
} from '../VisualEnhancerPrompt';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;
const JSON_FENCE_PATTERN = /```(echarts|widget-choices|widget-chart|widget-tree)\s*\n([\s\S]*?)```/g;

function extractJsonFencedBlocks(prompt: string): Array<{ fence: string; content: string }> {
    return [...prompt.matchAll(JSON_FENCE_PATTERN)].map(match => ({
        fence: match[1] ?? '',
        content: (match[2] ?? '').trim(),
    }));
}

describe('VisualEnhancerPrompt invariants', () => {
    it('keeps system-owned prompt text in English', () => {
        const prompt = [
            buildVisualEnhancerSystemPrompt(),
            buildVisualEnhancerUserPrompt('This report contains numeric trends and recommendations.'),
        ].join('\n');

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
    });

    it('anchors enhancement labels to the report source language', () => {
        const prompt = buildVisualEnhancerSystemPrompt('这是中文报告，包含三个实施阶段。');

        expect(prompt).toContain('Detected source-language signal: Simplified Chinese');
        expect(prompt).toContain('do not switch to the runtime or provider language');
    });

    it('preserves required visual fence names', () => {
        const prompt = buildVisualEnhancerSystemPrompt();
        const requiredFences = [
            'echarts',
            'mermaid',
            'widget-choices',
            'widget-chart',
            'widget-tree',
        ];

        for (const fence of requiredFences) {
            expect(prompt).toContain(`\`\`\`${fence}`);
        }
    });

    it('keeps JSON examples parseable', () => {
        const blocks = extractJsonFencedBlocks(buildVisualEnhancerSystemPrompt());

        expect(blocks.length).toBeGreaterThanOrEqual(5);

        for (const block of blocks) {
            expect(() => JSON.parse(block.content), `${block.fence} example should be valid JSON`)
                .not.toThrow();
        }
    });

    it('forbids adding unsupported data during enhancement', () => {
        const systemPrompt = buildVisualEnhancerSystemPrompt();
        const userPrompt = buildVisualEnhancerUserPrompt('The report mentions a market map but includes no numeric data.');

        expect(systemPrompt).toContain('Do not introduce facts, entities, rankings, dates, metrics, percentages, estimates, or numeric values');
        expect(systemPrompt).toContain('Do not infer, approximate, normalize, rank, score, bucket, or complete missing data.');
        expect(systemPrompt).toContain('ECharts series data, axis labels, pie slices, gauges, and widget-chart `value` fields must come directly from numbers in the original report.');
        expect(systemPrompt).toContain('Never copy, adapt, or reuse their labels or numbers');
        expect(userPrompt).toContain('Use only facts and numbers that appear in the report above.');
        expect(userPrompt).toContain('Do not add inferred, estimated, example, or background data.');
    });

    it('wraps the original report without altering it', () => {
        const originalContent = [
            '# Quarterly Report',
            '',
            '- Revenue grew by 18%',
            '- Retention reached 91%',
        ].join('\n');

        const prompt = buildVisualEnhancerUserPrompt(originalContent);

        expect(prompt).toContain(originalContent);
        expect(prompt).toContain('Enhance the following report content');
        expect(prompt).toContain('Output the complete enhanced content directly.');
    });
});
