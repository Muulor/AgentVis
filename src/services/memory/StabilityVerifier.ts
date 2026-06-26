/**
 * StabilityVerifier - 稳定性验证器
 * 
 * 【Layer 2】判断候选事实是否足够稳定以写入长期记忆
 * 
 * 验证维度：
 * 1. 跨轮次重复 - 同一事实在不同轮次、不同语境中出现 ≥2 次
 * 2. 用户确认 - 被用户显式确认（"对的"、"就是这样"、"你记住这个"）
 * 3. 决策影响 - 在关键决策中被反复引用
 * 
 * 打分规则：
 * | 维度              | 分值 |
 * |-------------------|------|
 * | 跨多轮重复出现    | +3   |
 * | 表达确定（无模糊词）| +2   |
 * | 影响决策路径      | +2   |
 * | 被用户确认        | +3   |
 * | 含临时/情绪/假设  | −3   |
 * | 强上下文绑定      | −2   |
 * 
 */

import type {
    MemoryCandidate,
    StabilityVerificationResult,
    LongTermFactCategory,
} from './types';
import { embeddingService } from '../rag/EmbeddingService';
import { getSemanticHintsBatch, type SemanticHints } from './SemanticAnchors';
import { getLogger } from '@services/logger';

const logger = getLogger('StabilityVerifier');
const EMPTY_SEMANTIC_HINTS: SemanticHints = {
    certaintyBoost: 0,
    uncertaintyPenalty: 0,
    rawScores: { avgCertaintySimilarity: 0, avgUncertaintySimilarity: 0 },
};

// ============================================================================
// 配置常量
// ============================================================================

/** 保留候选的默认最低分数阈值 */
export const CANDIDATE_RETENTION_THRESHOLD = 3;

/** 写入记忆的最低分数阈值 */
export const MEMORY_WRITE_THRESHOLD = 5;

/** 保留候选池溢出阈值（达到此数量后强制送入 LLM） */
export const CANDIDATE_POOL_OVERFLOW_THRESHOLD = 5;

const REASON_DELIMITER = '; ';
const REASON_SPLIT_PATTERN = /\s*(?:;|、)\s*/;

/**
 * 类别感知的保留阈值
 *
 * interaction_signals 降低保留门槛：该类别的质量把关由 Layer 3（LLM）承担，
 * Layer 2 仅做"明显噪声过滤"（score < 1 的才丢弃）。
 * 与 FactExtractor 中置信度阈值分级的设计对称。
 */
const CATEGORY_RETENTION_THRESHOLD: Record<LongTermFactCategory, number> = {
    preference_style: CANDIDATE_RETENTION_THRESHOLD,
    identity_role: CANDIDATE_RETENTION_THRESHOLD,
    long_term_goal: CANDIDATE_RETENTION_THRESHOLD,
    knowledge_level: CANDIDATE_RETENTION_THRESHOLD,
    // interaction_signals 保留门槛降低：让更多候选进入池子等待累积或溢出，
    // 依赖 LLM（Layer 3）做最终价值判断
    interaction_signals: 1,
    task_experience: CANDIDATE_RETENTION_THRESHOLD,
};

/** 打分权重配置 */
const SCORE_WEIGHTS = {
    /** 跨多轮重复出现 (occurrenceCount >= 2) */
    REPETITION: 3,
    /** 表达确定（无模糊词） */
    CERTAINTY: 2,
    /** 影响决策路径 */
    DECISION_IMPACT: 2,
    /** 被用户确认 */
    USER_CONFIRMATION: 3,
    /** 含临时/情绪/假设（惩罚） */
    TEMPORARY_PENALTY: -3,
    /** 强上下文绑定（惩罚） */
    CONTEXT_BOUND_PENALTY: -2,
    /** 语义放大倍率（用于 enrichSemanticSignals） */
    SEMANTIC_AMPLIFIER: 1.5,
};

/**
 * 类别加成分
 * 
 * 某些类别的事实更具稳定性，首次出现即可给予额外加分
 */
const CATEGORY_BONUS: Record<LongTermFactCategory, number> = {
    preference_style: 3,         // 偏好类通常稳定
    identity_role: 3,            // 身份类通常稳定
    long_term_goal: 2,           // 长期目标较稳定
    knowledge_level: 2,          // 知识水平较稳定
    // interaction_signals 不给类别加成；其价值来自 LLM 的"值得记住"直觉，
    // 而非规则层可证明的稳定性，加分反而会误导打分模型
    interaction_signals: 0,
    task_experience: 0,          // 任务经验直写记忆，不经过稳定性验证
};

