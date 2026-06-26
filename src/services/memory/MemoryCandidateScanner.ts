/**
 * MemoryCandidateScanner - 候选记忆扫描器
 * 
 * 【Layer 1】轻量级扫描，不调用 LLM
 * 
 * 触发时机：
 * - 每 5-10 轮对话
 * - 或用户显式确认（"你记住这个"）
 * - 或会话结束时
 * 
 * 职责：
 * - 使用规则 + 关键词检测潜在事实候选
 * - 输出 MemoryCandidate（不写入记忆）
 */

import type {
    Message,
    MemoryCandidate,
} from './types';
import {
    matchAllIntents,
    MEMORY_COMMAND_KEYWORDS,
    CONFIRMATION_KEYWORDS,
    PSEUDO_MEMORY_PATTERNS,
    PREFERENCE_CONSTRAINT_PATTERNS
} from './MemoryIntentDictionary';
import { getLogger } from '@services/logger';

const logger = getLogger('MemoryCandidateScanner');

// ============================================================================
// 关键词配置
// ============================================================================

/** 确定性词汇 - 表示稳定事实的关键词 */
const CERTAINTY_KEYWORDS = [
    '一直', '总是', '从不', '永远', '必须', '绝对',
    'always', 'never', 'must', 'absolutely', 'definitely', 'certainly',
    'for sure', 'required', 'requirement', 'fixed', 'firm', 'every time',
    'from now on', 'always use', 'never use',
];


/** 模糊词汇 - 表示不稳定、需要过滤 */
const FUZZY_KEYWORDS = [
    '可能', '也许', '或许', '大概', '应该', '估计',
    '目前', '现在', '这次', '暂时', '临时', '今天', '这周',
    '试试', '看看', '考虑', '想想',
    'maybe', 'perhaps', 'probably', 'might', 'currently', 'now',
    'this time', 'today', 'this week', 'try', 'consider', 'for now',
    'temporarily', 'at the moment', 'right now', 'just this time',
    'I think', 'I guess', 'not sure', 'uncertain', 'tentative',
    'try out', 'test out', 'considering', 'might change', 'subject to change',
];

/** 情绪/临时状态词汇 */
const EMOTIONAL_KEYWORDS = [
    '烦', '累', '开心', '生气', '郁闷', '焦虑', '紧张',
    'annoyed', 'tired', 'happy', 'angry', 'frustrated', 'anxious',
    'upset', 'stressed', 'worried', 'nervous', 'overwhelmed', 'excited',
    'sad', 'mad', 'irritated',
];

// ============================================================================
// 扫描器类
// ============================================================================

/**
 * 候选扫描结果
 */
export interface ScanResult {
    /** 检测到的候选列表 */
    candidates: Omit<MemoryCandidate, 'id'>[];
    /** 是否检测到用户确认 */
    hasUserConfirmation: boolean;
}

/**
 * 候选记忆扫描器类
 */
export class MemoryCandidateScanner {
    private agentId: string;

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    /**
     * 扫描消息列表，提取候选事实
     * 
     * @param messages - 要扫描的消息列表（通常是最近 5-10 轮）
     * @returns 扫描结果
     */
    scan(messages: Message[]): ScanResult {
        const candidates: Omit<MemoryCandidate, 'id'>[] = [];

        logger.trace('[CandidateScanner]  开始扫描');
        logger.trace('[CandidateScanner] 消息数量:', messages.length);

        // 【两阶段扫描】第一阶段：检测整个消息批次中是否有用户确认
        let hasUserConfirmation = false;
        for (const msg of messages) {
            if (msg.role === 'user' && this.detectUserConfirmation(msg.content)) {
                hasUserConfirmation = true;
                logger.trace('[CandidateScanner]  预扫描检测到用户确认');
                break;
            }
        }

        // 第二阶段：扫描 user 消息的候选（使用已确定的确认状态）
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg) continue;
            if (msg.role !== 'user') continue;

            logger.trace('[CandidateScanner] 扫描用户消息:', msg.content.substring(0, 50));

