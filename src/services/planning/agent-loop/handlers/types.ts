/**
 * 状态处理器类型定义
 *
 * 定义处理器上下文和共享状态类型
 */

import type { AgentSession } from '../AgentSession';
import type { LoopGovernor } from '../LoopGovernor';
import type { AgentLoopCallbacks, TerminationReason } from '../types';
import type { DecisionMapper } from '../mappers/DecisionMapper';
import type { MasterBrainInputBuilder } from '../builders/MasterBrainInputBuilder';
import type { SubAgentDispatcher } from '../dispatchers/SubAgentDispatcher';
import type { MasterBrain } from '../../brain/MasterBrain';
import type { FSMTracer } from '../../observability/FSMTracer';
import type { IFSMEngine, FSMEvent, FSMContext, AgentServiceState } from '../../fsm/types';
import type {
  SubAgentSpec,
  CheckpointCallback,
  ExternalGuideSkillInfo,
  ExternalScriptSkillCatalogEntry,
  ExternalScriptSkillInfo,
  MbDecisionLogEntry,
} from '../../brain/types';

// ═══════════════════════════════════════════════════════════════
// 工具调用类型（从 AgentLoopFSMIntegration 提取）
// ═══════════════════════════════════════════════════════════════

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// 处理器配置
// ═══════════════════════════════════════════════════════════════

/**
 * 处理器只读配置
 */
export interface HandlerConfig {
  /** Agent ID */
  agentId: string;
  tokenContextId?: string;
  /** 最大迭代次数 */
  maxIterations: number;
  /** LLM 模型 ID */
  modelId?: string;
  /** LLM 提供商 ID */
  providerId?: string;
  /** 自定义 API 基址 URL */
  baseUrl?: string;
  /** 工作目录 */
  workdir?: string;
  /** Master Brain 专属规则 */
  mbAgentRules?: string;
  /** Sub-Agent 专属规则 */
  saAgentRules?: string;
  /**
   * 用户关联的外部项目路径（cwd 切换）
   *
   * 透传到 MasterBrainInputBuilder.build() 以注入 [PROJECT_CONTEXT] 区块。
   */
  projectPath?: string;
  /** User-visible sandbox permission mode propagated to MB/SA decision context. */
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
}

// ═══════════════════════════════════════════════════════════════
// 处理器依赖
// ═══════════════════════════════════════════════════════════════

/**
 * 处理器依赖注入
 */
export interface HandlerDependencies {
  /** MasterBrain 实例（Native 模式） */
  masterBrain: MasterBrain | null;
  /** 决策映射器 */
  decisionMapper: DecisionMapper;
  /** MasterBrain 输入构建器 */
  masterBrainInputBuilder: MasterBrainInputBuilder;
  /** SubAgent 派遣器 */
  subAgentDispatcher: SubAgentDispatcher;
  /** 循环治理器 */
  loopGovernor: LoopGovernor;
  /** FSM 追踪器 */
  tracer: FSMTracer;
  /** 会话实例 */
  session: AgentSession;
  /** 回调函数 */
  callbacks: AgentLoopCallbacks;
  /** FSM 引擎 */
  fsmEngine: IFSMEngine<AgentServiceState, FSMEvent>;

  /**
   * Checkpoint 回调工厂（可选，仅动态 Loop 模式使用）
   *
   * 创建 Checkpoint 回调，用于 SubAgent 循环执行时向 Master Brain 汇报进度
   *
   * @param spec - 完整的 Sub-Agent 规格（用于 Master Brain 理解任务全貌）
   */
  createCheckpointHandler?: (spec: SubAgentSpec) => CheckpointCallback;

  /**
   * 按查询文本语义检索 Guide 模式技能（可选）
   *
   * 用于 MB 决策后的二次技能检索：当用户输入（如"请继续"）
   * 未命中技能包触发词时，可用 MB 的 nextStep.task 再次检索
   */
  getExternalGuideSkills?: (query: string) => Promise<ExternalGuideSkillInfo[]>;

  /**
   * 按查询文本精确匹配 Script 模式技能（可选）
   */
  getExternalScriptSkills?: (query: string) => Promise<ExternalScriptSkillInfo[]>;

  /**
   * 获取所有已安装外部 Guide 技能的轻量目录（可选，静态全量）
   *
   * 供 MasterBrainInputBuilder 使用，确保 MB 始终知道已安装技能
   */
  getInstalledSkillCatalog?: () => Array<{ name: string; description: string }>;

