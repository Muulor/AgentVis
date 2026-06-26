/**
 * Memory System 类型定义
 */

/** 记忆层级 */
export type MemoryLayer = 'short_term' | 'summary' | 'fact';

/**
 * 事实类别
 * 
 * 设计原则：
 * - 稳定性 > 细节丰富度
 * - 事实 > 事件
 * - 可被多任务复用
 * 
 * 5 类通用用户事实 + 1 类系统经验事实
 * 
 * 注意：interaction_signals 是开放捕获通道，用于收纳前四类无法容纳的
 * 人机交互信号（隐含偏好、未解决张力、反复出现的模式等），
 * 判断标准是「值得记住」的直觉，而非归类逻辑。
 */
export type LongTermFactCategory =
    | 'identity_role'       // 身份/角色 - 职业、行业、角色（如"我是后端工程师"）
    | 'preference_style'    // 偏好/风格 - 输出偏好、决策风格（如"我喜欢简洁回复"）
    | 'long_term_goal'      // 长期目标/约束 - 方向性事实（如"我在准备系统设计面试"）
    | 'knowledge_level'     // 知识基线 - 已知什么、不需要解释什么（如"熟悉 TypeScript"）
    | 'interaction_signals' // 交互信号 - 不易归类但值得记住的人机交互模式（如反复表现出的隐含偏好、未决张力等）
    | 'task_experience';    // 任务经验 - SA 执行中的试错教训（如"Windows 下应用 findstr 而非 grep"）

/** 记忆实体 */
export interface Memory {
    id: string;
    agentId: string;
    layer: MemoryLayer;
    content: string;
    category?: LongTermFactCategory;
    importance?: number;
    sourceMessageIds?: string[];
    createdAt: number;
    updatedAt: number;
}

/** 消息实体（用于短期缓冲） */
export interface Message {
    id: string;
    agentId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: number;
}


/** 短期缓冲配置 */
export interface ShortTermBufferConfig {
    /** 窗口大小（user 消息数上限） */
    windowSize: number;
    /** 触发摘要的水位线阈值 */
    watermarkThreshold: number;
    /** 每次转换的批次大小比例 */
    batchSizeRatio: number;
}

/** 默认短期缓冲配置 */
export const DEFAULT_SHORT_TERM_CONFIG: ShortTermBufferConfig = {
    windowSize: 10,
    watermarkThreshold: 0.6,
    batchSizeRatio: 0.4,
};

/** 摘要记录 */
export interface SummaryRecord {
    id: string;
    agentId: string;
    content: string;
    /** 包含的消息 ID 列表 */
    sourceMessageIds: string[];
    /** @deprecated 旧版多级摘要字段；当前摘要状态通过 metadataJson 传递，不独立维护 */
    mergeLevel: number;
    createdAt: number;
}

/**
 * 事实记录
 * 
 * Layer 3 写入记忆阶段产生。confidence/evidenceCount/scope 主要服务提取与合并流程，
 * 当前事实表只持久化 content/category/importance/sourceMessageIds/时间字段。
 */
export interface FactRecord {
    id: string;
    agentId: string;
    /** 事实内容 */
    content: string;
    /** 事实类别 */
    category: LongTermFactCategory;
    /** 提取置信度 (0-1)，写入时映射为 importance，不独立持久化 */
    confidence: number;
    /** 实验证据计数：跨轮次重复出现的次数，当前不独立持久化 */
    evidenceCount: number;
    /** 最后验证时间，当前通过 updatedAt 表达，不独立持久化 */
    lastVerified: number;
    /** 实验影响范围：哪些能力会参考此事实，当前不独立持久化 */
    scope: string[];
    createdAt: number;
    updatedAt: number;
}

/** 记忆统计 */
export interface MemoryStats {
    shortTermCount: number;
    summaryCount: number;
    factCount: number;
    totalCount: number;
}

/**
 * 开放性问题（用于精准原文回溯）
 * 
 * 设计原则：
 * - 只保留「需要原文证据才能推进的未决问题」
 * - 每个问题必须能定位到原文范围
 * - 宁缺毋滥，没有就返回空数组
 */
