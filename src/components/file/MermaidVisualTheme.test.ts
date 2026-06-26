import { describe, expect, it } from 'vitest';
import {
    applyMermaidVisualDirectives,
    applyMermaidSvgTextContrast,
    buildMermaidVisualConfig,
    getReadableTextColor,
    inferMermaidDiagramType,
} from './MermaidVisualTheme';

describe('MermaidVisualTheme', () => {
    it('识别常见 Mermaid 图表类型', () => {
        expect(inferMermaidDiagramType('flowchart LR\nA-->B')).toBe('flowchart');
        expect(inferMermaidDiagramType('graph TB\nA-->B')).toBe('flowchart');
        expect(inferMermaidDiagramType('sequenceDiagram\nA->>B: hi')).toBe('sequence');
        expect(inferMermaidDiagramType('gantt\ndateFormat YYYY-MM-DD')).toBe('gantt');
        expect(inferMermaidDiagramType('stateDiagram-v2\n[*] --> Idle')).toBe('state');
        expect(inferMermaidDiagramType('erDiagram\nA ||--|| B : owns')).toBe('er');
    });

    it('构建 base 主题并按图表类型加入布局配置', () => {
        const flowchartConfig = buildMermaidVisualConfig(true, 'flowchart');
        const sequenceConfig = buildMermaidVisualConfig(false, 'sequence');
        const ganttConfig = buildMermaidVisualConfig(true, 'gantt');

        expect(flowchartConfig).toMatchObject({
            startOnLoad: false,
            theme: 'base',
            securityLevel: 'loose',
            flowchart: {
                curve: 'basis',
                nodeSpacing: 48,
            },
        });
        expect(flowchartConfig.themeVariables.primaryColor).toBe('#303642');
        expect(flowchartConfig.themeVariables.edgeLabelBackground).toBe('transparent');
        expect(sequenceConfig.sequence).toMatchObject({ mirrorActors: false });
        expect(ganttConfig.gantt).toMatchObject({ barHeight: 20 });
    });

    it('仅为无 classDef 的 flowchart 注入默认节点样式', () => {
        const code = 'flowchart LR\nA[开始] --> B[结束]';
        const enhanced = applyMermaidVisualDirectives(code, 'flowchart', true);

        expect(enhanced).toContain('classDef default');
        expect(enhanced).toContain('fill:#303642');
        expect(enhanced).toContain('stroke:#7DA0FA');
    });

    it('不覆盖已有 classDef，也不影响非 flowchart 图表', () => {
        const styledFlow = 'flowchart LR\nA-->B\nclassDef custom fill:#fff;';
        const sequence = 'sequenceDiagram\nA->>B: hi';

        expect(applyMermaidVisualDirectives(styledFlow, 'flowchart', true)).toBe(styledFlow);
        expect(applyMermaidVisualDirectives(sequence, 'sequence', true)).toBe(sequence);
    });

    it('根据节点填充色选择可读文字色', () => {
        expect(getReadableTextColor('#dff3fb')).toBe('#202635');
        expect(getReadableTextColor('rgb(255, 238, 209)')).toBe('#202635');
        expect(getReadableTextColor('#303642')).toBe('#F4F7FB');
        expect(getReadableTextColor('transparent')).toBeNull();
    });

    it('修正 SVG 中浅色节点的 HTML label 对比度', () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg">
            <g class="node">
                <rect style="fill: #dff3fb;" />
                <foreignObject>
                    <div><span class="nodeLabel">report.md</span></div>
                </foreignObject>
            </g>
        </svg>`;

        const fixed = applyMermaidSvgTextContrast(svg);
        if (typeof DOMParser === 'undefined') {
            expect(fixed).toBe(svg);
            return;
        }

        expect(fixed).toContain('color: #202635 !important');
        expect(fixed).toContain('-webkit-text-fill-color: #202635 !important');
    });
});
