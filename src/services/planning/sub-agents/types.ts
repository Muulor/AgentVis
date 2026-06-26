/**
 * Sub-Agent 系统类型定义
 *
 * 子智能体核心类型，用于工厂、执行器、验证器
 *
 * 设计原则：
 * - Sub-Agent 是通用执行单元，由 MasterBrain 动态授权工具
 * - 不区分 research/execution/verification 分类
 * - 输出采用统一扁平接口
 * - 失败是 observation，不是 exception
 */

import { PLANNING_CONSTANTS } from '../PlanningConstants';


// ═══════════════════════════════════════════════════════════════
// Sub-Agent 状态
// ═══════════════════════════════════════════════════════════════

/**
 * 子智能体状态
 */
export type SubAgentStatus = 'completed' | 'failed';

// ═══════════════════════════════════════════════════════════════
// 任务上下文
// ═══════════════════════════════════════════════════════════════

/**
 * 工作目录文件信息（方案 B：文件名 + 大小 + 修改时间）
 *
 * 让 SA 在启动时感知 cwd 下已有哪些文件，
 * 避免文件名冲突、重复工作和浪费工具调用
 */
export interface WorkdirFileInfo {
    /** 文件名（相对于 cwd） */
    name: string;
    /** 文件大小（人类可读格式，如 "4.2KB"） */
    size: string;
    /** 最后修改时间（YYYY-MM-DD HH:MM 格式） */
    modified: string;
}

export interface TaskAttachmentReference {
    /** 原始附件文件名 */
    fileName: string;
    /** 本地绝对路径，通常位于 cwd/attachments 下 */
    path: string;
    /** 附件类型 */
    type: 'document' | 'image';
    /** 文件扩展名（小写，不含点号） */
    extension: string;
    /** 文件大小（字节） */
    sizeBytes?: number;
}

/**
 * 任务上下文（隔离的最小必要信息）
 *
 * 注意：不包含敏感信息（用户ID、全局目标等）
 */
export interface TaskContext {
    /** 工作目录下的已有文件列表（最新 N 个，按修改时间降序，SA 启动时自动扫描） */
    files?: WorkdirFileInfo[];
    /**
     * 工作目录过滤后的真实总文件数（含被截断的文件）
     *
     * 配合 files 字段让 SA 感知项目规模：
     * 当 totalFileCount > files.length 时，SA 能判断当前展示的只是最近活跃的文件子集。
     */
    totalFileCount?: number;
    /** 工作目录扫描是否因文件数或时间预算被截断 */
    workdirScanTruncated?: boolean;
    /** 工作目录（SubAgent 执行工具时的根目录） */
    cwd?: string;
    /** 用户本轮上传的附件路径清单，供 Sub-Agent 使用 read/搜索/图片引用工具按需查看 */
    attachments?: TaskAttachmentReference[];
    /** 附件读取提示 */
    attachmentInstruction?: string;
    /** 当前运行时沙箱模式；仅用于给 Sub-Agent 注入运行边界提示，不写入普通上下文 JSON */
    sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
    /** 任务特定数据 */
    data?: Record<string, unknown>;
    /** 模型上下文窗口大小 (tokens)，用于 SA 内部的压缩/重置阈值计算 */
    contextWindowSize?: number;
}



// ═══════════════════════════════════════════════════════════════
// 输出类型
// ═══════════════════════════════════════════════════════════════

/**
 * file_write 工具返回的 Diff 记录
 *
 * 在 Sub-Agent 原子事件循环中收集，传递给 UI 层渲染 Diff 面板
 */
export interface FileWriteDiffRecord {
    /** Diff 数据类型 */
    type: 'file_write_create' | 'file_write_overwrite' | 'file_write_merge' | 'file_write_patch';
    /** 目标文件路径 */
    filePath: string;
    /** 原始内容（新文件为空字符串） */
    originalContent?: string;
    /** 新内容 */
    newContent?: string;
    /** Diff 结果对象 */
    diff?: unknown;
    /** XML 修改协议（由 DiffToXmlConverter 生成，与 edit 工具格式一致） */
    xml?: string;
    /** 差异比例 */
    changeRatio?: number;
    /** 写入字节数（create 模式） */
    bytesWritten?: number;
    /** 修改数量（merge 模式） */
    modificationCount?: number;
}

/**
 * Sub-Agent 统一输出接口
 *
 * 不再区分 research/execution/verification，采用扁平结构。
 * MasterBrain 动态决定工具授权，输出结构统一。
 */
export interface SubAgentOutput {
    /** 执行状态 */
    status: SubAgentStatus;
    /** 输出是否通过 Schema 验证 */
    outputValid: boolean;
    /** 观察结果描述 */
    observations: string;
    /** 不确定性变化量（负值 = 降低不确定性） */
    uncertaintyDelta: number;
    /** 错误信息（如有） */
    error?: string;
    /** 是否需要用户交互（如 Diff 确认、授权请求等） */
    requiresInteraction?: boolean;
    /** 本次执行中的工具调用记录（可选） */
    toolCalls?: string[];
    /** 执行效果描述（可选） */
    observedEffects?: string;
    /** 执行状态细节（可选） */
    executionStatus?: 'success' | 'failure';
    /** 工具执行过程中收集到的 Diff 数据列表（file_write 产生） */
    diffDataList?: FileWriteDiffRecord[];

