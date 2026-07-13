/**
 * SubAgentLLMCaller - Sub-Agent 专用 LLM 调用器工厂
 *
 * 封装 Tauri invoke('llm_chat_with_tools') 逻辑，
 * 为 SubAgentRunner 提供 LLM 调用能力
 */

import { invoke } from '@tauri-apps/api/core';
import { toolRegistry } from '../../tools/ToolRegistry';
import { getToolNamesForSchemaFilter } from '../../tools/ToolAliases';
import type {
  LLMCaller,
  LLMContextUsageOptions,
  LLMResponse,
  ReasoningTraceProgress,
  ToolCallProgress,
} from '../../sub-agents/SubAgentRunner';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import type { AccumulatedMessage } from '../../sub-agents/types';
import { getLogger } from '@services/logger';
import { normalizeSafetyFooterText } from '../../sub-agents/SubAgentSafetyFooter';
import { modelSupportsVision } from '@/config/modelRegistry';
import { translate } from '@/i18n';
import {
  getLlmTokenPolicy,
  type LlmTokenPolicy,
  type LlmTokenPolicyPurpose,
} from '@services/llm/LlmTokenPolicy';
import { isMaxTokensParameterRejection } from '../../utils/LlmRetryPolicy';
import {
  estimateGeneratedTokens,
  estimateRequestTokens,
  normalizeReportedTokenCount,
} from '@services/llm/tokenEstimator';
import { useStatusStore } from '@stores/statusStore';

const logger = getLogger('SubAgentLLMCaller');
const SUB_AGENT_LLM_CANCEL_SETTLE_TIMEOUT_MS = 5000;
const SUB_AGENT_REASONING_UI_FLUSH_INTERVAL_MS = 64;

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
  /** 视觉 fallback 时优先保留此消息上的图片（例如当前轮用户附件） */
}

/**
 * LLM 响应（带工具调用）
 */
interface LLMResponseWithTools {
  type: 'text' | 'tool_use' | 'error' | 'cancelled';
  content?: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignature?: string;
  }>;
  error?: string;
  /** API 返回的输入 token 数 */
  inputTokens?: number;
  /** API 返回的输出 token 数 */
  outputTokens?: number;
  /** Provider 返回的完成原因；token 截断与参数拒绝是两类不同信号。 */
  finishReason?: string;
  /** 思考内容（DeepSeek 思考模式返回的推理链，需在多轮工具调用中回传） */
  reasoningContent?: string;
}

interface ToolCallProgressPayload {
  sessionId: string;
  toolName: string;
  argBytes: number;
}

interface ReasoningProgressPayload {
  sessionId: string;
  delta: string;
  done: boolean;
}

/**
 * 消息格式（用于 LLM API 调用）
 */
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  /** Function Calling: assistant 角色的工具调用列表（含可选 id 用于 Anthropic/OpenAI tool_result 匹配） */
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignature?: string;
  }>;
  /** Function Calling: tool 角色的调用 ID（映射到 Gemini functionResponse） */
  toolCallId?: string;
  /** 图片附件（tool 角色时可填充，用于多模态 tool_result） */
  images?: Array<{ mimeType: string; data: string }>;
  preserveImagesOnVisionFallback?: boolean;
  /** 思考内容（DeepSeek 思考模式专用，工具调用场景需回传 API） */
  reasoningContent?: string;
}

const VISION_UNSUPPORTED_ERROR_PATTERNS = [
  'no endpoints found that support image input',
  'image input',
  'image_url',
  'image url',
  'images are not supported',
  'image is not supported',
  'does not support images',
  'unsupported image',
  'vision',
  'visual',
  'multi-modal',
  'multimodal',
  'content part',
  'failed to read request',
];

export type VisionFallbackMode = 'none' | 'strip-unmarked' | 'strip-all';

/**
 * SubAgent LLM Caller 配置
 */
export interface SubAgentLLMCallerConfig {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  /** 是否在每步 Sub-Agent LLM 调用尾部追加 Safety Footer。默认关闭。 */
  subAgentSafetyFooterEnabled?: boolean;
  /** Safety Footer 的可编辑提示词文本。为空时回退到内置默认值。 */
  subAgentSafetyFooterText?: string;
  /** 输出 token 场景策略。普通 Sub-Agent 默认使用 subAgent，复用调用方应显式声明。 */
  tokenPolicy?: LlmTokenPolicyPurpose;
}

