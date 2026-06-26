/**
 * FSM 引擎类型定义
 *
 * 状态机核心类型，用于 Agent Service 和 Sub-Agent 生命周期管理
 */

// ═══════════════════════════════════════════════════════════════
// Agent Service FSM 状态
// ═══════════════════════════════════════════════════════════════

/**
 * Agent Service 主状态机状态
 *
 * 状态流转逻辑：
 * IDLE → PREPARE_CONTEXT → MASTER_DECISION → DISPATCH → OBSERVE → EVALUATE → (循环或终止)
 */
export type AgentServiceState =
    | 'IDLE' // 空闲状态，等待用户请求
    | 'PREPARE_CONTEXT' // 上下文准备中（收集记忆、RAG 证据等）
    | 'MASTER_DECISION' // 调用 Master Brain 做决策
    | 'DISPATCH' // 分发决策（执行工具或创建子 Agent）
    | 'OBSERVE' // 观察执行结果
    | 'EVALUATE' // 评估是否继续或终止
    | 'TERMINATE'; // 终止状态

// ═══════════════════════════════════════════════════════════════
// Sub-Agent 生命周期状态
// ═══════════════════════════════════════════════════════════════

/**
 * Sub-Agent 生命周期状态
 *
 * Sub-Agent 的 FSM 是线性生命周期，内部 ReAct 循环由 SubAgentRunner 管理
 */
export type SubAgentState =
    | 'SPAWNED' // 刚创建
    | 'INPUT_VALIDATED' // 输入已验证
    | 'RUNNING' // 执行中
    | 'OUTPUT_CHECKED' // 输出已检查
    | 'COMPLETED' // 成功完成
    | 'FAILED'; // 失败

// ═══════════════════════════════════════════════════════════════
// FSM 事件类型
// ═══════════════════════════════════════════════════════════════

/**
 * 用户请求载荷
 */
export interface UserRequestPayload {
    /** 用户消息内容 */
    content: string;
    /** 附加上下文（@引用等） */
    context?: string[];
    /** 会话 ID */
    sessionId: string;
}

/**
 * 上下文准备完成载荷
 */
export interface PreparedContextPayload {
    /** 记忆快照 */
    memorySnapshot: unknown;
    /** RAG 证据 */
    ragEvidence: unknown[];
    /** 工具目录 */
    toolCatalog: unknown[];
}

/**
 * 决策接收载荷
 */
export interface DecisionReceivedPayload {
    /** Master Brain 决策结果 */
    decision: MasterBrainDecisionType;
    /** 决策详情 */
    details: unknown;
}

/**
 * Master Brain 决策类型（与 brain/types.ts DecisionType 同步）
 */
export type MasterBrainDecisionType =
    | 'SPAWN_SUB_AGENT'
    | 'REQUEST_MORE_INPUT'
    | 'RESPOND_TO_USER';

/**
 * Agent 输出载荷
 */
export interface AgentOutputPayload {
    /** 执行状态 */
    status: 'completed' | 'failed';
    /** 输出是否有效 */
    outputValid: boolean;
    /** 观察结果 */
    observations: string;
    /** 不确定性变化量 */
    uncertaintyDelta: number;
    /** 错误信息 */
    error?: string;
}

/**
 * FSM 事件联合类型
 *
 * 所有可能的状态机事件
 */
export type FSMEvent =
    | { type: 'USER_REQUEST'; payload: UserRequestPayload }
    | { type: 'CONTEXT_READY'; payload: PreparedContextPayload }
    | { type: 'CONTEXT_ERROR'; error: string }
    | { type: 'DECISION_RECEIVED'; payload: DecisionReceivedPayload }
    | { type: 'DECISION_INVALID'; reason: string }
    | { type: 'ACTION_COMPLETED'; result: unknown }
    | { type: 'ACTION_FAILED'; error: string }
    | { type: 'AGENT_OUTPUT'; payload: AgentOutputPayload }
    | { type: 'AGENT_ERROR'; error: string }
    | { type: 'CONTINUE' }
    | { type: 'TIMEOUT' };

// ═══════════════════════════════════════════════════════════════
// FSM 上下文
// ═══════════════════════════════════════════════════════════════

/**
 * 决策日志条目
 */
