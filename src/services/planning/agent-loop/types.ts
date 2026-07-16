/**
 * AgentLoop 类型定义
 *
 * 定义 Agent Loop 执行所需的类型
 */

import type { ToolCall, ToolResult } from '../tools/types';
import type { SubAgentSpec, SubAgentOutput, TaskAttachmentReference } from '../sub-agents/types';
import type { AgentServiceState } from '../fsm/types';
import type { GovernorSnapshot } from './LoopGovernor';
import type { ReasoningPreset } from '@/config/modelRegistry';

// ==================== FSM 可视化类型 ====================

/**
 * 思维阶段类型
 *
 * 用于 FSM 可视化的三阶段展示
 */
export type ThinkingPhase = 'ANALYZING' | 'PLANNING' | 'DECIDED' | 'IDLE';

/**
 * 思维阶段事件
 *
 * 用于前端订阅 Master Brain 思考过程
 */
export interface ThinkingPhaseEvent {
  /** 事件类型 */
  type: 'START' | 'CONTENT' | 'COMPLETE';
  /** 当前阶段 */
  phase: ThinkingPhase;
  /** 阶段内容（CONTENT 类型时填充） */
  content?: string;
}

/**
 * Master Brain 推理内容流事件
 *
 * 用于展示模型 provider 返回的 reasoning_content，与结构化 Decision 流分离。
 */
export interface ReasoningTraceEvent {
  /** 事件类型 */
  type: 'START' | 'CONTENT' | 'COMPLETE';
  /** 当前用于 UI 展示的有界 reasoning_content 快照 */
  content?: string;
}

/**
 * Sub-Agent 单步观测事件
 *
 * 用于前端实时监控 Sub-Agent 的思考和行为
 * 每次工具调用产生一条记录，与 Sub-Agent 预算单位对齐
 */
export interface SubAgentObservationEvent {
  /** Stable namespace for one Sub-Agent dispatch/run. Prevents step/tool IDs from colliding across runs. */
  runId?: string;
  /** LLM 文字输出（思考/推理/总结） */
  thinking: string;
  /** UI-only provider reasoning trace, streamed before the structured Sub-Agent decision content is ready. */
  reasoningTrace?: {
    content: string;
    isStreaming?: boolean;
    completed?: boolean;
  };
  /** Ephemeral status event that may be replaced by the real observation for the same step. */
  transient?: boolean;
  /** 工具行为（为空表示纯文本步骤） */
  toolAction?: {
    /** Stable ID for updating the same tool row from pending to final state */
    toolCallId?: string;
    /** 工具名：read | file_write | exec | web_search */
    tool: string;
    /** 目标：文件名、命令摘要、搜索词 */
    target: string;
    /** 完整目标内容：用于 UI 按需展开查看，不参与紧凑摘要展示 */
    fullTarget?: string;
    /** 结构化工作目录：主要用于 exec，不直接参与 UI target 展示 */
    workdir?: string;
    /** 显式传入 exec 的 timeout 秒数；默认 timeout 不展示 */
    timeoutSeconds?: number;
    /** 执行结果 */
    success?: boolean;
  };
  /** Sub-Agent 最终输出文本（仅在任务完成时携带） */
  result?: string;
  /** LLM 调用轮次序号（从1开始），用于 UI 按步骤分组 */
  step?: number;
  /** 时间戳 */
  timestamp: number;
}

// ==================== 会话消息类型 ====================

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 会话消息
 */
export interface AgentMessage {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 工具调用（assistant 消息可能包含） */
  toolCalls?: ToolCall[];
  /** 工具调用 ID（tool 消息必须包含） */
  toolCallId?: string;
  /** 工具名称（tool 消息必须包含） */
  toolName?: string;
  /** 图片附件（user/assistant 消息可携带，用于多模态对话历史恢复） */
  images?: Array<{ mime_type: string; data: string }>;
  /** 消息创建时间戳（Unix ms），用于对话历史时间感知 */
  createdAt?: number;
}

// ==================== 循环状态类型 ====================

/**
 * 循环状态
 */
export type LoopState =
  | 'idle' // 空闲
  | 'running' // 运行中
  | 'awaiting_tool' // 等待工具执行
  | 'completed' // 完成
  | 'error' // 错误
  | 'cancelled'; // 已取消

/**
 * 循环终止原因
 */