/** 
 * 模糊词汇（不确定表达）
 * 
 * 注意：不包含时间词，时间词单独处理（见下方）
 */
const FUZZY_KEYWORDS = [
    '可能', '也许', '或许', '大概', '应该', '估计',
    'maybe', 'perhaps', 'probably', 'might', 'possibly', 'roughly',
    'I think', 'I guess', 'not sure', 'uncertain', 'tentative', 'seems',
];

/**
 * 弱时间词 - 对偏好类不惩罚
 * 
 * 这些词在偏好表达中是自然的（"最近在补电影" ≠ 临时偏好）
 */
const WEAK_TEMPORAL_KEYWORDS = [
    '最近', '有空', '平时', '这阵子', '近来',
    'recently', 'lately', 'usually', 'normally', 'these days', 'most days',
    'from time to time',
];

/**
 * 强时间词 - 对所有类别惩罚（偏好类减半）
 * 
 * 这些词确实表示临时状态
 */
const STRONG_TEMPORAL_KEYWORDS = [
    '目前', '现在', '这次', '暂时', '临时', '今天', '这周',
    'currently', 'now', 'this time', 'today', 'this week', 'for now',
    'temporarily', 'at the moment', 'right now', 'just this time',
];

/** 情绪/假设词汇 */
const EMOTIONAL_HYPOTHETICAL_KEYWORDS = [
    '烦', '累', '生气', '郁闷', '焦虑',
    '如果', '假如', '假设', '万一',
    'if', 'suppose', 'assume', 'hypothetically', 'what if',
    'annoyed', 'upset', 'frustrated', 'anxious', 'stressed', 'tired',
    'angry', 'worried',
];

/**
 * 强上下文绑定词汇 - 工作/代码相关，维持惩罚
 */
const STRONG_CONTEXT_BOUND_KEYWORDS = [
    '这个项目', '这个任务', '这个文件', '这段代码',
    '这个函数', '这个模块', '这个接口',
    '刚才', '刚刚', '方才',
    'this project', 'this task', 'this file', 'this code', 'this function',
    'this module', 'this interface', 'this repo', 'this branch', 'just now',
    'earlier', 'a moment ago',
];

/**
 * 弱上下文绑定词汇 - 生活/娱乐相关，不惩罚
 * 
 * "这个电影我挺喜欢的" 并不意味着"只在这个上下文成立"
 * 
 * 注意：当前未使用，保留用于未来可能的日志/调试需求
 */
// 导出供测试/调试使用
export const WEAK_CONTEXT_BOUND_KEYWORDS = [
    '这个电影', '这部片子', '这部电影', '这类片子',
    '这类音乐', '这种音乐', '这首歌',
    '这类游戏', '这个游戏',
    '这本书', '这类书',
    'this movie', 'this film', 'this song', 'this game', 'this book',
];

/** 决策影响关键词 */
const DECISION_IMPACT_KEYWORDS = [
    '决定', '选择', '采用', '使用', '必须', '一定',
    '不要', '不能', '禁止', '要求',
    'decide', 'choose', 'select', 'pick', 'adopt', 'use', 'must',
    'must use', 'always use', 'never use', 'require', 'required',
    'requirement', 'constraint', 'do not', 'cannot', 'forbid', 'avoid',
];

/**
 * 偏好信号关键词 - 用于 Soft Signal (+1)
 * 
 * 仅适用于 preference_style 类别
 * 设计意图：把"边缘候选"从丢弃区拉回保留区
 */
const PREFERENCE_SIGNAL_KEYWORDS = [
    // 中文 - 喜欢类
    '喜欢', '爱看', '爱听', '爱玩', '偏爱', '更喜欢', '挺喜欢', '很喜欢',
    '超喜欢', '太喜欢', '比较喜欢', '特别喜欢',
    '迷上', '着迷', '热衷', '钟爱', '中意',
    // 中文 - 不喜欢类（也是偏好信号）
    '不喜欢', '讨厌', '反感', '不爱',
    // 英文
    'like', 'love', 'enjoy', 'prefer', 'into', 'fan of', 'fond of',
    'adore', 'favorite', 'favourite', 'would rather', 'lean toward',
    'hate', 'dislike', 'avoid', "can't stand",
];

// ============================================================================
// 验证器类
// ============================================================================

/**
 * 稳定性验证器类
 */
