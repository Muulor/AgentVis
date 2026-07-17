/**
 * Brain 系统类型定义
 *
 * Master Brain 输入输出契约、决策类型、风险评估等核心类型
 *
 * 设计原则：
 * - 记忆系统类型直接复用 services/memory 模块
 * - 决策输出严格遵循 JSON Schema 规范
 */

import type { LongTermFactCategory, OpenQuestion, Memory } from '../../memory/types';
import type {
  ExecutionContract,
  SkillDependencies,
  SkillNetworkMode,
} from '../skills/external/types';
import type { OutputLanguageHint } from '../../language/OutputLanguagePolicy';

// ═══════════════════════════════════════════════════════════════
// 记忆系统类型复用（re-export for convenience）
// ═══════════════════════════════════════════════════════════════

export type { LongTermFactCategory, OpenQuestion, Memory };

// ═══════════════════════════════════════════════════════════════
// Master Brain 输入契约
// ═══════════════════════════════════════════════════════════════

/**
 * 用户意图
 */
export interface UserIntent {
  /** 显式用户请求 */
  explicit: string;
  /**
   * 用户消息的原始发送时间（unix ms）
   *
   * 用于在 [USER_INTENT] 区块中渲染精确发送时间和相对时差，
   * 帮助 MB 在 SA 执行完成后被再次调用时区分"用户刚发的请求"和"SA 完成报告"。
   * 当 CURRENT_TIME 远晚于 sentAt 时，MB 可以推断 SA 已执行了一段时间。
   */
  sentAt?: number;
}

/**
 * RAG 检索证据
 */
export interface RAGEvidence {
  /** 来源标识 */
  source: string;
  /** 内容片段 */
  content: string;
  /** 相关性分数 (0-1) */
  relevance: number;
}

/**
 * 工具目录条目
 */
export interface ToolCatalogEntry {
  /** 工具名称 */
  name: string;
  /** 工具描述 (场景化描述) */
  description: string;
  /** 使用场景列表 (从 SKILL.md 提取) */
  whenToUse?: string[];
  /** 禁用场景列表 (从 SKILL.md 提取，安全边界信息) */
  whenNotToUse?: string[];
  /** 决策提示 (从 SKILL.md 提取，帮助 MB 设定 behaviorHint 和风险判断) */
  decisionHint?: string[];
  /** 参数 Schema */
  parameters?: Record<string, unknown>;
  /** 风险等级 */
  riskLevel?: 'low' | 'medium' | 'high';
}

/**
 * 记忆项（用于 MasterBrain 输入）
 *
 * 与 Memory 类型对齐，添加状态型摘要字段
 */
export interface MemoryItem {
  id: string;
  agentId: string;
  layer: 'short_term' | 'summary' | 'fact';
  content: string;
  category: LongTermFactCategory | null;
  /** 置信度：0-1 数值，≥0.7 高置信，0.4-0.7 中置信，<0.4 低置信 */
  importance: number | null;
  sourceMessageIds: string | null;
  createdAt: number;
  updatedAt: number;

  // ==================== 摘要状态字段（layer = 'summary' 时填充） ====================
  /** 已确认的结论或决策 */
  confirmedDecisions?: string[];
  /** 待决问题（驱动精准原文回溯） */
  openQuestions?: OpenQuestion[];
  /** 已失效的观点（避免模型幻觉旧状态） */
  invalidatedPoints?: string[];
}

/**
 * 记忆快照
 *
 * MasterBrain 的记忆输入契约
 */
export interface MemorySnapshot {
  /** 事实（layer = 'fact'） */
  facts: MemoryItem[];
  /** 状态型摘要（layer = 'summary'） */
  summaries: MemoryItem[];
  /** 按类别分组的事实 */
  factsByCategory: Record<LongTermFactCategory, MemoryItem[]>;
  /** 任务经验事实（独立于用户事实，避免混入用户画像渲染） */
  taskExperiences: MemoryItem[];
}

