/**
 * DiffLine - 单行 Diff 渲染组件
 * 
 * 根据行类型（新增/删除/上下文）渲染不同样式的 Diff 行
 * 
 */

import styles from './DiffLine.module.css';
import type { DiffLine as DiffLineType } from '../../services/fast-apply/types';

// ==================== 类型定义 ====================

export interface DiffLineProps {
    /** Diff 行数据 */
    line: DiffLineType;
    /** 是否显示行号 */
    showLineNumbers?: boolean;
    /** 是否高亮整行（用于手动定位模式） */
    isHighlighted?: boolean;
    /** 点击回调（用于手动定位模式） */
    onClick?: () => void;
}

// ==================== 辅助函数 ====================

/**
 * 获取行前缀符号
 * - add: +
 * - remove: -
 * - context: 空格
 */
function getLinePrefix(type: DiffLineType['type']): string {
    switch (type) {
        case 'add': return '+';
        case 'remove': return '-';
        case 'context': return ' ';
        default: return ' ';
    }
}

/**
 * 获取行类型对应的 CSS 类名
 */
function getLineTypeClass(type: DiffLineType['type']): string {
    switch (type) {
        case 'add': return styles.lineAdd ?? '';
        case 'remove': return styles.lineRemove ?? '';
        case 'context': return styles.lineContext ?? '';
        default: return '';
    }
}

// ==================== 主组件 ====================

export function DiffLine({
    line,
    showLineNumbers = true,
    isHighlighted = false,
    onClick,
}: DiffLineProps) {
    const lineClasses = [
        styles.line,
        getLineTypeClass(line.type),
        isHighlighted ? styles.highlighted : '',
        onClick ? styles.clickable : '',
    ].filter(Boolean).join(' ');

    return (
        <div
            className={lineClasses}
            onClick={onClick}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
        >
            {/* 行号区域 */}
            {showLineNumbers && (
                <>
                    {/* 旧文件行号（删除和上下文行显示） */}
                    <span className={styles.lineNumber}>
                        {line.type !== 'add' ? line.oldLineNumber ?? '' : ''}
                    </span>
                    {/* 新文件行号（新增和上下文行显示） */}
                    <span className={styles.lineNumber}>
                        {line.type !== 'remove' ? line.newLineNumber ?? '' : ''}
                    </span>
                </>
            )}

            {/* 行前缀（+/-/空格） */}
            <span className={styles.linePrefix}>
                {getLinePrefix(line.type)}
            </span>

            {/* 行内容 */}
            <span className={styles.lineContent}>
                {line.content}
            </span>
        </div>
    );
}
