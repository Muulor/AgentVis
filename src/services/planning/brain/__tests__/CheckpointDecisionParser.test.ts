/**
 * CheckpointDecisionParser 测试
 *
 * 验证 LLM 输出的 Checkpoint 决策解析逻辑
 */

import { describe, it, expect } from 'vitest';
import {
    parseCheckpointDecision,
    CheckpointDecisionSchema,
} from '../CheckpointDecisionParser';
import type { ExtendBudgetDecision, AdjustStrategyDecision } from '../types';

// ═══════════════════════════════════════════════════════════════
// parseCheckpointDecision 测试
// ═══════════════════════════════════════════════════════════════

describe('CheckpointDecisionParser', () => {
    describe('parseCheckpointDecision', () => {
        it('解析 EXTEND_BUDGET 决策', () => {
            const llmOutput = `
根据进度报告分析，Sub-Agent 已完成初步信息收集，但还需要更多数据。

\`\`\`json
{
    "type": "EXTEND_BUDGET",
    "additionalIterations": 3,
    "reason": "信息收集尚不充分，需要继续搜索相关文档"
}
\`\`\`

建议继续执行以获取更完整的信息。
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('EXTEND_BUDGET');
            const extendDecision = decision as ExtendBudgetDecision;
            expect(extendDecision.additionalIterations).toBe(3);
            expect(extendDecision.reason).toBe('信息收集尚不充分，需要继续搜索相关文档');
        });

        it('解析 EXTEND_BUDGET 带 refinedInstructions', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "EXTEND_BUDGET",
    "additionalIterations": 2,
    "refinedInstructions": "请专注于 API 文档部分",
    "reason": "需要更多 API 相关信息"
}
\`\`\`
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('EXTEND_BUDGET');
            const extendDecision = decision as ExtendBudgetDecision;
            expect(extendDecision.additionalIterations).toBe(2);
            // EXTEND_BUDGET 不含 refinedInstructions，验证 reason 即可
            expect(extendDecision.reason).toBe('需要更多 API 相关信息');
        });

        it('解析 ADJUST_STRATEGY 决策', () => {
            const llmOutput = `
发现 Sub-Agent 的搜索方向有偏差，需要调整策略。

\`\`\`json
{
    "type": "ADJUST_STRATEGY",
    "refinedInstructions": "停止搜索通用文档，专注于官方 API 参考手册",
    "additionalIterations": 2,
    "reason": "当前方向偏离目标，需要修正"
}
\`\`\`
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('ADJUST_STRATEGY');
            const adjustDecision = decision as AdjustStrategyDecision;
            expect(adjustDecision.refinedInstructions).toBe('停止搜索通用文档，专注于官方 API 参考手册');
            expect(adjustDecision.additionalIterations).toBe(2);
            expect(adjustDecision.reason).toBe('当前方向偏离目标，需要修正');
        });

        it('解析 ADJUST_STRATEGY 无额外迭代', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "ADJUST_STRATEGY",
    "refinedInstructions": "切换到另一个数据源",
    "reason": "当前数据源不可用"
}
\`\`\`
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('ADJUST_STRATEGY');
            const adjustDecision = decision as AdjustStrategyDecision;
            expect(adjustDecision.refinedInstructions).toBe('切换到另一个数据源');
            expect(adjustDecision.additionalIterations).toBeUndefined();
        });

        it('解析 TERMINATE_SUB_AGENT 决策', () => {
            const llmOutput = `
Sub-Agent 已收集到足够的信息，可以终止执行。

\`\`\`json
{
    "type": "TERMINATE_SUB_AGENT",
    "reason": "已收集到足够的技术文档，可以开始分析"
}
\`\`\`
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('TERMINATE_SUB_AGENT');
            expect(decision.reason).toBe('已收集到足够的技术文档，可以开始分析');
        });

        it('无 JSON 块且短文本时抛出错误', () => {
            // 短文本且无法推断决策类型时应抛出错误
            const llmOutput = `abc123`;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow(
                'Failed to parse checkpoint decision'
            );
        });

        it('无 JSON 块但包含完成信号时推断为 TERMINATE', () => {
            // 容错处理：检测到完成信号时推断决策
            const llmOutput = `
任务已完成，文档已保存成功。
            `;

            const decision = parseCheckpointDecision(llmOutput);
            expect(decision.type).toBe('TERMINATE_SUB_AGENT');
        });

        it('无 JSON 块但长文本时推断为 TERMINATE', () => {
            // 容错处理：长文本（>2048字符）认为是完整回复，推断为完成
            const longText = '这是一段很长的文本内容用于测试。'.repeat(300);

            const decision = parseCheckpointDecision(longText);
            expect(decision.type).toBe('TERMINATE_SUB_AGENT');
        });

        it('JSON 格式错误时抛出错误', () => {
            const llmOutput = `
\`\`\`json
{ invalid json here }
\`\`\`
            `;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow();
        });

        it('无效类型时抛出 Zod 错误', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "INVALID_TYPE",
    "reason": "测试"
}
\`\`\`
            `;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow();
        });

        it('additionalIterations 超上限时抛出错误', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "EXTEND_BUDGET",
    "additionalIterations": 21,
    "reason": "需要大量额外迭代"
}
\`\`\`
            `;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow();
        });

        it('additionalIterations 允许 20 步预算扩展', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "EXTEND_BUDGET",
    "additionalIterations": 20,
    "reason": "仍在推进，需要完整 phase 续航"
}
\`\`\`
            `;

            const decision = parseCheckpointDecision(llmOutput);

            expect(decision.type).toBe('EXTEND_BUDGET');
            expect((decision as ExtendBudgetDecision).additionalIterations).toBe(20);
        });

        it('additionalIterations 小于1时抛出错误', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "EXTEND_BUDGET",
    "additionalIterations": 0,
    "reason": "无需额外迭代"
}
\`\`\`
            `;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow();
        });

        it('ADJUST_STRATEGY 缺少 refinedInstructions 时抛出错误', () => {
            const llmOutput = `
\`\`\`json
{
    "type": "ADJUST_STRATEGY",
    "reason": "需要调整策略"
}
\`\`\`
            `;

            expect(() => parseCheckpointDecision(llmOutput)).toThrow();
        });
    });

    describe('Schema 验证', () => {
        it('验证 EXTEND_BUDGET Schema', () => {
            const valid = {
                type: 'EXTEND_BUDGET',
                additionalIterations: 3,
                reason: '需要更多信息',
            };

            expect(() => CheckpointDecisionSchema.parse(valid)).not.toThrow();
        });

        it('验证 ADJUST_STRATEGY Schema', () => {
            const valid = {
                type: 'ADJUST_STRATEGY',
                refinedInstructions: '新指令',
                reason: '需要调整',
            };

            expect(() => CheckpointDecisionSchema.parse(valid)).not.toThrow();
        });

        it('验证 TERMINATE_SUB_AGENT Schema', () => {
            const valid = {
                type: 'TERMINATE_SUB_AGENT',
                reason: '任务完成',
            };

            expect(() => CheckpointDecisionSchema.parse(valid)).not.toThrow();
        });
    });
});
