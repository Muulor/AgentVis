/**
 * Task Artifact 类型定义
 *
 * Artifact 是跨 SA 生命周期的结构化中间成果。
 * 当 SA 因外部错误（API 中断、网络超时等）被迫终止时，
 * 已完成的工具调用结果通过 Artifact 持久化，
 * 确保 MB 重新派遣的新 SA 能复用这些数据，避免重复操作。
 *
 * 设计原则：
 * - 纯内存实现，生命周期与单次 FSM 任务执行绑定
 * - Token 预算控制，避免无限膨胀
 * - 系统层自动提取，不依赖 LLM 的自觉性
 */

// ═══════════════════════════════════════════════════════════════
// Artifact 数据类型
// ═══════════════════════════════════════════════════════════════

/**
 * Artifact 数据分类
 *
 * 帮助后续 SA 和 MB 理解如何使用该 Artifact
 */
export type ArtifactDataType =
    | 'search_results'   // web_search 工具的搜索结果
    | 'file_content'     // read 工具读取的文件内容
    | 'execution_output' // exec 工具的命令输出
    | 'file_operation'   // file_write 工具的写入记录
    | 'user_intervention' // 用户 HITL 介入调整指令（Human-in-the-Loop）
    | 'custom';          // 未来扩展

/**
 * 单条 Artifact 条目
 */
export interface TaskArtifact {
    /** 语义标识（系统自动生成，如 'search_0', 'read_1'） */
    key: string;
    /** 数据类型提示 */
    dataType: ArtifactDataType;
    /** 结构化内容（工具调用的原始结果文本） */
    content: string;
    /** 写入者标识（SA 实例 ID 或 role 名） */
    createdBy: string;
    /** 创建时间戳 */
    createdAt: number;
    /** 预估 token 数（用于上下文窗口预算控制） */
    estimatedTokens: number;
    /** 来源工具名 */
    toolName: string;
    /** 来源参数摘要（如搜索 query、文件路径） */
    sourceHint: string;
}

/**
 * Artifact Store 快照（注入 SA/MB 时使用的精简视图）
 */
export interface TaskArtifactSnapshot {
    /** 所有 Artifact 的索引摘要 */
    index: ArtifactIndexEntry[];
    /** 注入的 Artifact 完整内容（受 token 预算限制，可能不包含全部） */
    artifacts: TaskArtifact[];
    /** 总 token 数 */
    totalTokens: number;
}

/**
 * Artifact 索引条目（轻量，用于 MB Prompt 展示概览）
 */
export interface ArtifactIndexEntry {
    key: string;
    dataType: ArtifactDataType;
    toolName: string;
    sourceHint: string;
    estimatedTokens: number;
}