  /**
   * 获取所有已安装外部 Script 技能的轻量目录（可选，静态全量）
   */
  getInstalledScriptSkillCatalog?: () => ExternalScriptSkillCatalogEntry[];

  /**
   * 保存任务经验到长期记忆（可选，由 MemoryService.saveTaskExperience 注入）
   *
   * SA 执行中的试错经验经 Agent Loop 提取后，通过此回调直写到记忆系统
   */
  saveTaskExperience?: (content: string) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 共享状态
// ═══════════════════════════════════════════════════════════════

/**
 * 跨处理器共享的可变状态
 *
 * 用于处理器之间传递信息，由 Orchestrator 同步回主类字段
 */
export interface HandlerSharedState {
  /** 终止原因（null 表示还未确定） */
  terminationReason: TerminationReason | null;
  /** 最后的 LLM 响应内容 */
  lastLLMContent: string;
  /** 待处理的 SubAgentSpec */
  pendingSubAgentSpec: SubAgentSpec | null;
  /** 上次操作是否有进展 */
  lastActionMadeProgress: boolean;
  /** 上次操作是否创建了子智能体 */
  lastActionSpawnedSubAgent: boolean;
  /** 当前正在处理的工具调用 */
  currentToolCalls: ToolCallInfo[];
  /** 取消标志 */
  cancelled: boolean;
  /** 外部中断信号（用于传递到 SubAgentRunner，实现即时中断） */
  abortSignal?: AbortSignal;
  /**
   * 当次决策检索到的外部 Guide 技能（MASTER_DECISION → DISPATCH 传递）
   *
   * 由 MasterBrainInputBuilder.build 动态检索，注入 MB Prompt；
   * 同时需要传递给 SubAgentDispatcher，使 SA 也能获得技能指南。
   */
  externalGuideSkills?: ExternalGuideSkillInfo[];
  /**
   * 当次命中的外部 Script 技能（MASTER_DECISION → DISPATCH 传递）
   *
   * 用于 SA prompt compact contract 注入与 external_skill_execute 授权兜底。
   */
  externalScriptSkills?: ExternalScriptSkillInfo[];
  /**
   * SA 派遣计数器（系统层重试限制）
   *
   * SA 失败/被终止时递增，超过 MAX_SPAWN_RETRIES 时系统强制 RESPOND_TO_USER。
   * 仅计入失败场景，SA 正常完成不累加。
   */
  spawnCount: number;
  /**
   * 用户上传的图片附件（MB 注入后保留，DISPATCH 时透传给 SA）
   *
   * camelCase 格式（mimeType），与 llm_chat_with_tools 的 ImageAttachment 一致
   */
  pendingImageAttachments?: Array<{ mimeType: string; data: string }>;
  /**
   * 图片附件持久化后的路径列表（保存在 workdir/attachments/ 下）
   *
   * SA 可通过这些路径引用图片（如 generate_image 的 ref_image_path）
   */
  savedAttachmentPaths?: string[];
  /**
   * 配对好的历史对话消息（含图片），注入 SA messages[] 首条任务指令之前
   *
   * 与 pendingImageAttachments 互斥：
   * - 当轮新图片 → 继续使用 pendingImageAttachments（挂到 initialUserMessage）
   * - 历史跨轮图片 → 使用本字段（配对模式，多条消息，各自携带对应图片）
   *
   * 由 AgentLoop 构建，经 FSMIntegration → SharedState → SubAgentDispatcher → SubAgentRunner 透传
   */
  pendingPairedHistoryMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    images?: Array<{ mimeType: string; data: string }>;
  }>;
  /**
   * 待写入的 SA 执行经验（由 handleDispatch SA 完成后提取，在 RESPOND_TO_USER 时写入）
   *
   * 整个 planning loop 生命周期内累积，最终在向用户响应时一次性写入
   */
  pendingExperiences: string[];
  /**
   * 记忆系统中的已有任务经验（MASTER_DECISION 阶段缓存，DISPATCH 传递给 SA）
   *
   * 由 MasterBrainInputBuilder.build() 获取 MemorySnapshot 时产生，
   * 缓存到 SharedState 避免 DISPATCH 重复查询。SA 用于避免重复报告同类经验。
   */
  taskExperiences: Array<{ content: string }>;
  /**
   * MB 最近一轮的决策 rationale（跨请求持久化用）
   *
   * 每轮 MASTER_DECISION 成功后更新。当系统因 SA 连续失败等原因非正常终止时，
   * 将此 rationale 嵌入写入 session 的 assistant 终止消息中。
   * 下一轮用户请求时，MB 通过 conversationHistory 自然获取上一轮的任务进展认知，
   * 避免从头开始规划。
   */
  lastMBRationale?: string;
  /**
   * MB 最近一轮 SPAWN_SUB_AGENT 时下发的 nextStep.task（同轮战略连续性）
   *
   * 仅在 decision === 'SPAWN_SUB_AGENT' 时更新，RESPOND_TO_USER 和降级决策不更新。
   * 注入 MB System Prompt 的 [LAST_MB_DECISION] 不可截断区块，
   * 使同一轮多 SA 串行场景中，MB 无需重新推导"我上次派遣了什么、接下来应该做什么"。
   */
  lastMBTask?: string;
  /**
   * 最近一次 SA 的执行观察摘要（跨请求持久化用）
   *
   * 每次 SA dispatch 完成后更新。非正常终止时与 lastMBRationale 一起嵌入终止消息，
   * 使下一轮 MB 知道失败 SA 在断点前的具体执行进展（如已创建哪些文件、已完成哪些步骤）。
   */
  lastSAObservations?: string;
  /**
   * 各次 SA 执行的简洁观测摘要列表（按派遣顺序累积）
   *
   * 每次 SA 完成后追加其 observations 的精简版本，
   * 在 MASTER_DECISION 阶段通过 MasterBrainInputBuilder 注入 MB Prompt 的 TASK_ARTIFACTS 区块，
   * 让 MB 知道每个 SA 具体发现了什么、得出了什么结论，避免重复派遣。
   * 截断策略：每条 observations 截取前 300 字符，总量由 token 预算控制。
   */
  saObservationsSummaries: Array<{ role: string; summary: string }>;
  /**
   * 强制终止内容锁定（handleDispatch spawnCount 终止专用）
   *
   * 当 handleDispatch 的 spawnCount 超限触发系统强制终止时，
   * 将终止消息保存在此字段。FSM 循环结束后统一收口点优先使用此内容
   * 替换 lastLLMContent，防止后续 handler 覆盖。
   */
  forceTerminationContent?: string;
  /**
   * MB 决策历史日志（同 run 内按派遣顺序累积，滑动窗口）
   *
   * 每次 SPAWN_SUB_AGENT 的 DISPATCH 完成后追加一条终态 entry。
   * 由 AgentLoopFSMIntegration.syncSharedState 同步到 MasterBrainInputBuilder，
   * 注入 MB Prompt [MB_DECISION_HISTORY] 区块，增强长任务决策连贯性。
   * run 开始时重置为空数组（reset() 中清空）。
   */
  mbDecisionLog: MbDecisionLogEntry[];
}

