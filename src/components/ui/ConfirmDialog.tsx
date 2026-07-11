/**
 * ConfirmDialog - 确认对话框组件
 *
 * 用于需要用户确认的危险操作（如删除）。
 * 使用应用 UI 风格，基于 Radix Dialog 构建。
 */

import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ConfirmDialog.module.css';

export type ConfirmDialogVariant = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 确认回调 */
  onConfirm: () => void;
  /** 标题 */
  title: string;
  /** 描述信息 */
  description: string;
  /** 确认按钮文字 */
  confirmText?: string;
  /** 取消按钮文字 */
  cancelText?: string;
  /** 变体类型 */
  variant?: ConfirmDialogVariant;
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 自定义图标（覆盖 variant 默认图标） */
  icon?: React.ReactNode;
  disableDismiss?: boolean;
}

/**
 * 确认对话框
 *
 * 用于删除等危险操作的二次确认
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'danger',
  isLoading = false,
  icon,
  disableDismiss = false,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');

  // 处理确认
  const handleConfirm = () => {
    if (isLoading) return;
    onConfirm();
  };

  // 渲染图标：优先使用自定义图标，否则根据 variant 选择
  const renderIcon = () => {
    if (icon) return icon;
    switch (variant) {
      case 'danger':
        return <Trash2 size={24} />;
      case 'warning':
        return <AlertTriangle size={24} />;
      default:
        return <AlertTriangle size={24} />;
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !disableDismiss && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          onEscapeKeyDown={(event) => {
            if (disableDismiss) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (disableDismiss) {
              event.preventDefault();
            }
          }}
        >
          <div className={styles.header}>
            <div className={cx(styles.iconWrapper, styles[variant])}>{renderIcon()}</div>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          </div>

          <Dialog.Description className={styles.description}>{description}</Dialog.Description>

          <div className={styles.actions}>
            <button className={styles.cancelButton} onClick={onClose} disabled={isLoading}>
              {resolvedCancelText}
            </button>
            <button
              className={cx(styles.confirmButton, styles[variant])}
              onClick={handleConfirm}
              disabled={isLoading}
            >
              {isLoading ? t('common.processing') : resolvedConfirmText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
