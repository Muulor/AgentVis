/**
 * useMessageActions Hook
 * 
 * 统一封装消息操作逻辑（copy/quote/delete/revoke/multiselect）
 * 供 AgentChatView 和 HubChatView 共同使用
 * 
 * 设计要点：
 * 1. Agent 模式支持 Diff 回滚检测
 * 2. Agent 模式支持短期记忆同步删除
 * 3. Quote 操作需正确设置 sourceAgentId 以实现可见性隔离
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '@stores/chatStore';
import { useDiffStore } from '@stores/diffStore';
import { useAttachmentViewerStore } from '@stores/attachmentViewerStore';
import type { QuoteInfo, UIMessage } from '@/types/message';
import type { DiffRecord } from '@components/ui';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';
import { getMessageQuoteContent } from '@utils/quoteContent';

const logger = getLogger('useMessageActions');

// ==================== 类型定义 ====================

/** 回滚确认弹窗状态 */
export interface RevertDialogState {
    isOpen: boolean;
    records: DiffRecord[];
    messageId: string;
    onConfirm: (() => Promise<void>) | null;
}

/** 操作确认弹窗状态（delete / revoke 共用结构） */
export interface ActionConfirmDialogState {
    isOpen: boolean;
    title: string;
    description: string;
    confirmText: string;
    variant: 'danger' | 'warning';
    onConfirm: (() => Promise<void>) | null;
}

/** Hook 配置选项 */
export interface UseMessageActionsOptions {
    /** 上下文类型：Agent 或 Hub */
    contextType: 'agent' | 'hub';
    /** 上下文 ID（Agent ID 或 Hub ID） */
    contextId: string | null;
    /** Hub ID（Agent 模式需要，用于存储引用） */
    hubId?: string;
    /** Agent 名称（Agent 模式需要，用于引用时标记来源） */
    agentName?: string;
    /** 消息列表（用于查找消息） */
    messages: UIMessage[];
    /** Agent 用户消息撤回完成后回调，用于 UI 层恢复输入草稿 */
    onRevokeComplete?: (message: UIMessage) => void;
}