export interface DecisionLogEntry {
    /** 时间戳 */
    timestamp: Date;
    /** 决策类型 */
    decisionType: MasterBrainDecisionType;
    /** 输入摘要 */
    inputSummary: string;
    /** 执行结果 */
    executionResult?: {
        success: boolean;
        output?: unknown;
        error?: string;
    };
}

/**
 * FSM 运行时上下文
 *
 * 存储状态机运行过程中的所有状态数据
 */
export interface FSMContext {
    /** 循环预算（剩余次数） */
    loopBudget: number;
    /** 风险分数 */
    riskScore: number;
    /** 是否有进展 */
    progress: boolean;
    /** 决策日志 */
    decisionLog: DecisionLogEntry[];
    /** 活跃的子 Agent 状态 */
    activeSubAgents: Map<string, SubAgentState>;
    /** 工具调用历史（用于检测工具震荡） */
    toolCallHistory: string[];
    /** 连续无进展计数 */
    consecutiveNoProgress: number;
    /** 子 Agent 创建计数 */
    subAgentSpawnCount: number;
    /** 当前决策（缓存） */
    currentDecision?: DecisionReceivedPayload;
    /** 当前会话 ID */
    sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════
// FSM 定义结构
// ═══════════════════════════════════════════════════════════════

/**
 * Guard 函数类型
 *
 * 用于条件判断，必须是纯函数（无副作用）
 */
export type GuardFn<E extends { type: string }> = (
    context: FSMContext,
    event: E
) => boolean;

/**
 * Action 函数类型
 *
 * 用于执行副作用（修改上下文、日志记录等）
 */
export type ActionFn<E extends { type: string }> = (
    context: FSMContext,
    event: E
) => void | Promise<void>;

/**
 * 状态转移定义
 */
export interface FSMTransition<S extends string, E extends { type: string }> {
    /** 目标状态 */
    to: S;
    /** 可选的 Guard 函数（条件检查） */
    guard?: GuardFn<E>;
    /** 可选的 Action 函数列表（副作用） */
    actions?: ActionFn<E>[];
}

/**
 * 单个状态的配置
 */
export interface StateConfig<S extends string, E extends { type: string }> {
    /** 事件到转移的映射，使用 string 索引以支持动态查询 */
    on: Record<string, FSMTransition<S, E> | FSMTransition<S, E>[] | undefined>;
    /** 进入状态时执行的 Action */
    onEnter?: ActionFn<E>[];
    /** 离开状态时执行的 Action */
    onExit?: ActionFn<E>[];
}

/**
 * FSM 定义结构
 */
export interface FSMDefinition<S extends string, E extends { type: string }> {
    /** 初始状态 */
    initialState: S;
    /** 状态配置表 */
    states: Record<S, StateConfig<S, E>>;
    /** 创建初始上下文 */
    createInitialContext: () => FSMContext;
}

// ═══════════════════════════════════════════════════════════════
// FSM 轨迹记录
// ═══════════════════════════════════════════════════════════════

/**
 * FSM 轨迹条目
 *
 * 记录单次状态转移的完整信息
 */
export interface FSMTraceEntry<S extends string = string, E extends { type: string } = { type: string }> {
    /** 时间戳 */
    timestamp: Date;
    /** 迭代次数 */
    iteration: number;
    /** 起始状态 */
    fromState: S;
    /** 目标状态 */
    toState: S;
    /** 触发事件 */
    event: E;
    /** Guard 执行结果 */
    guardResult?: boolean;
    /** 执行的 Action 名称列表 */
    actionsExecuted: string[];
    /** 预算快照 */
    budgetSnapshot: {
        remaining: number;
        risk: number;
        progress: boolean;
    };
    /** 转移耗时（ms） */
    duration: number;
}

// ═══════════════════════════════════════════════════════════════
// FSMEngine 接口
// ═══════════════════════════════════════════════════════════════

/**
 * FSM 引擎接口
 */
export interface IFSMEngine<S extends string, E extends { type: string }> {
    /** 当前状态 */
    readonly currentState: S;

    /** 发送事件到队列 */
    send(event: E): void;

    /** 执行一步（处理当前事件队列中的一个事件） */
    step(): Promise<void>;

    /** 重置到初始状态 */
    reset(): void;

    /** 获取执行轨迹 */
    getTrace(): FSMTraceEntry<S, E>[];

    /** 获取当前上下文（只读） */
    getContext(): Readonly<FSMContext>;
}
