/**
 * AttachmentButton - 附件上传按钮组件
 * 
 * 功能：
 * - 点击打开文件选择对话框
 * - 使用 Paperclip 图标
 * - 与 ModeSelector 风格一致
 */

import { memo, useCallback } from 'react';
import { attachmentService } from '@/services/attachment';
import { useI18n } from '@/i18n';
import styles from './AttachmentButton.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('AttachmentButton');

// ==================== 类型定义 ====================

interface AttachmentButtonProps {
    /** 文件选择回调（支持多选） */
    onFileSelect: (filePaths: string[]) => void | Promise<void>;
    /** 是否禁用 */
    disabled?: boolean;
}

// ==================== 组件实现 ====================

/**
 * AttachmentButton 附件上传按钮
 */
export const AttachmentButton = memo(function AttachmentButton({
    onFileSelect,
    disabled = false,
}: AttachmentButtonProps) {
    const { t } = useI18n();
    // 处理点击事件
    const handleClick = useCallback(async () => {
        if (disabled) return;

        try {
            const filePaths = await attachmentService.selectFiles();
            if (filePaths.length > 0) {
                await onFileSelect(filePaths);
            }
        } catch (error) {
            logger.error('[AttachmentButton] 文件选择失败:', error);
        }
    }, [disabled, onFileSelect]);

    return (
        <button
            className={styles.button}
            onClick={handleClick}
            disabled={disabled}
            aria-label={t('chat.addAttachment')}
            title={t('chat.addAttachment')}
        >
            {/* Lucide Paperclip 图标 */}
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.58 8.58a2 2 0 1 1-2.83-2.83l8.49-8.48" />
            </svg>
        </button>
    );
});
