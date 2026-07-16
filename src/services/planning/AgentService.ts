/**
 * AgentService - Agent 服务层
 *
 * 作为 UI 层与 AgentLoop 的桥接层
 *
 * 核心职责：
 * 1. 管理 AgentSession（会话创建、获取、销毁）
 * 2. 集成记忆系统和 RAG 检索
 * 3. 创建并执行 AgentLoop
 * 4. 提供统一的进度和授权回调接口
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import { AgentLoop } from './agent-loop/AgentLoop';
import {
  AgentSession,
  createAgentSession,
  type AgentSessionConfig,
  type RuntimeContext,
} from './agent-loop/AgentSession';
import type {
  AgentLoopResult,
  AgentLoopCallbacks,
  AgentMessage,
  ReasoningTraceEvent,
  ThinkingPhaseEvent,
  SubAgentObservationEvent,
} from './agent-loop/types';
import type { TaskAttachmentReference } from './sub-agents/types';
import type { GovernorSnapshot } from './agent-loop/LoopGovernor';
import type { ProgressItemData } from '@/types/message';
import { getLogger } from '@services/logger';
import { imageCompressionService } from '@services/attachment/ImageCompressionService';
import type { ReasoningPreset } from '@/config/modelRegistry';

const logger = getLogger('AgentService');
const CANCEL_FORCE_UNLOCK_MS = 10000;

// ==================== 配置类型 ====================

/**
 * AgentService 配置
 */
export interface AgentServiceConfig {
  /** Agent ID */
  agentId: string;
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
  /** AgentVis 统一推理档位，由具体供应商适配器解析。 */
  reasoningPreset?: ReasoningPreset;
  /** 工作目录 */
  workdir?: string;
  /** 自定义 API 基址 URL（用于 Local 代理） */
  baseUrl?: string;
  /**
   * 上下文 ID（用于 Session 隔离）
   *
   * - Agent 模式：等于 agentId
   * - Hub @提及模式：等于 hubId（隔离 Hub 和 Agent 窗口的 Session）
   */
  contextId?: string;
  /**
   * 是否启用 RAG 检索（默认 true）
   *
   * - Agent 模式：启用（检索 Agent 知识库）
   * - Hub @提及模式：禁用（减少上下文压力，与 Chat 模式一致）
   */
  enableRag?: boolean;
  /**
   * 精准命中技能列表
   *
   * 配置后跳过语义检索，直接按名称加载绑定技能的 fullContent。
   * 同时 MB 不加载 installedSkillCatalog，全局技能开关对此 Agent 无效。
   */
  pinnedSkills?: string[];
  /**
   * Agent 头像 base64 数据（用于身份形象感知注入）
   *
   * 从 agentStore 获取，在 MB System Prompt 后以合成 user 消息方式注入，
   * 让 LLM "看到"自己的形象，增强社交互动场景的体验。
   */
  agentAvatar?: string;
  /**
   * MB 最大决策轮次（per-agent 覆盖）
   *
   * 来自 Agent 设置面板的 planningLoopBudget 字段。
   * undefined 时 AgentLoopFSMIntegration 回退到 LOOP_GOVERNOR_INITIAL_BUDGET 全局默认。
   */
  mbDecisionBudget?: number;
  /**
   * 用户关联的外部项目路径
   *
   * 用户在授权弹窗确认后 Agent 具有该目录的全权限。
   * - cwd 切换为 projectPath（方案B）
   * - MB 注入 [PROJECT_CONTEXT] 区块，SA 调投 TaskContext.projectPath
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
 * 处理消息的选项
 */
export interface ProcessMessageOptions {
  /** 进度回调 */
  onProgress?: (items: ProgressItemData[]) => void;
  /** 授权请求回调 */
  onRequestAuthorization?: (path: string) => Promise<boolean>;
  /** 消息回调 */
  onMessage?: (message: AgentMessage) => void;
  /** Diff 数据回调（EditTool 返回 requiresInteraction 时触发） */
  onDiffData?: (diffData: {
    filePath: string;
    originalContent: string;
    newContent: string;
    xml: string;
    batchResult?: unknown; // overwrite/merge 模式无 batchResult，保持与 AgentLoopCallbacks 类型一致
  }) => void;

  // ==================== FSM 驱动模式回调 ====================

