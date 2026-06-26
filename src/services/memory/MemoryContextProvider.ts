/**
 * MemoryContextProvider - 记忆上下文提供器
 * 
 * 从后端查询记忆数据，返回调用侧可渲染的结构化上下文。
 * 
 * 设计原则：
 * 1. 事实全量加载并按类别分组 - 避免遗漏稳定用户背景
 * 2. 摘要混合召回 - 只返回与当前 query 相关的历史状态
 * 3. Evidence Slices 按需加载 - 为待决问题保留精准原文证据
 * 4. Prompt 渲染由 Chat/MB 调用侧按各自场景完成
 */

import { invoke } from '@tauri-apps/api/core';
import { memorySummaryRetriever } from './MemorySummaryRetriever';
import { getEvidenceRetriever } from './EvidenceRetriever';
import { getMemorySafeMessageContent, stripMemoryVisualCodeBlocks } from './utils/SafeMessageContent';
import { getLogger } from '@services/logger';

const logger = getLogger('MemoryContextProvider');

// ============================================================================
// 摘要召回常量
// ============================================================================

/** 摘要混合召回返回数量（Rust 层已按 document_id 前缀隔离，此值控制最终返回给 Prompt 的摘要条数） */
const SUMMARY_RECALL_TOP_K = 3;

/** 摘要 embedding 候选相似度阈值（摘要宁可多给不可遗漏，阈值偏低；后续有 topK 截断控制数量） */
const SUMMARY_RECALL_THRESHOLD = 0.4;

const DEFAULT_EVIDENCE_TURNS = 1;
const EXPANDED_EVIDENCE_TURNS = 2;
const EXPANDED_EVIDENCE_QUERY_PATTERN = new RegExp([
    '完整',
    '全过程',
    '完整过程',
    '完整流程',
    '完整链路',
    '前后文',
    '前因后果',
    '来龙去脉',
    '上下文',
    '历史脉络',
    '回顾',
    '复盘',
    '梳理',
    '串起来',
    '串一下',
    '从头到尾',
    '几步',
    '步骤',
    '链路',
    '推导',
    '怎么从',
    '如何从',
    '前面怎么说',
    '刚才怎么说',
    'timeline',
    'recap',
    'review',
    'walkthrough',
    'end-to-end',
    'full context',
    'full process',
    'sequence',
    'history',
    'chain',
    'how did we get here',
].join('|'), 'i');

function parseSourceMessageIds(sourceMessageIds: string): string[] {
    try {
        const parsed = JSON.parse(sourceMessageIds) as unknown;
        if (Array.isArray(parsed)) {
            const items = parsed as unknown[];
            return items.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
        }
    } catch {
        // JSON 解析失败，降级为逗号分隔
    }

    return sourceMessageIds.split(',').map(s => s.trim()).filter(Boolean);
}

function shouldUseExpandedEvidence(userQuery?: string): boolean {
    return Boolean(userQuery && EXPANDED_EVIDENCE_QUERY_PATTERN.test(userQuery));
}

// 时间格式化工具（用于记忆时间标注增强）
import { formatTimestamp, formatRelativeTime } from '@services/utils/TimeUtils';

// ==================== 类型定义 ====================

// OpenQuestion 统一使用共享类型定义（含 evidenceSlices 字段）
import type { OpenQuestion as OpenQuestionItem } from './types';

/**
 * 记忆项（来自后端，支持状态字段）
 */
export interface MemoryItem {
    id: string;
    agentId: string;
    layer: string;
    content: string;
    category: string | null;
    importance: number | null;
    sourceMessageIds: string | null;
    metadataJson?: string | null;  // 后端返回的 JSON 字符串
    createdAt: number;
    updatedAt: number;

    // ==================== 解析后的状态字段 ====================
    /** 关键点 */
    keyPoints?: string[];
    /** 主题 */
    topics?: string[];
    /** 提及的文件 */
    mentionedFiles?: string[];

    // ==================== 原文加载 ====================
    /** 原始消息（按需加载，用于摘要溯源） */
    originalMessages?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;