// ═══════════════════════════════════════════════════════════════
// 处理器上下文
// ═══════════════════════════════════════════════════════════════

/**
 * 处理器上下文
 *
 * 传递给每个状态处理器的完整上下文
 */
export interface HandlerContext {
  /** 只读配置 */
  config: HandlerConfig;
  /** 依赖注入 */
  dependencies: HandlerDependencies;
  /** 可变共享状态 */
  sharedState: HandlerSharedState;
}

// ═══════════════════════════════════════════════════════════════
// 处理器函数类型
// ═══════════════════════════════════════════════════════════════

/**
 * 状态处理器函数签名
 *
 * @param fsmContext FSM 上下文（当前状态信息）
 * @param handlerContext 处理器上下文（配置、依赖、共享状态）
 * @returns 下一个 FSM 事件
 */
export type StateHandlerFn = (
  fsmContext: FSMContext,
  handlerContext: HandlerContext
) => Promise<FSMEvent>;

/**
 * 状态处理器映射表
 */
export type StateHandlerMap = Partial<Record<AgentServiceState, StateHandlerFn>>;

// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建初始共享状态
 */
export function createInitialSharedState(): HandlerSharedState {
  return {
    terminationReason: null,
    lastLLMContent: '',
    pendingSubAgentSpec: null,
    lastActionMadeProgress: true,
    lastActionSpawnedSubAgent: false,
    currentToolCalls: [],
    cancelled: false,
    abortSignal: undefined,
    externalGuideSkills: undefined,
    externalScriptSkills: undefined,
    spawnCount: 0,
    pendingImageAttachments: undefined,
    savedAttachmentPaths: undefined,
    pendingPairedHistoryMessages: undefined,
    pendingExperiences: [],
    taskExperiences: [],
    lastMBRationale: undefined,
    lastMBTask: undefined,
    lastSAObservations: undefined,
    saObservationsSummaries: [],
    forceTerminationContent: undefined,
    mbDecisionLog: [],
  };
}
