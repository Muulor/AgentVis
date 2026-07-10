/**
 * AgentLoopFSMIntegration - FSM 与 AgentLoop 集成层
 *
 * 职责：
 * 1. 封装 FSM 与现有 AgentLoop 组件的桥接
 * 2. 定义状态处理器（每个 FSM 状态的具体执行逻辑）
 * 3. 绑定 FSM Actions 与现有服务调用
 * 4. 桥接 FSM Events 与回调系统
 *
 * 设计原则：
 * - 支持 Native MasterBrain 模式
 * - FSM 只负责状态流转控制
 * - 观测性组件自动集成
 */

import { FSMEngine } from '../fsm/FSMEngine';
import { createAgentServiceFSMDefinition } from '../fsm/FSMDefinitions';
import { LoopGovernor } from './LoopGovernor';
import { FSMTracer, type TraceOutcome } from '../observability/FSMTracer';
import type {
    AgentServiceState,
    FSMEvent,
    FSMContext,
    UserRequestPayload,
} from '../fsm/types';
import type { AgentLoopCallbacks, ReasoningTraceEvent, TerminationReason } from './types';
import type { AgentSession } from './AgentSession';
import type { SkillDefinition } from '../skills/types';
import { PLANNING_CONSTANTS } from '../PlanningConstants';

// ========== MasterBrain 集成 ==========
import { MasterBrain } from '../brain/MasterBrain';
import { MasterBrainPrompt } from '../brain/MasterBrainPrompt';
import { DecisionParser } from '../brain/DecisionParser';
import { parseCheckpointDecision } from '../brain/CheckpointDecisionParser';
import type {
    MbDecisionRetryCorrection,
    MbDecisionRetryState,
} from '../brain/MasterBrainDecisionGuard';
import type {
    MemorySnapshot,
    RAGEvidence,
    ToolCatalogEntry,
    SubAgentSpec,
    CheckpointCallback,
    CheckpointDecision,
    ExternalGuideSkillInfo,
    ExternalScriptSkillCatalogEntry,
    ExternalScriptSkillInfo,
    MbDecisionLogEntry,
} from '../brain/types';
import type { ProgressReport, TaskAttachmentReference } from '../sub-agents/types';

// ==========  Sub-Agent 集成 ==========

// ========== 委托模块集成 ==========
import { DecisionMapper } from './mappers';
import { MasterBrainInputBuilder } from './builders';
import { SubAgentDispatcher } from './dispatchers';
import type { VisionFallbackMode } from './callers/SubAgentLLMCaller';
import { TaskArtifactStore } from '../artifact/TaskArtifactStore';

// ========== 状态处理器模块集成 ==========
import {
    createStateHandlerMap as createModularHandlers,
    type HandlerContext,
    type HandlerSharedState,
    type HandlerConfig,
    type HandlerDependencies,
} from './handlers';
import { formatAgentLoopFailureMessage } from './ErrorObservationFormatter';
import { getLogger } from '@services/logger';
import { getDefaultModelIdForProvider } from '@/config/modelRegistry';
import { translate } from '@/i18n';

const logger = getLogger('AgentLoopFSMIntegration');
const DEFAULT_PROVIDER = 'local';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * 状态处理器函数类型
 *
 * 每个 FSM 状态对应一个处理器，返回下一个事件
 */
export type StateHandler = (
    context: FSMContext,
    integration: AgentLoopFSMIntegration
) => Promise<FSMEvent>;

/**
 * 状态处理器映射表
 */
export type StateHandlerMap = Partial<Record<AgentServiceState, StateHandler>>;

/**
 * FSM 集成配置
 */
export interface FSMIntegrationConfig {
    /** Agent ID */
    agentId: string;
    tokenContextId?: string;
    /** Agent 名称（用于 Character Grounding Prompt） */
    agentName?: string;
    /** 最大迭代次数 */
    maxIterations: number;
    /** 回调函数 */
    callbacks: AgentLoopCallbacks;
    /** LLM 模型 ID */
    modelId?: string;
    /** LLM 提供商 ID */
    providerId?: string;
    /** 自定义 API 基址 URL（用于 local 代理） */
    baseUrl?: string;
    /** 工作目录（用于 SubAgent 执行工具时的根目录） */
    workdir?: string;
    /** Master Brain 专属规则 */
    mbAgentRules?: string;
    /** Sub-Agent 专属规则 */
    saAgentRules?: string;
    /** Agent 头像 base64 数据（用于身份形象感知注入） */
    agentAvatar?: string;
    /**
     * MB 最大决策轮次（per-agent 覆盖）
     *
     * 来自 Agent 设置面板的 planningLoopBudget。
     * undefined 时回退到 PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET。
     * 不会影响 maxIterations（FSM 安全阀）。
     */
    mbDecisionBudget?: number;
    /**
     * 用户关联的外部项目路径（cwd 切换）
     *
     * 用户在授权弹窗确认后 Agent 具有该目录的全权限：
     * - SA 的 cwd 切换为 projectPath（exec 命令在正确目录执行）
     * - file_write 相对路径自动解析到 projectPath 下
     * - MB 注入 [PROJECT_CONTEXT] 快照供决策参考
     */
    projectPath?: string;
    /** 用户本轮上传的附件路径清单，注入 Sub-Agent TaskContext */
    attachmentReferences?: TaskAttachmentReference[];
    /** 用户可见的三档沙箱权限。 */
    sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
    /** 是否启用 Sub-Agent 每步 Safety Footer 热区提示词。 */
    subAgentSafetyFooterEnabled?: boolean;
    /** Sub-Agent Safety Footer 的自定义提示词文本。 */
    subAgentSafetyFooterText?: string;
}

/**
 * LLM 服务接口（供 MasterBrain 使用）
 * 
 * 抽象 LLM 调用，便于 MasterBrain 内部使用
 */