    // ==================== 状态字段（LLM 生成） ====================
    /** 已确认的结论或决策 */
    confirmedDecisions?: string[];
    /** 待决问题（驱动精准回溯） */
    openQuestions?: OpenQuestionItem[];
    /** 已失效的观点 */
    invalidatedPoints?: string[];
    /** 精准回溯的证据片段 */
    evidenceSlices?: Array<{
        turnId: number;
        speaker: 'user' | 'assistant';
        content: string;
    }>;
}

/**
 * 记忆上下文响应
 */
interface MemoryContextResponse {
    facts: MemoryItem[];
    summaries: MemoryItem[];
}

/**
 * 按类别分组的事实
 */
export type FactsByCategory = Map<string, MemoryItem[]>;

/**
 * 记忆上下文（前端使用）
 */
export interface MemoryContext {
    /** 原始事实列表 */
    facts: MemoryItem[];
    /** 原始摘要列表 */
    summaries: MemoryItem[];
    /** 按类别分组的事实 */
    factsByCategory: FactsByCategory;
}

/**
 * 获取记忆上下文的选项
 */
export interface GetMemoryContextOptions {
    /** 用户查询（用于摘要混合召回） */
    userQuery?: string;
    /** 摘要召回数量，默认 SUMMARY_RECALL_TOP_K */
    summaryTopK?: number;
    /** 摘要召回阈值，默认 SUMMARY_RECALL_THRESHOLD */
    summaryThreshold?: number;
    /** 是否加载摘要对应的原文，默认 false */
    includeOriginal?: boolean;
    /** 每条摘要的原文最大字符数，默认 500 */
    originalMaxLength?: number;
}

// ==================== 主类 ====================

/**
 * 记忆上下文提供器
 * 
 * 负责：
 * 1. 从后端查询记忆数据
 * 2. 按类别分组事实
 * 3. 摘要混合召回（可选）
 * 4. Evidence Slices 按需加载
 */