/**
 * MB 单轮决策日志条目
 *
 * 记录 MB 每次派遣 Sub-Agent 的决策推理链，
 * 积累为滑动窗口（最近 N 轮），注入 [MB_DECISION_HISTORY] 区块，
 * 使 MB 在长任务中能回溯完整的推理历史，避免决策漂移。
 *
 * 设计原则：entry 在 DISPATCH 完成后一次性写入终态，无需 'running' 过渡状态。
 * FSM 串行架构保证了在下一次 MB 调用之前，DISPATCH 必然已完成并更新状态。
 */
export interface MbDecisionLogEntry {
  /** 派遣轮次（从 1 开始，每次 SPAWN_SUB_AGENT 递增） */
  round: number;
  /** MB 的决策理由（精炼，通常 50-150 字） */
  rationale: string;
  /** 派遣给 SA 的具体任务指令（仅 SPAWN_SUB_AGENT 决策时有值） */
  task?: string;
  /**
   * SA 执行结果状态（写入时即为终态）
   *
   * - 'completed'：SA 正常完成且有实质进展（dispatchResult.madeProgress = true）
   * - 'failed'：SA 失败 / API 中断 / 用户取消 / Checkpoint 强制终止等
   */
  status: 'completed' | 'failed';
}

/**
 * WORKDIR 文件系统统计摘要（轻量，供 MB 感知 SA 执行进度）
 *
 * 设计原则：MB 作为决策者只需知道"有什么成果"和"规模如何"，
 * 不需要逐文件细节（完整文件列表由 SA 通过 TaskContext 获取）。
 * 控制在 ~200 tokens 以内，放入 P1 不可截断区域。
 */
export interface WorkdirSnapshot {
  /** 总文件数 */
  totalFiles: number;
  /** 文件扫描是否因预算限制提前停止 */
  scanTruncated?: boolean;
  /** 按扩展名分类统计（key=扩展名如".tsx"，value=文件数） */
  byExtension: Record<string, number>;
  /** 最近修改的文件（按修改时间降序，Top-5） */
  recentFiles: Array<{ name: string; size: string; modified: string }>;
}

/**
 * Master Brain 输入契约
 */
export interface MasterBrainInput {
  /** 用户意图 */
  userIntent: UserIntent;
  /** 从原始用户请求一次性解析出的输出语言提示，供 MB 与后续 SA 共享。 */
  outputLanguageHint?: OutputLanguageHint;
  /** Agent 名称（用于 Character Grounding Prompt） */
  agentName?: string;
  /** Agent 是否拥有自定义头像（用于 Character Grounding 中条件注入形象感知引导） */
  hasAvatar?: boolean;
  /** 记忆快照 */
  memory: MemorySnapshot;
  /** RAG 检索证据 */
  ragEvidence: RAGEvidence[];
  /** 工具目录 */
  toolCatalog: ToolCatalogEntry[];
  /**
   * 用户自定义角色规则（可选）
   *
   * 注意：这些规则的优先级低于 Prime Directive，
   * 不能覆盖 MasterBrain 的核心职责
   */
  agentRules?: string;
  /** 工作目录（Sub-Agent 的文件操作根目录） */
  workdir?: string;
  /** Sandbox runtime mode used to inject mode-specific decision constraints. */
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  /** 模型 ID（用于 prompt 预算计算） */
  modelId?: string;
  /**
   * 最近对话历史（防止决策漂移）
   *
   * 记忆系统的 summaries 由水位线触发生成，最近几轮对话可能未被摘要。
   * 注入最近 N 轮 user-assistant 对话作为短期上下文补充。
   */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>;

  /**
   * 已安装的外部技能目录（静态全量注入，仅 name + description）
   *
   * 确保 MB 始终知道所有已安装技能的存在，即使语义检索未命中。
   * MB 可根据此目录判断用户需求是否与某个技能相关，
   * 在 SPAWN_SUB_AGENT 的 nextStep.task 中引用技能名称，
   * 触发 SA dispatch 阶段的二次检索命中。
   */
  installedSkillCatalog?: Array<{ name: string; description: string }>;

  /**
   * 已安装的外部 Script 技能目录（静态全量注入，仅轻量元数据）
   *
   * 供 MB 识别 Script Skill 并派遣 SA 使用 external_skill_execute。
   */
  installedScriptSkillCatalog?: ExternalScriptSkillCatalogEntry[];