export interface LLMServiceInterface {
    /** 生成文本响应 */
    generate(
        prompt: string,
        options?: {
            maxTokens?: number;
            temperature?: number;
            /**
             * 跳过 Session messages 拼接（Checkpoint 专用）
             *
             * 正常 MB 决策需要 Session messages 提供用户对话上下文；
             * 但 Checkpoint 评估不应混入 Session 消息——这些消息包含
             * 用户原始请求和 SA 工具结果，会导致 LLM 混淆"评估者"与"执行者"角色。
             *
             * 当 skipSessionMessages=true 时，仅发送 [system: prompt] + [user: taskContext]
             */
            skipSessionMessages?: boolean;
            /**
             * 替代 Session messages 的简洁任务上下文（与 skipSessionMessages 配合）
             *
             * 通常设置为 MB 下发的 spec.role（任务描述），
             * 确保 Checkpoint MB 理解任务目标但不接触原始会话消息。
             */
            taskContext?: string;
            /**
             * MB 当前剩余决策预算（由 MasterBrainInputBuilder 注入）
             *
             * MasterBrain.callLLM() 透传此值，供 AgentLoop.generate() 判断是否
             * 需要在 messages 尾部追加预算警告 user 消息。
             * undefined 表示预算充足，不注入警告。
             */
            mbBudgetRemaining?: number;
            /**
             * 流式增量回调（MB Thought 流式显示专用）
             *
             * LLM 流式生成过程中，每收到一个 chunk 就调用此回调，
             * 传递当前已累积的完整文本（含 reasoning + delta），
             * 供 StateHandlers 实时更新 Thought 卡片。
             *
             * 仅正常 MB 决策路径使用，Checkpoint 路径不启用。
             */
            onStreamDelta?: (accumulatedContent: string) => void;
            /** provider reasoning_content 流式回调 */
            onReasoningTrace?: (event: ReasoningTraceEvent) => void;
            /** 流式异常与解析异常共用的 MB 语义重试状态 */
            mbDecisionRetryState?: MbDecisionRetryState;
            /** 追加到 messages 尾部的定向纠错原因 */
            mbDecisionCorrection?: MbDecisionRetryCorrection;
        }
    ): Promise<string>;
}

/**
 * 工具执行选项
 */
export interface ToolExecuteOptions {
    /** 是否由 Sub-Agent 调用（true 时跳过交互确认） */
    isSubAgentContext?: boolean;
    /** 覆盖工具执行 cwd（projectPath 场景下用于对齐 UI 工作区） */
    workdirOverride?: string;
    /** 隔离模式允许访问的文件根目录集合 */
    sandboxRoots?: string[];
    /** 任务取消信号，传递给底层工具用于中断长耗时调用 */
    signal?: AbortSignal;
}

export interface FSMIntegrationDependencies {
    /** 会话实例 */
    session: AgentSession;

    /** 工具执行函数（来自原 AgentLoop） */
    executeTool: (toolCall: ToolCallInfo, options?: ToolExecuteOptions) => Promise<ToolExecutionResult>;

    // ========== Native MasterBrain 模式依赖 ==========
    /** LLM 服务接口（Native 模式使用） */
    llmService?: LLMServiceInterface;

    /** 获取记忆快照（可选，如无则使用空快照） */
    getMemorySnapshot?: (agentId: string, userQuery?: string) => Promise<MemorySnapshot>;

    /** 获取 RAG 证据（可选，如无则返回空数组） */
    getRAGEvidence?: (query: string) => Promise<RAGEvidence[]>;

    /** 获取工具目录（可选，如无则返回空数组） */
    getToolCatalog?: () => ToolCatalogEntry[];

    /** 按用户意图语义检索 Guide 模式技能（可选，由 SkillRetriever 提供） */
    getExternalGuideSkills?: (query: string) => Promise<ExternalGuideSkillInfo[]>;

    /** 按查询文本精确匹配 Script 模式技能（可选） */
    getExternalScriptSkills?: (query: string) => Promise<ExternalScriptSkillInfo[]>;

    /** 获取所有已安装外部 Guide 技能的轻量目录（可选，静态全量） */
    getInstalledSkillCatalog?: () => Array<{ name: string; description: string }>;

    /** 获取所有已安装外部 Script 技能的轻量目录（可选，静态全量） */
    getInstalledScriptSkillCatalog?: () => ExternalScriptSkillCatalogEntry[];

    /** 保存任务经验到长期记忆（可选，由 MemoryService.saveTaskExperience 提供） */
    saveTaskExperience?: (content: string) => Promise<void>;
}

/**
 * LLM 调用结果
 */
export interface LLMCallResult {
    type: 'text' | 'tool_use' | 'error';
    content?: string;
    toolCalls?: ToolCallInfo[];
    error?: string;
}

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
    name: string;
    args: Record<string, unknown>;
}

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
    success: boolean;
    content: string;
    requiresInteraction?: boolean;
    data?: Record<string, unknown>;
    /** 图片附件（多模态，read 工具读取图片时填充） */
    images?: Array<{ mimeType: string; data: string }>;
}


// ═══════════════════════════════════════════════════════════════
// AgentLoopFSMIntegration 主类
// ═══════════════════════════════════════════════════════════════

/**
 * FSM 与 AgentLoop 集成器
 *
 * 将 FSM 状态机与现有 AgentLoop 功能组合
 */
export class AgentLoopFSMIntegration {
    /** FSM 引擎 */
    private readonly fsmEngine: FSMEngine<AgentServiceState, FSMEvent>;

    /** 循环治理器 */
    private readonly loopGovernor: LoopGovernor;

    /** FSM 追踪器 */
    private readonly tracer: FSMTracer;

    /** 配置 */
    private readonly config: FSMIntegrationConfig;

    /** 技能定义列表 */
    private skills: SkillDefinition[] = [];

    /** 依赖 */
    private dependencies: FSMIntegrationDependencies | null = null;

    /** 状态处理器映射 */
    private readonly stateHandlers: StateHandlerMap;

    /** 取消标志 */
    private cancelled = false;

    /** 中断控制器（用于将 cancel 信号传递到 SubAgentRunner） */
    private abortController = new AbortController();

    /** 当前正在处理的工具调用 */
    private currentToolCalls: ToolCallInfo[] = [];

    /** 终止原因（null 表示还未确定） */
    private terminationReason: TerminationReason | null = null;

    /** 最后的 LLM 响应内容 */
    private lastLLMContent = '';

    // ========== MasterBrain 相关字段 ==========
    /** MasterBrain 实例（Native 模式使用） */
    private masterBrain: MasterBrain | null = null;