export class MemoryContextProvider {
    /**
     * 获取完整的记忆上下文
     * 
     * 事实：全量加载
     * 摘要：根据 options.userQuery 决定全量或混合召回
     * 原文：根据 options.includeOriginal 决定是否加载
     * 
     * @param agentId - Agent ID
     * @param options - 可选配置（摘要召回参数）
     * @returns 记忆上下文
     */
    async getMemoryContext(agentId: string, options?: GetMemoryContextOptions): Promise<MemoryContext> {
        try {
            // 获取全量事实和摘要
            const result = await invoke<MemoryContextResponse>(
                'memory_get_context',
                { agentId }
            );

            // 解析 metadataJson 填充状态字段
            let summaries = result.summaries.map(s => this.parseMetadataJson(s));

            // 如果提供了 userQuery，使用混合召回过滤摘要
            let isDegraded = false;
            if (options?.userQuery && summaries.length > 0) {
                const recall = await this.getRelevantSummaries(
                    agentId,
                    options.userQuery,
                    summaries,
                    options.summaryTopK ?? SUMMARY_RECALL_TOP_K,
                    options.summaryThreshold ?? SUMMARY_RECALL_THRESHOLD
                );
                summaries = recall.summaries;
                isDegraded = recall.isDegraded;
                logger.trace(`[MemoryContextProvider] 摘要混合召回: ${result.summaries.length} → ${summaries.length}${isDegraded ? ' (降级)' : ''}`);
            }

            // 降级模式下只注入摘要文本，不加载原文和证据，避免无关内容浪费 token
            if (!isDegraded) {
                // 按需加载摘要对应的原文
                if (options?.includeOriginal && summaries.length > 0) {
                    const maxLength = options.originalMaxLength ?? 500;
                    summaries = await this.loadOriginalMessages(summaries, maxLength);
                    const loadedCount = summaries.filter(s => s.originalMessages && s.originalMessages.length > 0).length;
                    logger.trace(`[MemoryContextProvider]  已加载 ${loadedCount} 条摘要的原文`);
                }

                // 为有 openQuestions 的摘要加载 Evidence Slices
                summaries = await this.loadEvidenceSlices(summaries, options?.userQuery);
            } else {
                logger.trace('[MemoryContextProvider] 降级模式: 跳过原文和 Evidence 加载，仅注入摘要文本');
            }

            // ==================== 摘要返回诊断日志 ====================
            if (summaries.length > 0) {
                logger.trace(`\n${'═'.repeat(60)}`);
                logger.trace(`[MemoryContextProvider] 📋 摘要返回报告 (共 ${summaries.length} 条)`);
                logger.trace('═'.repeat(60));

                for (const [i, s] of summaries.entries()) {
                    const timeStr = formatTimestamp(s.createdAt);
                    logger.trace(`\n  ┌─── 摘要 ${i + 1}/${summaries.length} [${timeStr}] ───`);
                    logger.trace(`  │ ID: ${s.id.substring(0, 12)}...`);
                    logger.trace(`  │ 内容: ${s.content.substring(0, 120)}${s.content.length > 120 ? '...' : ''}`);

                    // 已确认结论
                    if (s.confirmedDecisions && s.confirmedDecisions.length > 0) {
                        logger.trace(`  │ ✅ 已确认结论 (${s.confirmedDecisions.length}):`);
                        s.confirmedDecisions.forEach(d => logger.trace(`  │    - ${d}`));
                    }

                    // 原文消息回溯
                    if (s.originalMessages && s.originalMessages.length > 0) {
                        logger.trace(`  │ 📝 原文消息 (${s.originalMessages.length} 条):`);
                        s.originalMessages.forEach((msg, idx) => {
                            const roleTag = msg.role === 'user' ? 'User' : 'Assistant';
                            logger.trace(`  │    ${idx + 1}. [${roleTag}] "${msg.content.substring(0, 80)}${msg.content.length > 80 ? '...' : ''}"`);
                        });
                    } else {
                        logger.trace(`  │ 📝 原文消息: (未加载或无 sourceMessageIds)`);
                    }

                    // 待决问题
                    if (s.openQuestions && s.openQuestions.length > 0) {
                        logger.trace(`  │ ❓ 待决问题 (${s.openQuestions.length}):`);
                        s.openQuestions.forEach(q => logger.trace(`  │    - ${q.question}`));
                    }

                    // Evidence Slices（从问题级别读取）
                    const questionSliceCount = s.openQuestions?.reduce(
                        (sum, q) => sum + (q.evidenceSlices?.length ?? 0), 0
                    ) ?? 0;
                    if (questionSliceCount > 0) {
                        logger.trace(`  │ 🔍 Evidence Slices (${questionSliceCount}):`);
                        s.openQuestions?.forEach(q => {
                            q.evidenceSlices?.forEach((slice, idx) => {
                                const speaker = slice.speaker === 'user' ? 'User' : 'Assistant';
                                logger.trace(`  │    [${q.question.substring(0, 25)}...] ${idx + 1}. [Turn ${slice.turnId} - ${speaker}] "${slice.content.substring(0, 60)}${slice.content.length > 60 ? '...' : ''}"`);
                            });
                        });
                    } else if (s.openQuestions && s.openQuestions.length > 0) {
                        logger.trace(`  │ 🔍 Evidence Slices: ⚠️ 有待决问题但无证据片段`);
                    }

                    // 已失效观点
                    if (s.invalidatedPoints && s.invalidatedPoints.length > 0) {
                        logger.trace(`  │ ⛔ 已失效观点 (${s.invalidatedPoints.length}):`);
                        s.invalidatedPoints.forEach(p => logger.trace(`  │    - ${p}`));
                    }

                    logger.trace(`  └${'─'.repeat(40)}`);
                }

                logger.trace(`${'═'.repeat(60)}\n`);
            }

            return {
                facts: result.facts,
                summaries,
                factsByCategory: this.groupFactsByCategory(result.facts),
            };
        } catch (error) {
            logger.warn('[MemoryContextProvider] 获取记忆上下文失败:', error);
            // 降级返回空上下文，不阻塞主流程
            return {
                facts: [],
                summaries: [],
                factsByCategory: new Map(),
            };
        }
    }