  /**
   * 外部 Guide 模式技能列表（动态检索命中，注入到 Master Brain Prompt）
   * 仅包含 SkillRetriever 语义检索命中的技能，携带 fullContent。
   */
  externalGuideSkills?: ExternalGuideSkillInfo[];

  /**
   * 外部 Script 模式技能列表（精确名称命中）
   *
   * 不直接注入 MB Prompt 的完整 contract；用于 DISPATCH 阶段传递给 SA。
   */
  externalScriptSkills?: ExternalScriptSkillInfo[];

  /**
   * 前序 SA 已产出的 Artifact 索引（跨 SA 中间成果概览）
   *
   * MB 通过此索引了解前序 SA 已完成的工作，
   * 在重新派遣时指引新 SA 跳过已完成步骤。
   */
  taskArtifactIndex?: Array<{
    key: string;
    toolName: string;
    sourceHint: string;
    estimatedTokens: number;
  }>;

  /**
   * 前序 SA 的推理结论摘要（按执行顺序排列）
   *
   * 让 MB 知道每个 SA 具体发现了什么、得出了什么结论，
   * 避免因不了解 SA 推理结果而重复派遣相同任务。
   * 每条摘要已截取前 300 字符，token 开销轻量。
   */
  taskArtifactObservations?: Array<{ role: string; summary: string }>;

  /**
   * 工作目录文件系统摘要（轻量统计，帮助 MB 感知 SA 执行进度）
   *
   * 包含总文件数、扩展名分类统计、最近修改 Top-5 文件。
   * 让 MB 在恢复决策时知道"SA 已经创建了 20+ 组件文件"，
   * 避免盲目重新派遣已完成的任务阶段。
   */
  workdirSnapshot?: WorkdirSnapshot;

  /**
   * 用户关联的外部项目路径（cwd 切换）
   *
   * 有值时 MasterBrainPrompt 渲染 [PROJECT_CONTEXT] 区块，
   * 告知 MB 当前 SA 的 cwd 已切换为项目目录。
   */
  projectPath?: string;

  /**
   * 原始交付物目录（仅在 projectPath 切换时有值）
   *
   * 保留原始 workdir 引用，让 MB 知道 Agent 自身的产出物存放位置，
   * 用于跨目录访问场景（如存放独立产出物到交付物目录）。
   */
  deliverableWorkdir?: string;

  /**
   * 上一轮 MB 的决策摘要（仅在同一轮 FSM 循环内有值，新 run 重置为 undefined）
   *
   * 注入 System Prompt 的 [LAST_MB_DECISION] 不可截断区块，
   * 让 MB 在多 SA 串行场景中保持战略连续性，
   * 无需从 TASK_ARTIFACTS 的 SA 步骤摘要中反推"我上一轮派遣了什么"。
   * - rationale：上一轮决策理由（battle plan 摘要）
   * - task：上一轮下发给 SA 的具体任务指令
   *
   * 注意：当 mbDecisionLog 存在时，Prompt 层优先使用 mbDecisionLog 渲染
   * [MB_DECISION_HISTORY] 多轮历史区块；lastMBDecision 作为兜底保持向后兼容。
   */
  lastMBDecision?: {
    rationale: string;
    task: string;
  };

  /**
   * 本次 run 内 MB 的决策历史日志（滑动窗口，最近 N 轮 SPAWN_SUB_AGENT 的推理链）
   *
   * 替代原单条 lastMBDecision，使 MB 在长任务中能回溯多轮决策推理链：
   * - 每轮 SPAWN_SUB_AGENT 完成 DISPATCH 后追加一条 entry（终态写入）
   * - 滑动窗口保留最近 N 轮（由 PlanningConstants.MB_DECISION_LOG_MAX_ROUNDS 控制）
   * - 注入 [MB_DECISION_HISTORY] 不可截断区块，带 status 标注帮助 MB 快速识别进度
   * - run 结束时通过 lastMBRationale/lastMBTask 跨请求持久化（与本字段独立，互不干扰）
   */
  mbDecisionLog?: MbDecisionLogEntry[];