export type TerminationReason =
  | 'text_response' // LLM 返回文本响应
  | 'max_iterations' // 达到最大迭代次数
  | 'error' // 发生错误
  | 'cancelled' // 用户取消
  | 'budget_exhausted' // Token 预算耗尽
  | 'awaiting_interaction'; // 等待用户交互（如 Diff 确认）

// ==================== 循环配置类型 ====================

/**
 * AgentLoop 配置
 */
export interface AgentLoopConfig {
  /** Agent ID */
  agentId?: string;
  tokenContextId?: string;
  /** Agent 名称 */
  agentName?: string;
  /** Master Brain 专属规则 */
  mbAgentRules?: string;
  /** Sub-Agent 专属规则 */
  saAgentRules?: string;
  /** LLM Provider ID */
  providerId?: string;
  /** 模型 ID */
  modelId?: string;
  /** AgentVis 统一推理档位。 */
  reasoningPreset?: ReasoningPreset;
  /** 工作目录 */
  workdir?: string;
  /** 自定义 API 基址 URL（用于 Local 代理） */
  baseUrl?: string;
  /** 最大迭代次数（默认 20） */
  maxIterations?: number;
  /** Token 预算 */
  tokenBudget?: number;
  /** 用户上传的图片附件（仅首轮 LLM 调用注入，后续迭代不重复发送） */
  imageAttachments?: Array<{ mime_type: string; data: string }>;
  /** 用户本轮上传的附件路径清单，注入 Sub-Agent TaskContext */
  attachmentReferences?: TaskAttachmentReference[];
  /**
   * Agent 头像 base64 数据（用于身份形象感知注入）
   *
   * 在 MB System Prompt 后以合成 user 消息方式注入，
   * 让 LLM "看到"自己的形象，增强社交互动场景的体验。
   * 格式：纯 base64 字符串（不含 data URL 前缀），MIME 默认 image/webp
   */
  agentAvatar?: string;
  /**
   * 绑定技能列表
   *
   * 配置后跳过语义检索，直接按名称加载绑定技能的 fullContent。
   * 同时 MB 不加载 installedSkillCatalog，全局技能开关对此 Agent 无效。
   */
  pinnedSkills?: string[];
  /**
   * MB 最大决策轮次（per-agent 覆盖）
   *
   * 来自 Agent 设置中的 planningLoopBudget 字段，undefined 时
   * 由 AgentLoopFSMIntegration 回退到 LOOP_GOVERNOR_INITIAL_BUDGET 全局默认值。
   */
  mbDecisionBudget?: number;
  /**
   * 当前触发此任务的 IM Bot ID
   *
   * 由 ImTaskBridge 在 cron:execute_planning 事件中携带，经由
   * AgentChatView → usePlanningMode → AgentService → AgentLoop 层层透传，
   * 最终注入到 ToolExecutionContext.imBotId，供 im_send 等工具
   * 精确定位当前机器人，实现多 Bot 并行时的路由隔离。
   *
   * 非 IM 触发的任务（用户直接在 UI 中对话）此字段为 undefined。
   */
  imBotId?: string;
  /**
   * 用户关联的外部项目路径（cwd 切换）
   *
   * 用户在授权弹窗确认后 Agent 具有该目录的全权限：
   * - SA 的 cwd 切换为 projectPath（exec 命令在正确目录执行）
   * - file_write 守卫扩展允许写入 projectPath 范围内的文件
   * - MB 注入 [PROJECT_CONTEXT] 区块
   */
  projectPath?: string;
  /** 用户可见的三档沙箱权限。 */
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  /** 是否启用 Sub-Agent 每步 Safety Footer 热区提示词。 */
  subAgentSafetyFooterEnabled?: boolean;
  /** Sub-Agent Safety Footer 的自定义提示词文本。 */
  subAgentSafetyFooterText?: string;
}

/**
 * 循环事件回调
 */
export interface AgentLoopCallbacks {
  /** 状态变更 */
  onStateChange?: (state: LoopState) => void;
  /** 消息新增 */
  onMessage?: (message: AgentMessage) => void;
  /** 工具调用开始 */
  onToolCallStart?: (toolCall: ToolCall) => void;
  /** 工具调用完成 */
  onToolCallEnd?: (toolCall: ToolCall, result: ToolResult) => void;
  /** 进度更新 */
  onProgress?: (message: string) => void;
  /** 授权请求 */
  onRequestAuthorization?: (operation: string, target: string) => Promise<boolean>;
  /** 错误发生 */
  onError?: (error: Error) => void;