  /**
   * 思维链步骤回调（FSM 模式特有）
   *
   * 用于可视化 OODA 循环的执行过程
   */
  onThought?: (step: {
    phase: 'observe' | 'orient' | 'decide' | 'act';
    content: string;
    timestamp: Date;
  }) => void;

  /**
   * 预算更新回调（FSM 模式特有）
   *
   * 用于显示当前剩余预算
   */
  onBudgetUpdate?: (remaining: number, total: number) => void;

  /**
   * 风险更新回调（FSM 模式特有）
   *
   * 用于显示当前风险评分
   */
  onRiskUpdate?: (score: number, threshold: number) => void;

  /**
   * FSM 状态变化回调（FSM 模式特有）
   *
   * 用于可视化状态机执行
   */
  onFSMStateChange?: (from: string, to: string) => void;

  /**
   * 思维阶段事件回调（FSM 可视化 ）
   *
   * 用于显示三阶段思维链：分析 → 规划 → 决策
   */
  onThinkingPhase?: (event: ThinkingPhaseEvent) => void;

  /**
   * Master Brain provider reasoning_content 流事件回调
   *
   * 用于单独展示模型内部推理流，避免混入结构化 Decision 展示。
   */
  onReasoningTrace?: (event: ReasoningTraceEvent) => void;

  /**
   * Master Brain 最终用户回复的累积流快照
   *
   * 仅在决策类型为 RESPOND_TO_USER 时触发，不包含结构化决策 JSON。
   */
  onResponseStream?: (accumulatedContent: string) => void;

  /**
   * 治理器指标更新回调（FSM 可视化 ）
   *
   * 用于显示预算、进度、风险等指标
   */
  onMetricsUpdate?: (snapshot: GovernorSnapshot) => void;

  /**
   * Sub-Agent 实时观测回调
   *
   * 每个执行步骤触发，用于前端实时展示 Sub-Agent 行为
   */
  onSubAgentObservation?: (event: SubAgentObservationEvent) => void;

  // ==================== Sub-Agent 生命周期回调 ====================

  /** Sub-Agent 创建时触发 */
  onSubAgentSpawn?: (spec: import('./sub-agents/types').SubAgentSpec) => void;
  /** Sub-Agent 完成时触发 */
  onSubAgentComplete?: (id: string, output: import('./sub-agents/types').SubAgentOutput) => void;
  /** Sub-Agent 失败时触发 */
  onSubAgentFail?: (id: string, error: string) => void;

  // ==================== 附件上下文 ====================

  /** 附件文本内容（由 UI 层处理后传入，注入到 RuntimeContext.attachments） */
  attachmentContent?: string;

  /** 图片附件的 base64 数据（由 UI 层传入，注入到 AgentLoop 的首轮 LLM 调用） */
  imageAttachments?: Array<{ mime_type: string; data: string }>;

  /** 用户本轮上传的附件路径清单，注入 Sub-Agent TaskContext */
  attachmentReferences?: TaskAttachmentReference[];

  /**
   * 触发本次任务关联的 IM Bot ID（IM 或绑定 IM Bot 的 cron 触发时有值）
   *
   * 由 AgentChatView 从 cron:execute_planning 事件中提取并传入，
   * 透传至 AgentLoop.config.imBotId → ToolExecutionContext.imBotId，
   * 供 IM 发送工具精确路由到当前机器人配置。
   */
  imBotId?: string;

  /**
   * Embedding 警告回调
   *
   * 记忆语义检索或 RAG 向量化失败时调用，供 UI 层弹出非阻塞性提示。
   * 失败属于降级场景，消息流程仍会继续执行（只是缺少记忆上下文辅助）。
   */
  onEmbeddingWarning?: (errorMessage: string) => void;
}

interface ChatHistoryMessageInput {
  role: 'user' | 'assistant';
  content: string;
  /** 消息创建时间戳（Unix ms），用于对话历史时间感知 */
  createdAt?: number;
  /** 历史 user 消息的图片附件（从 metadata.attachments 恢复） */
  images?: Array<{ mime_type: string; data: string }>;
}

// ==================== 主类 ====================

/**
 * AgentService - Agent 服务
 *
 * 设计原则：
 * - 单 Agent 单实例，由 UI 层持有
 * - 内部管理 AgentSession 和 AgentLoop
 * - 集成记忆系统和 RAG 检索
 */
export class AgentService {
  /** 服务配置 */
  private readonly config: AgentServiceConfig;

