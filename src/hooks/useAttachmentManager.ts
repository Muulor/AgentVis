/**
 * 附件管理 Hook
 * 
 * 统一封装附件的添加、移除、重排序、并发验证等逻辑
 * 供 AgentChatView 和 HubChatView 共同使用
 * 
 * 设计要点：
 * 1. 使用 ref + state 双轨机制解决并发验证问题
 * 2. 预占计数器机制防止异步操作期间的竞态条件
 * 3. 统一的错误处理和 Toast 通知
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@components/ui/Toast';
import {
    attachmentService,
    ImageCompressionError,
    CompressionErrorCode,
    SUPPORTED_FORMATS_DISPLAY,
    DocumentProcessingError,
} from '@services/attachment';
import type { AttachmentInfo } from '@/types/message';
import { useAttachmentViewerStore } from '@/stores/attachmentViewerStore';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';

const logger = getLogger('useAttachmentManager');

// ==================== 常量定义 ====================

/** 最大附件数量 */
const MAX_FILE_COUNT = 5;
/** 最大总大小（50MB） */
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

// ==================== 类型定义 ====================

/** Hook 配置选项 */
export interface UseAttachmentManagerOptions {
    /** 是否启用 RAG 索引（仅 Agent 模式需要） */
    enableRagIndex?: boolean;
}

export interface AddAttachmentsOptions {
    /** 附件保存目录，通常为当前 workdir/attachments */
    targetDir?: string;
}

/** Hook 返回值 */
export interface UseAttachmentManagerReturn {
    /** 当前待发送的附件列表 */
    pendingAttachments: AttachmentInfo[];
    /** 是否正在添加附件 */
    isAddingAttachment: boolean;
    /** 添加附件（支持多选） */
    addAttachments: (filePaths: string[], options?: AddAttachmentsOptions) => Promise<void>;
    /** 移除单个附件 */
    removeAttachment: (attachmentId: string) => void;
    /** 重排序附件 */
    reorderAttachments: (reorderedAttachments: AttachmentInfo[]) => void;
    /** 恢复附件列表（撤回消息后复用已保存的附件对象） */
    restoreAttachments: (attachments: AttachmentInfo[]) => void;
    /** 清空所有附件（发送消息后调用） */
    clearAttachments: () => void;
    /** 获取附件列表副本（用于发送前保存） */
    getAttachmentsCopy: () => AttachmentInfo[];
}

function normalizeAttachmentPath(path?: string): string | null {
    const normalized = path?.trim().replace(/\\/g, '/');
    if (!normalized) return null;

    return /^[a-z]:\//i.test(normalized)
        ? normalized.toLowerCase()
        : normalized;
}

function getAttachmentIdentity(attachment: AttachmentInfo): string {
    return normalizeAttachmentPath(attachment.localPath)
        ?? normalizeAttachmentPath(attachment.originalPath)
        ?? `${attachment.fileName}:${attachment.fileExtension}:${attachment.size}`;
}

function isSameAttachmentPath(filePath: string, attachment: AttachmentInfo): boolean {
    const normalizedPath = normalizeAttachmentPath(filePath);
    if (!normalizedPath) return false;

    return normalizedPath === normalizeAttachmentPath(attachment.localPath)
        || normalizedPath === normalizeAttachmentPath(attachment.originalPath);
}

// ==================== Hook 实现 ====================

/**
 * 附件管理 Hook
 * 
 * @param contextId - 上下文 ID（Agent ID 或 Hub ID），为 null 时禁用操作
 * @param options - 配置选项
 * @returns 附件管理相关的状态和方法
 * 
 * @example
 * ```tsx
 * const {
 *     pendingAttachments,
 *     isAddingAttachment,
 *     addAttachments,
 *     removeAttachment,
 *     reorderAttachments,
 *     clearAttachments,
 * } = useAttachmentManager(currentAgentId, { enableRagIndex: true });
 * ```
 */
