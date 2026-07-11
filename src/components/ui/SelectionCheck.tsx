/**
 * 通用选择标记组件
 *
 * 作为 checkbox / 多选列表的统一视觉层，实际交互与无障碍语义由外层控件负责。
 */

import { Check, Minus } from 'lucide-react';
import { cx } from '@utils/classNames';
import styles from './SelectionCheck.module.css';

interface SelectionCheckProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  shape?: 'rounded' | 'circle';
  size?: 'sm' | 'md';
  className?: string;
}

export function SelectionCheck({
  checked,
  indeterminate = false,
  disabled = false,
  shape = 'rounded',
  size = 'md',
  className,
}: SelectionCheckProps) {
  const active = checked || indeterminate;
  const Icon = indeterminate ? Minus : Check;

  return (
    <span
      className={cx(styles.indicator, styles[shape], styles[size], className)}
      data-checked={active ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      aria-hidden="true"
    >
      <Icon className={styles.icon} strokeWidth={3} />
    </span>
  );
}
