/**
 * SelectCheckbox - 多选圆圈指示器组件
 *
 * 功能：
 * - 未选中：空心圆（边框）
 * - 选中：实心圆 + 白色对勾图标
 * - 过渡动画：150ms ease
 */

import { memo, useCallback } from 'react';
import { Check } from 'lucide-react';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './SelectCheckbox.module.css';

// ==================== 类型定义 ====================

interface SelectCheckboxProps {
    /** 是否选中 */
    checked: boolean;
    /** 切换回调 */
    onChange: () => void;
}

// ==================== 组件实现 ====================

export const SelectCheckbox = memo(function SelectCheckbox({
    checked,
    onChange,
}: SelectCheckboxProps) {
    const { t } = useI18n();
    // 阻止事件冒泡，避免触发消息气泡的点击
    const handleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        onChange();
    }, [onChange]);

    return (
        <button
            className={cx(styles.checkbox, checked && styles.checked)}
            onClick={handleClick}
            aria-label={checked ? t('chat.unselectMessage') : t('chat.selectMessage')}
            aria-pressed={checked}
        >
            {checked && <Check size={12} strokeWidth={3} className={styles.checkIcon} />}
        </button>
    );
});
