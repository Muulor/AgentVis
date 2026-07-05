/**
 * DiffActions - 迷你操作按钮组件
 * 
 * 在每个 Diff 区块下方显示小型 Accept/Reject 图标按钮
 * 按钮颜色跟随 Diff 风格（柔和红绿色）
 */

import { Check, X } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n } from '@/i18n';
import styles from './DiffActions.module.css';
import type { ApplyStatus } from '../../services/fast-apply/types';

// ==================== 类型定义 ====================

export interface DiffActionsProps {
    /** 当前状态 */
    status: ApplyStatus;
    /** 接受回调 */
    onAccept: () => void;
    /** 拒绝回调 */
    onReject: () => void;
    /** 是否正在处理 */
    isProcessing?: boolean;
}

// ==================== 主组件 ====================

export function DiffActions({
    status,
    onAccept,
    onReject,
    isProcessing = false,
}: DiffActionsProps) {
    const { t } = useI18n();

    // 根据状态渲染不同内容
    if (status === 'applied') {
        return (
            <div className={styles.container}>
                <span className={styles.statusApplied}>{t('diff.accepted')}</span>
            </div>
        );
    }

    if (status === 'rejected') {
        return (
            <div className={styles.container}>
                <span className={styles.statusRejected}>{t('diff.rejected')}</span>
            </div>
        );
    }

    if (status === 'failed') {
        return (
            <div className={styles.container}>
                <span className={styles.statusFailed}>{t('diff.matchFailed')}</span>
            </div>
        );
    }

    // pending 状态：显示 Accept/Reject 按钮
    return (
        <div className={styles.container}>
            <Tooltip content={t('diff.acceptChange')}>
                <button
                    className={styles.acceptBtn}
                    onClick={onAccept}
                    disabled={isProcessing}
                    aria-label={t('diff.acceptChange')}
                >
                    <Check size={14} />
                </button>
            </Tooltip>
            <Tooltip content={t('diff.rejectChange')}>
                <button
                    className={styles.rejectBtn}
                    onClick={onReject}
                    disabled={isProcessing}
                    aria-label={t('diff.rejectChange')}
                >
                    <X size={14} />
                </button>
            </Tooltip>
        </div>
    );
}
