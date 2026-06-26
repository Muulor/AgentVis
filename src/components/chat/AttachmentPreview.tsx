/**
 * AttachmentPreview - 输入区附件预览组件
 * 
 * 功能：
 * - 显示待发送附件列表
 * - 显示文件图标和文件名（图片显示缩略图）
 * - 提供删除按钮
 * - 点击附件可预览（图片打开 Lightbox，文档打开右栏预览）
 * - 支持拖拽调整附件顺序
 */

import { memo, useCallback, useState, useMemo, type ReactElement } from 'react';
import type { AttachmentInfo } from '@/types/message';
import { useAttachmentViewerStore } from '@/stores/attachmentViewerStore';
import { useI18n } from '@/i18n';
import styles from './AttachmentPreview.module.css';

// ==================== 类型定义 ====================

interface AttachmentPreviewProps {
    /** 附件列表 */
    attachments: AttachmentInfo[];
    /** 移除附件回调 */
    onRemove: (id: string) => void;
    /** 重新排序回调 */
    onReorder?: (reorderedAttachments: AttachmentInfo[]) => void;
    /** 是否启用拖拽排序（默认 true） */
    enableDrag?: boolean;
}

// ==================== 工具函数 ====================

/**
 * 根据附件类型获取图标
 */
function getAttachmentIcon(type: 'image' | 'document'): ReactElement {
    if (type === 'image') {
        // Image 图标
        return (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
        );
    }

    // 文档图标（FileText）
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            <path d="M10 9H8" />
            <path d="M16 13H8" />
            <path d="M16 17H8" />
        </svg>
    );
}

/**
 * 截断文件名
 */
function truncateFileName(name: string, maxLength: number = 20): string {
    if (name.length <= maxLength) return name;

    const lastDot = name.lastIndexOf('.');
    if (lastDot === -1) {
        return name.substring(0, maxLength - 3) + '...';
    }

    const ext = name.substring(lastDot);
    const base = name.substring(0, lastDot);
    const maxBase = maxLength - ext.length - 3;

    if (maxBase < 3) {
        return name.substring(0, maxLength - 3) + '...';
    }

    return base.substring(0, maxBase) + '...' + ext;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ==================== 子组件 ======================================

interface AttachmentItemProps {
    attachment: AttachmentInfo;
    index: number;
    onRemove: (id: string) => void;
    onPreview: (attachment: AttachmentInfo) => void;
    // 拖拽相关
    enableDrag: boolean;
    isDragging: boolean;
    isDragOver: boolean;
    onDragStart: (e: React.DragEvent, index: number) => void;
    onDragOver: (e: React.DragEvent, index: number) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent, index: number) => void;
    onDragEnd: () => void;
}

const AttachmentItem = memo(function AttachmentItem({
    attachment,
    index,
    onRemove,
    onPreview,
    enableDrag,
    isDragging,
    isDragOver,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
}: AttachmentItemProps) {
    const { t } = useI18n();
    const handleRemove = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // 阻止触发预览
        onRemove(attachment.id);
    }, [attachment.id, onRemove]);

    const handleClick = useCallback(() => {
        onPreview(attachment);
    }, [attachment, onPreview]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPreview(attachment);
        }
    }, [attachment, onPreview]);

    // 构建 className
    const itemClassName = [
        styles.item,
        styles.itemClickable,
        isDragging && styles.dragging,
        isDragOver && styles.dragOver,
    ].filter(Boolean).join(' ');

    return (
        <div
            className={itemClassName}
            data-type={attachment.type}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={0}
            title={t('chat.previewAttachment', { name: attachment.fileName })}
            // 拖拽属性
            draggable={enableDrag}
            onDragStart={(e) => {
                // 设置自定义 MIME 类型，标记为内部附件拖拽（而非文件上传）
                e.dataTransfer.setData('application/x-attachment-reorder', index.toString());
                e.dataTransfer.effectAllowed = 'move';
                // 阻止事件冒泡到父容器，避免触发 ChatInput 的文件拖放
                e.stopPropagation();
                onDragStart(e, index);
            }}
            onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDragOver(e, index);
            }}
            onDragLeave={(e) => {
                e.stopPropagation();
                onDragLeave();
            }}
            onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDrop(e, index);
            }}
            onDragEnd={(e) => {
                e.stopPropagation();
                onDragEnd();
            }}
        >
            {/* 拖拽手柄 */}
            {enableDrag && (
                <span className={styles.dragHandle} title={t('chat.dragToReorder')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="9" cy="6" r="1.5" />
                        <circle cx="15" cy="6" r="1.5" />
                        <circle cx="9" cy="12" r="1.5" />
                        <circle cx="15" cy="12" r="1.5" />
                        <circle cx="9" cy="18" r="1.5" />
                        <circle cx="15" cy="18" r="1.5" />
                    </svg>
                </span>
            )}

            {/* 图标 */}
            <span className={styles.icon}>
                {getAttachmentIcon(attachment.type)}
            </span>

            <span className={styles.fileName} title={attachment.fileName}>
                {truncateFileName(attachment.fileName)}
            </span>
            <span className={styles.size}>
                {formatFileSize(attachment.size)}
            </span>
            <button
                className={styles.removeBtn}
                onClick={handleRemove}
                aria-label={t('chat.removeAttachmentName', { name: attachment.fileName })}
                title={t('chat.removeAttachment')}
            >
                {/* X 图标 */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                </svg>
            </button>
        </div>
    );
});

