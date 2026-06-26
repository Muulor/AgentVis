import { describe, expect, it } from 'vitest';
import type { EChartsOption } from 'echarts';
import { buildSafeEChartsOption } from './EchartsVisualTheme';

describe('buildSafeEChartsOption', () => {
    it('为朴素柱状图注入安全视觉样式', () => {
        const option = buildSafeEChartsOption({
            title: { text: '盈利能力' },
            xAxis: { type: 'category', data: ['毛利率', '净利率'] },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: [70, 55] }],
        }, { dark: true });

        const series = Array.isArray(option.series) ? option.series[0] : undefined;

        expect(option.backgroundColor).toBe('transparent');
        expect(option.color).toEqual(expect.arrayContaining(['#7DA0FA']));
        expect(option.tooltip).toMatchObject({ confine: true });
        expect(option.grid).toMatchObject({ containLabel: true });
        const itemStyle = (series as Record<string, unknown> | undefined)?.itemStyle as Record<string, unknown> | undefined;
        const color = itemStyle?.color as Record<string, unknown> | undefined;

        expect(series).toMatchObject({
            type: 'bar',
            barMaxWidth: 51,
            itemStyle: {
                borderRadius: [5, 5, 2, 2],
            },
        });
        expect(color?.type).toBe('linear');
        expect(Array.isArray(color?.colorStops)).toBe(true);
    });

    it('adds a value xAxis when a horizontal cartesian option only declares yAxis', () => {
        const option = buildSafeEChartsOption({
            yAxis: { type: 'category', data: ['price'] },
            series: [{
                type: 'bar',
                data: [
                    { value: 224.25, itemStyle: { color: '#cbd5e1' } },
                    { value: 225.32, itemStyle: { color: '#3b82f6' } },
                    { value: 231.5, itemStyle: { color: '#cbd5e1' } },
                ],
                barWidth: 40,
            }],
            graphic: [{ type: 'text', style: { text: 'day low' } }],
        } as unknown as EChartsOption, { dark: true });

        expect(option.xAxis).toMatchObject({ type: 'value' });
        expect(option.yAxis).toMatchObject({ type: 'category', data: ['price'] });
        expect((option as Record<string, unknown>).graphic).toBeUndefined();
    });

    it('adds a value yAxis when a vertical cartesian option only declares xAxis', () => {
        const option = buildSafeEChartsOption({
            xAxis: { type: 'category', data: ['A', 'B'] },
            series: [{ type: 'line', data: [1, 2] }],
        }, { dark: false });

        expect(option.xAxis).toMatchObject({ type: 'category', data: ['A', 'B'] });
        expect(option.yAxis).toMatchObject({ type: 'value' });
    });

    it('normalizes LLM string titles so otherwise valid bar charts stay renderable', () => {
        const option = buildSafeEChartsOption({
            title: '各渠道投入产出比（新账号适用） ',
            xAxis: {
                type: 'category',
                data: ['GitHub', 'Reddit', 'Twitter/X', 'HackerNews', 'Dev.to', 'V2EX', '即刻', '小红书/B站'],
            },
            yAxis: {
                type: 'value',
                name: '推荐投入时间占比 %',
            },
            series: [{
                data: [30, 20, 15, 10, 10, 10, 5],
                type: 'bar',
                itemStyle: { color: '#7C3AED' },
            }],
        } as unknown as EChartsOption, { dark: true });

        const title = option.title as Record<string, unknown>;
        const series = Array.isArray(option.series) ? option.series[0] : undefined;

        expect(title).toMatchObject({
            text: '各渠道投入产出比（新账号适用）',
            left: 'center',
        });
        expect(option.xAxis).toMatchObject({ type: 'category' });
        expect(option.yAxis).toMatchObject({ type: 'value' });
        expect(series).toMatchObject({
            type: 'bar',
            data: [30, 20, 15, 10, 10, 10, 5],
            itemStyle: {
                color: '#7C3AED',
            },
        });
    });

    it('裁剪未注册或高风险字段，保留可渲染 series', () => {
        const llmOption = {
            graphic: { type: 'text', left: 0 },
            dataset: {
                source: [['name', 'value'], ['A', 1]],
                transform: { type: 'sort' },
            },
            series: [
                { type: 'custom', renderItem: 'not allowed', data: [1, 2] },
                { type: 'line', data: [1, 3, 2] },
            ],
        } as unknown as EChartsOption;

        const option = buildSafeEChartsOption(llmOption, { dark: false });

        const record = option as Record<string, unknown>;
        const dataset = record.dataset as Record<string, unknown>;

        expect(record.graphic).toBeUndefined();
        expect(dataset.transform).toBeUndefined();
        expect(option.series).toEqual([
            expect.objectContaining({ type: 'line', smooth: true }),
        ]);
    });

    it('尊重 LLM 已明确给出的关键样式值', () => {
        const option = buildSafeEChartsOption({
            series: [{
                type: 'bar',
                barMaxWidth: 18,
                itemStyle: { borderRadius: 0, color: '#123456' },
                data: [1, 2],
            }],
        }, { dark: true });

        const series = Array.isArray(option.series) ? option.series[0] : undefined;

        expect(series).toMatchObject({
            barMaxWidth: 18,
            itemStyle: {
                borderRadius: 0,
                color: '#123456',
            },
        });
    });

    it('关闭视觉主题时只保留基础安全默认值', () => {
        const option = buildSafeEChartsOption({
            xAxis: { type: 'category', data: ['A'] },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: [1] }],
        }, { dark: false, enableVisualTheme: false });

        const series = Array.isArray(option.series) ? option.series[0] : undefined;

        expect(option.backgroundColor).toBe('transparent');
        expect(option.tooltip).toMatchObject({ confine: true });
        expect(series).toEqual({ type: 'bar', data: [1] });
    });

    it('雷达图单 series 多 data 时为每个对比项分配不同颜色', () => {
        const option = buildSafeEChartsOption({
            radar: {
                indicator: [
                    { name: '代码补全', max: 5 },
                    { name: '生态整合', max: 5 },
                    { name: 'Agent能力', max: 5 },
                ],
            },
            series: [{
                type: 'radar',
                data: [
                    { name: '产品 A', value: [4, 5, 4] },
                    { name: '产品 B', value: [5, 3, 4] },
                    { name: '产品 C', value: [4, 4, 5] },
                ],
            }],
        }, { dark: true });

        const series = Array.isArray(option.series) ? option.series[0] : undefined;
        const data = (series as Record<string, unknown> | undefined)?.data as Record<string, unknown>[] | undefined;
        const firstLine = data?.[0]?.lineStyle as Record<string, unknown> | undefined;
        const secondLine = data?.[1]?.lineStyle as Record<string, unknown> | undefined;
        const thirdArea = data?.[2]?.areaStyle as Record<string, unknown> | undefined;

        expect(firstLine?.color).toBe('#7DA0FA');
        expect(secondLine?.color).toBe('#8FD17F');
        expect(thirdArea).toMatchObject({ color: '#F3C567', opacity: 0.15 });
    });

    it('财务暖色主题的折线面积渐变保持可见', () => {
        const option = buildSafeEChartsOption({
            __visualPreset: 'financialWarm',
            xAxis: { type: 'category', data: ['FY2021', 'FY2022'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [340, 410] }],
        } as unknown as EChartsOption, { dark: true });

        const series = Array.isArray(option.series) ? option.series[0] : undefined;

        expect(series).toMatchObject({
            areaStyle: {
                opacity: 0.25,
                color: { type: 'linear' },
            },
        });
    });
});