  /**
   * 当前 run 内是否已有 SA 完成执行（即当前为 Round 2+ MB 决策）
   *
   * 为 true 时，[USER_INTENT] 不再渲染用户原始裸消息，改为中性决策引导，
   * 防止 MB 将历史消息视为刚收到的新请求（"上一轮SA已...但用户仍..."句式根源）。
   * 与 SA 原子循环「第 2 步起对用户原始消息脱敏」的设计对称——SA 的 system prompt
   * 只有任务描述，不含用户原始裸消息，MB Round 2+ 应遵循同样的脱敏原则。
   * 原始意图仍在 [CONVERSATION_HISTORY] 中可见，MB 不会失去上下文。
   */
  hasExecutedSA?: boolean;

  /**
   * MB 当前剩余决策预算（由 LoopGovernor 管理，通过 MasterBrainInputBuilder 注入）
   *
   * 仅在预算临近耗尽时注入（budgetRemaining <= MB_BUDGET_WARNING_THRESHOLD），
   * 其余时间为 undefined，不暴露给 LLM，避免频繁感知数字导致焦虑决策。
   * 由 AgentLoop.buildMbBudgetWarningMessage() 读取，生成 messages 末尾警告。
   */
  mbBudgetRemaining?: number;
}

/**
 * 外部 Guide 模式技能信息（用于 MasterBrain Prompt 注入）
 */
export interface ExternalGuideSkillInfo {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** SKILL.md 完整内容 */
  fullContent: string;
  /** 技能包的绝对路径（Guide+scripts 类技能需要此信息定位脚本） */
  packagePath?: string;
  /** 技能包内的脚本文件列表（相对于 packagePath，如 scripts/convert_pdf_to_images.py） */
  scriptFiles?: string[];
  /** 技能包内的资源文件列表（相对于 packagePath，如 themes/arctic-frost.md） */
  resourceFiles?: string[];
}

/**
 * 外部 Script 模式技能轻量目录项（用于 MasterBrain Prompt）
 */
export interface ExternalScriptSkillCatalogEntry {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 网络模式声明 */
  networkMode?: SkillNetworkMode;
  /** 普通网络权限声明 */
  network?: boolean;
  /** 是否声明桌面启动权限 */
  desktopLaunch?: boolean;
  /** 是否声明桌面控制权限 */
  desktopControl?: boolean;
}

/**
 * 外部 Script 模式技能信息（用于 SubAgent Prompt 注入和工具授权补全）
 */
export interface ExternalScriptSkillInfo {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能包的绝对路径 */
  packagePath: string;
  /** 执行契约 */
  contract: ExecutionContract;
  /** 依赖声明 */
  dependencies?: SkillDependencies;
}

// ═══════════════════════════════════════════════════════════════
// Master Brain 输出契约（决策）
// ═══════════════════════════════════════════════════════════════

/**
 * 风险评估
 */
export interface RiskAssessment {
  /** 风险等级 */
  level: 'low' | 'medium' | 'high';
  /** 可能出错的点 */
  notes: string;
}

/**
 * 子智能体规格
 */
export interface SubAgentSpec {
  /**
   * 行为提示（可选标签，仅影响 Prompt 语气，不限制工具权限）
   *
   * MasterBrain 可通过此字段提示 Sub-Agent 执行风格：
   * - 'careful': 操作前先确认，发现异常立即停止
   * - 'direct': 直接执行，无需反复确认
   * - undefined: 无特殊行为提示
   */
  behaviorHint?: 'careful' | 'direct';
  /** 单一职责描述 */
  role: string;
  /** 背景上下文摘要（可选） */
  contextSummary?: string;
  /** 从原始用户请求继承的输出语言提示；独立 SA 可省略并自行回退解析。 */
  outputLanguageHint?: OutputLanguageHint;
  /** 工具白名单 */
  allowedTools: string[];
  /** 终止条件（可选，系统从 task 自动衍生） */
  terminationCondition?: string;
  /**
   * [动态决策] Loop 配置
   *
   * 统一使用 DEFAULT_LOOP_CONFIG（高预算、无定期 checkpoint），
   * exec 命令安全由 ExecSafetyPolicy + 事件驱动 Checkpoint 保障。
   */
  loopConfig?: import('../sub-agents/types').SubAgentLoopConfig;

