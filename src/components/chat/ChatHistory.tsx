/**
 * ChatHistory - 对话历史列表组件
 *
 * 功能：
 * - 显示消息列表
 * - 自动滚动到底部
 * - 按日期分组（可选）
 * - 空状态提示
 * - 多选模式支持
 *
 * 搜索栏由外部（AgentChatView / HubChatView）直接渲染于 header 下方，
 * ChatHistory 不再负责搜索栏的渲染
 */

import { useEffect, useRef, useCallback, memo } from 'react';
import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import { MultiSelectBar } from './MultiSelectBar';
import { TextContextMenu, useTextContextMenu } from '@components/ui';
import { useI18n } from '@/i18n';
import type { ChatMode } from '@/types/chatMode';
import type { UIMessage } from '@/types/message';
import styles from './ChatHistory.module.css';

// ==================== 类型定义 ====================

interface ChatHistoryProps {
    /** 消息列表 */
    messages: UIMessage[];
    /** 当前 Agent 名称 */
    agentName?: string;
    /** 是否正在流式接收 */
    isStreaming?: boolean;
    /** 流式内容 */
    streamingContent?: string;
    /** 流式 reasoning 内容 */
    streamingReasoningContent?: string;
    /** 当前模式：planning 或 chat */
    mode?: ChatMode;
    /** 空状态提示文本 */
    emptyText?: string;
    /** 空状态描述 */
    emptyHint?: string;
    /** 消息操作回调 */
    onMessageAction?: (
        messageId: string,
        action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect',
        options?: { contentOverride?: string }
    ) => void;

    // ========== 多选相关 ==========
    /** 是否处于多选模式 */
    multiSelectActive?: boolean;
    /** 已选消息 ID 集合 */
    selectedMessageIds?: Set<string>;
    /** 切换消息选中状态 */
    onToggleMessageSelect?: (messageId: string) => void;
    /** 多选批量操作回调 */
    onMultiSelectAction?: (action: 'copy' | 'quote' | 'delete' | 'cancel') => void;
    /** 图片保存到交付物回调（图像生成模型的 base64 图片可保存） */
    onImageSave?: (dataUrl: string, fileName: string) => void;
    contextId?: string;
    /** 是否还有更早的历史消息可加载 */
    hasMore?: boolean;
    /** 加载更多历史消息回调 */
    onLoadMore?: () => void;
    /** 是否正在加载更多 */
    isLoadingMore?: boolean;
}

// ==================== 组件实现 ====================

/**
 * ChatHistory 对话历史组件
 */