export class StabilityVerifier {
    /**
     * 验证候选事实的稳定性
     * 
     * 优化点：
     * 1. 偏好类 Soft Signal (+1) - 对自然偏好表达给予轻量加分
     * 2. Category-Aware 时间惩罚 - 偏好类对弱时间词不惩罚
     * 3. 上下文绑定词拆分 - 只有强上下文（工作/代码相关）才惩罚
     * 
     * @param candidate - 候选事实
     * @returns 验证结果
     */
    verify(candidate: MemoryCandidate): StabilityVerificationResult {
        const scoreBreakdown: StabilityVerificationResult['scoreBreakdown'] = {
            repetition: 0,
            certainty: 0,
            decisionImpact: 0,
            userConfirmation: 0,
            temporaryPenalty: 0,
            contextBoundPenalty: 0,
            preferenceSignal: 0,
            interactionSignal: 0,
        };

        const content = candidate.content.toLowerCase();
        const isPreferenceCategory = candidate.category === 'preference_style';

        // 1. 跨多轮重复出现 (+3)
        if (candidate.occurrenceCount >= 2) {
            scoreBreakdown.repetition = SCORE_WEIGHTS.REPETITION;
        }

        // 2. 表达确定（无模糊词）(+2)
        // 注意：模糊词不再包含时间词，时间词单独处理
        const hasFuzzyWords = FUZZY_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );
        if (!hasFuzzyWords) {
            scoreBreakdown.certainty = SCORE_WEIGHTS.CERTAINTY;
        }