  /** 当前会话 */
  private session: AgentSession | null = null;

  /** 是否正在处理 */
  private isProcessing = false;

  /** Monotonic run id used to avoid stale cancelled runs clearing a newer run. */
  private processingRunSeq = 0;

  /** Current run id that owns isProcessing/activeLoop. */
  private activeRunId: number | null = null;

  /** Watchdog used when cancellation does not make the active loop settle. */
  private cancelForceUnlockTimer: ReturnType<typeof setTimeout> | null = null;

  /** 当前执行中的 AgentLoop（用于取消） */
  private activeLoop: AgentLoop | null = null;

  /**
   * 取消请求标志位
   *
   * 用于在 activeLoop 创建之前就能中断 loadRuntimeContext。
   * 原始设计中 cancelProcessing 依赖 activeLoop.cancel()，但 activeLoop 在
   * loadRuntimeContext 返回后才赋値，如果 Embedding 卡住则取消永远无效。
   */
  private cancellationRequested = false;

  constructor(config: AgentServiceConfig) {
    this.config = config;
    logger.trace(`[AgentService] 创建服务: agentId=${config.agentId}`);
  }

  private clearCancelForceUnlockTimer(): void {
    if (this.cancelForceUnlockTimer) {
      clearTimeout(this.cancelForceUnlockTimer);
      this.cancelForceUnlockTimer = null;
    }
  }

  private scheduleCancelForceUnlock(): void {
    const runId = this.activeRunId;
    if (!this.isProcessing || runId === null) {
      return;
    }

    this.clearCancelForceUnlockTimer();
    this.cancelForceUnlockTimer = setTimeout(() => {
      if (!this.isProcessing || this.activeRunId !== runId || !this.cancellationRequested) {
        return;
      }

      logger.warn(
        `[AgentService] Cancel did not settle within ${CANCEL_FORCE_UNLOCK_MS}ms; force releasing processing lock: agentId=${this.config.agentId}, runId=${runId}`
      );
      this.isProcessing = false;
      this.activeLoop = null;
      this.activeRunId = null;
      this.cancelForceUnlockTimer = null;
    }, CANCEL_FORCE_UNLOCK_MS);
  }

  private createCancelledResult(message = 'Processing cancelled'): AgentLoopResult {
    return {
      success: true,
      content: '',
      persistContent: '',
      terminationReason: 'cancelled',
      iterationCount: 0,
      toolCallCount: 0,
      messages: [],
      error: message,
    };
  }

  // ==================== 会话管理 ====================

  /**
   * 获取或创建会话
   */
  getOrCreateSession(): AgentSession {
    if (!this.session) {
      const sessionConfig: AgentSessionConfig = {
        agentId: this.config.agentId,
        modelId: this.config.modelId,
      };
      this.session = createAgentSession(sessionConfig);
    }
    return this.session;
  }

  /**
   * 获取当前会话
   */
  getSession(): AgentSession | null {
    return this.session;
  }

  /**
   * 重置会话
   */
  resetSession(): void {
    if (this.session) {
      this.session.clear();
      this.session = null;
    }
    logger.trace(`[AgentService] 会话已重置: agentId=${this.config.agentId}`);
  }

  /**
   * 加载聊天历史到会话
   *
   * 用于在首次处理消息前，将持久化的聊天历史加载到 AgentSession
   * 这确保 Planning 模式能够理解上下文
   *
   * @param messages 历史消息列表（不包含当前用户消息）
   */
  loadChatHistory(messages: ChatHistoryMessageInput[]): void {
    const session = this.getOrCreateSession();
    let imageCount = 0;

    const sessionMessages: AgentMessage[] = messages.map((msg) => {
      if (msg.images && msg.images.length > 0) {
        imageCount += msg.images.length;
      }

      return {
        role: msg.role,
        content: msg.content,
        // 时间戳透传到 Session，供 CONVERSATION_HISTORY 渲染时间标签
        createdAt: msg.createdAt,
        // 图片数据透传到 Session，供 MB 对话历史构建时使用
        ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
      };
    });

    // 每轮都以 UI 从持久化消息重建出的历史快照为准。
    // 其中可能包含历史附件提示、引用恢复、assistant persistContent 等跨请求注入内容；
    // 若复用旧 Session 而不替换，第二轮 MB 会只看到上一轮运行时保存的原始文本。
    session.replaceMessages(sessionMessages);

    logger.trace(
      '[AgentService] 已同步聊天历史:',
      messages.length,
      '条消息',
      imageCount > 0 ? `(含 ${imageCount} 张历史图片)` : ''
    );
  }