  /**
   * 是否注入用户对话历史到 SA 上下文（默认 false）
   *
   * - false/undefined：SA 仅通过 contextSummary 理解任务背景，聚焦当前阶段任务
   * - true：SA 接收完整用户对话历史，适用于需要理解多轮沟通细节的任务
   *   （如 PRD 制定、文档完善等需要参考用户讨论记录的场景）
   *
   * 默认不注入，避免 SA 因看到完整用户需求而越权执行多阶段任务
   */
  includeHistory?: boolean;
}

/**
 * 工具调用信息
 *
 * 描述 MB nextStep 中允许出现的工具调用协议。LLM 可能返回标准字段
 * tool/parameters，也可能返回 name/arguments/args 等兼容形态；
 * SubAgentSpecBuilder 负责在运行时做最终归一化。
 */
export interface ToolCallInfo {
  /** 标准工具名称 */
  tool?: string;
  /** 兼容字段：部分模型会用 name 表达工具名称 */
  name?: string;
  /** 标准工具参数 */
  parameters?: Record<string, unknown>;
  /** 兼容字段：部分模型会用 arguments 表达工具参数 */
  arguments?: Record<string, unknown>;
  /** 兼容字段：部分工具调用协议会用 args 表达工具参数 */
  args?: Record<string, unknown>;
}

/**
 * 决策下一步详情
 *
 * 这里描述 MasterBrain Prompt 的正式输出协议。运行时仍由
 * SubAgentSpecBuilder 保留更宽松的兼容解析，避免因为 LLM 字段变体
 * 导致原本可恢复的任务被拒绝。
 */
export interface DecisionNextStep {
  /** SPAWN_SUB_AGENT 的具体任务描述 */
  task?: string;
  /** 兼容字段：部分模型会用 description 表达任务描述 */
  description?: string;
  /** MB 显式授权的特殊/扩展工具；基础工具由系统自动补全 */
  tools?: string[];
  /** 兼容字段：单工具场景下的工具名称 */
  tool?: string;
  /** 自定义 SA 角色名 */
  role?: string;
  /** 行为风格提示 */
  behaviorHint?: SubAgentSpec['behaviorHint'];
  /** 是否注入用户对话历史到 SA 上下文 */
  includeHistory?: boolean | 'true' | 'false';
  /** 兼容字段：旧格式中 actionId 可表示工具名 */
  actionId?: string;
  /** 工具调用（支持 tool/name + parameters/arguments/args 变体） */
  toolCall?: ToolCallInfo;
  /** 兼容字段：与 tool 搭配的参数对象 */
  parameters?: Record<string, unknown>;
  /** 兼容字段：与 tool/actionId 搭配的参数对象 */
  arguments?: Record<string, unknown>;
  /** 兼容字段：旧格式中与 actionId 搭配的参数对象 */
  toolInput?: Record<string, unknown>;
  /** 兼容字段：exec 单命令快捷写法 */
  command?: string;
  /** 向用户提问（REQUEST_MORE_INPUT 时使用） */
  questionsForUser?: string | string[];
  /** 给用户的回复内容（RESPOND_TO_USER 的 MB wire protocol 字段） */
  response?: string;
}

// ═══════════════════════════════════════════════════════════════
// 决策类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * 决策类型枚举
 *
 * - SPAWN_SUB_AGENT：创建子智能体执行任务
 * - RESPOND_TO_USER：回复用户
 * - REQUEST_MORE_INPUT：请求更多信息
 */
export type DecisionType = 'SPAWN_SUB_AGENT' | 'REQUEST_MORE_INPUT' | 'RESPOND_TO_USER';

/**
 * 决策基础结构
 */
interface BaseDecision {
  /** 决策理由 */
  rationale: string;
  /** 风险评估 */
  riskAssessment: RiskAssessment;
  /** 下一步详情 */
  nextStep?: DecisionNextStep;
}

/**
 * 创建子智能体决策
 *
 * LLM 通过 nextStep.{task, tools} 提供决策性信息，
 * 由 SubAgentSpecBuilder JIT 构建完整 SubAgentSpec。
 */
export interface SpawnSubAgentDecision extends BaseDecision {
  decision: 'SPAWN_SUB_AGENT';
}

/**
 * 请求更多信息决策
 */
