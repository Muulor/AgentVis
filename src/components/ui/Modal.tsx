import React, { useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useI18n } from '@/i18n';
import styles from './Modal.module.css';

/**
 * Modal 组件属性
 */
interface ModalProps {
    /** 是否打开 */
    open: boolean;
    /** 关闭回调 */
    onClose: () => void;
    /** 标题 */
    title?: string;
    /** 描述 */
    description?: string;
    /** 模态框内容 */
    children: React.ReactNode;
    /** 自定义宽度 */
    width?: number;
}

/**
 * Modal 模态对话框组件
 *
 * 基于 Radix UI Dialog 构建，居中显示
 */
export function Modal({
    open,
    onClose,
    title,
    description,
    children,
    width = 480,
}: ModalProps) {
    const { t } = useI18n();

    // ESC 键关闭
    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        },
        [onClose]
    );

    useEffect(() => {
        if (open) {
            document.addEventListener('keydown', handleKeyDown);
            return () => document.removeEventListener('keydown', handleKeyDown);
        }
    }, [open, handleKeyDown]);

    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className={styles.overlay} />
                <Dialog.Content
                    className={styles.content}
                    style={{ width }}
                    aria-describedby={description ? undefined : undefined}
                >
                    {title && (
                        <Dialog.Title className={styles.title}>{title}</Dialog.Title>
                    )}
                    {description && (
                        <Dialog.Description className={styles.description}>
                            {description}
                        </Dialog.Description>
                    )}
                    <div className={styles.body}>{children}</div>
                    <Dialog.Close asChild>
                        <button className={styles.closeButton} aria-label={t('common.close')}>
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                        </button>
                    </Dialog.Close>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
