/**
 * CollapsedLines - 折叠行组件
 *
 * 显示折叠占位符，点击展开隐藏的上下文行
 *
 * @example
 * <CollapsedLines lineCount={73} onExpand={() => handleExpand(regionIndex)} />
 */

import styles from './CollapsedLines.module.css';

// ==================== 类型定义 ====================

export interface CollapsedLinesProps {
    /** 折叠的行数 */
    lineCount: number;
    /** 展开回调 */
    onExpand: () => void;
}

// ==================== 主组件 ====================

export function CollapsedLines({ lineCount, onExpand }: CollapsedLinesProps) {
    return (
        <div
            className={styles.container}
            onClick={onExpand}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onExpand();
                }
            }}
        >
            <div className={styles.line} />
            <span className={styles.text}>
                <svg
                    className={styles.icon}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                >
                    <path d="M2 4l4 4 4-4" />
                </svg>
                Expand {lineCount} more lines
            </span>
            <div className={styles.line} />
        </div>
    );
}