  // ═══ FSM 扩展回调 ═══

  /** 思维链步骤（OODA 可视化） */
  onThought?: (step: ThoughtStep) => void;
  /** 预算更新 */
  onBudgetUpdate?: (remaining: number, total: number) => void;
  /** 风险更新 */
  onRiskUpdate?: (score: number, threshold: number) => void;

  // ═══ FSM 可视化回调 ═══

  /** FSM 状态变更 */
  onFSMStateChange?: (from: AgentServiceState, to: AgentServiceState) => void;
  /** 治理器指标更新（budget, risk, progress） */
  onMetricsUpdate?: (snapshot: GovernorSnapshot) => void;
  /** 思维阶段事件（用于混合思维链展示） */
  onThinkingPhase?: (event: ThinkingPhaseEvent) => void;
  /** Master Brain provider reasoning_content 流事件 */
  onReasoningTrace?: (event: ReasoningTraceEvent) => void;
  /** Master Brain RESPOND_TO_USER.response 字段的累积流快照 */
  onResponseStream?: (accumulatedContent: string) => void;

  // ═══ Sub-Agent 生命周期回调 ═══

  /** Sub-Agent 创建 */
  onSubAgentSpawn?: (spec: SubAgentSpec) => void;
  /** Sub-Agent 完成 */
  onSubAgentComplete?: (id: string, output: SubAgentOutput) => void;
  /** Sub-Agent 失败 */
  onSubAgentFail?: (id: string, error: string) => void;
  /** Sub-Agent 产生的 Diff 数据（file_write 工具执行后触发） */
  onDiffData?: (diffData: {
    filePath: string;
    originalContent: string;
    newContent: string;
    xml: string;
    batchResult?: unknown;
  }) => void;
  /** Sub-Agent 实时观测（每个执行步骤触发，用于前端实时展示行为） */
  onSubAgentObservation?: (event: SubAgentObservationEvent) => void;
}

/**
 * 思维链步骤（用于 OODA 可视化）
 */
export interface ThoughtStep {
  /** 步骤类型 */
  phase: 'observe' | 'orient' | 'decide' | 'act';
  /** 步骤内容 */
  content: string;
  /** 时间戳 */
  timestamp: Date;
}

// ==================== 循环结果类型 ====================

/**
 * AgentLoop 执行结果
 */
export interface AgentLoopResult {
  /** 是否成功 */
  success: boolean;
  /** UI 展示用的最终响应内容（已剥离跨请求持久化上下文） */
  content: string;
  /** 数据库持久化用的完整内容（含 rationale + SA observations，供下轮 MB 读取） */
  persistContent: string;
  /** 终止原因 */
  terminationReason: TerminationReason;
  /** 迭代次数 */
  iterationCount: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 消息历史 */
  messages: AgentMessage[];
  /** 错误信息（如果有） */
  error?: string;
  /** SA 通过 generate_image 工具生成的图片本地路径列表（供 UI 内联展示） */
  generatedImages?: string[];
}

// ==================== LLM 请求/响应类型 ====================

/**
 * LLM 请求（带工具）
 */
export interface LLMRequestWithTools {
  /** 消息列表 */
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }>;
  /** 模型 ID */
  modelId?: string;
  /** Provider ID */
  providerId?: string;
  /** 自定义 API 基址 URL（用于 Local 代理） */
  baseUrl?: string;
  /** 工具定义（Gemini functionDeclarations 格式） */
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

/**
 * LLM 响应（带工具调用）
 */
export interface LLMResponseWithTools {
  /** 响应类型 */
  type: 'text' | 'tool_use' | 'error';
  /** 文本内容（如果是 text 类型） */
  content?: string;
  /** 工具调用列表（如果是 tool_use 类型） */
  toolCalls?: ToolCall[];
  /** 错误信息（如果是 error 类型） */
  error?: string;
  /** Provider 返回的完成原因（如 stop、length、max_tokens、MAX_TOKENS） */
  finishReason?: string;
  /** Provider 返回的输入 token 数。 */
  inputTokens?: number;
  /** Provider 返回的输出 token 数。 */
  outputTokens?: number;
  /** Provider 返回的推理内容（若可用）。 */
  reasoningContent?: string;
}