    /**
     * 解析 metadataJson 填充状态字段
     * 
     * 后端存储的 metadataJson 包含 openQuestions、confirmedDecisions 等
     */
    private parseMetadataJson(summary: MemoryItem): MemoryItem {
        if (!summary.metadataJson) {
            return summary;
        }

        try {
            const metadata = JSON.parse(summary.metadataJson) as {
                keyPoints?: string[];
                topics?: string[];
                mentionedFiles?: string[];
                confirmedDecisions?: string[];
                openQuestions?: OpenQuestionItem[];
                invalidatedPoints?: string[];
            };

            return {
                ...summary,
                keyPoints: metadata.keyPoints,
                topics: metadata.topics,
                mentionedFiles: metadata.mentionedFiles,
                confirmedDecisions: metadata.confirmedDecisions,
                openQuestions: metadata.openQuestions,
                invalidatedPoints: metadata.invalidatedPoints,
            };
        } catch (error) {
            logger.warn('[MemoryContextProvider] 解析 metadataJson 失败:', error);
            return summary;
        }
    }


    /**
     * 加载摘要对应的原始消息
     * 
     * 通过 sourceMessageIds 批量查询原始消息，附加到摘要对象
     * 
     * @param summaries - 摘要列表
     * @param maxLength - 每条原文的最大字符数
     * @returns 带原文的摘要列表
     */
    private async loadOriginalMessages(
        summaries: MemoryItem[],
        maxLength: number
    ): Promise<MemoryItem[]> {
        // 收集所有需要加载的消息 ID
        const allMessageIds: string[] = [];
        const summaryToIds = new Map<string, string[]>();

        for (const summary of summaries) {
            if (!summary.sourceMessageIds) continue;

            // 解析 sourceMessageIds（兼容 JSON 数组或逗号分隔格式）
            const ids = parseSourceMessageIds(summary.sourceMessageIds);

            if (ids.length > 0) {
                summaryToIds.set(summary.id, ids);
                allMessageIds.push(...ids);
            }
        }

        if (allMessageIds.length === 0) {
            return summaries;
        }

        // 批量查询消息（去重）
        const uniqueIds = [...new Set(allMessageIds)];
        let messagesMap: Map<string, { role: string; content: string }> = new Map();

        try {
            interface BackendMessage {
                id: string;
                role: string;
                content: string;
                metadata?: string | null;
            }
            const messages = await invoke<BackendMessage[]>('message_get_batch', { ids: uniqueIds });
            messagesMap = new Map(messages.map(m => [
                m.id,
                { role: m.role, content: getMemorySafeMessageContent(m) },
            ]));
        } catch (error) {
            logger.warn('[MemoryContextProvider] 批量查询消息失败:', error);
            return summaries;
        }

        // 附加原文到摘要
        return summaries.map(summary => {
            const ids = summaryToIds.get(summary.id);
            if (!ids) return summary;

            const originalMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
            for (const id of ids) {
                const msg = messagesMap.get(id);
                if (msg) {
                    // 截断过长的内容
                    let content = msg.content;
                    if (content.length > maxLength) {
                        content = content.substring(0, maxLength) + '...';
                    }
                    originalMessages.push({
                        role: msg.role === 'user' ? 'user' : 'assistant',
                        content,
                    });
                }
            }

            return { ...summary, originalMessages };
        });
    }