/** Hook 返回值 */
export interface UseMessageActionsReturn {
    /** 执行消息操作（options.skipConfirm 为 true 时跳过确认弹窗，供批量删除等已有外层确认的场景使用） */
    handleMessageAction: (messageId: string, action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect', options?: { skipConfirm?: boolean }) => Promise<void>;
    /** 回滚确认弹窗状态（仅 Agent 模式使用） */
    revertDialogState: RevertDialogState;
    /** 设置回滚确认弹窗状态 */
    setRevertDialogState: (state: RevertDialogState) => void;
    /** 关闭回滚确认弹窗 */
    closeRevertDialog: () => void;
    /** 删除确认弹窗状态 */
    deleteDialogState: ActionConfirmDialogState;
    /** 关闭删除确认弹窗 */
    closeDeleteDialog: () => void;
    /** 撤回确认弹窗状态（在 FileRevertDialog 之前的第一道确认） */
    revokeConfirmDialogState: ActionConfirmDialogState;
    /** 关闭撤回确认弹窗 */
    closeRevokeConfirmDialog: () => void;
}

// ==================== 初始状态 ====================

const initialRevertDialogState: RevertDialogState = {
    isOpen: false,
    records: [],
    messageId: '',
    onConfirm: null,
};

const initialActionConfirmDialogState: ActionConfirmDialogState = {
    isOpen: false,
    title: '',
    description: '',
    confirmText: 'Confirm',
    variant: 'danger',
    onConfirm: null,
};

// ==================== Hook 实现 ====================

/**
 * 消息操作 Hook
 * 
 * @param options - 配置选项
 * @returns 消息操作相关的方法和状态
 * 
 * @example
 * ```tsx
 * // Agent 模式
 * const { handleMessageAction, revertDialogState, closeRevertDialog } = useMessageActions({
 *     contextType: 'agent',
 *     contextId: currentAgentId,
 *     hubId: currentAgent.hubId,
 *     agentName: currentAgent.name,
 *     messages: agentMessages,
 * });
 * 
 * // Hub 模式
 * const { handleMessageAction } = useMessageActions({
 *     contextType: 'hub',
 *     contextId: currentHubId,
 *     messages: hubMessages,
 * });
 * ```
 */
export function useMessageActions(options: UseMessageActionsOptions): UseMessageActionsReturn {
    const { contextType, contextId, hubId, agentName, messages, onRevokeComplete } = options;
    const { t } = useI18n();

    // 从 chatStore 获取 addQuote（统一引用存储）
    const addQuote = useChatStore((state) => state.addQuote);

    // 回滚确认弹窗状态（仅 Agent 模式使用）
    const [revertDialogState, setRevertDialogState] = useState<RevertDialogState>(initialRevertDialogState);

    // 关闭回滚确认弹窗
    const closeRevertDialog = useCallback(() => {
        setRevertDialogState(initialRevertDialogState);
    }, []);

    // 删除确认弹窗状态
    const [deleteDialogState, setDeleteDialogState] = useState<ActionConfirmDialogState>(initialActionConfirmDialogState);

    // 撤回确认弹窗状态（在 FileRevertDialog 之前的第一道确认门）
    const [revokeConfirmDialogState, setRevokeConfirmDialogState] = useState<ActionConfirmDialogState>(initialActionConfirmDialogState);

    // 关闭删除确认弹窗
    const closeDeleteDialog = useCallback(() => {
        setDeleteDialogState(initialActionConfirmDialogState);
    }, []);

    // 关闭撤回确认弹窗
    const closeRevokeConfirmDialog = useCallback(() => {
        setRevokeConfirmDialogState(initialActionConfirmDialogState);
    }, []);

    // ==================== 核心操作方法 ====================

    const handleMessageAction = useCallback(
        async (messageId: string, action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect', options?: { skipConfirm?: boolean }) => {
            if (!contextId) return;

            const msg = messages.find((m) => m.id === messageId);

            switch (action) {
                // ==================== 复制消息 ====================
                case 'copy': {
                    if (msg) {
                        await navigator.clipboard.writeText(msg.content);
                        logger.trace('[useMessageActions] 已复制消息');
                    }
                    break;
                }

                // ==================== 引用消息 ====================
                case 'quote': {
                    if (!msg) break;

                    const quoteContent = getMessageQuoteContent(msg);

                    if (contextType === 'agent') {
                        // Agent 模式：存储到 Hub 引用列表，设置 sourceAgentId 实现可见性隔离
                        if (!hubId || !agentName) {
                            logger.warn('[useMessageActions] Agent 模式需要 hubId 和 agentName');
                            break;
                        }
                        const senderName = msg.role === 'user' ? 'User' : agentName;
                        const quoteInfo: QuoteInfo = {
                            messageId: msg.id,
                            content: quoteContent,
                            hubId: hubId,
                            agentName: senderName,
                            sourceAgentId: contextId,  // 标记来源 Agent，用于其他 Agent 窗口过滤
                        };
                        addQuote(hubId, quoteInfo);
                    } else {
                        // Hub 模式：直接存储到当前 Hub 的引用列表
                        // 确定发送者名称（优先级从高到低）：
                        // 1. metadata.agentName（Chat 模式 / 新版 Planning 模式已写入）
                        // 2. agentStore 反查（旧版 Planning 模式消息的兜底，通过 msg.agentId 查询）
                        // 3. 'User'（user 消息）
                        // 4. 'Hub'（真正无法确认来源时）
                        let senderName: string;
                        if (msg.metadata?.agentName) {
                            senderName = msg.metadata.agentName;
                        } else if (msg.role === 'user') {
                            senderName = 'User';
                        } else {
                            // assistant 消息但无 agentName metadata（旧版 Planning 模式消息）
                            // 尝试通过 agentId 从 agentStore 同步反查 Agent 名称
                            const { useAgentStore } = await import('@stores/agentStore');
                            const agentFromStore = useAgentStore.getState().agents.find(a => a.id === msg.agentId);
                            senderName = agentFromStore?.name ?? 'Hub';
                        }

                        const quoteInfo: QuoteInfo = {
                            messageId: msg.id,
                            content: quoteContent,
                            hubId: contextId,
                            agentName: senderName,
                        };
                        addQuote(contextId, quoteInfo);
                    }
                    break;
                }

                // ==================== 删除消息（确认弹窗拦截） ====================
                case 'delete': {
                    // 构建确认文案：Planning 模式 assistant 消息需要额外警告进度快照丢失
                    const isPlanningAssistant = msg?.role === 'assistant'
                        && (msg.metadata as Record<string, unknown> | undefined)?.mode === 'planning';

                    const deleteDescription = isPlanningAssistant
                        ? t('chat.deletePlanningRecordDescription')
                        : t('chat.deleteMessageDescription');

                    // 将实际删除逻辑封装为确认回调，原有逻辑完全不变
                    const executeDelete = async () => {
                        if (contextType === 'agent') {
                            // Agent 模式：更新 Store 并调用后端持久化
                            const currentMessages = useChatStore.getState().messagesByAgent.get(contextId) ?? [];

                            // 收集需要删除的消息 ID（至少包含当前消息本身）
                            const idsToDelete: string[] = [messageId];

                            // 检测：如果删除的是 assistant 消息，且前一条是隐藏的 widget/cron user 消息，
                            // 则联动删除该 user 消息（因为 UI 中已隐藏，用户无法手动删除）
                            const deletedMsg = currentMessages.find(m => m.id === messageId);
                            if (deletedMsg?.role === 'assistant') {
                                const deletedIndex = currentMessages.indexOf(deletedMsg);
                                const prevMsg = deletedIndex > 0 ? currentMessages[deletedIndex - 1] : undefined;
                                if (prevMsg?.role === 'user' && prevMsg.metadata) {
                                    const meta = prevMsg.metadata as Record<string, unknown>;
                                    // widget/cron user 消息在 UI 中已隐藏，需要联动清理
                                    if (meta.source === 'widget' || meta.source === 'cron') {
                                        idsToDelete.push(prevMsg.id);
                                        logger.trace(`[useMessageActions] 联动删除隐藏的 ${meta.source} user 消息:`, prevMsg.id);
                                    }
                                }
                            }

                            // 从 Store 中移除所有待删消息
                            const newMessages = currentMessages.filter(m => !idsToDelete.includes(m.id));
                            useChatStore.getState().setMessages(contextId, newMessages);

                            // 后端持久化删除
                            for (const id of idsToDelete) {
                                try {
                                    await invoke('message_delete', { id });
                                } catch (error) {
                                    logger.error('[useMessageActions] 删除消息失败:', error);
                                }
                            }
                            logger.trace('[useMessageActions] 消息已删除:', idsToDelete);

                            // 同步删除关联的短期缓冲记录，防止已删除消息被水位线摘要收录
                            try {
                                await invoke('memory_delete_by_source_ids', {
                                    agentId: contextId,
                                    sourceMessageIds: idsToDelete,
                                });
                                logger.debug('[useMessageActions] 已同步删除短期缓冲记录');
                            } catch (e) {
                                logger.warn('[useMessageActions] 删除短期缓冲记录失败:', e);
                            }

                            // 同步清理内存中的 ShortTermBuffer
                            try {
                                const { getCachedMemoryService } = await import('@services/memory');
                                const memoryService = getCachedMemoryService(contextId);
                                if (memoryService) {
                                    for (const id of idsToDelete) {
                                        memoryService.removeMessageFromBuffer(id);
                                    }
                                }
                            } catch (e) {
                                logger.warn('[useMessageActions] 清理内存缓冲失败:', e);
                            }
                        } else {
                            // Hub 模式：更新 Store 并调用后端持久化删除
                            const currentMessages = useChatStore.getState().messagesByHub.get(contextId) ?? [];
                            const filteredMessages = currentMessages.filter((m) => m.id !== messageId);
                            useChatStore.getState().setHubMessages(contextId, filteredMessages);

                            // 后端持久化删除
                            try {
                                await invoke('message_delete', { id: messageId });
                                logger.trace('[useMessageActions] Hub 消息已删除:', messageId);
                            } catch (error) {
                                logger.error('[useMessageActions] Hub 消除消息失败:', error);
                            }
                        }
                        // 确认后关闭弹窗
                        setDeleteDialogState(initialActionConfirmDialogState);
                    };

                    // 批量删除等场景已有外层确认，跳过弹窗直接执行
                    if (options?.skipConfirm) {
                        await executeDelete();
                        break;
                    }

                    // 弹出确认弹窗，用户确认后才执行删除
                    setDeleteDialogState({
                        isOpen: true,
                        title: t('chat.deleteMessage'),
                        description: deleteDescription,
                        confirmText: t('common.confirmDelete'),
                        variant: 'danger',
                        onConfirm: executeDelete,
                    });
                    break;
                }

                // ==================== 撤回消息（确认弹窗拦截） ====================
                case 'revoke': {
                    // 检查被撤回消息之后是否含有 Planning 模式消息（进度快照将丢失）
                    const revokeIdx = messages.findIndex(m => m.id === messageId);
                    const followingMessages = revokeIdx !== -1 ? messages.slice(revokeIdx) : [];
                    const hasPlanningContent = followingMessages.some(m =>
                        (m.metadata as Record<string, unknown> | undefined)?.mode === 'planning'
                    );

                    const revokeDescription = hasPlanningContent
                        ? t('chat.revokePlanningDescription')
                        : t('chat.revokeMessageDescription');

                    // 将实际撤回逻辑封装为确认回调，原有逻辑完全不变
                    const executeRevoke = async () => {
                        // 先关闭确认弹窗（Agent 模式后续可能还会弹 FileRevertDialog）
                        setRevokeConfirmDialogState(initialActionConfirmDialogState);

                        if (contextType === 'agent') {
                            // Agent 模式：带 Diff 回滚检测的撤回（内部逻辑完全不改动）
                            await handleAgentRevoke(
                                messageId,
                                contextId,
                                setRevertDialogState,
                                msg?.role === 'user' ? () => onRevokeComplete?.(msg) : undefined
                            );
                        } else {
                            // Hub 模式：截断消息列表并持久化到后端
                            const allMessages = useChatStore.getState().messagesByHub.get(contextId) ?? [];
                            const idx = allMessages.findIndex((m) => m.id === messageId);
                            if (idx !== -1) {
                                const messagesToRevoke = allMessages.slice(idx);
                                useChatStore.getState().setHubMessages(contextId, allMessages.slice(0, idx));

                                // Hub 消息的 agentId 可能是 hubId 或 mentionedAgent.id
                                // 需按消息自身的 agentId 分组后，对每组调用 message_retract_from
                                const agentGroups = new Map<string, { firstId: string }>(); 
                                for (const m of messagesToRevoke) {
                                    if (!agentGroups.has(m.agentId)) {
                                        agentGroups.set(m.agentId, { firstId: m.id });
                                    }
                                }
                                for (const [agentId, { firstId }] of agentGroups.entries()) {
                                    try {
                                        await invoke('message_retract_from', { id: firstId, agentId });
                                        logger.debug('[useMessageActions] Hub 消息已按 agentId 撤回:', agentId);
                                    } catch (error) {
                                        logger.error('[useMessageActions] Hub 撤回消息失败 (agentId:', agentId, '):', error);
                                    }
                                }
                            }

                            // 清理附件预览状态
                            useAttachmentViewerStore.getState().clearContextAttachments(contextId);
                            useAttachmentViewerStore.getState().clearDocumentPreview();
                            useAttachmentViewerStore.getState().triggerClearPreview();
                            logger.trace('[useMessageActions] Hub 模式撤回：已清理附件预览状态');
                        }
                    };

                    // 弹出确认弹窗，用户确认后才执行撤回
                    setRevokeConfirmDialogState({
                        isOpen: true,
                        title: t('chat.revokeMessage'),
                        description: revokeDescription,
                        confirmText: t('chat.confirmRevoke'),
                        variant: 'warning',
                        onConfirm: executeRevoke,
                    });
                    break;
                }

                // ==================== 进入多选模式 ====================
                case 'multiselect': {
                    // 进入多选并选中当前消息
                    useChatStore.getState().enterMultiSelect(contextId, messageId);
                    logger.trace('[useMessageActions] 进入多选模式, 初始选中:', messageId);
                    break;
                }
            }
        },
        [contextType, contextId, hubId, agentName, messages, addQuote, onRevokeComplete, t]
    );

    return {
        handleMessageAction,
        revertDialogState,
        setRevertDialogState,
        closeRevertDialog,
        deleteDialogState,
        closeDeleteDialog,
        revokeConfirmDialogState,
        closeRevokeConfirmDialog,
    };
}

// ==================== 内部辅助函数 ====================

/**
 * Agent 模式撤回消息（带 Diff 回滚检测）
 * 
 * 流程：
 * 1. 检查消息是否关联 Diff 记录
 * 2. 如有已应用的 Diff → 弹窗确认
 * 3. 执行撤回：回滚文件 → 更新 UI → 删除后端记录 → 清理记忆
 */
async function handleAgentRevoke(
    messageId: string,
    agentId: string,
    setRevertDialogState: (state: RevertDialogState) => void,
    onRevokeComplete?: () => void
): Promise<void> {
    const currentMessages = useChatStore.getState().messagesByAgent.get(agentId) ?? [];
    const idx = currentMessages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    // 1. 检查是否有关联的 Diff 记录
    let diffRecords: DiffRecord[] = [];
    try {
        diffRecords = await invoke<DiffRecord[]>('diff_record_get_by_message', { messageId });
    } catch (e) {
        logger.warn('[useMessageActions] 查询 Diff 记录失败:', e);
    }

    // 2. 定义执行撤销的函数
    const executeRevoke = async () => {
        // 2.1 如果有 Diff 记录，先回滚文件
        if (diffRecords.length > 0) {
            for (const record of diffRecords) {
                if (record.status === 'applied') {
                    try {
                        await invoke('file_write_to_path', {
                            path: record.documentId,
                            content: record.originalContent,
                            createBackup: true,
                        });
                        logger.debug('[useMessageActions] 文件已回滚:', record.documentId);
                    } catch (revertError) {
                        logger.error('[useMessageActions] 文件回滚失败:', revertError);
                    }
                }
            }
            // 更新 Diff 记录状态为 reverted
            try {
                await invoke('diff_record_revert_by_message', { messageId });
            } catch (e) {
                logger.warn('[useMessageActions] 更新 Diff 记录状态失败:', e);
            }
            // 清理前端 diffStore 状态，防止 Diff 面板残留
            useDiffStore.getState().resetContext(agentId);
            logger.debug('[useMessageActions] 已清理 diffStore 前端状态');
        }

        // 2.2 获取要删除的消息 ID 列表
        const messagesToDelete = currentMessages.slice(idx);
        const messageIdsToDelete = messagesToDelete.map(m => m.id);

        // 2.3 更新 UI 状态
        useChatStore.getState().setMessages(agentId, currentMessages.slice(0, idx));

        // 2.4 调用后端命令撤回消息
        try {
            await invoke('message_retract_from', { id: messageId, agentId: agentId });
            logger.debug('[useMessageActions] 消息已撤回:', messageId);
        } catch (error) {
            logger.error('[useMessageActions] 撤回消息失败:', error);
        }

        // 2.5 同步删除关联的短期缓冲记录
        try {
            const deletedCount = await invoke<number>('memory_delete_by_source_ids', {
                agentId: agentId,
                sourceMessageIds: messageIdsToDelete,
            });
            logger.trace('[useMessageActions] 已删除关联的短期缓冲记录:', deletedCount, '条');
        } catch (e) {
            logger.warn('[useMessageActions] 删除短期缓冲记录失败:', e);
        }

        // 2.6  重置 AgentSession，清空内存中的消息历史和工具输出
        try {
            const { getOrCreateAgentService } = await import('@services/planning/AgentService');
            const agentService = getOrCreateAgentService({ agentId });
            agentService.resetSession();
            logger.trace('[useMessageActions] 已重置 AgentSession 内存缓存');
        } catch (e) {
            logger.warn('[useMessageActions] 重置 AgentSession 失败:', e);
        }

        // 2.7 RAG 向量索引不在消息撤销时清理
        // 向量生命周期由知识库 UI 管理：用户在 Agent 设置 → 知识库标签页中移除文件即可清除对应向量
        // file_write 产生的交付物和附件都已自动同步到知识库，documentId 统一使用 filePath
        logger.trace('[useMessageActions] RAG 向量索引由知识库管理，撤销消息不触发向量清理');

        // 2.8 清理附件预览状态
        useAttachmentViewerStore.getState().clearDocumentPreview();
        useAttachmentViewerStore.getState().clearContextAttachments(agentId);
        useAttachmentViewerStore.getState().triggerClearPreview();
        logger.trace('[useMessageActions] 已清理附件预览状态');

        // 2.8 关闭弹窗
        setRevertDialogState({
            isOpen: false,
            records: [],
            messageId: '',
            onConfirm: null,
        });
        onRevokeComplete?.();
    };

    // 3. 判断是否需要弹窗确认
    const appliedRecords = diffRecords.filter(r => r.status === 'applied');
    if (appliedRecords.length > 0) {
        // 有已应用的 Diff 记录 → 弹窗确认
        setRevertDialogState({
            isOpen: true,
            records: appliedRecords,
            messageId,
            onConfirm: executeRevoke,
        });
    } else {
        // 无关联 Diff 或无已应用记录 → 直接撤销
        await executeRevoke();
    }
}