    /** 待处理的 SubAgentSpec（由 MasterBrain 决策设置，使用） */
    private pendingSubAgentSpec: SubAgentSpec | null = null;

    /** 上次操作是否有进展（用于 LoopGovernor 评估） */
    private lastActionMadeProgress = true;

    /** 上次操作是否创建了子智能体 */
    private lastActionSpawnedSubAgent = false;

    /** 当次 MB 决策检索到的外部 Guide 技能（MASTER_DECISION → DISPATCH 传递） */
    private externalGuideSkills?: ExternalGuideSkillInfo[];

    /** 当次命中的外部 Script 技能（MASTER_DECISION → DISPATCH 传递） */
    private externalScriptSkills?: ExternalScriptSkillInfo[];

    // ========== 委托模块实例 ==========
    /** 决策映射器 */
    private decisionMapper: DecisionMapper | null = null;

    /** MasterBrain 输入构建器 */
    private masterBrainInputBuilder: MasterBrainInputBuilder | null = null;

    /** SubAgent 派遣器 */
    private subAgentDispatcher: SubAgentDispatcher | null = null;

    /** 跨 SA 生命周期的 Artifact Store（持久化中间成果） */
    private artifactStore: TaskArtifactStore = new TaskArtifactStore();

    /** SA 连续失败派遣计数器（系统层重试安全阀，超过 MAX_SPAWN_RETRIES 时强制终止） */
    private spawnCount = 0;

    /** SA 执行期间提取的待写入经验（跨 FSM 状态持久化） */
    private pendingExperiences: string[] = [];

    /** 记忆系统中的已有任务经验（MASTER_DECISION 缓存，DISPATCH 传递给 SA） */
    private taskExperiences: Array<{ content: string }> = [];

    /** MB 最近一轮的决策 rationale（跨请求持久化用，非正常终止时嵌入 session 消息） */
    private lastMBRationale?: string;

    /** MB 最近一轮 SPAWN_SUB_AGENT 时下发的 nextStep.task（同轮战略连续性） */
    private lastMBTask?: string;

    /** 最近一次 SA 的执行观察摘要（跨请求持久化用，非正常终止时嵌入 session 消息） */
    private lastSAObservations?: string;

    /** 各次 SA 执行的推理结论摘要（按派遣顺序累积，注入 MB 的 TASK_ARTIFACTS 区块） */
    private saObservationsSummaries: Array<{ role: string; summary: string }> = [];

    /** MB 决策历史日志（同 run 内按派遣顺序累积，滑动窗口保留最近 N 轮） */
    private mbDecisionLog: MbDecisionLogEntry[] = [];

    /** handleDispatch spawnCount 终止时锁定的消息，防止后续 handler 覆盖 */
    private forceTerminationContent?: string;

    /** 用户上传的图片附件（MB 注入后保留，DISPATCH 时透传给 SA） */
    private pendingImageAttachments?: Array<{ mimeType: string; data: string }>;
    /** 图片附件持久化后的路径列表（保存在 workdir/attachments/ 下） */
    private savedAttachmentPaths?: string[];
    /**
     * 图片附件 dirty flag——防止 syncSharedState 用旧快照覆盖 setImageAttachments() 设置的值
     *
     * 时序问题：setImageAttachments() 在 MASTER_DECISION handler 执行期间设置 class field，
     * 但 handler 结束后 syncSharedState() 会用创建时的旧快照（undefined）覆盖更新后的值。
     * dirty=true 时 syncSharedState 跳过回写，保留 class field 上的新值。
     */
    private pendingImageAttachmentsDirty = false;
    /**
     * 配对好的历史对话消息（含图片），注入 SA messages[] 首条任务指令之前
     *
     * 由 AgentLoop.ts 构建，经 FSMIntegration → SharedState → SubAgentDispatcher → SubAgentRunner 透传。
     * 与 pendingImageAttachments 互斥：历史图片走此路径（配对模式），当轮新图片走 pendingImageAttachments。
     */
    private pendingPairedHistoryMessages?: Array<{
        role: 'user' | 'assistant';
        content: string;
        images?: Array<{ mimeType: string; data: string }>;
    }>;
    /**
     * 配对消息 dirty flag——防止 syncSharedState 用旧快照覆盖 setPairedHistoryMessages() 设置的值
     *
     * 与 pendingImageAttachmentsDirty 完全对称的时序保护机制。
     */
    private pendingPairedHistoryMessagesDirty = false;

    constructor(config: FSMIntegrationConfig) {
        this.config = config;

        // 初始化 FSM 引擎
        const fsmDefinition = createAgentServiceFSMDefinition();
        this.fsmEngine = new FSMEngine(fsmDefinition);

        // 初始化治理器。优先使用 per-agent 配置，fallback 到全局常量。
        // 注意：config.maxIterations 是 FSM 步进次数硬上限（安全阀），
        // 与 LoopGovernor.initialBudget（MB 决策轮次预算）是不同概念，不应混用。
        const effectiveMbBudget = config.mbDecisionBudget
            ?? PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET;
        this.loopGovernor = new LoopGovernor({ initialBudget: effectiveMbBudget });

        // 初始化观测性组件
        this.tracer = new FSMTracer();

        // 注册状态处理器
        this.stateHandlers = this.createStateHandlers();
    }

    // ═══════════════════════════════════════════════════════════════
    // 公共接口
    // ═══════════════════════════════════════════════════════════════

