/**
 * CategoryConsolidator - 类别汇总器
 * 
 * 职责：
 * 1. 接收某类别下的所有事实
 * 2. 调用 LLM 进行汇总
 * 3. 输出 0 或 1 条干净的事实
 * 4. 根据结果决定是否写入（保留模式：汇总失败时保留候选）
 */

import { invoke } from '@tauri-apps/api/core';
import type { LongTermFactCategory, LLMService } from './types';
import { parseWithFallback } from './utils/JsonParser';
import { getLogger } from '@services/logger';
import { SOURCE_LANGUAGE_PRESERVATION_RULES } from './PromptLanguagePolicy';

const logger = getLogger('CategoryConsolidator');

// ============================================================================
// 汇总 Prompt
// ============================================================================

/**
 * 类别汇总 Prompt
 * 
 * 设计原则：
 * - 整合而非提取
 * - 保守态度，严禁人格脑补
 * - 只能输出 0 或 1 条事实
 */
const CONSOLIDATOR_PROMPT = `You are a **memory category consolidator** for an AI Agent.

You will receive multiple **candidate facts** that belong to the **same category**.
Your task is to decide whether they can be consolidated into **one** stable, reusable user fact.

**Important role notes:**
- You are performing "consolidation", not "extraction".
- You must remain **conservative**.
- It is completely acceptable and expected to output no fact when the evidence is not strong enough.

**Core principles:**
- **Accuracy over completeness**: it is better to miss a fact than to remember a wrong one.
- **Never force a conclusion**: if the evidence is insufficient, do not force consolidation.
- If candidate facts conflict, are limited to a specific context, or have weak support, you **must** reject consolidation.
- A fact should describe a **stable tendency or attribute**, not an instant or situation-bound behavior.

**Before consolidating, check all of the following:**
1. **Consistency**: do the candidate facts point to the same underlying tendency or attribute?
2. **Stability**: would this fact still hold in future, different conversation contexts?
3. **Abstraction**: can this fact be expressed without referring to a specific event or situation?
4. **Category safety**: if this fact is stored in memory, is there a risk that it could mislead future behavior?

**If any of the checks above fail, do not generate a fact.**

**Strictly forbidden:**
- Merging contradictory candidate facts into a vague generalization.
- Inferring personality traits without direct evidence.
- Including emotional states or temporary interests expressed only once.
- Writing more than **one** fact.

**Input format:**
You will receive:
- category name (category)
- candidate fact list (candidates), including content and confidence

${SOURCE_LANGUAGE_PRESERVATION_RULES}

**Output format:**
Return valid JSON only.

If consolidation is **rejected**:
{"write": false, "reason": "<brief explanation>"}

If consolidation is **approved**:
{"write": true, "category": "<category>", "long_term_fact": "<concise statement>", "confidence": <0-1>, "merged_from_indices": [<merged candidate indices>], "rejected_indices": [<excluded candidate indices>], "notes": "<stability rationale>"}`;

