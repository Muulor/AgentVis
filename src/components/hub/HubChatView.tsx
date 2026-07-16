import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { useWidgetStore } from '@stores/widgetStore';
import { destroyAgentService } from '@services/planning/AgentService';
import { getCachedMemoryService } from '@services/memory/MemoryService';
import { useToast } from '@components/ui/Toast';
import { useAttachmentManager } from '@/hooks/useAttachmentManager';
import { useMessageActions } from '@/hooks/useMessageActions';
import { useChatSender } from '@/hooks/useChatSender';
import { usePlanningMode } from '@/hooks/usePlanningMode';
import {
  ChatHistory,
  ChatInput,
  ChatSearchBar,
  type ChatInputRestoreDraft,
} from '@components/chat';
import { buildWidgetUndoRetractionPlan } from '@components/widgets/widgetUndo';
import { collectWidgetBubbleSubmissions } from '@stores/widgetSubmissionRecovery';
import { Tooltip } from '@components/ui/Tooltip';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { SetupChecklist, type SetupChecklistState } from '@components/onboarding/SetupChecklist';
import { useI18n } from '@/i18n';
import type { ChatMode } from '@/types/chatMode';
import { normalizeChatMode } from '@/types/chatMode';
import type { UIMessage } from '@/types/message';
import type { Message } from '@/types';
import styles from './HubChatView.module.css';
import { getLogger } from '@services/logger';
import { getMessageQuoteContent, serializeQuotesForMessage } from '@utils/quoteContent';
import { refreshHubMessagesFromDb } from '@utils/messageReload';

const logger = getLogger('HubChatView');

interface HubChatViewProps {
  setupChecklistState: SetupChecklistState;
}

/**
 * 解析消息中的 @提及
 * 支持两种语法：
 * - @AgentName（单词，无空格）
 * - @"Agent Name" 或 @'Agent Name'（引号包裹，支持空格）
 * 返回提及的 Agent 名称列表
 */
function parseMentions(content: string): string[] {
  // 匹配 @"..." 或 @'...' 或 @单词
  const mentionRegex = /@(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    // 优先取引号内的内容，其次取单词
    const name = match[1] ?? match[2] ?? match[3];
    if (name) {
      mentions.push(name);
    }
  }
  return mentions;
}

function buildRevokeRestoreDraft(message: UIMessage): ChatInputRestoreDraft {
  const metadataDisplayContent = message.metadata?.displayContent;

  return {
    id: `revoke:${message.id}:${Date.now()}`,
    value: typeof metadataDisplayContent === 'string' ? metadataDisplayContent : message.content,
    contextTokens: [],
  };
}

function getMessageAttachments(message: UIMessage) {
  if (Array.isArray(message.metadata?.attachments)) {
    return message.metadata.attachments;
  }

  return Array.isArray(message.attachments) ? message.attachments : [];
}

/**
 * HubChatView 组件
 *
 * Hub讨论区主视图，支持：
 * - 标题区显示当前Hub名称
 * - 对话历史区（使用 ChatHistory 组件）
 * - 输入区支持@提及Agent（使用 ChatInput 组件）
 * - 模式选择器（Chat/Planning）
 * - @提及Agent时调用对应Agent的LLM
 */