    /**
     * 设置运行时依赖
     *
     * 必须在 run() 之前调用
     * 
     * 初始化 MasterBrain 实例（OODA 2.0 架构）
     */
    setDependencies(
        dependencies: FSMIntegrationDependencies,
        skills: SkillDefinition[]
    ): void {
        this.dependencies = dependencies;
        this.skills = skills;

        // 初始化 MasterBrain（Native 模式）
        if (dependencies.llmService) {
            this.initializeMasterBrain(dependencies.llmService);
        }

        // ========== 初始化委托模块 ==========
        // 决策映射器
        this.decisionMapper = new DecisionMapper();

        // MasterBrain 输入构建器
        this.masterBrainInputBuilder = new MasterBrainInputBuilder(
            dependencies.session,
            dependencies, // MasterBrainInputBuilderDeps 兼容
            this.config.agentId,
            this.fsmEngine,
            this.config.agentName
        );

        // ═══ 创建 SubAgent 专用工具执行函数 ═══
        // 包装原始的 executeTool，添加 isSubAgentContext 标识
        const subAgentExecuteTool = this.createSubAgentToolExecutor(dependencies.executeTool);

        // SubAgent 派遣器
        // 当用户关联了外部项目路径时，SA 的 cwd 切换为 projectPath
        // 这使得 file_write 的相对路径解析、exec 命令的工作目录都指向用户项目
        const effectiveWorkdir = this.config.projectPath ?? this.config.workdir;
        this.subAgentDispatcher = new SubAgentDispatcher(
            dependencies.session,
            this.config.callbacks,
            {
                providerId: this.config.providerId ?? DEFAULT_PROVIDER,
                modelId: this.config.modelId
                    ?? getDefaultModelIdForProvider(this.config.providerId ?? DEFAULT_PROVIDER),
                baseUrl: this.config.baseUrl,
                workdir: effectiveWorkdir,
                sandboxMode: this.config.sandboxMode ?? 'LocalAudit',
                // SA 专属规则注入 SubAgent prompt
                agentRules: this.config.saAgentRules,
                agentId: this.config.agentId,
                tokenContextId: this.config.tokenContextId ?? this.config.agentId,
                // 原始交付物目录（projectPath 切换时保留引用，用于跨目录访问）
                deliverableWorkdir: this.config.projectPath ? this.config.workdir : undefined,
                attachmentReferences: this.config.attachmentReferences,
                subAgentSafetyFooterEnabled: this.config.subAgentSafetyFooterEnabled,
                subAgentSafetyFooterText: this.config.subAgentSafetyFooterText,
            },
            subAgentExecuteTool,
            this.skills
        );

        // ═══ Task Artifact Store 注入 ═══
        // Store 由本类持有，通过 setter 注入到 Dispatcher（自动传递给 Runner）和 InputBuilder
        this.subAgentDispatcher.setArtifactStore(this.artifactStore);
        this.masterBrainInputBuilder.setArtifactStore(this.artifactStore);

        // Agent 形象感知：通知 MasterBrainInputBuilder 是否有 avatar，
        // 使 Character Grounding 段落条件性注入形象引导文字
        if (this.config.agentAvatar) {
            this.masterBrainInputBuilder.setHasAvatar(true);
        }

        // ═══ WORKDIR 文件扫描依赖注入 ═══
        // 复用 SubAgentDispatcher 的扫描逻辑，避免重复实现
        // MasterBrainInputBuilder 会将扫描结果聚合为轻量统计摘要注入 MB Prompt
        // 适配新的返回结构 { files, totalFileCount, scanTruncated }：
        // - 以往 scanWorkdirFiles() 返回 WorkdirFileInfo[]（最多 50 个），导致 WORKDIR_SNAPSHOT.totalFiles 被截断
        // - 现在返回 totalFileCount + scanTruncated，确保 MB 能区分完整快照与预算截断快照
        const dispatcher = this.subAgentDispatcher;
        (dependencies as unknown as Record<string, unknown>).getWorkdirFiles =
            async () => {
                const result = await dispatcher.scanWorkdirFiles();
                return {
                    files: result.files,
                    totalFileCount: result.totalFileCount,
                    scanTruncated: result.scanTruncated,
                };
            };

        logger.trace('[AgentLoopFSMIntegration] 委托模块初始化完成（含 Task Artifact Store + WORKDIR 扫描）');
    }


    /**
     * 初始化 MasterBrain 实例
     * 
     * 创建 MasterBrain 及其依赖组件
     */
    private initializeMasterBrain(llmService: LLMServiceInterface): void {
        const promptBuilder = new MasterBrainPrompt();
        const decisionParser = new DecisionParser();

        this.masterBrain = new MasterBrain(
            promptBuilder,
            decisionParser,
            llmService
        );

        logger.trace('[AgentLoopFSMIntegration] MasterBrain 初始化完成（Native 模式）');
    }


    /**
     * 执行 FSM 驱动的 Agent Loop
     *
     * @param userMessage 用户消息
     * @returns 终止原因
     */
    async run(userMessage: string): Promise<TerminationReason> {
        if (!this.dependencies) {
            throw new Error('Dependencies not set. Call setDependencies() first.');
        }

        // 重置状态
        this.reset();

        // 启动追踪会话
        this.tracer.startSession();

        // 发送初始事件
        const userRequestPayload: UserRequestPayload = {
            content: userMessage,
            sessionId: this.dependencies.session.id,
        };
        this.fsmEngine.send({ type: 'USER_REQUEST', payload: userRequestPayload });

        try {
            // 发送初始思维状态（UI）
            this.config.callbacks.onThinkingPhase?.({
                type: 'START',
                phase: 'IDLE',
            });

            // FSM 驱动循环
            // maxIterations 作为 defense-in-depth 安全阀：
            // 正常终止由 LoopGovernor 的 budget/progress/risk 检测负责，
            // maxIterations 仅在 LoopGovernor 异常失效时兜底防止无限循环
            let previousState = this.fsmEngine.currentState;
            let stepCount = 0;
            const maxSteps = this.config.maxIterations;

            while ((this.fsmEngine.currentState as string) !== 'TERMINATE') {
                // 检查取消
                if (this.cancelled) {
                    this.terminationReason = 'cancelled';
                    break;
                }

                // defense-in-depth: FSM 步进次数硬终止
                stepCount++;
                if (stepCount > maxSteps) {
                    logger.warn(
                        `[AgentLoopFSMIntegration] FSM 步进次数 (${stepCount}) 超过安全上限 (${maxSteps})，强制终止`
                    );
                    this.terminationReason = 'max_iterations';
                    break;
                }

                // 执行一步 FSM
                await this.fsmEngine.step();

                // 获取当前状态
                const currentState = this.fsmEngine.currentState;

                // ═══ UI: FSM 状态变更回调 ═══
                if (currentState !== previousState) {
                    this.config.callbacks.onFSMStateChange?.(previousState, currentState);
                    previousState = currentState;
                }

                const handler = this.stateHandlers[currentState];

                if (handler && currentState !== 'TERMINATE' && currentState !== 'IDLE') {
                    // 执行状态处理器，获取下一个事件
                    const context = this.fsmEngine.getContext();
                    const nextEvent = await handler(context, this);

                    // 记录状态转移到 Tracer
                    this.recordTrace(currentState, nextEvent);

                    // 发送下一个事件
                    this.fsmEngine.send(nextEvent);
                }
            }


            // 结束追踪会话
            const finalReason = this.terminationReason ?? 'text_response';
            this.tracer.endSession(this.mapTerminationToOutcome(finalReason));

            // ═══ 统一收口点：注入 rationale + SA observations ═══
            this.injectRationaleBeforeReturn(finalReason);

            return finalReason;
        } catch (error) {
            // 错误路径也必须执行统一收口点，否则 handler 抛出未捕获错误时 rationale 丢失
            this.terminationReason = 'error';
            this.tracer.endSession('error');
            this.injectRationaleBeforeReturn('error');
            this.config.callbacks.onError?.(
                error instanceof Error ? error : new Error(String(error))
            );
            throw error;
        }
    }