  // ==================== 消息处理 ====================

  /**
   * 处理用户消息（核心方法）
   *
   * 流程：
   * 1. 获取或创建会话
   * 2. 加载记忆上下文和 RAG 检索
   * 3. 创建并执行 AgentLoop
   * 4. 返回执行结果
   *
   * @param message 用户消息
   * @param options 处理选项
   * @returns 执行结果
   */
  async processMessage(
    message: string,
    options: ProcessMessageOptions = {}
  ): Promise<AgentLoopResult> {
    if (this.isProcessing) {
      return {
        success: false,
        content: translate('agent.chat.processingInProgress'),
        persistContent: translate('agent.chat.processingInProgress'),
        terminationReason: 'error',
        iterationCount: 0,
        toolCallCount: 0,
        messages: [],
        error: translate('agent.chat.alreadyProcessing'),
      };
    }

    this.isProcessing = true;
    const runId = ++this.processingRunSeq;
    this.activeRunId = runId;
    this.clearCancelForceUnlockTimer();
    // 每次处理新消息前重置取消标志位，避免上一次取消残留影响新请求
    this.cancellationRequested = false;

    try {
      // 1. 获取或创建会话
      const session = this.getOrCreateSession();

      // 2. 加载运行时上下文（记忆 + RAG）
      // 传入 cancellationRequested 标志引用使内部各个 await 点可被中断
      // 传入 onEmbeddingWarning 使 Embedding 失败时能回调 UI 层弹出提示
      const runtimeContext = await this.loadRuntimeContext(message, options.onEmbeddingWarning);
      if (this.activeRunId !== runId) {
        return this.createCancelledResult('Processing cancelled before runtime context completed');
      }

      // 2.5 注入外部附件内容（由 UI 层传入）
      if (options.attachmentContent) {
        runtimeContext.attachments = options.attachmentContent;
        logger.trace('[AgentService] 已注入附件上下文:', options.attachmentContent.length, '字符');
      }

      // 3. 准备上下文（包含预算管理，用于历史压缩和预算计算）
      // 注意：用户消息由 AgentLoop.run() 内部添加，避免重复
      await session.prepareContext(runtimeContext);
      if (this.activeRunId !== runId) {
        return this.createCancelledResult('Processing cancelled before agent loop started');
      }

      // 4. 构建回调
      // 收集 SA 通过 generate_image 工具生成的图片本地路径（供 UI 内联展示）
      const generatedImagePaths: string[] = [];

      const callbacks: AgentLoopCallbacks = {
        onProgress: (msg: string) => {
          // 将字符串进度转换为 ProgressItemData[]
          options.onProgress?.([
            {
              label: msg,
              status: 'running',
              detail: '',
            },
          ]);
        },
        onMessage: options.onMessage,
        onRequestAuthorization: async (_operation: string, target: string) => {
          // 适配授权回调
          if (options.onRequestAuthorization) {
            return options.onRequestAuthorization(target);
          }
          return true; // 默认允许
        },
        // 处理工具调用完成，检测 EditTool 或 FileWriteTool 返回的 Diff 数据
        // 同时收集 generate_image 工具返回的图片路径
        onToolCallEnd: (_toolCall, result) => {
          // 检查是否是 EditTool 或 FileWriteTool 返回的 Diff 数据
          const data = result.data;
          const dataType = data?.type as string | undefined;
          const isEditDiff = dataType === 'file_edit';
          const isFileWriteDiff =
            dataType === 'file_write_overwrite' || dataType === 'file_write_merge';

          if (result.requiresInteraction && data && (isEditDiff || isFileWriteDiff)) {
            logger.trace('[AgentService] 检测到 Diff 数据，触发回调, type:', dataType);
            const xml =
              typeof data.xml === 'string'
                ? data.xml
                : typeof data.diff === 'string'
                  ? data.diff
                  : '';
            options.onDiffData?.({
              filePath: data.filePath as string,
              originalContent: data.originalContent as string,
              newContent: data.newContent as string,
              xml,
              batchResult: data.batchResult,
            });
          }

          // 收集 generate_image 工具生成的图片路径（供 MB 回复消息内联展示）
          if (data?.savedPaths && Array.isArray(data.savedPaths)) {
            generatedImagePaths.push(...(data.savedPaths as string[]));
          }
        },

        // FSM 驱动模式回调（FSM 集成层调用）
        onThought: options.onThought
          ? (step) => {
              options.onThought?.({
                phase: step.phase,
                content: step.content,
                timestamp: step.timestamp,
              });
            }
          : undefined,
        onBudgetUpdate: options.onBudgetUpdate,
        onRiskUpdate: options.onRiskUpdate,

        // FSM 可视化回调
        onThinkingPhase: options.onThinkingPhase,
        onReasoningTrace: options.onReasoningTrace,
        onResponseStream: options.onResponseStream,
        onMetricsUpdate: options.onMetricsUpdate,
        onFSMStateChange: options.onFSMStateChange,

        // Sub-Agent Diff 数据回调（file_write 执行后触发）
        onDiffData: options.onDiffData,
        // Sub-Agent 实时观测回调
        onSubAgentObservation: options.onSubAgentObservation,
        // Sub-Agent 生命周期回调
        onSubAgentSpawn: options.onSubAgentSpawn,
        onSubAgentComplete: options.onSubAgentComplete,
        onSubAgentFail: options.onSubAgentFail,
      };

      // 5. 创建并执行 AgentLoop
      // Session 管理消息历史，AgentLoop 内部会添加用户消息和助手消息
      const loop = new AgentLoop(
        {
          agentId: this.config.agentId,
          tokenContextId: this.config.contextId ?? this.config.agentId,
          agentName: this.config.agentName,
          mbAgentRules: this.config.mbAgentRules,
          saAgentRules: this.config.saAgentRules,
          providerId: this.config.providerId,
          modelId: this.config.modelId,
          reasoningPreset: this.config.reasoningPreset,
          workdir: this.config.workdir,
          baseUrl: this.config.baseUrl,
          // 用户上传的图片 base64 数据，仅首轮 LLM 调用注入
          imageAttachments: options.imageAttachments,
          // 用户上传的附件路径清单，供 SA 通过 TaskContext 直接读取
          attachmentReferences: options.attachmentReferences,
          // 精准命中技能：跳过语义检索，直接加载绑定技能
          pinnedSkills: this.config.pinnedSkills,
          // Agent 头像（身份形象感知注入）
          agentAvatar: this.config.agentAvatar,
          // per-agent MB 决策轮次预算（undefined 时由 FSMIntegration 使用全局默认）
          mbDecisionBudget: this.config.mbDecisionBudget,
          // IM/cron 触发时携带的机器人 ID，透传至 ToolExecutionContext 供工具路由使用
          imBotId: options.imBotId,
          // 用户关联的外部项目路径（平方B：cwd 切换）
          projectPath: this.config.projectPath,
          sandboxMode: this.config.sandboxMode,
          subAgentSafetyFooterEnabled: this.config.subAgentSafetyFooterEnabled,
          subAgentSafetyFooterText: this.config.subAgentSafetyFooterText,
        },
        session,
        callbacks
      );

      // 保存引用（用于取消）
      if (this.activeRunId !== runId) {
        return this.createCancelledResult(
          'Processing cancelled before agent loop ownership was assigned'
        );
      }
      this.activeLoop = loop;

      // 6. 执行循环
      const result = await loop.run(message);
      if (this.activeRunId !== runId) {
        return this.createCancelledResult('Processing cancelled after agent loop settled');
      }

      const clearedGeneratedImageContexts = this.clearGeneratedImageContextImages();
      if (clearedGeneratedImageContexts > 0) {
        logger.trace(
          '[AgentService] generate_image short-term context consumed; cleared assistant image context messages:',
          clearedGeneratedImageContexts
        );
      }

      // 注入 SA 生成的图片路径到 AgentLoopResult（供 UI 内联展示）。
      // 多模态上下文只短期保留最后一张，供下一轮 MB/SA 参考；消费后会清除。
      if (generatedImagePaths.length > 0) {
        result.generatedImages = generatedImagePaths;
        logger.trace(
          '[AgentService] generate_image saved paths collected for UI:',
          generatedImagePaths.length,
          'short-term context path:',
          generatedImagePaths[generatedImagePaths.length - 1]
        );
        logger.trace('[AgentService] 🖼️ 收集到', generatedImagePaths.length, '张 SA 生成图片');

        // 读取图片文件为 base64，注入到 Session 的 assistant 消息
        try {
          const imageDataList: Array<{ mime_type: string; data: string }> = [];
          for (const imgPath of generatedImagePaths.slice(-1)) {
            const fileName = imgPath.split(/[\\/]/).pop() ?? 'generated-image.png';
            try {
              const compressed = await imageCompressionService.compressImage(imgPath, fileName, {
                allowOversizeInput: true,
              });
              const base64 = await imageCompressionService.toBase64(compressed);
              imageDataList.push({ mime_type: compressed.mimeType, data: base64 });
              logger.trace(
                '[AgentService] 生成图历史注入已压缩:',
                fileName,
                `${(compressed.originalSize / 1024 / 1024).toFixed(2)}MB → ${(compressed.compressedSize / 1024 / 1024).toFixed(2)}MB`
              );
            } catch (compressionError) {
              const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
              const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
              const base64 = await invoke<string>('file_read_as_base64', { path: imgPath });
              imageDataList.push({ mime_type: mimeType, data: base64 });
              logger.warn(
                '[AgentService] 生成图历史注入压缩失败，回退原图 base64:',
                compressionError
              );
            }
          }

          // 找到 Session 中最后一条 assistant 消息并附加 images
          const sessionMessages = session.getMessages();
          for (let i = sessionMessages.length - 1; i >= 0; i--) {
            const msg = sessionMessages[i];
            if (msg?.role === 'assistant') {
              msg.images = imageDataList;
              logger.trace(
                '[AgentService] 🖼️ 已将',
                imageDataList.length,
                '张图片注入 Session assistant 消息（供下轮 MB/SA 上下文感知）'
              );
              break;
            }
          }
        } catch (readError) {
          // 图片读取失败不影响主流程，仅记录警告
          logger.warn('[AgentService] 图片注入 Session 失败（不影响 UI 渲染）:', readError);
        }
      }

      // 清除引用
      if (this.activeRunId === runId) {
        this.activeLoop = null;
      }

      // 注意：记忆系统记录已移至 AgentChatView 处理
      // 因为需要使用真正的消息 ID（而非临时 ID）才能正确支持消息撤销时的记忆清理

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[AgentService] 处理消息失败:', error);
      return {
        success: false,
        content: translate('chat.processingFailedWithError', { error: errorMessage }),
        persistContent: translate('chat.processingFailedWithError', { error: errorMessage }),
        terminationReason: 'error',
        iterationCount: 0,
        toolCallCount: 0,
        messages: [],
        error: errorMessage,
      };
    } finally {
      if (this.activeRunId === runId) {
        this.isProcessing = false;
        this.activeLoop = null; // 确保清除引用
        this.activeRunId = null;
        this.clearCancelForceUnlockTimer();
      } else {
        logger.trace(
          `[AgentService] Stale run settled after ownership moved: agentId=${this.config.agentId}, runId=${runId}, activeRunId=${this.activeRunId}`
        );
      }
    }
  }