/**
 * SubAgent LLM Caller 工厂
 *
 * 创建用于 SubAgentRunner 的 LLM 调用器
 */
export class SubAgentLLMCallerFactory {
  private visionFallbackMode: VisionFallbackMode = 'none';
  private readonly tokenPolicy: LlmTokenPolicy;
  private activeMaxTokens: number;

  constructor(
    private config: SubAgentLLMCallerConfig,
    // executeTool 保留接口兼容性，但不再在此处使用（工具执行移到 Runner）
    _executeTool?: (toolCall: ToolCallInfo) => Promise<ToolExecutionResult>
  ) {
    this.tokenPolicy = getLlmTokenPolicy(config.tokenPolicy ?? 'subAgent');
    this.activeMaxTokens = this.tokenPolicy.primaryMaxTokens;
  }

  setVisionFallbackMode(mode: VisionFallbackMode): void {
    if (mode === 'none') return;
    if (this.visionFallbackMode === 'strip-all' && mode === 'strip-unmarked') return;
    this.visionFallbackMode = mode;
  }

  /**
   * 创建 LLM Caller 实例（支持多轮会话）
   */
  create(): LLMCaller {
    return {
      // 带上下文的多轮调用（原子事件循环专用）
      callWithContext: async (
        systemPrompt: string,
        tools: string[],
        accumulatedContext: AccumulatedMessage[],
        additionalInstructions?: string,
        signal?: AbortSignal,
        persistedIntervention?: { message: string; stepsSinceIntervention: number },
        onToolCallProgress?: (progress: ToolCallProgress) => void,
        onReasoningTrace?: (progress: ReasoningTraceProgress) => void,
        contextUsage?: LLMContextUsageOptions
      ): Promise<LLMResponse> => {
        const messages = this.buildMessagesWithContext(
          systemPrompt,
          accumulatedContext,
          additionalInstructions,
          persistedIntervention
        );
        return this.invokeWithMessages(
          messages,
          tools,
          signal,
          onToolCallProgress,
          onReasoningTrace,
          contextUsage
        );
      },
    };
  }

  /**
   * 构建带上下文的消息列表
   */
  private buildMessagesWithContext(
    systemPrompt: string,
    accumulatedContext: AccumulatedMessage[],
    additionalInstructions?: string,
    persistedIntervention?: { message: string; stepsSinceIntervention: number }
  ): Message[] {
    const messages: Message[] = [{ role: 'system', content: systemPrompt }];

    // 追加累积的上下文消息（assistant/tool 角色）
    // 关键：传递 toolCalls 和 toolCallId 以维持 Gemini Function Calling 协议
    for (const ctx of accumulatedContext) {
      messages.push({
        role: ctx.role as 'assistant' | 'tool',
        content: ctx.content,
        ...(ctx.toolName && { toolName: ctx.toolName }),
        ...(ctx.toolCalls && { toolCalls: ctx.toolCalls }),
        ...(ctx.toolCallId && { toolCallId: ctx.toolCallId }),
        ...(ctx.images && ctx.images.length > 0 && { images: ctx.images }),
        ...(ctx.preserveImagesOnVisionFallback && { preserveImagesOnVisionFallback: true }),
        ...(ctx.reasoningContent && { reasoningContent: ctx.reasoningContent }),
      });
    }

    // 构建每步的尾部 user 消息，结构如下（注意力优先级从低到高）：
    // 1. 策略调整 / 系统补充指令
    // 2. Safety Footer（启用时追加的实验提示词，每步热区注入）
    // 3. persistedIntervention（用户强制介入消息，置于最尾部，拥有最高注意力优先级）
    //
    // 设计原因：LLM 注意力高度依赖上下文尾部（Lost in the Middle 问题），
    // 用户介入消息必须在已启用的 Safety Footer 之后，或在无 Footer 时直接处于最末尾。
    const finalSections: string[] = [];

    if (additionalInstructions) {
      finalSections.push(
        translate('chat.subAgentSystemNote', {
          instructions: additionalInstructions,
        })
      );
    }

    if (this.config.subAgentSafetyFooterEnabled === true) {
      finalSections.push(normalizeSafetyFooterText(this.config.subAgentSafetyFooterText));
    }

    // 将用户介入消息追加到最尾部（SAFETY_FOOTER 之后），确保最高注意力优先级。
    // stepsSinceIntervention 表示介入发生到当前步骤已经过了多少步。
    // SA 需要结合当前进度自行判断：是继续执行剩余任务，还是立即终止并报告。
    if (persistedIntervention) {
      const { message, stepsSinceIntervention } = persistedIntervention;
      const stepsAgoLabel =
        stepsSinceIntervention === 0
          ? translate('chat.subAgentForcedUserInstructionIssuedNow')
          : translate('chat.subAgentForcedUserInstructionIssuedStepsAgo', {
              count: stepsSinceIntervention,
            });
      finalSections.push(
        translate('chat.subAgentForcedUserInstruction', {
          issued: stepsAgoLabel,
          message,
        })
      );
    }

    if (finalSections.length > 0) {
      messages.push({ role: 'user', content: finalSections.join('\n\n---\n\n') });
    }

    return messages;
  }