    /**
     * 统一收口点：将 MB rationale 和 SA observations 嵌入 lastLLMContent
     *
     * 从 run() 的 try 和 catch 路径都调用，确保所有终止路径均注入上下文恢复信息。
     * 注入的内容通过 session.addMessage() 持久化到对话历史，
     * 下一轮用户请求时由 MasterBrainInputBuilder 的 conversationHistory 自然读取。
     */
    private injectRationaleBeforeReturn(finalReason: string): void {
        // 恢复被后续 handler 覆盖的强制终止内容
        // 场景：handleDispatch spawnCount 终止后，FSM 继续运行，
        // 后续 MB LLM 调用也失败 → catch block 覆盖了 lastLLMContent
        if (this.forceTerminationContent) {
            this.lastLLMContent = this.forceTerminationContent;
        }

        const RATIONALE_MARKER = 'MB decision progress (system-injected context for the next decision)';
        // 排除法：只排除不需要注入的正常场景（awaiting_interaction），
        // text_response 仅在 lastLLMContent 已有实质内容时排除（真正的正常完成），
        // 若 lastLLMContent 为空说明是 FSM 异常退出后默认值生效，仍需注入
        if (this.lastMBRationale
            && !this.lastLLMContent.includes(RATIONALE_MARKER)
            && finalReason !== 'awaiting_interaction'
            && !(finalReason === 'text_response' && this.lastLLMContent.trim())) {
            // 当 lastLLMContent 为空时先插入用户可见的系统提示，
            // 避免 buildResult 剥离 rationale 后 UI 显示空气泡
            if (!this.lastLLMContent.trim()) {
                this.lastLLMContent = formatAgentLoopFailureMessage(finalReason, {
                    includeRawDetail: false,
                });
            }
            const rationaleBlock = `\n\n${RATIONALE_MARKER}:\n${this.lastMBRationale}`;
            // 追加上次派遣任务，使 conversationHistory 承载完整决策上下文
            const taskBlock = this.lastMBTask
                ? `\n\n${translate('chat.agentLastMbDispatchedTaskContext', {
                    task: this.lastMBTask,
                })}`
                : '';
            let latestSaObservations = '';
            if (this.lastSAObservations) {
                // 倒序截取：保留最后 N 字符，MB 关心的是中断时刻的最新进展
                latestSaObservations = this.lastSAObservations.length > PLANNING_CONSTANTS.SA_OBSERVATIONS_MAX_CHARS
                    ? translate('chat.agentEarlierStepsOmitted') +
                    this.lastSAObservations.slice(-PLANNING_CONSTANTS.SA_OBSERVATIONS_MAX_CHARS)
                    : this.lastSAObservations;
            }
            const saBlock = this.lastSAObservations
                ? `\n\n${translate('chat.agentLastSaExecutionProgressContext', {
                    observations: latestSaObservations,
                })}`
                : '';
            this.lastLLMContent += rationaleBlock + taskBlock + saBlock;
        }
    }

    /**
     * 取消执行
     */
    cancel(): void {
        this.cancelled = true;
        // 触发 AbortController，使正在运行的 SubAgentRunner 立即感知中断
        this.abortController.abort();
    }

    /**
     * 获取当前 FSM 状态
     */
    getCurrentState(): AgentServiceState {
        return this.fsmEngine.currentState;
    }

    /**
     * 获取执行轨迹
     */
    getTrace(): ReturnType<FSMTracer['getFullTrace']> {
        return this.tracer.getFullTrace();
    }

    /**
     * 获取最后的 LLM 内容
     */
    getLastLLMContent(): string {
        return this.lastLLMContent;
    }

    /**
     * 获取终止原因
     */
    getTerminationReason(): TerminationReason {
        return this.terminationReason ?? 'text_response';
    }

    // ═══════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════

    /**
     * 设置用户上传的图片附件（供 DISPATCH 透传给 SA）
     *
     * 由 AgentLoop.ts 在 MB 注入图片后调用，使 SA 也能"看到"用户上传的图片。
     * 图片数据使用 camelCase 格式（mimeType），与 llm_chat_with_tools 一致。
     */
    setImageAttachments(
        images?: Array<{ mimeType: string; data: string }>,
        savedPaths?: string[]
    ): void {
        this.pendingImageAttachments = images;
        this.savedAttachmentPaths = savedPaths;
        // 标记为 dirty，防止后续 syncSharedState 用旧快照覆盖
        this.pendingImageAttachmentsDirty = true;
    }

    /**
     * 设置配对好的历史对话消息（供 DISPATCH 透传给 SA）
     *
     * 由 AgentLoop.ts 在跨轮图片收集阶段调用，将历史图片以配对消息的形式射入 SA。
     * 与 setImageAttachments 互斥：当轮新上传的图片由 setImageAttachments 处理，
     * 历史跨轮图片由本方法处理。
     */
    setPairedHistoryMessages(
        messages?: Array<{ role: 'user' | 'assistant'; content: string; images?: Array<{ mimeType: string; data: string }> }>
    ): void {
        this.pendingPairedHistoryMessages = messages;
        // 标记为 dirty，防止后续 syncSharedState 用旧快照覆盖
        this.pendingPairedHistoryMessagesDirty = true;
        logger.trace(`[AgentLoopFSMIntegration] 📷 已设置配对历史消息，待 DISPATCH 透传给 SA (${messages?.length ?? 0} 条消息)`);
    }