export function HubChatView({ setupChecklistState }: HubChatViewProps) {
  const { t } = useI18n();
  const currentHubId = useHubStore((state) => state.currentHubId);
  const hubs = useHubStore((state) => state.hubs);
  const agents = useAgentStore((state) => state.agents);
  // 流式状态（按 contextId 隔离）
  const streamingByContext = useChatStore((state) => state.streamingByContext);
  // Hub 消息存储（按 hubId 隔离）
  const messagesByHub = useChatStore((state) => state.messagesByHub);
  const addHubMessage = useChatStore((state) => state.addHubMessage);
  // 模式状态（按 contextId 隔离）
  const modeByContext = useChatStore((state) => state.modeByContext);
  const mode = normalizeChatMode(currentHubId ? modeByContext.get(currentHubId) : undefined);
  const setModeFor = useChatStore((state) => state.setModeFor);
  const pendingQuotesByHub = useChatStore((state) => state.pendingQuotesByHub);
  const removeQuote = useChatStore((state) => state.removeQuote);
  const clearQuotes = useChatStore((state) => state.clearQuotes);
  // 发送状态（按 contextId 隔离）
  const sendingContexts = useChatStore((state) => state.sendingContexts);
  const isSending = currentHubId ? sendingContexts.has(currentHubId) : false;
  const stopStreaming = useChatStore((state) => state.stopStreaming);

  // ========== 搜索状态 ==========
  const searchByContext = useChatStore((state) => state.searchByContext);
  const isSearchOpen = currentHubId ? (searchByContext.get(currentHubId)?.isOpen ?? false) : false;
  const openSearch = useChatStore((state) => state.openSearch);
  const closeSearch = useChatStore((state) => state.closeSearch);

  // ========== 多选状态 ==========
  const multiSelectByContext = useChatStore((state) => state.multiSelectByContext);
  const multiSelectState = currentHubId ? multiSelectByContext.get(currentHubId) : undefined;
  const isMultiSelectActive = multiSelectState?.isActive ?? false;
  const selectedMessageIds = useMemo(
    () => multiSelectState?.selectedIds ?? new Set<string>(),
    [multiSelectState?.selectedIds]
  );
  const toggleMessageSelect = useChatStore((state) => state.toggleMessageSelect);
  const exitMultiSelect = useChatStore((state) => state.exitMultiSelect);

  // ========== 消息分页（加载更多）==========
  const hasMoreByHub = useChatStore((state) => state.hasMoreByHub);
  const hubHasMore = currentHubId ? (hasMoreByHub.get(currentHubId) ?? false) : false;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [restoreDraft, setRestoreDraft] = useState<ChatInputRestoreDraft | null>(null);

  // Toast 通知 hook
  const { toast } = useToast();

  // 使用统一的附件管理 Hook（Hub 不需要 RAG 索引）
  const {
    pendingAttachments,
    isAddingAttachment,
    addAttachments: handleAttachmentAdd,
    removeAttachment: handleAttachmentRemove,
    reorderAttachments: handleAttachmentReorder,
    restoreAttachments,
    clearAttachments,
    getAttachmentsCopy,
  } = useAttachmentManager(currentHubId);

  // Hub 视图激活时，注册 token 追踪上下文 ID
  // StatusBar 通过 activeTokenContextId 确定读取哪个上下文的 token 数据，
  // 解决 Hub 视图下 currentAgentId 为 null 导致 token 不显示的问题
  useEffect(() => {
    if (currentHubId) {
      void import('@stores/statusStore')
        .then(({ useStatusStore }) => {
          useStatusStore.getState().setActiveTokenContextId(currentHubId);
        })
        .catch((error: unknown) => {
          logger.warn('[HubChatView] 设置 active token context 失败:', error);
        });
    }
  }, [currentHubId]);

  // 获取当前Hub
  const currentHub = hubs.find((h) => h.id === currentHubId);

  // 获取当前 Hub 的消息列表（从 Store 读取，统一数据源）
  const hubMessages = useMemo<UIMessage[]>(() => {
    if (!currentHubId) return [];
    const messages = messagesByHub.get(currentHubId) ?? [];
    // 转换为 UIMessage 类型
    return messages.map((m) => ({
      ...m,
      status: 'completed' as const,
    }));
  }, [currentHubId, messagesByHub]);

  const handleRevokeComplete = useCallback(
    (message: UIMessage) => {
      restoreAttachments(getMessageAttachments(message));
      setRestoreDraft(buildRevokeRestoreDraft(message));
    },
    [restoreAttachments]
  );

  // 消息操作（由 useMessageActions Hook 管理）
  const {
    handleMessageAction,
    deleteDialogState,
    closeDeleteDialog,
    revokeConfirmDialogState,
    closeRevokeConfirmDialog,
  } = useMessageActions({
    contextType: 'hub',
    contextId: currentHubId,
    messages: hubMessages,
    onRevokeComplete: handleRevokeComplete,
  });

  // Chat 模式消息发送（由 useChatSender Hook 管理）
  // Hub 模式：启用记忆（用于 @Agent 时注入该 Agent 记忆），禁用 RAG（Hub 无知识库）
  const { sendMessage: sendHubMessage } = useChatSender({
    contextType: 'hub',
    contextId: currentHubId,
    enableMemory: true,
    enableRag: false,
  });

  // Planning 模式消息发送（由 usePlanningMode Hook 管理）
  const { executePlanningTask, stopPlanningTask } = usePlanningMode({
    contextType: 'hub',
    contextId: currentHubId,
  });

  const handleStopStreaming = useCallback(() => {
    if (!currentHubId) return;

    stopStreaming(currentHubId);
    toast({
      type: 'info',
      title: t('chat.toastStreamCancelRequestedTitle'),
      description: t('chat.toastStreamCancelRequestedDescription'),
      duration: 3000,
    });

    // Planning 模式额外取消 AgentLoop
    if (mode === 'planning') {
      stopPlanningTask();
    }
  }, [currentHubId, mode, stopPlanningTask, stopStreaming, t, toast]);

  // 获取当前 Hub 的引用列表（直接订阅 Map 状态以实现响应式更新）
  const pendingQuotes = useMemo(
    () => (currentHubId ? (pendingQuotesByHub.get(currentHubId) ?? []) : []),
    [currentHubId, pendingQuotesByHub]
  );

  // 获取当前 Hub 的流式状态（隔离存储）
  const currentStreamingState = useMemo(() => {
    if (!currentHubId) return { content: '', isStreaming: false, agentName: undefined };
    return (
      streamingByContext.get(currentHubId) ?? {
        content: '',
        isStreaming: false,
        agentName: undefined,
      }
    );
  }, [currentHubId, streamingByContext]);
  const isStreaming = currentStreamingState.isStreaming;
  const streamingContent = currentStreamingState.content;
  const streamingReasoningContent = currentStreamingState.reasoningContent ?? '';
  // 从流式状态中获取响应中的 Agent 名称，确保切换标签后也能正确显示
  const streamingAgentName = currentStreamingState.agentName ?? 'Hub';

  // Hub 消息已通过 useDataLoader 在 Hub 切换时从 SQLite 加载，无需手动 localStorage 操作

  // ========== Widget 交互闭环 ==========
  // 监听 widgetStore 的 pendingAction，用户在气泡 Widget 中确认回复后，
  // 自动路由回产生该 Widget 的 Agent，无需用户手动 @提及
  //
  // 使用 ref 持有 isSending/isStreaming 最新值，避免 subscriber 因这两个状态变化而频繁重建，
  // 消除 pendingAction 在 effect 重建窗口期被新订阅拦截但条件不满足而永久丢弃的竞争条件
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    const unsubscribe = useWidgetStore.subscribe((state) => {
      const action = state.pendingAction;
      // 通过 ref 读取最新的 isSending/isStreaming，避免闭包过期导致竞争条件
      if (action?.contextId !== currentHubId || isSendingRef.current || isStreamingRef.current)
        return;

      // 立即消费事件（防止重复触发）
      useWidgetStore.getState().consumeAction();

      // 提取气泡 ID，用于 sendMessage 成功后调用 markBubbleSubmitted
      const { widgetBubbleId } = action;

      // 通过 agentId 精准找到目标 Agent
      let targetAgent = action.agentId ? agents.find((a) => a.id === action.agentId) : undefined;

      // 兜底回退：找不到 agentId 时，从消息列表反查最近一条 assistant 消息的来源 Agent
      if (!targetAgent && currentHubId) {
        const hubMsgs = useChatStore.getState().messagesByHub.get(currentHubId) ?? [];
        for (let i = hubMsgs.length - 1; i >= 0; i--) {
          const msg = hubMsgs[i];
          if (msg?.role === 'assistant' && msg.agentId) {
            targetAgent = agents.find((a) => a.id === msg.agentId);
            if (targetAgent) break;
          }
        }
      }

      if (!targetAgent) {
        logger.warn('[HubChatView] Widget 交互无法找到目标 Agent，事件丢弃');
        return;
      }

      // widgetBubbleId 写入 metadata，使 SQLite 中的消息也携带该字段，
      // 便于 useDataLoader 重启时扫描恢复 markBubbleSubmitted 状态
      const widgetMeta: Record<string, unknown> = {
        source: 'widget' as const,
        displayText: action.displayText,
        ...(widgetBubbleId ? { widgetBubbleId } : {}),
        ...(action.widgetSelections ? { widgetSelections: action.widgetSelections } : {}),
        ...(action.widgetExtraText !== undefined
          ? { widgetExtraText: action.widgetExtraText }
          : {}),
      };

      // 根据当前模式路由：Planning 模式走 AgentLoop，Chat 模式走流式对话
      if (mode === 'planning') {
        executePlanningTask(action.actionText, {
          mentionedAgent: {
            id: targetAgent.id,
            name: targetAgent.name,
            hubId: targetAgent.hubId,
            mbRulesFilePath: targetAgent.mbRulesFilePath ?? undefined,
            saRulesFilePath: targetAgent.saRulesFilePath ?? undefined,
            mbRules: targetAgent.mbRules ?? undefined,
            saRules: targetAgent.saRules ?? undefined,
            modelProvider: targetAgent.modelProvider ?? undefined,
            modelName: targetAgent.modelName ?? undefined,
            reasoningPreset: targetAgent.reasoningPreset ?? undefined,
            pinnedSkills: targetAgent.pinnedSkills ?? undefined,
            sandboxMode: targetAgent.sandboxMode ?? undefined,
            visualEnhancementEnabled: targetAgent.visualEnhancementEnabled ?? undefined,
            subAgentSafetyFooterEnabled: targetAgent.subAgentSafetyFooterEnabled ?? undefined,
            subAgentSafetyFooterText: targetAgent.subAgentSafetyFooterText ?? undefined,
          },
          userMessageMeta: widgetMeta,
        })
          .then(() => {
            // Planning 执行完成后，标记气泡已提交（此时消息已写入 SQLite）
            if (widgetBubbleId) {
              useWidgetStore.getState().markBubbleSubmitted(widgetBubbleId);
            }
          })
          .catch((error: unknown) => {
            logger.error('[HubChatView] Widget 交互 Planning 模式执行失败:', error);
          });
      } else {
        sendHubMessage(action.actionText, {
          mentionedAgent: {
            id: targetAgent.id,
            name: targetAgent.name,
            mbRulesFilePath: targetAgent.mbRulesFilePath ?? undefined,
            saRulesFilePath: targetAgent.saRulesFilePath ?? undefined,
            chatRules: targetAgent.chatRules ?? undefined,
            modelProvider: targetAgent.modelProvider ?? undefined,
            modelName: targetAgent.modelName ?? undefined,
            reasoningPreset: targetAgent.reasoningPreset ?? undefined,
          },
          userMessageMeta: widgetMeta,
        })
          .then(() => {
            // sendMessage 成功（用户消息已持久化到 SQLite）后才标记气泡已提交
            // 避免 localStorage 先写、SQLite 后写的竞争条件
            if (widgetBubbleId) {
              useWidgetStore.getState().markBubbleSubmitted(widgetBubbleId);
            }
          })
          .catch((error: unknown) => {
            logger.error('[HubChatView] Widget 交互发送失败:', error);
          });
      }
    });
    return unsubscribe;
    // 注意：isSending 和 isStreaming 已移出依赖数组，通过 ref 在订阅回调内即时读取，
    // 避免这两个高频变化的状态导致订阅反复销毁重建，引发 pendingAction 竞争条件
  }, [currentHubId, agents, mode, sendHubMessage, executePlanningTask]);

  // ========== Widget 重选撤回 ==========
  // 监听 widgetStore 的 pendingUndo，用户点击「重新选择」时，
  // 删除最近一组 widget 交互消息（widget source user 消息 + 对应 assistant 回复）
  useEffect(() => {
    const unsubscribe = useWidgetStore.subscribe((state) => {
      const undo = state.pendingUndo;
      if (undo?.contextId !== currentHubId) return;
      useWidgetStore.getState().consumeUndo();

      const allMessages = useChatStore.getState().messagesByHub.get(currentHubId) ?? [];
      const undoPlan = buildWidgetUndoRetractionPlan(allMessages, {
        widgetBubbleId: undo.widgetBubbleId,
      });
      if (undoPlan) {
        useChatStore.getState().setHubMessages(currentHubId, undoPlan.retainedMessages);

        destroyAgentService(currentHubId);

        for (const [agentId, group] of undoPlan.agentGroups.entries()) {
          const memoryService = getCachedMemoryService(agentId);
          for (const id of group.messageIds) {
            memoryService?.removeMessageFromBuffer(id);
          }
        }

        void Promise.allSettled(
          Array.from(undoPlan.agentGroups.entries()).map(([agentId, { firstId }]) =>
            invoke('message_retract_from', { id: firstId, agentId })
          )
        )
          .then(async (results) => {
            const failed = results.filter(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            );
            if (failed.length > 0) {
              logger.error(
                '[HubChatView] Widget retract failed:',
                failed.map((result) => String(result.reason))
              );
              await refreshHubMessagesFromDb(currentHubId, allMessages.length);
            }
          })
          .catch((error: unknown) => {
            logger.error('[HubChatView] Widget retract result handling failed:', error);
          });

        logger.debug(
          '[HubChatView] Widget 重选截断撤回完成，撤回消息:',
          undoPlan.messagesToRetract.length
        );
        return;
      }

      if (undo.widgetBubbleId) {
        logger.warn(
          '[HubChatView] Widget 重选未找到匹配的气泡消息，跳过撤回:',
          undo.widgetBubbleId
        );
        return;
      }

      const idsToDelete: string[] = [];

      // 从后往前找最近的 widget source user 消息
      let widgetUserMsg: (typeof allMessages)[0] | undefined;
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const msg = allMessages[i];
        if (!msg) continue;
        const meta = msg.metadata as Record<string, unknown> | undefined;
        if (msg.role === 'user' && meta?.source === 'widget') {
          widgetUserMsg = msg;
          break;
        }
      }

      if (widgetUserMsg) {
        idsToDelete.push(widgetUserMsg.id);

        // 使用 createdAt 时间戳而非数组下标找「紧随其后的」assistant 消息，
        // 避免 allMessages[i+1] 在非严格升序排列时误删原始 agent 消息
        const widgetCreatedAt = widgetUserMsg.createdAt;
        let nearestFollowUpAssistant: (typeof allMessages)[0] | undefined;
        for (const msg of allMessages) {
          if (msg.role === 'assistant' && msg.createdAt > widgetCreatedAt) {
            if (!nearestFollowUpAssistant || msg.createdAt < nearestFollowUpAssistant.createdAt) {
              nearestFollowUpAssistant = msg;
            }
          }
        }
        if (nearestFollowUpAssistant) {
          idsToDelete.push(nearestFollowUpAssistant.id);
        }
      }

      if (idsToDelete.length > 0) {
        const filtered = allMessages.filter((m) => !idsToDelete.includes(m.id));
        useChatStore.getState().setHubMessages(currentHubId, filtered);

        void Promise.allSettled(idsToDelete.map((id) => invoke('message_delete', { id })))
          .then(async (results) => {
            const failed = results.filter(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            );
            if (failed.length > 0) {
              logger.error(
                '[HubChatView] Widget delete failed:',
                failed.map((result) => String(result.reason))
              );
              await refreshHubMessagesFromDb(currentHubId, allMessages.length);
            }
          })
          .catch((error: unknown) => {
            logger.error('[HubChatView] Widget delete result handling failed:', error);
          });

        // 后端持久化删除
        logger.debug('[HubChatView] Widget 重选撤回完成, 删除消息:', idsToDelete.length);
      }
    });
    return unsubscribe;
  }, [currentHubId]);

  // 发送消息并处理 @提及
  const handleSend = useCallback(
    async (content: string) => {
      if (!currentHubId || isSending) return;

      // 解析 @提及
      const mentions = parseMentions(content);

      // 通用消息创建辅助函数（用于无 @提及或找不到 Agent 的情况）
      const createUserMessageOnly = async () => {
        // Hub 消息统一带上 sourceType 和 hubId metadata，与有 @提及情况保持一致
        // 这类消息以 hubId 为 agentId， message_list_by_hub 的 UNION ALL 第一分支可直接命中
        const baseMetadata: Record<string, unknown> = {
          sourceType: 'hub',
          hubId: currentHubId,
        };
        if (pendingAttachments.length > 0) {
          baseMetadata.attachments = [...pendingAttachments];
        }
        // quotedFrom 写入 metadata，重启后从 DB 加载时能恢复引用内容展示
        if (pendingQuotes.length > 0) {
          baseMetadata.quotedFrom = serializeQuotesForMessage(pendingQuotes);
        }

        const { invoke } = await import('@tauri-apps/api/core');
        const messageResult = await invoke<{ id: string; createdAt: number }>('message_create', {
          request: {
            agentId: currentHubId,
            role: 'user',
            content,
            metadata: JSON.stringify(baseMetadata),
          },
        });

        addHubMessage(currentHubId, {
          id: messageResult.id,
          content,
          role: 'user',
          agentId: currentHubId,
          createdAt: messageResult.createdAt,
          quotedFrom:
            pendingQuotes.length > 0 ? serializeQuotesForMessage(pendingQuotes) : undefined,
          metadata: baseMetadata,
        });

        if (pendingAttachments.length > 0) {
          clearAttachments();
        }
      };

      // 如果没有 @提及，仅保存用户消息（不调用 LLM）
      if (mentions.length === 0) {
        logger.trace('[HubChatView] 未检测到 @提及，仅保存消息');
        await createUserMessageOnly();
        return;
      }

      // 找到精确匹配的 Agent（忽略大小写）
      const mentionedAgentName = mentions[0];
      const agent = agents.find((a) => a.name.toLowerCase() === mentionedAgentName?.toLowerCase());

      if (!agent) {
        // Agent 不存在：仍保存用户消息，但不调用 LLM
        toast({
          type: 'warning',
          title: t('hub.chat.agentNotFoundTitle'),
          description: t('hub.chat.agentNotFoundDescription', { name: mentionedAgentName ?? '' }),
          duration: 4000,
        });
        await createUserMessageOnly();
        return;
      }

      // 匹配到 Agent：根据 mode 选择使用 Chat 模式或 Planning 模式
      logger.debug('[HubChatView] @提及匹配到 Agent:', agent.name, '模式:', mode);

      if (mode === 'planning') {
        // Planning 模式：使用 usePlanningMode Hook
        // 与 Chat 模式保持对称，同时传入 attachments 和 quotes，发送成功后清理 UI 状态
        const attachmentsToSend = getAttachmentsCopy();
        await executePlanningTask(content, {
          mentionedAgent: {
            id: agent.id,
            name: agent.name,
            hubId: agent.hubId,
            mbRulesFilePath: agent.mbRulesFilePath ?? undefined,
            saRulesFilePath: agent.saRulesFilePath ?? undefined,
            mbRules: agent.mbRules ?? undefined,
            saRules: agent.saRules ?? undefined,
            modelProvider: agent.modelProvider ?? undefined,
            modelName: agent.modelName ?? undefined,
            reasoningPreset: agent.reasoningPreset ?? undefined,
            pinnedSkills: agent.pinnedSkills ?? undefined,
            sandboxMode: agent.sandboxMode ?? undefined,
            visualEnhancementEnabled: agent.visualEnhancementEnabled ?? undefined,
            subAgentSafetyFooterEnabled: agent.subAgentSafetyFooterEnabled ?? undefined,
            subAgentSafetyFooterText: agent.subAgentSafetyFooterText ?? undefined,
          },
          attachments: attachmentsToSend,
          onClearAttachments: clearAttachments,
          quotes: pendingQuotes,
          onClearQuotes: () => clearQuotes(currentHubId),
        });
      } else {
        // Chat 模式：使用 useChatSender Hook
        const attachmentsToSend = getAttachmentsCopy();
        await sendHubMessage(content, {
          attachments: attachmentsToSend,
          quotes: pendingQuotes,
          onClearQuotes: () => clearQuotes(currentHubId),
          onClearAttachments: clearAttachments,
          mentionedAgent: {
            id: agent.id,
            name: agent.name,
            mbRulesFilePath: agent.mbRulesFilePath ?? undefined,
            saRulesFilePath: agent.saRulesFilePath ?? undefined,
            chatRules: agent.chatRules ?? undefined,
            modelProvider: agent.modelProvider ?? undefined,
            modelName: agent.modelName ?? undefined,
            reasoningPreset: agent.reasoningPreset ?? undefined,
          },
        });
      }
    },
    [
      currentHubId,
      isSending,
      agents,
      mode,
      pendingQuotes,
      pendingAttachments,
      addHubMessage,
      clearQuotes,
      toast,
      getAttachmentsCopy,
      clearAttachments,
      sendHubMessage,
      executePlanningTask,
      t,
    ]
  );

  // 模式切换
  const handleModeChange = useCallback(
    (newMode: ChatMode) => {
      if (currentHubId) {
        setModeFor(currentHubId, newMode);
      }
    },
    [currentHubId, setModeFor]
  );

  // 移除当前 Hub 的引用
  const handleRemoveQuote = useCallback(
    (messageId: string) => {
      if (currentHubId) {
        removeQuote(currentHubId, messageId);
      }
    },
    [currentHubId, removeQuote]
  );

  // 搜索切换
  const handleToggleSearch = useCallback(() => {
    if (!currentHubId) return;
    if (isSearchOpen) {
      closeSearch(currentHubId);
    } else {
      openSearch(currentHubId);
    }
  }, [currentHubId, isSearchOpen, openSearch, closeSearch]);

  const handleCloseSearch = useCallback(() => {
    if (currentHubId) closeSearch(currentHubId);
  }, [currentHubId, closeSearch]);

  // 多选消息切换
  const handleToggleMessageSelect = useCallback(
    (messageId: string) => {
      if (currentHubId) toggleMessageSelect(currentHubId, messageId);
    },
    [currentHubId, toggleMessageSelect]
  );

  // 搜索结果跳转：滚动到目标消息 + 高亮闪烁
  const handleJumpToMessage = useCallback((messageId: string) => {
    const targetEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('highlight-flash');
      setTimeout(() => targetEl.classList.remove('highlight-flash'), 2000);
    }
  }, []);

  // 多选批量删除确认弹窗状态
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState<{
    isOpen: boolean;
    count: number;
    onConfirm: (() => void) | null;
  }>({ isOpen: false, count: 0, onConfirm: null });

  // 多选批量操作
  const handleMultiSelectAction = useCallback(
    (action: 'copy' | 'quote' | 'delete' | 'cancel') => {
      if (!currentHubId) return;
      switch (action) {
        case 'copy': {
          const selectedMsgs = hubMessages.filter((m) => selectedMessageIds.has(m.id));
          const text = selectedMsgs
            .map(
              (m) =>
                `${m.role === 'user' ? t('chat.userLabel') : (m.metadata?.agentName ?? 'Hub')}: ${m.content}`
            )
            .join('\n\n');
          navigator.clipboard.writeText(text).catch((err: unknown) => {
            logger.error('[HubChatView] 复制失败:', err);
          });
          exitMultiSelect(currentHubId);
          break;
        }
        case 'quote': {
          const selectedMsgs = hubMessages.filter((m) => selectedMessageIds.has(m.id));
          const { addQuote } = useChatStore.getState();
          for (const msg of selectedMsgs) {
            const quoteContent = getMessageQuoteContent(msg);
            addQuote(currentHubId, {
              messageId: msg.id,
              content: quoteContent,
              hubId: currentHubId,
              agentName:
                msg.role === 'user' ? t('chat.userLabel') : (msg.metadata?.agentName ?? 'Hub'),
            });
          }
          exitMultiSelect(currentHubId);
          break;
        }
        case 'delete': {
          // 批量删除：弹出确认弹窗
          const count = selectedMessageIds.size;
          setBatchDeleteConfirm({
            isOpen: true,
            count,
            onConfirm: () => {
              for (const msgId of selectedMessageIds) {
                void handleMessageAction(msgId, 'delete', { skipConfirm: true });
              }
              exitMultiSelect(currentHubId);
              setBatchDeleteConfirm({ isOpen: false, count: 0, onConfirm: null });
            },
          });
          break;
        }
        case 'cancel': {
          exitMultiSelect(currentHubId);
          break;
        }
      }
    },
    [currentHubId, hubMessages, selectedMessageIds, exitMultiSelect, handleMessageAction, t]
  );

  // 加载更早的 Hub 历史消息（游标式分页）
  const handleLoadMore = useCallback(async () => {
    if (!currentHubId || isLoadingMore) return;
    const currentMessages = useChatStore.getState().messagesByHub.get(currentHubId) ?? [];
    if (currentMessages.length === 0) return;

    const oldestMessage = currentMessages[0];
    if (!oldestMessage) return;

    setIsLoadingMore(true);
    try {
      const LOAD_MORE_COUNT = 100;
      const olderMessagesFromDb = await invoke<
        Array<{
          id: string;
          agentId: string;
          role: string;
          content: string;
          metadata: string | null;
          createdAt: number;
        }>
      >('message_get_before_hub', {
        hubId: currentHubId,
        beforeMessageId: oldestMessage.id,
        count: LOAD_MORE_COUNT,
      });

      const olderMessages: Message[] = olderMessagesFromDb.map((m) => {
        let parsedMetadata: Message['metadata'] = undefined;
        if (m.metadata) {
          try {
            parsedMetadata = JSON.parse(m.metadata) as unknown as Message['metadata'];
          } catch (e) {
            logger.warn('[HubChatView] 解析 metadata 失败:', e);
          }
        }
        return {
          id: m.id,
          agentId: m.agentId,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          createdAt: m.createdAt,
          metadata: parsedMetadata,
        };
      });

      const widgetSubmissions = collectWidgetBubbleSubmissions(olderMessages);
      if (widgetSubmissions.length > 0) {
        const { restoreBubbleSubmittedState } = useWidgetStore.getState();
        for (const submission of widgetSubmissions) {
          restoreBubbleSubmittedState(
            submission.bubbleId,
            submission.selections,
            submission.extraText
          );
        }
      }

      useChatStore.getState().prependHubMessages(currentHubId, olderMessages);

      if (olderMessagesFromDb.length < LOAD_MORE_COUNT) {
        useChatStore.getState().setHubHasMore(currentHubId, false);
      }

      logger.trace('[HubChatView] 加载更多 Hub 历史消息', {
        loaded: olderMessages.length,
        hasMore: olderMessagesFromDb.length >= LOAD_MORE_COUNT,
      });
    } catch (error) {
      logger.error('[HubChatView] 加载更多 Hub 历史消息失败:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [currentHubId, isLoadingMore]);

  // Ctrl+F 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (currentHubId) openSearch(currentHubId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentHubId, openSearch]);

  // 消息操作方法已由 useMessageActions Hook 提供：
  // - handleMessageAction

  // 附件管理方法已由 useAttachmentManager Hook 提供：
  // - handleAttachmentAdd
  // - handleAttachmentRemove
  // - handleAttachmentReorder

  if (!currentHub) {
    return (
      <div className={styles.chatView}>
        {setupChecklistState.shouldRender ? (
          <div className={styles.setupArea}>
            <SetupChecklist state={setupChecklistState} />
          </div>
        ) : (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <svg
                width="64"
                height="64"
                viewBox="0 0 64 64"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="8" y="12" width="48" height="40" rx="4" />
                <path d="M8 24h48" />
                <circle cx="16" cy="18" r="2" />
                <circle cx="24" cy="18" r="2" />
                <circle cx="32" cy="18" r="2" />
              </svg>
            </div>
            <p className={styles.emptyText}>{t('hub.chat.selectHub')}</p>
          </div>
        )}
      </div>
    );
  }

  const showSetupChecklist =
    setupChecklistState.shouldRender && hubMessages.length === 0 && !isStreaming;

  return (
    <>
      <div className={styles.chatView}>
        {/* 标题区 */}
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <div className={styles.icon}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M4 4h12v10H6l-2 2V4z" />
              </svg>
            </div>
            <h1 className={styles.title}>
              {t('hub.chat.discussionTitle', { name: currentHub.name })}
            </h1>
          </div>
          <Tooltip content={t('agent.chat.searchTitle')}>
            <button
              className={styles.searchBtn}
              onClick={handleToggleSearch}
              aria-label={t('chat.searchAria')}
            >
              <Search size={18} />
            </button>
          </Tooltip>
        </div>

        {/* 搜索栏 - 直接紧贴 header 底部渲染 */}
        {isSearchOpen && currentHubId && (
          <ChatSearchBar
            contextId={currentHubId}
            messages={hubMessages}
            onJumpToMessage={handleJumpToMessage}
            onClose={handleCloseSearch}
          />
        )}

        {/* 对话历史 - 使用 ChatHistory 的内置流式消息渲染 */}
        {showSetupChecklist ? (
          <div className={styles.setupArea}>
            <SetupChecklist state={setupChecklistState} />
          </div>
        ) : (
          <ChatHistory
            messages={hubMessages}
            agentName={streamingAgentName}
            isStreaming={isStreaming}
            streamingContent={streamingContent}
            streamingReasoningContent={streamingReasoningContent}
            mode={mode}
            contextId={currentHubId ?? undefined}
            emptyText={t('hub.chat.startDiscussion')}
            emptyHint={t('hub.chat.emptyHint')}
            onMessageAction={handleMessageAction}
            multiSelectActive={isMultiSelectActive}
            selectedMessageIds={selectedMessageIds}
            onToggleMessageSelect={handleToggleMessageSelect}
            onMultiSelectAction={handleMultiSelectAction}
            hasMore={hubHasMore}
            onLoadMore={handleLoadMore}
            isLoadingMore={isLoadingMore}
          />
        )}

        {/* 输入区 */}
        <ChatInput
          placeholder={t('hub.chat.inputPlaceholder')}
          disabled={isStreaming || isSending || isAddingAttachment}
          mode={mode}
          pendingQuotes={pendingQuotes}
          enableMention={true}
          enableAttachment={true}
          attachments={pendingAttachments}
          draftKey={currentHubId ? `hub:${currentHubId}` : undefined}
          restoreDraft={restoreDraft}
          isStreaming={isStreaming}
          onStop={handleStopStreaming}
          onSend={handleSend}
          onModeChange={handleModeChange}
          onRemoveQuote={handleRemoveQuote}
          onAttachmentAdd={handleAttachmentAdd}
          onAttachmentRemove={handleAttachmentRemove}
          onAttachmentReorder={handleAttachmentReorder}
        />
      </div>

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={deleteDialogState.isOpen}
        onClose={closeDeleteDialog}
        onConfirm={deleteDialogState.onConfirm ?? (() => Promise.resolve())}
        title={deleteDialogState.title}
        description={deleteDialogState.description}
        confirmText={deleteDialogState.confirmText}
        variant={deleteDialogState.variant}
      />

      {/* 撤回确认弹窗 */}
      <ConfirmDialog
        open={revokeConfirmDialogState.isOpen}
        onClose={closeRevokeConfirmDialog}
        onConfirm={revokeConfirmDialogState.onConfirm ?? (() => Promise.resolve())}
        title={revokeConfirmDialogState.title}
        description={revokeConfirmDialogState.description}
        confirmText={revokeConfirmDialogState.confirmText}
        variant={revokeConfirmDialogState.variant}
      />

      {/* 多选批量删除确认弹窗 */}
      <ConfirmDialog
        open={batchDeleteConfirm.isOpen}
        onClose={() => setBatchDeleteConfirm({ isOpen: false, count: 0, onConfirm: null })}
        onConfirm={batchDeleteConfirm.onConfirm ?? (() => Promise.resolve())}
        title={t('hub.chat.batchDeleteTitle')}
        description={t('hub.chat.batchDeleteDescription', { count: batchDeleteConfirm.count })}
        confirmText={t('common.confirmDelete')}
        variant="danger"
      />
    </>
  );
}