    /**
     * 为有 openQuestions 的摘要加载 Evidence Slices
     * 
     * 调用 EvidenceRetriever 精准提取原文证据片段
     */
    private async loadEvidenceSlices(summaries: MemoryItem[], userQuery?: string): Promise<MemoryItem[]> {
        // 筛选有 openQuestions 的摘要
        const summariesWithQuestions = summaries.filter(
            s => s.openQuestions && s.openQuestions.length > 0 && s.sourceMessageIds
        );

        if (summariesWithQuestions.length === 0) {
            logger.trace('[MemoryContextProvider]  没有摘要包含 openQuestions，跳过 Evidence 回溯');
            return summaries;
        }

        logger.trace(`[MemoryContextProvider]  开始 Evidence 回溯，${summariesWithQuestions.length} 条摘要有待决问题`);

        const evidenceRetriever = getEvidenceRetriever();
        const primaryEvidenceSummaryId = summariesWithQuestions[0]?.id;
        const maxEvidenceTurns = shouldUseExpandedEvidence(userQuery)
            ? EXPANDED_EVIDENCE_TURNS
            : DEFAULT_EVIDENCE_TURNS;
        const updatedSummaries = await Promise.all(
            summaries.map(async (summary) => {
                // 如果没有 openQuestions，直接返回
                if (!summary.openQuestions || summary.openQuestions.length === 0 || !summary.sourceMessageIds) {
                    return summary;
                }

                // 只为召回排序中最相关的一条摘要展开原文证据，其余摘要保留结构化状态即可
                if (summary.id !== primaryEvidenceSummaryId) {
                    return summary;
                }

                // 解析 sourceMessageIds
                const sourceIds = parseSourceMessageIds(summary.sourceMessageIds);

                if (sourceIds.length === 0) {
                    return summary;
                }

                // 为每个 openQuestion 独立检索 Evidence Slices
                // 将 slices 挂到问题级别而非摘要级别，避免渲染时重复
                const updatedQuestions: OpenQuestionItem[] = [];
                let totalSliceCount = 0;

                for (const question of summary.openQuestions) {
                    const slices = await evidenceRetriever.retrieveByIds(question, sourceIds, {
                        maxEvidenceTurns,
                        userQuery,
                    });

                    // 按 turnId + speaker 去重
                    const seen = new Set<string>();
                    const uniqueSlices = slices
                        .map(slice => ({
                            turnId: slice.turnId,
                            speaker: slice.speaker,
                            content: slice.content,
                        }))
                        .filter(slice => {
                            const key = `${slice.turnId}-${slice.speaker}`;
                            if (seen.has(key)) return false;
                            seen.add(key);
                            return true;
                        });

                    updatedQuestions.push({ ...question, evidenceSlices: uniqueSlices });
                    totalSliceCount += uniqueSlices.length;
                }

                if (totalSliceCount > 0) {
                    logger.trace(`[MemoryContextProvider]  摘要 ${summary.id.substring(0, 8)} 加载了 ${totalSliceCount} 个 Evidence Slices:`);
                    updatedQuestions.forEach(q => {
                        q.evidenceSlices?.forEach((slice, idx) => {
                            logger.trace(`    [${q.question.substring(0, 30)}...] ${idx + 1}. [Turn ${slice.turnId} - ${slice.speaker}] "${slice.content.substring(0, 60)}..."`);
                        });
                    });
                }

                return {
                    ...summary,
                    openQuestions: updatedQuestions,
                };
            })
        );

        return updatedSummaries;
    }

    /**
     * 混合召回相关摘要

     * 
     * @param agentId - Agent ID
     * @param userQuery - 用户查询
     * @param allSummaries - 全量摘要
     * @param topK - 返回数量
     * @param threshold - 相似度阈值
     * @returns 相关的摘要列表
     */
    private async getRelevantSummaries(
        agentId: string,
        userQuery: string,
        allSummaries: MemoryItem[],
        topK: number,
        threshold: number
    ): Promise<{ summaries: MemoryItem[]; isDegraded: boolean }> {
        return memorySummaryRetriever.retrieve(agentId, userQuery, allSummaries, {
            topK,
            threshold,
        });
    }

    /**
     * 按类别分组事实
     */
    private groupFactsByCategory(facts: MemoryItem[]): FactsByCategory {
        const grouped = new Map<string, MemoryItem[]>();

        for (const fact of facts) {
            const category = fact.category ?? 'OTHER';
            const existing = grouped.get(category) ?? [];
            existing.push(fact);
            grouped.set(category, existing);
        }

        return grouped;
    }

    /**
     * 构建"身份与偏好"部分的 Prompt（需遵守的约束）
     * 
     * 包含：identity_role、preference_style
     * 这些是模型应该遵守的硬约束，合并到 Agent 身份 Prompt
     * 
     * @param facts - 事实列表
     * @returns 格式化的身份与偏好 Prompt，如果无相关事实返回 null
     */
    buildBindingFactsPrompt(facts: MemoryItem[]): string | null {
        if (facts.length === 0) return null;

        const grouped = this.groupFactsByCategory(facts);
        const parts: string[] = [];

        // 身份/角色（用户的身份背景）
        const identityRoles = grouped.get('identity_role') ?? [];
        if (identityRoles.length > 0) {
            parts.push('## User Identity\n' + identityRoles.map(f => `- ${f.content}`).join('\n'));
        }

        // 偏好/风格（必须遵守）
        const preferences = grouped.get('preference_style') ?? [];
        if (preferences.length > 0) {
            parts.push('## User Preferences\n' + preferences.map(f => `- ${f.content}`).join('\n'));
        }

        if (parts.length === 0) return null;

        // 添加优先级说明：当前用户请求优先于历史偏好
        const priorityNote = '> **Note**: The information above is summarized from historical interactions with the user. If the current user request conflicts with historical preferences, follow the user\'s **currently explicit intent**.';

        return '# Confirmed Identity And Preferences\n\n' + parts.join('\n\n') + '\n\n' + priorityNote;
    }

