/**
 * CheckpointDecisionParser - Checkpoint 决策解析器
 *
 * 从 LLM 输出中解析 Checkpoint 决策
 *
 * 职责：
 * - 从 LLM 文本输出中提取 JSON 块
 * - 验证决策结构符合类型定义
 * - 返回类型安全的 CheckpointDecision
 *
 * 设计说明：
 * - 复用项目统一的 JsonParser（4 级降级策略）
 * - 文本推断作为兜底：信号词优先级 失败/阻塞 > 完成 > 继续 > 长文本降级
 * - 约束与 types.ts 中的 CheckpointDecision 类型保持一致
 */

import type {
    CheckpointDecision,
    ExtendBudgetDecision,
    AdjustStrategyDecision,
    TerminateSubAgentDecision,
} from './types';
// 复用项目统一的 JSON 解析工具（与 DecisionParser 对齐）
import { parseWithFallback } from '../../memory/utils/JsonParser';
import { getLogger } from '@services/logger';
import { PLANNING_CONSTANTS } from '../PlanningConstants';

const logger = getLogger('CheckpointDecisionParser');

// ═══════════════════════════════════════════════════════════════
// 验证约束常量
// ═══════════════════════════════════════════════════════════════

const CONSTRAINTS = {
    /** additionalIterations 最小值 */
    MIN_ADDITIONAL_ITERATIONS: 1,
    /** additionalIterations 最大值 */
    MAX_ADDITIONAL_ITERATIONS: PLANNING_CONSTANTS.SUB_AGENT_BUDGET_EXTENSION_MAX_ITERATIONS,
} as const;

// ═══════════════════════════════════════════════════════════════
// 验证辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 验证是否为有效的 EXTEND_BUDGET 决策
 */
function validateExtendBudget(obj: Record<string, unknown>): ExtendBudgetDecision {
    if (
        typeof obj.additionalIterations !== 'number' ||
        obj.additionalIterations < CONSTRAINTS.MIN_ADDITIONAL_ITERATIONS ||
        obj.additionalIterations > CONSTRAINTS.MAX_ADDITIONAL_ITERATIONS
    ) {
        throw new Error(
            `additionalIterations must be between ${CONSTRAINTS.MIN_ADDITIONAL_ITERATIONS} and ${CONSTRAINTS.MAX_ADDITIONAL_ITERATIONS}`
        );
    }

    if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
        throw new Error('reason is required and must be a non-empty string');
    }

    if (obj.refinedInstructions !== undefined && typeof obj.refinedInstructions !== 'string') {
        throw new Error('refinedInstructions must be a string if provided');
    }

    return {
        type: 'EXTEND_BUDGET',
        additionalIterations: obj.additionalIterations,
        refinedInstructions: obj.refinedInstructions,
        reason: obj.reason,
    };
}

/**
 * 验证是否为有效的 ADJUST_STRATEGY 决策
 */
function validateAdjustStrategy(obj: Record<string, unknown>): AdjustStrategyDecision {
    if (typeof obj.refinedInstructions !== 'string' || obj.refinedInstructions.length === 0) {
        throw new Error('refinedInstructions is required for ADJUST_STRATEGY');
    }

    if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
        throw new Error('reason is required and must be a non-empty string');
    }

    if (
        obj.additionalIterations !== undefined &&
        (typeof obj.additionalIterations !== 'number' ||
            obj.additionalIterations < 0 ||
            obj.additionalIterations > CONSTRAINTS.MAX_ADDITIONAL_ITERATIONS)
    ) {
        throw new Error(
            `additionalIterations must be between 0 and ${CONSTRAINTS.MAX_ADDITIONAL_ITERATIONS}`
        );
    }

    return {
        type: 'ADJUST_STRATEGY',
        refinedInstructions: obj.refinedInstructions,
        additionalIterations: obj.additionalIterations,
        reason: obj.reason,
    };
}

/**
 * 验证是否为有效的 TERMINATE_SUB_AGENT 决策
 */
function validateTerminateSubAgent(obj: Record<string, unknown>): TerminateSubAgentDecision {
    if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
        throw new Error('reason is required and must be a non-empty string');
    }

    return {
        type: 'TERMINATE_SUB_AGENT',
        reason: obj.reason,
    };
}

// ═══════════════════════════════════════════════════════════════
// Schema 导出（用于测试）
// ═══════════════════════════════════════════════════════════════

/**
 * Checkpoint 决策 Schema（用于测试验证）
 *
 * 模拟 Zod 的 parse 接口，保持 API 兼容
 */
export const CheckpointDecisionSchema = {
    parse(obj: unknown): CheckpointDecision {
        if (typeof obj !== 'object' || obj === null) {
            throw new Error('Decision must be an object');
        }

        const record = obj as Record<string, unknown>;

        if (typeof record.type !== 'string') {
            throw new Error('type is required and must be a string');
        }

        switch (record.type) {
            case 'EXTEND_BUDGET':
                return validateExtendBudget(record);
            case 'ADJUST_STRATEGY':
                return validateAdjustStrategy(record);
            case 'TERMINATE_SUB_AGENT':
                return validateTerminateSubAgent(record);
            default:
                throw new Error(`Unknown decision type: ${record.type}`);
        }
    },
};

// ═══════════════════════════════════════════════════════════════
// 解析函数
// ═══════════════════════════════════════════════════════════════

