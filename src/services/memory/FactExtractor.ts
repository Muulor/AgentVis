/**
 * FactExtractor - 事实提取器 (V2)
 * 
 * 【Layer 3】调用 LLM 从已验证的候选中提取记忆事实
 * 
 * - 采用"保守事实裁判"原则：宁可漏记，不可错记
 * - 只处理经过 StabilityVerifier 验证通过的候选
 * - 提取阶段携带 confidence/evidenceCount/scope，写库时仅映射必要字段
 */

import { invoke } from '@tauri-apps/api/core';
import type {
    LLMService,
    LongTermFactCategory,
    MemoryCandidate,
    FactRecord,
    MemoryExtractorResult,
} from './types';
import { parseWithFallback } from './utils/JsonParser';
import { embeddingService } from '@services/rag/EmbeddingService';
import { getLogger } from '@services/logger';
import { SOURCE_LANGUAGE_PRESERVATION_RULES } from './PromptLanguagePolicy';

const logger = getLogger('FactExtractor');

// ============================================================================
// Memory Extractor Prompt 
// ============================================================================

/**
 * Memory Extractor Prompt
 * 
 * 设计原则：
 * - 前四类（身份/偏好/目标/知识）：保留结构化提取约束，精确归类
 * - interaction_signals：开放式捕获，以「值得记住的直觉」为判断标准，而非归类规则
 * - 对 interaction_signals 豁免 AND 条件门槛，允许模糊、低确定性、单次观察
 */
const MEMORY_EXTRACTOR_PROMPT = `You are a memory-fact organizing specialist assisting an Agent.

Your task is to review a candidate conversation fragment and decide whether to extract it as memory.

**Core principles:**
- When you receive a conversation fragment between the user and the Agent, do not ask only "is this a fact?" Instead, ask: "If I deeply understood this user and were keeping working notes, would I write this down?"
- Do not remember everything. Remember only information with potential value for future collaboration. Think carefully: if the user mentions this later and the Agent does not remember it, would that feel like the Agent failed to take the present moment seriously? If so, it may be worth storing as an interaction signal.

---

There are five categories that guide your decision.
**Categories (choose exactly one):**

For classifiable user attributes:
- identity_role - occupation, industry, role, or positioning
- preference_style - output preferences, communication style, decision habits
- long_term_goal - directional goals or persistent constraints
- knowledge_level - known technical stack or concepts that do not need explanation

For interaction attributes that do not fit the above:
- interaction_signals - see the dedicated criteria below

---

**Criteria for user attributes:**
1. The content directly relates to the user's identity, preferences, goals, or knowledge level.
2. It is expressed as a tendency, habit, or clear preference.
3. It may be reused across different conversations or tasks.
4. It does not depend on task-bound time anchors such as "this time" or "this project",
   though words that express an ongoing state, such as "recently" or "these days", are allowed.

**Allowed flexibility:**
- The user does not need to explicitly say "always" or "I like".
- You may extract mild or implicit preferences.
- The fact does not need to be fully stabilized yet.

---

**Criteria for interaction attributes:**

When you cannot confidently fit an observation into one of the user-attribute categories,
but you have the intuition "if I do not know this next time a similar situation appears, I may drift off course",
then it is worth remembering and should be classified as interaction_signals.

This category uses different logic from the first four:
- It does not require precise classification; ambiguity is allowed.
- It does not require repeated occurrences; a signal observed once can be enough.
- It does not require the user to state it explicitly; implicit tendencies are allowed.
- It does not require a hard "fact"; patterns, tensions, or inclinations are allowed.

Signals suitable for this category include, as directional examples rather than exhaustive rules:
- The user repeatedly shows resistance to a certain type of solution, even without explaining why.
- An unresolved tradeoff tension that repeatedly affects decisions, such as speed versus quality.
- An implicit constraint or unstated preference visible in the user's wording.
- A collaboration pattern that appears faintly across multiple conversations.

Signals not suitable for this category:
- Temporary emotional expressions such as "this is annoying" or "I am tired".
- Temporary instructions limited to the current task.
- Facts that clearly fit one of the first four categories; prefer the more precise category.

**interaction_signals does not need to satisfy all criteria for the first four categories.
Use only the judgment "this is worth letting my future self know."**

---

**Candidate fact:**
category: {category}
content: {content}
occurrenceCount: {occurrenceCount}
userConfirmed: {userConfirmed}

Note: "occurrenceCount" and "userConfirmed" are algorithmic results. Do not treat them as hard evaluation rules.

**Conversation context (important):**
{contextMessages}

**Special reminders:**
- Always use the context to understand the candidate's specific meaning.
- If the conversation contains Widget interaction messages between the user and the Agent, do not extract behavior-only facts such as "the user selected ...".
- Instead, think about what user trait is reflected by the user's choices or actions, then decide whether that trait is worth distilling as a memory fact.

Examples (contrast):
Bad: "The user selected building a microscopic world and focusing on game environment design during career exploration."
Good: "The user is interested in game environment design and prefers microscopic-world directions."

Bad: "The user selected Python and data analysis in a learning path."
Good: "The user is learning Python and data analysis."

${SOURCE_LANGUAGE_PRESERVATION_RULES}

**Output format:**
Return valid JSON only.

If no suitable candidate is found, return:
{"extract": false, "reason": "<brief explanation>"}

If a candidate is found, return:
{"extract": true, "category": "<one category>", "candidate_fact": "<distilled point, 10-30 words or characters>", "confidence": <number between 0 and 1>, "notes": "<why this is worth remembering>"}`;