    /**
     * 构建其他事实部分的 Prompt
     * 
     * 包含：long_term_goal、knowledge_level、interaction_signals
     * 这些是用户背景知识，不是 Agent 身份的一部分
     * 
     * @param facts - 事实列表
     * @returns 格式化的其他事实 Prompt，如果无相关事实返回 null
     */
    buildContextFactsPrompt(facts: MemoryItem[]): string | null {
        if (facts.length === 0) return null;

        const grouped = this.groupFactsByCategory(facts);
        const parts: string[] = [];

        // 长期目标/约束
        const goals = grouped.get('long_term_goal') ?? [];
        if (goals.length > 0) {
            parts.push('## Long-Term Goals\n' + goals.map(f => {
                const timeHint = formatRelativeTime(f.updatedAt);
                return `- ${f.content} _(updated ${timeHint})_`;
            }).join('\n'));
        }

        // 知识水平/技能
        const knowledge = grouped.get('knowledge_level') ?? [];
        if (knowledge.length > 0) {
            parts.push('## Knowledge Background\n' + knowledge.map(f => {
                const timeHint = formatRelativeTime(f.updatedAt);
                return `- ${f.content} _(updated ${timeHint})_`;
            }).join('\n'));
        }

        // 值得留意的交互信号（开放捕获，参考性使用）
        const context = grouped.get('interaction_signals') ?? [];
        if (context.length > 0) {
            parts.push('## Interaction Signals Worth Noticing\n> The following signals were captured from historical interactions. They are hard to categorize but may affect collaboration style; use them only as reference.\n' + context.map(f => {
                const timeHint = formatRelativeTime(f.updatedAt);
                return `- ${f.content} _(updated ${timeHint})_`;
            }).join('\n'));
        }

        // task_experience 由 buildTaskExperiencePrompt 独立渲染，此处跳过

        // 其他事实（排除已由独立方法处理的类别）
        const others = grouped.get('OTHER') ?? [];
        if (others.length > 0) {
            parts.push('## Other Known Information\n' + others.map(f => `- ${f.content}`).join('\n'));
        }

        if (parts.length === 0) return null;

        return '# Factual Background From User Interactions (for reference only)\n\n' + parts.join('\n\n');
    }

    /**
     * 构建任务经验部分的 Prompt
     * 
     * 独立于用户事实，展示 SA 历史执行中积累的试错经验。
     * MB 派发任务时参考这些经验，避免 SA 重复犯错。
     * 
     * @param facts - 事实列表（从中提取 task_experience 类别）
     * @returns 格式化的任务经验 Prompt，如无相关事实返回 null
     */
    buildTaskExperiencePrompt(facts: MemoryItem[]): string | null {
        if (facts.length === 0) return null;

        const grouped = this.groupFactsByCategory(facts);
        const experiences = grouped.get('task_experience') ?? [];
        if (experiences.length === 0) return null;

        return '# Historical Task Execution Experience\n\n' +
            '> The following notes come from Sub-Agent trial-and-error summaries in past tasks. ' +
            'Reference them when dispatching work to avoid repeating the same mistakes.\n\n' +
            experiences.map(f => `- ${f.content}`).join('\n');
    }