/**
 * 从 LLM 输出中解析 Checkpoint 决策
 *
 * 解析管线（与 DecisionParser 对齐）：
 * 1. 使用 JsonParser.parseWithFallback（4 级降级策略）
 * 2. 对解析结果做 Schema 验证
 * 3. 全部失败时，降级到信号词推断
 *
 * @param llmOutput - LLM 的原始文本输出
 * @returns 解析后的 CheckpointDecision
 * @throws 如果所有策略均无法解析
 */
export function parseCheckpointDecision(llmOutput: string): CheckpointDecision {
    // 策略 1: 使用项目统一的 JsonParser（支持中文引号修复、截断修复、激进清理等）
    const parseResult = parseWithFallback<Record<string, unknown>>(llmOutput, {
        verbose: false,
        logPrefix: '[CheckpointDecisionParser]',
    });

    if (parseResult.success && parseResult.data) {
        // JSON 解析成功，验证 Schema
        try {
            const decision = CheckpointDecisionSchema.parse(parseResult.data);
            if (parseResult.quality && parseResult.quality !== 'perfect') {
                logger.warn(`[CheckpointDecisionParser] JSON 使用 ${parseResult.quality} 策略解析成功`);
            }
            return decision;
        } catch (validationError) {
            // Schema 验证失败（如 type 字段无效），降级到文本推断
            logger.warn(
                '[CheckpointDecisionParser] JSON Schema 验证失败，降级到文本推断:',
                validationError instanceof Error ? validationError.message : String(validationError)
            );
        }
    }

    // 策略 2: 容错处理 - 从文本内容推断决策
    logger.warn('[CheckpointDecisionParser] JSON 解析失败，尝试从文本推断决策');
    const inferredDecision = inferDecisionFromText(llmOutput);
    if (inferredDecision) {
        return inferredDecision;
    }

    throw new Error('Failed to parse checkpoint decision: no valid JSON or recognizable text signals found');
}

/**
 * 从文本内容推断决策（容错处理）
 *
 * 当 LLM 没有返回标准 JSON 格式时，尝试从文本中的关键词推断决策
 * 这是一个降级策略，优先保证系统不崩溃
 *
 * 优先级：失败/阻塞信号 > 完成信号 > 继续信号 > 长文本降级
 * 失败信号优先级最高——当 MB 用自然语言描述环境问题时，应终止而非让 SA 继续
 */
function inferDecisionFromText(text: string): CheckpointDecision | null {
    const lowerText = text.toLowerCase();

    // 【最高优先级】失败/阻塞信号词
    // MB 用自然语言描述环境问题（如 Playwright 未安装、命令超时）时匹配
    const failureSignals = [
        // 中文失败/阻塞信号
        '未安装', '安装失败', '缺少依赖', '环境问题', '找不到',
        '无法执行', '无法完成', '不可用', '执行超时', '命令超时',
        '环境依赖', '依赖缺失',
        // 英文失败/阻塞信号
        'not installed', 'not found', 'not recognized',
        'is not recognized', 'command not found',
        'timed out', 'missing dependency',
        'executable doesn\'t exist',
    ];

    // 任务完成信号词
    const completionSignals = [
        '已完成', '完成任务', '任务完成', '已保存', '保存成功',
        'completed', 'done', 'finished', 'saved successfully',
        '写入成功', '创建成功', '执行成功',
    ];

    // 需要更多迭代信号词
    const continueSignals = [
        '需要更多', '继续执行', '还需要', '尚未完成',
        'need more', 'continue', 'not finished',
    ];

    // 失败/阻塞检测（最高优先级）
    if (failureSignals.some(signal => lowerText.includes(signal))) {
        logger.debug('[CheckpointDecisionParser] 推断决策：TERMINATE_SUB_AGENT（检测到失败/阻塞信号）');
        return {
            type: 'TERMINATE_SUB_AGENT',
            reason: 'Inferred from text content: detected missing environment dependencies or execution failure, terminating Sub-Agent',
        };
    }

    // 完成检测
    if (completionSignals.some(signal => lowerText.includes(signal))) {
        logger.debug('[CheckpointDecisionParser] 推断决策：TERMINATE_SUB_AGENT（检测到完成信号）');
        return {
            type: 'TERMINATE_SUB_AGENT',
            reason: 'Inferred from text content: the Sub-Agent has completed the task',
        };
    }

    // 继续检测
    if (continueSignals.some(signal => lowerText.includes(signal))) {
        logger.debug('[CheckpointDecisionParser] 推断决策：EXTEND_BUDGET（检测到继续信号）');
        return {
            type: 'EXTEND_BUDGET',
            additionalIterations: 2,
            reason: 'Inferred from text content: the Sub-Agent needs more iterations',
        };
    }

    // 长文本降级：超过 500 字符的纯文本响应不可能是有效 JSON 决策
    // MB 返回了分析报告或多方案建议，说明情况复杂，应终止让用户决策
    if (text.length > 500) {
        logger.debug('[CheckpointDecisionParser] 推断决策：TERMINATE_SUB_AGENT（检测到长文本回复）');
        return {
            type: 'TERMINATE_SUB_AGENT',
            reason: 'Inferred from text content: the LLM returned a long analytical response, so terminate the Sub-Agent and wait for the user decision',
        };
    }

    // 无法推断
    return null;
}

/**
 * 安全解析（返回 Result 模式）
 *
 * @param llmOutput - LLM 的原始文本输出
 * @returns 解析结果或错误
 */
export function safeParseCheckpointDecision(
    llmOutput: string
): { success: true; data: CheckpointDecision } | { success: false; error: string } {
    try {
        const decision = parseCheckpointDecision(llmOutput);
        return { success: true, data: decision };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