        // 3. 影响决策路径 (+2)
        const hasDecisionImpact = DECISION_IMPACT_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );
        if (hasDecisionImpact) {
            scoreBreakdown.decisionImpact = SCORE_WEIGHTS.DECISION_IMPACT;
        }

        // 4. 被用户确认 (+3)
        if (candidate.userConfirmed) {
            scoreBreakdown.userConfirmation = SCORE_WEIGHTS.USER_CONFIRMATION;
        }

        // 5. 含临时/情绪/假设（惩罚）- Category-Aware
        const hasEmotionalHypothetical = EMOTIONAL_HYPOTHETICAL_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );
        const hasWeakTemporal = WEAK_TEMPORAL_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );
        const hasStrongTemporal = STRONG_TEMPORAL_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );

        if (hasEmotionalHypothetical) {
            // 情绪/假设词对所有类别都惩罚
            scoreBreakdown.temporaryPenalty = SCORE_WEIGHTS.TEMPORARY_PENALTY;
        } else if (hasStrongTemporal) {
            // 强时间词：偏好类减半惩罚，其他类别完整惩罚
            scoreBreakdown.temporaryPenalty = isPreferenceCategory
                ? Math.round(SCORE_WEIGHTS.TEMPORARY_PENALTY / 2)  // -1.5 → -2 (rounded)
                : SCORE_WEIGHTS.TEMPORARY_PENALTY;
        } else if (hasWeakTemporal && !isPreferenceCategory) {
            // 弱时间词：只对非偏好类惩罚
            scoreBreakdown.temporaryPenalty = SCORE_WEIGHTS.TEMPORARY_PENALTY;
        }
        // 偏好类 + 弱时间词 = 不惩罚（"最近在补电影" ≠ 临时偏好）

        // 6. 上下文绑定（只惩罚强上下文）
        const hasStrongContextBound = STRONG_CONTEXT_BOUND_KEYWORDS.some(kw =>
            content.includes(kw.toLowerCase())
        );
        // 弱上下文绑定（如"这个电影"）不惩罚
        // const hasWeakContextBound = WEAK_CONTEXT_BOUND_KEYWORDS.some(kw => content.includes(kw.toLowerCase()));

        if (hasStrongContextBound) {
            scoreBreakdown.contextBoundPenalty = SCORE_WEIGHTS.CONTEXT_BOUND_PENALTY;
        }

        // 7. 偏好类 Soft Signal (+1)
        // 仅适用于 preference_style 类别，用于把边缘候选拉回保留区
        if (isPreferenceCategory) {
            const hasPreferenceSignal = PREFERENCE_SIGNAL_KEYWORDS.some(kw =>
                content.includes(kw.toLowerCase())
            );
            if (hasPreferenceSignal) {
                scoreBreakdown.preferenceSignal = 1;
            }
        }

        // 8. 交互信号 Soft Signal (+2)
        // interaction_signals 类别无 CATEGORY_BONUS（其价值来自 LLM 直觉而非规则稳定性），
        // 但词典匹配本身已是有意义的第一层筛选证据，给予基线加分
        // 避免该类别候选系统性被丢弃（典型得分从 0-2 提升到 2-4，可进入候选池）
        if (candidate.category === 'interaction_signals') {
            scoreBreakdown.interactionSignal = 2;
        }

        // 计算总分
        const baseScore = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0);

        // 加上类别加成分
        const categoryBonus = CATEGORY_BONUS[candidate.category];
        const score = baseScore + categoryBonus;

        // 判断是否通过
        const passed = score >= MEMORY_WRITE_THRESHOLD;

        // 生成验证理由
        const reasons: string[] = [];
        if (scoreBreakdown.repetition > 0) reasons.push('repeated across turns');
        if (scoreBreakdown.certainty > 0) reasons.push('confident wording');
        if (scoreBreakdown.decisionImpact > 0) reasons.push('impacts decision path');
        if (scoreBreakdown.userConfirmation > 0) reasons.push('confirmed by user');
        if ((scoreBreakdown.preferenceSignal ?? 0) > 0) reasons.push('preference signal');
        if ((scoreBreakdown.interactionSignal ?? 0) > 0) reasons.push('interaction-signal baseline');
        if (scoreBreakdown.temporaryPenalty < 0) reasons.push('temporary or hypothetical wording');
        if (scoreBreakdown.contextBoundPenalty < 0) reasons.push('strong context binding');

        return {
            passed,
            score,
            scoreBreakdown,
            reason: reasons.length > 0
                ? reasons.join(REASON_DELIMITER)
                : (passed ? 'meets stability requirements' : 'below stability threshold'),
        };
    }

    /**
     * 批量验证候选事实
     * 
     * @param candidates - 候选事实列表
     * @returns 验证结果列表和通过验证的候选
     */
    verifyBatch(candidates: MemoryCandidate[]): {
        results: Array<{ candidate: MemoryCandidate; result: StabilityVerificationResult }>;
        passed: MemoryCandidate[];
        retained: MemoryCandidate[];
    } {
        const results: Array<{ candidate: MemoryCandidate; result: StabilityVerificationResult }> = [];
        const passed: MemoryCandidate[] = [];
        const retained: MemoryCandidate[] = [];

        for (const candidate of candidates) {
            const result = this.verify(candidate);
            results.push({ candidate, result });

            // 使用类别感知的保留阈值（interaction_signals 门槛更低）
            const retentionThreshold = CATEGORY_RETENTION_THRESHOLD[candidate.category];

            if (result.score >= MEMORY_WRITE_THRESHOLD) {
                passed.push(candidate);
            } else if (result.score >= retentionThreshold) {
                retained.push(candidate);
            }
            // 分数 < retentionThreshold 的候选将被丢弃
        }

        return { results, passed, retained };
    }

    /**
     * 批量验证候选事实（异步版本，带语义增强）
     *
     * 【Cascading Verification】
     * 1. 先用同步 verify() 快速过滤
     * 2. 对于"灰度地带"候选 (RETENTION_THRESHOLD <= score < WRITE_THRESHOLD)，
     *    调用 enrichSemanticSignals 进行语义放大
     * 3. 重新评估是否能晋升
     *
     * @param candidates - 候选事实列表
     * @returns 验证结果列表和通过验证的候选
     */
    async verifyBatchAsync(candidates: MemoryCandidate[]): Promise<{
        results: Array<{ candidate: MemoryCandidate; result: StabilityVerificationResult }>;
        passed: MemoryCandidate[];
        retained: MemoryCandidate[];
    }> {
        const results: Array<{ candidate: MemoryCandidate; result: StabilityVerificationResult }> = [];
        const passed: MemoryCandidate[] = [];
        const retained: MemoryCandidate[] = [];

        // 同步快速过滤
        const grayZoneCandidates: Array<{ candidate: MemoryCandidate; result: StabilityVerificationResult; index: number }> = [];

        for (const [i, candidate] of candidates.entries()) {
            const result = this.verify(candidate);
            results.push({ candidate, result });

            // 使用类别感知的保留阈值（interaction_signals 门槛更低）
            const retentionThreshold = CATEGORY_RETENTION_THRESHOLD[candidate.category];

            if (result.score >= MEMORY_WRITE_THRESHOLD) {
                // 直接通过，无需语义增强
                passed.push(candidate);
            } else if (result.score >= retentionThreshold) {
                // 灰度地带，需语义增强判断
                grayZoneCandidates.push({ candidate, result, index: i });
            }
            // score < retentionThreshold 的候选直接丢弃
        }

        // 对灰度地带候选进行语义增强
        if (grayZoneCandidates.length > 0) {
            logger.trace(`[StabilityVerifier] 灰度地带候选数量: ${grayZoneCandidates.length}，触发语义增强`);

            const grayZoneTexts = grayZoneCandidates.map(g => g.candidate.content);
            const semanticHintsList = await getSemanticHintsBatch(grayZoneTexts);

            for (let i = 0; i < grayZoneCandidates.length; i++) {
                const grayZoneCandidate = grayZoneCandidates[i];
                if (!grayZoneCandidate) continue;
                const { candidate, result, index } = grayZoneCandidate;
                const hints = semanticHintsList[i] ?? EMPTY_SEMANTIC_HINTS;

                // 应用语义放大逻辑
                const enhancedResult = this.applySemanticAmplification(result, hints);

                // 更新 results 中的条目
                results[index] = { candidate, result: enhancedResult };

                if (enhancedResult.score >= MEMORY_WRITE_THRESHOLD) {
                    // 语义增强后晋升
                    logger.trace(`[StabilityVerifier]  候选晋升: "${candidate.content.substring(0, 30)}..." (${result.score} -> ${enhancedResult.score})`);
                    passed.push(candidate);
                } else {
                    // 仍在灰度地带，保留
                    retained.push(candidate);
                }
            }
        }

        return { results, passed, retained };
    }

    /**
     * 应用语义放大逻辑
     *
     * 【Gate-first Model】
     * - Embedding 只能放大已有的关键词/重复度得分
     * - 不能单独推送事实到记忆
     *
     * @param baseResult - 基础验证结果
     * @param hints - 语义提示
     * @returns 增强后的验证结果
     */
    private applySemanticAmplification(
        baseResult: StabilityVerificationResult,
        hints: SemanticHints
    ): StabilityVerificationResult {
        // 深拷贝 scoreBreakdown
        const enhancedBreakdown = { ...baseResult.scoreBreakdown };
        const reasons = baseResult.reason ? baseResult.reason.split(REASON_SPLIT_PATTERN).filter(Boolean) : [];

        // Gate-first: 只有当已有证据存在时，语义信号才能放大
        let scoreModifier = 0;

        // 确定性放大：如果关键词已判定为确定，且语义也确定，则放大
        if (hints.certaintyBoost > 0 && enhancedBreakdown.certainty > 0) {
            const amplifiedCertainty = Math.round(enhancedBreakdown.certainty * SCORE_WEIGHTS.SEMANTIC_AMPLIFIER);
            scoreModifier += amplifiedCertainty - enhancedBreakdown.certainty;
            enhancedBreakdown.certainty = amplifiedCertainty;
            if (!reasons.includes('semantic certainty boost')) {
                reasons.push('semantic certainty boost');
            }
        }

        // 决策影响放大：如果关键词已判定有决策影响，且语义也确定，则放大
        if (hints.certaintyBoost > 0 && enhancedBreakdown.decisionImpact > 0) {
            const amplifiedImpact = Math.round(enhancedBreakdown.decisionImpact * SCORE_WEIGHTS.SEMANTIC_AMPLIFIER);
            scoreModifier += amplifiedImpact - enhancedBreakdown.decisionImpact;
            enhancedBreakdown.decisionImpact = amplifiedImpact;
        }

        // 不确定性放大惩罚：如果关键词已判定有临时/假设，且语义也不确定，则放大惩罚
        if (hints.uncertaintyPenalty > 0 && enhancedBreakdown.temporaryPenalty < 0) {
            const amplifiedPenalty = Math.round(enhancedBreakdown.temporaryPenalty * SCORE_WEIGHTS.SEMANTIC_AMPLIFIER);
            scoreModifier += amplifiedPenalty - enhancedBreakdown.temporaryPenalty;
            enhancedBreakdown.temporaryPenalty = amplifiedPenalty;
            if (!reasons.includes('semantic uncertainty boost')) {
                reasons.push('semantic uncertainty boost');
            }
        }

        const enhancedScore = baseResult.score + scoreModifier;
        const passed = enhancedScore >= MEMORY_WRITE_THRESHOLD;

        return {
            passed,
            score: enhancedScore,
            scoreBreakdown: enhancedBreakdown,
            reason: reasons.length > 0
                ? reasons.join(REASON_DELIMITER)
                : (passed ? 'meets stability requirements' : 'below stability threshold'),
        };
    }

    /**
     * 合并候选池中的相似候选
     * 
     * 当新候选与候选池中的候选相似时，合并它们（累加出现次数）
     * 
     * @param newCandidates - 新扫描的候选
     * @param candidatePool - 现有候选池
     * @returns 合并后的候选池
     */
    mergeCandidates(
        newCandidates: Omit<MemoryCandidate, 'id'>[],
        candidatePool: MemoryCandidate[]
    ): MemoryCandidate[] {
        const result = [...candidatePool];

        for (const newCandidate of newCandidates) {
            // 查找相似的已有候选
            const existingIndex = result.findIndex(existing =>
                this.isSimilar(existing, newCandidate)
            );

            if (existingIndex >= 0) {
                // 合并到已有候选
                const existing = result[existingIndex];
                if (existing) {
                    existing.occurrenceCount += 1;
                    existing.lastSeenAt = Math.max(existing.lastSeenAt, newCandidate.lastSeenAt);
                    existing.userConfirmed = existing.userConfirmed || newCandidate.userConfirmed;
                    existing.score = Math.max(existing.score, newCandidate.score);
                }
            } else {
                // 添加为新候选
                result.push({
                    id: this.generateId(),
                    ...newCandidate,
                });
            }
        }

        return result;
    }

    /**
     * 合并候选池中的相似候选（异步版本，使用 Embedding 语义匹配）
     * 
     * 当新候选与候选池中的候选语义相似时，合并它们（累加出现次数）
     * 
     * @param newCandidates - 新扫描的候选
     * @param candidatePool - 现有候选池
     * @returns 合并后的候选池
     */
    async mergeCandidatesAsync(
        newCandidates: Omit<MemoryCandidate, 'id'>[],
        candidatePool: MemoryCandidate[]
    ): Promise<MemoryCandidate[]> {
        const result = [...candidatePool];

        for (const newCandidate of newCandidates) {
            // 查找语义相似的已有候选
            let existingIndex = -1;
            for (let i = 0; i < result.length; i++) {
                const existing = result[i];
                if (!existing) continue;

                // 先检查类别是否相同
                if (existing.category !== newCandidate.category) continue;

                // 使用 Embedding 语义匹配
                try {
                    const isSimilar = await embeddingService.isSemanticallySimilar(existing.content, newCandidate.content);
                    if (isSimilar) {
                        existingIndex = i;
                        break;
                    }
                } catch (error) {
                    logger.warn('[StabilityVerifier] 语义匹配失败，降级到词汇匹配:', error);
                    // 降级到同步版本
                    if (this.isSimilar(existing, newCandidate)) {
                        existingIndex = i;
                        break;
                    }
                }
            }

            if (existingIndex >= 0) {
                // 合并到已有候选
                const existing = result[existingIndex];
                if (existing) {
                    existing.occurrenceCount += 1;
                    existing.lastSeenAt = Math.max(existing.lastSeenAt, newCandidate.lastSeenAt);
                    existing.userConfirmed = existing.userConfirmed || newCandidate.userConfirmed;
                    existing.score = Math.max(existing.score, newCandidate.score);
                    logger.trace(`[StabilityVerifier]  语义合并: "${newCandidate.content.substring(0, 30)}..." -> occurrenceCount=${existing.occurrenceCount}`);
                }
            } else {
                // 添加为新候选
                result.push({
                    id: this.generateId(),
                    ...newCandidate,
                });
            }
        }

        return result;
    }

    /**
     * 判断两个候选是否相似
     * 
     * 使用简单的文本相似度判断
     */
    private isSimilar(
        a: MemoryCandidate,
        b: Omit<MemoryCandidate, 'id'>
    ): boolean {
        // 类别必须相同
        if (a.category !== b.category) {
            return false;
        }

        // 使用词汇重叠率判断
        const wordsA = new Set(a.content.toLowerCase().split(/\s+/));
        const wordsB = new Set(b.content.toLowerCase().split(/\s+/));

        let matchCount = 0;
        for (const word of wordsA) {
            if (wordsB.has(word)) {
                matchCount++;
            }
        }

        const totalWords = Math.max(wordsA.size, wordsB.size);
        return matchCount / totalWords > 0.7;
    }

    /**
     * 生成唯一 ID
     */
    private generateId(): string {
        return `candidate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
}

/**
 * 创建 StabilityVerifier 实例
 */
export function createStabilityVerifier(): StabilityVerifier {
    return new StabilityVerifier();
}
