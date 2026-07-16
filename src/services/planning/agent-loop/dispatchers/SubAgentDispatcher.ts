/**
 * SubAgentDispatcher - SubAgent 生命周期管理器
 *
 * 职责：
 * 1. 构建 TaskContext
 * 2. 创建 LLM Caller
 * 3. 执行 SubAgent
 * 4. 处理执行结果
 */

import { SubAgentRunner } from '../../sub-agents/SubAgentRunner';
// fastApplyService 和 diffToXml 使用懒加载动态导入
// 避免模块顶层实例化 DOMParser（browser-only API），确保 node 测试环境兼容
import {
  SubAgentLLMCallerFactory,
  type ToolCallInfo,
  type ToolExecutionResult,
  type VisionFallbackMode,
} from '../callers/SubAgentLLMCaller';
import { getContextWindowSize, type ReasoningPreset } from '@/config/modelRegistry';
import type { AgentSession } from '../AgentSession';
import type { AgentLoopCallbacks } from '../types';
import type {
  SubAgentSpec,
  CheckpointCallback,
  ExternalGuideSkillInfo,
  ExternalScriptSkillInfo,
} from '../../brain/types';
import type {
  SubAgentOutput,
  TaskAttachmentReference,
  TaskContext,
  WorkdirFileInfo,
} from '../../sub-agents/types';
import type { FSMEvent } from '../../fsm/types';
import type { SkillDefinition } from '../../skills/types';
import type { TaskArtifactStore } from '../../artifact/TaskArtifactStore';
import type { TaskArtifactSnapshot } from '../../artifact/types';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('SubAgentDispatcher');

interface RunnerHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: Array<{ mimeType: string; data: string }>;
}

interface ToolExecuteOptions {
  isSubAgentContext?: boolean;
  workdirOverride?: string;
  sandboxRoots?: string[];
  signal?: AbortSignal;
}

/**
 * SubAgent 派遣配置
 */
export interface SubAgentDispatcherConfig {
  providerId: string;
  modelId: string;
  reasoningPreset?: ReasoningPreset;
  baseUrl?: string;
  workdir?: string;
  /** 当前 Agent 的沙箱模式，用于 Sub-Agent prompt 与工具 observation 的运行时感知 */
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  /** 用户自定义角色规则（注入 Sub-Agent system prompt） */
  agentRules?: string;
  /** 是否启用 Sub-Agent 每步 Safety Footer 热区提示词。 */
  subAgentSafetyFooterEnabled?: boolean;
  /** Sub-Agent Safety Footer 的自定义提示词文本。 */
  subAgentSafetyFooterText?: string;
  /** Agent ID（用于交付物索引等需要关联 Agent 的场景） */
  agentId?: string;
  tokenContextId?: string;
  /**
   * 原始交付物目录（仅在 projectPath 切换时有值）
   *
   * 当用户关联了外部项目路径后，workdir 已切换为 projectPath，
   * deliverableWorkdir 保留原始交付物目录引用，供需要跨目录访问的场景使用
   * （如 DeliverableIndexer 索引、跨 Agent 协作文件访问等）。
   */
  deliverableWorkdir?: string;
  /** 本轮用户上传的附件路径清单，直接注入 SA TaskContext */
  attachmentReferences?: TaskAttachmentReference[];
}

/**
 * 派遣结果
 */
export interface DispatchResult {
  /** FSM 事件 */
  event: FSMEvent;
  /** SubAgent 输出 */
  output?: SubAgentOutput;
  /** 是否有进展 */
  madeProgress: boolean;
  /** 是否创建了子智能体 */
  spawnedSubAgent: boolean;
}

/**
 * SubAgent 派遣器
 */