export function buildMemoryExtractorPrompt(candidate: MemoryCandidate): string {
    const contextStr = candidate.contextMessages
        ? candidate.contextMessages
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n')
        : '(No context)';

    return MEMORY_EXTRACTOR_PROMPT
        .replace('{category}', candidate.category)
        .replace('{content}', candidate.content)
        .replace('{occurrenceCount}', String(candidate.occurrenceCount))
        .replace('{userConfirmed}', candidate.userConfirmed ? 'yes' : 'no')
        .replace('{contextMessages}', contextStr);
}


// ============================================================================
// 事实提取器类
// ============================================================================

/**
 * 事实提取器类 (V2)
 */
export class FactExtractor {
    private llm: LLMService;
    private agentId: string;

    constructor(llm: LLMService, agentId: string) {
        this.llm = llm;
        this.agentId = agentId;
    }


    /**
     * 从已验证的候选中提取事实 (V2)
     * 
     * 只处理经过 StabilityVerifier 验证通过的候选
     * 
     * @param candidate - 已验证的候选事实
     * @returns 提取结果
     */
    async extractFromVerifiedCandidate(
        candidate: MemoryCandidate
    ): Promise<MemoryExtractorResult> {
        const prompt = buildMemoryExtractorPrompt(candidate);

        try {
            const response = await this.llm.generate(prompt, {
                temperature: 1, // 更低的温度以提高一致性
                maxTokens: 24576,
            });

            return this.parseMemoryExtractorResponse(response);
        } catch (error) {
            // 标记为 API 错误，区分于 LLM 正常拒绝，让调用方决定是否保留候选
            logger.error('[FactExtractor] V2 提取失败:', error);
            return { extract: false, reason: 'An error occurred during extraction', _apiError: true };
        }
    }

    /**
     * 批量处理已验证的候选并保存事实 (V2)
     * 
     * @param candidates - 已验证的候选列表
     * @returns savedCount - 成功保存的事实数量；failedCandidateIds - API 失败需重试的候选 ID
     */
    async extractAndSaveFromVerified(candidates: MemoryCandidate[]): Promise<{
        savedCount: number;
        failedCandidateIds: string[];
    }> {
        let savedCount = 0;
        const failedCandidateIds: string[] = [];

        for (const candidate of candidates) {
            const result = await this.extractFromVerifiedCandidate(candidate);

            // API 调用失败（有错误标记），候选需要保留等待重试
            if (result._apiError) {
                failedCandidateIds.push(candidate.id);
                continue;
            }

            // 兼容新旧两种 Prompt 格式：candidate_fact (新) 或 memory (旧)
            const factContent = result.candidate_fact ?? result.memory;

            if (result.extract && factContent && result.category) {
                await this.saveFactV2({
                    agentId: this.agentId,
                    content: factContent,
                    category: result.category,
                    confidence: result.confidence ?? 0.8,
                    evidenceCount: candidate.occurrenceCount,
                    lastVerified: Date.now(),
                    scope: result.scope ?? [],
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });
                savedCount++;
                logger.trace(`[FactExtractor]  保存事实: ${factContent}`);
            } else {
                // LLM 正常拒绝提取，不需要重试
                    logger.trace(`[FactExtractor]  跳过候选: ${candidate.content} (${result.reason ?? 'unknown'})`);
            }
        }

        return { savedCount, failedCandidateIds };
    }

    /**
     * 保存 V2 格式的事实
     *
     * 事实当前通过全量加载注入上下文，不在写入时主动创建事实向量索引。
     */
    async saveFactV2(fact: Omit<FactRecord, 'id'>): Promise<string> {
        // 先检查是否存在相似的事实
        const existingFacts = await this.getFactsByCategoryV2(fact.category);
        // 语义相似度判断（async），解决中文空格分词无效的问题
        let similarFact: { id: string; content: string; confidence: number } | undefined;
        for (const f of existingFacts) {
            if (await this.isSimilarContent(f.content, fact.content)) {
                similarFact = f;
                break;
            }
        }

        let factId: string;

        if (similarFact) {
            // 更新已有事实
            await invoke('memory_update', {
                id: similarFact.id,
                content: fact.content,
                importance: Math.round(fact.confidence * 5), // 转换为 1-5 评分
                category: fact.category, // 确保类别也更新
            });
            factId = similarFact.id;
        } else {
            // 创建新事实
            const result = await invoke<{ id: string }>('memory_create', {
                request: {
                    agentId: this.agentId,
                    layer: 'fact',
                    content: fact.content,
                    category: fact.category,
                    importance: Math.round(fact.confidence * 5),
                    sourceMessageIds: null,
                },
            });
            factId = result.id;
        }

        return factId;
    }

