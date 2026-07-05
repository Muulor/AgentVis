/**
 * MessageActions - 消息操作栏组件
 * 
 * 功能：
 * - 悬停消息时显示
 * - 复制、引用、删除、撤回、多选操作
 */

import { memo, useCallback } from 'react';
import { ListChecks } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './MessageActions.module.css';

// ==================== 类型定义 ====================

interface MessageActionsProps {
    /** 是否为用户消息 */
    isUser: boolean;
    /** 操作回调 */
    onAction: (action: 'copy' | 'quote' | 'delete' | 'revoke' | 'multiselect') => void;
    /** 是否隐藏多选按钮（已在多选模式时隐藏） */
    hideMultiSelect?: boolean;
}

// ==================== 组件实现 ====================

/**
 * MessageActions 消息操作栏
 */
export const MessageActions = memo(function MessageActions({
    isUser,
    onAction,
    hideMultiSelect = false,
}: MessageActionsProps) {
    const { t } = useI18n();
    const handleCopy = useCallback(() => onAction('copy'), [onAction]);
    const handleQuote = useCallback(() => onAction('quote'), [onAction]);
    const handleDelete = useCallback(() => onAction('delete'), [onAction]);
    const handleRevoke = useCallback(() => onAction('revoke'), [onAction]);
    const handleMultiSelect = useCallback(() => onAction('multiselect'), [onAction]);

    return (
        <div className={cx(styles.actions, isUser ? styles.userActions : styles.agentActions)}>
            {/* 多选 */}
            {!hideMultiSelect && (
                <Tooltip content={t('chat.multiSelect')}>
                    <button
                        className={styles.actionBtn}
                        onClick={handleMultiSelect}
                        aria-label={t('chat.multiSelectMessages')}
                    >
                        <ListChecks size={14} />
                    </button>
                </Tooltip>
            )}

            {/* 复制 */}
            <Tooltip content={t('common.copy')}>
                <button
                    className={styles.actionBtn}
                    onClick={handleCopy}
                    aria-label={t('chat.copyMessage')}
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="4" y="4" width="8" height="8" rx="1" />
                        <path d="M2 10V2.5a.5.5 0 0 1 .5-.5H10" />
                    </svg>
                </button>
            </Tooltip>

            {/* 引用 */}
            <Tooltip content={t('common.quote')}>
                <button
                    className={styles.actionBtn}
                    onClick={handleQuote}
                    aria-label={t('chat.quoteMessage')}
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 7c0-2 1.5-4 4-4M7 7c0-2 1.5-4 4-4" />
                        <path d="M3 11V7M7 11V7" />
                    </svg>
                </button>
            </Tooltip>

            {/* 删除 */}
            <Tooltip content={t('common.delete')}>
                <button
                    className={styles.actionBtn}
                    onClick={handleDelete}
                    aria-label={t('chat.deleteMessage')}
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M2 4h10M5 4V2h4v2M5 6v5M9 6v5M3 4l1 8h6l1-8" />
                    </svg>
                </button>
            </Tooltip>

            {/* 撤回（仅用户消息） */}
            {isUser && (
                <Tooltip content={t('chat.revokeMessage')}>
                    <button
                        className={styles.actionBtn}
                        onClick={handleRevoke}
                        aria-label={t('chat.revokeMessage')}
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M2 7h8a2 2 0 0 1 2 2v1M2 7l3-3M2 7l3 3" />
                        </svg>
                    </button>
                </Tooltip>
            )}
        </div>
    );
});