    /**
     * SA 每步的详细观测事件（thinking + 工具动作）
     *
     * 由 SubAgentRunner 在原子事件循环中收集，按执行顺序排列。
     * StateHandlers 将其序列化为紧凑文本注入 MB 的 TASK_ARTIFACTS，
     * 让 MB 了解 SA 具体的推理链和行动轨迹（尤其是 SA 因网络中断时）。
     */
    observationEvents?: Array<{
        /** Stable namespace for one Sub-Agent dispatch/run */
        runId?: string;
        /** LLM 推理文字（截取前 150 字符） */
        thinking: string;
        /** 工具行为（为空表示纯文本推理步骤） */
        toolAction?: {
            /** Stable ID for updating the same tool row from pending to final state */
            toolCallId?: string;
            tool: string;
            target: string;
            /** 结构化工作目录：主要用于 exec，不直接参与 UI target 展示 */
            workdir?: string;
            success?: boolean;
        };
        /** 步骤序号 */
        step?: number;
    }>;
}

// ═══════════════════════════════════════════════════════════════
// Loop 配置与进度报告（动态决策机制）
// ═══════════════════════════════════════════════════════════════

/**
 * Sub-Agent Loop 配置（v2 动态决策版）
 *
 * 控制 Sub-Agent 循环执行的行为，包括：
 * - 初始预算和 Checkpoint 间隔
 * - 硬性上限（熔断机制）
 * - 终止信号检测
 */
export interface SubAgentLoopConfig {
    /** 初始迭代预算（Master Brain 评估任务复杂度后设定） */
    initialBudget: number;

    /** 每隔多少步向 Master Brain 汇报（Checkpoint），设为 maxSteps + 1 表示不触发 */
    checkpointInterval: number;

    /** 步数上限（主预算，一步 = 一次 LLM 决策/工具执行轮，并行工具调用只算 1 步） */
    maxSteps: number;

    /** 终止信号模式（LLM 输出匹配任一则停止） */
    terminationPatterns: string[];

    /** 单轮最大 Token 消耗（可选） */
    maxTokensPerIteration?: number;
}

/**
 * 默认 Loop 配置
 */
export const DEFAULT_LOOP_CONFIG: SubAgentLoopConfig = {
    initialBudget: 3,
    // 默认不触发定期 Checkpoint（maxSteps + 1 确保 modulo 永远不命中）
    // 安全保障由高风险前置 Checkpoint + 连续失败检测覆盖
    checkpointInterval: PLANNING_CONSTANTS.SUB_AGENT_DEFAULT_MAX_STEPS + 1,
    maxSteps: PLANNING_CONSTANTS.SUB_AGENT_DEFAULT_MAX_STEPS,
    terminationPatterns: [
        'TASK_COMPLETE',
    ],
};

/**
 * Sub-Agent 进度报告（Checkpoint 时发送给 Master Brain）
 *
 * 包含执行状态、已收集信息摘要、置信度评估等，
 * 供 Master Brain 决策是否继续、调整策略或终止。
 */
export interface ProgressReport {
    /** Sub-Agent 唯一标识 */
    subAgentId: string;

    /** 已执行轮次 */
    completedIterations: number;

    /** 剩余预算 */
    remainingBudget: number;

    /** 已收集信息摘要 */
    collectedObservations: string;

    /** Sub-Agent 自评置信度（0-1） */
    confidenceLevel: number;

    /** Sub-Agent 判断是否需要更多迭代 */
    needsMoreIterations: boolean;

    /** 请求的额外预算（可选） */
    requestedAdditionalBudget?: number;

    /** 遇到的问题或障碍（可选） */
    blockers?: string;

    /** Checkpoint 触发类型（帮助 MB 理解当前 Checkpoint 的场景） */
    checkpointTrigger?:
        | 'high_risk_pre_execution'
        | 'periodic'
        | 'consecutive_failures'
        | 'budget_near_exhaustion';

    /**
     * 即将执行的高风险操作详情（仅 high_risk_pre_execution 时填充）
     *
     * 包含工具名和完整命令参数，帮助 MB 判断该操作是否是任务核心目标。
     * 关键语义：此操作尚未执行，SA 正在等待 MB 批准。
     */
    pendingHighRiskAction?: string;
}

/**
 * 累积消息（多轮上下文）
 *
 * 用于在循环执行中累积每轮的 LLM 响应和工具结果
 */
export interface AccumulatedMessage {
    /** 消息角色 */
    role: 'assistant' | 'tool' | 'model'; // 修正 role 类型以匹配实际 usage

    /** 消息内容 */
    content: string;

    /** 工具名称（tool 角色时填充） */
    toolName?: string;

    /** 工具调用参数（model 角色时填充，含可选 id/signature 用于 provider tool_result 匹配） */
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string; thoughtSignature?: string }>;

    /** 工具调用 ID（tool 角色时填充，用于 Gemini functionResponse 匹配） */
    toolCallId?: string;

    /** 图片附件（tool 角色时可填充，用于多模态 tool_result） */
    images?: Array<{ mimeType: string; data: string }>;

    /** 视觉 fallback 时优先保留此消息上的图片（例如当前轮用户附件） */
    preserveImagesOnVisionFallback?: boolean;

    /** 思考内容（DeepSeek 思考模式专用，工具调用场景需回传 API） */
    reasoningContent?: string;

    /** 时间戳 */
    timestamp: number;
}


// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建失败输出
 *
 * @param error - 错误信息
 */
export function createFailedOutput(error: string): SubAgentOutput {
    return {
        status: 'failed',
        outputValid: false,
        observations: '',
        uncertaintyDelta: 0,
        error,
    };
}

// ═══════════════════════════════════════════════════════════════
// Re-export（便于外部模块统一从 sub-agents/types 导入）
// ═══════════════════════════════════════════════════════════════

export type { SubAgentSpec } from '../brain/types';