export function useAttachmentManager(
    contextId: string | null,
    options: UseAttachmentManagerOptions = {}
): UseAttachmentManagerReturn {
    const { enableRagIndex = false } = options;
    const { toast } = useToast();
    const { t } = useI18n();

    // ==================== 状态管理 ====================

    // UI 渲染用的状态
    const [pendingAttachments, setPendingAttachments] = useState<AttachmentInfo[]>([]);
    // 是否正在添加附件（用于禁用发送按钮）
    const [isAddingAttachment, setIsAddingAttachment] = useState(false);

    // 并发验证用的 ref（解决闭包问题）
    const pendingAttachmentsRef = useRef<AttachmentInfo[]>([]);
    // 预占计数器（在异步操作开始前立即递增，解决并发验证问题）
    const pendingCountRef = useRef(0);
    const handleAttachmentErrorRef = useRef<(error: unknown) => void>(() => undefined);

    // 切换 Agent/Hub 时：从 store 加载该上下文的附件状态
    // 实现内存级持久化，切换回来时附件还在
    useEffect(() => {
        if (!contextId) {
            pendingAttachmentsRef.current = [];
            pendingCountRef.current = 0;
            setPendingAttachments([]);
            return;
        }

        // 从 store 加载该上下文的附件
        const storedAttachments = useAttachmentViewerStore.getState().getContextAttachments(contextId);
        pendingAttachmentsRef.current = storedAttachments;
        pendingCountRef.current = 0;
        setPendingAttachments(storedAttachments);
        logger.trace('[useAttachmentManager] 上下文切换，加载附件:', contextId, storedAttachments.length);
    }, [contextId]);

    // ==================== 核心方法 ====================

    /**
     * 添加附件（支持多选）
     * 
     * 处理流程：
     * 1. 同步预占验证（数量限制）
     * 2. 异步获取文件大小并验证容量
     * 3. 调用 attachmentService 处理文件
     * 4. 可选：启动 RAG 索引
     */
    const addAttachments = useCallback(async (filePaths: string[], addOptions: AddAttachmentsOptions = {}) => {
        if (!contextId || filePaths.length === 0) return;

        for (const filePath of filePaths) {
            if (pendingAttachmentsRef.current.some(attachment => isSameAttachmentPath(filePath, attachment))) {
                logger.trace('[useAttachmentManager] 附件已存在，跳过重复添加:', filePath);
                continue;
            }

            // ==================== 同步预占验证 ====================
            // 使用计数器立即预占位置，解决并发异步调用期间的验证问题
            const currentOccupied = pendingAttachmentsRef.current.length + pendingCountRef.current;

            if (currentOccupied >= MAX_FILE_COUNT) {
                toast({
                    type: 'warning',
                    title: t('chat.attachmentLimitTitle'),
                    description: t('chat.attachmentLimitDescription', { count: MAX_FILE_COUNT }),
                    duration: 5000,
                });
                logger.trace('[useAttachmentManager] 数量限制拦截:', {
                    current: pendingAttachmentsRef.current.length,
                    pending: pendingCountRef.current,
                });
                return;  // 中断循环，不再处理后续文件
            }

            // 立即预占一个位置（同步操作）
            pendingCountRef.current++;
            logger.trace('[useAttachmentManager] 预占位置:', {
                filePath,
                currentCount: pendingAttachmentsRef.current.length,
                pendingCount: pendingCountRef.current,
            });

            // ==================== 异步操作 ====================
            let fileSize = 0;
            try {
                // 获取文件大小（用于容量验证）
                fileSize = await invoke<number>('file_get_size', { path: filePath });

                // 验证容量限制
                const currentSize = pendingAttachmentsRef.current.reduce((sum, a) => sum + a.size, 0);
                if (currentSize + fileSize > MAX_TOTAL_SIZE) {
                    const remainingMB = ((MAX_TOTAL_SIZE - currentSize) / 1024 / 1024).toFixed(1);
                    const newFileMB = (fileSize / 1024 / 1024).toFixed(1);
                    toast({
                        type: 'warning',
                        title: t('chat.attachmentSizeLimitTitle'),
                        description: t('chat.attachmentSizeLimitDescription', {
                            remaining: remainingMB,
                            current: newFileMB,
                        }),
                        duration: 5000,
                    });
                    // 释放预占位置
                    pendingCountRef.current--;
                    continue;  // 跳过此文件，继续处理后续文件
                }
            } catch (err) {
                // 文件不存在或无法读取，继续到 addAttachment 获取更详细的错误
                logger.warn('[useAttachmentManager] 获取文件大小失败:', err);
            }

            setIsAddingAttachment(true);

            try {
                // 使用 attachmentService 处理文件
                const attachment = await attachmentService.addAttachment(filePath, contextId, {
                    targetDir: addOptions.targetDir,
                });

                // 可选：启动异步 RAG 索引
                if (enableRagIndex && attachment.type === 'document' && attachment.parsedContent) {
                    attachment.indexStatus = 'indexing';
                    attachment.indexingPromise = attachmentService.indexToKnowledge(attachment, contextId)
                        .then(() => {
                            attachment.indexStatus = 'indexed';
                            attachment.indexed = true;
                            logger.trace('[useAttachmentManager]  附件索引完成:', attachment.fileName);
                        })
                        .catch((err: unknown) => {
                            attachment.indexStatus = 'failed';
                            logger.warn('[useAttachmentManager]  附件索引失败:', attachment.fileName, err);
                        });
                    logger.trace('[useAttachmentManager]  异步索引已启动:', attachment.fileName);
                }

                // 同时更新 ref 和 state
                pendingAttachmentsRef.current = [...pendingAttachmentsRef.current, attachment];
                setPendingAttachments(pendingAttachmentsRef.current);
                // 同步到全局 store，供 RightPanel 显示
                useAttachmentViewerStore.getState().setContextAttachments(contextId, pendingAttachmentsRef.current);

                // 自动预览：仅第一个文档类型附件自动预览，图片不自动预览
                // 检查是否为第一个文档（之前没有任何附件）
                const isFirstDocument = attachment.type === 'document' &&
                    pendingAttachmentsRef.current.length === 1;
                if (isFirstDocument) {
                    useAttachmentViewerStore.getState().setDocumentPreview(attachment);
                }

                // 成功添加后释放预占位置
                pendingCountRef.current--;
                logger.trace('[useAttachmentManager] 附件已添加:', attachment.fileName,
                    '当前数量:', pendingAttachmentsRef.current.length,
                    '预占释放后:', pendingCountRef.current);

            } catch (error) {
                logger.error('[useAttachmentManager] 添加附件失败:', error);
                handleAttachmentErrorRef.current(error);
                // 处理失败，释放预占位置
                pendingCountRef.current--;
            } finally {
                setIsAddingAttachment(false);
            }
        }
    }, [contextId, enableRagIndex, toast, t]);

    /**
     * 处理附件添加错误
     * 根据错误类型显示不同的 Toast
     */
    const handleAttachmentError = useCallback((error: unknown) => {
        if (error instanceof ImageCompressionError) {
            if (error.code === CompressionErrorCode.FILE_TOO_LARGE) {
                toast({
                    type: 'warning',
                    title: t('chat.imageTooLargeTitle'),
                    description: t('chat.imageTooLargeDescription'),
                    duration: 5000,
                });
            } else {
                toast({
                    type: 'error',
                    title: t('chat.imageProcessingFailed'),
                    description: error.message,
                    duration: 4000,
                });
            }
        } else if (error instanceof DocumentProcessingError) {
            toast({
                type: 'warning',
                title: t('chat.documentProcessingFailed'),
                description: error.message,
                duration: 5000,
            });
        } else if (error instanceof Error && (
            error.message.includes('Unsupported file format') ||
            error.message.toLowerCase().includes('unsupported file format')
        )) {
            toast({
                type: 'warning',
                title: t('chat.unsupportedFileFormat'),
                description: t('chat.supportedFormats', { formats: SUPPORTED_FORMATS_DISPLAY }),
                duration: 5000,
            });
        } else {
            toast({
                type: 'error',
                title: t('chat.addAttachmentFailed'),
                description: error instanceof Error ? error.message : String(error),
                duration: 4000,
            });
        }
    }, [toast, t]);
    handleAttachmentErrorRef.current = handleAttachmentError;

    /**
     * 移除单个附件
     */
    const removeAttachment = useCallback((attachmentId: string) => {
        if (!contextId) return;
        // 同步更新 ref 和 state
        pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(a => a.id !== attachmentId);
        setPendingAttachments(pendingAttachmentsRef.current);
        // 同步到全局 store
        useAttachmentViewerStore.getState().setContextAttachments(contextId, pendingAttachmentsRef.current);
        logger.trace('[useAttachmentManager] 附件已移除:', attachmentId,
            '剩余数量:', pendingAttachmentsRef.current.length);
    }, [contextId]);

    /**
     * 重排序附件（仅更新数组顺序，不触发重新处理）
     */
    const reorderAttachments = useCallback((reorderedAttachments: AttachmentInfo[]) => {
        // 直接复用现有对象引用，只更新数组顺序
        pendingAttachmentsRef.current = reorderedAttachments;
        setPendingAttachments(reorderedAttachments);
        logger.trace('[useAttachmentManager] 附件顺序已调整:',
            reorderedAttachments.map(a => a.fileName));
    }, []);

    /**
     * 恢复附件列表（撤回消息后调用）
     * 直接复用消息 metadata 中的 AttachmentInfo，避免重新复制/解析/索引同一文件
     */
    const restoreAttachments = useCallback((attachments: AttachmentInfo[]) => {
        if (!contextId || attachments.length === 0) return;

        const mergedAttachments = [...pendingAttachmentsRef.current];
        const knownIdentities = new Set(mergedAttachments.map(getAttachmentIdentity));

        for (const attachment of attachments) {
            if (mergedAttachments.length >= MAX_FILE_COUNT) break;

            const identity = getAttachmentIdentity(attachment);
            if (knownIdentities.has(identity)) continue;

            mergedAttachments.push(attachment);
            knownIdentities.add(identity);
        }

        pendingAttachmentsRef.current = mergedAttachments;
        pendingCountRef.current = 0;
        setPendingAttachments(mergedAttachments);
        useAttachmentViewerStore.getState().setContextAttachments(contextId, mergedAttachments);

        const firstDocument = mergedAttachments.find(attachment => attachment.type === 'document');
        if (firstDocument) {
            useAttachmentViewerStore.getState().setDocumentPreview(firstDocument);
        }

        logger.trace('[useAttachmentManager] 附件已恢复:',
            attachments.map(attachment => attachment.fileName),
            '当前数量:', mergedAttachments.length);
    }, [contextId]);

    /**
     * 清空所有附件（发送消息后调用）
     * 清空本地状态和 store 中的待发送附件列表
     * 但保留右栏的预览内容（previewDocument 不清空）
     */
    const clearAttachments = useCallback(() => {
        pendingAttachmentsRef.current = [];
        pendingCountRef.current = 0;
        setPendingAttachments([]);
        // 清空 store 中的待发送附件列表（底部不再显示）
        // 但不清空 previewDocument，让预览内容保留
        if (contextId) {
            useAttachmentViewerStore.getState().clearContextAttachments(contextId);
        }
        logger.trace('[useAttachmentManager] 附件列表已清空，预览内容保留');
    }, [contextId]);

    /**
     * 获取附件列表副本（用于发送前保存，避免清空后丢失引用）
     */
    const getAttachmentsCopy = useCallback((): AttachmentInfo[] => {
        return [...pendingAttachmentsRef.current];
    }, []);

    return {
        pendingAttachments,
        isAddingAttachment,
        addAttachments,
        removeAttachment,
        reorderAttachments,
        restoreAttachments,
        clearAttachments,
        getAttachmentsCopy,
    };
}