    /**
     * 重置状态
     */
    setVisionFallbackMode(mode: VisionFallbackMode): void {
        this.subAgentDispatcher?.setVisionFallbackMode(mode);
    }

    private reset(): void {
        this.fsmEngine.reset();
        this.loopGovernor.reset();
        this.cancelled = false;
        this.abortController = new AbortController();
        this.currentToolCalls = [];
        this.terminationReason = null; // 初始为 null 表示未确定
        this.lastLLMContent = '';
        this.pendingSubAgentSpec = null; // 重置待处理的 SubAgentSpec
        this.externalGuideSkills = undefined; // 重置外部 Guide 技能
        this.externalScriptSkills = undefined; // 重置外部 Script 技能
        this.spawnCount = 0; // 重置连续失败计数器
        this.pendingExperiences = []; // 重置待写入经验
        this.taskExperiences = []; // 重置已有任务经验缓存
        this.lastMBRationale = undefined; // 重置 MB rationale（每次 run 重新开始）
        this.lastMBTask = undefined;     // 重置 MB 上一轮 task（与 rationale 一起重置）
        this.lastSAObservations = undefined; // 重置 SA observations
        this.saObservationsSummaries = []; // 重置 SA 推理结论累积列表
        this.mbDecisionLog = [];             // 重置 MB 决策历史日志
        // 注意：不重置 pendingImageAttachments/savedAttachmentPaths——
        // 它们由 AgentLoop.ts 在 run() 之前设置，在 DISPATCH 处理器消费后清除

        // 注意：不清空 artifactStore——
        // Artifact 的生命周期跨多次 MB 决策循环，在同一个用户消息处理期间持续有效。
        // 只有在新的用户消息到来时（run() 被再次调用时）才清空。
        this.artifactStore.clear();
    }

    /**
     * 创建状态处理器映射
     *
     * 使用模块化处理器，通过适配层桥接旧签名和新架构
     */
    private createStateHandlers(): StateHandlerMap {
        // 获取模块化处理器映射
        const modularHandlers = createModularHandlers();

        // 创建适配器：将模块化处理器包装为旧签名
        const createAdapter = (
            handlerFn: typeof modularHandlers.PREPARE_CONTEXT
        ): StateHandler => {
            if (!handlerFn) {
                throw new Error('Missing modular state handler');
            }
            return async (
                fsmContext: FSMContext,
                _integration: AgentLoopFSMIntegration
            ): Promise<FSMEvent> => {
                // 构建 HandlerContext
                const handlerContext = this.createHandlerContext();

                // 执行模块化处理器
                const event = await handlerFn(fsmContext, handlerContext);

                // 同步共享状态回主类字段
                this.syncSharedState(handlerContext.sharedState);

                return event;
            };
        };

        return {
            PREPARE_CONTEXT: createAdapter(modularHandlers.PREPARE_CONTEXT),
            MASTER_DECISION: createAdapter(modularHandlers.MASTER_DECISION),
            DISPATCH: createAdapter(modularHandlers.DISPATCH),
            OBSERVE: createAdapter(modularHandlers.OBSERVE),
            EVALUATE: createAdapter(modularHandlers.EVALUATE),
        };
    }

    /**
     * 创建处理器上下文
     *
     * 将主类字段打包为 HandlerContext
     */
    private createHandlerContext(): HandlerContext {
        if (!this.dependencies) {
            throw new Error('Dependencies not set');
        }

        const config: HandlerConfig = {
            agentId: this.config.agentId,
            tokenContextId: this.config.tokenContextId ?? this.config.agentId,
            maxIterations: this.config.maxIterations,
            modelId: this.config.modelId,
            providerId: this.config.providerId,
            baseUrl: this.config.baseUrl,
            workdir: this.config.workdir,
            // MB/SA 分离规则，传递给各自的处理器
            mbAgentRules: this.config.mbAgentRules,
            saAgentRules: this.config.saAgentRules,
            // 项目路径（方案B），透传到 StateHandlers → MasterBrainInputBuilder
            projectPath: this.config.projectPath,
            sandboxMode: this.config.sandboxMode,
        };

        const sharedState: HandlerSharedState = {
            terminationReason: this.terminationReason,
            lastLLMContent: this.lastLLMContent,
            pendingSubAgentSpec: this.pendingSubAgentSpec,
            lastActionMadeProgress: this.lastActionMadeProgress,
            lastActionSpawnedSubAgent: this.lastActionSpawnedSubAgent,
            currentToolCalls: this.currentToolCalls,
            cancelled: this.cancelled,
            abortSignal: this.abortController.signal,
            externalGuideSkills: this.externalGuideSkills,
            externalScriptSkills: this.externalScriptSkills,
            spawnCount: this.spawnCount,
            pendingImageAttachments: this.pendingImageAttachments,
            savedAttachmentPaths: this.savedAttachmentPaths,
            pendingPairedHistoryMessages: this.pendingPairedHistoryMessages,
            pendingExperiences: [...this.pendingExperiences],
            taskExperiences: this.taskExperiences,
            lastMBRationale: this.lastMBRationale,
            lastMBTask: this.lastMBTask,
            lastSAObservations: this.lastSAObservations,
            saObservationsSummaries: [...this.saObservationsSummaries],
            mbDecisionLog: [...this.mbDecisionLog],
        };

        const { decisionMapper, masterBrainInputBuilder, subAgentDispatcher } = this;
        if (!decisionMapper || !masterBrainInputBuilder || !subAgentDispatcher) {
            throw new Error('AgentLoopFSMIntegration dependencies are not initialized');
        }

        const dependencies: HandlerDependencies = {
            masterBrain: this.masterBrain,
            decisionMapper,
            masterBrainInputBuilder,
            subAgentDispatcher,
            loopGovernor: this.loopGovernor,
            tracer: this.tracer,
            session: this.dependencies.session,
            callbacks: this.config.callbacks,
            fsmEngine: this.fsmEngine,
            // Checkpoint 回调工厂（动态 Loop 模式使用）
            createCheckpointHandler: (spec: SubAgentSpec) =>
                this.createCheckpointHandler(spec),
            // 技能语义检索（用于 MB 决策后的二次检索补充）
            getExternalGuideSkills: this.dependencies.getExternalGuideSkills,
            // Script 技能精确匹配（用于 external_skill_execute 注入）
            getExternalScriptSkills: this.dependencies.getExternalScriptSkills,
            // 已安装技能目录（静态全量，用于 MasterBrainInputBuilder）
            getInstalledSkillCatalog: this.dependencies.getInstalledSkillCatalog,
            getInstalledScriptSkillCatalog: this.dependencies.getInstalledScriptSkillCatalog,
            // 任务经验直写回调（由 MemoryService 提供）
            saveTaskExperience: this.dependencies.saveTaskExperience,
        };

        return { config, sharedState, dependencies };
    }

