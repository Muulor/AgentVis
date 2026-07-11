/**
 * DiffViewer - 双栏对比查看器组件
 *
 * 左栏显示原文（删除高亮），右栏显示新文（新增高亮）
 * 支持行号同步滚动
 *
 */

import { useRef, useCallback } from 'react';
import { useI18n } from '@/i18n';
import styles from './DiffViewer.module.css';
import { DiffLine } from './DiffLine';
import type { DiffResult, DiffHunk } from '../../services/fast-apply/types';

// ==================== 类型定义 ====================

export interface DiffViewerProps {
  /** Diff 结果数据 */
  diff: DiffResult;
  /** 文件名称 */
  fileName?: string;
  /** 是否启用手动定位模式 */
  isLocatingMode?: boolean;
  /** 行点击回调（手动定位模式） */
  onLineClick?: (lineNumber: number) => void;
  /** 选中的行号（手动定位模式） */
  selectedLine?: number;
  /** 最大高度 */
  maxHeight?: number;
}

interface DiffHunkViewProps {
  /** Diff 块数据 */
  hunk: DiffHunk;
  /** 块索引 */
  index: number;
  /** 是否是手动定位模式 */
  isLocatingMode?: boolean;
  /** 行点击回调 */
  onLineClick?: (lineNumber: number) => void;
  /** 选中的行号 */
  selectedLine?: number;
}

// ==================== 子组件 ====================

/**
 * DiffHunk 渲染组件
 *
 * 渲染单个 Diff 块（Hunk），包含头部信息和行内容
 */
function DiffHunkView({
  hunk,
  index,
  isLocatingMode = false,
  onLineClick,
  selectedLine,
}: DiffHunkViewProps) {
  return (
    <div className={styles.hunk}>
      {/* Hunk 头部：@@ 格式行号范围，与 git diff 保持一致 */}
      <div className={styles.hunkHeader}>
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>

      {/* Hunk 内容：渲染每一行 */}
      <div className={styles.hunkContent}>
        {hunk.lines.map((line, lineIndex) => {
          // 计算实际行号用于手动定位
          const actualLineNumber = line.newLineNumber ?? line.oldLineNumber ?? 0;
          const isSelected = selectedLine === actualLineNumber;

          return (
            <DiffLine
              key={`${index}-${lineIndex}`}
              line={line}
              showLineNumbers={true}
              isHighlighted={isSelected}
              onClick={
                isLocatingMode && onLineClick ? () => onLineClick(actualLineNumber) : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * 统计信息组件
 */
function DiffStats({ diff }: { diff: DiffResult }) {
  // 计算新增/删除行数
  const stats = {
    added: diff.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === 'add').length, 0),
    removed: diff.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === 'remove').length,
      0
    ),
  };

  return (
    <div className={styles.stats}>
      <span className={styles.statsAdded}>+{stats.added}</span>
      <span className={styles.statsRemoved}>-{stats.removed}</span>
    </div>
  );
}

// ==================== 主组件 ====================

export function DiffViewer({
  diff,
  fileName = 'document',
  isLocatingMode = false,
  onLineClick,
  selectedLine,
  maxHeight,
}: DiffViewerProps) {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 处理滚动同步（预留用于双栏模式）
  const handleScroll = useCallback(() => {
    // 未来实现双栏同步滚动
  }, []);

  // 无变更状态
  if (!diff.hasChanges) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.fileName}>{fileName}</span>
        </div>
        <div className={styles.noChanges}>
          <svg
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="16" cy="16" r="12" />
            <path d="M11 16l4 4 6-8" />
          </svg>
          <p>{t('diff.noChanges')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* 头部：文件名和统计 */}
      <div className={styles.header}>
        <span className={styles.fileName}>{fileName}</span>
        <DiffStats diff={diff} />
      </div>

      {/* 手动定位模式提示 */}
      {isLocatingMode && (
        <div className={styles.locatingHint}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3M8 10v1" />
          </svg>
          {t('diff.locatingHint')}
        </div>
      )}

      {/* Diff 内容区域：maxHeight 未设置时不限制高度（全面板预览模式由外层控制滚动）*/}
      <div
        ref={scrollContainerRef}
        className={styles.diffContent}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
        onScroll={handleScroll}
      >
        {diff.hunks.map((hunk, index) => (
          <DiffHunkView
            key={index}
            hunk={hunk}
            index={index}
            isLocatingMode={isLocatingMode}
            onLineClick={onLineClick}
            selectedLine={selectedLine}
          />
        ))}
      </div>
    </div>
  );
}
