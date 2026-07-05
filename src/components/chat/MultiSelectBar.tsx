/**
 * MultiSelectBar - 多选浮动操作栏组件
 *
 * 功能：
 * - 固定浮动在消息列表底部
 * - 显示选中数量 + 批量操作按钮（复制/引用/删除/取消）
 * - 毛玻璃背景效果
 */

import { memo } from 'react';
import { Copy, Quote, Trash2, X, CheckSquare } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './MultiSelectBar.module.css';

// ==================== 类型定义 ====================

interface MultiSelectBarProps {
    /** 已选消息数量 */
    selectedCount: number;
    /** 复制回调 */
    onCopy: () => void;
    /** 引用回调 */
    onQuote: () => void;
    /** 删除回调 */
    onDelete: () => void;
    /** 取消多选回调 */
    onCancel: () => void;
}

// ==================== 组件实现 ====================

export const MultiSelectBar = memo(function MultiSelectBar({
    selectedCount,
    onCopy,
    onQuote,
    onDelete,
    onCancel,
}: MultiSelectBarProps) {
    const { t } = useI18n();
    return (
        <div className={styles.bar}>
            {/* 选中数量 */}
            <div className={styles.countSection}>
                <CheckSquare size={16} className={styles.countIcon} />
                <span className={styles.countText}>{t('chat.selectedMessages', { count: selectedCount })}</span>
            </div>

            {/* 分隔线 */}
            <div className={styles.divider} />

            {/* 操作按钮 */}
            <div className={styles.actions}>
                <Tooltip content={t('common.copy')} disabled={selectedCount === 0}>
                    <button
                        className={styles.actionBtn}
                        onClick={onCopy}
                        disabled={selectedCount === 0}
                        aria-label={t('chat.copySelected')}
                    >
                        <Copy size={15} />
                        <span>{t('common.copy')}</span>
                    </button>
                </Tooltip>

                <Tooltip content={t('common.quote')} disabled={selectedCount === 0}>
                    <button
                        className={styles.actionBtn}
                        onClick={onQuote}
                        disabled={selectedCount === 0}
                        aria-label={t('chat.quoteSelected')}
                    >
                        <Quote size={15} />
                        <span>{t('common.quote')}</span>
                    </button>
                </Tooltip>

                <Tooltip content={t('common.delete')} disabled={selectedCount === 0}>
                    <button
                        className={cx(styles.actionBtn, styles.dangerBtn)}
                        onClick={onDelete}
                        disabled={selectedCount === 0}
                        aria-label={t('chat.deleteSelected')}
                    >
                        <Trash2 size={15} />
                        <span>{t('common.delete')}</span>
                    </button>
                </Tooltip>
            </div>

            {/* 分隔线 */}
            <div className={styles.divider} />

            {/* 取消按钮 */}
            <Tooltip content={t('chat.cancelMultiSelect')}>
                <button
                    className={styles.cancelBtn}
                    onClick={onCancel}
                    aria-label={t('chat.cancelMultiSelect')}
                >
                    <X size={15} />
                    <span>{t('common.cancel')}</span>
                </button>
            </Tooltip>
        </div>
    );
});