// ==================== 主组件 ====================

/**
 * AttachmentPreview 附件预览组件
 * 
 * 支持点击预览和拖拽排序
 */
export const AttachmentPreview = memo(function AttachmentPreview({
    attachments,
    onRemove,
    onReorder,
    enableDrag = true,
}: AttachmentPreviewProps) {
    const { openImageLightbox, setDocumentPreview } = useAttachmentViewerStore();

    // 拖拽状态
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    // 处理点击预览
    const handlePreview = useCallback((attachment: AttachmentInfo) => {
        if (attachment.type === 'image') {
            // 图片：打开 Lightbox，传递所有图片附件用于轮播
            const allImages = attachments.filter(a => a.type === 'image');
            openImageLightbox(attachment, allImages);
        } else {
            // 文档：通知右栏打开预览
            setDocumentPreview(attachment);
        }
    }, [openImageLightbox, setDocumentPreview, attachments]);

    // ==================== 拖拽事件处理 ====================

    const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
        setDraggedIndex(index);
        e.dataTransfer.effectAllowed = 'move';
        // 设置拖拽数据（用于识别是否是内部拖拽）
        e.dataTransfer.setData('text/plain', index.toString());
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (draggedIndex !== null && draggedIndex !== index) {
            setDragOverIndex(index);
        }
    }, [draggedIndex]);

    const handleDragLeave = useCallback(() => {
        setDragOverIndex(null);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
        e.preventDefault();

        if (draggedIndex === null || draggedIndex === dropIndex || !onReorder) {
            setDraggedIndex(null);
            setDragOverIndex(null);
            return;
        }

        // 计算新顺序
        // 注意：直接复用现有对象引用，不创建新对象，避免触发重新处理
        const newAttachments = [...attachments];
        const [draggedItem] = newAttachments.splice(draggedIndex, 1);

        // 安全检查：确保被拖拽的项存在
        if (!draggedItem) {
            setDraggedIndex(null);
            setDragOverIndex(null);
            return;
        }

        newAttachments.splice(dropIndex, 0, draggedItem);

        // 调用回调更新顺序
        onReorder(newAttachments);

        // 清理状态
        setDraggedIndex(null);
        setDragOverIndex(null);
    }, [draggedIndex, attachments, onReorder]);

    const handleDragEnd = useCallback(() => {
        setDraggedIndex(null);
        setDragOverIndex(null);
    }, []);

    // 判断是否实际启用拖拽（需要有回调且附件数量 > 1）
    const isDragEnabled = useMemo(() => {
        return enableDrag && !!onReorder && attachments.length > 1;
    }, [enableDrag, onReorder, attachments.length]);

    if (attachments.length === 0) {
        return null;
    }

    return (
        <div className={styles.container}>
            {attachments.map((attachment, index) => (
                <AttachmentItem
                    key={attachment.id}
                    attachment={attachment}
                    index={index}
                    onRemove={onRemove}
                    onPreview={handlePreview}
                    enableDrag={isDragEnabled}
                    isDragging={draggedIndex === index}
                    isDragOver={dragOverIndex === index}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                />
            ))}
        </div>
    );
});