export function buildCategoryConsolidatorPrompt(
    category: LongTermFactCategory,
    candidates: ConsolidationCandidate[]
): string {
    const lines = [
        `category: ${category}`,
        'candidates:',
        ...candidates.map((c, i) =>
            `${i + 1}. "${c.content}" (confidence: ${c.confidence.toFixed(2)})`
        ),
    ];

    return CONSOLIDATOR_PROMPT + '\n\n' + lines.join('\n');
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 候选事实输入
 */
export interface ConsolidationCandidate {
    id: string;
    content: string;
    confidence: number;
}

/**
 * 汇总结果
 */
export interface ConsolidationResult {
    /** 类别 */
    category: LongTermFactCategory;
    /** 是否成功写入 */
    success: boolean;
    /** 是否执行了写入 */
    wrote: boolean;
    /** 汇总后的事实内容（如果成功） */
    consolidatedFact?: string;
    /** 拒绝原因（如果拒绝） */
    reason?: string;
    /** 错误信息（如果失败） */
    error?: string;
}

/**
 * LLM 汇总响应
 */
interface ConsolidatorResponse {
    write: boolean;
    reason?: string;
    category?: string;
    long_term_fact?: string;
    confidence?: number;
    merged_from_indices?: number[];
    rejected_indices?: number[];
    notes?: string;
}

// ============================================================================
// 汇总器类
// ============================================================================

/**
 * 类别汇总器
 */
export class CategoryConsolidator {
    private agentId: string;
    private llm: LLMService;

    constructor(agentId: string, llm: LLMService) {
        this.agentId = agentId;
        this.llm = llm;
    }

    /**
     * 执行类别汇总
     * 
     * @param category - 要汇总的类别
     * @param candidates - 候选事实列表
     * @returns 汇总结果
     */
    async consolidate(
        category: LongTermFactCategory,
        candidates: ConsolidationCandidate[]
    ): Promise<ConsolidationResult> {
        logger.trace(`[Consolidator] 开始汇总类别: ${category}, 候选数量: ${candidates.length}`);

        if (candidates.length === 0) {
            return {
                category,
                success: true,
                wrote: false,
                reason: 'No candidate facts',
            };
        }

        try {
            // 构建 Prompt
            const fullPrompt = buildCategoryConsolidatorPrompt(category, candidates);

            // 调用 LLM
            const response = await this.llm.generate(fullPrompt, {
                temperature: 1,
                maxTokens: 24576,
            });

            // 解析响应
            const result = this.parseResponse(response);

            if (result.write && result.long_term_fact) {
                // 汇总成功：删除旧事实，写入新事实
                await this.deleteOldFacts(candidates.map(c => c.id));
                await this.writeConsolidatedFact(
                    category,
                    result.long_term_fact,
                    result.confidence ?? 0.9
                );

                logger.trace(`[Consolidator]  类别 ${category} 汇总成功: ${result.long_term_fact}`);

                return {
                    category,
                    success: true,
                    wrote: true,
                    consolidatedFact: result.long_term_fact,
                };
            } else {
                // 汇总失败：保留候选事实，不做任何操作
                logger.trace(`[Consolidator]  类别 ${category} 汇总跳过: ${result.reason ?? 'unknown'}`);

                return {
                    category,
                    success: true,
                    wrote: false,
                    reason: result.reason ?? 'Did not pass the consistency check',
                };
            }
        } catch (error) {
            logger.error(`[Consolidator]  类别 ${category} 汇总失败:`, error);

            return {
                category,
                success: false,
                wrote: false,
                error: String(error),
            };
        }
    }

    /**
     * 解析 LLM 响应
     * 
     * 使用统一的 JsonParser 处理各种格式问题
     */
    private parseResponse(response: string): ConsolidatorResponse {
        logger.trace('[Consolidator] 原始响应:', response.substring(0, 200));

        const result = parseWithFallback<ConsolidatorResponse>(response, {
            verbose: true,
            logPrefix: '[Consolidator]',
        });

        if (result.success && result.data) {
            return result.data;
        }

        // 解析失败
        logger.trace('[Consolidator] 完整响应:', response);
        return { write: false, reason: result.error ?? 'No valid JSON found' };
    }

    /**
     * 删除旧事实
     */
    private async deleteOldFacts(ids: string[]): Promise<void> {
        for (const id of ids) {
            try {
                await invoke('memory_delete', { id });
            } catch (error) {
                logger.warn(`[Consolidator] 删除事实 ${id} 失败:`, error);
            }
        }
    }

    /**
     * 写入汇总后的事实
     */
    private async writeConsolidatedFact(
        category: LongTermFactCategory,
        content: string,
        confidence: number
    ): Promise<string> {
        // 使用 request 包装参数（与后端 Tauri 命令格式匹配）
        const result = await invoke<{ id: string }>('memory_create', {
            request: {
                agentId: this.agentId,
                layer: 'fact',
                content,
                category,
                importance: Math.round(confidence * 5), // 转换为 1-5 评分
                sourceMessageIds: null,
            },
        });

        return result.id;
    }
}

/**
 * 创建 CategoryConsolidator 实例
 */
export function createCategoryConsolidator(
    agentId: string,
    llm: LLMService
): CategoryConsolidator {
    return new CategoryConsolidator(agentId, llm);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 延迟函数
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
