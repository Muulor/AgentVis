import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLLMAdapter } from '@services/memory/LLMAdapter';
import { Search, UserRoundCog } from 'lucide-react';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useChatStore } from '@stores/chatStore';
import { useWidgetStore } from '@stores/widgetStore';
import { destroyAgentService } from '@services/planning/AgentService';
import { getCachedMemoryService } from '@services/memory/MemoryService';

import { useAttachmentManager } from '@/hooks/useAttachmentManager';
import { useMessageActions } from '@/hooks/useMessageActions';
import { useChatSender } from '@/hooks/useChatSender';
import { usePlanningMode } from '@/hooks/usePlanningMode';
import {
  ChatHistory,
  ChatInput,
  ChatSearchBar,
  type ChatInputRestoreDraft,
  type ChatInputSendOptions,
} from '@components/chat';
import type { InputDisplayPart, InputContextToken } from '@components/chat/inputContextTokens';
import { buildWidgetUndoRetractionPlan } from '@components/widgets/widgetUndo';
import { collectWidgetBubbleSubmissions } from '@stores/widgetSubmissionRecovery';
import { shouldStartImTask } from '@services/im-channel/ImTaskBridge';

import { AgentSettingsModal } from './AgentSettingsModal';
import { AgentModelSelector } from './AgentModelSelector';
import { Tooltip } from '@components/ui/Tooltip';
import { FileRevertDialog } from '@components/ui';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { useToast } from '@components/ui/Toast';
import { useI18n } from '@/i18n';
import type { ChatMode } from '@/types/chatMode';
import { normalizeChatMode } from '@/types/chatMode';
import type { UIMessage } from '@/types/message';
import type { Message } from '@/types';
import styles from './AgentChatView.module.css';
import { getLogger } from '@services/logger';
import { getMessageQuoteContent } from '@utils/quoteContent';
import { refreshAgentMessagesFromDb } from '@utils/messageReload';

const logger = getLogger('AgentChatView');

/**
 * 清理文件夹名称（移除不安全字符，与 FileList 保持一致）
 */
function sanitizeFolderName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unnamed'
  );
}

/**
 * 将 Message 转换为 UIMessage
 */
function toUIMessage(msg: Message): UIMessage {
  return {
    ...msg,
    status: 'completed',
  };
}

function isInputContextToken(value: unknown): value is InputContextToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Partial<InputContextToken>;
  return (
    typeof token.id === 'string' &&
    typeof token.label === 'string' &&
    (token.type === 'skill' || token.type === 'file' || token.type === 'folder')
  );
}

function isInputDisplayPartArray(value: unknown): value is InputDisplayPart[] {
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!part || typeof part !== 'object') return false;
    const candidate = part as Partial<InputDisplayPart>;
    if (candidate.type === 'text') {
      return typeof candidate.text === 'string';
    }
    if (candidate.type === 'token') {
      return isInputContextToken(candidate.token);
    }
    return false;
  });
}

function buildDisplayContentFromParts(parts: InputDisplayPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : part.token.label)).join('');
}

