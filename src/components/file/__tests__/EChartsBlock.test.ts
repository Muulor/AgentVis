import { describe, expect, it } from 'vitest';
import {
    buildEChartsTableFallback,
    postProcessEChartsOption,
    safeParseEChartsOption,
    sanitizeEChartsJson,
} from '../EChartsBlock';

const quotaChart = `{
  "title": { "text": "部分平台免费额度对比（估算）", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["免费额度"], "top": "bottom" },
  "xAxis": {
    "type": "category",
    "data": ["Vercel", "Netlify", "Cloudflare Pages", "GitHub Pages", "Render"],
    "axisLabel": { "interval": 0 }
  },
  "yAxis": { "type": "value", "name": "月带宽/请求（GB）" },
  "series": [{
    "name": "免费额度",
    "type": "bar",
    "data": [100, 100, 无限, 100, 750],
    "label": { "show": true, "position": "top", "formatter": "{c} GB/月" }
  }]
}`;

describe('EChartsBlock parsing tolerance', () => {
    it('quotes bare localized array values from LLM output', () => {
        const sanitized = sanitizeEChartsJson('{ "series": [{ "data": [100, 无限, 750] }] }');

        expect(JSON.parse(sanitized)).toMatchObject({
            series: [{ data: [100, '无限', 750] }],
        });
    });

    it('parses the quota chart that contains a bare 无限 value', () => {
        const option = safeParseEChartsOption(quotaChart);
        const series = Array.isArray(option?.series) ? option.series[0] : undefined;
        const data = (series as Record<string, unknown> | undefined)?.data;

        expect(Array.isArray(data)).toBe(true);
        expect((data as unknown[])[2]).toBe('无限');
    });

    it('maps unlimited text values to a renderable data item with the original label', () => {
        const option = safeParseEChartsOption(quotaChart)!;
        postProcessEChartsOption(option);

        const series = Array.isArray(option.series) ? option.series[0] : undefined;
        const data = (series as Record<string, unknown> | undefined)?.data as unknown[] | undefined;
        const unlimitedItem = data?.[2] as Record<string, unknown> | undefined;
        const label = unlimitedItem?.label as Record<string, unknown> | undefined;

        expect(unlimitedItem?.value).toBeGreaterThan(750);
        expect(label).toMatchObject({
            show: true,
            position: 'top',
            formatter: '无限',
        });
    });

    it('builds a table fallback for LLM table series output', () => {
        const option = safeParseEChartsOption(`{
            "title": { "text": "文件发送详情" },
            "tooltip": { "trigger": "item" },
            "dataset": {
                "source": [
                    ["文件名称", "发送状态", "对应消息ID"],
                    ["models.zip", "发送成功", "om_x100b6d91438f50a8c34d4e81c7ef9ff"],
                    ["handlers.tar", "发送成功", "om_x100b6d9143aae89cc3588738eed3bae"],
                    ["hooks.7z", "发送成功", "om_x100b6d9143450c9cc34b336020a6b85"]
                ]
            },
            "series": [
                { "type": "table", "headerBold": true, "rowHeight": 30 }
            ]
        }`)!;

        const table = buildEChartsTableFallback(option);

        expect(table).toMatchObject({
            title: '文件发送详情',
            headers: ['文件名称', '发送状态', '对应消息ID'],
            rows: [
                ['models.zip', '发送成功', 'om_x100b6d91438f50a8c34d4e81c7ef9ff'],
                ['handlers.tar', '发送成功', 'om_x100b6d9143aae89cc3588738eed3bae'],
                ['hooks.7z', '发送成功', 'om_x100b6d9143450c9cc34b336020a6b85'],
            ],
            headerBold: true,
            rowHeight: 30,
        });
    });

    it('does not build a table fallback for ordinary chart series', () => {
        const option = safeParseEChartsOption(`{
            "xAxis": { "type": "category", "data": ["A", "B"] },
            "yAxis": { "type": "value" },
            "series": [{ "type": "bar", "data": [1, 2] }]
        }`)!;

        expect(buildEChartsTableFallback(option)).toBeNull();
    });
});
