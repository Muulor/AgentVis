/**
 * AgentLoop - 嵌入式运行器核心类
 *
 * 实现 LLM 驱动的 Agent 执行循环
 *
 * 架构设计：
 * 1. 每轮循环：组装 Prompt → 调用 LLM → 解析响应 → 执行工具 → 更新历史
 * 2. LLM 驱动决策：代码不预设执行路径，LLM 自主选择工具
 * 3. 完整历史传递：每次 LLM 调用都包含完整对话历史
 * 4. 动态规划：每一步都可能改变后续计划
 *
 * 核心流程：
 * ```
 * while (iteration < maxIterations) {
 *   1. buildPrompt() → 组装 System Prompt + 工具列表
 *   2. callLLM() → 发送消息历史给 LLM
 *   3. parseResponse() → 解析 LLM 响应
 *   4. if (响应是 tool_use) {
 *        executeTool() → 执行工具
 *        将结果加入历史 → 继续循环
 *      } else {
 *        返回文本响应 → 结束循环
 *      }
 * }
 * ```
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import { toolRegistry, initializeTools } from '../tools';
import { normalizeToolCallForExecution } from '../tools/ToolAliases';
import { TOOL_RISK_REGISTRY, DEFAULT_TOOL_RISK } from '../tools/ToolPolicyManager';
import { PLANNING_CONSTANTS } from '../PlanningConstants';
import { skillLoader, type SkillDefinition } from '../skills';
import type { ToolCall, ToolResult, ToolExecutionContext } from '../tools/types';
import type {
  AgentMessage,
  AgentLoopConfig,
  AgentLoopCallbacks,
  AgentLoopResult,
  LoopState,
  TerminationReason,
  LLMResponseWithTools,
  ReasoningTraceEvent,
} from './types';
import type { AgentSession } from './AgentSession';
import {
  AgentLoopFSMIntegration,
  type FSMIntegrationConfig,
  type FSMIntegrationDependencies,
  type ToolCallInfo,
  type ToolExecutionResult,
  type ToolExecuteOptions,
} from './AgentLoopFSMIntegration';
import type { SkillRetriever } from '../skills/external/SkillRetriever';
import type {
  ExternalGuideSkillInfo,
  ExternalScriptSkillCatalogEntry,
  ExternalScriptSkillInfo,
  MemoryItem,
  MemorySnapshot,
} from '../brain/types';
import { useRuntimeStore } from '@stores/runtimeStore';
import { useStatusStore } from '@stores/statusStore';
import { getLogger } from '@services/logger';
import {
  getContextWindowSize,
  modelSupportsVision,
  modelUsesSharedReasoningOutputBudget,
} from '@/config/modelRegistry';
import {
  estimateGeneratedTokens,
  estimateRequestTokens,
  normalizeReportedTokenCount,
} from '@services/llm/tokenEstimator';
import { formatTimestamp } from '@services/utils/TimeUtils';
import type { VisionFallbackMode } from './callers/SubAgentLLMCaller';
import {
  classifyLlmRetry,
  getLlmRetryDelayMs,
  isMaxTokensParameterRejection,
  MASTER_BRAIN_LLM_RETRY_DELAYS_MS,
} from '../utils/LlmRetryPolicy';
import {
  createMbDecisionRetryState,
  tryConsumeMbDecisionRetry,
  type MbDecisionRetryCorrection,
  type MbDecisionRetryReason,
  type MbDecisionRetryState,
} from '../brain/MasterBrainDecisionGuard';
import {
  MbEstimatedTokenCounter,
  MasterBrainReasoningGuard,
  type MbReasoningGuardResult,
  type MbReasoningPreview,
} from '../brain/MasterBrainReasoningGuard';

const logger = getLogger('AgentLoop');

interface AgentLoopLLMMessage {
  role: string;
  content: string;
  images?: unknown;
}

interface ActivePlanningContextUsage {
  contextId: string;
  callId: string;
  estimatedInputTokens: number;
}

type PlanningContextPurpose = 'master-brain' | 'checkpoint';

const DEEPSEEK_V4_MODEL_IDS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const DEEPSEEK_V4_MB_PRE_JSON_RETRY_CHARS = 2600;
const MB_GUARD_CANCEL_GRACE_MS = 1200;
const MB_STREAM_UI_FLUSH_INTERVAL_MS = 64;
const MB_REASONING_GUARD_CHECK_INTERVAL_CHARS = 512;
const MB_REASONING_APPROXIMATE_CHECK_INTERVAL_CHARS = 1024;
const MB_REASONING_DETECTION_WINDOW_CHARS = 16 * 1024;
const REPETITION_SEGMENT_MIN_CHARS = 16;
const REPETITION_SEGMENT_MIN_COUNT = 8;
const REPETITION_SEGMENT_MIN_TOTAL_CHARS = 900;
const MB_TOOL_CALL_ENVELOPE_SCAN_CHARS = 2000;
const MB_TOOL_CALL_ENVELOPE_PATTERN =
  /<\s*\/?\s*(?:tool_call|function(?:_call)?)\b[^>]*>|\[\s*tool_call\s*\]/i;
const MB_TRUNCATED_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'incomplete',
]);

const VISION_UNSUPPORTED_ERROR_PATTERNS = [
  'no endpoints found that support image input',
  'image input',
  'image_url',
  'vision',
  'multi-modal',
  'multimodal',
  'does not support images',
  'unsupported image',
  'failed to read request',
];

function retryErrorFromToolResponse(response: LLMResponseWithTools): unknown {
  return response.type === 'error'
    ? (response.error ?? response.content ?? 'LLM call failed')
    : undefined;
}

class MbEmptyDecisionContentError extends Error {
  readonly retryCorrection: MbDecisionRetryCorrection = { reason: 'empty_content' };

  constructor(reasoningLength: number) {
    super(
      `MB_EMPTY_DECISION_CONTENT: stream finished without final decision content (reasoningLength=${reasoningLength})`
    );
    this.name = 'MbEmptyDecisionContentError';
  }
}

class MbAnomalousDecisionContentError extends Error {
  readonly retryCorrection: MbDecisionRetryCorrection;

  constructor(reason: MbDecisionRetryReason, detail: string, observedLength: number) {
    super(`MB_ANOMALOUS_DECISION_CONTENT: ${detail} (observedLength=${observedLength})`);
    this.name = 'MbAnomalousDecisionContentError';
    this.retryCorrection = { reason, detail };
  }
}

type MbReasoningHardFuseReason = 'reasoning_token_hard_limit' | 'reasoning_time_hard_limit';

class MbReasoningHardFuseError extends Error {
  constructor(
    readonly reason: MbReasoningHardFuseReason,
    readonly detail: string,
    readonly observedLength: number
  ) {
    super(translate('chat.mbReasoningHardLimitFailed'));
    this.name = 'MbReasoningHardFuseError';
  }
}

type MbLocalStreamGuardError = MbAnomalousDecisionContentError | MbReasoningHardFuseError;

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<
  Omit<
    AgentLoopConfig,
    | 'agentId'
    | 'tokenContextId'
    | 'agentName'
    | 'mbAgentRules'
    | 'saAgentRules'
    | 'providerId'
    | 'modelId'
    | 'workdir'
    | 'baseUrl'
    | 'imageAttachments'
    | 'attachmentReferences'
    | 'agentAvatar'
    | 'pinnedSkills'
    | 'imBotId'
    | 'mbDecisionBudget'
    | 'projectPath'
    | 'sandboxMode'
    | 'subAgentSafetyFooterEnabled'
    | 'subAgentSafetyFooterText'
  >
> = {
  maxIterations: PLANNING_CONSTANTS.AGENT_LOOP_MAX_ITERATIONS,
  tokenBudget: PLANNING_CONSTANTS.AGENT_LOOP_TOKEN_BUDGET,
};

/**
 * AgentLoop 核心类
 */
export class AgentLoop {
  /** 配置 */
  private config: AgentLoopConfig;
  /** 回调 */
  private callbacks: AgentLoopCallbacks;
  /** 会话实例（消息历史由此管理） */
  private session: AgentSession;
  /** 当前状态 */
  private state: LoopState = 'idle';
  /** 迭代计数 */
  private iterationCount = 0;
  /** 工具调用计数 */
  private toolCallCount = 0;
  /** 当前会话 ID（用于后端取消） */
  private currentSessionId: string | null = null;
  /** 技能定义列表（用于动态规则生成） */
  private skills: SkillDefinition[] = [];

  /** FSM 集成层实例 */
  private fsmIntegration: AgentLoopFSMIntegration | null = null;

  /** Guide 技能语义检索器（懒初始化） */
  private skillRetriever: SkillRetriever | null = null;
  /** SkillRetriever 初始化 Promise（避免重复初始化） */
  private skillRetrieverInitPromise: Promise<void> | null = null;
  /**
   * embedding 降级时的临时 SkillRetriever 实例（仅 L1 关键词可用）
   *
   * 当 embedding API 不可用时，register() 使用空向量降级，
   * 降级实例存于此字段供当次请求使用，同时 skillRetriever 和 Promise 锁被清零以供下次重试。
   * 用完即清零（ensureSkillRetriever() 末尾处理）。
   */
  private degradedSkillRetriever: SkillRetriever | null = null;
  /** App-managed roots allowed inside OfflineIsolated sandbox modes. */
  private appManagedSandboxRootsPromise: Promise<string[]> | null = null;

  /** 跨轮历史图片是否已透传给 SA（确保只传递一次，避免多轮 MB 迭代重复注入） */
  private hasPassedHistoryImagesToSA = false;

  /**
   * 当前 MB 决策首次调用携带的图片快照。
   *
   * 仅供同一次 MasterBrain.decide() 的解析层纠错重试复用；下一次正常 MB
   * 决策开始时立即清空，避免图片泄漏到后续决策轮次。
   */
  private mbDecisionRetryImageAttachments?: Array<{ mime_type: string; data: string }>;

  private visionFallbackMode: VisionFallbackMode = 'none';

  /**
   * loadChatHistory 加载的历史消息数量（分界线）
   *
   * 用于 createLLMService 中区分"历史消息"和"当轮新增消息"：
   * - 历史消息（index < historyMessageCount）：已由 System Prompt 的 [CONVERSATION_HISTORY] 提供，
   *   不再重复放入 messages 数组，避免上下文膨胀和 keepRounds 预算失效
   * - 当轮消息（index >= historyMessageCount）：当轮 user、MB assistant 决策、SA tool 结果
   * - 例外：带图片的历史 user 消息仍保留在 messages 中（System Prompt 纯文本无法承载图片）
   */
  private historyMessageCount = 0;

  /**
   * 构造函数
   *
   * @param config 配置
   * @param session 会话实例（消息历史由此管理）
   * @param callbacks 回调函数
   */
  constructor(config: AgentLoopConfig, session: AgentSession, callbacks: AgentLoopCallbacks = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.session = session;
    this.callbacks = callbacks;

    // 确保工具已初始化
    initializeTools();

    // 同步获取构建时嵌入的 Native Skills（import.meta.glob eager 模式，立即可用）
    this.skills = skillLoader.getAllSync();
    logger.trace(`[AgentLoop] 同步获取 ${this.skills.length} 个 Native 技能定义`);

    // 异步加载外部技能（External Skills 通过 Guide 模式注入 SA prompt）
    void this.loadSkills();

    // 初始化 FSM 集成层
    this.initializeFSM();
  }

  /**
   * 异步加载外部技能定义
   *
   * 注意：此方法仅负责追加外部技能（External Skills），
   * 不允许覆盖构造函数中 getAllSync() 同步加载的 Native Skills。
   * 这是因为 getToolCatalogEntries() 通过闭包读取 this.skills，
   * 如果此方法失败并重置为 []，会导致 MB 的 TOOL_CATALOG 退化为 tool schema 描述。
   */
  private async loadSkills(): Promise<void> {
    try {
      const allSkills = await skillLoader.loadAllSkills();
      this.skills = allSkills;
      logger.trace(`[AgentLoop] 加载了 ${this.skills.length} 个技能定义（含外部技能）`);
    } catch (error) {
      // 加载失败时保留构造函数中同步加载的 native skills，不覆盖
      logger.warn('[AgentLoop] 外部技能加载失败，保留已有 native skills:', error);
    }
  }

  /**
   * 初始化 FSM 集成层
   */
  private initializeFSM(): void {
    const fsmConfig: FSMIntegrationConfig = {
      agentId: this.config.agentId ?? 'default-agent',
      tokenContextId: this.config.tokenContextId ?? this.config.agentId ?? 'default-agent',
      agentName: this.config.agentName,
      maxIterations: this.config.maxIterations ?? DEFAULT_CONFIG.maxIterations,
      callbacks: this.callbacks,
      // SubAgent LLM 调用需要使用相同的 provider 配置
      modelId: this.config.modelId,
      providerId: this.config.providerId,
      baseUrl: this.config.baseUrl,
      // 工作目录，用于 SubAgent 执行工具时的根目录
      workdir: this.config.workdir,
      // MB/SA 分离的用户自定义规则
      mbAgentRules: this.config.mbAgentRules,
      saAgentRules: this.config.saAgentRules,
      // Agent 头像（用于身份形象感知注入）
      agentAvatar: this.config.agentAvatar,
      // per-agent MB 决策轮次预算（undefined 时由 FSMIntegration 回退到全局默认值）
      mbDecisionBudget: this.config.mbDecisionBudget,
      // 用户关联的外部项目路径（cwd 切换为 projectPath）
      projectPath: this.config.projectPath,
      attachmentReferences: this.config.attachmentReferences,
      sandboxMode: this.config.sandboxMode,
      subAgentSafetyFooterEnabled: this.config.subAgentSafetyFooterEnabled,
      subAgentSafetyFooterText: this.config.subAgentSafetyFooterText,
    };

    this.fsmIntegration = new AgentLoopFSMIntegration(fsmConfig);

    // 注入依赖（Native MasterBrain 模式）
    const dependencies: FSMIntegrationDependencies = {
      session: this.session,
      executeTool: this.createToolAdapter(),
      llmService: this.createLLMService(),
      getMemorySnapshot: this.createMemorySnapshotProvider(),
      getToolCatalog: () => this.getToolCatalogEntries(),
      // RAG 证据：从 Session 的 PreparedContext 中提取
      getRAGEvidence: (_query: string) => Promise.resolve(this.extractRAGEvidenceFromSession()),
      // Guide 技能语义检索：懒初始化 SkillRetriever，按意图 Top-K 检索
      getExternalGuideSkills: async (query: string): Promise<ExternalGuideSkillInfo[]> => {
        // 精准命中模式：跳过语义检索，直接按名称加载绑定技能
        if (this.config.pinnedSkills?.length) {
          const guideSkills = skillLoader.getExternalGuideSkills();
          const pinned = this.config.pinnedSkills
            .map((name) => guideSkills.find((s) => s.name === name))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => ({
              name: s.name,
              description: s.description,
              fullContent: s.fullContent,
              packagePath: s.packagePath,
              scriptFiles: s.scriptFiles,
              resourceFiles: s.resourceFiles,
            }));
          logger.debug('[AgentLoop] 精准命中模式：直接加载绑定技能', {
            requested: this.config.pinnedSkills,
            loaded: pinned.map((s) => s.name),
          });
          return pinned;
        }
        // 默认模式：语义检索
        try {
          const retriever = await this.ensureSkillRetriever();
          if (!retriever) return [];

          const results = await retriever.retrieve(query);
          return results.map((r) => ({
            name: r.skill.name,
            description: r.skill.description,
            fullContent: r.skill.fullContent,
            packagePath: r.skill.packagePath,
            scriptFiles: r.skill.scriptFiles,
            resourceFiles: r.skill.resourceFiles,
          }));
        } catch (error) {
          logger.warn('[AgentLoop] Guide 技能检索失败，降级为空:', error);
          return [];
        }
      },
      // Script 技能精确匹配：不做语义索引，只有明确提到 skillName 时注入
      getExternalScriptSkills: async (query: string): Promise<ExternalScriptSkillInfo[]> => {
        await skillLoader.loadAllSkills();
        const scriptSkills = this.getEnabledExternalScriptSkills();

        const matched = this.config.pinnedSkills?.length
          ? scriptSkills.filter((skill) => this.config.pinnedSkills?.includes(skill.name))
          : this.matchExternalScriptSkillsByName(query, scriptSkills);

        return matched.flatMap((skill): ExternalScriptSkillInfo[] => {
          if (!skill.contract || !skill.packagePath) {
            return [];
          }
          return [
            {
              name: skill.name,
              description: skill.description,
              packagePath: skill.packagePath,
              contract: skill.contract,
              dependencies: skill.dependencies,
            },
          ];
        });
      },
      // 已安装技能目录：静态返回所有启用的 Guide 技能的 name + description
      // 禁用的技能不注入 MB 上下文，减轻上下文压力
      getInstalledSkillCatalog: (): Array<{ name: string; description: string }> => {
        // 精准命中模式：MB 不需要全量技能目录，直接返回空
        if (this.config.pinnedSkills?.length) {
          return [];
        }
        const guideSkills = skillLoader.getExternalGuideSkills();
        // 从 runtimeStore 获取技能开关偏好，过滤禁用的技能
        const { skillEnabledOverrides } = useRuntimeStore.getState();
        return guideSkills
          .filter((s) => skillEnabledOverrides[s.name] ?? true)
          .map((s) => ({
            name: s.name,
            description: s.description,
          }));
      },
      // 已安装 Script 技能目录：静态返回所有启用的 Script 技能轻量元数据
      getInstalledScriptSkillCatalog: (): ExternalScriptSkillCatalogEntry[] => {
        if (this.config.pinnedSkills?.length) {
          return [];
        }
        return this.getEnabledExternalScriptSkills().map((s) => ({
          name: s.name,
          description: s.description,
          networkMode: s.contract?.permissions?.networkMode,
          network: s.contract?.permissions?.network,
          desktopLaunch: s.contract?.permissions?.desktopLaunch,
          desktopControl: s.contract?.permissions?.desktopControl,
        }));
      },
      // 任务经验直写回调：确保 MemoryService 实例存在，将 SA 执行经验写入长期记忆
      // 使用 getOrCreateMemoryService 而非 getCachedMemoryService，
      // 解决首次 Planning 模式下缓存为空导致经验写入被跳过的时序竞态
      saveTaskExperience: async (content: string): Promise<void> => {
        try {
          const { getOrCreateMemoryService } = await import('../../memory/MemoryService');
          const agentId = this.config.agentId ?? 'default-agent';
          // saveTaskExperience 内部调用 FactExtractor.saveFactV2，不涉及 LLM 调用，
          // 传入最小占位 llmService 仅满足 getOrCreateMemoryService 签名
          const noopLlmService = { generate: () => Promise.resolve('') };
          const memoryService = getOrCreateMemoryService(agentId, noopLlmService);
          await memoryService.saveTaskExperience(content);
        } catch (error) {
          logger.warn('[AgentLoop] saveTaskExperience 写入失败:', error);
        }
      },
    };