  /**
   * 使用指定消息列表调用 LLM（无状态单次调用）
   *
   * 只负责发送请求和返回响应，不处理循环逻辑。
   * 工具执行和循环控制由 SubAgentRunner 负责。
   *
   * 通过 AbortSignal 支持取消：
   * - 生成唯一 sessionId 注册到 Rust 侧 CANCEL_SENDERS
   * - AbortSignal 触发时立即调用 llm_cancel_stream，Rust 的 tokio::select! 感知后中断 HTTP 流
   * - invoke 返回/取消后清理 AbortSignal 监听器，避免内存泄漏
   */
  private async invokeWithMessages(
    messages: Message[],
    tools: string[],
    signal?: AbortSignal,
    onToolCallProgress?: (progress: ToolCallProgress) => void,
    onReasoningTrace?: (progress: ReasoningTraceProgress) => void,
    contextUsage?: LLMContextUsageOptions
  ): Promise<LLMResponse> {
    // 获取所有已注册的工具 Schema
    const allSchemas = toolRegistry.getSchemas();

    logger.debug('[SubAgentLLMCaller] 调用 LLM, 消息数:', messages.length, '工具数:', tools.length);

    // 过滤出允许的工具
    const allowedSchemaNames = getToolNamesForSchemaFilter(tools);
    const toolDefinitions = allSchemas
      .filter((schema) => allowedSchemaNames.includes(schema.name))
      .map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
      }));

    // 空工具列表会导致 Gemini API proto 验证失败
    // （tools[0].tool_type: required one_of must have one initialized field）
    // 当过滤后无匹配工具时，不传 tools 字段
    const toolsPayload = toolDefinitions.length > 0 ? toolDefinitions : null;

    const { providerId, modelId, baseUrl } = this.config;

    // 生成本次请求的唯一 sessionId，用于 Rust 侧取消信号路由
    // 格式：sa-llm-{时间戳}-{随机后缀}，确保并发调用不互相影响
    const sessionId = `sa-llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 监听 AbortSignal：用户终止时立即通知 Rust 取消对应请求
    // Rust 侧 dispatch_with_cancel 的 tokio::select! 会感知到 cancel_rx，
    // 立即中断正在进行的 HTTP 流式请求，无需等待 8 分钟超时
    const abortHandler = () => {
      invoke('llm_cancel_stream', { sessionId }).catch(() => {
        // 取消请求失败是无害的（Rust 端会话可能已正常完成）
      });
      logger.debug(
        `[SubAgentLLMCaller] ⛔ AbortSignal 触发，已发送取消信号 (sessionId: ${sessionId})`
      );
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    let unlistenToolCallProgress: (() => void) | undefined;
    let unlistenReasoningProgress: (() => void) | undefined;
    let reasoningProgressContent = '';
    let reasoningProgressFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingReasoningProgress = false;
    let pendingReasoningDone = false;
    let contextUsageAttemptSequence = 0;
    let activeContextUsageCallId: string | null = null;
    let activeAttemptReasoningContent = '';
    let activeAttemptToolArgumentBytes = 0;
    let contextUsageFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushActiveContextUsage = () => {
      if (contextUsageFlushTimer) {
        clearTimeout(contextUsageFlushTimer);
        contextUsageFlushTimer = null;
      }
      if (!contextUsage || !activeContextUsageCallId) return;
      useStatusStore
        .getState()
        .updateContextUsage(contextUsage.contextId, activeContextUsageCallId, {
          currentOutputTokens:
            estimateGeneratedTokens({
              reasoningContent: activeAttemptReasoningContent,
            }) + Math.ceil(activeAttemptToolArgumentBytes / 4),
        });
    };

    const scheduleActiveContextUsage = () => {
      if (!contextUsage || !activeContextUsageCallId || contextUsageFlushTimer) return;
      contextUsageFlushTimer = setTimeout(
        flushActiveContextUsage,
        SUB_AGENT_REASONING_UI_FLUSH_INTERVAL_MS
      );
    };

    const clearReasoningProgressFlushTimer = () => {
      if (reasoningProgressFlushTimer) {
        clearTimeout(reasoningProgressFlushTimer);
        reasoningProgressFlushTimer = null;
      }
    };

    const flushReasoningProgress = () => {
      clearReasoningProgressFlushTimer();

      if (!onReasoningTrace || !pendingReasoningProgress) return;

      const done = pendingReasoningDone;
      pendingReasoningProgress = false;
      pendingReasoningDone = false;

      if (signal?.aborted && !done) return;

      onReasoningTrace({
        content: reasoningProgressContent,
        done,
      });
    };

    const scheduleReasoningProgress = (done: boolean) => {
      if (!onReasoningTrace) return;

      pendingReasoningProgress = true;
      pendingReasoningDone = pendingReasoningDone || done;

      if (done) {
        flushReasoningProgress();
        return;
      }

      if (reasoningProgressFlushTimer) return;

      reasoningProgressFlushTimer = setTimeout(
        flushReasoningProgress,
        SUB_AGENT_REASONING_UI_FLUSH_INTERVAL_MS
      );
    };

    if (onToolCallProgress || contextUsage) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenToolCallProgress = await listen<ToolCallProgressPayload>(
          'llm-tool-call-progress',
          (event) => {
            const payload = event.payload;
            if (payload.sessionId !== sessionId) return;
            activeAttemptToolArgumentBytes = Math.max(
              activeAttemptToolArgumentBytes,
              payload.argBytes
            );
            scheduleActiveContextUsage();
            onToolCallProgress?.({
              toolName: payload.toolName,
              argBytes: payload.argBytes,
            });
          }
        );
      } catch (error) {
        logger.warn('[SubAgentLLMCaller] 工具调用进度监听注册失败:', error);
      }
    }

    // 调试：检查是否有 tool 消息携带 images
    if (onReasoningTrace || contextUsage) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenReasoningProgress = await listen<ReasoningProgressPayload>(
          'llm-reasoning-progress',
          (event) => {
            const payload = event.payload;
            if (payload.sessionId !== sessionId) return;
            if (payload.delta) {
              reasoningProgressContent += payload.delta;
              activeAttemptReasoningContent += payload.delta;
              scheduleActiveContextUsage();
            }
            scheduleReasoningProgress(payload.done);
          }
        );
      } catch (error) {
        logger.warn('[SubAgentLLMCaller] reasoning trace listener registration failed:', error);
      }
    }

    const msgsWithImages = messages.filter((m) => m.images && m.images.length > 0);
    if (msgsWithImages.length > 0) {
      logger.trace(
        '[SubAgentLLMCaller] 📷 发现',
        msgsWithImages.length,
        '条消息包含 images，各含:',
        msgsWithImages.map((m) => `${m.images?.length ?? 0} image(s)`)
      );
    }

    let initialMessages = messages;
    let initialStrippedImageCount = 0;
    if (msgsWithImages.length > 0 && !modelSupportsVision(modelId, providerId)) {
      const stripped = this.stripImagesForVisionFallback(messages);
      initialMessages = stripped.messages;
      initialStrippedImageCount = stripped.imageCount;
      this.visionFallbackMode = 'strip-all';
    } else if (msgsWithImages.length > 0 && this.visionFallbackMode === 'strip-unmarked') {
      const stripped = this.stripImagesForVisionFallback(messages, { preserveMarked: true });
      initialMessages = stripped.messages;
      initialStrippedImageCount = stripped.imageCount;
      logger.trace(
        '[SubAgentLLMCaller] 沿用本次 SA 已确认的视觉 fallback 策略：移除历史/未标记 images，保留当前任务 images',
        {
          providerId,
          modelId,
          strippedImageCount: stripped.imageCount,
          preservedCurrentImageMessages: this.hasMarkedImages(messages),
        }
      );
    } else if (msgsWithImages.length > 0 && this.visionFallbackMode === 'strip-all') {
      const stripped = this.stripImagesForVisionFallback(messages);
      initialMessages = stripped.messages;
      initialStrippedImageCount = stripped.imageCount;
      logger.trace('[SubAgentLLMCaller] 沿用本次 SA 已确认的视觉 fallback 策略：移除全部 images', {
        providerId,
        modelId,
        strippedImageCount: stripped.imageCount,
      });
    }
    let alreadyStrippedImages = initialMessages !== messages;
    const appliedFallbackMode = alreadyStrippedImages ? this.visionFallbackMode : 'none';
    if (alreadyStrippedImages) {
      logger.warn('[SubAgentLLMCaller] 已在首次调用前按视觉 fallback 策略移除 images:', {
        providerId,
        modelId,
        imageMessageCount: msgsWithImages.length,
        strippedImageCount: initialStrippedImageCount,
        fallbackMode: this.visionFallbackMode,
      });
    }

    const invokeOnce = async (
      messagesForCall: Message[],
      maxTokens: number
    ): Promise<LLMResponseWithTools> => {
      if (signal?.aborted) {
        return {
          type: 'cancelled',
          content: 'Sub-agent LLM request cancelled before start.',
        };
      }

      const callId = contextUsage ? `${sessionId}-attempt-${++contextUsageAttemptSequence}` : null;
      const estimatedInputTokens = contextUsage
        ? estimateRequestTokens(messagesForCall, { tools: toolsPayload })
        : 0;
      if (contextUsage && callId) {
        activeContextUsageCallId = callId;
        activeAttemptReasoningContent = '';
        activeAttemptToolArgumentBytes = 0;
        useStatusStore.getState().beginContextUsage(contextUsage.contextId, {
          callId,
          currentInputTokens: estimatedInputTokens,
          currentOutputTokens: 0,
          contextWindowSize: contextUsage.contextWindowSize,
          purpose: 'sub-agent',
          providerId,
          modelId,
        });
      }

      let attemptCompleted = false;
      let fallbackTimeout: ReturnType<typeof setTimeout> | undefined;
      let fallbackHandler: (() => void) | undefined;
      const completeAttempt = (response?: LLMResponseWithTools) => {
        if (!contextUsage || !callId || attemptCompleted) return;
        attemptCompleted = true;
        flushActiveContextUsage();
        const responseContent =
          response?.type === 'text' || response?.type === 'tool_use' ? response.content : undefined;
        const responseToolCalls = response?.type === 'tool_use' ? response.toolCalls : undefined;
        const currentInputTokens =
          normalizeReportedTokenCount(response?.inputTokens) ?? estimatedInputTokens;
        const estimatedOutputTokens = estimateGeneratedTokens({
          content: responseContent,
          reasoningContent: response?.reasoningContent ?? activeAttemptReasoningContent,
          toolCalls: responseToolCalls,
        });
        const currentOutputTokens =
          normalizeReportedTokenCount(response?.outputTokens) ??
          Math.max(
            estimatedOutputTokens,
            estimateGeneratedTokens({ reasoningContent: activeAttemptReasoningContent }) +
              Math.ceil(activeAttemptToolArgumentBytes / 4)
          );
        useStatusStore.getState().completeContextUsage(contextUsage.contextId, callId, {
          currentInputTokens,
          currentOutputTokens,
        });
      };

      try {
        const invokePromise = invoke<LLMResponseWithTools>('llm_chat_with_tools', {
          request: {
            messages: messagesForCall,
            modelId,
            providerId,
            baseUrl,
            supportsVision: modelSupportsVision(modelId, providerId),
            tools: toolsPayload,
            maxTokens,
            temperature: PLANNING_CONSTANTS.SUB_AGENT_TEMPERATURE,
          },
          sessionId,
        });

        let response: LLMResponseWithTools;
        if (!signal) {
          response = await invokePromise;
        } else {
          const abortFallback = new Promise<LLMResponseWithTools>((resolve) => {
            fallbackHandler = () => {
              fallbackTimeout = setTimeout(() => {
                resolve({
                  type: 'cancelled',
                  content: `Sub-agent LLM request cancelled; backend stream did not settle within ${SUB_AGENT_LLM_CANCEL_SETTLE_TIMEOUT_MS}ms.`,
                });
              }, SUB_AGENT_LLM_CANCEL_SETTLE_TIMEOUT_MS);
            };
            signal.addEventListener('abort', fallbackHandler, { once: true });
          });
          response = await Promise.race([invokePromise, abortFallback]);
        }

        completeAttempt(response);
        return response;
      } catch (error) {
        completeAttempt();
        throw error;
      } finally {
        if (fallbackHandler) {
          signal?.removeEventListener('abort', fallbackHandler);
        }
        if (fallbackTimeout) {
          clearTimeout(fallbackTimeout);
        }
        if (activeContextUsageCallId === callId) {
          activeContextUsageCallId = null;
          activeAttemptReasoningContent = '';
          activeAttemptToolArgumentBytes = 0;
        }
      }
    };

    const invokeWithTokenFallback = async (
      messagesForCall: Message[]
    ): Promise<LLMResponseWithTools> => {
      const attemptedMaxTokens = this.activeMaxTokens;
      let tokenFallbackUsed = false;
      try {
        const result = await invokeOnce(messagesForCall, attemptedMaxTokens);
        if (
          result.type !== 'error' ||
          !this.shouldUseTokenParameterFallback(
            result.error ?? result.content,
            attemptedMaxTokens,
            signal
          )
        ) {
          return result;
        }

        tokenFallbackUsed = true;
        return await this.retryWithTokenParameterFallback(
          messagesForCall,
          attemptedMaxTokens,
          result.error ?? result.content,
          invokeOnce
        );
      } catch (error) {
        if (
          tokenFallbackUsed ||
          !this.shouldUseTokenParameterFallback(error, attemptedMaxTokens, signal)
        ) {
          throw error;
        }

        tokenFallbackUsed = true;
        return await this.retryWithTokenParameterFallback(
          messagesForCall,
          attemptedMaxTokens,
          error,
          invokeOnce
        );
      }
    };

    let response: LLMResponseWithTools;
    try {
      response = await invokeWithTokenFallback(initialMessages);
    } catch (invokeError) {
      logger.error('[SubAgentLLMCaller] invoke 调用失败:', invokeError);
      if (
        alreadyStrippedImages &&
        appliedFallbackMode === 'strip-unmarked' &&
        this.hasImages(messages) &&
        this.isVisionUnsupportedError(invokeError)
      ) {
        const allStripped = this.stripImagesForVisionFallback(messages);
        logger.warn('[SubAgentLLMCaller] 沿用保留当前图片策略仍失败，移除全部 images 后重试一次:', {
          providerId,
          modelId,
          strippedImageCount: allStripped.imageCount,
          error: String(invokeError).slice(0, 240),
        });
        response = await invokeWithTokenFallback(allStripped.messages);
        this.visionFallbackMode = 'strip-all';
      } else if (
        !alreadyStrippedImages &&
        this.hasImages(messages) &&
        this.isVisionUnsupportedError(invokeError)
      ) {
        const partial = this.stripImagesForVisionFallback(messages, { preserveMarked: true });
        const stripped =
          partial.imageCount > 0 ? partial : this.stripImagesForVisionFallback(messages);
        logger.warn('[SubAgentLLMCaller] 视觉输入不支持，移除 images 后重试一次:', {
          providerId,
          modelId,
          strippedImageCount: stripped.imageCount,
          preservedCurrentImageMessages: this.hasMarkedImages(messages) && partial.imageCount > 0,
          error: String(invokeError).slice(0, 240),
        });
        alreadyStrippedImages = true;
        response = await invokeWithTokenFallback(stripped.messages);
        this.rememberVisionFallbackMode(partial, response);
        if (
          response.type === 'error' &&
          partial.imageCount > 0 &&
          this.isVisionUnsupportedError(response.error ?? response.content)
        ) {
          const allStripped = this.stripImagesForVisionFallback(messages);
          logger.warn('[SubAgentLLMCaller] 保留当前图片重试仍失败，移除全部 images 后再重试一次:', {
            providerId,
            modelId,
            strippedImageCount: allStripped.imageCount,
            error: (response.error ?? response.content ?? '').slice(0, 240),
          });
          response = await invokeWithTokenFallback(allStripped.messages);
          this.visionFallbackMode = 'strip-all';
        }
      } else {
        throw invokeError;
      }
    } finally {
      // 无论成功/失败/取消，都清理 AbortSignal 监听器，避免内存泄漏
      signal?.removeEventListener('abort', abortHandler);
      flushReasoningProgress();
      clearReasoningProgressFlushTimer();
      unlistenToolCallProgress?.();
      unlistenReasoningProgress?.();
    }

    logger.debug(
      '[SubAgentLLMCaller] LLM 响应 - type:',
      response.type,
      '| toolCalls:',
      response.toolCalls?.length ?? 0
    );

    if (response.type === 'cancelled') {
      return {
        content: response.content ?? '',
        output: undefined,
        toolCalls: [],
        error: response.error ?? response.content ?? 'Sub-agent LLM request cancelled.',
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
      };
    }

    // 如果是工具调用，返回工具调用信息，由 Runner 执行
    if (
      response.type === 'error' &&
      alreadyStrippedImages &&
      appliedFallbackMode === 'strip-unmarked' &&
      this.hasImages(messages) &&
      this.isVisionUnsupportedError(response.error ?? response.content)
    ) {
      const allStripped = this.stripImagesForVisionFallback(messages);
      logger.warn(
        '[SubAgentLLMCaller] 沿用保留当前图片策略仍返回视觉错误，移除全部 images 后重试一次:',
        {
          providerId,
          modelId,
          strippedImageCount: allStripped.imageCount,
          error: (response.error ?? response.content ?? '').slice(0, 240),
        }
      );
      response = await invokeWithTokenFallback(allStripped.messages);
      this.visionFallbackMode = 'strip-all';
    }

    if (
      response.type === 'error' &&
      !alreadyStrippedImages &&
      this.hasImages(messages) &&
      this.isVisionUnsupportedError(response.error ?? response.content)
    ) {
      const partial = this.stripImagesForVisionFallback(messages, { preserveMarked: true });
      const stripped =
        partial.imageCount > 0 ? partial : this.stripImagesForVisionFallback(messages);
      logger.warn('[SubAgentLLMCaller] API 返回视觉输入不支持，移除 images 后重试一次:', {
        providerId,
        modelId,
        strippedImageCount: stripped.imageCount,
        preservedCurrentImageMessages: this.hasMarkedImages(messages) && partial.imageCount > 0,
        error: (response.error ?? response.content ?? '').slice(0, 240),
      });
      alreadyStrippedImages = true;
      response = await invokeWithTokenFallback(stripped.messages);
      this.rememberVisionFallbackMode(partial, response);
      if (
        response.type === 'error' &&
        partial.imageCount > 0 &&
        this.isVisionUnsupportedError(response.error ?? response.content)
      ) {
        const allStripped = this.stripImagesForVisionFallback(messages);
        logger.warn('[SubAgentLLMCaller] 保留当前图片重试仍失败，移除全部 images 后再重试一次:', {
          providerId,
          modelId,
          strippedImageCount: allStripped.imageCount,
          error: (response.error ?? response.content ?? '').slice(0, 240),
        });
        response = await invokeWithTokenFallback(allStripped.messages);
        this.visionFallbackMode = 'strip-all';
      }
    }

    if (response.type === 'tool_use' && response.toolCalls && response.toolCalls.length > 0) {
      return {
        // 保留 LLM 伴随工具调用的思考文字（如有），供 UI 展示
        content: response.content ?? '',
        output: undefined,
        toolCalls: response.toolCalls.map((tc) => tc.name),
        // 新增: 传递完整的工具调用信息供 Runner 执行
        rawToolCalls: response.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          // 保留 API 返回的 tool_use id，供后续 tool_result 匹配
          ...(tc.id && { id: tc.id }),
          ...(tc.thoughtSignature && { thoughtSignature: tc.thoughtSignature }),
        })),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
        // DeepSeek 思考模式：透传 reasoning_content 给 Runner 存入消息历史
        reasoningContent: response.reasoningContent,
      };
    }

    // API 错误响应（如 429 限速、500 服务器错误等）
    // 将错误信息传递给 Runner，由 Runner 决定是否重试
    if (response.type === 'error') {
      const errorDetail = response.error ?? response.content ?? 'unknown API error';
      logger.warn('[SubAgentLLMCaller] ⚠️ API 错误:', errorDetail);
      return {
        content: response.content ?? '',
        output: undefined,
        toolCalls: [],
        error: errorDetail,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
        reasoningContent: response.reasoningContent,
      };
    }

    // 文本响应
    return {
      content: response.content ?? '',
      output: undefined,
      toolCalls: [],
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
      reasoningContent: response.reasoningContent,
    };
  }

  private shouldUseTokenParameterFallback(
    error: unknown,
    attemptedMaxTokens: number,
    signal?: AbortSignal
  ): boolean {
    const fallbackMaxTokens = this.tokenPolicy.parameterFallbackMaxTokens;
    return (
      !signal?.aborted &&
      fallbackMaxTokens !== undefined &&
      attemptedMaxTokens === this.tokenPolicy.primaryMaxTokens &&
      fallbackMaxTokens < attemptedMaxTokens &&
      isMaxTokensParameterRejection(error)
    );
  }

  private async retryWithTokenParameterFallback(
    messages: Message[],
    rejectedMaxTokens: number,
    error: unknown,
    invokeOnce: (messagesForCall: Message[], maxTokens: number) => Promise<LLMResponseWithTools>
  ): Promise<LLMResponseWithTools> {
    const fallbackMaxTokens = this.tokenPolicy.parameterFallbackMaxTokens;
    if (fallbackMaxTokens === undefined) {
      throw error;
    }

    this.activeMaxTokens = fallbackMaxTokens;
    logger.warn('[SubAgentLLMCaller] token 参数被 provider 拒绝，降低预算后重试一次:', {
      providerId: this.config.providerId,
      modelId: this.config.modelId,
      rejectedMaxTokens,
      fallbackMaxTokens,
      error: error instanceof Error ? error.message : String(error),
    });
    return await invokeOnce(messages, fallbackMaxTokens);
  }

  private hasImages(messages: Message[]): boolean {
    return messages.some((message) => (message.images?.length ?? 0) > 0);
  }

  private hasMarkedImages(messages: Message[]): boolean {
    return messages.some(
      (message) => message.preserveImagesOnVisionFallback && (message.images?.length ?? 0) > 0
    );
  }

  private rememberVisionFallbackMode(
    partial: { imageCount: number },
    response: LLMResponseWithTools
  ): void {
    if (
      response.type === 'error' &&
      this.isVisionUnsupportedError(response.error ?? response.content)
    ) {
      return;
    }

    this.visionFallbackMode = partial.imageCount > 0 ? 'strip-unmarked' : 'strip-all';
  }

  private isVisionUnsupportedError(error: unknown): boolean {
    if (isMaxTokensParameterRejection(error)) return false;

    let errorText = '';
    if (error instanceof Error) {
      errorText = `${error.name}: ${error.message}`;
    } else if (typeof error === 'string') {
      errorText = error;
    } else {
      try {
        const serialized = JSON.stringify(error);
        errorText = typeof serialized === 'string' ? serialized : '';
      } catch {
        errorText = '';
      }
    }
    const text = errorText.toLowerCase();
    return VISION_UNSUPPORTED_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
  }

  private stripImagesForVisionFallback(
    messages: Message[],
    options: { preserveMarked?: boolean } = {}
  ): { messages: Message[]; imageCount: number } {
    let imageCount = 0;
    const strippedMessages = messages.map((message) => {
      const count = message.images?.length ?? 0;
      if (count === 0) return message;
      if (options.preserveMarked && message.preserveImagesOnVisionFallback) return message;

      imageCount += count;
      const { images: _images, ...rest } = message;
      const note = translate('chat.subAgentVisionImagesOmitted', { count });
      return {
        ...rest,
        content: `${message.content}\n\n${note}`,
      };
    });

    return { messages: strippedMessages, imageCount };
  }
}
