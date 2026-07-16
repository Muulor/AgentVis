/**
 * useChatSender - Chat 模式消息发送 Hook
 *
 * 封装 Chat 模式下的消息发送逻辑，包括：
 * - 消息持久化（用户消息 + 助手响应）
 * - 记忆上下文注入（三层记忆：身份/偏好、事实、摘要）
 * - RAG 知识库检索
 * - 三层上下文预算管理（Identity/Elastic/Dynamic）
 * - 流式 LLM 调用
 * - 多模态图片处理
 *
 * @module hooks/useChatSender
 */

import { useCallback, useRef } from 'react';
import { createLLMAdapter } from '@services/memory/LLMAdapter';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '@stores/chatStore';
import { useSettingsStore } from '@stores/settingsStore';
import { useStatusStore } from '@stores/statusStore';
import { useToast } from '@components/ui/Toast';
import type { AttachmentInfo, QuoteInfo } from '@/types/message';
import type { Message } from '@/types';
import { getLogger } from '@services/logger';
import { formatTimestamp } from '@services/utils/TimeUtils';
import {
  notifyTaskCompleted,
  resolveTaskCompletionNotificationSource,
} from '@services/desktop-notification';
import { useI18n } from '@/i18n';
import {
  buildChatModeIdentityPrompt,
  buildChatQuoteContext,
  getChatContextSectionTitle,
  NO_CONVERSATION_HISTORY,
} from './useChatSenderPrompt';
import {
  buildChatHistoricalAttachmentContext,
  getChatHistoricalMessageAttachments,
} from './chatAttachmentContext';
import { selectChatHistoryMessages } from './useChatSenderContext';
import { serializeQuotesForMessage } from '@utils/quoteContent';
import {
  modelSupportsVision,
  normalizeReasoningPreset,
  type ReasoningPreset,
} from '@/config/modelRegistry';
import { LLM_TOKEN_POLICIES } from '@services/llm/LlmTokenPolicy';
import {
  estimateGeneratedTokens,
  estimateRequestTokens,
  normalizeReportedTokenCount,
} from '@services/llm/tokenEstimator';

const logger = getLogger('useChatSender');
const STREAM_UI_FLUSH_INTERVAL_MS = 64;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * useChatSender 配置选项
 */
export interface UseChatSenderOptions {
  /** 上下文类型：agent 或 hub */
  contextType: 'agent' | 'hub';
  /** 上下文 ID（Agent ID 或 Hub ID） */
  contextId: string | null;
  /** Agent 配置（仅 agent 模式需要） */
  agentConfig?: {
    name: string;
    hubId: string;
    mbRulesFilePath?: string;
    saRulesFilePath?: string;
    chatRules?: string;
    modelProvider?: string;
    modelName?: string;
    reasoningPreset?: ReasoningPreset;
  };
  /** 是否启用记忆系统（默认 agent=true, hub=true） */
  enableMemory?: boolean;
  /** 是否启用 RAG 检索（默认 agent=true, hub=false） */
  enableRag?: boolean;
}

/**
 * 发送消息选项
 */
export interface SendMessageOptions {
  /** 附件列表 */
  attachments?: AttachmentInfo[];
  /** 引用列表 */
  quotes?: QuoteInfo[];
  /** 清空引用回调 */
  onClearQuotes?: () => void;
  /** 清空附件回调 */
  onClearAttachments?: () => void;
  /** Hub 模式下 @提及的 Agent 信息（动态传入） */
  mentionedAgent?: {
    id: string;
    name: string;
    mbRulesFilePath?: string;
    saRulesFilePath?: string;
    chatRules?: string;
    modelProvider?: string;
    modelName?: string;
    reasoningPreset?: ReasoningPreset;
  };
  /**
   * 跳过用户消息创建（Hub 模式用）
   * 当组件需要先解析 @提及再决定是否调用 LLM 时，
   * 可以在调用前手动创建用户消息，然后设置此选项为 true
   */
  skipUserMessageCreation?: boolean;
  /** 外部提供的用户消息 ID（与 skipUserMessageCreation 配合使用） */
  existingUserMessageId?: string;
  /** 额外的用户消息 metadata（会合并到自动构建的 metadata 中） */
  userMessageMeta?: Record<string, unknown>;
}

/**
 * useChatSender 返回值
 */
export interface UseChatSenderReturn {
  /** 发送消息 */
  sendMessage: (content: string, options?: SendMessageOptions) => Promise<void>;
  /** 当前上下文是否正在发送 */
  isSending: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 读取 Agent Rules 文件内容
 */
async function readRulesFile(filePath: string): Promise<string | undefined> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const content = await readTextFile(filePath);
    return content.trim() || undefined;
  } catch (error) {
    logger.warn('[useChatSender] 读取 Rules 文件失败:', error);
    return undefined;
  }
}

/**
 * 构建多模态图片数据
 */
function buildImageData(
  imageAttachments: AttachmentInfo[]
): Array<{ mime_type: string; data: string }> {
  const imageData: Array<{ mime_type: string; data: string }> = [];
  for (const img of imageAttachments) {
    if (img.base64Data) {
      // 移除 data:image/xxx;base64, 前缀（如果有）
      let base64 = img.base64Data;
      const base64Match = base64.match(/^data:([^;]+);base64,(.+)$/);
      if (base64Match?.[2]) {
        base64 = base64Match[2];
      }
      const ext = img.fileExtension;
      imageData.push({
        mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        data: base64,
      });
    }
  }
  return imageData;
}

// ============================================================================
// 消息类型（支持多模态）
// ============================================================================

interface ChatMessage {
  role: string;
  content: string;
  images?: Array<{ mime_type: string; data: string }>;
}