export class SubAgentDispatcher {
  private readonly runner: SubAgentRunner;
  private readonly llmCallerFactory: SubAgentLLMCallerFactory;
  /** 跨 SA 生命周期的中间成果存储 */
  private artifactStore?: TaskArtifactStore;
  /** 记忆系统中已有的任务经验（注入 SA prompt 避免重复报告） */
  private taskExperiences: Array<{ content: string }> = [];
  /** 所有已安装的 External 技能名称（全量，用于 SA prompt 目录提示） */
  private allInstalledSkillNames: string[] = [];
  /** 当次命中的外部 Script 技能（用于 SA contract 注入） */
  private externalScriptSkills?: ExternalScriptSkillInfo[];
  /** 当前 dispatch 的开始时间戳，用于限定 DeliverableIndexer 的扫描范围 */
  private dispatchStartTime: number = Date.now();
  /** 实时 Diff 合并：记录每个文件路径首次被修改时的原始内容，用于同一文件多次修改时的增量合并 */
  private firstOriginalContentByPath?: Map<string, string>;
  /**
   * 配对好的历史对话消息（含图片）
   *
   * 由 StateHandlers.handleDispatch 在调用 dispatch() 前通过 setPairedHistoryMessages() 设置，
   * 在 dispatchWithDynamicLoop 内透传给 SubAgentRunner.runWithDynamicLoop();
   * dispatch 返回后由 StateHandlers 清空 sharedState 引用。
   */
  private pendingPairedHistoryMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    images?: Array<{ mimeType: string; data: string }>;
  }>;

  constructor(
    private session: AgentSession,
    private callbacks: AgentLoopCallbacks,
    private config: SubAgentDispatcherConfig,
    executeTool: (
      toolCall: ToolCallInfo,
      options?: ToolExecuteOptions
    ) => Promise<ToolExecutionResult>,
    private skills: SkillDefinition[],
    private externalGuideSkills?: ExternalGuideSkillInfo[]
  ) {
    this.runner = new SubAgentRunner();
    // 新架构：传递 toolExecutor 给 Runner，启用原子事件循环
    this.runner.setToolExecutor(executeTool);
    // HITL：绑定 UI contextId，使 Runner 内的步间暂停检查能关联 hitlStore
    // agentId 在执行期间不变，直接在构造时注入即可
    const runnerContextId = config.tokenContextId ?? config.agentId;
    if (runnerContextId) {
      this.runner.setContextId(runnerContextId);
    }
    if (config.tokenContextId) {
      this.runner.setTokenContextId(config.tokenContextId);
    }
    // 实时观测：将 UI 层回调传递给 Runner
    if (callbacks.onSubAgentObservation) {
      this.runner.setObservationCallback(callbacks.onSubAgentObservation);
    }
    // 实时 Diff：file_write 执行后立即发射到 UI
    if (callbacks.onDiffData) {
      this.setupRealtimeDiffCallback(callbacks.onDiffData);
    }
    this.llmCallerFactory = new SubAgentLLMCallerFactory(
      {
        providerId: config.providerId,
        modelId: config.modelId,
        reasoningPreset: config.reasoningPreset,
        baseUrl: config.baseUrl,
        subAgentSafetyFooterEnabled: config.subAgentSafetyFooterEnabled,
        subAgentSafetyFooterText: config.subAgentSafetyFooterText,
      },
      executeTool
    );
  }

  /**
   * 动态更新外部 Guide 技能列表
   *
   * 每次 MasterBrain 决策时通过 SkillRetriever 动态检索到的 Guide 技能，
   * 需要在 DISPATCH 阶段注入 SA 的 System Prompt。
   * 由于技能是按用户意图动态检索的（非静态），不能在构造时传入。
   */
  setExternalGuideSkills(skills?: ExternalGuideSkillInfo[]): void {
    this.externalGuideSkills = skills;
  }

  /**
   * 动态更新外部 Script 技能列表
   */
  setExternalScriptSkills(skills?: ExternalScriptSkillInfo[]): void {
    this.externalScriptSkills = skills;
  }

  /**
   * 更新全量已安装 External 技能名称列表
   *
   * 仅携带技能名称（string[]），不含 fullContent，token 消耗极低。
   * 由 StateHandlers 在 DISPATCH 阶段调用，数据来自 getInstalledSkillCatalog()。
   * SubAgentPromptBuilder 利用此列表与当次命中技能取差集，
   * 在 Guide Section 尾部生成"其他可参考技能"目录，
   * 使 SA 能感知复合技能中引用的其他技能的存在并自行查阅 SKILL.md。
   */
  setAllInstalledSkillNames(names: string[]): void {
    this.allInstalledSkillNames = names;
  }

  setVisionFallbackMode(mode: VisionFallbackMode): void {
    this.llmCallerFactory.setVisionFallbackMode(mode);
  }

  /**
   * 设置 Task Artifact Store（跨 SA 生命周期的中间成果持久化）
   *
   * 由 AgentLoopFSMIntegration 在初始化时注入，
   * Store 同时传递给 SubAgentRunner 实现自动提取。
   */
  setArtifactStore(store: TaskArtifactStore): void {
    this.artifactStore = store;
    this.runner.setArtifactStore(store);
  }

  /**
   * 设置记忆系统中已有的任务经验
   *
   * 由 StateHandlers DISPATCH 阶段注入，传递给 SA 的 SubAgentPromptBuilder，
   * 使 SA 能感知已有经验并避免重复报告。
   */
  setTaskExperiences(experiences: Array<{ content: string }>): void {
    this.taskExperiences = experiences;
  }

  /**
   * 设置配对好的历史对话消息（供 dispatchWithDynamicLoop 透传给 Runner）
   *
   * 由 StateHandlers.handleDispatch 在 dispatch() 前调用，将历史图片以配对消息的形式射入 SA。
   * dispatch 完成后由 StateHandlers 清空 sharedState 中的引用。
   */
  setPairedHistoryMessages(
    messages?: Array<{
      role: 'user' | 'assistant';
      content: string;
      images?: Array<{ mimeType: string; data: string }>;
    }>
  ): void {
    this.pendingPairedHistoryMessages = messages;
  }

  /**
   * 派遣 SubAgent 执行任务
   *
   * @param spec - SubAgent 规格
   * @param onCheckpoint - 可选的 Checkpoint 回调（Loop 模式必需）
   * @param signal - 可选的中断信号（用户点击终止时触发）
   */
  async dispatch(
    spec: SubAgentSpec,
    onCheckpoint?: CheckpointCallback,
    signal?: AbortSignal,
    /** 用户上传的图片附件（透传给 SA 使其能"看到"图片） */
    imageAttachments?: Array<{ mimeType: string; data: string }>,
    /** 图片附件持久化后的路径（SA 可用于 generate_image 的 ref_image_path） */
    savedAttachmentPaths?: string[]
  ): Promise<DispatchResult> {
    // 所有 SA 都走动态循环模式
    if (!onCheckpoint) {
      throw new Error('onCheckpoint callback is required for SubAgent dispatch');
    }
    return this.dispatchWithDynamicLoop(
      spec,
      onCheckpoint,
      signal,
      imageAttachments,
      savedAttachmentPaths
    );
  }

  /**
   * 动态循环执行模式
   *
   * Sub-Agent 在循环中执行，定期向 Master Brain 汇报进度，
   * 由 Master Brain 决策是否继续、调整策略或终止。
   */
  private async dispatchWithDynamicLoop(
    spec: SubAgentSpec,
    onCheckpoint: CheckpointCallback,
    signal?: AbortSignal,
    imageAttachments?: Array<{ mimeType: string; data: string }>,
    savedAttachmentPaths?: string[]
  ): Promise<DispatchResult> {
    // 记录任务开始时间，用于 DeliverableIndexer 限定扫描范围
    this.dispatchStartTime = Date.now();
    // 重置实时 Diff 合并状态（每次派遣独立隔离）
    this.firstOriginalContentByPath?.clear();
    this.callbacks.onProgress?.(`Creating loop Sub-Agent: ${spec.role}`);
    this.callbacks.onSubAgentSpawn?.(spec);

    const agentId = crypto.randomUUID();

    try {
      const shouldIncludeHistory = spec.includeHistory === true;

      const historyMessagesForRunner = shouldIncludeHistory
        ? (this.buildRunnerHistoryMessages() ?? this.pendingPairedHistoryMessages)
        : undefined;
      logger.trace('[SubAgentDispatcher] History injection gate:', {
        includeHistory: shouldIncludeHistory,
        runnerHistoryCount: historyMessagesForRunner?.length ?? 0,
        sequence: this.summarizeRunnerHistoryMessages(historyMessagesForRunner),
      });

      // 1. 构建任务上下文。对话历史统一走 Runner messages[]，避免 system prompt 与 messages[] 割裂。
      const taskContext = await this.buildTaskContext();

      // 2. 设置 LLM Caller
      const llmCaller = this.llmCallerFactory.create();
      this.runner.setLLMCaller(llmCaller);

      // 3. 执行动态决策循环
      logger.debug('[SubAgentDispatcher]  开始执行动态决策循环...');
      const output: SubAgentOutput = await this.runner.runWithDynamicLoop(
        spec,
        taskContext,
        onCheckpoint,
        this.skills,
        signal,
        this.externalGuideSkills,
        this.externalScriptSkills,
        undefined, // overrideSystemPrompt
        imageAttachments,
        savedAttachmentPaths,
        this.allInstalledSkillNames,
        historyMessagesForRunner // 历史消息（注入 SA messages[] 首条任务指令之前）
      );
      // 消费后立即清空，防止后续 SA 重复接收
      this.pendingPairedHistoryMessages = undefined;
      logger.debug('[SubAgentDispatcher]  动态循环执行完成:');
      logger.debug('[SubAgentDispatcher]   - status:', output.status);

      // 4. 通知 UI：Sub-Agent 生命周期结束
      this.callbacks.onSubAgentComplete?.(agentId, output);

      // 5. 构建 DispatchResult
      return this.buildDispatchResult(spec, output);
    } catch (error) {
      logger.error('[SubAgentDispatcher]  动态循环执行失败:', error);
      this.callbacks.onSubAgentFail?.(agentId, String(error));

      return {
        event: {
          type: 'ACTION_FAILED',
          error: String(error),
        },
        madeProgress: false,
        spawnedSubAgent: true,
      };
    }
  }

  /**
   * 构建派遣结果（公共方法，复用于 dispatchOnce 和 dispatchWithDynamicLoop）
   */
  private buildDispatchResult(spec: SubAgentSpec, output: SubAgentOutput): DispatchResult {
    // 发送思维链可视化事件
    this.callbacks.onThought?.({
      phase: 'act',
      content: `[Sub-Agent:${spec.role}] ${output.observations}`,
      timestamp: new Date(),
    });

    if (output.status === 'completed') {
      // 发射最终结果观测事件：将 Sub-Agent 的任务输出传递给 UI
      // observations 包含 LLM 最终文本回复（如 `{ success: true, result: "..." }` 的原文）
      // this.callbacks.onSubAgentObservation?.({
      // thinking: '',
      // result: output.observations,
      // timestamp: Date.now(),
      // });

      if (output.requiresInteraction) {
        logger.debug('[SubAgentDispatcher]  检测到交互需求，将信号传递给 MasterBrain');
      }

      // [Diff 数据已通过 diffDataCallback 实时发射，无需批量发射]
      // collectedDiffData 仍然保留在 SubAgentOutput.diffDataList 用于日志审计和 failover 场景
      if (output.diffDataList && output.diffDataList.length > 0) {
        logger.debug(
          `[SubAgentDispatcher] 📦 SA 完成，共产生 ${output.diffDataList.length} 个 Diff 记录（已实时发射）`
        );
      }

      const messageContent = output.requiresInteraction
        ? `${output.observations}\n\n${translate('chat.subAgentPreviewRequiresConfirmation')}`
        : output.observations;

      this.session.addMessage({
        role: 'tool',
        content: messageContent,
        toolName: `sub_agent_${spec.role}`,
      });

      // 异步扫描工作目录中的未索引二进制交付物（xlsx/docx/pptx/pdf）
      // 使用 fire-and-forget 模式，不阻塞 dispatch 结果返回
      // 传入 dispatchStartTime 限定扫描范围为本次任务期间新创建的文件，
      // 避免用户从知识库手动移除的旧文件被重新索引
      if (this.config.workdir && this.config.agentId) {
        const indexAgentId = this.config.agentId;
        const workdir = this.config.workdir;
        const taskStartTime = this.dispatchStartTime;
        import('../../utils/DeliverableIndexer')
          .then(({ indexUnindexedDeliverables }) => {
            return indexUnindexedDeliverables(indexAgentId, workdir, taskStartTime);
          })
          .catch((err: unknown) => {
            logger.warn('[SubAgentDispatcher] 加载 DeliverableIndexer 失败:', err);
          });
      }

      return {
        event: {
          type: 'ACTION_COMPLETED',
          result: {
            subAgentOutput: output,
            observations: output.observations,
            requiresInteraction: output.requiresInteraction,
          },
        },
        output,
        madeProgress: true,
        spawnedSubAgent: true,
      };
    } else {
      // [Diff 数据已通过 diffDataCallback 实时发射，无需批量发射]
      if (output.diffDataList && output.diffDataList.length > 0) {
        logger.debug(
          `[SubAgentDispatcher] 📦 (失败但有已完成的修改) 共 ${output.diffDataList.length} 个 Diff 记录（已实时发射）`
        );
      }

      // 将失败 SA 的中间成果写入 session，确保 MB 重新派遣时能传递前序成果
      // observations 已包含增强版摘要（web_search 1500字符、read 800字符）
      const toolCallSummary =
        output.toolCalls && output.toolCalls.length > 0
          ? `\n\n${translate('chat.subAgentCompletedToolCallSummary', {
              count: output.toolCalls.length,
              tools: output.toolCalls.join(', '),
            })}`
          : '';
      // 无论是否有 toolCalls，只要 SA 失败就注入 recoveryHint
      // 解决 SA 单步 API 中断时 MB 完全无感知的问题
      const recoveryHint =
        output.toolCalls && output.toolCalls.length > 0
          ? `\n\n${translate('chat.subAgentRecoveryWithTools')}`
          : `\n\n${translate('chat.subAgentRecoveryWithoutTools', {
              error: output.error ?? translate('chat.subAgentUnknownError'),
            })}`;
      this.session.addMessage({
        role: 'tool',
        content: output.observations + toolCallSummary + recoveryHint,
        toolName: `sub_agent_${spec.role}`,
      });

      // 若 SA 已完成了有效工具调用，标记为部分进展
      // 使 LoopGovernor 不会因"无进展"而过早终止
      const hasPartialProgress = (output.toolCalls?.length ?? 0) > 0;

      return {
        event: {
          type: 'ACTION_FAILED',
          error: output.error ?? 'Sub-Agent execution failed',
        },
        output,
        madeProgress: hasPartialProgress,
        spawnedSubAgent: true,
      };
    }
  }

  /**
   * 构建注入 Runner messages[] 的历史消息。
   *
   * 当 MB 显式 includeHistory 时，历史统一放在 messages[] 前段，
   * system prompt 不再渲染 conversationHistory，避免同一段历史分散在两个载体里。
   */
  private buildRunnerHistoryMessages(): RunnerHistoryMessage[] | undefined {
    const keepRounds = PLANNING_CONSTANTS.MASTER_BRAIN_HISTORY_KEEP_ROUNDS;
    const allMessages = this.session.getMessages();
    const recentMessages = allMessages
      .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
      .slice(-(keepRounds * 2));

    const historyMessages: RunnerHistoryMessage[] = [];
    for (const message of recentMessages) {
      const role = message.role as 'user' | 'assistant';
      const content =
        typeof (message as { content?: unknown }).content === 'string'
          ? (message as { content: string }).content
          : '';
      const images = this.normalizeHistoryImages((message as { images?: unknown }).images);

      if (role === 'assistant' && images.length > 0) {
        if (content.trim()) {
          historyMessages.push({ role: 'assistant', content });
        }
        historyMessages.push({
          role: 'user',
          content: translate('planning.masterBrain.historicalGeneratedImageReference'),
          images,
        });
        continue;
      }

      if (!content.trim() && images.length === 0) continue;

      historyMessages.push({
        role,
        content:
          content ||
          translate(
            role === 'user'
              ? 'planning.masterBrain.historicalUserMessagePlaceholder'
              : 'planning.masterBrain.historicalAssistantMessagePlaceholder'
          ),
        ...(images.length > 0 ? { images } : {}),
      });
    }

    return historyMessages.length > 0 ? historyMessages : undefined;
  }

  private normalizeHistoryImages(images: unknown): Array<{ mimeType: string; data: string }> {
    if (!Array.isArray(images)) return [];

    return images
      .map((image): { mimeType: string; data: string } | null => {
        if (!image || typeof image !== 'object') return null;
        const record = image as {
          mimeType?: unknown;
          mime_type?: unknown;
          data?: unknown;
        };
        if (typeof record.data !== 'string' || record.data.length === 0) {
          return null;
        }
        const mimeType =
          typeof record.mimeType === 'string'
            ? record.mimeType
            : typeof record.mime_type === 'string'
              ? record.mime_type
              : 'image/webp';
        return { mimeType, data: record.data };
      })
      .filter((image): image is { mimeType: string; data: string } => image != null);
  }

  private summarizeRunnerHistoryMessages(messages?: RunnerHistoryMessage[]): Array<{
    index: number;
    role: 'user' | 'assistant';
    imageCount: number;
    contentPreview: string;
  }> {
    return (messages ?? []).map((message, index) => ({
      index,
      role: message.role,
      imageCount: message.images?.length ?? 0,
      contentPreview: message.content.replace(/\s+/g, ' ').slice(0, 80),
    }));
  }

  /**
   * 构建 Sub-Agent 任务上下文
   * 对话历史不再写入 TaskContext/system prompt；includeHistory=true 时由 Runner messages[] 前缀承载。
   */
  private async buildTaskContext(): Promise<TaskContext> {
    // 提取所有消息
    const allMessages = this.session.getMessages();

    // 提取最近的工具调用结果作为上下文
    const recentToolResults = allMessages
      .filter((m: { role: string }) => m.role === 'tool')
      .slice(-3);

    // 获取模型总上下文窗口（用于 SA 内部阈值计算和 Artifact 快照预算）
    const totalTokens = getContextWindowSize(this.config.modelId, this.config.providerId);

    // 从 Artifact Store 获取前序 SA 的中间成果快照
    // Artifact 预算 = 总窗口的 15%（SA 总结文字体量远小于此上限，留足余量）
    let artifactSnapshot: TaskArtifactSnapshot | undefined;
    if (this.artifactStore && !this.artifactStore.isEmpty()) {
      const artifactBudget = Math.floor(totalTokens * 0.15);
      artifactSnapshot = this.artifactStore.getSnapshot(artifactBudget);
      logger.trace(
        `[SubAgentDispatcher] 📦 注入 Artifact 快照: ` +
          `${artifactSnapshot.artifacts.length}/${artifactSnapshot.index.length} 条, ` +
          `${artifactSnapshot.totalTokens} tokens`
      );
    }

    // 提取 HITL 用户介入消息，作为最高优先级约束
    // user_intervention 与普通工具 Artifact 平级会被淹没；单独提取后由
    // SubAgentPromptBuilder 置于系统提示最前位置渲染，确保新 SA 第一眼就看到约束。
    let hitlOverride: string | undefined;
    if (this.artifactStore && !this.artifactStore.isEmpty()) {
      const interventions = this.artifactStore.getByType('user_intervention');
      if (interventions.length > 0) {
        hitlOverride = interventions.map((a) => a.content).join('\n---\n');
        logger.debug(`[SubAgentDispatcher] 🚨 提取 HITL 介入约束: ${interventions.length} 条`);
      }
    }

    // 扫描工作目录已有文件，使 SA 感知文件系统状态（最新 50 个 + 总文件数）
    const { files: existingFiles, totalFileCount, scanTruncated } = await this.scanWorkdirFiles();

    const attachmentReferences = this.config.attachmentReferences?.filter((attachment) =>
      attachment.path.trim()
    );

    return {
      cwd: this.config.workdir,
      ...(attachmentReferences?.length
        ? {
            attachments: attachmentReferences,
            attachmentInstruction: translate('planning.subAgent.attachmentContextInstruction'),
          }
        : {}),
      sandboxMode: this.config.sandboxMode ?? 'LocalAudit',
      files: existingFiles.length > 0 ? existingFiles : undefined,
      totalFileCount: totalFileCount > 0 ? totalFileCount : undefined,
      workdirScanTruncated: scanTruncated ? true : undefined,
      data: {
        recentToolResults: recentToolResults.map((m: { toolName?: string; content: string }) => ({
          name: m.toolName,
          content: m.content,
        })),
        // 用户自定义角色规则（由 SubAgentPromptBuilder 注入 system prompt）
        ...(this.config.agentRules ? { agentRules: this.config.agentRules } : {}),
        // HITL 用户介入强制约束（最高优先级，渲染在系统提示最前）
        ...(hitlOverride ? { hitlOverride } : {}),
        // Task Artifact 快照（前序 SA 的中间成果）
        ...(artifactSnapshot ? { artifactSnapshot } : {}),
        // 记忆系统中已有的任务经验（SA 用于参考和避免重复报告）
        ...(this.taskExperiences.length > 0 ? { taskExperiences: this.taskExperiences } : {}),
      },
      contextWindowSize: totalTokens,
    };
  }

  /**
   * 配置实时 Diff 回调（含同一文件多次修改的增量合并）
   *
   * 维护 firstOriginalContentByPath Map：
   * - 首次修改某文件：记录 originalContent，直接发射
   * - 后续修改同一文件：使用首次 originalContent + 最新 newContent 重新生成 diff/XML
   *
   * 清理时机：每次 dispatch 开始时重置 Map（dispatchWithDynamicLoop 入口）
   */
  private setupRealtimeDiffCallback(
    onDiffData: NonNullable<AgentLoopCallbacks['onDiffData']>
  ): void {
    // 跨 SA 增量合并：仅首次调用时初始化 Map，后续 SA 复用已记录的首次原始内容
    // 这样多轮 SA 修改同一文件时，能正确以首轮原始内容为基准累计 diff
    this.firstOriginalContentByPath ??= new Map<string, string>();

    this.runner.setDiffDataCallback((record) => {
      void (async () => {
        const firstOriginalContentByPath = this.firstOriginalContentByPath;
        if (!firstOriginalContentByPath) return;
        const existing = firstOriginalContentByPath.get(record.filePath);
        if (existing === undefined) {
          // 首次修改此文件：记录原始内容，直接发射
          // merge 模式时 record.originalContent 可能为空字符串（""）
          // 但仍记录下来（用作 "已被记录" 的标记），发射时使用原始值
          firstOriginalContentByPath.set(record.filePath, record.originalContent ?? '');
          onDiffData({
            filePath: record.filePath,
            originalContent: record.originalContent ?? '',
            newContent: record.newContent ?? '',
            xml: record.xml ?? '',
            batchResult: record.diff,
          });
          logger.trace(`[SubAgentDispatcher] 📄 实时发射 Diff: ${record.filePath} (首次修改)`);
        } else {
          // 同一文件再次修改：使用首次原始内容 + 最新内容重建 diff/XML
          // 当 firstOrig=""（merge 模式首次未能记录原始内容）时，
          // 回退使用 record.originalContent（工具层写入前实际读取的磁盘内容），
          // 避免 generateWholeFileReplaceXml(searchLen=0) 导致 PARSE_ERROR
          const rawFirstOrig = existing;
          const recordOrig = record.originalContent ?? '';
          const originalContent =
            rawFirstOrig.length === 0 && recordOrig.length > 0 ? recordOrig : rawFirstOrig;

          const newContent = record.newContent ?? '';
          logger.trace(
            `[SubAgentDispatcher] 增量合并输入: firstOrig=${originalContent.length}字符/${originalContent.split('\n').length}行, latest=${newContent.length}字符/${newContent.split('\n').length}行, recordOrig=${recordOrig.length}字符`
          );
          try {
            const { generateWholeFileReplaceXml } =
              await import('../../../fast-apply/DiffToXmlConverter');
            // 增量合并使用整文件 REPLACE：避免 diffToXml 的 LCS 对齐问题
            //
            // 为何不用 diffToXml(generateDiff(orig, new))：
            // Myers diff 在含大量重复行的文件（如 CSS）中，LCS 会将新文件行与
            // 远距离的旧文件行错误对齐，导致 INSERT 块位置和顺序与实际文件不一致。
            //
            // generateWholeFileReplaceXml 产出单一 REPLACE(orig→new)，
            // FullFileDiffBuilder 内部的局部 myersDiff 在完整上下文中执行，
            // 两端内容完全对应，保证 diff 展开与实际文件一致。
            const xml = generateWholeFileReplaceXml(originalContent, newContent);
            logger.trace(
              `[SubAgentDispatcher] 增量合并结果: wholeFileReplace, xmlLen=${xml.length}字符`
            );
            onDiffData({
              filePath: record.filePath,
              originalContent,
              newContent,
              xml,
            });
            logger.trace(
              `[SubAgentDispatcher] 📄 实时发射 Diff: ${record.filePath} (增量合并后更新)`
            );
          } catch (mergeError) {
            // 合并失败时直接发射原始记录（降级保证可见性）
            logger.warn('[SubAgentDispatcher] 实时 Diff 合并失败:', mergeError);
            onDiffData({
              filePath: record.filePath,
              originalContent: record.originalContent ?? '',
              newContent: record.newContent ?? '',
              xml: record.xml ?? '',
              batchResult: record.diff,
            });
          }
        }
      })().catch((error: unknown) => {
        logger.warn('[SubAgentDispatcher] 实时 Diff 回调失败:', error);
      });
    });
  }

  /**
   * 扫描工作目录下的文件列表（递归，文件名 + 大小 + 修改时间）
   *
   * 采用两阶段策略：
   *   阶段一：在文件数/时间预算内扫描通过过滤规则的文件，收集 mtime 数值时间戳
   *   阶段二：按 mtime 降序排列，取最新 MAX_FILES 个注入 prompt
   *
   * 相比旧的「DFS 先到先停」策略，能确保注入的是最近活跃文件，
   * 而非根字母序靠前目录（如 dist/）的构建产物。
   *
   * 扫描失败时静默降级为空结果，不影响 SA 执行。
   */
  async scanWorkdirFiles(): Promise<{
    files: WorkdirFileInfo[];
    totalFileCount: number;
    scanTruncated?: boolean;
  }> {
    if (!this.config.workdir) return { files: [], totalFileCount: 0 };

    /** 最终注入 prompt 的最大文件条数——防止 token 膨胀 */
    const MAX_FILES = 50;
    /** 本地扫描最多 stat 的文件数——防止海量临时文件拖慢 MB/SA 流转 */
    const MAX_FILES_TO_STAT = 2000;
    /** 本地扫描时间预算（毫秒） */
    const MAX_SCAN_MS = 10_000;

    /**
     * 排除目录（大小写不敏感精确匹配目录名）
     *
     * 覆盖范围：包管理器产物、构建输出、版本控制元数据、缓存目录、
     * 临时目录，等价于 .gitignore 中通常排除的目录。
     */
    const EXCLUDED_DIRS = new Set([
      // ── 应用内部临时目录 ──
      'vite_preview', // 项目预览临时文件夹
      'attachments', // 图片附件临时文件夹
      // ── 包管理器依赖 ──
      'node_modules', // npm / yarn / pnpm 依赖
      '.pnpm-store', // pnpm 全局/项目 store
      '.yarn', // Yarn Berry 缓存/插件
      '.npm', // npm 缓存
      '.venv', // Python 虚拟环境（点前缀）
      'venv', // Python 虚拟环境
      'env', // Python 虚拟环境（通用名）
      // ── 构建输出 ──
      'dist', // Vite / Rollup / tsc 产物
      'build', // Create React App / 通用构建目录
      'out', // Next.js 静态导出
      '.next', // Next.js 服务端构建缓存
      '.nuxt', // Nuxt.js 构建缓存
      '.svelte-kit', // SvelteKit 构建缓存
      '.vite', // Vite 内部缓存
      '.output', // Nitro / Nuxt 输出目录
      'target', // Rust / Maven 构建产物
      'bin', // 编译输出可执行文件（Go / C#）
      'obj', // .NET 中间编译对象
      '.gradle', // Gradle 缓存
      '.cxx', // Android CMake 中间产物
      '.externalnativebuild', // Android Native build 中间产物
      '.vs', // Visual Studio 缓存
      'cmake-build-debug', // CLion/CMake Debug 构建目录
      'cmake-build-release', // CLion/CMake Release 构建目录
      'cmakefiles', // CMake 内部目录
      '.cmake', // CMake 缓存目录
      '.dart_tool', // Dart/Flutter 工具缓存
      '.expo', // Expo 工具缓存
      'pods', // CocoaPods 依赖
      'vendor', // 常见依赖目录（Composer/Bundler/Go vendor 等）
      // ── 测试 & 覆盖率 ──
      'coverage', // 测试覆盖率报告
      '__snapshots__', // Jest 快照目录
      'playwright-report', // Playwright HTML 报告
      'test-results', // Playwright/Jest 测试产物
      'testresults', // Visual Studio 测试产物
      'htmlcov', // Python coverage HTML 报告
      // ── 缓存 & 工具链 ──
      '.cache', // webpack / babel / …缓存
      '.parcel-cache', // Parcel 缓存
      '.turbo', // Turborepo 缓存
      '.nx', // Nx 缓存
      '.angular', // Angular CLI 缓存
      // ── 版本控制元数据 ──
      '.git', // Git 元数据
      // ── Python 编译缓存 ──
      '__pycache__', // Python 字节码缓存
      '.pytest_cache', // pytest 缓存
      '.mypy_cache', // mypy 缓存
      '.ruff_cache', // ruff 缓存
      '.tox', // tox 环境
      '.nox', // nox 环境
      '.hypothesis', // Hypothesis 测试缓存
      '.eggs', // Python packaging 临时目录
      '.ipynb_checkpoints', // Jupyter notebook checkpoint
      // ── 通用临时目录 ──
      'tmp',
      'temp',
      '.tmp',
    ]);

    /**
     * 排除文件名黑名单（精确文件名匹配，大小写不敏感）
     *
     * 覆盖范围：锁文件（体积大、内容无意义）、IDE / OS 元数据文件、
     * 版本控制配置文件——SA 无需感知这些文件的存在。
     */
    const EXCLUDED_FILE_NAMES = new Set([
      // ── 包管理锁文件（体积大，模型无法利用）──
      'package-lock.json', // npm
      'yarn.lock', // yarn
      'pnpm-lock.yaml', // pnpm
      'bun.lockb', // bun（二进制锁文件）
      'Cargo.lock', // Rust cargo
      'poetry.lock', // Python poetry
      'Pipfile.lock', // Python pipenv
      'composer.lock', // PHP composer
      'Gemfile.lock', // Ruby bundler
      // ── 版本控制 & 格式化配置 ──
      '.gitignore',
      '.gitattributes',
      '.editorconfig',
      '.prettierignore',
      '.eslintignore',
      '.npmignore',
      // ── OS 生成的元数据 ──
      'Thumbs.db', // Windows 缩略图缓存
      '.DS_Store', // macOS 目录元数据
    ]);

    /** 带数值时间戳的内部扫描条目（用于排序，不对外暴露） */
    interface RawFileEntry {
      name: string;
      size: string;
      mtimeMs: number;
    }

    try {
      const { readDir, stat } = await import('@tauri-apps/plugin-fs');
      const { join } = await import('@tauri-apps/api/path');

      // ── 阶段一：预算内扫描，收集通过过滤规则的文件 ──
      // 预算用于避免海量缓存、测试产物或临时文件拖慢 MB/SA 流转。
      const rawEntries: RawFileEntry[] = [];
      const scanStartedAt = Date.now();
      const scanState = { truncated: false };

      const shouldStopScan = (): boolean => {
        if (rawEntries.length >= MAX_FILES_TO_STAT || Date.now() - scanStartedAt >= MAX_SCAN_MS) {
          scanState.truncated = true;
          return true;
        }
        return false;
      };

      /**
       * 递归扫描目录
       * @param dirPath - 当前扫描的绝对路径
       * @param relativePath - 相对于 workdir 的前缀路径
       */
      const scanDir = async (dirPath: string, relativePath: string): Promise<void> => {
        if (shouldStopScan()) return;
        const entries = await readDir(dirPath);

        for (const entry of entries) {
          if (shouldStopScan()) return;
          if (!entry.name) continue;

          // 构建相对路径（用正斜杠统一，便于模型理解）
          const relName = relativePath ? `${relativePath}/${entry.name}` : entry.name;

          if (entry.isDirectory) {
            // 跳过排除目录（不区分大小写）
            if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
            const subDirPath = await join(dirPath, entry.name);
            await scanDir(subDirPath, relName);
          } else {
            // 跳过排除文件名（不区分大小写）
            if (EXCLUDED_FILE_NAMES.has(entry.name.toLowerCase())) continue;

            try {
              const fullPath = await join(dirPath, entry.name);
              const fileStat = await stat(fullPath);

              // 提取数值时间戳用于排序（无法获取时退回 0，置于列表末尾）
              let mtimeMs = 0;
              if (fileStat.mtime != null) {
                const mtime =
                  fileStat.mtime instanceof Date ? fileStat.mtime : new Date(fileStat.mtime);
                if (!isNaN(mtime.getTime())) {
                  mtimeMs = mtime.getTime();
                }
              }

              rawEntries.push({
                name: relName,
                size: this.formatFileSize(fileStat.size),
                mtimeMs,
              });
            } catch {
              // 单个文件 stat 失败（权限问题等），以 mtime=0 记录，排在最后
              rawEntries.push({ name: relName, size: 'unknown', mtimeMs: 0 });
            }
          }
        }
      };

      await scanDir(this.config.workdir, '');

      // ── 阶段二：按修改时间降序排列，取最新 MAX_FILES 个 ──
      // 降序排列确保「最近活跃」的文件排在前面，SA 能优先感知到正在开发的文件。
      rawEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const totalFileCount = rawEntries.length;
      const topEntries = rawEntries.slice(0, MAX_FILES);

      // 格式化 modified 字符串（仅对最终展示的文件执行，避免无效开销）
      const results: WorkdirFileInfo[] = topEntries.map((entry) => {
        if (entry.mtimeMs === 0) {
          return { name: entry.name, size: entry.size, modified: 'unknown' };
        }
        const mtime = new Date(entry.mtimeMs);
        const y = mtime.getFullYear();
        const mo = String(mtime.getMonth() + 1).padStart(2, '0');
        const d = String(mtime.getDate()).padStart(2, '0');
        const h = String(mtime.getHours()).padStart(2, '0');
        const mi = String(mtime.getMinutes()).padStart(2, '0');
        return {
          name: entry.name,
          size: entry.size,
          modified: `${y}-${mo}-${d} ${h}:${mi}`,
        };
      });

      logger.trace(
        `[SubAgentDispatcher] 📂 扫描完成: 共 ${scanState.truncated ? '至少 ' : ''}${totalFileCount} 个文件，` +
          `注入最新 ${results.length} 个${scanState.truncated ? '（已达到扫描预算）' : ''}`
      );

      return { files: results, totalFileCount, scanTruncated: scanState.truncated };
    } catch (error) {
      // 目录不存在或扫描失败时静默降级——不阻塞 SA 执行
      logger.trace('[SubAgentDispatcher] 📂 工作目录扫描失败（降级为空）:', error);
      return { files: [], totalFileCount: 0 };
    }
  }

  /**
   * 格式化文件大小为人类可读格式
   */
  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}