    /**
     * 获取指定类别的事实 (V2 格式)
     */
    async getFactsByCategoryV2(category: LongTermFactCategory): Promise<Array<{
        id: string;
        content: string;
        confidence: number;
    }>> {
        // 复用现有 API，后续可扩展为 V2 专用 API
        const result = await invoke<Array<{
            id: string;
            content: string;
            importance: number | null;
        }>>('memory_list_facts', {
            agentId: this.agentId,
            category,
        });

        return result.map(r => ({
            id: r.id,
            content: r.content,
            confidence: (r.importance ?? 3) / 5, // 转换为 0-1
        }));
    }

    /**
     * 解析 Memory Extractor 响应
     * 
     * 使用统一的 JsonParser 处理各种格式问题：
     * - 中文引号、控制字符、嵌套引号等
     */
    private parseMemoryExtractorResponse(response: string): MemoryExtractorResult {
        logger.trace('[FactExtractor] 原始响应:', response.substring(0, 200));

        const result = parseWithFallback<MemoryExtractorResult>(response, {
            verbose: true,
            logPrefix: '[FactExtractor]',
        });

        if (result.success && result.data) {
            return this.validateExtractorResult(result.data);
        }

        // 解析失败
        logger.trace('[FactExtractor] 完整响应:', response);
        return { extract: false, reason: result.error ?? 'No valid JSON found' };
    }

    /**
     * 验证提取结果
     */
    private validateExtractorResult(parsed: MemoryExtractorResult): MemoryExtractorResult {
        // 验证类别
        if (parsed.extract && parsed.category) {
            const validCategories: LongTermFactCategory[] = [
                'identity_role', 'preference_style', 'long_term_goal',
                'knowledge_level', 'interaction_signals', 'task_experience',
            ];
            if (!validCategories.includes(parsed.category)) {
                return { extract: false, reason: `Invalid category: ${parsed.category}` };
            }

            // interaction_signals 类别本身允许低确定性观察，单独使用较宽松的置信度阈值
            const confidenceThreshold = parsed.category === 'interaction_signals' ? 0.4 : 0.5;
            if (parsed.confidence !== undefined && parsed.confidence < confidenceThreshold) {
                return { extract: false, reason: `Confidence too low: ${parsed.confidence}` };
            }
        }

        return parsed;
    }

    // ========================================================================
    // 工具方法
    // ========================================================================

    /**
     * 获取指定类别的事实
     */
    async getFactsByCategory(category: LongTermFactCategory): Promise<Array<{
        id: string;
        content: string;
        importance: number;
    }>> {
        const result = await invoke<Array<{
            id: string;
            content: string;
            importance: number | null;
        }>>('memory_list_facts', {
            agentId: this.agentId,
            category,
        });

        return result.map(r => ({
            id: r.id,
            content: r.content,
            importance: r.importance ?? 3,
        }));
    }

    /**
     * 获取所有事实
     */
    async getAllFacts(): Promise<Array<{
        id: string;
        content: string;
        category: LongTermFactCategory;
        importance: number;
    }>> {
        const result = await invoke<Array<{
            id: string;
            content: string;
            category: string | null;
            importance: number | null;
        }>>('memory_list_by_layer', {
            agentId: this.agentId,
            layer: 'fact',
        });

        return result.map(r => ({
            id: r.id,
            content: r.content,
            // 类别未知时默认归入 interaction_signals（开放捕获通道的安全洗略）
            category: (r.category ?? 'interaction_signals') as LongTermFactCategory,
            importance: r.importance ?? 3,
        }));
    }

    /**
     * 语义相似度判断
     *
     * 使用 Embedding 余弦相似度替代空格分词，正确处理中文文本
     */
    private async isSimilarContent(a: string, b: string): Promise<boolean> {
        try {
            return await embeddingService.isSemanticallySimilar(a, b, 0.75);
        } catch (error) {
            logger.warn('[FactExtractor] 语义相似度判断失败，回退到字符重叠:', error);
            // 回退策略：基于字符级 bigram 重叠
            const bigramsA = new Set<string>();
            const bigramsB = new Set<string>();
            for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
            for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
            let overlap = 0;
            for (const bg of bigramsA) { if (bigramsB.has(bg)) overlap++; }
            return overlap / Math.max(bigramsA.size, bigramsB.size) > 0.6;
        }
    }
}

/**
 * 创建 FactExtractor 实例
 */
export function createFactExtractor(llm: LLMService, agentId: string): FactExtractor {
    return new FactExtractor(llm, agentId);
}