function buildRevokeRestoreDraft(message: UIMessage): ChatInputRestoreDraft {
  const displayParts = isInputDisplayPartArray(message.metadata?.displayParts)
    ? message.metadata.displayParts
    : undefined;
  const metadataDisplayContent = message.metadata?.displayContent;
  const value =
    typeof metadataDisplayContent === 'string'
      ? metadataDisplayContent
      : displayParts
        ? buildDisplayContentFromParts(displayParts)
        : message.content;

  return {
    id: `revoke:${message.id}:${Date.now()}`,
    value,
    displayParts,
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
 * AgentChatView 组件
 *
 * Agent对话视图，支持：
 * - 标题区显示模型选择器、搜索与设置入口
 * - 对话历史区（使用 ChatHistory 组件）
 * - 输入区（使用 ChatInput 组件）
 * - 模式选择器（Task/Chat）
 */
export function AgentChatView() {
  const { t } = useI18n();
  const { toast } = useToast();
  const currentAgentId = useAgentStore((state) => state.currentAgentId);
  const agents = useAgentStore((state) => state.agents);
  const updateAgent = useAgentStore((state) => state.updateAgent);

  // 从 chatStore 获取消息（按 Agent 分组）
  const messagesByAgent = useChatStore((state) => state.messagesByAgent);
  // 流式状态（按 contextId 隔离）
  const streamingByContext = useChatStore((state) => state.streamingByContext);
  // 模式状态（按 contextId 隔离）
  const modeByContext = useChatStore((state) => state.modeByContext);
  const mode = normalizeChatMode(currentAgentId ? modeByContext.get(currentAgentId) : undefined);
  const setModeFor = useChatStore((state) => state.setModeFor);
  // 统一引用存储（按 Hub ID 分组）
  const pendingQuotesByHub = useChatStore((state) => state.pendingQuotesByHub);
  const removeQuote = useChatStore((state) => state.removeQuote);
  const clearQuotes = useChatStore((state) => state.clearQuotes);
  // 发送状态（按 contextId 隔离）
  const sendingContexts = useChatStore((state) => state.sendingContexts);
  const isSending = currentAgentId ? sendingContexts.has(currentAgentId) : false;
  const stopStreaming = useChatStore((state) => state.stopStreaming);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [restoreDraft, setRestoreDraft] = useState<ChatInputRestoreDraft | null>(null);

  // ========== 搜索状态 ==========
  const searchByContext = useChatStore((state) => state.searchByContext);
  const isSearchOpen = currentAgentId
    ? (searchByContext.get(currentAgentId)?.isOpen ?? false)
    : false;
  const openSearch = useChatStore((state) => state.openSearch);
  const closeSearch = useChatStore((state) => state.closeSearch);

  // ========== 多选状态 ==========
  const multiSelectByContext = useChatStore((state) => state.multiSelectByContext);
  const multiSelectState = currentAgentId ? multiSelectByContext.get(currentAgentId) : undefined;
  const isMultiSelectActive = multiSelectState?.isActive ?? false;
  const selectedMessageIds = useMemo(
    () => multiSelectState?.selectedIds ?? new Set<string>(),
    [multiSelectState?.selectedIds]
  );
  const toggleMessageSelect = useChatStore((state) => state.toggleMessageSelect);
  const exitMultiSelect = useChatStore((state) => state.exitMultiSelect);

  // ========== 消息分页（加载更多）==========
  const hasMoreByAgent = useChatStore((state) => state.hasMoreByAgent);
  const hasMore = currentAgentId ? (hasMoreByAgent.get(currentAgentId) ?? false) : false;
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // 使用统一的附件管理 Hook（Agent 模式需要 RAG 索引）
  const {
    pendingAttachments,
    isAddingAttachment,
    addAttachments: handleAttachmentAdd,
    removeAttachment: handleAttachmentRemove,
    reorderAttachments: handleAttachmentReorder,
    restoreAttachments,
    clearAttachments,
    getAttachmentsCopy,
  } = useAttachmentManager(currentAgentId);

  // Agent 切换或组件卸载时触发 onSessionEnd
  useEffect(() => {
    // 辅助函数：获取或创建 MemoryService 实例
    // 使用 getOrCreateMemoryService 确保同一 agentId 共享实例，互斥锁生效
    const getMemoryService = async (agentId: string) => {
      const { getOrCreateMemoryService } = await import('@services/memory');
      // dynamic 模式：LLMAdapter 在每次 generate 调用时从 settingsStore 实时解析
      // provider/model，UI 切换设置后无需重建实例即可生效
      const llmService = createLLMAdapter({
        dynamic: true,
      });
      // getOrCreateMemoryService 内部有缓存：如果已存在则忽略 llmService 直接返回缓存实例
      return getOrCreateMemoryService(agentId, llmService);
    };

    // 记录本次 effect 绑定的 agentId，供 cleanup 使用
    const boundAgentId = currentAgentId;

    // 对新 Agent 执行水位线恢复检查：处理之前 LLM 失败导致的堆积 short_term 记录
    // 以及补索引 Embedding API 故障期间未索引的摘要
    if (boundAgentId) {
      // 标记该 Agent 消息已读（清除 NavItem 上的未读蓝点）
      useChatStore.getState().markAsRead(boundAgentId);

      void (async () => {
        try {
          const service = await getMemoryService(boundAgentId);
          await service.checkWatermarkOnResume();
          logger.trace('[AgentChatView] 水位线恢复检查完成, agentId:', boundAgentId);
        } catch (error) {
          logger.warn('[AgentChatView] 水位线恢复检查失败:', error);
        }
      })();
    }

    // cleanup：当 currentAgentId 变化或组件卸载时，
    // 对本次 effect 绑定的 Agent 触发 onSessionEnd（只执行一次）
    return () => {
      if (boundAgentId) {
        void (async () => {
          try {
            const memoryService = await getMemoryService(boundAgentId);
            await memoryService.onSessionEnd();
            logger.trace(
              '[AgentChatView]  生命周期事件: onSessionEnd 已触发, agentId:',
              boundAgentId
            );
          } catch (error) {
            logger.warn('[AgentChatView] 生命周期触发失败:', error);
          }
        })();
      }
    };
  }, [currentAgentId]);

  // Agent 视图激活时，注册 token 追踪上下文 ID
  // StatusBar 通过 activeTokenContextId 确定读取哪个 Agent 的 token 数据
  useEffect(() => {
    if (currentAgentId) {
      void import('@stores/statusStore')
        .then(({ useStatusStore }) => {
          useStatusStore.getState().setActiveTokenContextId(currentAgentId);
        })
        .catch((error: unknown) => {
          logger.warn('[AgentChatView] 设置 active token context 失败:', error);
        });
    }
  }, [currentAgentId]);

  // 监听消息跳转事件（从记忆面板发起）
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ messageId: string; agentId: string }>(
          'chat:jump_to_message',
          (event) => {
            const { messageId, agentId } = event.payload;
            logger.trace('[AgentChatView] 收到跳转事件:', { messageId, agentId });

            // 只处理当前 Agent 的跳转请求
            if (agentId !== currentAgentId) {
              logger.trace('[AgentChatView] 跳转请求 Agent 不匹配，忽略');
              return;
            }

            // 1. 关闭设置弹窗
            setIsSettingsOpen(false);

            // 2. 延迟 300ms 后滚动到目标消息（等待弹窗关闭动画完成）
            setTimeout(() => {
              const targetElement = document.querySelector(`[data-message-id="${messageId}"]`);
              if (targetElement) {
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // 添加高亮效果
                targetElement.classList.add('highlight-flash');
                setTimeout(() => targetElement.classList.remove('highlight-flash'), 2000);
                logger.trace('[AgentChatView]  已跳转到消息:', messageId);
              } else {
                logger.warn('[AgentChatView] 未找到目标消息元素:', messageId);
              }
            }, 300);
          }
        );
      } catch (error) {
        logger.error('[AgentChatView] 设置跳转监听器失败:', error);
      }
    };

    void setupListener();

    return () => {
      unlisten?.();
    };
  }, [currentAgentId]);

  //  已移除 pendingFileEdit 状态，改用右栏 diffStore 管理

  // 文件回滚确认弹窗状态（由 useMessageActions Hook 管理）

  // 获取当前Agent
  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const currentHub = useHubStore((state) => state.hubs).find((h) => h.id === currentAgent?.hubId);

  // 获取当前 Agent 的消息列表
  const agentMessages = useMemo<UIMessage[]>(() => {
    if (!currentAgentId) return [];
    const messages = messagesByAgent.get(currentAgentId) ?? [];
    // 过滤掉定时任务和 Widget 交互触发的 user 消息，避免干扰对话视图
    // Widget 交互的选项 + 补充文字根据病验用内联展示在气泡底部的 BubbleReplyBar已提交态中，不需要在聊天流中再单独展示一条用户消息气泡
    return messages
      .filter((m) => {
        if (m.role === 'user' && m.metadata) {
          const meta = m.metadata as Record<string, unknown>;
          // 隐藏定时任务触发的用户消息
          if (meta.source === 'cron') return false;
          // 隐藏 Widget 交互触发的用户消息：选择内容和补充文字内联展示在 BubbleReplyBar 已提交态
          if (meta.source === 'widget') return false;
        }
        return true;
      })
      .map(toUIMessage);
  }, [currentAgentId, messagesByAgent]);

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
    revertDialogState,
    closeRevertDialog,
    deleteDialogState,
    closeDeleteDialog,
    revokeConfirmDialogState,
    closeRevokeConfirmDialog,
  } = useMessageActions({
    contextType: 'agent',
    contextId: currentAgentId,
    hubId: currentAgent?.hubId,
    agentName: currentAgent?.name,
    messages: agentMessages,
    onRevokeComplete: handleRevokeComplete,
  });

  // Chat 模式消息发送（由 useChatSender Hook 管理）
  const { sendMessage: sendChatMessage } = useChatSender({
    contextType: 'agent',
    contextId: currentAgentId,
    agentConfig: currentAgent
      ? {
          name: currentAgent.name,
          hubId: currentAgent.hubId,
          mbRulesFilePath: currentAgent.mbRulesFilePath ?? undefined,
          saRulesFilePath: currentAgent.saRulesFilePath ?? undefined,
          chatRules: currentAgent.chatRules ?? undefined,
          modelProvider: currentAgent.modelProvider ?? undefined,
          modelName: currentAgent.modelName ?? undefined,
        }
      : undefined,
    enableMemory: true,
    enableRag: true,
  });

  // Task 模式消息发送（由 usePlanningMode Hook 管理）
  const { executePlanningTask, stopPlanningTask } = usePlanningMode({
    contextType: 'agent',
    contextId: currentAgentId,
    agentConfig: currentAgent
      ? {
          name: currentAgent.name,
          hubId: currentAgent.hubId,
          mbRulesFilePath: currentAgent.mbRulesFilePath ?? undefined,
          saRulesFilePath: currentAgent.saRulesFilePath ?? undefined,
          mbRules: currentAgent.mbRules ?? undefined,
          saRules: currentAgent.saRules ?? undefined,
          modelProvider: currentAgent.modelProvider ?? undefined,
          modelName: currentAgent.modelName ?? undefined,
          pinnedSkills: currentAgent.pinnedSkills ?? undefined,
          sandboxMode: currentAgent.sandboxMode ?? undefined,
          visualEnhancementEnabled: currentAgent.visualEnhancementEnabled ?? undefined,
          subAgentSafetyFooterEnabled: currentAgent.subAgentSafetyFooterEnabled ?? undefined,
          subAgentSafetyFooterText: currentAgent.subAgentSafetyFooterText ?? undefined,
        }
      : undefined,
  });

  const handleStopStreaming = useCallback(() => {
    if (!currentAgentId) return;

    stopStreaming(currentAgentId);
    toast({
      type: 'info',
      title: t('chat.toastStreamCancelRequestedTitle'),
      description: t('chat.toastStreamCancelRequestedDescription'),
      duration: 3000,
    });

    // Task 模式额外取消 AgentLoop
    if (mode === 'planning') {
      stopPlanningTask();
    }
  }, [currentAgentId, mode, stopPlanningTask, stopStreaming, t, toast]);

  // 使用 ref 持有 executePlanningTask 最新引用，
  // 避免 cron:execute_planning 监听器 useEffect 因函数重建而频繁注销/重注册，
  // 消除模型切换时监听器竞态导致的潜在重复执行
  const executePlanningTaskRef = useRef(executePlanningTask);
  executePlanningTaskRef.current = executePlanningTask;

  // 使用 ref 持有最新的 currentAgentId
  // 关键：cron:execute_planning listener 是异步注册的（await listen(...)），
  // closure 里的 currentAgentId 可能是旧快照，使用 ref 可保证事件到达时能读到最新的分配结果
  const currentAgentIdRef = useRef(currentAgentId);
  currentAgentIdRef.current = currentAgentId;

  // 监听定时任务/IM Planning 模式执行事件
  // 当 CronExecutor 或 ImTaskBridge 以 planning 模式触发时，通过此事件让 AgentChatView 接手执行 Agent Loop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // 防止 React StrictMode 下异步 listen 完成前 cleanup 已执行导致泄漏
    let aborted = false;

    const setupCronPlanningListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistenFn = await listen<{
          agentId: string;
          prompt: string;
          cronJobId: string;
          cronJobName: string;
          source?: 'cron' | 'im';
          imTaskId?: string;
          imPlatform?: 'feishu' | 'slack' | 'dingtalk' | 'telegram';
          /** 多 Bot 架构：当前执行关联的机器人 ID，供工具定位当前 Bot 配置 */
          botId?: string;
        }>('cron:execute_planning', (event) => {
          const { agentId, prompt, cronJobId, cronJobName, source, imTaskId, imPlatform, botId } =
            event.payload;

          if (agentId !== currentAgentIdRef.current) {
            logger.trace('[AgentChatView] cron:execute_planning 目标 Agent 不匹配，忽略');
            return;
          }

          logger.info(
            `[AgentChatView] 收到${source === 'im' ? ' IM' : '定时任务'} Planning 触发: ${cronJobName}`
          );

          if (source === 'im' && !shouldStartImTask(botId, imTaskId)) {
            logger.trace('[AgentChatView] IM 任务已取消或结束，跳过 Planning 启动', {
              botId,
              imTaskId,
            });
            return;
          }

          // 构建提示词：IM 消息为 Agent/DB 保留来源前缀，UI 渲染层会剥离此前缀
          const imPromptPrefixKey =
            imPlatform === 'slack'
              ? 'im.bridge.userPromptPrefixSlack'
              : imPlatform === 'feishu'
                ? 'im.bridge.userPromptPrefixFeishu'
                : 'im.bridge.userPromptPrefix';
          const taskPrompt =
            source === 'im'
              ? `${t(imPromptPrefixKey)}\n${prompt}`
              : `[This is a Cron-triggered message from a scheduled task named ✉${cronJobName}✉ in your conversation with the user]\n\`\`\`\n${prompt}\n\`\`\``;

          // 调用 executePlanningTask 启动 Agent Loop
          // 传入来源标识，用于 UI 隐藏和历史上下文排除
          // botId 注入到 extraContext，供 IM/cron 触发的工具精确定位当前 Bot
          executePlanningTaskRef
            .current(taskPrompt, {
              userMessageMeta: {
                source: source ?? 'cron',
                cronJobId,
                cronJobName,
              },
              // IM 或绑定了飞书 Bot 的 cron 触发时注入额外上下文
              ...(botId ? { extraContext: { imBotId: botId, imTaskId } } : {}),
            })
            .catch((error: unknown) => {
              logger.error('[AgentChatView] Planning 执行失败:', error);
            });
        });

        // 异步注册完成后检查：如果 cleanup 已执行，立即注销
        if (aborted) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      } catch (error) {
        logger.error('[AgentChatView] 设置 cron:execute_planning 监听器失败:', error);
      }
    };

    void setupCronPlanningListener();

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [currentAgentId, t]);

  // 监听 IM 终止任务事件（用户在飞书卡片上点击“终止任务”按钮）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;

    const setupAbortListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistenFn = await listen<{ taskId: string }>('im:abort_task', () => {
          // 知道是 IM 终止请求，调用 stopPlanningTask 取消当前 AgentLoop
          logger.info('[AgentChatView] 收到 IM 终止任务请求');
          stopPlanningTask();
        });

        if (aborted) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      } catch (error) {
        logger.error('[AgentChatView] 设置 im:abort_task 监听器失败:', error);
      }
    };

    void setupAbortListener();

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [stopPlanningTask]);

  // 获取当前 Agent 的流式状态（隔离存储）
  const currentStreamingState = useMemo(() => {
    if (!currentAgentId) return { content: '', isStreaming: false };
    return streamingByContext.get(currentAgentId) ?? { content: '', isStreaming: false };
  }, [currentAgentId, streamingByContext]);
  const isStreaming = currentStreamingState.isStreaming;
  const streamingContent = currentStreamingState.content;
  const streamingReasoningContent = currentStreamingState.reasoningContent ?? '';

  // streaming 结束时自动标记已读：防止用户停留小窗口期间 agent 跑完任务后切走误报未读
  // 注意：此处必须在 isStreaming 声明之后，避免依赖数组求值时触发 TDZ ReferenceError
  const prevIsStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    // 仅在 streaming 从 true 变为 false 时计为已读（任务完成瞬间）
    if (wasStreaming && !isStreaming && currentAgentId) {
      useChatStore.getState().markAsRead(currentAgentId);
    }
  }, [isStreaming, currentAgentId]);

  // ========== Widget 交互闭环 ==========
  // 监听 widgetStore 的 pendingAction，用户在 Widget 中的交互（如点击选项卡片）
  // 会通过 widgetStore.dispatchWidgetAction 派发事件，此处消费事件并根据当前模式路由处理
  //
  // 使用 ref 持有 isSending/isStreaming 最新值，避免 subscriber 因这两个状态变化而频繁重建，
  // 消除 pendingAction 在 effect 重建窗口期被新订阅拦截但条件不满足而永久丢弃的竞争条件。
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    const unsubscribe = useWidgetStore.subscribe((state) => {
      const action = state.pendingAction;
      // 通过 ref 读取最新的 isSending/isStreaming，避免闭包过期导致竞争条件
      if (
        action?.contextId === currentAgentId &&
        !isSendingRef.current &&
        !isStreamingRef.current
      ) {
        // 立即消费事件（防止重复触发）
        useWidgetStore.getState().consumeAction();

        // 提取气泡 ID，用于 sendMessage 成功后调用 markBubbleSubmitted
        const { widgetBubbleId } = action;

        // 根据当前模式路由：Planning 模式走 AgentLoop，Chat 模式走流式对话
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
        if (mode === 'planning') {
          executePlanningTask(action.actionText, {
            userMessageMeta: widgetMeta,
          })
            .then(() => {
              // Planning 执行完成后，标记气泡已提交（此时消息已写入 SQLite）
              if (widgetBubbleId) {
                useWidgetStore.getState().markBubbleSubmitted(widgetBubbleId);
              }
            })
            .catch((error: unknown) => {
              logger.error('[AgentChatView] Widget 交互 Planning 执行失败:', error);
            });
        } else {
          sendChatMessage(action.actionText, {
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
              logger.error('[AgentChatView] Widget 交互发送失败:', error);
            });
        }
      }
    });
    return unsubscribe;
  }, [currentAgentId, mode, sendChatMessage, executePlanningTask]);

  // ========== Widget 重选撤回 ==========
  // 监听 widgetStore 的 pendingUndo，用户点击「重新选择」时触发
  // 此处删除最近一组 widget 交互消息（widget source user 消息 + 对应 assistant 回复）
  useEffect(() => {
    const unsubscribe = useWidgetStore.subscribe((state) => {
      const undo = state.pendingUndo;
      if (undo?.contextId === currentAgentId) {
        useWidgetStore.getState().consumeUndo();

        // 从 chatStore 原始数据中查找（包括被过滤隐藏的 widget 消息）
        const allMessages = useChatStore.getState().messagesByAgent.get(currentAgentId) ?? [];
        const undoPlan = buildWidgetUndoRetractionPlan(allMessages, {
          widgetBubbleId: undo.widgetBubbleId,
        });
        if (undoPlan) {
          useChatStore.getState().setMessages(currentAgentId, undoPlan.retainedMessages);

          destroyAgentService(currentAgentId);

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
                  '[AgentChatView] Widget retract failed:',
                  failed.map((result) => String(result.reason))
                );
                await refreshAgentMessagesFromDb(currentAgentId, allMessages.length);
              }
            })
            .catch((error: unknown) => {
              logger.error('[AgentChatView] Widget retract result handling failed:', error);
            });

          logger.trace(
            '[AgentChatView] Widget 重选截断撤回完成，撤回消息:',
            undoPlan.messagesToRetract.length
          );
          return;
        }

        if (undo.widgetBubbleId) {
          logger.warn(
            '[AgentChatView] Widget 重选未找到匹配的气泡消息，跳过撤回:',
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

          // 使用 createdAt 时间戳而非数组下标找「紧随其后的」 assistant 消息，即使 Store 内部不是纯升序也能正确匹配
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
          // 更新 chatStore
          const filtered = allMessages.filter((m) => !idsToDelete.includes(m.id));
          useChatStore.getState().setMessages(currentAgentId, filtered);

          void Promise.allSettled(idsToDelete.map((id) => invoke('message_delete', { id })))
            .then(async (results) => {
              const failed = results.filter(
                (result): result is PromiseRejectedResult => result.status === 'rejected'
              );
              if (failed.length > 0) {
                logger.error(
                  '[AgentChatView] Widget delete failed:',
                  failed.map((result) => String(result.reason))
                );
                await refreshAgentMessagesFromDb(currentAgentId, allMessages.length);
              }
            })
            .catch((error: unknown) => {
              logger.error('[AgentChatView] Widget delete result handling failed:', error);
            });

          // 后端持久化删除消息

          // 同步删除关联的短期缓冲记录，避免记忆摘要重复
          invoke('memory_delete_by_source_ids', {
            agentId: currentAgentId,
            sourceMessageIds: idsToDelete,
          }).catch((error: unknown) => {
            logger.warn('[AgentChatView] Widget 撤回：删除短期缓冲记录失败:', error);
          });

          logger.trace('[AgentChatView] Widget 重选撤回完成, 删除消息:', idsToDelete.length);
        }
      }
    });
    return unsubscribe;
  }, [currentAgentId]);

  // 获取引用列表（同 Hub 下所有引用均对当前 Agent 可见）
  const pendingQuotes = useMemo(() => {
    if (!currentAgentId || !currentAgent) return [];
    // 同 Hub 内所有引用均可见，包括来自其他 Agent 窗口的引用
    return pendingQuotesByHub.get(currentAgent.hubId) ?? [];
  }, [currentAgent, currentAgentId, pendingQuotesByHub]);

  // 发送消息（流式响应）
  const handleSend = useCallback(
    async (content: string, inputOptions?: ChatInputSendOptions) => {
      if (!currentAgentId || !currentAgent) return;

      const inputMetadata = inputOptions
        ? {
            ...(inputOptions.displayContent ? { displayContent: inputOptions.displayContent } : {}),
            ...(inputOptions.displayParts ? { displayParts: inputOptions.displayParts } : {}),
            ...(inputOptions.contextTokens ? { contextTokens: inputOptions.contextTokens } : {}),
          }
        : undefined;

      // Planning 模式：使用 usePlanningMode Hook
      // quotes 和 onClearQuotes 与 Chat 模式对称传递，确保引用内容注入 LLM 上下文
      if (mode === 'planning') {
        const attachmentsToSend = getAttachmentsCopy();
        await executePlanningTask(content, {
          attachments: attachmentsToSend,
          onClearAttachments: clearAttachments,
          quotes: pendingQuotes,
          onClearQuotes: () => clearQuotes(currentAgent.hubId),
          userMessageMeta: inputMetadata,
        });
        return;
      }

      // Chat 模式：使用 useChatSender Hook 处理
      const attachmentsToSend = getAttachmentsCopy();
      await sendChatMessage(content, {
        attachments: attachmentsToSend,
        quotes: pendingQuotes,
        onClearQuotes: () => clearQuotes(currentAgent.hubId),
        onClearAttachments: clearAttachments,
        userMessageMeta: inputMetadata,
      });
    },
    [
      currentAgentId,
      currentAgent,
      mode,
      executePlanningTask,
      getAttachmentsCopy,
      clearAttachments,
      pendingQuotes,
      clearQuotes,
      sendChatMessage,
    ]
  );

  // 模式切换
  const handleModeChange = useCallback(
    (newMode: ChatMode) => {
      if (currentAgentId) {
        setModeFor(currentAgentId, newMode);
      }
    },
    [currentAgentId, setModeFor]
  );

  // 移除引用
  const handleRemoveQuote = useCallback(
    (messageId: string) => {
      if (currentAgent) {
        removeQuote(currentAgent.hubId, messageId);
      }
    },
    [currentAgent, removeQuote]
  );

  // 搜索切换
  const handleToggleSearch = useCallback(() => {
    if (!currentAgentId) return;
    if (isSearchOpen) {
      closeSearch(currentAgentId);
    } else {
      openSearch(currentAgentId);
    }
  }, [currentAgentId, isSearchOpen, openSearch, closeSearch]);

  const handleCloseSearch = useCallback(() => {
    if (currentAgentId) closeSearch(currentAgentId);
  }, [currentAgentId, closeSearch]);

  // 多选消息切换
  const handleToggleMessageSelect = useCallback(
    (messageId: string) => {
      if (currentAgentId) toggleMessageSelect(currentAgentId, messageId);
    },
    [currentAgentId, toggleMessageSelect]
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

  // 多选批量操作
  // 多选批量删除确认弹窗状态
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState<{
    isOpen: boolean;
    count: number;
    onConfirm: (() => void) | null;
  }>({ isOpen: false, count: 0, onConfirm: null });

  const handleMultiSelectAction = useCallback(
    (action: 'copy' | 'quote' | 'delete' | 'cancel') => {
      if (!currentAgentId) return;
      switch (action) {
        case 'copy': {
          // 按时间顺序合并选中消息文本
          const selectedMsgs = agentMessages.filter((m) => selectedMessageIds.has(m.id));
          const text = selectedMsgs
            .map(
              (m) =>
                `${m.role === 'user' ? t('chat.userLabel') : (currentAgent?.name ?? 'Agent')}: ${m.content}`
            )
            .join('\n\n');
          navigator.clipboard.writeText(text).catch((err: unknown) => {
            logger.error('[AgentChatView] 复制失败:', err);
          });
          exitMultiSelect(currentAgentId);
          break;
        }
        case 'quote': {
          // 批量添加到引用列表
          if (!currentAgent) break;
          const selectedMsgs = agentMessages.filter((m) => selectedMessageIds.has(m.id));
          const { addQuote } = useChatStore.getState();
          for (const msg of selectedMsgs) {
            const quoteContent = getMessageQuoteContent(msg);
            addQuote(currentAgent.hubId, {
              messageId: msg.id,
              content: quoteContent,
              hubId: currentAgent.hubId,
              agentName: msg.role === 'user' ? t('chat.userLabel') : currentAgent.name,
              sourceAgentId: currentAgentId,
            });
          }
          exitMultiSelect(currentAgentId);
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
              exitMultiSelect(currentAgentId);
              setBatchDeleteConfirm({ isOpen: false, count: 0, onConfirm: null });
            },
          });
          break;
        }
        case 'cancel': {
          exitMultiSelect(currentAgentId);
          break;
        }
      }
    },
    [
      currentAgentId,
      currentAgent,
      agentMessages,
      selectedMessageIds,
      exitMultiSelect,
      handleMessageAction,
      t,
    ]
  );

  // 保存生成图片到交付物目录（deliverables/{hubName}/{agentName}/）
  const handleImageSave = useCallback(
    async (dataUrl: string, fileName: string) => {
      if (!currentAgentId) return;
      try {
        // 从 data URL 提取 base64 数据部分
        const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
        if (!base64Match?.[1]) {
          logger.error('[AgentChatView] 无法解析图片 data URL');
          return;
        }
        const base64Data = base64Match[1];

        // 解码 base64 为二进制
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // 获取 Agent 和 Hub 信息，构建正确的交付物路径
        // 路径格式：deliverables/{hubName}/{agentName}/ （与右栏 FileList 一致）
        const agent = useAgentStore.getState().agents.find((a) => a.id === currentAgentId);
        const hub = agent ? useHubStore.getState().hubs.find((h) => h.id === agent.hubId) : null;
        const hubName = sanitizeFolderName(hub?.name ?? 'default');
        const agentName = sanitizeFolderName(agent?.name ?? 'unknown');

        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        const dirPath = await join(appData, 'deliverables', hubName, agentName);
        const filePath = await join(dirPath, fileName);

        // 确保目录存在并写入文件
        const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs');
        await mkdir(dirPath, { recursive: true });
        await writeFile(filePath, bytes);
        logger.trace('[AgentChatView] 图片已保存到交付物:', filePath);

        // 发射事件通知右栏 FileList 刷新
        const { emit } = await import('@tauri-apps/api/event');
        await emit('file:deliverable_created', { agentId: currentAgentId, filePath });
      } catch (error) {
        logger.error('[AgentChatView] 保存图片到交付物失败:', error);
      }
    },
    [currentAgentId]
  );

  // 加载更早的历史消息（游标式分页）
  const handleLoadMore = useCallback(async () => {
    if (!currentAgentId || isLoadingMore) return;
    const currentMessages = useChatStore.getState().messagesByAgent.get(currentAgentId) ?? [];
    if (currentMessages.length === 0) return;

    // 以当前最旧消息的 ID 作为游标
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
      >('message_get_before', {
        agentId: currentAgentId,
        beforeMessageId: oldestMessage.id,
        count: LOAD_MORE_COUNT,
      });

      // 转换为前端 Message 类型
      const olderMessages: Message[] = olderMessagesFromDb.map((m) => {
        let parsedMetadata: Message['metadata'] = undefined;
        if (m.metadata) {
          try {
            parsedMetadata = JSON.parse(m.metadata) as unknown as Message['metadata'];
          } catch (e) {
            logger.warn('[AgentChatView] 解析 metadata 失败:', e);
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

      // 过滤掉 Hub 消息
      const agentOnly = olderMessages.filter((m) => {
        const sourceType = (m.metadata as { sourceType?: string } | undefined)?.sourceType;
        return sourceType !== 'hub';
      });

      const widgetSubmissions = collectWidgetBubbleSubmissions(agentOnly);
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

      // 向头部插入
      useChatStore.getState().prependMessages(currentAgentId, agentOnly);

      // 如果返回数量不足一页，说明已无更多历史
      if (olderMessagesFromDb.length < LOAD_MORE_COUNT) {
        useChatStore.getState().setHasMore(currentAgentId, false);
      }

      logger.trace('[AgentChatView] 加载更多历史消息', {
        loaded: agentOnly.length,
        hasMore: olderMessagesFromDb.length >= LOAD_MORE_COUNT,
      });
    } catch (error) {
      logger.error('[AgentChatView] 加载更多历史消息失败:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [currentAgentId, isLoadingMore]);

  // Ctrl+F 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (currentAgentId) openSearch(currentAgentId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentAgentId, openSearch]);

  // 消息操作方法已由 useMessageActions Hook 提供：
  // - handleMessageAction
  // - revertDialogState
  // - closeRevertDialog

  if (!currentAgent) {
    return (
      <div className={styles.chatView}>
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
              <circle cx="32" cy="24" r="12" />
              <path d="M16 52c0-8.8 7.2-16 16-16s16 7.2 16 16" />
            </svg>
          </div>
          <p className={styles.emptyText}>{t('agent.selectAgent')}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.chatView}>
        {/* 标题区 */}
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <AgentModelSelector
              provider={currentAgent.modelProvider}
              model={currentAgent.modelName}
              onSelect={async (provider, model) => {
                if (!currentAgentId) return;
                // 更新 Store
                updateAgent(currentAgentId, { modelProvider: provider, modelName: model });
                // 持久化到后端
                try {
                  await invoke('agent_update', {
                    id: currentAgentId,
                    request: { model_provider: provider, model_name: model },
                  });
                  logger.trace('[AgentChatView] 模型配置已保存:', provider, model);
                } catch (error) {
                  logger.error('[AgentChatView] 保存模型配置失败:', error);
                }
              }}
            />
          </div>
          <div className={styles.headerActions}>
            <Tooltip content={t('agent.chat.searchTitle')}>
              <button
                className={styles.searchBtn}
                onClick={handleToggleSearch}
                aria-label={t('agent.chat.searchAria')}
              >
                <Search size={18} />
              </button>
            </Tooltip>
            <Tooltip content={t('agent.chat.settingsAria')}>
              <button
                className={styles.settingsBtn}
                onClick={() => setIsSettingsOpen(true)}
                aria-label={t('agent.chat.settingsAria')}
              >
                <UserRoundCog size={20} strokeWidth={1.5} />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 搜索栏 - 直接紧贴 header 底部渲染 */}
        {isSearchOpen && currentAgentId && (
          <ChatSearchBar
            contextId={currentAgentId}
            messages={agentMessages}
            agentName={currentAgent.name}
            onJumpToMessage={handleJumpToMessage}
            onClose={handleCloseSearch}
          />
        )}

        {/* 对话历史区 - 始终显示，Chat / Task 共用（Task 内部值为 planning） */}
        <ChatHistory
          messages={agentMessages}
          agentName={currentAgent.name}
          isStreaming={isStreaming}
          streamingContent={streamingContent}
          streamingReasoningContent={streamingReasoningContent}
          mode={mode}
          contextId={currentAgentId ?? undefined}
          emptyText={t('agent.chat.emptyTitle', { name: currentAgent.name })}
          emptyHint={
            mode === 'planning'
              ? t('agent.chat.planningEmptyHint', { name: currentAgent.name })
              : t('agent.chat.chatEmptyHint')
          }
          onMessageAction={handleMessageAction}
          multiSelectActive={isMultiSelectActive}
          selectedMessageIds={selectedMessageIds}
          onToggleMessageSelect={handleToggleMessageSelect}
          onMultiSelectAction={handleMultiSelectAction}
          onImageSave={handleImageSave}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          isLoadingMore={isLoadingMore}
        />

        {/* 输入区 - Agent 窗口禁用 @提及功能 */}
        <ChatInput
          placeholder={
            mode === 'planning'
              ? t('agent.chat.planningInputPlaceholder')
              : t('agent.chat.chatInputPlaceholder')
          }
          disabled={isStreaming || isSending || isAddingAttachment}
          mode={mode}
          pendingQuotes={pendingQuotes}
          enableMention={false}
          enableAttachment={true}
          attachments={pendingAttachments}
          agentId={currentAgentId ?? undefined}
          draftKey={currentAgentId ? `agent:${currentAgentId}` : undefined}
          projectPath={currentAgent.projectPath}
          hubName={currentHub?.name}
          agentName={currentAgent.name}
          restoreDraft={restoreDraft}
          isStreaming={isStreaming}
          onStop={handleStopStreaming}
          onSend={handleSend}
          onModeChange={handleModeChange}
          onRemoveQuote={handleRemoveQuote}
          onAttachmentAdd={handleAttachmentAdd}
          onAttachmentRemove={handleAttachmentRemove}
          onAttachmentReorder={handleAttachmentReorder}
          modelName={currentAgent.modelName ?? undefined}
        />
      </div>

      {/* 设置弹窗 */}
      <AgentSettingsModal
        isOpen={isSettingsOpen}
        agentId={currentAgentId}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* 文件回滚确认弹窗 - 撤销消息时如有关联文件编辑则弹出确认 */}
      <FileRevertDialog
        isOpen={revertDialogState.isOpen}
        records={revertDialogState.records}
        onConfirm={revertDialogState.onConfirm ?? (() => Promise.resolve())}
        onCancel={closeRevertDialog}
      />

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

      {/* 撤回确认弹窗（在 FileRevertDialog 之前的第一道确认门） */}
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
        title={t('agent.chat.batchDeleteTitle')}
        description={t('agent.chat.batchDeleteDescription', { count: batchDeleteConfirm.count })}
        confirmText={t('common.confirmDelete')}
        variant="danger"
      />

      {/*  已移除 DiffConfirmCard 弹窗，改用右栏 Diff 面板审批 */}
    </>
  );
}