    /**
     * 同步共享状态回主类字段
     *
     * Direct Property Synchronization 模式
     * 注意：cancelled 标志由外部 cancel() 方法控制，不应被覆盖
     */
    private syncSharedState(sharedState: HandlerSharedState): void {
        this.terminationReason = sharedState.terminationReason;
        this.lastLLMContent = sharedState.lastLLMContent;
        this.pendingSubAgentSpec = sharedState.pendingSubAgentSpec;
        this.lastActionMadeProgress = sharedState.lastActionMadeProgress;
        this.lastActionSpawnedSubAgent = sharedState.lastActionSpawnedSubAgent;
        this.currentToolCalls = sharedState.currentToolCalls;
        this.externalGuideSkills = sharedState.externalGuideSkills;
        this.externalScriptSkills = sharedState.externalScriptSkills;
        this.spawnCount = sharedState.spawnCount;
        this.pendingExperiences = sharedState.pendingExperiences;
        this.taskExperiences = sharedState.taskExperiences;
        this.lastMBRationale = sharedState.lastMBRationale;
        this.lastMBTask = sharedState.lastMBTask;
        this.lastSAObservations = sharedState.lastSAObservations;
        this.saObservationsSummaries = sharedState.saObservationsSummaries;
        this.forceTerminationContent = sharedState.forceTerminationContent;
        this.mbDecisionLog = sharedState.mbDecisionLog;

        // 同步 SA 推理结论摘要到 MasterBrainInputBuilder，
        // 下一轮 MB 决策的 build() 将自动包含 taskArtifactObservations
        this.masterBrainInputBuilder?.setSaObservationsSummaries(
            this.saObservationsSummaries
        );
        // 同步上一轮 MB 决策摘要到 MasterBrainInputBuilder，
        // 下一轮 MB 决策的 build() 将自动包含 [LAST_MB_DECISION] 区块
        this.masterBrainInputBuilder?.setLastMBDecision(
            this.lastMBRationale,
            this.lastMBTask
        );
        // 同步 MB 决策历史日志到 InputBuilder，
        // 下一轮 MB 决策的 build() 将自动包含 [MB_DECISION_HISTORY] 区块
        this.masterBrainInputBuilder?.setMbDecisionLog(this.mbDecisionLog);
        // 同步 MB 剩余决策预算到 InputBuilder（供 MasterBrain 透传至 generate() 注入 messages 尾部警告）
        // syncSharedState 在每个 handler 执行完毕后调用（含 EVALUATE），
        // 因此 MASTER_DECISION 被调用前，此处读到的是上一轮 EVALUATE 递减后的最新值。
        const budgetSnapshot = this.loopGovernor.getSnapshot();
        this.masterBrainInputBuilder?.setMbBudget(budgetSnapshot.budgetRemaining);
        // pendingImageAttachments 使用 dirty flag 保护：
        // setImageAttachments() 在 handler 执行期间更新 class field，
        // 此时 sharedState 是旧快照（undefined），不应覆盖。
        // DISPATCH 处理器清除时 dirty=false，正常同步。
        if (!this.pendingImageAttachmentsDirty) {
            this.pendingImageAttachments = sharedState.pendingImageAttachments;
            this.savedAttachmentPaths = sharedState.savedAttachmentPaths;
        }
        this.pendingImageAttachmentsDirty = false;
        // pendingPairedHistoryMessages 同样使用 dirty flag 保护：
        // setPairedHistoryMessages() 在 handler 执行期间更新 class field，
        // DISPATCH 消费后清空时 dirty=false，正常同步。
        if (!this.pendingPairedHistoryMessagesDirty) {
            this.pendingPairedHistoryMessages = sharedState.pendingPairedHistoryMessages;
        }
        this.pendingPairedHistoryMessagesDirty = false;
        // 注意：不同步 cancelled，它由外部 cancel() 方法控制
    }

    /**
     * 记录状态转移到 Tracer
     */
    private recordTrace(state: AgentServiceState, event: FSMEvent): void {
        if (!this.tracer.isSessionActive()) {
            return;
        }

        const snapshot = this.loopGovernor.getSnapshot();

        this.tracer.record({
            iteration: this.fsmEngine.getTrace().length + 1,
            fromState: state,
            toState: this.fsmEngine.currentState,
            event,
            actionsExecuted: [],
            budgetSnapshot: {
                remaining: snapshot.budgetRemaining,
                risk: snapshot.riskScore,
                progress: snapshot.consecutiveNoProgress === 0,
            },
            duration: 0,
        });
    }

    /**
     * 映射终止原因到 TraceOutcome
     */
    private mapTerminationToOutcome(reason: TerminationReason): TraceOutcome {
        switch (reason) {
            case 'text_response':
            case 'awaiting_interaction':
                return 'success';
            case 'cancelled':
                return 'cancelled';
            case 'max_iterations':
            case 'budget_exhausted':
                return 'timeout';
            case 'error':
            default:
                return 'error';
        }
    }

    // ==========================================================================
    // Checkpoint 回调工厂（动态 Loop 模式）
    // ==========================================================================