export const ChatHistory = memo(function ChatHistory({
    messages,
    agentName,
    isStreaming = false,
    streamingContent = '',
    streamingReasoningContent = '',
    mode = 'chat',
    emptyText,
    emptyHint,
    onMessageAction,
    multiSelectActive = false,
    selectedMessageIds,
    onToggleMessageSelect,
    onMultiSelectAction,
    onImageSave,
    contextId,
    hasMore = false,
    onLoadMore,
    isLoadingMore = false,
}: ChatHistoryProps) {
    const { t } = useI18n();
    const containerRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const {
        menu: textContextMenu,
        closeMenu: closeTextContextMenu,
        openSelectionMenu,
        handleMenuAction,
    } = useTextContextMenu();
    /** 记录加载更多前的滚动高度，用于加载后恢复位置 */
    const prevScrollHeightRef = useRef<number>(0);

    // 自动滚动到底部
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        bottomRef.current?.scrollIntoView({ behavior });
    }, []);

    // 滚动节流 ref（流式内容变化用）
    const scrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 滚动节流 ref（FSM 可视化内容变化用，独立于流式节流避免互斥）
    const fsmScrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 消息列表变化时滚动到底部（仅新消息到达时）
    // 如果是向头部 prepend 了旧消息（加载更多），则保持当前滚动位置不跳动
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        if (prevScrollHeightRef.current > 0) {
            // 加载更多完成：新内容被 prepend 到顶部，滚动高度变大
            // 恢复到加载前用户看到的位置
            const heightDiff = container.scrollHeight - prevScrollHeightRef.current;
            container.scrollTop += heightDiff;
            prevScrollHeightRef.current = 0;
        } else {
            scrollToBottom('auto');
        }
    }, [messages.length, scrollToBottom]);

    // 流式内容变化时节流滚动（每 100ms 最多滚动一次）
    useEffect(() => {
        if (isStreaming && !scrollThrottleRef.current) {
            scrollThrottleRef.current = setTimeout(() => {
                scrollToBottom('auto');
                scrollThrottleRef.current = null;
            }, 100);
        }
        return () => {
            if (scrollThrottleRef.current) {
                clearTimeout(scrollThrottleRef.current);
                scrollThrottleRef.current = null;
            }
        };
    }, [streamingContent, streamingReasoningContent, isStreaming, scrollToBottom]);

    // Planning 模式下监听 FSM 可视化内容变化（MB Thought / SA Observations），
    // 驱动外层聊天容器自动滚动到底部。
    // 使用 store.subscribe 模式：直接订阅 Zustand store 变化并执行 DOM 滚动，
    // 避免 FSM 高频内容更新触发 ChatHistory 组件重渲染（消息列表开销大）。
    useEffect(() => {
        if (mode !== 'planning' || !contextId) return;

        let prevSignal = 0;

        const unsubscribe = useFSMVisualizationStore.subscribe((state) => {
            const ctx = state.contextStates[contextId];
            if (!ctx) return;

            // 计算内容变化信号：
            // - thinkingSteps 数量 × 大基数 = 新步骤出现
            // - 最后一步三阶段内容总长度 = thinking 流式内容持续增长
            // - observations 数量 × 中基数 = SA 新工具调用/思考文字
            const lastStep = ctx.thinkingSteps[ctx.thinkingSteps.length - 1];
            const contentLen = lastStep
                ? lastStep.analyzing.length
                  + lastStep.planning.length
                  + lastStep.decided.length
                : 0;
            const signal =
                ctx.thinkingSteps.length * 10000
                + contentLen
                + ctx.subAgentObservations.length * 100;

            if (signal !== prevSignal) {
                prevSignal = signal;
                // 节流：150ms 内最多触发一次滚动，平衡跟随感与性能
                fsmScrollThrottleRef.current ??= setTimeout(() => {
                        scrollToBottom('auto');
                        fsmScrollThrottleRef.current = null;
                    }, 150);
            }
        });

        return () => {
            unsubscribe();
            if (fsmScrollThrottleRef.current) {
                clearTimeout(fsmScrollThrottleRef.current);
                fsmScrollThrottleRef.current = null;
            }
        };
    }, [mode, contextId, scrollToBottom]);

    // "加载更多"按钮点击时，记录当前滚动高度，加载完成后恢复位置
    // 注意：必须在 early return 之前声明，保证 hook 调用顺序一致
    const handleLoadMore = useCallback(() => {
        if (containerRef.current) {
            prevScrollHeightRef.current = containerRef.current.scrollHeight;
        }
        onLoadMore?.();
    }, [onLoadMore]);

    const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        openSelectionMenu(event, containerRef.current);
    }, [openSelectionMenu]);

    // 空状态
    if (messages.length === 0 && !isStreaming) {
        return (
            <div
                className={styles.container}
                data-custom-context-menu
                onContextMenu={handleContextMenu}
                ref={containerRef}
            >
                <div className={styles.emptyState}>
                    <div className={styles.emptyIcon}>
                        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M16 16h32v28H24l-8 8V16z" />
                            <path d="M24 28h16M24 36h10" />
                        </svg>
                    </div>
                    <p className={styles.emptyText}>{emptyText ?? t('chat.noConversation')}</p>
                    {(emptyHint ?? t('chat.noConversationHint')) && (
                        <p className={styles.emptyHint}>{emptyHint ?? t('chat.noConversationHint')}</p>
                    )}
                </div>
                <TextContextMenu
                    menu={textContextMenu}
                    onAction={handleMenuAction}
                    onClose={closeTextContextMenu}
                />
            </div>
        );
    }

    return (
        <div
            className={styles.container}
            ref={containerRef}
            data-custom-context-menu
            onContextMenu={handleContextMenu}
        >
            <div className={styles.messageList}>
                {/* 加载更多按钮 - 列表顶部 */}
                {hasMore && (
                    <div className={styles.loadMoreWrapper}>
                        <button
                            className={styles.loadMoreBtn}
                            onClick={handleLoadMore}
                            disabled={isLoadingMore}
                        >
                            {isLoadingMore ? t('chat.loadingMore') : t('chat.loadEarlier')}
                        </button>
                    </div>
                )}
                {messages.map((message) => (
                    <MessageBubble
                        key={message.id}
                        message={message}
                        agentName={message.metadata?.agentName ?? agentName}
                        onAction={onMessageAction}
                        multiSelectMode={multiSelectActive}
                        selected={selectedMessageIds?.has(message.id)}
                        onToggleSelect={onToggleMessageSelect}
                        onImageSave={onImageSave}
                        contextId={contextId}
                    />
                ))}

                {/* 流式消息：isStreaming 时立即显示（组件内部处理空内容时的 typing indicator） */}
                {isStreaming && (
                    <StreamingMessage
                        content={streamingContent}
                        reasoningContent={streamingReasoningContent}
                        agentName={agentName}
                        mode={mode}
                        contextId={contextId}
                    />
                )}

                {/* 滚动锚点 */}
                <div ref={bottomRef} className={styles.scrollAnchor} />
            </div>

            {/* 多选浮动操作栏 */}
            {multiSelectActive && onMultiSelectAction && (
                <MultiSelectBar
                    selectedCount={selectedMessageIds?.size ?? 0}
                    onCopy={() => onMultiSelectAction('copy')}
                    onQuote={() => onMultiSelectAction('quote')}
                    onDelete={() => onMultiSelectAction('delete')}
                    onCancel={() => onMultiSelectAction('cancel')}
                />
            )}
            <TextContextMenu
                menu={textContextMenu}
                onAction={handleMenuAction}
                onClose={closeTextContextMenu}
            />
        </div>
    );
});
