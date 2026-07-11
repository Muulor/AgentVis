/**
 * CollapsibleSection - 可折叠区块组件
 *
 * 通用可折叠容器
 *
 */

import { useState, useCallback, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cx } from '@utils/classNames';
import styles from './CollapsibleSection.module.css';

export interface CollapsibleSectionProps {
  /** 区块标题 */
  title: ReactNode;
  /** 标题图标（可选） */
  icon?: ReactNode;
  /** 标题旁的状态标签（如 "● 进行中"） */
  statusBadge?: ReactNode;
  /** 折叠时显示的摘要信息 */
  collapsedSummary?: string;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
  /** 受控模式：是否展开 */
  isExpanded?: boolean;
  /** 受控模式：展开切换回调 */
  onToggle?: () => void;
  /** 子内容 */
  children: ReactNode;
  /** 额外的 CSS 类名 */
  className?: string;
}

/**
 * 可折叠区块组件
 */
export function CollapsibleSection({
  title,
  icon,
  statusBadge,
  collapsedSummary,
  defaultExpanded = false,
  isExpanded: controlledExpanded,
  onToggle,
  children,
  className,
}: CollapsibleSectionProps) {
  // 内部状态（非受控模式使用）
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  // 判断是否受控模式
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  // 切换处理
  const handleToggle = useCallback(() => {
    if (isControlled && onToggle) {
      onToggle();
    } else if (!isControlled) {
      setInternalExpanded((prev) => !prev);
    }
  }, [isControlled, onToggle]);

  return (
    <div className={cx(styles.container, className)}>
      {/* 标题栏 */}
      <button
        type="button"
        className={styles.header}
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        {/* 左侧：图标 + 标题 + 状态标签 */}
        <div className={styles.headerLeft}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <span className={styles.title}>{title}</span>
          {statusBadge && <span className={styles.statusBadge}>{statusBadge}</span>}
        </div>

        {/* 右侧：折叠按钮 */}
        <div className={styles.toggleButton}>
          {expanded ? (
            <>
              <span>Collapse</span>
              <ChevronDown size={14} />
            </>
          ) : (
            <>
              {collapsedSummary && (
                <span className={styles.collapsedSummary}>{collapsedSummary}</span>
              )}
              <ChevronRight size={14} />
            </>
          )}
        </div>
      </button>

      {/* 分隔线（展开时显示） */}
      {expanded && <div className={styles.divider} />}

      {/* 内容区域（带动画） */}
      <div
        className={cx(styles.content, expanded ? styles.expanded : styles.collapsed)}
        aria-hidden={!expanded}
      >
        <div className={styles.contentInner}>{children}</div>
      </div>
    </div>
  );
}
