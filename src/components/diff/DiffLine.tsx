/**
 * DiffLine - 单行 Diff 渲染组件
 *
 * 根据行类型（新增/删除/上下文）渲染不同样式的 Diff 行
 *
 */

import { memo, useEffect, useState } from 'react';
import type { Token } from 'prism-react-renderer';
import { useI18n } from '@/i18n';
import styles from './DiffLine.module.css';
import {
  buildDiffLinePreview,
  buildExpandedDiffLinePreview,
  MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS,
} from './DiffLinePreview';
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
  /** Prism 按行生成的语法 token；缺失时保持纯文本渲染 */
  syntaxTokens?: Token[];
  /** 由虚拟化父级持有的长行展开状态；省略时使用组件本地状态 */
  isLongLineExpanded?: boolean;
  /** 长行展开状态变化回调 */
  onLongLineExpandedChange?: (expanded: boolean) => void;
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
    case 'add':
      return '+';
    case 'remove':
      return '-';
    case 'context':
      return ' ';
    default:
      return ' ';
  }
}

/**
 * 获取行类型对应的 CSS 类名
 */
function getLineTypeClass(type: DiffLineType['type']): string {
  switch (type) {
    case 'add':
      return styles.lineAdd ?? '';
    case 'remove':
      return styles.lineRemove ?? '';
    case 'context':
      return styles.lineContext ?? '';
    default:
      return '';
  }
}

// ==================== 主组件 ====================

function DiffLineComponent({
  line,
  showLineNumbers = true,
  isHighlighted = false,
  onClick,
  syntaxTokens,
  isLongLineExpanded: controlledLongLineExpanded,
  onLongLineExpandedChange,
}: DiffLineProps) {
  const { t } = useI18n();
  const [uncontrolledLongLineState, setUncontrolledLongLineState] = useState({
    content: line.content,
    expanded: false,
  });
  const uncontrolledLongLineExpanded =
    uncontrolledLongLineState.content === line.content && uncontrolledLongLineState.expanded;
  const isLongLineExpanded = controlledLongLineExpanded ?? uncontrolledLongLineExpanded;
  const preview = buildDiffLinePreview(line.content);
  const isLongLine = preview.isTruncated;
  const renderedPreview = isLongLineExpanded ? buildExpandedDiffLinePreview(line.content) : preview;

  useEffect(() => {
    setUncontrolledLongLineState((current) =>
      current.content === line.content ? current : { content: line.content, expanded: false }
    );
  }, [line.content]);
  const lineClasses = [
    styles.line,
    getLineTypeClass(line.type),
    isHighlighted ? styles.highlighted : '',
    onClick ? styles.clickable : '',
  ]
    .filter(Boolean)
    .join(' ');

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
            {line.type !== 'add' ? (line.oldLineNumber ?? '') : ''}
          </span>
          {/* 新文件行号（新增和上下文行显示） */}
          <span className={styles.lineNumber}>
            {line.type !== 'remove' ? (line.newLineNumber ?? '') : ''}
          </span>
        </>
      )}

      {/* 行前缀（+/-/空格） */}
      <span className={styles.linePrefix}>{getLinePrefix(line.type)}</span>

      {/* 行内容 */}
      <span className={styles.lineContent}>
        {isLongLine && (
          <button
            type="button"
            className={styles.longLineToggle}
            aria-expanded={isLongLineExpanded}
            onClick={(event) => {
              event.stopPropagation();
              const nextExpanded = !isLongLineExpanded;
              if (controlledLongLineExpanded === undefined) {
                setUncontrolledLongLineState({ content: line.content, expanded: nextExpanded });
              }
              onLongLineExpandedChange?.(nextExpanded);
            }}
          >
            {isLongLineExpanded
              ? t('diff.collapseLongLine')
              : t('diff.expandLongLine', {
                  count: Math.min(line.content.length, MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS),
                })}
          </button>
        )}
        {isLongLine && renderedPreview.isTruncated ? (
          <>
            {renderedPreview.leading}
            <span className={styles.longLineOmission}>
              {t('diff.longLineOmitted', { count: renderedPreview.omittedChars })}
            </span>
            {renderedPreview.trailing}
          </>
        ) : syntaxTokens && !isLongLine ? (
          syntaxTokens.map((token, index) => (
            <span key={index} className={`token ${token.types.join(' ')}`}>
              {token.content}
            </span>
          ))
        ) : (
          line.content
        )}
      </span>
    </div>
  );
}

export const DiffLine = memo(DiffLineComponent);