            // 构建当前消息的上下文（当前 user + 紧跟的 assistant）
            const contextMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
                { role: 'user', content: msg.content },
            ];
            const nextMessage = messages[i + 1];
            if (nextMessage?.role === 'assistant') {
                contextMessages.push({ role: 'assistant', content: nextMessage.content });
            }

            const userCandidates = this.scanMessage(
                msg.content,
                msg.createdAt,
                false, // 不是 Agent 消息
                contextMessages,
                hasUserConfirmation // 传递整个批次的确认信号
            );
            if (userCandidates.length > 0) {
                logger.trace('[CandidateScanner] 用户消息匹配到', userCandidates.length, '个候选, userConfirmed:', hasUserConfirmation);
                userCandidates.forEach(c => logger.trace('  -', c.category, ':', c.content.substring(0, 50)));
            }
            candidates.push(...userCandidates);
        }

        // 去重：相同内容的候选合并
        const deduped = this.deduplicateCandidates(candidates);

        logger.trace('[CandidateScanner] 扫描完成: 总共', deduped.length, '个候选, 用户确认:', hasUserConfirmation);

        return {
            candidates: deduped,
            hasUserConfirmation,
        };
    }

    /**
     * 扫描单条消息
     * 
     * 使用意图词典进行匹配，支持关键词和正则两种方式
     * 
     * @param content - 消息内容
     * @param timestamp - 时间戳
     * @param isAgentMessage - 是否为 Agent 消息
     * @param contextMessages - 对话上下文（用于 LLM 提取时避免过度泛化）
     */
    private scanMessage(
        content: string,
        timestamp: number,
        isAgentMessage: boolean,
        contextMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
        sessionHasConfirmation?: boolean // 会话级确认信号
    ): Omit<MemoryCandidate, 'id'>[] {
        const candidates: Omit<MemoryCandidate, 'id'>[] = [];

        // 计算模糊度和情绪度（后续按候选类别差异化过滤）
        const fuzzyCount = this.countKeywords(content, FUZZY_KEYWORDS);
        const emotionalCount = this.countKeywords(content, EMOTIONAL_KEYWORDS);

        // 计算确定性得分
        const certaintyScore = this.countKeywords(content, CERTAINTY_KEYWORDS);

        // 使用意图词典进行匹配
        const intentMatches = matchAllIntents(content);

        // 根据消息来源过滤类别
        if (isAgentMessage) {
            return []; // Agent 消息不再扫描
        }

        for (const match of intentMatches) {
            // 类别感知的噪声过滤：interaction_signals 使用更宽松的阈值，
            // 因为"但其实我..."这类交互信号天然与模糊词共现，
            // 硬性拦截会系统性丢失高价值信号
            const isInteractionSignal = match.category === 'interaction_signals';
            const fuzzyThreshold = isInteractionSignal ? 5 : 3;
            const emotionalThreshold = isInteractionSignal ? 3 : 2;

            if (fuzzyCount >= fuzzyThreshold || emotionalCount >= emotionalThreshold) {
                continue;
            }

            // 提取包含匹配词的句子
            const sentence = this.extractSentenceContaining(content, match.matchedTerm);
            if (!sentence) continue;

            // 计算初始分数：确定性 + 置信度加成 - 模糊惩罚
            const baseScore = certaintyScore + Math.floor(match.confidence * 2) - fuzzyCount - emotionalCount;

            candidates.push({
                agentId: this.agentId,
                content: this.normalizeContent(sentence),
                category: match.category,
                occurrenceCount: 1,
                firstSeenAt: timestamp,
                lastSeenAt: timestamp,
                userConfirmed: sessionHasConfirmation ?? false, // 使用会话级确认信号
                score: baseScore,
                contextMessages, // 保存对话上下文
            });
        }

        return candidates;
    }

    /**
     * 提取包含指定词语的句子
     */
    private extractSentenceContaining(content: string, term: string): string | null {
        const index = content.toLowerCase().indexOf(term.toLowerCase());
        if (index === -1) return null;
        return this.extractSentence(content, index);
    }



    /**
     * 检测用户确认
     * 
     * 先排除伪记忆请求（疑问句、否定句等），再匹配：
     * - 确认关键词（如"对的"、"是的"）
     * - 记忆命令词（如"记住这个"）
     * - 偏好约束正则（如"请务必"、"请勿"）
     * - 确定性关键词（如"必须"、"绝对"）← 设计要求
     */
    private detectUserConfirmation(content: string): boolean {
        // 1. 过滤伪记忆请求
        for (const pattern of PSEUDO_MEMORY_PATTERNS) {
            if (pattern.test(content)) {
                logger.trace('[CandidateScanner] 检测到伪记忆请求，跳过:', content.substring(0, 30));
                return false;
            }
        }

        // 2. 匹配确认关键词或记忆命令关键词
        const lowerContent = content.toLowerCase();

        // 检查确认词
        const hasConfirmation = CONFIRMATION_KEYWORDS.some(keyword =>
            lowerContent.includes(keyword.toLowerCase())
        );

        // 检查记忆命令词
        const hasMemoryCommand = MEMORY_COMMAND_KEYWORDS.some(keyword =>
            lowerContent.includes(keyword.toLowerCase())
        );

        // 3. 检查偏好约束正则（如：请务必、请勿、以后请）
        const hasPreferenceConstraint = PREFERENCE_CONSTRAINT_PATTERNS.some(pattern =>
            pattern.test(content)
        );

        if (hasPreferenceConstraint) {
            logger.trace('[CandidateScanner] 检测到偏好约束表达:', content.substring(0, 40));
        }

        // 4. 检查确定性关键词（如"必须"、"绝对"、"永远"等）
        // 设计要求：确定性词汇表示用户对内容的强调/确认，应触发记忆
        const hasCertaintyKeyword = CERTAINTY_KEYWORDS.some(keyword =>
            lowerContent.includes(keyword.toLowerCase())
        );

        if (hasCertaintyKeyword) {
            logger.trace('[CandidateScanner] 检测到确定性关键词:', content.substring(0, 40));
        }

        return hasConfirmation || hasMemoryCommand || hasPreferenceConstraint || hasCertaintyKeyword;
    }

    /**
     * 统计关键词出现次数
     */
    private countKeywords(content: string, keywords: string[]): number {
        const lowerContent = content.toLowerCase();
        let count = 0;
        for (const keyword of keywords) {
            if (lowerContent.includes(keyword.toLowerCase())) {
                count++;
            }
        }
        return count;
    }



    /**
     * 提取匹配位置所在的句子
     */
    private extractSentence(content: string, index: number): string {
        // 向前找句子开始
        let start = index;
        while (start > 0 && !/[。！？.!?\n]/.test(content[start - 1] ?? '')) {
            start--;
        }

        // 向后找句子结束
        let end = index;
        while (end < content.length && !/[。！？.!?\n]/.test(content[end] ?? '')) {
            end++;
        }

        const sentence = content.slice(start, end + 1).trim();
        // 限制句子长度
        if (sentence.length > 100) {
            return sentence.slice(0, 100) + '...';
        }
        return sentence;
    }

    /**
     * 规范化内容（去除多余空白等）
     */
    private normalizeContent(content: string): string {
        return content
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 候选去重
     */
    private deduplicateCandidates(
        candidates: Omit<MemoryCandidate, 'id'>[]
    ): Omit<MemoryCandidate, 'id'>[] {
        const seen = new Map<string, Omit<MemoryCandidate, 'id'>>();

        for (const candidate of candidates) {
            const key = `${candidate.category}:${candidate.content}`;
            const existing = seen.get(key);

            if (existing) {
                // 合并：增加出现次数，更新最后出现时间，取最高分
                existing.occurrenceCount += 1;
                existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt);
                existing.score = Math.max(existing.score, candidate.score);
                existing.userConfirmed = existing.userConfirmed || candidate.userConfirmed;
            } else {
                seen.set(key, { ...candidate });
            }
        }

        return Array.from(seen.values());
    }
}

/**
 * 创建 MemoryCandidateScanner 实例
 */
export function createMemoryCandidateScanner(agentId: string): MemoryCandidateScanner {
    return new MemoryCandidateScanner(agentId);
}
