/**
 * VisualEnhancerService 单元测试
 *
 * 覆盖 shouldEnhance 的启发式判断逻辑和 enhance 的降级策略。
 *
 * 注意：enhance 函数内部使用 llm_chat_stream + Tauri 事件监听，
 * 在单元测试环境中 Tauri IPC 不可用，因此 enhance 的集成测试
 * 需要在应用运行时进行端到端验证。这里仅测试 shouldEnhance 纯函数逻辑。
 */

import { describe, it, expect } from 'vitest';
import { shouldEnhance } from '../VisualEnhancerService';

// ============================================================================
// shouldEnhance 测试
// ============================================================================

describe('shouldEnhance', () => {
  it('短回复（< 200 字符）应跳过', () => {
    expect(shouldEnhance('好的，已完成')).toBe(false);
    expect(shouldEnhance('任务执行成功，文件已保存到指定位置。')).toBe(false);
  });

  it('空字符串应跳过', () => {
    expect(shouldEnhance('')).toBe(false);
  });

  it('已含 widget 代码块应跳过', () => {
    const content =
      '以下是分析结果：\n\n```widget-choices\n{"title":"选择","options":[]}\n```\n\n请选择一个方向。' +
      'x'.repeat(300);
    expect(shouldEnhance(content)).toBe(false);
  });

  it('已含 echarts 代码块应跳过', () => {
    const content =
      '数据可视化：\n\n```echarts\n{"title":{"text":"图表"}}\n```\n\n如上所示。' + 'x'.repeat(300);
    expect(shouldEnhance(content)).toBe(false);
  });

  it('已含 mermaid 代码块应跳过', () => {
    const content = '流程如下：\n\n```mermaid\ngraph LR\nA-->B\n```\n\n以上。' + 'x'.repeat(300);
    expect(shouldEnhance(content)).toBe(false);
  });

  it('含百分比 + 多项列表 + 长报告应触发', () => {
    const content = `
# 市场分析报告

根据搜索结果，以下是关键数据：

- 前端开发工程师：平均薪资 25000 元，占比 35%
- 后端开发工程师：平均薪资 28000 元，占比 30%
- 全栈开发工程师：平均薪资 32000 元，占比 20%
- 数据工程师：平均薪资 30000 元，占比 15%

整体市场趋势向好，同比增长 12%。

${'补充说明内容。'.repeat(50)}
`;
    expect(shouldEnhance(content)).toBe(true);
  });

  it('含数量级数据 + 分析关键词 + 长报告应触发', () => {
    const content = `
# 行业趋势分析

全球市场规模预计达到500亿美元，其中中国市场约80亿。

从分布来看，一线城市仍然占据主导地位，招聘需求同比增长显著。

${'报告正文内容补充。'.repeat(50)}
`;
    expect(shouldEnhance(content)).toBe(true);
  });

  it('English metrics report with scale values should trigger', () => {
    const content = `
# Quarterly Market Analysis

The dashboard should compare market share, growth trend, and regional distribution.
North America reached 4.2 million users, Europe reached 2.8 million users, and APAC
grew by 18% quarter over quarter. The ranking changed across three segments, and the
next step is to visualize the breakdown by category, timeline, and workflow status.

${'Additional analysis paragraph. '.repeat(60)}
`;
    expect(shouldEnhance(content)).toBe(true);
  });

  it('仅含一个百分比且不长不应触发', () => {
    const content = '增长率为 15%，表现良好。这是一段中等长度的描述文字。';
    expect(shouldEnhance(content)).toBe(false);
  });

  it('纯文字长报告无数据特征不应触发', () => {
    const content =
      '这是一篇关于技术发展的综述报告，讨论了多个方面的问题。' + '内容描述。'.repeat(200);
    expect(shouldEnhance(content)).toBe(false);
  });

  it('不适合增强时 enhance 应直接返回（shouldEnhance = false 路径）', async () => {
    // 直接导入 enhance 测试其 shouldEnhance 前置判断
    const { enhance } = await import('../VisualEnhancerService');
    const result = await enhance('短回复', {
      provider: 'openai',
      model: 'gpt-4',
    });
    expect(result.enhanced).toBe(false);
    expect(result.content).toBe('短回复');
    expect(result.reason).toBe('content_not_suitable');
  });
});