export interface RequestMoreInputDecision extends BaseDecision {
  decision: 'REQUEST_MORE_INPUT';
  /** 向用户提问 */
  questionsForUser: string[];
}

/**
 * 回复用户决策
 */
export interface RespondToUserDecision extends BaseDecision {
  decision: 'RESPOND_TO_USER';
  /** 给用户的回复内容 */
  response: string;
}

/**
 * Master Brain 决策联合类型
 */
export type MasterBrainDecision =
  | SpawnSubAgentDecision
  | RequestMoreInputDecision
  | RespondToUserDecision;

// ═══════════════════════════════════════════════════════════════
// Checkpoint 决策类型（Sub-Agent 动态决策机制）
// ═══════════════════════════════════════════════════════════════

/**
 * 延长预算决策
 *
 * Master Brain 判断 Sub-Agent 需要更多迭代时返回，
 * 授予额外预算继续执行。
 */
export interface ExtendBudgetDecision {
  type: 'EXTEND_BUDGET';
  /** 额外授予的迭代次数 */
  additionalIterations: number;
  /** 可选：调整指令 */
  refinedInstructions?: string;
  /** 决策理由 */
  reason: string;
}

/**
 * 调整策略决策
 *
 * Master Brain 判断 Sub-Agent 需要改变执行方向时返回，
 * 提供新的指令让 Sub-Agent 调整行为。
 */
export interface AdjustStrategyDecision {
  type: 'ADJUST_STRATEGY';
  /** 新的执行指令 */
  refinedInstructions: string;
  /** 是否同时延长预算 */
  additionalIterations?: number;
  /** 决策理由 */
  reason: string;
}

/**
 * 提前终止 Sub-Agent 决策
 *
 * Master Brain 判断已收集足够信息或任务无法完成时返回，
 * Sub-Agent 立即停止并返回已收集的结果。
 */
export interface TerminateSubAgentDecision {
  type: 'TERMINATE_SUB_AGENT';
  /** 终止原因 */
  reason: string;
}

/**
 * Checkpoint 决策联合类型
 *
 * Master Brain 对 Sub-Agent Checkpoint 的响应决策，
 * 决定 Sub-Agent 是否继续执行、如何调整策略、或提前终止。
 */
export type CheckpointDecision =
  | ExtendBudgetDecision
  | AdjustStrategyDecision
  | TerminateSubAgentDecision;

/**
 * Checkpoint 回调函数类型
 *
 * Sub-Agent 在达到 Checkpoint 时调用此回调，
 * 向 Master Brain 汇报进度并等待决策。
 *
 * @param report - Sub-Agent 的进度报告
 * @param spec - 完整的 Sub-Agent 规格（用于 Master Brain 理解任务全貌）
 */
export type CheckpointCallback = (
  report: import('../sub-agents/types').ProgressReport,
  spec: SubAgentSpec
) => Promise<CheckpointDecision>;

// ═══════════════════════════════════════════════════════════════
// 类型守卫
// ═══════════════════════════════════════════════════════════════

/** 有效的决策类型 */
const VALID_DECISION_TYPES: DecisionType[] = [
  'SPAWN_SUB_AGENT',
  'REQUEST_MORE_INPUT',
  'RESPOND_TO_USER',
];

/**
 * 检查是否为有效的决策类型
 */
export function isValidDecisionType(value: unknown): value is DecisionType {
  return typeof value === 'string' && (VALID_DECISION_TYPES as string[]).includes(value);
}

/**
 * 检查是否为 SpawnSubAgentDecision
 */
export function isSpawnSubAgentDecision(
  decision: MasterBrainDecision
): decision is SpawnSubAgentDecision {
  return decision.decision === 'SPAWN_SUB_AGENT';
}

// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建空的记忆快照
 */
export function createEmptyMemorySnapshot(): MemorySnapshot {
  return {
    facts: [],
    summaries: [],
    factsByCategory: {
      identity_role: [],
      preference_style: [],
      long_term_goal: [],
      knowledge_level: [],
      interaction_signals: [],
      task_experience: [],
    },
    taskExperiences: [],
  };
}

/**
 * 创建默认风险评估
 */
export function createDefaultRiskAssessment(): RiskAssessment {
  return {
    level: 'low',
    notes: '',
  };
}