    /**
     * 创建 Checkpoint 回调处理器
     *
     * 当 Sub-Agent 达到 Checkpoint 时调用此回调，
     * 向 Master Brain 汇报进度并等待决策。
     *
     * @param spec - 完整的 Sub-Agent 规格（用于 Master Brain 理解任务全貌）
     * @returns Checkpoint 回调函数
     */
    private createCheckpointHandler(spec: SubAgentSpec): CheckpointCallback {
        return async (report: ProgressReport, _spec: SubAgentSpec): Promise<CheckpointDecision> => {
            // Sub-Agent 进度报告日志（含 trigger 类型信息）
            logger.debug('[Checkpoint] Sub-Agent 进度报告:', {
                role: spec.role.substring(0, 60) + (spec.role.length > 60 ? '...' : ''),
                iteration: report.completedIterations,
                budget: report.remainingBudget,
                confidence: `${(report.confidenceLevel * 100).toFixed(0)}%`,
                trigger: report.checkpointTrigger ?? 'unknown',
            });
            logger.trace('[Checkpoint] 待评估高风险操作:', report.pendingHighRiskAction?.substring(0, 80) ?? 'none');

            // 1. 检查 LLM 服务是否可用
            if (!this.dependencies?.llmService) {
                logger.warn('[Checkpoint] LLM 服务不可用，默认终止');
                return {
                    type: 'TERMINATE_SUB_AGENT',
                    reason: 'LLM service not available',
                };
            }

            // 2. 构建评估 Prompt
            // Checkpoint MB 只需判断「批准/拒绝/延展预算」，不需要看 artifact 原始内容。
            // 只传轻量索引（工具名 + 来源），避免 artifact 内容加上 spec.role 导致 systemPrompt 暴涨。
            // 完整 artifact 数据已由 SubAgentPromptBuilder 注入 SA prompt，无需在 Checkpoint 层重复。
            const promptBuilder = new MasterBrainPrompt();
            const artifactIndexOnly = this.artifactStore.isEmpty() ? undefined : (() => {
                const fullSnapshot = this.artifactStore.getSnapshot(0);
                // 只传 index，不传 artifacts 原始内容（避免上下文膨胀）
                return { artifacts: [], index: fullSnapshot.index, totalTokens: 0 };
            })();
            const prompt = promptBuilder.buildCheckpointEvaluationPrompt(
                report,
                spec,
                artifactIndexOnly
            );

            // 3. 构建 Checkpoint 专用的任务上下文
            // 仅传递 MB 下发的 task spec，不混入原始用户消息或 SA 工具结果
            // 这确保 Checkpoint MB 只看到"评估者"角色的上下文
            const taskContext = [
                '## Original Task Assignment (from Master Brain)',
                '',
                `**Task**: ${spec.role}`,
                spec.contextSummary ? `**Context**: ${spec.contextSummary}` : '',
                '',
                'Based on the progress report in the system prompt, please evaluate and output your JSON decision.',
            ].filter(Boolean).join('\n');

            // 4. 打印完整上下文日志（方便排查角色漂移问题）
            // estimatedTokens 使用与 SA 相同的启发式算法（中文 1.5 字符/token，英文 4 字符/token）
            const fullContext = prompt + taskContext;
            const chineseChars = (fullContext.match(/[\u4e00-\u9fa5]/g) ?? []).length;
            const estimatedCheckpointTokens = Math.ceil(chineseChars / 1.5) + Math.ceil((fullContext.length - chineseChars) / 4);
            logger.trace(
                '[Checkpoint] 📋 Checkpoint LLM 完整上下文:',
                {
                    systemPromptLength: prompt.length,
                    taskContextLength: taskContext.length,
                    // 与 SA 的 "本轮发送: N tokens" 同口径，方便对比
                    estimatedTokens: estimatedCheckpointTokens,
                    // 关键：确认上下文隔离——不应有 Session messages
                    mode: 'OfflineIsolated (skipSessionMessages=true)',
                    checkpointTrigger: report.checkpointTrigger ?? 'unknown',
                }
            );
            // 打印完整 system prompt（确认 Checkpoint MB 接收到的评估内容）
            logger.trace('[Checkpoint] 📄 System Prompt (完整内容):\n', prompt);
            // 打印 taskContext（确认传递了主 MB 下发的 task 描述）
            logger.trace('[Checkpoint] 📝 Task Context (user message):\n', taskContext);

            // 5. 调用 LLM 进行评估（隔离模式：不拼接 Session messages）
            const llmResponse = await this.dependencies.llmService.generate(prompt, {
                temperature: PLANNING_CONSTANTS.MASTER_BRAIN_TEMPERATURE,
                skipSessionMessages: true,
                taskContext,
            });

            // 6. 解析决策
            const decision = parseCheckpointDecision(llmResponse);
            logger.debug('[Checkpoint] Master Brain 决策:', decision.type,
            decision.type === 'ADJUST_STRATEGY' ? `(+${(decision as { additionalIterations?: number }).additionalIterations ?? 0} 轮)` : '');

            return decision;
        };
    }

    // ==========================================================================
    // SubAgent 工具执行适配器
    // ==========================================================================

    /**
     * 创建 SubAgent 专用工具执行函数
     *
     * 包装原始的 executeTool 回调，添加 isSubAgentContext 标识。
     * 这使得 file_write 工具在 SubAgent 模式下跳过用户授权确认，
     * 避免阻断动态循环执行流程。
     *
     * @param originalExecuteTool - 原始工具执行函数
     * @returns 设置了 isSubAgentContext 的工具执行函数
     */
    private createSubAgentToolExecutor(
        originalExecuteTool: FSMIntegrationDependencies['executeTool']
    ): FSMIntegrationDependencies['executeTool'] {
        return async (toolCall: ToolCallInfo, options?: ToolExecuteOptions): Promise<ToolExecutionResult> => {
            logger.debug('[AgentLoopFSMIntegration] SubAgent 工具执行:', toolCall.name);
            const effectiveWorkdir = options?.workdirOverride ?? this.config.projectPath ?? this.config.workdir;
            const sandboxRoots = options?.sandboxRoots ?? [
                effectiveWorkdir,
                this.config.projectPath ? this.config.workdir : undefined,
            ].filter((root): root is string => Boolean(root));

            // 调用原始执行函数，传递 isSubAgentContext: true
            const result = await originalExecuteTool(toolCall, {
                isSubAgentContext: true,
                workdirOverride: effectiveWorkdir,
                sandboxRoots,
                signal: options?.signal ?? this.abortController.signal,
            });

            return result;
        };
    }

}