    this.fsmIntegration.setDependencies(dependencies, this.skills);
    logger.debug('[AgentLoop] FSM 驱动模式已启用（Native MasterBrain）');
  }

  /**
   * 懒初始化 SkillRetriever
   *
   * 首次调用时创建 SkillRetriever 并注册 Guide 模式技能的 embedding 索引。
   * 后续调用直接返回缓存实例。使用 Promise 锁避免并发时重复初始化。
   *
   * 降级策略（embedding API 不可用时）：
   * - register() 内部将所有条目的 embedding 设为空向量（L1 关键词仍可用）
   * - 降级实例存入 degradedSkillRetriever 字段，供当次请求的 L1 关键词检索使用
   * - 同时重置 Promise 锁和正式缓存（skillRetriever），使下次请求可重试完整 embedding 初始化
   */
  private async ensureSkillRetriever(): Promise<SkillRetriever | null> {
    // 精准命中模式不需要初始化 SkillRetriever（节省嵌入计算开销）
    if (this.config.pinnedSkills?.length) {
      return null;
    }
    if (this.skillRetriever) return this.skillRetriever;

    // 使用 Promise 锁避免并发初始化
    this.skillRetrieverInitPromise ??= (async () => {
      try {
        const { createSkillRetriever } = await import('../skills/external/SkillRetriever');
        const retriever = await createSkillRetriever();

        // 确保外部技能已完成加载注册（解决初始化时序竞态）
        // loadAllSkills() 内部调用 externalSkillsInitOnce()，
        // 与构造函数中 loadSkills() 共享同一 Promise 锁，
        // 确保扫描注册完成后才继续
        await skillLoader.loadAllSkills();

        // 从 SkillLoader 获取所有外部技能，注册 Guide 模式的 embedding 索引
        const guideSkills = skillLoader.getExternalGuideSkills();

        logger.trace('[AgentLoop] SkillRetriever 获取到 Guide 技能:', {
          count: guideSkills.length,
          names: guideSkills.map((s) => s.name),
        });

        // 转换 SkillDefinition → LoadedExternalSkill 兼容格式
        // 从 runtimeStore 获取技能开关偏好，传递正确的 enabled 状态
        // SkillRetriever.register() 内部会过滤 enabled: false 的技能
        const { skillEnabledOverrides } = useRuntimeStore.getState();
        const loadedSkills = guideSkills.map((s) => ({
          name: s.name,
          description: s.description,
          mode: 'guide' as const,
          packagePath: s.packagePath ?? '',
          fullContent: s.fullContent,
          enabled: skillEnabledOverrides[s.name] ?? true,
          scriptFiles: s.scriptFiles,
          resourceFiles: s.resourceFiles,
        }));

        await retriever.register(loadedSkills);

        const indexSize = retriever.getIndexSize();
        logger.trace('[AgentLoop] SkillRetriever 初始化完成:', {
          indexSize,
        });

        // 检测 embedding 降级状态：有技能条目但所有 embedding 向量为空（embedding API 不可用）。
        // isEmbeddingDegraded() 当且仅当有条目且所有 embedding 都为空向量时返回 true。
        //
        // 降级处理策略（双轨制）：
        // ① 当次请求：将降级实例存入 this.degradedSkillRetriever，L1 关键词检索仍可使用
        // ② 下次请求：重置 Promise 锁（skillRetrieverInitPromise=null）和正式缓存（skillRetriever=null），
        //    使下次 ensureSkillRetriever() 调用重新执行完整的 register()（含 embedding）
        if (retriever.isEmbeddingDegraded()) {
          this.degradedSkillRetriever = retriever; // ① 供当次请求的 return ... ?? 兜底
          this.skillRetrieverInitPromise = null; // ② 允许下次重试
          logger.warn(
            '[AgentLoop] SkillRetriever 处于 embedding 降级状态（仅 L1 关键词可用），下次请求将重试 embedding 初始化'
          );
          return; // 不写入 this.skillRetriever，保留清零状态用于下次重试
        }

        this.skillRetriever = retriever;
      } catch (error) {
        logger.error('[AgentLoop] SkillRetriever 初始化失败:', error);
      }
    })();

    await this.skillRetrieverInitPromise;
    // 优先返回正式缓存；降级时正式缓存为 null，使用 degradedSkillRetriever 兜底（L1 可用）
    const degradedRetriever = this.degradedSkillRetriever;
    const retrieverState = this as unknown as {
      skillRetriever?: SkillRetriever | null;
      degradedSkillRetriever?: SkillRetriever | null;
    };
    const result = retrieverState.skillRetriever ?? degradedRetriever;
    // 降级实例只使用一次后清零，下次调用重新走初始化流程
    if (!retrieverState.skillRetriever && degradedRetriever) {
      this.degradedSkillRetriever = null;
    }
    return result;
  }

  /**
   * 创建 LLM 服务接口
   *
   * 供 MasterBrain 使用的抽象 LLM 调用接口
   */
  private createLLMService(): FSMIntegrationDependencies['llmService'] {
    return {
      generate: async (
        prompt: string,
        options?: {
          maxTokens?: number;
          temperature?: number;
          skipSessionMessages?: boolean;
          taskContext?: string;
          /** MB 剩余预算，由 MasterBrain.callLLM() 透传，用于判断是否在 messages 尾部注入警告 */
          mbBudgetRemaining?: number;
          /** 流式增量回调，LLM 输出过程中实时推送累积内容到 Thought 卡片 */
          onStreamDelta?: (accumulatedContent: string) => void;
          /** provider reasoning_content 流式回调 */
          onReasoningTrace?: (event: ReasoningTraceEvent) => void;
          /** 流式异常与解析异常共用的 MB 语义重试状态 */
          mbDecisionRetryState?: MbDecisionRetryState;
          /** 追加到 messages 尾部的定向纠错原因 */
          mbDecisionCorrection?: MbDecisionRetryCorrection;
        }
      ): Promise<string> => {
        try {
          const callMasterBrainWithRetry = async <T>(
            label: string,
            call: () => Promise<T>,
            getResponseError?: (response: T) => unknown
          ): Promise<T> => {
            let retryCount = 0;
            while (retryCount <= MASTER_BRAIN_LLM_RETRY_DELAYS_MS.length) {
              try {
                const response = await call();
                const responseError = getResponseError?.(response);
                if (responseError !== undefined && responseError !== null) {
                  const retryClassification = classifyLlmRetry(responseError);
                  if (
                    retryClassification.shouldRetry &&
                    retryCount < MASTER_BRAIN_LLM_RETRY_DELAYS_MS.length
                  ) {
                    retryCount++;
                    const waitMs = getLlmRetryDelayMs(retryCount, MASTER_BRAIN_LLM_RETRY_DELAYS_MS);
                    logger.debug(
                      `[AgentLoop] ⏳ ${label} 可重试 API 错误 ` +
                        `(${retryClassification.reason})，等待 ${waitMs}ms 后重试 ` +
                        `(${retryCount}/${MASTER_BRAIN_LLM_RETRY_DELAYS_MS.length})`
                    );
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                  }
                }
                return response;
              } catch (error) {
                if (
                  this.isMbEmptyDecisionContentError(error) ||
                  this.isMbLocalStreamGuardError(error)
                ) {
                  throw error;
                }
                const retryClassification = classifyLlmRetry(error);
                if (
                  retryClassification.shouldRetry &&
                  retryCount < MASTER_BRAIN_LLM_RETRY_DELAYS_MS.length
                ) {
                  retryCount++;
                  const waitMs = getLlmRetryDelayMs(retryCount, MASTER_BRAIN_LLM_RETRY_DELAYS_MS);
                  logger.debug(
                    `[AgentLoop] ⏳ ${label} 可重试 API 异常 ` +
                      `(${retryClassification.reason})，等待 ${waitMs}ms 后重试 ` +
                      `(${retryCount}/${MASTER_BRAIN_LLM_RETRY_DELAYS_MS.length})`
                  );
                  await new Promise((resolve) => setTimeout(resolve, waitMs));
                  continue;
                }
                throw error;
              }
            }
            throw new Error('Master Brain LLM retry loop exhausted unexpectedly');
          };

          // ── Checkpoint 隔离模式（skipSessionMessages=true）──
          // 不拼接 Session messages，仅发送 system prompt + MB task 上下文
          // 避免用户原始消息和工具执行结果污染 Checkpoint 评估角色
          if (options?.skipSessionMessages) {
            const messages = [
              { role: 'system', content: prompt },
              // 以 MB 下发的 task spec 作为唯一任务上下文
              // 确保 Checkpoint MB 理解任务目标但不混淆执行者角色
              {
                role: 'user',
                content:
                  options.taskContext ??
                  'Please evaluate the sub-agent progress and output your JSON decision.',
              },
            ];

            logger.trace(
              '[AgentLoop] 🔒 Checkpoint 隔离模式: messages=2 (system + task context), ' +
                `taskContext 长度=${options.taskContext?.length ?? 0}`
            );

            const response = await callMasterBrainWithRetry(
              'MB Checkpoint',
              () =>
                this.invokeMasterBrainWithContextUsage(messages, 'checkpoint', () =>
                  invoke<LLMResponseWithTools>('llm_chat_with_tools', {
                    request: {
                      messages: this.sanitizeMessagesForIpc(messages),
                      modelId: this.config.modelId,
                      providerId: this.config.providerId,
                      baseUrl: this.config.baseUrl,
                      supportsVision: modelSupportsVision(
                        this.config.modelId ?? '',
                        this.config.providerId
                      ),
                      tools: [], // Checkpoint 评估不使用工具
                      maxTokens: options.maxTokens ?? 4096,
                      temperature: options.temperature,
                    },
                    sessionId: this.currentSessionId,
                  })
                ),
              retryErrorFromToolResponse
            );

            if (response.type === 'text' && response.content) {
              logger.trace(
                '[MasterBrain] Checkpoint LLM 响应:',
                response.content.substring(0, 200)
              );
              return response.content;
            } else if (response.type === 'error') {
              throw new Error(response.error ?? 'Checkpoint LLM call failed');
            }

            logger.warn('[AgentLoop] Checkpoint LLM 响应类型异常:', response.type);
            return '';
          }

          // ── 正常 MB 决策模式（拼接 Session messages）──
          //
          // 历史对话（loadChatHistory 加载的 user/assistant）已由 System Prompt的 [CONVERSATION_HISTORY] 提供（受 keepRounds 预算控制），
          // 因此 messages 数组只需包含"当轮新增消息"，避免重复和预算失效。
          //
          // 例外：带图片的历史 user 消息仍保留（System Prompt 纯文本无法承载 base64 图片）
          if (!options?.mbDecisionCorrection) {
            this.mbDecisionRetryImageAttachments = undefined;
          }

          const sessionMessages = this.session.getMessages();
          const historyBoundary = this.historyMessageCount;
          const mbSupportsVisionInput = modelSupportsVision(
            this.config.modelId ?? '',
            this.config.providerId
          );
          const currentTurnImageMessages = new WeakSet<AgentLoopLLMMessage>();

          const convertedMessages = sessionMessages
            .filter((msg, index) => {
              // 过滤掉空的 assistant 消息（仅含 toolCalls，后端无法处理）
              if (msg.role === 'assistant' && !msg.content.trim()) return false;

              // 跳过历史消息（已由 System Prompt [CONVERSATION_HISTORY] 提供）
              // 例外：带图片的 user/assistant 消息保留（多模态 API 需要在 messages 中传图）
              if (index < historyBoundary) {
                const hasImages = mbSupportsVisionInput && msg.images && msg.images.length > 0;
                if (!hasImages) return false;
              }

              return true;
            })
            .flatMap((msg, index) => {
              // 将工具消息转换为 user 消息（包含执行结果上下文）
              // 注意：LLM API 在纯文本模式（tools:[]）下不支持 role=tool，只能转为 user。
              // 对 SA 最终报告（sub_agent_*）加语义围栏，防止 MB 将其误判为新一轮用户请求，
              // 从而避免 MB 重复派遣 SA 的问题（SA 报告与用户原始请求主题高度相似时最易触发）。
              if (msg.role === 'tool') {
                const toolName = msg.toolName ?? 'unknown_tool';
                // 使用较高阈值以保留足够上下文（约 5000 tokens）
                const MAX_TOOL_OUTPUT = 15000;
                const truncatedContent =
                  msg.content.length > MAX_TOOL_OUTPUT
                    ? msg.content.substring(0, MAX_TOOL_OUTPUT) +
                      '\n\n[Note: content was truncated because it is too long. Make the decision based on the retrieved content. Do not read the same content again.]'
                    : msg.content;
                // SA 报告加双层围栏标识：区分于真实用户输入，避免 MB 混淆
                const isSubAgentReport = toolName.startsWith('sub_agent_');
                const content = isSubAgentReport
                  ? `[SYSTEM: The following is the execution completion report from Sub-Agent (${toolName}), not a user message. Make your decision based on this report.]\n${truncatedContent}\n[END_SA_REPORT]`
                  : `[Tool execution result - ${toolName}]\n${truncatedContent}`;
                return [
                  {
                    role: 'user' as const,
                    content,
                  },
                ];
              }
              // 透传 user 消息的图片附件（跨轮图片上下文恢复）
              // images 来自 Session 中 loadChatHistory 加载的历史 user 消息
              if (
                mbSupportsVisionInput &&
                msg.role === 'user' &&
                msg.images &&
                msg.images.length > 0
              ) {
                // 转换为 camelCase 格式（后端 ToolChatMessage 的 ImageAttachment 使用 mimeType）
                const camelCaseImages = msg.images.map((img) => ({
                  mimeType: img.mime_type,
                  data: img.data,
                }));
                const isHistoricalImageMessage = index < historyBoundary;
                const convertedMessage = {
                  role: msg.role,
                  content: isHistoricalImageMessage
                    ? this.buildHistoricalUserImageMessageContent(
                        msg.content,
                        msg.createdAt,
                        camelCaseImages.length
                      )
                    : msg.content,
                  images: camelCaseImages,
                };
                if (index >= historyBoundary) {
                  currentTurnImageMessages.add(convertedMessage);
                }
                return [convertedMessage];
              }
              // assistant 消息携带的生成图片（跨轮：SA 生成的图片注入上下文）
              // 后端 LLM 适配器只处理 user 消息的 images 字段，
              // 因此将 assistant 消息拆分为：(1) 原始文本 + (2) 合成 user 消息携带图片
              if (
                mbSupportsVisionInput &&
                msg.role === 'assistant' &&
                msg.images &&
                msg.images.length > 0
              ) {
                const camelCaseImages = msg.images.map((img) => ({
                  mimeType: img.mime_type,
                  data: img.data,
                }));
                return [
                  // 原始 assistant 回复文本
                  { role: 'assistant' as const, content: msg.content },
                  // 合成 user 消息：携带图片供 LLM 多模态理解
                  {
                    role: 'user' as const,
                    content: translate('planning.masterBrain.historicalGeneratedImageReference'),
                    images: camelCaseImages,
                  },
                ];
              }
              return [
                {
                  role: msg.role,
                  content: msg.content,
                },
              ];
            });

          // ── Round 2+ 用户原始消息替换 ──
          // 检测到 SA 完成报告（[END_SA_REPORT]）后，将第一条裸用户消息整体替换为纯决策引导消息，彻底消除原始指令的语义引力。
          // 用户原始意图已在 system prompt 的 [USER_INTENT] 中完整保留（数据来源独立，
          // 由 MasterBrainInputBuilder.build() 在更早阶段从 session 直接读取原始内容），
          // 因此 messages 层无需再重复呈现裸指令，避免 LLM 产生「需要再次执行」的惯性。
          const hasSAReports = convertedMessages.some(
            (m) => m.role === 'user' && m.content.includes('[END_SA_REPORT]')
          );
          if (hasSAReports) {
            const firstBareUserMsg = convertedMessages.find(
              (m) => m.role === 'user' && !m.content.startsWith('[SYSTEM:')
            );
            if (firstBareUserMsg) {
              // 整体替换（= 而非 +=），保留 images 字段不受影响
              firstBareUserMsg.content =
                '[SYSTEM: The latest Sub-Agent completion report is below. Review your previous-round decision and make a decision based on the report result:\n' +
                'If the task is complete or blocked, choose RESPOND_TO_USER directly and report to the user;\n' +
                'If the next phase must continue, explain the reason in rationale and then choose SPAWN_SUB_AGENT.]';
              logger.trace('[AgentLoop] ✅ 已替换用户原始消息为决策引导（检测到 SA 报告）');
            }
          }

          logger.trace(
            `[AgentLoop] 📊 messages 数组: ${convertedMessages.length} 条（Session 总量 ${sessionMessages.length}, 历史跳过 ${historyBoundary}）`
          );

          const messages: AgentLoopLLMMessage[] = [
            { role: 'system', content: prompt },
            // Agent 形象感知注入：紧跟 system prompt 之后以合成 user 消息方式插入 avatar 图片
            // 三大 Provider（Gemini/OpenAI/Anthropic）的 system 消息均不稳定支持图片，
            // 但所有 Provider 的 user 消息均完整支持多模态，虚拟 user 消息是最兼容的方案
            ...(mbSupportsVisionInput ? this.buildAvatarIdentityMessage() : []),
            ...convertedMessages,
          ];

          // ── MB 预算警告注入 ──
          // 当预算剩余 <= MB_BUDGET_WARNING_THRESHOLD 时，在 messages 末尾追加合成 user 消息，
          // 此位置是整个 context 中 LLM 注意力最集中的位置，警告效果远优于 system prompt P1 区。
          // 类比「已执行」标记和 SA SAFETY_FOOTER_TEXT 的同一设计姿势。
          const budgetWarningContent = this.buildMbBudgetWarningMessage(options?.mbBudgetRemaining);
          if (budgetWarningContent) {
            messages.push({ role: 'user', content: budgetWarningContent });
            logger.trace(
              `[AgentLoop] ⚠️ MB 预算警告已注入 messages 尾部 (budgetRemaining=${options?.mbBudgetRemaining ?? 'unknown'})`
            );
          }

          // 将图片附件注入到当轮 user 消息（messages 数组中最后一条 user 消息）
          //
          // 设计原因：
          // - 历史轮次的图片已通过 patchSessionMessageImages 写入各自的 Session 消息，
          //   并随 convertedMessages 绑定到对应的历史 user 消息，形成精准配对。
          // - 当轮新图片必须附在最后一条 user 消息（当轮请求）上，而非 firstUserMsg，
          //   否则多轮场景下 firstUserMsg 可能已是携带历史图片的前序消息，
          //   导致"已有 images"检查跳过注入，新图片无法传递给 MB。
          // - 采用 append 而非替换：理论上当轮 user 消息不应已有 images，
          //   但使用 append 保证在极端情况下不丢失既有数据。
          const pendingImageAttachments = this.config.imageAttachments;
          const retryImageAttachments = options?.mbDecisionCorrection
            ? this.mbDecisionRetryImageAttachments
            : undefined;
          const decisionImageAttachments = pendingImageAttachments?.length
            ? pendingImageAttachments
            : retryImageAttachments;
          const isDecisionRetryImageReuse =
            !pendingImageAttachments?.length && Boolean(retryImageAttachments?.length);

          if (decisionImageAttachments?.length) {
            // llm_chat_with_tools 后端 ImageAttachment 使用 camelCase（mimeType），
            // 而 imageAttachments 来源于 llm_chat_stream 的 snake_case 格式（mime_type），
            // 这里做格式转换以确保反序列化正确
            const camelCaseImages = decisionImageAttachments.map((img) => ({
              mimeType: img.mime_type,
              data: img.data,
            }));

            // 找当轮 user 消息（最后一条），而非第一条
            if (mbSupportsVisionInput) {
              const userMessages = messages.filter((m) => m.role === 'user');
              const currentUserMsg = userMessages[userMessages.length - 1];
              if (currentUserMsg) {
                const existing = (currentUserMsg as unknown as Record<string, unknown>).images as
                  | typeof camelCaseImages
                  | undefined;
                // append 模式：保留既有图片，追加新图片（极端容错）
                (currentUserMsg as unknown as Record<string, unknown>).images = existing
                  ? [...existing, ...camelCaseImages]
                  : camelCaseImages;
                currentTurnImageMessages.add(currentUserMsg);
                logger.trace(
                  '[AgentLoop] 📷 已注入',
                  camelCaseImages.length,
                  '张图片到当轮 user 消息'
                );
              }
            } else {
              logger.warn('[AgentLoop] MB 模型标记为不支持视觉输入，跳过当轮 images 注入:', {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                imageCount: camelCaseImages.length,
              });
            }

            if (!isDecisionRetryImageReuse) {
              this.mbDecisionRetryImageAttachments = decisionImageAttachments.map((image) => ({
                ...image,
              }));

              // 缓存图片到系统临时目录并透传给 SA
              // 必须 await：确保 fsmIntegration.setImageAttachments() 在 MB LLM 调用前完成，
              // 否则 DISPATCH 触发时 pendingImageAttachments 仍为 undefined
              try {
                await this.saveAndPassImagesToSA(camelCaseImages);
              } catch (saveErr: unknown) {
                logger.warn('[AgentLoop] 图片持久化/透传失败（不影响 MB 调用）:', saveErr);
              }

              // 清除一次性配置引用；解析层纠错通过专用快照复用。
              this.config.imageAttachments = undefined;
            } else {
              logger.trace('[AgentLoop] 📷 MB 解析层纠错重试沿用当轮图片:', {
                imageCount: camelCaseImages.length,
                reason: options?.mbDecisionCorrection?.reason,
              });
            }
          } else if (!this.hasPassedHistoryImagesToSA) {
            // 跨轮图片透传给 SA（配对模式）：当轮没有新图片时，从 Session 历史 user 消息提取
            // 与 MB convertedMessages 对齐：图片绑定到各自原始消息，而非堆在首条消息
            //
            // 窗口限制：只取 keepRounds（10 轮）内的消息，与 MB [CONVERSATION_HISTORY] 对齐，
            // 避免全量历史的 46 张图片全部透传给 SA（实际有效的只有最近 16 张）
            const keepRounds = PLANNING_CONSTANTS.MASTER_BRAIN_HISTORY_KEEP_ROUNDS;
            const historyWindowStart = Math.max(0, sessionMessages.length - keepRounds * 2);

            // 配对消息类型
            interface PairedMessage {
              role: 'user' | 'assistant';
              content: string;
              images?: Array<{ mimeType: string; data: string }>;
            }
            const pairedMessages: PairedMessage[] = [];

            for (const msg of sessionMessages.slice(historyWindowStart)) {
              if (msg.role === 'user' && msg.images && msg.images.length > 0) {
                // user 消息携带图片：直接配对（图片随文字上下文一起注入）
                pairedMessages.push({
                  role: 'user',
                  content:
                    msg.content ||
                    translate('planning.masterBrain.historicalUserMessagePlaceholder'),
                  images: msg.images.map((img) => ({
                    mimeType: img.mime_type,
                    data: img.data,
                  })),
                });
              } else if (msg.role === 'assistant' && msg.images && msg.images.length > 0) {
                // assistant 消息携带图片（generate_image 产物）：
                // 后端 LLM 适配器只处理 user 消息的 images 字段，
                // 拆分为原始 assistant 文本 + 合成 user 消息携带图片（与 MB convertedMessages 保持一致）
                pairedMessages.push({
                  role: 'assistant',
                  content: msg.content,
                });
                pairedMessages.push({
                  role: 'user',
                  content: translate('planning.masterBrain.historicalGeneratedImageReference'),
                  images: msg.images.map((img) => ({
                    mimeType: img.mime_type,
                    data: img.data,
                  })),
                });
              }
            }

            if (pairedMessages.length > 0) {
              // 仅缓存历史图片到系统临时目录，避免把运行期图片缓存混入工作区附件列表
              // 不走 setImageAttachments 路径（那是扁平 pendingImageAttachments 专用）
              const allImages = pairedMessages.flatMap((m) => m.images ?? []);
              try {
                await this.saveImagesToTempCache(allImages);
              } catch (saveErr: unknown) {
                logger.warn('[AgentLoop] 跨轮图片缓存失败（不影响配对透传）:', saveErr);
              }

              // 通过配对路径传递给 FSMIntegration（DISPATCH 时注入 SA messages[] 前段）
              this.fsmIntegration?.setPairedHistoryMessages(pairedMessages);
              logger.trace(
                `[AgentLoop] 🖼️ 从 Session 历史提取跨轮图片: 配对模式，${pairedMessages.length} 条消息` +
                  ` (窗口: 最近 ${keepRounds} 轮，消息范围 [${historyWindowStart}, ${sessionMessages.length}))`
              );
            }
            // 标记已处理，避免后续 MB 迭代重复透传
            this.hasPassedHistoryImagesToSA = true;
          }

          if (options?.mbDecisionCorrection) {
            messages.push({
              role: 'user',
              content: this.buildMbDecisionRetryInstruction(options.mbDecisionCorrection),
            });
            logger.warn('[AgentLoop] 已在 MB messages 尾部追加决策协议纠错提示:', {
              providerId: this.config.providerId,
              modelId: this.config.modelId,
              reason: options.mbDecisionCorrection.reason,
            });
          }

          // ── 流式路径（有 onStreamDelta 回调时启用）──
          // 使用 llm_chat_stream + Tauri Event 实现 MB 决策的实时流式输出，
          // 参考 VisualEnhancerService.collectStreamResponse 的成熟模式。
          // 流式过程中通过 onStreamDelta 推送累积内容到 Thought 卡片，
          // 流结束后返回完整 delta 内容供 DecisionParser 解析 JSON。
          let preparedMessages = messages;
          let alreadyStrippedImages = false;
          let appliedFallbackMode: VisionFallbackMode = 'none';
          const imageMessageCount = this.countMessagesWithImages(messages);
          if (imageMessageCount > 0 && !mbSupportsVisionInput) {
            const stripped = this.stripImagesForVisionFallback(messages);
            preparedMessages = stripped.messages;
            alreadyStrippedImages = true;
            appliedFallbackMode = 'strip-all';
            this.setVisionFallbackMode('strip-all');
            logger.warn('[AgentLoop] MB 模型标记为不支持视觉输入，已在调用前移除 images:', {
              providerId: this.config.providerId,
              modelId: this.config.modelId,
              imageMessageCount,
              strippedImageCount: stripped.imageCount,
            });
          } else if (imageMessageCount > 0 && this.visionFallbackMode === 'strip-unmarked') {
            const stripped = this.stripImagesForVisionFallback(messages, {
              preserveMessages: currentTurnImageMessages,
            });
            preparedMessages = stripped.messages;
            alreadyStrippedImages = true;
            appliedFallbackMode = 'strip-unmarked';
            logger.trace(
              '[AgentLoop] 沿用本次请求已确认的视觉 fallback 策略：移除历史 images，保留当前轮 images',
              {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                strippedImageCount: stripped.imageCount,
              }
            );
          } else if (imageMessageCount > 0 && this.visionFallbackMode === 'strip-all') {
            const stripped = this.stripImagesForVisionFallback(messages);
            preparedMessages = stripped.messages;
            alreadyStrippedImages = true;
            appliedFallbackMode = 'strip-all';
            logger.trace('[AgentLoop] 沿用本次请求已确认的视觉 fallback 策略：移除全部 images', {
              providerId: this.config.providerId,
              modelId: this.config.modelId,
              strippedImageCount: stripped.imageCount,
            });
          }

          if (options?.onStreamDelta) {
            const onStreamDelta = options.onStreamDelta;
            const onReasoningTrace = options.onReasoningTrace;
            const finalDecisionMaxTokens =
              options.maxTokens ?? PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS;
            let activeTransportMaxTokens = this.getMbTransportMaxTokens(finalDecisionMaxTokens);
            let transportFallbackUsed = false;
            const temperature = options.temperature;
            const semanticRetryState = options.mbDecisionRetryState ?? createMbDecisionRetryState();
            const collectWithTransportFallback = async (
              messagesForCall: AgentLoopLLMMessage[]
            ): Promise<string> => {
              const collect = () =>
                callMasterBrainWithRetry('MB stream', () =>
                  this.collectMBStreamResponse(
                    messagesForCall,
                    onStreamDelta,
                    activeTransportMaxTokens,
                    finalDecisionMaxTokens,
                    temperature,
                    onReasoningTrace
                  )
                );

              try {
                return await collect();
              } catch (streamError) {
                const fallbackMaxTokens =
                  transportFallbackUsed || !this.isMbMaxTokensParameterRejection(streamError)
                    ? null
                    : this.getMbTransportFallbackMaxTokens(
                        activeTransportMaxTokens,
                        finalDecisionMaxTokens
                      );
                if (fallbackMaxTokens === null) {
                  throw streamError;
                }

                const rejectedMaxTokens = activeTransportMaxTokens;
                activeTransportMaxTokens = fallbackMaxTokens;
                transportFallbackUsed = true;
                logger.warn(
                  '[AgentLoop] MB transport token 参数被 provider 拒绝，降低预算后重试一次:',
                  {
                    providerId: this.config.providerId,
                    modelId: this.config.modelId,
                    rejectedMaxTokens,
                    fallbackMaxTokens,
                    error: streamError instanceof Error ? streamError.message : String(streamError),
                  }
                );
                return await collect();
              }
            };
            const collectMbDecisionStream = async (
              messagesForCall: AgentLoopLLMMessage[]
            ): Promise<string> => {
              try {
                return await collectWithTransportFallback(messagesForCall);
              } catch (streamError) {
                if (!this.isMbRetryableDecisionContentError(streamError)) {
                  throw streamError;
                }

                const correction = this.getMbDecisionRetryCorrection(streamError);
                if (
                  !correction ||
                  !tryConsumeMbDecisionRetry(semanticRetryState, correction.reason)
                ) {
                  throw new Error(this.getMbDecisionRetryFailedMessage(correction));
                }

                logger.warn('[AgentLoop] MB 流式调用返回不可执行决策正文，追加强约束后重试一次:', {
                  providerId: this.config.providerId,
                  modelId: this.config.modelId,
                  kind: correction.reason,
                  error: streamError instanceof Error ? streamError.message : String(streamError),
                });

                const retryMessages = this.buildMbDecisionRetryMessages(
                  messagesForCall,
                  correction
                );

                try {
                  return await collectWithTransportFallback(retryMessages);
                } catch (retryError) {
                  if (this.isMbRetryableDecisionContentError(retryError)) {
                    throw new Error(
                      this.getMbDecisionRetryFailedMessage(
                        this.getMbDecisionRetryCorrection(retryError) ?? correction
                      )
                    );
                  }
                  throw retryError;
                }
              }
            };

            try {
              return await collectMbDecisionStream(preparedMessages);
            } catch (streamError) {
              if (
                alreadyStrippedImages &&
                appliedFallbackMode === 'strip-unmarked' &&
                this.hasImages(messages) &&
                this.isVisionUnsupportedError(streamError)
              ) {
                const allStripped = this.stripImagesForVisionFallback(messages);
                logger.warn('[AgentLoop] 沿用保留当前图片策略仍失败，移除全部 images 后重试一次:', {
                  providerId: this.config.providerId,
                  modelId: this.config.modelId,
                  strippedImageCount: allStripped.imageCount,
                  error: String(streamError).slice(0, 240),
                });
                const content = await collectMbDecisionStream(allStripped.messages);
                this.setVisionFallbackMode('strip-all');
                return content;
              }
              if (
                !alreadyStrippedImages &&
                this.hasImages(messages) &&
                this.isVisionUnsupportedError(streamError)
              ) {
                const partial = this.stripImagesForVisionFallback(messages, {
                  preserveMessages: currentTurnImageMessages,
                });
                const stripped =
                  partial.imageCount > 0 ? partial : this.stripImagesForVisionFallback(messages);
                logger.warn(
                  '[AgentLoop] MB 流式调用返回视觉输入不支持，优先移除历史 images 后重试一次:',
                  {
                    providerId: this.config.providerId,
                    modelId: this.config.modelId,
                    strippedImageCount: stripped.imageCount,
                    preservedCurrentImageMessages: partial.imageCount > 0,
                    error: String(streamError).slice(0, 240),
                  }
                );
                try {
                  const content = await collectMbDecisionStream(stripped.messages);
                  this.rememberVisionFallbackMode(partial);
                  return content;
                } catch (partialError) {
                  if (partial.imageCount > 0 && this.isVisionUnsupportedError(partialError)) {
                    const allStripped = this.stripImagesForVisionFallback(messages);
                    logger.warn(
                      '[AgentLoop] MB 保留当前图片重试仍失败，移除全部 images 后再重试一次:',
                      {
                        providerId: this.config.providerId,
                        modelId: this.config.modelId,
                        strippedImageCount: allStripped.imageCount,
                        error: String(partialError).slice(0, 240),
                      }
                    );
                    const content = await collectMbDecisionStream(allStripped.messages);
                    this.setVisionFallbackMode('strip-all');
                    return content;
                  }
                  throw partialError;
                }
              }
              throw streamError;
            }
          }

          // ── 非流式 fallback（无 onStreamDelta 回调 / Checkpoint / 测试场景）──
          // 保持原有的同步 invoke('llm_chat_with_tools') 行为
          // 在发送前清理 messages 中的非法 Unicode 字符（孤立代理字符等），
          // 防止 serde_json 反序列化 ToolChatRequest 时报 "unexpected end of hex escape"
          const finalDecisionMaxTokens =
            options?.maxTokens ?? PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS;
          let activeTransportMaxTokens = this.getMbTransportMaxTokens(finalDecisionMaxTokens);
          let transportFallbackUsed = false;
          const invokeMasterBrainOnce = (messagesForCall: AgentLoopLLMMessage[]) =>
            callMasterBrainWithRetry(
              'MB non-stream',
              () =>
                this.invokeMasterBrainWithContextUsage(messagesForCall, 'master-brain', () =>
                  invoke<LLMResponseWithTools>('llm_chat_with_tools', {
                    request: {
                      messages: this.sanitizeMessagesForIpc(messagesForCall),
                      modelId: this.config.modelId,
                      providerId: this.config.providerId,
                      baseUrl: this.config.baseUrl,
                      supportsVision: modelSupportsVision(
                        this.config.modelId ?? '',
                        this.config.providerId
                      ),
                      tools: [], // MasterBrain 决策不使用工具
                      maxTokens: activeTransportMaxTokens,
                      temperature: options?.temperature,
                    },
                    sessionId: this.currentSessionId,
                  })
                ),
              retryErrorFromToolResponse
            );
          const applyTransportFallback = (error: unknown): boolean => {
            const fallbackMaxTokens =
              transportFallbackUsed || !this.isMbMaxTokensParameterRejection(error)
                ? null
                : this.getMbTransportFallbackMaxTokens(
                    activeTransportMaxTokens,
                    finalDecisionMaxTokens
                  );
            if (fallbackMaxTokens === null) return false;

            const rejectedMaxTokens = activeTransportMaxTokens;
            activeTransportMaxTokens = fallbackMaxTokens;
            transportFallbackUsed = true;
            logger.warn(
              '[AgentLoop] MB non-stream token 参数被 provider 拒绝，降低预算后重试一次:',
              {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                rejectedMaxTokens,
                fallbackMaxTokens,
                error: error instanceof Error ? error.message : String(error),
              }
            );
            return true;
          };
          const invokeMasterBrain = async (
            messagesForCall: AgentLoopLLMMessage[]
          ): Promise<LLMResponseWithTools> => {
            const invokeOnce = () => invokeMasterBrainOnce(messagesForCall);
            try {
              const response = await invokeOnce();
              const responseError = retryErrorFromToolResponse(response);
              return responseError !== undefined && applyTransportFallback(responseError)
                ? await invokeOnce()
                : response;
            } catch (error) {
              if (!applyTransportFallback(error)) throw error;
              return await invokeOnce();
            }
          };

          let response: LLMResponseWithTools;
          try {
            response = await invokeMasterBrain(preparedMessages);
          } catch (invokeError) {
            if (
              alreadyStrippedImages &&
              appliedFallbackMode === 'strip-unmarked' &&
              this.hasImages(messages) &&
              this.isVisionUnsupportedError(invokeError)
            ) {
              const allStripped = this.stripImagesForVisionFallback(messages);
              logger.warn('[AgentLoop] 沿用保留当前图片策略仍失败，移除全部 images 后重试一次:', {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                strippedImageCount: allStripped.imageCount,
                error: String(invokeError).slice(0, 240),
              });
              response = await invokeMasterBrain(allStripped.messages);
              this.setVisionFallbackMode('strip-all');
            } else if (
              !alreadyStrippedImages &&
              this.hasImages(messages) &&
              this.isVisionUnsupportedError(invokeError)
            ) {
              const partial = this.stripImagesForVisionFallback(messages, {
                preserveMessages: currentTurnImageMessages,
              });
              const stripped =
                partial.imageCount > 0 ? partial : this.stripImagesForVisionFallback(messages);
              alreadyStrippedImages = true;
              logger.warn(
                '[AgentLoop] MB 调用返回视觉输入不支持，优先移除历史 images 后重试一次:',
                {
                  providerId: this.config.providerId,
                  modelId: this.config.modelId,
                  strippedImageCount: stripped.imageCount,
                  preservedCurrentImageMessages: partial.imageCount > 0,
                  error: String(invokeError).slice(0, 240),
                }
              );
              response = await invokeMasterBrain(stripped.messages);
              this.rememberVisionFallbackMode(partial, response);
              if (
                response.type === 'error' &&
                partial.imageCount > 0 &&
                this.isVisionUnsupportedError(response.error ?? response.content)
              ) {
                const allStripped = this.stripImagesForVisionFallback(messages);
                logger.warn(
                  '[AgentLoop] MB 保留当前图片重试仍失败，移除全部 images 后再重试一次:',
                  {
                    providerId: this.config.providerId,
                    modelId: this.config.modelId,
                    strippedImageCount: allStripped.imageCount,
                    error: (response.error ?? response.content ?? '').slice(0, 240),
                  }
                );
                response = await invokeMasterBrain(allStripped.messages);
                this.setVisionFallbackMode('strip-all');
              }
            } else {
              throw invokeError;
            }
          }

          if (
            response.type === 'error' &&
            alreadyStrippedImages &&
            appliedFallbackMode === 'strip-unmarked' &&
            this.hasImages(messages) &&
            this.isVisionUnsupportedError(response.error ?? response.content)
          ) {
            const allStripped = this.stripImagesForVisionFallback(messages);
            logger.warn(
              '[AgentLoop] 沿用保留当前图片策略仍返回视觉错误，移除全部 images 后重试一次:',
              {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                strippedImageCount: allStripped.imageCount,
                error: (response.error ?? response.content ?? '').slice(0, 240),
              }
            );
            response = await invokeMasterBrain(allStripped.messages);
            this.setVisionFallbackMode('strip-all');
          }

          if (
            response.type === 'error' &&
            !alreadyStrippedImages &&
            this.hasImages(messages) &&
            this.isVisionUnsupportedError(response.error ?? response.content)
          ) {
            const partial = this.stripImagesForVisionFallback(messages, {
              preserveMessages: currentTurnImageMessages,
            });
            const stripped =
              partial.imageCount > 0 ? partial : this.stripImagesForVisionFallback(messages);
            alreadyStrippedImages = true;
            logger.warn('[AgentLoop] MB API 返回视觉输入不支持，优先移除历史 images 后重试一次:', {
              providerId: this.config.providerId,
              modelId: this.config.modelId,
              strippedImageCount: stripped.imageCount,
              preservedCurrentImageMessages: partial.imageCount > 0,
              error: (response.error ?? response.content ?? '').slice(0, 240),
            });
            response = await invokeMasterBrain(stripped.messages);
            this.rememberVisionFallbackMode(partial, response);
            if (
              response.type === 'error' &&
              partial.imageCount > 0 &&
              this.isVisionUnsupportedError(response.error ?? response.content)
            ) {
              const allStripped = this.stripImagesForVisionFallback(messages);
              logger.warn('[AgentLoop] MB 保留当前图片重试仍失败，移除全部 images 后再重试一次:', {
                providerId: this.config.providerId,
                modelId: this.config.modelId,
                strippedImageCount: allStripped.imageCount,
                error: (response.error ?? response.content ?? '').slice(0, 240),
              });
              response = await invokeMasterBrain(allStripped.messages);
              this.setVisionFallbackMode('strip-all');
            }
          }

          if (this.isTruncatedMbFinishReason(response.finishReason)) {
            const contentLength = response.content?.length ?? 0;
            throw new MbAnomalousDecisionContentError(
              'truncated_output',
              `provider finish reason: ${response.finishReason ?? 'unknown'}; ` +
                `finalContentChars=${contentLength}`,
              contentLength
            );
          }

          // 非流式路径同样保持最终决策正文的 8K 本地上限，传输预算只为推理留余量。
          if (response.type === 'text' && response.content) {
            const finalDecisionTokenCounter = new MbEstimatedTokenCounter();
            finalDecisionTokenCounter.append(response.content);
            if (finalDecisionTokenCounter.estimatedTokens > finalDecisionMaxTokens) {
              throw new MbAnomalousDecisionContentError(
                'truncated_output',
                `final decision exceeded the local ${finalDecisionMaxTokens}-token limit ` +
                  `(estimated=${finalDecisionTokenCounter.estimatedTokens})`,
                response.content.length
              );
            }
          }

          // 提取文本响应
          if (response.type === 'text' && response.content) {
            logger.trace('[MasterBrain]  LLM 响应:', response.content);
            return response.content;
          } else if (response.type === 'error') {
            throw new Error(response.error ?? 'LLM call failed');
          }

          logger.warn('[AgentLoop]  LLM 响应类型异常:', response.type);
          return '';
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('[AgentLoop] LLM Service 调用失败:', errorMessage);
          throw error;
        }
      },
    };
  }

  private beginPlanningContextUsage(
    messages: AgentLoopLLMMessage[],
    purpose: PlanningContextPurpose,
    callId: string,
    tools?: unknown
  ): ActivePlanningContextUsage | null {
    // Only Task mode supplies tokenContextId explicitly. Background planning callers
    // such as Skill Audit must not overwrite the foreground task's Current Context.
    const contextId = this.config.tokenContextId;
    if (!contextId) return null;

    const estimatedInputTokens = estimateRequestTokens(
      messages.map((message) => ({
        role: message.role,
        content: message.content,
        images: Array.isArray(message.images) ? message.images : undefined,
      })),
      { tools }
    );
    useStatusStore.getState().beginContextUsage(contextId, {
      callId,
      currentInputTokens: estimatedInputTokens,
      currentOutputTokens: 0,
      contextWindowSize: getContextWindowSize(this.config.modelId ?? '', this.config.providerId),
      purpose,
      providerId: this.config.providerId,
      modelId: this.config.modelId,
    });

    return { contextId, callId, estimatedInputTokens };
  }

  private updatePlanningContextUsage(
    activeUsage: ActivePlanningContextUsage | null,
    patch: { currentInputTokens?: number; currentOutputTokens?: number }
  ): void {
    if (!activeUsage) return;
    useStatusStore.getState().updateContextUsage(activeUsage.contextId, activeUsage.callId, patch);
  }

  private completePlanningContextUsage(
    activeUsage: ActivePlanningContextUsage | null,
    response: {
      content?: string;
      reasoningContent?: string;
      toolCalls?: ToolCall[];
      inputTokens?: number;
      outputTokens?: number;
    } = {}
  ): void {
    if (!activeUsage) return;

    const currentInputTokens =
      normalizeReportedTokenCount(response.inputTokens) ?? activeUsage.estimatedInputTokens;
    const currentOutputTokens =
      normalizeReportedTokenCount(response.outputTokens) ?? estimateGeneratedTokens(response);
    useStatusStore.getState().completeContextUsage(activeUsage.contextId, activeUsage.callId, {
      currentInputTokens,
      currentOutputTokens,
    });
  }

  private async invokeMasterBrainWithContextUsage(
    messages: AgentLoopLLMMessage[],
    purpose: PlanningContextPurpose,
    invokeCall: () => Promise<LLMResponseWithTools>
  ): Promise<LLMResponseWithTools> {
    const callId = `planning-${purpose}-${crypto.randomUUID()}`;
    const activeUsage = this.beginPlanningContextUsage(messages, purpose, callId, []);

    try {
      const response = await invokeCall();
      this.completePlanningContextUsage(activeUsage, response);
      return response;
    } catch (error) {
      // Preserve Last Context between retries/tool execution. The outer Planning
      // finally remains responsible for clearing it when the task truly ends.
      this.completePlanningContextUsage(activeUsage);
      throw error;
    }
  }

  private countMessagesWithImages(messages: AgentLoopLLMMessage[]): number {
    return messages.filter((msg) => Array.isArray(msg.images) && msg.images.length > 0).length;
  }

  private setVisionFallbackMode(mode: VisionFallbackMode): void {
    if (mode === 'none') return;
    if (this.visionFallbackMode === 'strip-all' && mode === 'strip-unmarked') return;
    this.visionFallbackMode = mode;
    this.fsmIntegration?.setVisionFallbackMode(mode);
  }

  private rememberVisionFallbackMode(
    partial: { imageCount: number },
    response?: LLMResponseWithTools
  ): void {
    if (
      response?.type === 'error' &&
      this.isVisionUnsupportedError(response.error ?? response.content)
    ) {
      return;
    }
    this.setVisionFallbackMode(partial.imageCount > 0 ? 'strip-unmarked' : 'strip-all');
  }

  private hasImages(messages: AgentLoopLLMMessage[]): boolean {
    return this.countMessagesWithImages(messages) > 0;
  }

  private isVisionUnsupportedError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error ?? '');
    const normalized = message.toLowerCase();
    return VISION_UNSUPPORTED_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
  }

  private isMbEmptyDecisionContentError(error: unknown): boolean {
    return (
      error instanceof MbEmptyDecisionContentError ||
      (error instanceof Error && error.name === 'MbEmptyDecisionContentError')
    );
  }

  private isMbAnomalousDecisionContentError(error: unknown): boolean {
    return (
      error instanceof MbAnomalousDecisionContentError ||
      (error instanceof Error && error.name === 'MbAnomalousDecisionContentError')
    );
  }

  private isMbReasoningHardFuseError(error: unknown): boolean {
    return (
      error instanceof MbReasoningHardFuseError ||
      (error instanceof Error && error.name === 'MbReasoningHardFuseError')
    );
  }

  private isMbLocalStreamGuardError(error: unknown): boolean {
    return this.isMbAnomalousDecisionContentError(error) || this.isMbReasoningHardFuseError(error);
  }

  private isMbRetryableDecisionContentError(error: unknown): boolean {
    return (
      this.isMbEmptyDecisionContentError(error) || this.isMbAnomalousDecisionContentError(error)
    );
  }

  private getMbDecisionRetryCorrection(error: unknown): MbDecisionRetryCorrection | null {
    if (error instanceof MbEmptyDecisionContentError) {
      return error.retryCorrection;
    }
    if (error instanceof MbAnomalousDecisionContentError) {
      return error.retryCorrection;
    }
    if (this.isMbEmptyDecisionContentError(error)) {
      return { reason: 'empty_content' };
    }
    if (this.isMbAnomalousDecisionContentError(error)) {
      return {
        reason: 'anomalous_content',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return null;
  }

  private getMbDecisionRetryFailedMessage(correction: MbDecisionRetryCorrection | null): string {
    if (correction?.reason === 'empty_content') {
      return translate('chat.mbEmptyDecisionRetryFailed');
    }
    if (correction?.reason === 'tool_call_envelope') {
      return translate('chat.mbToolCallDecisionRetryFailed');
    }
    if (correction?.reason === 'reasoning_transport_truncated') {
      return translate('chat.mbReasoningTransportRetryFailed');
    }
    if (correction?.reason === 'truncated_output') {
      return translate('chat.mbTruncatedDecisionRetryFailed');
    }
    return translate('chat.mbAnomalousDecisionRetryFailed');
  }

  private isDeepSeekV4MbModel(): boolean {
    return DEEPSEEK_V4_MODEL_IDS.has((this.config.modelId ?? '').trim().toLowerCase());
  }

  private getMbTransportMaxTokens(finalDecisionMaxTokens: number): number {
    // Reasoning-capable routes share provider output budget between thinking and
    // the final body. Keep the final decision locally bounded while allowing
    // the reasoning stream enough transport headroom to reach that body.
    const defaultTransportMaxTokens = Math.max(
      finalDecisionMaxTokens,
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS
    );
    if (
      !modelUsesSharedReasoningOutputBudget(this.config.modelId ?? '', this.config.providerId ?? '')
    ) {
      return defaultTransportMaxTokens;
    }

    return Math.max(
      defaultTransportMaxTokens,
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS
    );
  }

  private getMbTransportFallbackMaxTokens(
    currentTransportMaxTokens: number,
    finalDecisionMaxTokens: number
  ): number | null {
    const defaultTransportMaxTokens = Math.max(
      finalDecisionMaxTokens,
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS
    );
    if (currentTransportMaxTokens > defaultTransportMaxTokens) {
      return defaultTransportMaxTokens;
    }
    if (currentTransportMaxTokens > finalDecisionMaxTokens) {
      return finalDecisionMaxTokens;
    }
    return null;
  }

  private isMbMaxTokensParameterRejection(error: unknown): boolean {
    if (this.isMbLocalStreamGuardError(error)) return false;
    return isMaxTokensParameterRejection(error);
  }

  private buildMbDecisionRetryMessages(
    messages: AgentLoopLLMMessage[],
    correction: MbDecisionRetryCorrection
  ): AgentLoopLLMMessage[] {
    return [
      ...messages,
      {
        role: 'user',
        content: this.buildMbDecisionRetryInstruction(correction),
      },
    ];
  }

  private buildMbDecisionRetryInstruction(correction: MbDecisionRetryCorrection): string {
    const reason = (correction.detail ?? correction.reason).slice(0, 500);
    switch (correction.reason) {
      case 'empty_content':
        return translate('chat.mbEmptyDecisionRetryInstruction');
      case 'tool_call_envelope':
        return translate('chat.mbToolCallDecisionRetryInstruction', { reason });
      case 'truncated_output':
      case 'aggressive_repair':
        return translate('chat.mbTruncatedDecisionRetryInstruction', { reason });
      case 'reasoning_transport_truncated':
        return translate('chat.mbReasoningTransportRetryInstruction');
      case 'reasoning_repetition':
        return translate('chat.mbReasoningDecisionRetryInstruction');
      case 'anomalous_content':
        return translate('chat.mbAnomalousDecisionRetryInstruction', { reason });
      default:
        return translate('chat.mbMalformedDecisionRetryInstruction', { reason });
    }
  }

  private stripThinkTags(content: string): string {
    return content
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think\b[^>]*>/gi, '');
  }

  private findLikelyMbDecisionJsonStart(content: string): number {
    const decisionJson = content.match(/\{\s*"decision"\s*:/);
    if (decisionJson?.index !== undefined) {
      return decisionJson.index;
    }

    const fencedJson = content.match(/```(?:json)?\s*\n?\s*\{/i);
    if (fencedJson?.index !== undefined) {
      const braceIndex = content.indexOf('{', fencedJson.index);
      if (braceIndex >= 0 && content.slice(braceIndex).includes('"decision"')) {
        return braceIndex;
      }
    }

    const firstBrace = content.indexOf('{');
    if (firstBrace >= 0 && content.slice(firstBrace).includes('"decision"')) {
      return firstBrace;
    }

    return -1;
  }

  private normalizeDeepSeekV4MbContent(content: string): string {
    const withoutThinkTags = this.stripThinkTags(content);
    const jsonStart = this.findLikelyMbDecisionJsonStart(withoutThinkTags);
    if (jsonStart < 0) {
      return withoutThinkTags.trim();
    }

    return withoutThinkTags.slice(jsonStart).trimStart();
  }

  private buildDeepSeekV4MbDisplayContent(content: string): string | null {
    const normalized = this.normalizeDeepSeekV4MbContent(content);
    if (!normalized) {
      return null;
    }

    if (!/"decision"\s*:/.test(normalized) || !/"rationale"\s*:/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private getUniversalMbProtocolRetryCorrection(content: string): MbDecisionRetryCorrection | null {
    const withoutThinkTags = this.stripThinkTags(content);
    // 只检查 JSON 根对象开始前的协议文本。一旦出现首个 "{"，后续标签可能只是
    // rationale/response 字符串中的字面内容，应交给完整 JSON 解析器处理。
    // 这也确保同一 chunk 中 "伪工具协议 + 决策 JSON" 仍会命中前缀 guard。
    const jsonStart = withoutThinkTags.indexOf('{');
    const scanEnd =
      jsonStart >= 0
        ? jsonStart
        : Math.min(withoutThinkTags.length, MB_TOOL_CALL_ENVELOPE_SCAN_CHARS);
    const prefix = withoutThinkTags.slice(0, scanEnd);
    if (!MB_TOOL_CALL_ENVELOPE_PATTERN.test(prefix)) {
      return null;
    }

    return {
      reason: 'tool_call_envelope',
      detail: 'tool-call/function-call envelope detected before JSON decision',
    };
  }

  private isTruncatedMbFinishReason(finishReason: string | undefined): boolean {
    return (
      finishReason !== undefined &&
      MB_TRUNCATED_FINISH_REASONS.has(finishReason.trim().toLowerCase())
    );
  }

  private getDeepSeekV4MbStreamRetryReason(content: string): string | null {
    const withoutThinkTags = this.stripThinkTags(content);
    const jsonStart = this.findLikelyMbDecisionJsonStart(withoutThinkTags);

    if (jsonStart < 0) {
      const preJsonText = withoutThinkTags.trim();
      if (preJsonText.length >= DEEPSEEK_V4_MB_PRE_JSON_RETRY_CHARS) {
        return 'too much non-JSON text before the decision object';
      }
      if (this.hasPathologicalRepetition(preJsonText)) {
        return 'repeated non-JSON text before the decision object';
      }
      return null;
    }

    const jsonAndTail = withoutThinkTags.slice(jsonStart);
    if (this.hasPathologicalRepetition(jsonAndTail)) {
      return 'pathological repeated text in the decision output';
    }

    return null;
  }

  private getDeepSeekV4MbFinalRetryReason(
    rawContent: string,
    normalizedContent: string
  ): string | null {
    if (!normalizedContent.trim()) {
      return null;
    }

    if (this.findLikelyMbDecisionJsonStart(this.stripThinkTags(rawContent)) < 0) {
      return 'no JSON decision object was found';
    }

    if (!/"decision"\s*:/.test(normalizedContent)) {
      return 'missing decision field in the JSON decision object';
    }

    if (this.hasPathologicalRepetition(normalizedContent)) {
      return 'pathological repeated text in the final decision output';
    }

    return null;
  }

  private hasPathologicalRepetition(content: string): boolean {
    const segments = content
      .split(/(?:\r?\n|[。！？!?]+|[.!?]\s+)/)
      .map((segment) => segment.replace(/\s+/g, ' ').trim())
      .filter((segment) => segment.length >= REPETITION_SEGMENT_MIN_CHARS && segment.length <= 500);

    if (segments.length < REPETITION_SEGMENT_MIN_COUNT) {
      return false;
    }

    let previous = '';
    let streak = 0;
    const counts = new Map<string, number>();

    for (const segment of segments) {
      if (segment === previous) {
        streak++;
      } else {
        previous = segment;
        streak = 1;
      }
      if (
        streak >= Math.ceil(REPETITION_SEGMENT_MIN_COUNT / 2) &&
        segment.length * streak >= REPETITION_SEGMENT_MIN_TOTAL_CHARS
      ) {
        return true;
      }

      const count = (counts.get(segment) ?? 0) + 1;
      counts.set(segment, count);
      if (
        count >= REPETITION_SEGMENT_MIN_COUNT &&
        segment.length * count >= REPETITION_SEGMENT_MIN_TOTAL_CHARS
      ) {
        return true;
      }
    }

    return false;
  }

  private createMbReasoningGuard(): MasterBrainReasoningGuard {
    return new MasterBrainReasoningGuard({
      softEstimatedTokens: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_SOFT_TOKENS,
      softDurationMs: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_SOFT_DURATION_MS,
      hardEstimatedTokens: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_TOKENS,
      hardDurationMs: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_DURATION_MS,
      detectionWindowChars: MB_REASONING_DETECTION_WINDOW_CHARS,
      exactCheckStepChars: MB_REASONING_GUARD_CHECK_INTERVAL_CHARS,
      approximateCheckStepChars: MB_REASONING_APPROXIMATE_CHECK_INTERVAL_CHARS,
      previewHeadChars: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_HEAD_CHARS,
      previewTailChars: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_TAIL_CHARS,
    });
  }

  private formatMbReasoningPreview(preview: MbReasoningPreview): string {
    if (!preview.truncated) {
      return preview.content;
    }

    return [
      preview.head,
      translate('chat.mbReasoningTraceOmitted', {
        count: preview.omittedChars.toLocaleString(),
      }),
      preview.tail,
    ].join('\n\n');
  }

  private stripImagesForVisionFallback(
    messages: AgentLoopLLMMessage[],
    options: { preserveMessages?: WeakSet<AgentLoopLLMMessage> } = {}
  ): {
    messages: AgentLoopLLMMessage[];
    imageCount: number;
  } {
    let imageCount = 0;
    const strippedMessages = messages.map((msg) => {
      if (!Array.isArray(msg.images) || msg.images.length === 0) {
        return msg;
      }
      if (options.preserveMessages?.has(msg)) {
        return msg;
      }

      imageCount += msg.images.length;
      const { images: _images, ...rest } = msg;
      return {
        ...rest,
        content: [
          msg.content,
          translate('chat.subAgentVisionImagesOmitted', { count: msg.images.length }),
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    });

    return { messages: strippedMessages, imageCount };
  }

  private buildHistoricalUserImageMessageContent(
    originalContent: string,
    createdAt: number | undefined,
    imageCount: number
  ): string {
    return translate('planning.masterBrain.historicalUserImageMessage', {
      timestamp: createdAt
        ? formatTimestamp(createdAt)
        : translate('planning.masterBrain.unknownTimestamp'),
      imageCount,
      content:
        originalContent.trim() ||
        translate('planning.masterBrain.historicalUserMessagePlaceholder'),
    });
  }

  /**
   * MB 决策流式 LLM 调用（llm_chat_stream + Tauri Event 监听）
   *
   * 参考 VisualEnhancerService.collectStreamResponse 的成熟模式：
   * 1. 注册 llm-stream-chunk 事件监听器
   * 2. 发起 llm_chat_stream invoke
   * 3. 累积 reasoning（思考模型）+ delta（JSON 输出），实时回调 onStreamDelta
   * 4. 流结束后返回纯 delta 内容供 DecisionParser 解析
   *
   * 使用 ChatRequestDto 格式（provider/model/messages），
   * 与 llm_chat_with_tools 的 ToolChatRequest（providerId/modelId）字段名不同。
   */
  private async collectMBStreamResponse(
    messages: Array<{ role: string; content: string; images?: unknown }>,
    onStreamDelta: (accumulatedContent: string) => void,
    transportMaxTokens: number,
    finalDecisionMaxTokens: number,
    temperature?: number,
    onReasoningTrace?: (event: ReasoningTraceEvent) => void
  ): Promise<string> {
    const { listen } = await import('@tauri-apps/api/event');
    // 复用外层的 planning session，这样 cancel() 才能命中
    // 注册在 Rust 侧的那个流，而不是把取消信号发到一个不相关的 id 上。
    const streamSessionId =
      this.currentSessionId ?? `planning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamAttemptId = `${streamSessionId}-mb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const useDeepSeekV4MbGuard = this.isDeepSeekV4MbModel();

    return new Promise<string>((resolve, reject) => {
      const reasoningGuard = this.createMbReasoningGuard();
      const finalDecisionTokenCounter = new MbEstimatedTokenCounter();
      let deltaContent = '';
      let reasoningTracePreview = '';
      let unlistenFn: (() => void) | null = null;
      let settled = false;
      let guardCancellationError: MbLocalStreamGuardError | null = null;
      let guardCancelTimer: ReturnType<typeof setTimeout> | null = null;
      let reasoningHardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let hasReasoningTraceStarted = false;
      let reasoningTraceCompleted = false;
      let reasoningTraceFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingReasoningTraceContent = false;
      let streamDisplayFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingStreamDisplayContent: string | null = null;
      let activeContextUsage: ActivePlanningContextUsage | null = null;
      let contextReasoningContent = '';
      let reportedInputTokens: number | undefined;
      let reportedOutputTokens: number | undefined;
      let contextUsageFlushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushContextUsage = () => {
        if (contextUsageFlushTimer) {
          clearTimeout(contextUsageFlushTimer);
          contextUsageFlushTimer = null;
        }
        this.updatePlanningContextUsage(activeContextUsage, {
          ...(reportedInputTokens !== undefined ? { currentInputTokens: reportedInputTokens } : {}),
          currentOutputTokens:
            reportedOutputTokens ??
            estimateGeneratedTokens({
              content: deltaContent,
              reasoningContent: contextReasoningContent,
            }),
        });
      };

      const scheduleContextUsage = () => {
        if (!activeContextUsage || contextUsageFlushTimer) return;
        contextUsageFlushTimer = setTimeout(flushContextUsage, MB_STREAM_UI_FLUSH_INTERVAL_MS);
      };

      const clearReasoningTraceFlushTimer = () => {
        if (reasoningTraceFlushTimer) {
          clearTimeout(reasoningTraceFlushTimer);
          reasoningTraceFlushTimer = null;
        }
      };

      const emitReasoningTraceStart = () => {
        if (hasReasoningTraceStarted || !onReasoningTrace) return;
        hasReasoningTraceStarted = true;
        onReasoningTrace({ type: 'START' });
      };

      const flushReasoningTraceContent = () => {
        clearReasoningTraceFlushTimer();
        if (!pendingReasoningTraceContent) return;
        pendingReasoningTraceContent = false;
        if (!onReasoningTrace || reasoningTraceCompleted) return;
        emitReasoningTraceStart();
        onReasoningTrace({
          type: 'CONTENT',
          content: reasoningTracePreview,
        });
      };

      const scheduleReasoningTraceContent = () => {
        if (!onReasoningTrace || reasoningTraceCompleted) return;

        pendingReasoningTraceContent = true;
        if (reasoningTraceFlushTimer) return;

        reasoningTraceFlushTimer = setTimeout(
          flushReasoningTraceContent,
          MB_STREAM_UI_FLUSH_INTERVAL_MS
        );
      };

      const emitReasoningTraceComplete = () => {
        flushReasoningTraceContent();
        if (!onReasoningTrace || !hasReasoningTraceStarted || reasoningTraceCompleted) return;
        reasoningTraceCompleted = true;
        onReasoningTrace({
          type: 'COMPLETE',
          content: reasoningTracePreview,
        });
      };

      const clearStreamDisplayFlushTimer = () => {
        if (streamDisplayFlushTimer) {
          clearTimeout(streamDisplayFlushTimer);
          streamDisplayFlushTimer = null;
        }
      };

      const flushStreamDisplayContent = () => {
        clearStreamDisplayFlushTimer();
        if (pendingStreamDisplayContent === null || settled) {
          pendingStreamDisplayContent = null;
          return;
        }

        const content = pendingStreamDisplayContent;
        pendingStreamDisplayContent = null;
        onStreamDelta(content);
      };

      const scheduleStreamDisplayContent = (content: string) => {
        pendingStreamDisplayContent = content;
        if (streamDisplayFlushTimer) return;

        streamDisplayFlushTimer = setTimeout(
          flushStreamDisplayContent,
          MB_STREAM_UI_FLUSH_INTERVAL_MS
        );
      };

      const cleanup = () => {
        if (guardCancelTimer) {
          clearTimeout(guardCancelTimer);
          guardCancelTimer = null;
        }
        if (reasoningHardDeadlineTimer) {
          clearTimeout(reasoningHardDeadlineTimer);
          reasoningHardDeadlineTimer = null;
        }
        clearReasoningTraceFlushTimer();
        clearStreamDisplayFlushTimer();
        if (contextUsageFlushTimer) {
          clearTimeout(contextUsageFlushTimer);
          contextUsageFlushTimer = null;
        }
        pendingReasoningTraceContent = false;
        pendingStreamDisplayContent = null;
        unlistenFn?.();
        unlistenFn = null;
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        emitReasoningTraceComplete();
        settled = true;
        this.completePlanningContextUsage(activeContextUsage, {
          content: deltaContent,
          reasoningContent: contextReasoningContent,
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
        });
        cleanup();
        reject(error);
      };

      const settleResolve = (content: string) => {
        if (settled) return;
        emitReasoningTraceComplete();
        settled = true;
        this.completePlanningContextUsage(activeContextUsage, {
          content,
          reasoningContent: contextReasoningContent,
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
        });
        cleanup();
        resolve(content);
      };

      const cancelForMbGuardError = (error: MbLocalStreamGuardError) => {
        if (guardCancellationError || settled) return;

        guardCancellationError = error;
        void invoke('llm_cancel_stream', {
          sessionId: streamSessionId,
          attemptId: streamAttemptId,
        }).catch((err: unknown) => {
          logger.warn('[AgentLoop] MB 决策输出 guard 取消旧流失败:', err);
        });

        guardCancelTimer = setTimeout(() => {
          if (guardCancellationError) {
            settleReject(guardCancellationError);
          }
        }, MB_GUARD_CANCEL_GRACE_MS);
      };

      const cancelForMbGuard = (
        correction: MbDecisionRetryCorrection,
        observedLength = deltaContent.length
      ) => {
        cancelForMbGuardError(
          new MbAnomalousDecisionContentError(
            correction.reason,
            correction.detail ?? correction.reason,
            observedLength
          )
        );
      };

      const createFinalDecisionLimitError = (): MbAnomalousDecisionContentError =>
        new MbAnomalousDecisionContentError(
          'truncated_output',
          `final decision exceeded the local ${finalDecisionMaxTokens}-token limit ` +
            `(estimated=${finalDecisionTokenCounter.estimatedTokens})`,
          deltaContent.length
        );

      const createReasoningGuardError = (
        result: Exclude<MbReasoningGuardResult, { action: 'continue' }>
      ): MbLocalStreamGuardError => {
        if (result.action === 'retry') {
          return new MbAnomalousDecisionContentError(
            'reasoning_repetition',
            result.evidence.detail,
            result.metrics.totalChars
          );
        }

        const reason: MbReasoningHardFuseReason =
          result.reason === 'hard_token_fuse'
            ? 'reasoning_token_hard_limit'
            : 'reasoning_time_hard_limit';
        const detail =
          result.reason === 'hard_token_fuse'
            ? `reasoning reached the ${PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_TOKENS}-token hard fuse (estimated=${result.metrics.estimatedTokens})`
            : `reasoning reached the ${Math.round(PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_DURATION_MS / 60000)}-minute hard fuse`;
        return new MbReasoningHardFuseError(reason, detail, result.metrics.totalChars);
      };

      const handleReasoningGuardResult = (
        result: MbReasoningGuardResult,
        streamDone: boolean
      ): boolean => {
        if (result.action === 'continue') {
          if (result.softEntered) {
            logger.debug('[AgentLoop] MB reasoning 进入软门槛，启用近似停滞检测:', {
              providerId: this.config.providerId,
              modelId: this.config.modelId,
              estimatedTokens: result.metrics.estimatedTokens,
              elapsedMs: result.metrics.elapsedMs,
            });
          }
          return false;
        }

        // A completed final body can override semantic loop detection, but never a hard fuse.
        if (result.action === 'retry' && streamDone && deltaContent.trim()) {
          return false;
        }

        const guardError = createReasoningGuardError(result);
        if (guardError instanceof MbReasoningHardFuseError) {
          logger.warn('[AgentLoop] MB reasoning 命中不可重试硬保险丝:', {
            providerId: this.config.providerId,
            modelId: this.config.modelId,
            reason: guardError.reason,
            detail: guardError.detail,
            observedLength: guardError.observedLength,
          });
        }

        if (streamDone) {
          settleReject(guardError);
        } else {
          cancelForMbGuardError(guardError);
        }
        return true;
      };

      // 注册 Tauri 事件监听器（与 VisualEnhancerService 一致）
      listen<{
        sessionId: string;
        attemptId?: string;
        delta: string;
        reasoning?: string;
        done: boolean;
        finishReason?: string;
        error: string | null;
        inputTokens?: number;
        outputTokens?: number;
      }>('llm-stream-chunk', (event) => {
        // 仅处理当前 session 的事件
        if (event.payload.sessionId !== streamSessionId) return;
        if (event.payload.attemptId && event.payload.attemptId !== streamAttemptId) return;
        if (settled) return;

        if (guardCancellationError) {
          if (event.payload.done || event.payload.error) {
            settleReject(guardCancellationError);
          }
          return;
        }

        if (event.payload.error) {
          settleReject(new Error(event.payload.error));
          return;
        }

        const eventInputTokens = normalizeReportedTokenCount(event.payload.inputTokens);
        const eventOutputTokens = normalizeReportedTokenCount(event.payload.outputTokens);
        if (eventInputTokens !== undefined) reportedInputTokens = eventInputTokens;
        if (eventOutputTokens !== undefined) reportedOutputTokens = eventOutputTokens;

        const eventNow = Date.now();
        if (event.payload.delta) {
          reasoningGuard.noteFinalDelta(event.payload.delta, eventNow);
        }

        let reasoningResult: MbReasoningGuardResult | null = null;
        if (event.payload.reasoning) {
          contextReasoningContent += event.payload.reasoning;
          reasoningResult = reasoningGuard.appendReasoning(event.payload.reasoning, eventNow);
          reasoningTracePreview = this.formatMbReasoningPreview(reasoningGuard.getPreview());

          if (!event.payload.done && !reasoningHardDeadlineTimer) {
            reasoningHardDeadlineTimer = setTimeout(() => {
              reasoningHardDeadlineTimer = null;
              const timeResult = reasoningGuard.evaluateTime(Date.now());
              handleReasoningGuardResult(timeResult, false);
            }, PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_DURATION_MS);
          }
          scheduleReasoningTraceContent();
        }
        if (event.payload.delta) {
          deltaContent += event.payload.delta;
          finalDecisionTokenCounter.append(event.payload.delta);
          emitReasoningTraceComplete();
        }

        scheduleContextUsage();

        if (reasoningResult && handleReasoningGuardResult(reasoningResult, event.payload.done)) {
          return;
        }

        const protocolCorrection = this.getUniversalMbProtocolRetryCorrection(deltaContent);
        if (protocolCorrection) {
          cancelForMbGuard(protocolCorrection);
          return;
        }

        if (useDeepSeekV4MbGuard) {
          const retryReason = this.getDeepSeekV4MbStreamRetryReason(deltaContent);
          if (retryReason) {
            cancelForMbGuard({
              reason: 'anomalous_content',
              detail: retryReason,
            });
            return;
          }
        }

        if (
          !event.payload.done &&
          finalDecisionTokenCounter.estimatedTokens > finalDecisionMaxTokens
        ) {
          cancelForMbGuardError(createFinalDecisionLimitError());
          return;
        }

        if (useDeepSeekV4MbGuard) {
          const guardedDisplayContent = this.buildDeepSeekV4MbDisplayContent(deltaContent);
          if (guardedDisplayContent) {
            scheduleStreamDisplayContent(guardedDisplayContent);
          }
        } else {
          // Decision only displays structured output; provider reasoning_content uses Thinking.
          if (deltaContent) {
            scheduleStreamDisplayContent(deltaContent);
          }
        }

        if (event.payload.done) {
          const reasoningMetrics = reasoningGuard.getMetrics(Date.now());
          const reasoningPreview = reasoningGuard.getPreview();
          const retainedReasoningLength = reasoningPreview.truncated
            ? reasoningPreview.head.length + reasoningPreview.tail.length
            : reasoningPreview.content.length;
          const finalDeltaContent = useDeepSeekV4MbGuard
            ? this.normalizeDeepSeekV4MbContent(deltaContent)
            : deltaContent;
          const finalRetryReason = useDeepSeekV4MbGuard
            ? this.getDeepSeekV4MbFinalRetryReason(deltaContent, finalDeltaContent)
            : null;

          logger.trace('[AgentLoop] 📡 MB 流式输出完成', {
            deltaLength: deltaContent.length,
            normalizedDeltaLength: finalDeltaContent.length,
            reasoningLength: reasoningMetrics.totalChars,
            estimatedReasoningTokens: reasoningMetrics.estimatedTokens,
            reasoningPhase: reasoningMetrics.phase,
            retainedReasoningLength,
            reasoningPreviewTruncated: reasoningPreview.truncated,
            finishReason: event.payload.finishReason,
            deepSeekV4Guard: useDeepSeekV4MbGuard,
          });
          if (this.isTruncatedMbFinishReason(event.payload.finishReason)) {
            const reasoningTransportTruncated =
              reasoningMetrics.totalChars > 0 && !finalDeltaContent.trim();
            settleReject(
              new MbAnomalousDecisionContentError(
                reasoningTransportTruncated ? 'reasoning_transport_truncated' : 'truncated_output',
                `provider finish reason: ${event.payload.finishReason ?? 'unknown'}; ` +
                  `reasoningChars=${reasoningMetrics.totalChars}; ` +
                  `estimatedReasoningTokens=${reasoningMetrics.estimatedTokens}; ` +
                  `finalContentChars=${deltaContent.length}`,
                reasoningMetrics.totalChars + deltaContent.length
              )
            );
            return;
          }
          if (finalDecisionTokenCounter.estimatedTokens > finalDecisionMaxTokens) {
            settleReject(createFinalDecisionLimitError());
            return;
          }
          if (finalRetryReason) {
            settleReject(
              new MbAnomalousDecisionContentError(
                'anomalous_content',
                finalRetryReason,
                deltaContent.length
              )
            );
            return;
          }
          if (!finalDeltaContent.trim()) {
            settleReject(new MbEmptyDecisionContentError(reasoningMetrics.totalChars));
            return;
          }

          flushStreamDisplayContent();

          // 返回纯 delta 内容（JSON 输出），供 DecisionParser 解析
          settleResolve(finalDeltaContent);
        }
      })
        .then((unlisten) => {
          unlistenFn = unlisten;

          // 构建 ChatRequestDto 格式的请求（与 llm_chat_with_tools 的 ToolChatRequest 不同）
          // llm_chat_stream 使用 provider/model（非 providerId/modelId）
          const sanitizedMessages = this.sanitizeMessagesForIpc(messages);
          const request: Record<string, unknown> = {
            provider: this.config.providerId ?? 'gemini',
            model: this.config.modelId,
            supports_vision: modelSupportsVision(this.config.modelId ?? '', this.config.providerId),
            messages: sanitizedMessages.map((m) => ({
              role: m.role,
              content: m.content,
              // images 字段透传（用户上传的图片 / avatar 身份感知图片）
              // ChatMessageDto 使用 snake_case（mime_type），需要从 camelCase 转换
              ...(m.images
                ? {
                    images: (
                      m.images as Array<{ mimeType?: string; mime_type?: string; data: string }>
                    ).map((img) => ({
                      mime_type: img.mime_type ?? img.mimeType ?? 'image/webp',
                      data: img.data,
                    })),
                  }
                : {}),
            })),
            temperature,
            max_tokens: transportMaxTokens,
          };
          if (this.config.baseUrl) {
            request.base_url = this.config.baseUrl;
          }

          // 发起流式 LLM 调用
          activeContextUsage = this.beginPlanningContextUsage(
            messages,
            'master-brain',
            streamAttemptId
          );
          invoke('llm_chat_stream', {
            request,
            sessionId: streamSessionId,
            attemptId: streamAttemptId,
          }).catch((err: unknown) => {
            settleReject(err instanceof Error ? err : new Error(String(err)));
          });
        })
        .catch((err: unknown) => {
          settleReject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /**
   * 缓存图片附件并传递给 FSMIntegration
   *
   * 双重目的：
   * 1. 缓存到文件系统 → SA 可通过路径引用（如 generate_image 的 ref_image_path）
   * 2. 设置到 fsmIntegration → DISPATCH 时注入 SA 首条 user 消息（SA 能"看到"图片）
   *
   * 仅用于当轮新上传的图片（扁平 pendingImageAttachments 路径）；
   * 历史跨轮图片使用 saveImagesToTempCache + setPairedHistoryMessages（配对模式路径）。
   */
  private async saveAndPassImagesToSA(
    camelCaseImages: Array<{ mimeType: string; data: string }>
  ): Promise<void> {
    // 优先复用本轮附件系统已经保存的图片路径；缺失时才写入临时缓存，避免污染工作区附件列表
    let savedPaths = this.getCurrentImageAttachmentPaths();
    if (savedPaths.length < camelCaseImages.length) {
      const unsavedImages = camelCaseImages.slice(savedPaths.length);
      savedPaths = [...savedPaths, ...(await this.saveImagesToTempCache(unsavedImages))];
    }

    // 透传给 FSMIntegration（DISPATCH 时注入 SA 首条 user 消息）
    if (this.fsmIntegration) {
      this.fsmIntegration.setImageAttachments(camelCaseImages, savedPaths);
      logger.trace('[AgentLoop] 📷 已设置图片到 fsmIntegration，待 DISPATCH 透传给 SA');
    }
  }

  private getCurrentImageAttachmentPaths(): string[] {
    return (
      this.config.attachmentReferences
        ?.filter((reference) => reference.type === 'image' && reference.path.trim())
        .map((reference) => reference.path.trim()) ?? []
    );
  }

  /**
   * 缓存图片到系统临时目录
   *
   * 单一职责：只负责文件写入，不涉及 FSMIntegration 透传。
   * 供两条路径共同使用：
   * - 当轮新图片路径（saveAndPassImagesToSA 内部调用）
   * - 历史配对消息路径（历史跨轮图片直接调用，再走 setPairedHistoryMessages）
   *
   * @returns 成功缓存的文件路径列表（失败的路径不包含，整体失败时返回空数组）
   */
  private async saveImagesToTempCache(
    camelCaseImages: Array<{ mimeType: string; data: string }>
  ): Promise<string[]> {
    const savedPaths: string[] = [];

    try {
      const { join, tempDir } = await import('@tauri-apps/api/path');
      const { mkdir, exists, writeFile } = await import('@tauri-apps/plugin-fs');

      const cacheDir = await join(await tempDir(), 'dropped_files', 'agentvis_image_cache');
      const dirExists = await exists(cacheDir);
      if (!dirExists) {
        await mkdir(cacheDir, { recursive: true });
      }

      for (let i = 0; i < camelCaseImages.length; i++) {
        const img = camelCaseImages[i];
        if (!img) continue;
        // 从 mimeType 提取扩展名（如 image/webp → webp）
        const ext = img.mimeType.split('/')[1] ?? 'png';
        // 使用内容哈希生成文件名，避免跨轮恢复时重复保存相同图片
        // 简易哈希：取 base64 数据的前 64 字符计算数值指纹
        const contentFingerprint = this.computeSimpleHash(img.data);
        const fileName = `attachment_${contentFingerprint}_${i}.${ext}`;
        const filePath = await join(cacheDir, fileName);

        // 去重：同哈希文件已存在则跳过保存，直接复用路径
        const fileExists = await exists(filePath);
        if (fileExists) {
          savedPaths.push(filePath);
          logger.trace(`[AgentLoop] 📁 图片缓存已存在，跳过保存: ${filePath}`);
          continue;
        }

        // base64 解码并写入文件
        const binaryData = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
        await writeFile(filePath, binaryData);
        savedPaths.push(filePath);
        logger.trace(`[AgentLoop] 📁 图片已缓存: ${filePath}`);
      }
    } catch (saveError: unknown) {
      logger.warn('[AgentLoop] 图片缓存到临时目录失败:', saveError);
      // 缓存失败不阻塞调用方（返回空数组，base64 数据仍可透传）
    }

    return savedPaths;
  }

  /**
   * 计算 base64 字符串的简易内容哈希（DJB2 算法）
   *
   * 用于生成图片文件名的去重指纹。取前 128 字符采样即可区分不同图片，
   * 避免对整个 base64 串计算哈希带来的性能开销。
   * 输出 8 位 16 进制字符串（碰撞概率极低，满足文件去重需求）。
   */
  private computeSimpleHash(data: string): string {
    const sample = data.slice(0, 128);
    let hash = 5381;
    for (let i = 0; i < sample.length; i++) {
      // DJB2: hash * 33 + charCode
      hash = (hash << 5) + hash + sample.charCodeAt(i);
      // 保持 32 位整数范围
      hash = hash & 0xffffffff;
    }
    // 转为无符号 16 进制，确保 8 位
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 构建 Avatar 身份感知合成 user 消息
   *
   * 当 Agent 配置了自定义头像时，生成一条携带 avatar 图片的合成 user 消息，
   * 插入到 system prompt 与 convertedMessages 之间，让 LLM "看到"自己的形象。
   *
   * 采用合成 user 消息而非 system 嵌图的原因：
   * 三大 Provider（Gemini/OpenAI/Anthropic）的 system 消息均不稳定支持图片，
   * 但所有 Provider 的 user 消息均完整支持多模态。
   *
   * @returns 包含 0 或 1 条消息的数组（方便 spread 展开）
   */
  private buildAvatarIdentityMessage(): Array<{
    role: string;
    content: string;
    images?: Array<{ mimeType: string; data: string }>;
  }> {
    const avatarBase64 = this.config.agentAvatar;
    if (!avatarBase64) return [];
    if (!modelSupportsVision(this.config.modelId ?? '', this.config.providerId)) return [];

    return [
      {
        role: 'user',
        // 引导文字与 MasterBrainPrompt.buildCharacterGrounding 的「形象感知」段落呼应
        content:
          '[Agent Identity Visual Context] The following image is your visual appearance. Interpret and use it together with the "Appearance Awareness" guidance in the system instructions.',
        images: [
          {
            // avatar 持久化格式为 webp（参见 Agent 配置层）
            mimeType: 'image/webp',
            data: avatarBase64,
          },
        ],
      },
    ];
  }

  /**
   * 构建 MB 预算耗尽警告的合成 user 消息内容
   *
   * 当 MB 决策预算临近耗尽时，在 messages 数组末尾追加此消息，
   * 利用 context 末尾 LLM 注意力最集中的特性，引导 MB 主动收尾。
   *
   * 设计对称于 SA 端的 SUB_AGENT_BUDGET_WARNING_RATIO / CRITICAL_RATIO 双级机制：
   * - WARNING（剩余 <= MB_BUDGET_WARNING_THRESHOLD）：引导优先收尾，允许最后一次 SPAWN
   * - CRITICAL（剩余 <= MB_BUDGET_CRITICAL_THRESHOLD）：强制 RESPOND_TO_USER，禁止再派 SA
   *
   * @param mbBudgetRemaining - MB 剩余决策轮数（undefined 表示预算充足）
   * @returns 警告文案字符串；预算充足时返回 null（不注入）
   */
  private buildMbBudgetWarningMessage(mbBudgetRemaining: number | undefined): string | null {
    const C = PLANNING_CONSTANTS;

    // 预算充足：不注入任何内容，避免 LLM 频繁感知数字产生焦虑决策
    if (mbBudgetRemaining === undefined || mbBudgetRemaining > C.MB_BUDGET_WARNING_THRESHOLD) {
      return null;
    }

    // CRITICAL 级别（剩余 <= 1 轮）：这是最后一次决策机会，强制 RESPOND_TO_USER
    if (mbBudgetRemaining <= C.MB_BUDGET_CRITICAL_THRESHOLD) {
      return [
        '[SYSTEM: ⛔ MB_BUDGET_CRITICAL]',
        `This is your **last ${mbBudgetRemaining} decision opportunity**. The system will terminate automatically after this round.`,
        'You **must** choose `RESPOND_TO_USER` and tell the user:',
        '1. The task stages and deliverables that have been completed',
        '2. What remains unfinished and why',
        '3. Follow-up suggestions, such as asking the user to continue the remaining stages if needed',
        'Do not choose `SPAWN_SUB_AGENT` again, or the user will receive no reply.',
      ].join('\n');
    }

    // WARNING 级别（剩余 <= 2 轮，且 > 1）：引导收尾，允许最后一次 SPAWN
    return [
      '[SYSTEM: ⚠️ MB_BUDGET_WARNING]',
      `Your decision budget is about to run out (${mbBudgetRemaining} round(s) remaining).`,
      '- If the core stage of the current task is complete, choose `RESPOND_TO_USER` immediately and report the completed results to the user.',
      '- If exactly one key step remains and it is truly necessary, you may use the final budget to dispatch one SA, but the **next round must** be `RESPOND_TO_USER`.',
      '- Do not dispatch hastily for unnecessary perfection because of budget pressure. Reporting current progress and follow-up suggestions is more valuable than forcing completion.',
    ].join('\n');
  }

  /**
   * 将 Agent avatar 持久化到 workdir/agent_avatar.webp
   *
   * 使 SA 的 generate_image 工具可通过 ref_image_path 引用此文件做图生图。
   * 文件路径约定为 `{workdir}/agent_avatar.webp`，与 SKILL.md 中的指引一致。
   * 使用 hash 去重：avatar 未变化时跳过写入。
   *
   * 非阻塞：持久化失败不影响主流程（仅丢失 SA 的图生图能力，
   * 但 MB 的多模态合成 user 消息仍正常工作）。
   */
  private async persistAvatarToWorkdir(): Promise<void> {
    const avatarBase64 = this.config.agentAvatar;
    if (!avatarBase64 || !this.config.workdir) return;

    try {
      const { appDataDir: getAppDataDir, join } = await import('@tauri-apps/api/path');
      const { exists, writeFile, readFile } = await import('@tauri-apps/plugin-fs');

      const avatarPath = await join(this.config.workdir, 'agent_avatar.webp');

      // 使用内容 hash 判断是否需要更新（避免每轮重复写入）
      const contentHash = this.computeSimpleHash(avatarBase64);
      const hashMarkerPath = await join(this.config.workdir, '.agent_avatar_hash');

      let needsUpdate = true;
      try {
        const markerExists = await exists(hashMarkerPath);
        if (markerExists) {
          const { readTextFile } = await import('@tauri-apps/plugin-fs');
          const existingHash = await readTextFile(hashMarkerPath);
          if (existingHash.trim() === contentHash) {
            needsUpdate = false;
          }
        }
      } catch {
        // 读取 hash 失败则强制更新
      }

      if (!needsUpdate) {
        logger.trace('[AgentLoop] 🎭 Avatar 文件已是最新，跳过持久化');
        return;
      }

      // 从 {appDataDir}/avatars/{agentId}.webp 复制原图（未裁剪的高分辨率版本）
      // 原图由 AgentSettingsModal 在头像上传时保存
      const appData = await getAppDataDir();
      const originalPath = await join(
        appData,
        'avatars',
        `${this.config.agentId ?? 'unknown'}.webp`
      );
      const originalExists = await exists(originalPath);
      if (!originalExists) {
        logger.trace('[AgentLoop] 🎭 原图文件不存在，跳过（需重新上传头像生成原图）');
        return;
      }
      const originalBytes = await readFile(originalPath);
      await writeFile(avatarPath, originalBytes);
      logger.trace('[AgentLoop] 🎭 Avatar 原图已复制到 workdir:', avatarPath);

      // 写入 hash 标记
      const encoder = new TextEncoder();
      await writeFile(hashMarkerPath, encoder.encode(contentHash));
    } catch (error: unknown) {
      // 持久化失败不阻塞主流程
      logger.warn('[AgentLoop] Avatar 持久化失败（不影响 MB 形象感知）:', error);
    }
  }

  /**
   * 创建记忆快照提供者
   *
   * 从 MemoryContextProvider 获取记忆快照
   */
  private createMemorySnapshotProvider(): FSMIntegrationDependencies['getMemorySnapshot'] {
    return async (agentId: string, userQuery?: string) => {
      // 动态导入以避免循环依赖
      const { MemoryContextProvider } = await import('../../memory/MemoryContextProvider');
      const provider = new MemoryContextProvider();

      try {
        // 传入 userQuery 启用摘要语义召回（而非全量返回）
        // 不传 includeOriginal：Evidence Slices 已通过 openQuestions
        // 精准回溯最相关的完整原文片段，无需全量加载源消息
        const context = await provider.getMemoryContext(agentId, {
          userQuery,
        });

        const facts: MemoryItem[] = context.facts.map((f) => ({
          id: f.id,
          agentId: f.agentId,
          layer: this.validateMemoryLayer(f.layer),
          content: f.content,
          // 使用类型验证函数替代类型断言
          category: this.validateFactCategory(f.category),
          importance: f.importance,
          sourceMessageIds: f.sourceMessageIds,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        }));
        const summaries: MemoryItem[] = context.summaries.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          layer: this.validateMemoryLayer(s.layer),
          content: s.content,
          // 使用类型验证函数替代类型断言
          category: this.validateFactCategory(s.category),
          importance: s.importance,
          sourceMessageIds: s.sourceMessageIds,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          // 传递完整的摘要状态字段，供 MasterBrain 决策参考
          confirmedDecisions: s.confirmedDecisions,
          openQuestions: s.openQuestions,
          invalidatedPoints: s.invalidatedPoints,
        }));
        const factsByCategory = this.groupFactsByCategory(facts);

        // 转换为 MasterBrain 期望的 MemorySnapshot 格式
        return {
          facts,
          summaries,
          factsByCategory,
          // task_experience 类别的事实单独提取，避免混入用户画像渲染
          taskExperiences: factsByCategory.task_experience,
        };
      } catch (error) {
        logger.warn('[AgentLoop] 获取记忆快照失败:', error);
        // 返回空快照
        return {
          facts: [],
          summaries: [],
          factsByCategory: this.createEmptyFactsByCategory(),
          taskExperiences: [],
        };
      }
    };
  }

  /**
   * 获取工具目录条目
   *
   * 从 ToolRegistry 获取工具信息,并从 Skills 中提取使用场景、禁用场景和决策提示
   */
  private getToolCatalogEntries(): import('../brain/types').ToolCatalogEntry[] {
    const schemas = toolRegistry.getSchemas();
    // 基础工具（read/local_search/web_search）已默认注入 SA，
    // MB 无需了解其决策信息，过滤后聚焦于需要授权的特殊工具
    const baseToolSet = new Set<string>(PLANNING_CONSTANTS.BASE_TOOLS);
    return schemas
      .filter((schema) => !baseToolSet.has(schema.name))
      .map((schema) => {
        // 查找对应的 Skill 以获取决策级信息
        const skill = this.skills.find((s) => s.name === schema.name);
        const whenToUse = skill ? this.extractWhenToUse(skill.fullContent) : undefined;
        const whenNotToUse = skill ? this.extractWhenNotToUse(skill.fullContent) : undefined;
        const decisionHint = skill ? this.extractDecisionHint(skill.fullContent) : undefined;

        return {
          name: schema.name,
          description: skill?.description ?? schema.description,
          whenToUse,
          whenNotToUse,
          decisionHint,
          // 转换 ToolParameterSchema 为 Record<string, unknown>
          parameters: schema.parameters as unknown as Record<string, unknown>,
          riskLevel: this.assessToolRiskLevel(schema.name),
        };
      });
  }

  /**
   * 从 SKILL.md 的 fullContent 中提取指定章节的列表项
   *
   * 通用章节列表提取器，匹配以 # 开头的标题中包含指定关键词的章节，
   * 提取章节内所有 - 开头的列表项内容。
   *
   * @param fullContent SKILL.md 完整正文
   * @param sectionKeywords 章节关键词列表（中文/英文，任一匹配即进入该章节）
   */
  private extractSectionItems(fullContent: string, sectionKeywords: string[]): string[] {
    const lines = fullContent.split('\n');
    const results: string[] = [];
    let inSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 检查是否进入目标章节（标题行包含任一关键词）
      if (
        trimmed.startsWith('#') &&
        sectionKeywords.some(
          (kw) => trimmed.includes(kw) || trimmed.toLowerCase().includes(kw.toLowerCase())
        )
      ) {
        inSection = true;
        continue;
      }

      // 遇到新的标题则退出
      if (inSection && trimmed.startsWith('#')) {
        break;
      }

      // 提取列表项
      if (inSection && trimmed.startsWith('-')) {
        const content = trimmed.replace(/^-\s*/, '').trim();
        if (content) {
          results.push(content);
        }
      }
    }

    return results;
  }

  /**
   * 从 SKILL.md 的 fullContent 中提取 whenToUse 列表
   */
  private extractWhenToUse(fullContent: string): string[] {
    return this.extractSectionItems(fullContent, ['When To Use']);
  }

  /**
   * 从 SKILL.md 的 fullContent 中提取 whenNotToUse 列表
   */
  private extractWhenNotToUse(fullContent: string): string[] {
    return this.extractSectionItems(fullContent, ['When Not To Use']);
  }

  /**
   * 从 SKILL.md 的 fullContent 中提取 decisionHint 列表
   */
  private extractDecisionHint(fullContent: string): string[] {
    return this.extractSectionItems(fullContent, ['Decision Hint']);
  }

  /**
   * 评估工具风险等级
   *
   * 委托给 ToolPolicyManager 的 TOOL_RISK_REGISTRY，
   * 避免与 ToolPolicyManager 维护两套硬编码风险表
   */
  private assessToolRiskLevel(toolName: string): 'low' | 'medium' | 'high' {
    return TOOL_RISK_REGISTRY[toolName] ?? DEFAULT_TOOL_RISK;
  }

  private buildAttachmentReferenceEvidence(): string {
    const attachmentReferences = this.config.attachmentReferences?.filter((reference) =>
      reference.path.trim()
    );
    if (!attachmentReferences?.length) return '';

    const items = attachmentReferences
      .map((reference) =>
        translate('planning.masterBrain.attachmentReferenceEvidenceItem', {
          fileName: reference.fileName,
          type: reference.type,
          extension: reference.extension,
          size: Math.max(1, Math.round((reference.sizeBytes ?? 0) / 1024)),
          path: reference.path,
        })
      )
      .join('\n');

    return translate('planning.masterBrain.attachmentReferenceEvidenceHeader', { items });
  }

  /**
   * 从 Session 的 PreparedContext 提取 RAG 证据和附件内容
   *
   * 解决 MasterBrain Native 模式下 RAG 上下文和文档附件未注入的问题。
   * 同时提取 type='rag' 和 type='attachment' 的 ContextBlock，合并为
   * RAGEvidence 数组供 MasterBrain 的 [RAG_EVIDENCE] 部分使用。
   */
  private extractRAGEvidenceFromSession(): import('../brain/types').RAGEvidence[] {
    const preparedContext = this.session.getLastPreparedContext();
    const allEvidence: import('../brain/types').RAGEvidence[] = [];

    if (!preparedContext?.contextBlocks) {
      const attachmentReferenceEvidence = this.buildAttachmentReferenceEvidence();
      if (attachmentReferenceEvidence) {
        allEvidence.push({
          source: 'attachment_paths',
          content: attachmentReferenceEvidence,
          relevance: 1.0,
        });
      }
      logger.trace('[AgentLoop] 无 PreparedContext 或 contextBlocks，RAG 证据仅包含附件路径清单');
      return allEvidence;
    }

    // 提取附件内容（用户主动上传的文档，优先级最高）
    const attachmentBlock = preparedContext.contextBlocks.find(
      (block) => block.type === 'attachment'
    );
    if (attachmentBlock?.content) {
      allEvidence.push({
        source: 'attachment',
        content: attachmentBlock.content.trim(),
        // 用户主动上传的附件，意图明确，使用最高相关性
        relevance: 1.0,
      });
      logger.trace(`[AgentLoop] 📎 提取附件内容: ${attachmentBlock.tokenEstimate} tokens`);
    } else {
      const attachmentReferenceEvidence = this.buildAttachmentReferenceEvidence();
      if (attachmentReferenceEvidence) {
        allEvidence.push({
          source: 'attachment_paths',
          content: attachmentReferenceEvidence,
          relevance: 1.0,
        });
      }
    }

    // 提取 RAG 检索结果
    const ragBlock = preparedContext.contextBlocks.find((block) => block.type === 'rag');
    if (ragBlock?.content) {
      const ragEvidence = this.parseRAGContent(ragBlock.content);
      allEvidence.push(...ragEvidence);
      logger.trace(
        `[AgentLoop] 📚 提取 RAG 证据: ${ragEvidence.length} 条，共 ${ragBlock.tokenEstimate} tokens`
      );
    }

    if (allEvidence.length === 0) {
      logger.trace('[AgentLoop] 未找到 RAG 或附件上下文块');
    }

    return allEvidence;
  }

  /**
   * 解析 RAG 原始内容为结构化证据
   *
   * 支持两种格式：
   * 1. 纯文本（整体作为一条证据）
   * 2. 分块格式（按 --- 或 ### 分隔）
   */
  private parseRAGContent(rawContent: string): import('../brain/types').RAGEvidence[] {
    if (!rawContent.trim()) return [];

    // 尝试按常见分隔符分割
    const separators = ['\n---\n', '\n### ', '\n## '];
    let chunks: string[] = [rawContent];

    for (const sep of separators) {
      if (rawContent.includes(sep)) {
        chunks = rawContent.split(sep).filter((c) => c.trim());
        break;
      }
    }

    // 作为单条证据返回整块内容（避免过度分割）
    // 这样 MasterBrain 可以直接理解完整上下文
    if (chunks.length === 1 || rawContent.length < 2000) {
      return [
        {
          source: 'knowledge_base',
          content: rawContent.trim(),
          // -1 标记"无独立评分"：内容已通过 RRF 融合筛选，
          // 片段级匹配度已嵌入 content 文本中，外层不再重复标注
          relevance: -1,
        },
      ];
    }

    // 多块时返回分块证据
    return chunks.slice(0, 5).map((chunk) => ({
      source: 'knowledge_base',
      content: chunk.trim(),
      // 同上，片段级匹配度已在 content 中标注
      relevance: -1,
    }));
  }

  /**
   * 创建空的事实类别分组
   */
  private createEmptyFactsByCategory(): MemorySnapshot['factsByCategory'] {
    return {
      identity_role: [],
      preference_style: [],
      long_term_goal: [],
      knowledge_level: [],
      interaction_signals: [],
      task_experience: [],
    };
  }

  /**
   * 按类别填充 MasterBrain 记忆快照中的事实分组
   */
  private groupFactsByCategory(facts: MemoryItem[]): MemorySnapshot['factsByCategory'] {
    const factsByCategory = this.createEmptyFactsByCategory();
    for (const fact of facts) {
      if (fact.category) {
        factsByCategory[fact.category].push(fact);
      }
    }
    return factsByCategory;
  }

  /**
   * 验证记忆层级类型
   *
   * 使用类型验证替代不安全的类型断言
   */
  private validateMemoryLayer(layer: string): 'short_term' | 'summary' | 'fact' {
    const validLayers = ['short_term', 'summary', 'fact'] as const;
    if (validLayers.includes(layer as (typeof validLayers)[number])) {
      return layer as 'short_term' | 'summary' | 'fact';
    }
    // 默认返回 'fact' 而非抛出错误，保证系统鲁棒性
    logger.warn(`[AgentLoop] 未知记忆层级: ${layer}，默认使用 'fact'`);
    return 'fact';
  }

  /**
   * 验证事实类别类型
   *
   * 使用类型验证替代不安全的类型断言
   */
  private validateFactCategory(
    category: string | null
  ): import('../brain/types').LongTermFactCategory | null {
    if (category === null) return null;

    const validCategories = [
      'identity_role',
      'preference_style',
      'long_term_goal',
      'knowledge_level',
      'interaction_signals',
      'task_experience',
    ] as const;

    if (validCategories.includes(category as (typeof validCategories)[number])) {
      return category as import('../brain/types').LongTermFactCategory;
    }

    // 未知类别返回 null 而非抛出错误
    logger.warn(`[AgentLoop] 未知事实类别: ${category}，返回 null`);
    return null;
  }

  /**
   * 创建工具执行适配器
   *
   * 将现有的 executeTool() 方法适配为 FSM 集成层所需的格式
   * 同时将工具执行结果添加到会话历史
   */
  private createToolAdapter(): FSMIntegrationDependencies['executeTool'] {
    return async (
      toolCall: ToolCallInfo,
      options?: ToolExecuteOptions
    ): Promise<ToolExecutionResult> => {
      // 转换为现有格式
      const originalToolCall: ToolCall = {
        name: toolCall.name,
        args: toolCall.args,
      };

      // 执行工具，传递 SubAgent 标识和取消信号
      const result = await this.executeTool(originalToolCall, options);

      // SA 内部的工具结果不写入父级 Session，避免与 SA 最终报告重复
      // SA 的 observations 由 SubAgentDispatcher.buildDispatchResult 单独写入
      if (!options?.isSubAgentContext) {
        this.addMessage({
          role: 'tool',
          content: result.content,
          toolName: toolCall.name,
          toolCallId: `${toolCall.name}_${Date.now()}`,
        });
      }

      // 调试日志
      if (result.images && result.images.length > 0) {
        logger.trace(
          '[AgentLoop] 📷 createToolAdapter 透传 images:',
          result.images.length,
          '张, data长度:',
          result.images[0]?.data.length
        );
      }
      return {
        success: result.success,
        content: result.content,
        requiresInteraction: result.requiresInteraction,
        // 传递结构化数据（如 file_write 的 Diff 数据），供 SubAgentRunner 收集
        data: result.data,
        // 透传图片附件（多模态 tool_result，Anthropic 协议支持）
        images: result.images,
      };
    };
  }

  /**
   * 执行 Agent Loop
   *
   * @param userMessage 用户消息
   * @returns 执行结果
   */
  async run(userMessage: string): Promise<AgentLoopResult> {
    // 生成当前会话 ID（用于后端取消）
    this.currentSessionId = `planning-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logger.debug('[AgentLoop] 创建会话:', this.currentSessionId);

    // FSM 驱动模式执行（OODA 2.0 架构）
    return this.runWithFSM(userMessage);
  }

  /**
   * FSM 驱动模式执行
   *
   * 使用 FSMEngine 和 LoopGovernor 驱动状态转移
   */
  private async runWithFSM(userMessage: string): Promise<AgentLoopResult> {
    this.reset();
    this.setState('running');

    try {
      // Agent 形象持久化：将 avatar base64 写入 workdir/agent_avatar.webp
      // 使 SA 的 generate_image 工具可通过 ref_image_path 引用此文件做图生图
      await this.persistAvatarToWorkdir();

      // 轮次隔离：清除上一轮的 tool 消息，只保留 user+assistant 历史
      // 跨轮的任务经验由记忆系统承担（task_experience 类别）
      this.session.clearToolMessages();

      // 记录历史消息分界线：clearToolMessages 后剩余的都是 loadChatHistory 加载的历史
      // 当轮新增消息（user/assistant/tool）的 index 将 >= 此值
      this.historyMessageCount = this.session.getMessageCount();
      logger.trace(
        `[AgentLoop] 📊 历史消息分界线: ${this.historyMessageCount} 条（当轮消息将从此索引开始）`
      );

      // 添加用户消息到历史（去重：loadChatHistory 可能已从 UI 同步此消息）
      const messages = this.session.getMessages();
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role !== 'user' || lastMsg.content !== userMessage) {
        this.addMessage({ role: 'user', content: userMessage, createdAt: Date.now() });
      }

      // 委托给 FSM 集成层执行
      const fsmIntegration = this.fsmIntegration;
      if (!fsmIntegration) {
        throw new Error('FSM integration is not initialized');
      }

      const terminationReason = await fsmIntegration.run(userMessage);

      // 转换终止原因（FSM 可能返回更多类型）
      const mappedReason = this.mapFSMTerminationReason(terminationReason);

      // 获取最后的助手响应内容
      const lastContent = fsmIntegration.getLastLLMContent();
      if (lastContent) {
        // 如果 FSM 执行完成后有助手响应，添加到历史
        // 注意：某些情况下消息可能已由状态处理器添加
        const messages = this.session.getMessages();
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role !== 'assistant' || lastMsg.content !== lastContent) {
          this.addMessage({ role: 'assistant', content: lastContent });
        }
      }

      return this.buildResult(mappedReason);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(error instanceof Error ? error : new Error(errorMessage));

      // 错误路径也尝试将 rationale 注入的 lastLLMContent 写入 session，
      // 保证 buildResult 能找到包含 rationale 的 assistant 消息
      try {
        const lastContent = this.fsmIntegration?.getLastLLMContent();
        if (lastContent) {
          const msgs = this.session.getMessages();
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg?.role !== 'assistant' || lastMsg.content !== lastContent) {
            this.addMessage({ role: 'assistant', content: lastContent });
          }
        }
      } catch (sessionError) {
        // session 写入失败不阻塞主流程
        logger.warn('[AgentLoop] error 路径写入 lastLLMContent 失败:', sessionError);
      }

      return this.buildResult('error', errorMessage);
    } finally {
      if (this.state !== 'error' && this.state !== 'cancelled') {
        this.setState('completed');
      }
    }
  }
  /**
   * 取消执行
   */
  cancel(): void {
    this.setState('cancelled');

    // 调用后端取消 API（如果有活动的 sessionId）
    if (this.currentSessionId) {
      invoke('llm_cancel_stream', { sessionId: this.currentSessionId })
        .then(() => logger.debug('[AgentLoop] 已发送后端取消信号:', this.currentSessionId))
        .catch((err: unknown) => logger.warn('[AgentLoop] 后端取消失败:', err));
    }

    // 如果 FSM 模式启用，同时取消 FSM 执行
    if (this.fsmIntegration) {
      this.fsmIntegration.cancel();
    }
  }

  /**
   * 获取当前状态
   */
  getState(): LoopState {
    return this.state;
  }

  /**
   * 获取消息历史（委托给 Session）
   */
  getMessages(): AgentMessage[] {
    return this.session.getMessages();
  }

  // ==================== 私有方法 ====================

  /**
   * 重置状态
   *
   * 注意：不清空 Session 的消息历史，因为 Session 可能跨多次 run() 复用
   */
  private reset(): void {
    this.state = 'idle';
    this.iterationCount = 0;
    this.toolCallCount = 0;

    // 重置 FSM 集成层状态（如果存在）
    // 注意：FSM 集成层会在 run() 时自动重置
  }

  /**
   * 转换 FSM 终止原因为 AgentLoop 终止原因
   *
   * FSM 层可能返回更多类型的终止原因，需要映射为 AgentLoop 支持的类型
   */
  private mapFSMTerminationReason(fsmReason: TerminationReason): TerminationReason {
    // 当前 FSM 层和 AgentLoop 层使用相同的 TerminationReason 类型
    // 如果未来 FSM 层添加新的终止原因，可以在这里映射
    return fsmReason;
  }

  /**
   * 设置状态
   */
  private setState(state: LoopState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  /**
   * 添加消息（委托给 Session）
   */
  private addMessage(message: AgentMessage): void {
    this.session.addMessage(message);
    this.callbacks.onMessage?.(message);
  }

  /**
   * 解析 venv Python 路径供 exec 工具使用
   *
   * 与 SubAgentFactory.resolveVenvPythonPath() 逻辑一致。
   * 仅在 venv 就绪时返回路径，exec 工具据此将裸 python 命令规范化为 venv 路径。
   */
  private resolveVenvPythonPathForExec(): string | undefined {
    try {
      const { envStatus, venvPath } = useRuntimeStore.getState();
      if ((envStatus !== 'ready' && envStatus !== 'skipped') || !venvPath) {
        return undefined;
      }
      const isWindows = navigator.userAgent.includes('Windows') || venvPath.includes('\\');
      return isWindows ? `${venvPath}\\Scripts\\python.exe` : `${venvPath}/bin/python`;
    } catch {
      return undefined;
    }
  }

  private getEnabledExternalScriptSkills(): SkillDefinition[] {
    const { skillEnabledOverrides } = useRuntimeStore.getState();
    return skillLoader
      .getExternalScriptSkills()
      .filter((skill) => skillEnabledOverrides[skill.name] ?? true);
  }

  private matchExternalScriptSkillsByName(
    query: string,
    scriptSkills: SkillDefinition[]
  ): SkillDefinition[] {
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery.trim()) {
      return [];
    }

    return scriptSkills.filter((skill) => normalizedQuery.includes(skill.name.toLowerCase()));
  }

  private async getAppManagedSandboxRoots(): Promise<string[]> {
    this.appManagedSandboxRootsPromise ??= (async () => {
      try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        return [await join(appData, 'runtime'), await join(appData, 'skills')];
      } catch (error) {
        logger.debug('[AgentLoop] Failed to resolve app-managed sandbox roots:', error);
        return [];
      }
    })();

    return this.appManagedSandboxRootsPromise;
  }

  private mergeSandboxRoots(...rootGroups: Array<Array<string | undefined> | undefined>): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const group of rootGroups) {
      for (const root of group ?? []) {
        if (!root) continue;
        const key = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        roots.push(root);
      }
    }
    return roots;
  }

  /**
   * 执行工具
   *
   * @param toolCall 工具调用信息
   * @param options 工具执行选项
   */
  private async executeTool(toolCall: ToolCall, options?: ToolExecuteOptions): Promise<ToolResult> {
    if (options?.signal?.aborted) {
      return {
        success: false,
        content: translate('tools.common.toolExecutionCancelled'),
      };
    }

    this.setState('awaiting_tool');
    this.callbacks.onToolCallStart?.(toolCall);
    this.toolCallCount++;

    // 获取工具
    const executionToolCall = normalizeToolCallForExecution(toolCall);
    const tool = toolRegistry.get(executionToolCall.name);
    if (!tool) {
      const result: ToolResult = {
        success: false,
        content: `Error: Tool "${toolCall.name}" was not found`,
      };
      this.callbacks.onToolCallEnd?.(toolCall, result);
      this.setState('running');
      return result;
    }

    // 构建执行上下文
    // 传递 isSubAgentContext 标识，使 file_write 工具跳过授权确认
    // 从 workdir 解析 hubName/agentName：workdir 格式为 .../deliverables/{hubName}/{agentName}
    // 这样 generate_image 等工具无需通过 Store 查找即可获取正确的路径信息，
    // 避免 Store 未就绪时 fallback 到 default/unknown 目录。
    const workdirPathParts = this.config.workdir?.replace(/\\/g, '/').split('/') ?? [];
    const contextAgentName = workdirPathParts[workdirPathParts.length - 1];
    const contextHubName = workdirPathParts[workdirPathParts.length - 2];
    const effectiveToolWorkdir =
      options?.workdirOverride ?? this.config.projectPath ?? this.config.workdir;
    const baseSandboxRoots =
      options?.sandboxRoots ??
      [effectiveToolWorkdir, this.config.projectPath ? this.config.workdir : undefined].filter(
        (root): root is string => Boolean(root)
      );
    const appManagedSandboxRoots = await this.getAppManagedSandboxRoots();
    const sandboxRoots = this.mergeSandboxRoots(baseSandboxRoots, appManagedSandboxRoots);
    const sandboxMode = this.config.sandboxMode ?? 'LocalAudit';
    const sandboxFilesystemScope = sandboxMode === 'OfflineIsolated' ? 'workspace' : 'local';

    const context: ToolExecutionContext = {
      agentId: this.config.agentId,
      providerId: this.config.providerId,
      modelId: this.config.modelId,
      baseUrl: this.config.baseUrl,
      workdir: effectiveToolWorkdir,
      sandboxRoots,
      sandboxMode,
      sandboxFilesystemScope,
      onProgress: this.callbacks.onProgress,
      onRequestAuthorization: this.callbacks.onRequestAuthorization,
      isSubAgentContext: options?.isSubAgentContext,
      signal: options?.signal,
      // 注入 venv Python 路径，exec 工具据此将裸 python 命令规范化为 venv 路径
      venvPythonPath: this.resolveVenvPythonPathForExec(),
      // 注入已清理的 hub/agent 名称（从 workdir 解析），供 generate_image 等工具使用
      // 比在工具内部查 Store 更可靠（Store 在工具执行时可能尚未填充完成）
      hubName: contextHubName ?? undefined,
      agentName: contextAgentName ?? undefined,
      // 注入触发本次任务的 IM 机器人 ID（IM 触发时由 ImTaskBridge 携带）
      // im_send 工具通过此字段精确定位当前机器人，实现多 Bot 路由隔离
      // 非 IM 触发的任务此字段为 undefined，工具会退回到"无 botId"的错误提示
      imBotId: this.config.imBotId,
    };

    try {
      // 执行工具
      logger.trace(`[AgentLoop] 执行工具: ${executionToolCall.name}`);
      logger.trace('[AgentLoop] 工具参数:', executionToolCall.args);
      const result = await tool.execute(executionToolCall.args, context);
      if (options?.signal?.aborted) {
        const cancelledResult: ToolResult = {
          success: false,
          content: translate('tools.common.toolExecutionCancelled'),
        };
        this.callbacks.onToolCallEnd?.(toolCall, cancelledResult);
        this.setState('running');
        return cancelledResult;
      }

      this.callbacks.onToolCallEnd?.(toolCall, result);
      logger.trace(
        `[AgentLoop] 工具完成: ${toolCall.name} (${result.success ? 'success' : 'failed'})`
      );
      this.setState('running');
      return result;
    } catch (error) {
      if (options?.signal?.aborted) {
        const cancelledResult: ToolResult = {
          success: false,
          content: translate('tools.common.toolExecutionCancelled'),
        };
        this.callbacks.onToolCallEnd?.(toolCall, cancelledResult);
        this.setState('running');
        return cancelledResult;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        success: false,
        content: `Tool execution error: ${errorMessage}`,
      };
      this.callbacks.onToolCallEnd?.(toolCall, result);
      logger.debug(`[AgentLoop] 工具异常结束: ${toolCall.name}`);
      this.setState('running');
      return result;
    }
  }

  /**
   * 构建执行结果
   */
  private buildResult(reason: TerminationReason, error?: string): AgentLoopResult {
    // 获取最后的 assistant 消息作为最终响应
    // 关键：仅搜索当轮新增消息（historyMessageCount 分界线之后），
    // 避免 cancelled 场景下误取历史 assistant 消息导致重复显示
    const allMessages = this.session.getMessages();
    const currentRunMessages = allMessages.slice(this.historyMessageCount);
    const lastAssistantMessage = [...currentRunMessages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content);

    // 静默处理：剥离跨请求上下文恢复信息（rationale + SA observations）
    // 这些内容已写入 session 供下一轮 MB 的 conversationHistory 读取，
    // 但不应在 UI 中作为聊天气泡展示（对用户无意义，且可能造成困惑）
    let uiContent = lastAssistantMessage?.content ?? '';
    const RATIONALE_MARKER =
      '\n\nMB decision progress (system-injected context for the next decision)';
    const markerIndex = uiContent.indexOf(RATIONALE_MARKER);
    if (markerIndex !== -1) {
      uiContent = uiContent.slice(0, markerIndex).trim();
    }

    return {
      // 有内容即成功：确保所有有 rationale 注入的场景都走正常的 usePlanningMode 持久化路径
      // （含 persistContent），而不是走 error 分支创建无 persistContent 的错误消息。
      // 只有完全无内容的真正失败场景才返回 success=false。
      success:
        !!uiContent.trim() ||
        reason === 'text_response' ||
        reason === 'awaiting_interaction' ||
        reason === 'cancelled',
      content: uiContent,
      // 优先使用含 rationale 的完整版；lastAssistantMessage 为空时退回 uiContent
      // 不得退回空字符串——空字符串经 `||` 运算被 usePlanningMode 短路为 undefined，
      // 导致下一轮加载历史时 fallback 到可视化增强后的 content，污染 MB 的对话上下文
      persistContent: lastAssistantMessage?.content ?? uiContent,
      terminationReason: reason,
      iterationCount: this.iterationCount,
      toolCallCount: this.toolCallCount,
      messages: allMessages,
      error,
    };
  }

  /**
   * 在 Tauri IPC 发送前清理 messages 数组的 content 字段
   *
   * session 历史消息中可能含有孤立代理字符（Lone Surrogate，U+D800-U+DFFF），
   * 来源于 MiniMax 等供应商在流式 SSE 中产生的残缺 UTF-16 编码。
   * JS 允许孤立代理存在，但 JSON.stringify 会将其编码为 \uD800 等序列，
   * serde_json 遇到未配对的 surrogate half 直接报 "unexpected end of hex escape"，
   * 导致 Tauri 返回 500，所有供应商的重试请求均失败。
   */
  private sanitizeMessagesForIpc(
    messages: Array<{ role: string; content: string; images?: unknown }>
  ): Array<{ role: string; content: string; images?: unknown }> {
    return messages.map((msg) => ({
      ...msg,
      content: this.sanitizeTextForIpc(msg.content),
    }));
  }

  /**
   * 清理字符串中的非法 Unicode，使其可安全通过 Tauri IPC（serde_json 反序列化）
   *
   * 处理：
   * 1. 孤立高代理（\uD800-\uDBFF 后面不跟 \uDC00-\uDFFF）→ 替换为 \uFFFD
   * 2. 孤立低代理（\uDC00-\uDFFF 前面不是 \uD800-\uDBFF）→ 替换为 \uFFFD
   * 3. Null 字节（\u0000）→ 移除
   */
  private sanitizeTextForIpc(text: string): string {
    if (!text) return text;
    return (
      text
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD') // 孤立高代理
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') // 孤立低代理
        // eslint-disable-next-line no-control-regex
        .replace(/\u0000/g, '')
    ); // null 字节
  }
}
