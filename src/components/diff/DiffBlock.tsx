/**
 * DiffBlock - 修改区块组件
 *
 * 渲染单个修改区块，嵌入在全文视图中
 * 包含删除行 + 新增行 + 迷你操作按钮
 *
 * @see FullFileDiffViewer 使用此组件渲染每个修改块
 */

import { memo, useMemo } from 'react';
import styles from './DiffBlock.module.css';
import { DiffLine } from './DiffLine';
import { DiffActions } from './DiffActions';
import { applyDiffBlockSyntaxTokenBudget } from './DiffBlockTokenBudget';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { getDiffLineTokens, type DiffSyntaxHighlightData } from './DiffSyntaxHighlight';
import type { FullFileDiffLine, ApplyStatus } from '../../services/fast-apply/types';

// ==================== 类型定义 ====================

export interface DiffBlockProps {
  /** 修改 ID */
  modificationId: string;
  /** 属于此修改的所有行 */
  lines: FullFileDiffLine[];
  /** 当前状态 */
  status: ApplyStatus;
  /** 全文件语法高亮结果；未生成时使用纯文本 */
  syntaxHighlight?: DiffSyntaxHighlightData | null;
  /** 当前文档已展开的长行对象 */
  expandedLines?: ReadonlySet<FullFileDiffLine>;
  /** 长行展开状态变化回调 */
  onLongLineExpandedChange?: (line: FullFileDiffLine, expanded: boolean) => void;
}

export interface DiffBlockActionsProps {
  /** 修改 ID */
  modificationId: string;
  /** 当前状态 */
  status: ApplyStatus;
  /** 接受回调 */
  onAccept: () => void;
  /** 拒绝回调 */
  onReject: () => void;
  /** 是否正在处理 */
  isProcessing?: boolean;
}

// ==================== 辅助函数 ====================

/**
 * 获取状态对应的样式类
 */
function getStatusClass(status: ApplyStatus): string {
  switch (status) {
    case 'applied':
      return styles.statusApplied ?? '';
    case 'rejected':
      return styles.statusRejected ?? '';
    case 'failed':
      return styles.statusFailed ?? '';
    default:
      return '';
  }
}

// ==================== 主组件 ====================

function DiffBlockComponent({
  modificationId,
  lines,
  status,
  syntaxHighlight,
  expandedLines,
  onLongLineExpandedChange,
}: DiffBlockProps) {
  const statusClass = getStatusClass(status);
  const syntaxTokensByLine = useMemo(
    () =>
      applyDiffBlockSyntaxTokenBudget(
        lines.map((line) => getDiffLineTokens(line, syntaxHighlight ?? null))
      ),
    [lines, syntaxHighlight]
  );

  return (
    <div className={cx(styles.container, statusClass)} data-modification-id={modificationId}>
      <div className={styles.content}>
        {lines.map((line, index) => (
          <DiffLine
            key={`${modificationId}-${index}`}
            line={line}
            showLineNumbers={true}
            syntaxTokens={syntaxTokensByLine[index]}
            isLongLineExpanded={expandedLines?.has(line)}
            onLongLineExpandedChange={
              onLongLineExpandedChange
                ? (expanded) => onLongLineExpandedChange(line, expanded)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 独立的修改审批虚拟行。
 *
 * 与代码行分离后，接受/拒绝仍作用于完整 modification，且无需让所有修改行常驻 DOM。
 */
function DiffBlockActionsComponent({
  modificationId,
  status,
  onAccept,
  onReject,
  isProcessing = false,
}: DiffBlockActionsProps) {
  const { t } = useI18n();
  const statusClass = getStatusClass(status);
  const isPending = status === 'pending';

  return (
    <div className={cx(styles.actionRow, statusClass)} data-modification-id={modificationId}>
      {isPending && (
        <div className={styles.actions}>
          <DiffActions
            status={status}
            onAccept={onAccept}
            onReject={onReject}
            isProcessing={isProcessing}
          />
        </div>
      )}

      {/* 底部状态标签（非 pending 状态显示） */}
      {!isPending && (
        <div className={styles.statusLabel}>
          {status === 'applied' && t('diff.statusAccepted')}
          {status === 'rejected' && t('diff.statusRejected')}
          {status === 'failed' && t('diff.statusFailed')}
        </div>
      )}
    </div>
  );
}

export const DiffBlock = memo(DiffBlockComponent);
export const DiffBlockActions = memo(DiffBlockActionsComponent);