export interface OpenQuestion {
    /** 问题本身（清晰、具体） */
    question: string;
    /** 主题范围（用于检索过滤）：retrieval_strategy / architecture / implementation / performance 等 */
    scope: string;
    /** 为什么必须回溯原文 */
    reason: string;
    /** 可能的轮次提示（软要求但高价值） */
    turnHint?: number[];
    /** 关键词定位 */
    keywords?: string[];
    /** 精准回溯证据片段（由 loadEvidenceSlices 填充） */
    evidenceSlices?: Array<{
        turnId: number;
        speaker: 'user' | 'assistant';
        content: string;
    }>;
}

/** 摘要生成结果（状态型） */
export interface SummaryResult {
    /** 高度概括当前对话状态的摘要 */
    summary: string;
    /** 关键状态点 */
    keyPoints: string[];
    /** 讨论主题（用于语义检索） */
    topics?: string[];
    /** 涉及的文件路径（用于语义检索） */
    mentionedFiles?: string[];

    // ==================== 状态字段 ====================

    /** 已确认的结论或决策（可直接作为事实引用） */
    confirmedDecisions?: string[];
    /** 待决问题（驱动精准原文回溯） */
    openQuestions?: OpenQuestion[];
    /** 已失效的观点（被否定、替代或不再适用） */
    invalidatedPoints?: string[];
}

/** LLM 服务接口（供 Memory System 使用） */
export interface LLMService {
    /** 生成文本 */
    generate(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

// ============================================================================
// 事实提取架构
// ============================================================================

/**
 * 候选事实记录
 * 
 * Layer 1 候选捕获阶段产生，存储在候选池中等待验证
 */
export interface MemoryCandidate {
    id: string;
    agentId: string;
    /** 事实内容（简洁陈述句） */
    content: string;
    /** 事实类别 */
    category: LongTermFactCategory;
    /** 出现次数 - 跨轮次累加 */
    occurrenceCount: number;
    /** 首次出现时间 */
    firstSeenAt: number;
    /** 最后出现时间 */
    lastSeenAt: number;
    /** 是否被用户确认（"对的"、"你记住这个"等） */
    userConfirmed: boolean;
    /** 稳定性打分 */
    score: number;
    /** 对话上下文（用于 LLM 提取时避免过度泛化） */
    contextMessages?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
}

/**
 * 稳定性验证结果
 */
export interface StabilityVerificationResult {
    /** 是否通过验证 */
    passed: boolean;
    /** 稳定性得分 (≥5 保留候选, ≥7 写入记忆) */
    score: number;
    /** 得分明细 */
    scoreBreakdown: {
        /** 跨多轮重复出现: +3 */
        repetition: number;
        /** 表达确定（无模糊词）: +2 */
        certainty: number;
        /** 影响决策路径: +2 */
        decisionImpact: number;
        /** 被用户确认: +3 */
        userConfirmation: number;
        /** 含临时/情绪/假设: -3 (偏好类可减免) */
        temporaryPenalty: number;
        /** 强上下文绑定: -2 */
        contextBoundPenalty: number;
        /** 偏好表达信号: +1 (仅 preference_style 类别) */
        preferenceSignal?: number;
        /** 交互信号基线加分: +2 (仅 interaction_signals 类别，弥补该类别无 CATEGORY_BONUS 的结构性劣势) */
        interactionSignal?: number;
    };
    /** 验证理由 */
    reason: string;
}

/**
 * Memory Extractor 输出结果
 * 
 * 支持新版 Prompt 的 candidate_fact 和 notes 字段
 */
export interface MemoryExtractorResult {
    /** 是否提取 */
    extract: boolean;
    /** 不提取时的原因 */
    reason?: string;
    /** 提取时的类别 */
    category?: LongTermFactCategory;
    /** 提取时的事实内容（旧版兼容） */
    memory?: string;
    /** 提取时的候选事实（新版 Prompt） */
    candidate_fact?: string;
    /** 置信度 (0-1) */
    confidence?: number;
    /** 稳定性说明（旧版） */
    evidence?: string;
    /** 稳定性说明（新版） */
    notes?: string;
    /** 影响范围（已废弃） */
    scope?: string[];
    /** 内部标记：API 调用失败（非 LLM 正常拒绝），候选应保留等待重试 */
    _apiError?: boolean;
}
