/**
 * AttachmentCard - 消息区附件卡片组件
 * 
 * 功能：
 * - 在用户消息上方显示附件信息
 * - 显示文件图标和文件名
 * - 深色背景样式
 * - 点击图片附件打开 Lightbox 预览
 * - 点击文档附件在右栏 FilePreview 打开
 */

import { memo, useCallback, type ReactElement } from 'react';
import type { AttachmentInfo } from '@/types/message';
import { useAttachmentViewerStore } from '@/stores/attachmentViewerStore';
import { useI18n } from '@/i18n';
import styles from './AttachmentCard.module.css';

// ==================== 类型定义 ====================

interface AttachmentCardProps {
    /** 附件列表 */
    attachments: AttachmentInfo[];
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
function truncateFileName(name: string, maxLength: number = 25): string {
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

// ==================== 组件实现 ====================

/**
 * AttachmentCard 消息附件卡片
 */
export const AttachmentCard = memo(function AttachmentCard({
    attachments,
}: AttachmentCardProps) {
    const { t } = useI18n();
    const { openImageLightbox, setDocumentPreview } = useAttachmentViewerStore();

    // 处理附件点击
    const handleAttachmentClick = useCallback((attachment: AttachmentInfo) => {
        if (attachment.type === 'image') {
            // 图片：打开 Lightbox，传递所有图片附件用于轮播
            const allImages = attachments.filter(a => a.type === 'image');
            openImageLightbox(attachment, allImages);
        } else {
            // 文档：通知右栏打开预览
            setDocumentPreview(attachment);
        }
    }, [openImageLightbox, setDocumentPreview, attachments]);

    if (attachments.length === 0) {
        return null;
    }

    return (
        <div className={styles.container}>
            {attachments.map(attachment => (
                <div
                    key={attachment.id}
                    className={styles.item}
                    data-type={attachment.type}
                    title={t('chat.previewAttachment', { name: attachment.fileName })}
                    onClick={() => handleAttachmentClick(attachment)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleAttachmentClick(attachment);
                        }
                    }}
                >
                    <span className={styles.icon}>
                        {getAttachmentIcon(attachment.type)}
                    </span>
                    <span className={styles.fileName}>
                        {truncateFileName(attachment.fileName)}
                    </span>
                    {attachment.indexed && (
                        <span className={styles.indexedBadge} title={t('chat.indexedToKnowledge')}>
                            ✓
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
});
