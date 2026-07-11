/**
 * Planning 模块常量配置
 *
 * 集中管理 Planning 模块中的硬编码值
 *
 */

// ==================== 常量定义 ====================

/**
 * Planning 模块常量
 */
export const PLANNING_CONSTANTS = {
  // ==================== 基础工具 ====================

  /**
   * 基础工具列表（SA 默认注入，无需 MB 授权）
   *
   * 这些工具是 SA 执行任何任务的基础能力，由 SubAgentSpecBuilder 自动补全到 allowedTools：
   * - read: 文件/目录读取
   * - local_search: 文本搜索/文件查找/代码结构分析
   * - web_search: 网络搜索
   * - exec: Shell 命令执行（安全由 ExecSafetyPolicy + Rust command_validator 多层保障）
   * - file_write: 统一文件写入（Checkpoint 机制仍在高风险操作前触发）
   *
   * AgentLoop 从 MB TOOL_CATALOG 中过滤这些工具，让 MB 聚焦于任务决策。
   * 仅 cron 和 generate_image 等特殊工具需要 MB 显式授权。
   */
  BASE_TOOLS: ['read', 'local_search', 'web_search', 'exec', 'file_write'] as const,

  // ==================== 技能相关 ====================

  /** 精准命中模式允许绑定的最大技能数量 */
  PINNED_SKILLS_MAX_COUNT: 5,

  // ==================== 文档相关 ====================

  /** 文档内容预览截断长度 */
  MAX_DOCUMENT_PREVIEW_LENGTH: 3000,

  // ==================== 温度参数 ====================

  /** Master Brain 决策温度 */
  MASTER_BRAIN_TEMPERATURE: 1,

  /** Local cap for the final Master Brain decision body, independent of reasoning transport. */
  MASTER_BRAIN_MAX_OUTPUT_TOKENS: 8192,

  /** Default MB transport budget for unknown or non-reasoning model routes. */
  MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS: 16384,

  /** Transport budget for reasoning models (shared reasoning plus final decision output). */
  MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS: 32768,

  /** Soft reasoning threshold: enables stricter loop detection without cancelling. */
  MASTER_BRAIN_REASONING_SOFT_TOKENS: 6144,

  /** Soft reasoning duration: enables stricter loop detection without cancelling. */
  MASTER_BRAIN_REASONING_SOFT_DURATION_MS: 120000,

  /** Non-retryable local reasoning fuse, independent of the provider transport budget. */
  MASTER_BRAIN_REASONING_HARD_TOKENS: 16384,

  /** Non-retryable reasoning wall-clock fuse, measured from the first reasoning chunk. */
  MASTER_BRAIN_REASONING_HARD_DURATION_MS: 8 * 60 * 1000,

  /** Independent live UI preview budget: 8K head plus a rolling 16K tail. */
  MASTER_BRAIN_REASONING_PREVIEW_HEAD_CHARS: 8 * 1024,
  MASTER_BRAIN_REASONING_PREVIEW_TAIL_CHARS: 16 * 1024,

  /** Sub-Agent 执行温度 */
  SUB_AGENT_TEMPERATURE: 1,

  /**
   * Soft UI notice threshold for a single Sub-Agent LLM decision.
   *
   * This does not cancel the request. It only lets the UI show that the
   * model is still deciding while the existing Rust stream timeouts remain
   * the source of truth for network cancellation.
   */
  SUB_AGENT_SLOW_DECISION_NOTICE_MS: 90000,

  /** Maximum consecutive empty text decisions to retry with stricter guidance. */
  SUB_AGENT_EMPTY_RESPONSE_RETRY_LIMIT: 1,

  // ==================== 上下文窗口管理 ====================

  /** 默认模型上下文窗口大小 (tokens)，详细模型映射见 ContextWindowManager.MODEL_CONTEXT_WINDOWS */
  DEFAULT_CONTEXT_WINDOW: 128000,

  // ==================== AgentLoop 相关 ====================

  /**
   * 每轮 MB 决策消耗的 FSM 步进次数（用于 per-agent budget 自动推导 maxIterations）
   *
   * 每轮 MB 循环：PREPARE_CONTEXT → MASTER_DECISION → DISPATCH → OBSERVE → EVALUATE + 1 次缓冲
   * 自动联动公式：maxIterations = planningLoopBudget × FSM_STEPS_PER_MB_ROUND
   * AGENT_LOOP_MAX_ITERATIONS 应与该步进估算保持同步
   */
  FSM_STEPS_PER_MB_ROUND: 6,

  /**
   * FSM 步进次数硬终止上限（defense-in-depth 安全阀）
   *
   * 每轮 MB 决策约 5-6 次 FSM 步进，乘以 LOOP_GOVERNOR_INITIAL_BUDGET 后留余量
   * 正常流程不会触及此值，仅在 LoopGovernor 失效时兜底
   */
  AGENT_LOOP_MAX_ITERATIONS: 48, // LOOP_GOVERNOR_INITIAL_BUDGET × FSM_STEPS_PER_MB_ROUND

  /** AgentLoop 默认 Token 预算 */
  AGENT_LOOP_TOKEN_BUDGET: 100000,

  /** 工具调用超时时间 (ms) */
  TOOL_CALL_TIMEOUT_MS: 60000,

  // ==================== LoopGovernor 治理器相关 ====================

  /** 治理器初始预算（MB 最大决策轮次，支持复合多阶段任务） */
  LOOP_GOVERNOR_INITIAL_BUDGET: 8,

  /** 治理器风险阈值 */
  LOOP_GOVERNOR_RISK_THRESHOLD: 0.8,

  /** 最大子 Agent 数量（预留） */
  LOOP_GOVERNOR_MAX_SUB_AGENTS: 5,

  /** 工具震荡检测阈值（连续调用同一工具的次数） */
  LOOP_GOVERNOR_TOOL_THRASHING_THRESHOLD: 3,

  /** SA 失败后 MB 允许的最大重试派遣次数（系统层硬限制） */
  MAX_SPAWN_RETRIES: 1,

  /**
   * MB 预算首次警告阈值（剩余轮数 ≤ 此值时注入 WARNING 提醒）
   *
   * 引导 MB 开始考虑收尾，但仍允许在极必要时再派 1 次 SA。
   * 对称于 SA 端的 SUB_AGENT_BUDGET_WARNING_RATIO（85%）。
   */
  MB_BUDGET_WARNING_THRESHOLD: 2,

  /**
   * MB 预算最终警告阈值（剩余轮数 ≤ 此值时注入 CRITICAL 强制警告）
   *
   * 这是最后 1 次决策机会，强制 MB 选择 RESPOND_TO_USER。
   * 对称于 SA 端的 SUB_AGENT_BUDGET_CRITICAL_RATIO（95%）。
   */
  MB_BUDGET_CRITICAL_THRESHOLD: 1,

  // ==================== Sub-Agent 上下文管理 ====================

  /** Level 1 截断阈值 (tokens) - 低于此值完整保留 */
  SUB_AGENT_COMPRESS_THRESHOLD_L1: 8000,

  /** Level 2 截断阈值 (tokens) - 低于此值首尾截断，高于此值仅元信息 */
  SUB_AGENT_COMPRESS_THRESHOLD_L2: 12000,

  /** Level 2 截断保留首部 tokens */
  SUB_AGENT_COMPRESS_HEAD_TOKENS: 500,

  /** Level 2 截断保留尾部 tokens */
  SUB_AGENT_COMPRESS_TAIL_TOKENS: 500,

  /** 工具历史消息保留最近 N 轮（完整保留，不压缩） */
  SUB_AGENT_HISTORY_KEEP_RECENT_ROUNDS: 2,

  /** SA 默认最大步数（一步 = 一次 LLM 决策/工具执行轮）
   *  此值为 DEFAULT_LOOP_CONFIG.maxSteps 和 SubAgentFactory fallback 的唯一来源 */
  SUB_AGENT_DEFAULT_MAX_STEPS: 50,

  /** SA 预算阈值信号：第一级警告（85% 消耗时注入提醒） */
  SUB_AGENT_BUDGET_WARNING_RATIO: 0.85,

  /** SA 预算阈值信号：最终警告（95% 消耗时注入最终提醒） */
  SUB_AGENT_BUDGET_CRITICAL_RATIO: 0.95,

  /** SA 临近耗尽时触发预算 Checkpoint 的剩余步数阈值 */
  SUB_AGENT_BUDGET_CHECKPOINT_REMAINING_STEPS: 5,

  /** SA 单次 Checkpoint 允许追加的最大步数 */
  SUB_AGENT_BUDGET_EXTENSION_MAX_ITERATIONS: 20,

  /** SA 单次派遣中最多允许追加预算的次数 */
  SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT: 2,

  /** SA 上下文 Token 压力触发比例（超过总窗口此比例启动激进压缩）
   *  设置为高阈值（85%）作为纯安全兜底，让 L2 上下文重置（45%）优先触发。
   *  仅在接近上下文撑爆时（如巨型单步工具输出）才介入机械裁剪。
   */
  SUB_AGENT_TOKEN_PRESSURE_RATIO: 0.85,

  /** SA 上下文重置触发比例 — 超过总窗口此比例执行总结 + 清空历史 */
  SUB_AGENT_CONTEXT_RESET_RATIO: 0.45,

  /** 上下文重置后 SA 必须保留的最小剩余步数（低于此值不触发重置，避免浪费最后几步） */
  SUB_AGENT_CONTEXT_RESET_MIN_REMAINING_STEPS: 3,

  /**
   * 工具调用总数硬上限（defense-in-depth 安全阀）
   *
   * 主预算使用步数（toolCallSteps < maxSteps），此常量仅作为
   * 极端场景的兜底保护：如单步并行调用大量工具导致上下文爆炸。
   * 正常流程不会触及此上限。
   * 该值 = SUB_AGENT_DEFAULT_MAX_STEPS(50) × 4
   */
  TOOL_CALLS_HARD_LIMIT: 200,

  /**
   * 单步工具调用数上限
   *
   * LLM 可能在一次决策中返回大量并行工具调用，超过此上限的调用将被截断丢弃。
   * 防止单步调用过多工具导致上下文爆炸和 token 浪费。
   */
  MAX_TOOLS_PER_STEP: 8,

  // ==================== Master Brain Prompt 预算管理 ====================

  /** Master Brain prompt 使用模型上下文窗口的比例（留 15% 给输出） */
  MASTER_BRAIN_PROMPT_BUDGET_RATIO: 0.85,

  /** toolCatalog 最多占可变预算的比例 */
  MASTER_BRAIN_TOOL_CATALOG_MAX_RATIO: 0.25,

  /** 对话历史最多占可变预算的比例 */
  MASTER_BRAIN_HISTORY_MAX_RATIO: 0.2,

  /** memory 最多占可变预算的比例（含 summaries 中的 openQuestions） */
  MASTER_BRAIN_MEMORY_MAX_RATIO: 0.2,

  /** RAG evidence 最多占可变预算的比例 */
  MASTER_BRAIN_RAG_MAX_RATIO: 0.15,

  /** Task Artifact 索引最多占可变预算的比例（前序 SA 中间成果概览） */
  MASTER_BRAIN_TASK_ARTIFACT_MAX_RATIO: 0.1,

  /** 保留最近 N 轮对话历史（摘要已覆盖更早轮次，无需冗余保留） */
  MASTER_BRAIN_HISTORY_KEEP_ROUNDS: 10,

  /** 单条历史消息最大字符数 */
  MASTER_BRAIN_MAX_MESSAGE_CHARS: 5000,

  /**
   * lastSAObservations 注入 MB rationale 时的截断上限（字符数）
   *
   * 截断策略为倒序截取（保留最后 N 字符），确保 MB 恢复时看到的是
   * SA 最近的执行步骤，而非最早的步骤（MB 关心的是最后进展在哪）。
   */
  SA_OBSERVATIONS_MAX_CHARS: 1200,

  /**
   * MB 决策历史日志滑动窗口上限（最大保留轮次）
   *
   * 控制 [MB_DECISION_HISTORY] 区块的历史深度：
   * - 过少（< 3）：长任务中 MB 仍可能丢失早期阶段上下文
   * - 过多（> 7）：历史遥远的 rationale 对当前决策贡献低，徒增 token
   * 5 轮约 250-750 tokens，在 MB prompt 中代价可接受。
   */
  MB_DECISION_LOG_MAX_ROUNDS: 5,
} as const;

// ==================== 类型导出 ====================

/**
 * Planning 常量类型
 */
export type PlanningConstantsType = typeof PLANNING_CONSTANTS;