    /**
     * 构建事实部分的 Prompt（合并到 Agent 身份 Prompt）
     * 
     * @deprecated 请使用 buildBindingFactsPrompt() 和 buildContextFactsPrompt() 分别构建
     * 
     * 分区展示不同类别的事实，便于模型理解和区分
     * 
     * @param facts - 事实列表
     * @returns 格式化的事实 Prompt
     */
    buildFactsPrompt(facts: MemoryItem[]): string {
        if (facts.length === 0) return '';

        // 使用新方法构建，保持向后兼容
        const bindingPrompt = this.buildBindingFactsPrompt(facts);
        const contextPrompt = this.buildContextFactsPrompt(facts);

        const parts: string[] = [];
        if (bindingPrompt) parts.push(bindingPrompt);
        if (contextPrompt) parts.push(contextPrompt);

        return parts.join('\n\n---\n\n');
    }

    /**
     * 构建摘要部分的 Prompt（状态型）
     * 
     * 新策略：
     * - confirmedDecisions 作为确定事实输出
     * - 仅当 openQuestions 非空时才附加 Evidence Slices
     * - invalidatedPoints 以警告形式呈现
     * 
     * @param summaries - 摘要列表
     * @returns 格式化的摘要 Prompt，如无摘要返回 null
     */
    buildSummariesPrompt(summaries: MemoryItem[]): string | null {
        if (summaries.length === 0) return null;

        // 按时间正序（最早的在前），与对话发展的自然叙事一致
        const sorted = [...summaries].sort((a, b) => a.createdAt - b.createdAt);

        const lines: string[] = [];

        for (const s of sorted) {
            const timeStr = formatTimestamp(s.createdAt);
            lines.push(`- [${timeStr}] ${stripMemoryVisualCodeBlocks(s.content)}`);

            // 已确认的决策（跟随当条摘要，不聚合）
            if (s.confirmedDecisions && s.confirmedDecisions.length > 0) {
                lines.push('  Confirmed decisions:');
                for (const decision of s.confirmedDecisions) {
                    lines.push(`    - ${stripMemoryVisualCodeBlocks(decision)}`);
                }
            }

            // 待决问题 + 精准回溯证据
            if (s.openQuestions && s.openQuestions.length > 0) {
                lines.push('  Open questions:');
                for (const q of s.openQuestions) {
                    const scope = q.scope ? ` (${q.scope})` : '';
                    lines.push(`    - ${stripMemoryVisualCodeBlocks(q.question)}${scope}`);
                }

                // 渲染问题级 Evidence Slices（按证据指纹分组去重）
                const groupedByEvidence = new Map<string, {
                    questions: string[];
                    slices: Array<{ turnId: number; speaker: string; content: string }>;
                }>();
                for (const q of s.openQuestions) {
                    if (q.evidenceSlices && q.evidenceSlices.length > 0) {
                        const fingerprint = q.evidenceSlices
                            .map(sl => `${sl.turnId}:${sl.speaker}`).sort().join('|');
                        const existing = groupedByEvidence.get(fingerprint);
                        if (existing) {
                            existing.questions.push(q.question);
                        } else {
                            groupedByEvidence.set(fingerprint, {
                                questions: [q.question],
                                slices: q.evidenceSlices,
                            });
                        }
                    }
                }
                if (groupedByEvidence.size > 0) {
                    lines.push('  Evidence for precise trace-back:');
                    for (const group of groupedByEvidence.values()) {
                        for (const sl of group.slices) {
                            const speaker = sl.speaker === 'user' ? 'User' : 'Assistant';
                            lines.push(`    [Turn ${sl.turnId} - ${speaker}] "${stripMemoryVisualCodeBlocks(sl.content)}"`);
                        }
                    }
                }
            }

            // 已失效观点（跟随当条摘要，不聚合）
            if (s.invalidatedPoints && s.invalidatedPoints.length > 0) {
                lines.push('  Invalidated points:');
                for (const point of s.invalidatedPoints) {
                    lines.push(`    - ${stripMemoryVisualCodeBlocks(point)}`);
                }
            }
        }

        return `## Early Conversation State\n\n${lines.join('\n')}`;
    }
}

// ==================== 导出 ====================

/** 单例实例 */
export const memoryContextProvider = new MemoryContextProvider();

/**
 * 创建 MemoryContextProvider 实例
 */
export function createMemoryContextProvider(): MemoryContextProvider {
    return new MemoryContextProvider();
}
