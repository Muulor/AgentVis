/**
 * MasterBrain - 主脑封装
 *
 * 职责：协调 Prompt 构建、LLM 调用和决策解析
 *
 * 执行流程：
 * 1. 构建 System Prompt
 * 2. 调用 LLM
 * 3. 解析决策（JSON Schema 验证）
 * 4. 风险评估增强
 * 5. 返回决策
 *
 * 关键原则：
 * - Master Brain 只做决策，不执行动作
 * - 不修改记忆
 * - 所有输出必须通过 Schema 验证
 */

import type {
    MasterBrainInput,
    MasterBrainDecision,
} from './types';
import { MasterBrainPrompt } from './MasterBrainPrompt';
import { DecisionParser } from './DecisionParser';

import { PLANNING_CONSTANTS } from '../PlanningConstants';
import { getLogger } from '@services/logger';

const logger = getLogger('MasterBrain');

// ═══════════════════════════════════════════════════════════════
// LLM 服务接口
// ═══════════════════════════════════════════════════════════════

/**
 * LLM 服务接口（用于依赖注入）
 */
export interface LLMServiceInterface {
    /**
     * 生成文本
     *
     * @param prompt - 输入 Prompt
     * @param options - 可选参数
     * @returns 生成的文本
     */
    generate(
        prompt: string,
        options?: {
            maxTokens?: number;
            temperature?: number;
            /** MB 剩余决策预算，由 callLLM() 透传，供 AgentLoop.generate() 注入 messages 尾部警告 */
            mbBudgetRemaining?: number;
            /**
             * 流式增量回调（MB Thought 流式显示专用）
             *
             * LLM 流式生成过程中调用，传递累积的部分内容
             */
            onStreamDelta?: (accumulatedContent: string) => void;
        }
    ): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════
// MasterBrain 实现
// ═══════════════════════════════════════════════════════════════

/**
 * 主脑 - 自主智能体的决策核心
 *
 * 负责：
 * - 接收结构化输入
 * - 构建决策 Prompt
 * - 调用 LLM 获取决策
 * - 验证和增强决策
 */
export class MasterBrain {
    constructor(
        private promptBuilder: MasterBrainPrompt,
        private decisionParser: DecisionParser,
        private llmService: LLMServiceInterface
    ) { }

    /**
     * 做出决策
     *
     * @param input - 主脑输入契约
     * @param streamOptions - 可选的流式回调配置
     * @returns 验证后的决策（风险已评估）
     * @throws Error - LLM 调用或决策解析失败时抛出
     */
    async decide(
        input: MasterBrainInput,
        streamOptions?: {
            /** 流式增量回调：LLM 输出过程中实时推送累积内容到 Thought 卡片 */
            onStreamDelta?: (accumulatedContent: string) => void;
        }
    ): Promise<MasterBrainDecision> {
        // 1. 构建 System Prompt（Prime Directive + 输入契约）
        const systemPrompt = this.promptBuilder.build(input);

        // 打印完整 System Prompt 便于调试
        logger.debug(`[MasterBrain] System Prompt:\n${systemPrompt}`);

        // 2. 调用 LLM（透传 mbBudgetRemaining 供 AgentLoop 注入 messages 尾部警告）
        const rawResponse = await this.callLLM(systemPrompt, {
            mbBudgetRemaining: input.mbBudgetRemaining,
            onStreamDelta: streamOptions?.onStreamDelta,
        });

        // 3. 解析并验证决策（JSON Schema）
        const decision = this.decisionParser.parse(rawResponse);

        // 4. 返回决策（风险增强已移除，由 LLM 自评的 riskAssessment 直接返回）
        return decision;
    }

    /**
     * 调用 LLM 服务
     *
     * @param prompt - System Prompt
     * @param extra - 验证层额外参数（不影响 Prompt 内容）
     */
    private async callLLM(
        prompt: string,
        extra?: {
            mbBudgetRemaining?: number;
            onStreamDelta?: (accumulatedContent: string) => void;
        }
    ): Promise<string> {
        return this.llmService.generate(prompt, {
            maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS, // Limit MB output loops while leaving room for complete decisions
            temperature: PLANNING_CONSTANTS.MASTER_BRAIN_TEMPERATURE, // 低温度确保决策稳定一致
            mbBudgetRemaining: extra?.mbBudgetRemaining, // 透传预算剐余量，供 AgentLoop 判断是否注入尾部警告
            onStreamDelta: extra?.onStreamDelta, // 透传流式回调，实时推送 LLM 输出到 Thought 卡片
        });
    }
}