/** 从消息内容中提取的生成图片 */
interface ExtractedImage {
  mimeType: string;
  base64Data: string;
}

/**
 * 从 assistant 消息内容中提取 base64 生成图片并替换为占位符
 *
 * 图像生成模型的输出格式为 `![alt](data:image/xxx;base64,...)`。
 * 此函数提取图片的 base64 数据，并将原始 data URL 替换为 `[已生成图片]`
 * 以节省上下文窗口 Token（一张图 ~2.5MB base64 ≈ 数十万 Token）。
 *
 * 使用手动字符串搜索而非正则，避免对超长 base64 字符串的灾难性回溯。
 */
function extractGeneratedImages(content: string): {
  cleanedContent: string;
  images: ExtractedImage[];
} {
  const images: ExtractedImage[] = [];
  const marker = '](data:image/';
  let result = '';
  let searchStart = 0;

  for (;;) {
    const markerIdx = content.indexOf(marker, searchStart);
    if (markerIdx === -1) {
      result += content.slice(searchStart);
      break;
    }

    // 回溯找到 ![ 起始位置
    const bangBracketIdx = content.lastIndexOf('![', markerIdx);
    if (bangBracketIdx === -1 || bangBracketIdx < searchStart) {
      result += content.slice(searchStart, markerIdx + marker.length);
      searchStart = markerIdx + marker.length;
      continue;
    }

    // 查找闭合括号
    const openParenIdx = markerIdx + 1;
    const closeParenIdx = content.indexOf(')', openParenIdx + 1);
    if (closeParenIdx === -1) {
      result += content.slice(searchStart, markerIdx + marker.length);
      searchStart = markerIdx + marker.length;
      continue;
    }

    // 提取 data URL
    const dataUrl = content.slice(openParenIdx + 1, closeParenIdx);
    // 解析 MIME 类型和 base64 数据
    const dataUrlMatch = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (dataUrlMatch?.[1] && dataUrlMatch[2]) {
      const mimeType = `image/${dataUrlMatch[1] === 'jpg' ? 'jpeg' : dataUrlMatch[1]}`;
      images.push({ mimeType, base64Data: dataUrlMatch[2] });
    }

    // 替换为占位符
    result += content.slice(searchStart, bangBracketIdx);
    result += '[Generated image]';
    searchStart = closeParenIdx + 1;
  }

  return { cleanedContent: result, images };
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * Chat 模式消息发送 Hook
 *
 * @param options - Hook 配置
 * @returns 发送方法和状态
 *
 * @example
 * ```tsx
 * const { sendMessage, isSending } = useChatSender({
 *     contextType: 'agent',
 *     contextId: currentAgentId,
 *     agentConfig: { name: agent.name, hubId: agent.hubId },
 *     enableMemory: true,
 *     enableRag: true,
 * });
 *
 * await sendMessage(content, {
 *     attachments: pendingAttachments,
 *     quotes: pendingQuotes,
 *     onClearQuotes: () => clearQuotes(hubId),
 *     onClearAttachments: clearAttachments,
 * });
 * ```
 */
export function useChatSender(options: UseChatSenderOptions): UseChatSenderReturn {
  const {
    contextType,
    contextId,
    agentConfig,
    enableMemory = contextType === 'agent',
    enableRag = contextType === 'agent',
  } = options;

  const { toast } = useToast();
  const { t } = useI18n();
  // 同步防护：按 contextId 隔离，避免跨 Agent 共享导致的阻塞
  const sendingContextsRef = useRef<Set<string>>(new Set());

  // 从 settingsStore 获取默认配置
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const localApiUrl = useSettingsStore((s) => s.localApiUrl);

  // chatStore 方法
  const addMessage = useChatStore((s) => s.addMessage);
  const addHubMessage = useChatStore((s) => s.addHubMessage);
  // 按 contextId 读取当前上下文的发送状态
  const sendingContexts = useChatStore((s) => s.sendingContexts);
  const isSending = contextId ? sendingContexts.has(contextId) : false;
  const startSending = useChatStore((s) => s.startSending);
  const finishSending = useChatStore((s) => s.finishSending);

  /**
   * 发送消息（Chat 模式）
   */
  const sendMessage = useCallback(
    async (content: string, sendOptions?: SendMessageOptions): Promise<void> => {
      if (!contextId || sendingContextsRef.current.has(contextId)) return;

      const {
        attachments = [],
        quotes = [],
        onClearQuotes,
        onClearAttachments,
        mentionedAgent,
        skipUserMessageCreation = false,
        existingUserMessageId,
        userMessageMeta,
      } = sendOptions ?? {};

      sendingContextsRef.current.add(contextId);
      useStatusStore.getState().clearContextPressure(contextId);
      startSending(contextId);
      let currentContextCallId: string | null = null;

      // 获取 chatStore 流式操作方法
      const { startStreaming, appendStreamingContent, appendStreamingReasoning, finishStreaming } =
        useChatStore.getState();

      try {
        const attachmentOwnerId =
          contextType === 'agent' ? contextId : (mentionedAgent?.id ?? contextId);
        const attachmentsForSend =
          attachments.length > 0
            ? await (
                await import('@services/attachment')
              ).attachmentService.hydrateAttachmentsForContext(attachments, attachmentOwnerId)
            : [];
        // ====== 步骤 1: 创建用户消息并持久化 ======
        // Hub 模式的消息需要标记 sourceType 以便加载时过滤
        // 同时合并 userMessageMeta（Widget 交互等场景的额外元数据）
        const autoMetadata =
          attachmentsForSend.length > 0
            ? {
                attachments: attachmentsForSend,
                ...(contextType === 'hub' ? { sourceType: 'hub' as const, hubId: contextId } : {}),
              }
            : contextType === 'hub'
              ? { sourceType: 'hub' as const, hubId: contextId }
              : undefined;

        // 合并自动构建的 metadata 和外部传入的 userMessageMeta
        // quotedFrom 也嵌入 metadata 以便重启后能从数据库恢复引用展示
        const quotedFromMeta =
          quotes.length > 0 ? { quotedFrom: serializeQuotesForMessage(quotes) } : undefined;

        const userMetadata =
          autoMetadata || userMessageMeta || quotedFromMeta
            ? { ...autoMetadata, ...quotedFromMeta, ...userMessageMeta }
            : undefined;

        let userMessageId: string;
        let userMessageCreatedAt: number;

        // 检查是否跳过用户消息创建（Hub 混合模式）
        if (skipUserMessageCreation && existingUserMessageId) {
          // 使用外部提供的用户消息 ID
          userMessageId = existingUserMessageId;
          userMessageCreatedAt = Date.now();
          logger.trace('[useChatSender] 跳过用户消息创建，使用外部 ID:', userMessageId);
        } else if (contextType === 'agent') {
          // Agent 模式：持久化到后端
          const userMessageResult = await invoke<{
            id: string;
            agentId: string;
            role: string;
            content: string;
            createdAt: number;
          }>('message_create', {
            request: {
              agentId: contextId,
              role: 'user',
              content,
              metadata: userMetadata ? JSON.stringify(userMetadata) : undefined,
            },
          });
          userMessageId = userMessageResult.id;
          userMessageCreatedAt = userMessageResult.createdAt;

          // 添加到 chatStore
          const userMessage: Message = {
            id: userMessageId,
            content,
            role: 'user',
            agentId: contextId,
            createdAt: userMessageCreatedAt,
            quotedFrom: quotes.length > 0 ? serializeQuotesForMessage(quotes) : undefined,
            metadata: userMetadata,
          };
          addMessage(contextId, userMessage);
        } else {
          // Hub 模式：使用后端 API 持久化（消息持久化需求）
          // 使用 mentionedAgent.id 作为 agentId（满足外键约束）
          // 如果没有 mentionedAgent，则跳过持久化（仅前端显示）
          if (!mentionedAgent) {
            // 无 @提及 Agent 时，不调用后端存储（外键约束会失败）
            // 前端已在 HubChatView 中手动处理此场景
            logger.warn('[useChatSender] Hub 模式无 mentionedAgent，跳过后端持久化');
            userMessageId = `msg-${Date.now()}`;
            userMessageCreatedAt = Date.now();
          } else {
            const hubUserMessageResult = await invoke<{
              id: string;
              agentId: string;
              role: string;
              content: string;
              createdAt: number;
            }>('message_create', {
              request: {
                agentId: mentionedAgent.id, // 使用 Agent ID（满足外键约束）
                role: 'user',
                content,
                metadata: userMetadata ? JSON.stringify(userMetadata) : undefined,
              },
            });
            userMessageId = hubUserMessageResult.id;
            userMessageCreatedAt = hubUserMessageResult.createdAt;
          }

          // 添加到 chatStore（使用 hubId 作为 Store key，但消息的 agentId 使用被提及的 Agent）
          addHubMessage(contextId, {
            id: userMessageId,
            content,
            role: 'user',
            agentId: mentionedAgent?.id ?? contextId,
            createdAt: userMessageCreatedAt,
            quotedFrom: quotes.length > 0 ? serializeQuotesForMessage(quotes) : undefined,
            metadata: userMetadata,
          });
        }

        const streamingAgentName =
          contextType === 'agent' ? agentConfig?.name : mentionedAgent?.name;

        // 立即开始流式状态，Hub @Agent 场景需要带上响应 Agent 名称，避免等待气泡退回显示 Hub
        startStreaming(contextId, streamingAgentName);

        // 用户消息发送成功，清空附件预览
        if (attachmentsForSend.length > 0 && onClearAttachments) {
          onClearAttachments();
        }

        // 复制附件用于后续处理（因为即将清空）
        const attachmentsToSend = [...attachmentsForSend];

        // ====== 步骤 2: 构建消息上下文 ======
        const messages: ChatMessage[] = [];

        // 2.1 获取有效的 Provider/Model
        let effectiveProvider: string;
        let effectiveModel: string;
        let selectedReasoningPreset: ReasoningPreset | undefined;
        let agentName: string;

        if (contextType === 'agent' && agentConfig) {
          effectiveProvider = agentConfig.modelProvider ?? defaultProvider;
          effectiveModel = agentConfig.modelName ?? defaultModel;
          selectedReasoningPreset = agentConfig.reasoningPreset;
          agentName = agentConfig.name;
        } else if (contextType === 'hub' && mentionedAgent) {
          effectiveProvider = mentionedAgent.modelProvider ?? defaultProvider;
          effectiveModel = mentionedAgent.modelName ?? defaultModel;
          selectedReasoningPreset = mentionedAgent.reasoningPreset;
          agentName = mentionedAgent.name;
        } else {
          effectiveProvider = defaultProvider;
          effectiveModel = defaultModel;
          selectedReasoningPreset = undefined;
          agentName = 'Assistant';
        }
        const effectiveReasoningPreset = normalizeReasoningPreset(
          effectiveProvider,
          effectiveModel,
          selectedReasoningPreset
        );
        const supportsVisionInput = modelSupportsVision(effectiveModel, effectiveProvider);

        // 2.2 构建身份层 (Layer 1) — Character Grounding 人格锚定
        let identityPrompt = buildChatModeIdentityPrompt(agentName, content);

        // Chat 模式优先使用独立的 Chat Mode Rules 文本。
        const chatRules = (agentConfig?.chatRules ?? mentionedAgent?.chatRules)?.trim();
        if (chatRules) {
          identityPrompt += '\n' + chatRules + '\n';
          logger.debug('[useChatSender] 已注入 Chat Mode Rules');
        } else {
          // 旧数据兼容：未设置 Chat Rules 时，仍可读取旧版 MB/SA rules 文件。
          const mbRulesPath = agentConfig?.mbRulesFilePath ?? mentionedAgent?.mbRulesFilePath;
          const saRulesPath = agentConfig?.saRulesFilePath ?? mentionedAgent?.saRulesFilePath;
          const rulesPathsToRead = [
            ...new Set([mbRulesPath, saRulesPath].filter(Boolean) as string[]),
          ];
          for (const rulePath of rulesPathsToRead) {
            const rulesContent = await readRulesFile(rulePath);
            if (rulesContent) {
              identityPrompt += '\n' + rulesContent + '\n';
              logger.trace('[useChatSender] 已注入旧版 Rules 文件:', rulePath);
            }
          }
        }

        // 2.3 记忆上下文注入（仅 Agent 模式且启用时）
        let contextFactsPrompt: string | undefined;
        let summariesPrompt: string | undefined;

        if (enableMemory && contextType === 'agent') {
          try {
            const { memoryContextProvider } =
              await import('@services/memory/MemoryContextProvider');
            const memoryContext = await memoryContextProvider.getMemoryContext(contextId, {
              userQuery: content,
              includeOriginal: true,
            });

            // 身份/偏好注入到身份层
            const bindingFactsPrompt = memoryContextProvider.buildBindingFactsPrompt(
              memoryContext.facts
            );
            if (bindingFactsPrompt) {
              identityPrompt += '\n' + bindingFactsPrompt;
              logger.trace('[useChatSender]  已注入身份与偏好');
            }

            // 收集其他事实和摘要（用于 Elastic 层）
            contextFactsPrompt =
              memoryContextProvider.buildContextFactsPrompt(memoryContext.facts) ?? undefined;
            summariesPrompt =
              memoryContextProvider.buildSummariesPrompt(memoryContext.summaries) ?? undefined;
          } catch (error) {
            logger.warn('[useChatSender] 记忆上下文加载失败:', error);
          }
        }

        // Hub 模式记忆注入：加载 @提及 Agent 的记忆
        if (enableMemory && contextType === 'hub' && mentionedAgent) {
          try {
            const { memoryContextProvider } =
              await import('@services/memory/MemoryContextProvider');
            const memoryContext = await memoryContextProvider.getMemoryContext(mentionedAgent.id, {
              userQuery: content,
              includeOriginal: true,
            });

            // 身份/偏好注入
            const bindingFactsPrompt = memoryContextProvider.buildBindingFactsPrompt(
              memoryContext.facts
            );
            if (bindingFactsPrompt) {
              identityPrompt += '\n' + bindingFactsPrompt;
              logger.debug('[useChatSender]  Hub 模式已注入 @Agent 身份与偏好');
            }

            contextFactsPrompt =
              memoryContextProvider.buildContextFactsPrompt(memoryContext.facts) ?? undefined;
            summariesPrompt =
              memoryContextProvider.buildSummariesPrompt(memoryContext.summaries) ?? undefined;
          } catch (error) {
            logger.warn('[useChatSender] Hub 模式记忆加载失败:', error);
          }
        }

        // 添加身份系统消息
        messages.push({ role: 'system', content: identityPrompt });

        // 2.4 RAG 知识库检索（仅 Agent 模式且启用时）
        let ragResultsContent: string | undefined;
        if (enableRag && contextType === 'agent') {
          try {
            // 等待附件索引完成
            const indexingPromises = attachmentsToSend.flatMap((a) =>
              a.type === 'document' && a.indexingPromise ? [a.indexingPromise] : []
            );
            if (indexingPromises.length > 0) {
              logger.trace('[useChatSender]  等待附件索引完成...');
              await Promise.all(indexingPromises);
            }

            const { getRagService } = await import('@services/rag');
            const ragService = getRagService();
            const ragResults = await ragService.retrieveAndFormat(contextId, content, {
              topK: 5,
            });
            if (ragResults.trim()) {
              ragResultsContent = ragResults;
              logger.trace('[useChatSender]  RAG 检索成功:', ragResults.length, '字符');
            }
          } catch (error) {
            logger.warn('[useChatSender] RAG 检索失败:', error);
          }
        }

        // 2.5 收集附件内容
        const imageAttachments = attachmentsToSend.filter((a) => a.type === 'image');

        let attachmentContent: string | undefined;
        if (attachmentsToSend.length > 0) {
          const { attachmentService } = await import('@services/attachment');
          attachmentContent =
            attachmentService.buildAttachmentContext(attachmentsToSend, { mode: 'chat' }) ||
            undefined;
        }

        // 2.6 构建引用上下文
        const quotesContent = buildChatQuoteContext(quotes);

        // 2.7 使用 ContextWindowManager 智能处理上下文（三层预算模型）
        const currentMessages =
          contextType === 'agent'
            ? (useChatStore.getState().messagesByAgent.get(contextId) ?? [])
            : (useChatStore.getState().messagesByHub.get(contextId) ?? []);

        // 构建聊天历史：
        // 1. 提取 assistant 消息中的生成图片，替换为占位符节省 Token
        // 2. 恢复历史 user 消息的图片附件（从 metadata.attachments 中读取 base64Data）
        const historyImages: ExtractedImage[] = [];
        const chatHistory: Array<{
          role: string;
          content: string;
          createdAt?: number;
          images?: Array<{ mime_type: string; data: string }>;
        }> = selectChatHistoryMessages(currentMessages, userMessageId).map(
          (m: {
            id?: string;
            role: string;
            content: string;
            createdAt?: number;
            metadata?: Message['metadata'];
          }) => {
            let effectiveContent = m.content;

            if (m.role === 'user' && m.id !== userMessageId && m.metadata) {
              const historicalAttachmentContext = buildChatHistoricalAttachmentContext(
                getChatHistoricalMessageAttachments(m.metadata),
                effectiveContent,
                t
              );
              if (historicalAttachmentContext) {
                effectiveContent = `${historicalAttachmentContext}\n\n${effectiveContent}`;
              }
            }

            // assistant 消息中的 AI 生成图片：提取后替换为占位符
            if (m.role === 'assistant' && effectiveContent.includes('](data:image/')) {
              const { cleanedContent, images } = extractGeneratedImages(effectiveContent);
              if (images.length > 0 && supportsVisionInput) {
                historyImages.push(...images);
                logger.trace('[useChatSender] 从历史消息提取生成图片:', images.length, '张');
              }
              return { role: m.role, content: cleanedContent, createdAt: m.createdAt };
            }

            // 历史 user 消息的图片附件恢复：
            // 图片绑定原始消息而非合并到最新消息，避免跨话题时注入无关图片噪音
            if (supportsVisionInput && m.role === 'user' && m.metadata) {
              const attachmentsList = (
                m.metadata as {
                  attachments?: Array<{
                    type: string;
                    base64Data?: string;
                    fileExtension?: string;
                  }>;
                }
              ).attachments;
              if (attachmentsList) {
                const imgAttachments = attachmentsList.filter(
                  (a) => a.type === 'image' && a.base64Data
                );
                if (imgAttachments.length > 0) {
                  const restoredImages = imgAttachments.flatMap((img) => {
                    if (!img.base64Data) return [];
                    let base64 = img.base64Data;
                    const match = base64.match(/^data:([^;]+);base64,(.+)$/);
                    if (match?.[2]) base64 = match[2];
                    const ext = img.fileExtension ?? 'webp';
                    return [
                      {
                        mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                        data: base64,
                      },
                    ];
                  });
                  logger.trace(
                    '[useChatSender] 🖼️ 恢复历史 user 消息图片:',
                    restoredImages.length,
                    '张'
                  );
                  return {
                    role: m.role,
                    content: effectiveContent,
                    createdAt: m.createdAt,
                    images: restoredImages,
                  };
                }
              }
            }

            // 恢复上一轮 Planning assistant 通过 generate_image 生成的最后一张图片（跨模式短期图片感知）
            if (supportsVisionInput && m.role === 'assistant' && m.metadata) {
              const genImages = (m.metadata as { generatedImages?: string[] }).generatedImages;
              if (genImages && genImages.length > 0) {
                return {
                  role: m.role,
                  content: effectiveContent,
                  createdAt: m.createdAt,
                  _pendingImagePaths: genImages,
                };
              }
            }

            return { role: m.role, content: effectiveContent, createdAt: m.createdAt };
          }
        );

        // 异步解析 assistant 消息标记的生成图片路径为 base64
        // 后端只处理 user 消息的 images，因此拆分为 assistant 文本 + user 图片消息
        const latestChatHistoryMessage = chatHistory[chatHistory.length - 1] as
          | { _pendingImagePaths?: string[] }
          | undefined;
        for (const msg of chatHistory) {
          const pending = (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
          if (!pending || pending.length === 0) continue;

          if (msg === latestChatHistoryMessage) {
            const latestPath = pending[pending.length - 1];
            (msg as { _pendingImagePaths?: string[] })._pendingImagePaths = latestPath
              ? [latestPath]
              : undefined;
          } else {
            delete (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
          }
        }

        const resolvedHistory: typeof chatHistory = [];
        for (const msg of chatHistory) {
          const pending = (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
          if (pending && pending.length > 0) {
            if (!supportsVisionInput) {
              resolvedHistory.push({
                role: msg.role,
                content: msg.content,
                createdAt: msg.createdAt,
              });
              continue;
            }
            // 先添加原始 assistant 文本
            resolvedHistory.push({
              role: msg.role,
              content: msg.content,
              createdAt: msg.createdAt,
            });
            // 异步读取图片，作为合成 user 消息注入
            try {
              const results = await Promise.allSettled(
                pending.map(async (imgPath) => {
                  const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
                  const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
                  const base64 = await invoke<string>('file_read_as_base64', { path: imgPath });
                  return { mime_type: mimeType, data: base64 };
                })
              );
              const loadedImages = results
                .filter(
                  (r): r is PromiseFulfilledResult<{ mime_type: string; data: string }> =>
                    r.status === 'fulfilled'
                )
                .map((r) => r.value);
              if (loadedImages.length > 0) {
                resolvedHistory.push({
                  role: 'user',
                  content:
                    '[Historical reference: image generated by the previous assistant message]',
                  images: loadedImages,
                });
                logger.trace(
                  '[useChatSender] 🖼️ 恢复历史 assistant 生成图片:',
                  loadedImages.length,
                  '张'
                );
              }
            } catch (error) {
              logger.warn('[useChatSender] assistant 图片恢复失败:', error);
            }
          } else {
            resolvedHistory.push(msg);
          }
        }

        const { contextWindowManager, HISTORY_CONFIG } =
          await import('@services/planning/ContextWindowManager');

        // 构建上下文分层
        const contextLayers: import('@services/planning/ContextWindowManager').ContextLayers = {
          quotes: quotesContent,
          ragResults: ragResultsContent,
          attachments: attachmentContent,
          backgroundFacts: contextFactsPrompt,
          summaries: summariesPrompt,
        };

        // Chat 模式限制历史轮次（15 轮），防止长对话稀释 LLM 注意力
        const preparedContext = await contextWindowManager.prepareContext(
          resolvedHistory,
          identityPrompt,
          effectiveModel,
          contextLayers,
          HISTORY_CONFIG.CHAT_MODE_MAX_HISTORY_ROUNDS,
          estimateRequestTokens([
            {
              role: 'user',
              content,
              images: supportsVisionInput
                ? Array.from({ length: imageAttachments.length + historyImages.length })
                : undefined,
            },
          ]),
          effectiveProvider
        );

        logger.trace(
          '[useChatSender] 预算报告:',
          JSON.stringify(preparedContext.budgetReport, null, 2)
        );

        // 2.8 注入预算管理后的上下文块（Layer 2 内容）
        for (const block of preparedContext.contextBlocks) {
          if (block.content) {
            const sectionTitle = getChatContextSectionTitle(block.type);
            messages.push({
              role: 'system',
              content: `${sectionTitle}\n\n${block.content}`,
            });
            logger.trace(`[useChatSender]  已注入 ${block.type}: ${block.content.length} 字符`);
          }
        }

        // 2.9 注入对话历史（Layer 3 内容）
        if (preparedContext.wasTruncated) {
          if (
            preparedContext.conversationHistory &&
            preparedContext.conversationHistory !== NO_CONVERSATION_HISTORY
          ) {
            messages.push({
              role: 'system',
              content: `## Conversation History\n\n${preparedContext.conversationHistory}`,
            });
          }
        } else {
          // 未截断时为历史 user 消息前缀注入时间标签，让模型感知对话间隔
          // 仅标记 user 消息：assistant 消息如果也带时间戳，LLM 会通过 in-context learning
          // 模仿该格式在输出中附带时间戳（即使 prompt 明确禁止）
          for (const m of chatHistory) {
            const timePrefix =
              m.role === 'user' && m.createdAt ? `[${formatTimestamp(m.createdAt)}] ` : '';
            const msg: ChatMessage = { role: m.role, content: timePrefix + m.content };
            if (supportsVisionInput && m.images && m.images.length > 0) {
              msg.images = m.images;
            }
            messages.push(msg);
          }
        }

        // 2.10 添加当前用户消息
        const userMessageForLLM: ChatMessage = { role: 'user', content };

        // 多模态图片处理：用户上传的图片附件
        const allImages: Array<{ mime_type: string; data: string }> = [];
        if (supportsVisionInput && imageAttachments.length > 0) {
          const imageData = buildImageData(imageAttachments);
          allImages.push(...imageData);
        }

        // 多模态图片处理：历史 assistant 消息中的生成图片
        // 将提取的图片作为当前 user 消息的 images 注入（LLM API 仅支持 user 消息带图片）
        if (supportsVisionInput && historyImages.length > 0) {
          for (const img of historyImages) {
            allImages.push({ mime_type: img.mimeType, data: img.base64Data });
          }
          logger.trace('[useChatSender] 🖼️ 注入历史生成图片:', historyImages.length, '张');
        }

        if (allImages.length > 0) {
          userMessageForLLM.images = allImages;
          logger.trace('[useChatSender]  多模态图片总计:', allImages.length, '张');
        }

        messages.push(userMessageForLLM);

        // ====== 步骤 3: 流式 LLM 调用 ======
        const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        currentContextCallId = sessionId;

        // 注册 sessionId 和 AbortController 到 chatStore（用于取消信号传递）
        const abortController = new AbortController();
        useChatStore.getState().setSessionId(contextId, sessionId);
        useChatStore.getState().setAbortController(contextId, abortController);

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        // 取消标志：当后端发送 "用户取消" 错误时置为 true，
        // 用于阻止步骤4继续执行 addMessage 导致气泡重新出现
        const cancellationState = { cancelled: false };
        let pendingContentDelta = '';
        let pendingReasoningDelta = '';
        let streamFlushTimer: number | null = null;
        const estimatedInputTokens = estimateRequestTokens(messages);
        const { getContextWindowSize } = await import('@/config/modelRegistry');
        const contextWindow = getContextWindowSize(effectiveModel, effectiveProvider);

        useStatusStore.getState().beginContextUsage(contextId, {
          callId: sessionId,
          currentInputTokens: estimatedInputTokens,
          currentOutputTokens: 0,
          contextWindowSize: contextWindow,
          purpose: 'chat',
          providerId: effectiveProvider,
          modelId: effectiveModel,
        });

        const clearStreamFlushTimer = () => {
          if (streamFlushTimer !== null) {
            window.clearTimeout(streamFlushTimer);
            streamFlushTimer = null;
          }
        };

        const flushStreamingDeltas = () => {
          clearStreamFlushTimer();

          if (abortController.signal.aborted || cancellationState.cancelled) {
            pendingContentDelta = '';
            pendingReasoningDelta = '';
            return;
          }

          const contentDelta = pendingContentDelta;
          const reasoningDelta = pendingReasoningDelta;
          pendingContentDelta = '';
          pendingReasoningDelta = '';

          if (contentDelta) {
            appendStreamingContent(contextId, contentDelta);
          }

          if (reasoningDelta) {
            appendStreamingReasoning(contextId, reasoningDelta);
          }

          if (contentDelta || reasoningDelta) {
            useStatusStore.getState().updateContextUsage(contextId, sessionId, {
              currentOutputTokens: estimateGeneratedTokens({
                content: accumulatedContent,
                reasoningContent: accumulatedReasoning,
              }),
            });
          }
        };

        const scheduleStreamingFlush = () => {
          if (streamFlushTimer !== null) return;

          streamFlushTimer = window.setTimeout(flushStreamingDeltas, STREAM_UI_FLUSH_INTERVAL_MS);
        };

        const { listen } = await import('@tauri-apps/api/event');

        const unlisten = await listen<{
          sessionId: string;
          delta: string;
          reasoning?: string;
          done: boolean;
          error: string | null;
          inputTokens?: number;
          outputTokens?: number;
        }>('llm-stream-chunk', (event) => {
          if (event.payload.sessionId !== sessionId) return;

          // 用户已取消时忽略后续到达的 chunk，
          // 防止 appendStreamingContent 将 isStreaming 重置为 true 导致气泡重新出现
          if (abortController.signal.aborted) return;

          if (event.payload.error) {
            // 区分用户主动取消与真正的流式错误
            if (event.payload.error === 'User cancelled') {
              cancellationState.cancelled = true;
              pendingContentDelta = '';
              pendingReasoningDelta = '';
              clearStreamFlushTimer();
              logger.trace('[useChatSender] 收到后端取消确认');
            } else {
              flushStreamingDeltas();
              logger.error('[useChatSender] 流式响应错误:', event.payload.error);
            }
            finishStreaming(contextId);
            return;
          }

          if (event.payload.delta) {
            accumulatedContent += event.payload.delta;
            pendingContentDelta += event.payload.delta;
          }

          if (event.payload.reasoning) {
            accumulatedReasoning += event.payload.reasoning;
            pendingReasoningDelta += event.payload.reasoning;
          }

          if (event.payload.delta || event.payload.reasoning) {
            scheduleStreamingFlush();
          }

          // 流结束时提取 API 返回的 token 用量，累加到 statusStore
          if (event.payload.done) {
            flushStreamingDeltas();

            const estimatedOutput = estimateGeneratedTokens({
              content: accumulatedContent,
              reasoningContent: accumulatedReasoning,
            });
            const reportedInput = normalizeReportedTokenCount(event.payload.inputTokens);
            const reportedOutput = normalizeReportedTokenCount(event.payload.outputTokens);
            const inputTokens = reportedInput ?? estimatedInputTokens;
            const outputTokens = reportedOutput ?? estimatedOutput;
            const hasApiUsage = reportedInput !== undefined || reportedOutput !== undefined;

            useStatusStore.getState().completeContextUsage(contextId, sessionId, {
              currentInputTokens: inputTokens,
              currentOutputTokens: outputTokens,
            });

            if (hasApiUsage || accumulatedContent.length > 0 || accumulatedReasoning.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-deprecated -- TODO(token-usage-ledger): 保留旧累计直到账本接管。
              useStatusStore.getState().addTokenUsage(contextId, inputTokens, outputTokens);
            }
          }
        });

        // 调用流式 LLM API
        const baseUrl = effectiveProvider === 'local' ? localApiUrl : undefined;

        logger.trace('[useChatSender] 调用流式 LLM API:', {
          provider: effectiveProvider,
          model: effectiveModel,
          sessionId,
          messageCount: messages.length,
        });

        // 打印完整 System Prompt 便于调试时间注入效果
        const systemMessages = messages.filter((m) => m.role === 'system');
        for (const sysMsg of systemMessages) {
          logger.debug(`[useChatSender] System Prompt:\n${sysMsg.content}`);
        }

        // 图像模型检测：自动注入 response_modalities 和从提示词解析 image_size
        // Gemini 图像模型需要显式指定 response_modalities 才能输出图片
        const isImageModel = effectiveModel.includes('image');
        let imageModelConfig:
          | {
              response_modalities?: string[];
              image_config?: { aspect_ratio?: string; image_size: string };
            }
          | undefined;

        if (isImageModel) {
          // 从用户提示词中解析分辨率意图（4K > 2K > 1K > 512，优先匹配高分辨率）
          const sizeMatch = content.match(/\b(4K|2K|1K|512)\b/i);
          const parsedSize = sizeMatch?.[1]
            ? // API 要求大写 K，且 512 不带后缀
              sizeMatch[1].toUpperCase().replace(/^(\d)K$/i, '$1K')
            : undefined;

          imageModelConfig = {
            response_modalities: ['Text', 'Image'],
            // 传入解析到的分辨率，宽高比由模型根据输入图片自行匹配
            ...(parsedSize && {
              image_config: { image_size: parsedSize },
            }),
          };

          if (parsedSize) {
            logger.trace(`[useChatSender] 🖼️ 从提示词解析到 image_size: ${parsedSize}`);
          }
        }

        try {
          await invoke('llm_chat_stream', {
            request: {
              provider: effectiveProvider,
              model: effectiveModel,
              reasoning_preset: effectiveReasoningPreset,
              messages,
              temperature: 1,
              max_tokens: isImageModel
                ? LLM_TOKEN_POLICIES.imageGeneration.primaryMaxTokens
                : LLM_TOKEN_POLICIES.chat.primaryMaxTokens,
              supports_vision: supportsVisionInput,
              base_url: baseUrl,
              ...imageModelConfig,
            },
            sessionId,
          });
        } finally {
          unlisten();
          flushStreamingDeltas();
        }

        // ====== 步骤 4: 保存助手响应 ======
        // 若用户已取消，跳过响应保存，避免气泡消失后又被 addMessage 重新显示
        if (cancellationState.cancelled || abortController.signal.aborted) {
          logger.trace('[useChatSender] 用户已取消，跳过响应保存');
          finishStreaming(contextId);
        } else if (accumulatedContent.trim() || accumulatedReasoning.trim()) {
          let assistantMessageId: string;
          let assistantMessageCreatedAt: number;

          if (contextType === 'agent') {
            const assistantResult = await invoke<{
              id: string;
              agentId: string;
              role: string;
              content: string;
              createdAt: number;
            }>('message_create', {
              request: {
                agentId: contextId,
                role: 'assistant',
                content: accumulatedContent,
                metadata: accumulatedReasoning
                  ? JSON.stringify({ reasoningContent: accumulatedReasoning })
                  : undefined,
              },
            });
            assistantMessageId = assistantResult.id;
            assistantMessageCreatedAt = assistantResult.createdAt;

            const agentResponse: Message = {
              id: assistantMessageId,
              content: accumulatedContent,
              role: 'assistant',
              agentId: contextId,
              createdAt: assistantMessageCreatedAt,
              metadata: accumulatedReasoning
                ? { reasoningContent: accumulatedReasoning }
                : undefined,
            };
            addMessage(contextId, agentResponse);

            // 在 addMessage 后结束流式状态
            finishStreaming(contextId);
            logger.trace('[useChatSender]  助手响应已保存');

            void notifyTaskCompleted({
              id: assistantMessageId,
              contextType,
              contextId,
              agentId: contextId,
              agentName,
              hubId: agentConfig?.hubId,
              content: accumulatedContent,
              source: resolveTaskCompletionNotificationSource(userMessageMeta?.source),
              mode: 'chat',
              createdAt: assistantMessageCreatedAt,
            });

            // ====== 步骤 5: 更新记忆系统 ======
            if (enableMemory) {
              try {
                const { getOrCreateMemoryService } = await import('@services/memory');

                // dynamic 模式：LLMAdapter 在每次 generate 调用时从 settingsStore
                // 实时解析 provider/model，UI 切换设置后无需重建实例即可生效
                const llmService = createLLMAdapter({
                  dynamic: true,
                });

                // 使用全局工厂获取或创建 MemoryService 实例
                const memoryService = getOrCreateMemoryService(contextId, llmService);

                // fire-and-forget：记忆处理（含水位线摘要生成）在后台异步进行，
                // 不阻塞 setIsSending(false)，避免输入框在记忆整理期间被禁用
                memoryService
                  .addInteraction(
                    {
                      id: userMessageId,
                      agentId: contextId,
                      role: 'user',
                      content,
                      createdAt: userMessageCreatedAt,
                    },
                    {
                      id: assistantMessageId,
                      agentId: contextId,
                      role: 'assistant',
                      content: accumulatedContent,
                      createdAt: assistantMessageCreatedAt,
                    }
                  )
                  .catch((memoryError: unknown) => {
                    logger.warn('[useChatSender] 记忆系统更新失败:', memoryError);
                  });
                logger.trace('[useChatSender]  已更新记忆系统');
              } catch (memoryError) {
                logger.warn('[useChatSender] 记忆系统更新失败:', memoryError);
              }
            }
          } else {
            // Hub 模式：助手消息持久化
            // 使用 mentionedAgent.id 作为 agentId（满足外键约束）
            if (mentionedAgent) {
              const hubAssistantMessageResult = await invoke<{
                id: string;
                createdAt: number;
              }>('message_create', {
                request: {
                  agentId: mentionedAgent.id, // 使用 Agent ID
                  role: 'assistant',
                  content: accumulatedContent,
                  metadata: JSON.stringify({
                    agentName: agentName,
                    // Hub 模式添加 sourceType 和 hubId 以便加载时过滤
                    sourceType: 'hub' as const,
                    hubId: contextId,
                    ...(accumulatedReasoning ? { reasoningContent: accumulatedReasoning } : {}),
                  }),
                },
              });
              assistantMessageId = hubAssistantMessageResult.id;
              assistantMessageCreatedAt = hubAssistantMessageResult.createdAt;
            } else {
              // 无 mentionedAgent 时不应到达此处（前面已有检查）
              assistantMessageId = `msg-${Date.now()}`;
              assistantMessageCreatedAt = Date.now();
            }

            addHubMessage(contextId, {
              id: assistantMessageId,
              content: accumulatedContent,
              role: 'assistant',
              agentId: mentionedAgent?.id ?? contextId,
              createdAt: assistantMessageCreatedAt,
              metadata: {
                agentName: agentName,
                ...(accumulatedReasoning ? { reasoningContent: accumulatedReasoning } : {}),
              },
            });
            finishStreaming(contextId);
            logger.trace('[useChatSender]  Hub 助手响应已持久化');

            if (mentionedAgent) {
              void notifyTaskCompleted({
                id: assistantMessageId,
                contextType,
                contextId,
                agentId: mentionedAgent.id,
                agentName,
                hubId: contextId,
                content: accumulatedContent,
                source: resolveTaskCompletionNotificationSource(userMessageMeta?.source),
                mode: 'chat',
                createdAt: assistantMessageCreatedAt,
              });
            }
          }

          // 清空引用
          if (quotes.length > 0 && onClearQuotes) {
            onClearQuotes();
          }
        } else {
          finishStreaming(contextId);
        }

        // Legacy Session Usage accumulation happens in the stream done event.
      } catch (error) {
        logger.error('[useChatSender] 发送失败:', error);
        useChatStore.getState().finishStreaming(contextId);
        toast({
          type: 'error',
          title: t('chat.toastSendFailed'),
          description: error instanceof Error ? error.message : String(error),
          duration: 6000,
        });
        useStatusStore.getState().setModelStatus('error');
      } finally {
        if (contextId) {
          if (currentContextCallId) {
            useStatusStore.getState().clearContextPressure(contextId, currentContextCallId);
          }
          sendingContextsRef.current.delete(contextId);
          finishSending(contextId);
        }
        // 任务结束后恢复模型状态灯（瞬时错误不应持续红灯）
        useStatusStore.getState().setModelStatus('online');
      }
    },
    [
      contextType,
      contextId,
      agentConfig,
      enableMemory,
      enableRag,
      defaultProvider,
      defaultModel,
      localApiUrl,
      addMessage,
      addHubMessage,
      startSending,
      finishSending,
      toast,
      t,
    ]
  );

  return {
    sendMessage,
    isSending,
  };
}