  /**
   * 取消当前处理
   *
   * 先设置取消标志位，使进行中的 loadRuntimeContext 在下一个 await 后能尽快全透出。
   * 同时调用 activeLoop.cancel()（如果 loop 已建立）中断正在运行的 LLM 调用。
   */
  cancelProcessing(): void {
    // 先设置标志位：即使 loop 还未创建，也能在 loadRuntimeContext 的下一个 await 点断开
    this.cancellationRequested = true;

    if (this.activeLoop) {
      this.activeLoop.cancel();
      logger.debug(`[AgentService] 已取消处理: agentId=${this.config.agentId}`);
    } else {
      logger.debug(`[AgentService] 没有活动的处理可取消: agentId=${this.config.agentId}`);
    }

    this.scheduleCancelForceUnlock();
  }

  /**
   * Clear generated-image short-term visual context after it has had one turn to inform MB/SA.
   *
   * Only AgentService writes images onto assistant messages for generate_image outputs; user
   * attachments and tool observation images stay on their own user/tool paths and are untouched.
   */
  private clearGeneratedImageContextImages(): number {
    const session = this.session;
    if (!session) return 0;

    let cleared = 0;
    for (const msg of session.getMessages()) {
      if (msg.role === 'assistant' && msg.images && msg.images.length > 0) {
        delete msg.images;
        cleared++;
      }
    }

    return cleared;
  }

  // ==================== 上下文加载 ====================

  /**
   * 加载运行时上下文（记忆 + RAG）
   *
   * @param userQuery - 用户查询语句
   * @param onEmbeddingWarning - 向量化失败时的非阻塞回调，使 UI 层可弹出友好提示
   */
  private async loadRuntimeContext(
    userQuery: string,
    onEmbeddingWarning?: (errorMessage: string) => void
  ): Promise<RuntimeContext> {
    // 用封闭引用实例自身的 cancellationRequested，任何时刻都能读到最新实时値
    const isCancelled = () => this.cancellationRequested;

    const context: RuntimeContext = {
      // MB rules 传递给 RuntimeContext（用于 AgentSession 的 identityPrompt）
      // SA rules 不需要在这里传递，通过 AgentLoop 链路传递
      agentRules: this.config.mbAgentRules,
    };

    try {
      // 1. 加载记忆上下文
      const { memoryContextProvider } = await import('@services/memory/MemoryContextProvider');
      const memoryContext = await memoryContextProvider.getMemoryContext(this.config.agentId, {
        userQuery,
      });

      // 检查是否已取消：记忆加载（含 embedding）完成后立即检查，避免启动进一步的 RAG
      if (isCancelled()) {
        logger.trace('[AgentService] loadRuntimeContext: 已取消，跳过剩余步骤');
        return context;
      }

      // 转换为 RuntimeContext 格式
      context.facts = memoryContext.facts.map((f) => ({
        id: f.id,
        content: f.content,
        category: f.category ?? undefined,
      }));

      context.summaries = memoryContext.summaries.map((s) => ({
        id: s.id,
        content: s.content,
      }));

      logger.trace('[AgentService] 已加载记忆上下文:', {
        facts: context.facts.length,
        summaries: context.summaries.length,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[AgentService] 加载记忆上下文失败');

      // 检测是否为 Embedding 相关错误（超时或 API 调用失败）
      // 失败不阻塞发送流程，但需告知用户语义检索已降级
      const isEmbeddingRelated =
        errorMsg.includes('Embedding API') ||
        errorMsg.includes('cloud_embedding') ||
        errorMsg.includes('embedding');
      if (isEmbeddingRelated && onEmbeddingWarning) {
        onEmbeddingWarning('RAG_EMBEDDING_UNAVAILABLE');
      }
    }

    // 2. RAG 检索（可配置，Hub @提及模式下禁用）
    if (this.config.enableRag !== false) {
      // 再次检查取消（记忆加载耗时后用户可能已点击取消）
      if (isCancelled()) {
        logger.trace('[AgentService] loadRuntimeContext: 已取消，跳过 RAG 检索');
        return context;
      }
      try {
        const { getRagService } = await import('@services/rag');
        const ragService = getRagService();
        const ragResults = await ragService.retrieveAndFormat(this.config.agentId, userQuery, {
          topK: 5,
        });

        if (ragResults.trim()) {
          context.ragResults = ragResults;
          logger.trace('[AgentService] RAG 检索成功:', ragResults.length, '字符');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn('[AgentService] RAG 检索失败');

        // RAG 检索失败也可能源于 Embedding 超时，同样需要回调通知
        const isEmbeddingRelated =
          errorMsg.includes('Embedding API') ||
          errorMsg.includes('cloud_embedding') ||
          errorMsg.includes('embedding');
        if (isEmbeddingRelated && onEmbeddingWarning) {
          onEmbeddingWarning('RAG_EMBEDDING_UNAVAILABLE');
        }
      }
    } else {
      logger.trace('[AgentService] RAG 检索已禁用（Hub @提及模式）');
    }

    return context;
  }

  // ==================== 状态查询 ====================

  /**
   * 检查是否正在处理
   */
  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * 获取配置
   */
  getConfig(): AgentServiceConfig {
    return { ...this.config };
  }
}

// ==================== 服务管理 ====================

/** 服务实例缓存（按 agentId 缓存） */
const serviceCache = new Map<string, AgentService>();

/**
 * 获取或创建 AgentService
 *
 * 缓存策略：
 * - 使用 contextId 作为缓存 key（实现 Hub/Agent 窗口隔离）
 * - contextId 不存在时回退到 agentId（向后兼容）
 *
 * 注意：如果模型配置（providerId/modelId/baseUrl）发生变化，会自动销毁旧服务并创建新的
 */
export function getOrCreateAgentService(config: AgentServiceConfig): AgentService {
  // 使用 contextId 作为缓存 key（实现 Hub/Agent 隔离）
  const cacheKey = config.contextId ?? config.agentId;
  const cached = serviceCache.get(cacheKey);

  if (cached) {
    // 检查关键配置是否变化（模型供应商、模型 ID、API 基址、Agent 规则）
    const cachedConfig = cached.getConfig();
    const configChanged =
      cachedConfig.providerId !== config.providerId ||
      cachedConfig.modelId !== config.modelId ||
      cachedConfig.reasoningPreset !== config.reasoningPreset ||
      cachedConfig.baseUrl !== config.baseUrl ||
      cachedConfig.mbAgentRules !== config.mbAgentRules ||
      cachedConfig.saAgentRules !== config.saAgentRules ||
      // 精准命中技能变化检测（绑定技能变化需要重建 AgentLoop 以重新初始化注入逻辑）
      JSON.stringify(cachedConfig.pinnedSkills) !== JSON.stringify(config.pinnedSkills) ||
      // per-agent 决策预算变化需重建（当前 loop 已完成时下次自然生效）
      cachedConfig.mbDecisionBudget !== config.mbDecisionBudget ||
      // 项目路径变化：应立即重建，确保 cwd/快照/守卫全部切换到新项目
      cachedConfig.projectPath !== config.projectPath ||
      cachedConfig.sandboxMode !== config.sandboxMode ||
      cachedConfig.subAgentSafetyFooterEnabled !== config.subAgentSafetyFooterEnabled ||
      cachedConfig.subAgentSafetyFooterText !== config.subAgentSafetyFooterText;

    if (configChanged) {
      // 如果旧服务正在处理任务，不立即销毁，返回旧服务继续用当前配置执行
      // 任务完成后下次调用 getOrCreateAgentService 时会自然检测到配置变化并重建
      if (cached.getIsProcessing()) {
        logger.warn('[AgentService] 配置已变化但服务正在执行任务，延迟重建以避免中断', {
          cacheKey,
          old: { provider: cachedConfig.providerId, model: cachedConfig.modelId },
          new: { provider: config.providerId, model: config.modelId },
        });
        return cached;
      }
      logger.trace('[AgentService]  检测到配置变化，重建服务:', {
        cacheKey,
        old: {
          provider: cachedConfig.providerId,
          model: cachedConfig.modelId,
          hasMbRules: !!cachedConfig.mbAgentRules,
          hasSaRules: !!cachedConfig.saAgentRules,
        },
        new: {
          provider: config.providerId,
          model: config.modelId,
          hasMbRules: !!config.mbAgentRules,
          hasSaRules: !!config.saAgentRules,
        },
      });
      // 销毁旧服务
      cached.resetSession();
      serviceCache.delete(cacheKey);
      // 继续创建新服务
    } else {
      return cached;
    }
  }

  const service = new AgentService(config);
  serviceCache.set(cacheKey, service);
  logger.trace('[AgentService] 创建新服务, cacheKey:', cacheKey, 'agentId:', config.agentId);
  return service;
}

export function cancelCachedAgentService(contextIdOrAgentId: string): boolean {
  const service = serviceCache.get(contextIdOrAgentId);
  if (!service) {
    logger.trace('[AgentService] 未找到可取消的缓存服务:', contextIdOrAgentId);
    return false;
  }

  service.cancelProcessing();
  return true;
}

/**
 * 销毁指定 Agent 的服务
 */
export function destroyAgentService(agentId: string): void {
  const service = serviceCache.get(agentId);
  if (service) {
    service.resetSession();
    serviceCache.delete(agentId);
    logger.trace(`[AgentService] 已销毁服务: ${agentId}`);
  }
}

/**
 * 清空所有服务缓存
 */
export function clearAllAgentServices(): void {
  for (const [, service] of serviceCache) {
    service.resetSession();
  }
  serviceCache.clear();
  logger.trace('[AgentService] 已清空所有服务缓存');
}
