/**
 * FullFileDiffViewer - 全文档 Diff 查看器
 *
 * 显示完整文档，修改区块嵌入其中，无变化区域可折叠
 * 取代 InlineDiffViewer 的分块显示模式
 *
 * @example
 * <FullFileDiffViewer
 *     originalContent={content}
 *     modifications={mods}
 *     fileName="example.txt"
 *     onAccept={handleAccept}
 *     onReject={handleReject}
 *     onAcceptAll={handleAcceptAll}
 *     onRejectAll={handleRejectAll}
 * />
 */

import { useState, useMemo, useCallback, useEffect, useRef, type UIEvent } from 'react';
import { AlertTriangle, CheckCheck, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import styles from './FullFileDiffViewer.module.css';
import { DiffLine } from './DiffLine';
import { DiffBlock } from './DiffBlock';
import { CollapsedLines } from './CollapsedLines';
import {
  getDiffLineTokens,
  useDiffSyntaxHighlight,
  type DiffSyntaxHighlightData,
} from './DiffSyntaxHighlight';
import {
  buildFullFileDiff,
  toggleRegionExpanded,
} from '../../services/fast-apply/FullFileDiffBuilder';
import { countTextLines, measureRendererWork } from '@services/diagnostics/rendererHealth';
import { getLogger } from '@services/logger';
import type {
  ModificationApplyResult,
  FullFileDiffLine,
  CollapsibleRegion,
} from '../../services/fast-apply/types';

const logger = getLogger('FullFileDiffViewer');

const LARGE_REPLACE_SINGLE_SIDE_LINE_LIMIT = 10_000;
const LARGE_REPLACE_CHANGED_LINE_LIMIT = 1000;
const VIRTUAL_OVERSCAN_PX = 720;
const DEFAULT_VIEWPORT_HEIGHT = 600;
const ESTIMATED_LINE_HEIGHT = 24;
const ESTIMATED_COLLAPSED_HEIGHT = 36;
const ESTIMATED_LINE_CHROME_WIDTH = 88;
const ESTIMATED_MONO_CHAR_WIDTH = 8;
const MIN_ESTIMATED_WRAP_CHARS = 24;
const MAX_ESTIMATED_LINE_WRAP = 80;
const EMPTY_FULL_DIFF_LINES: FullFileDiffLine[] = [];

// ==================== 类型定义 ====================

export interface FullFileDiffViewerProps {
  /** 原始文件内容 */
  originalContent: string;
  /** 修改结果列表 */
  modifications: ModificationApplyResult[];
  /** 文件名 */
  fileName: string;
  /** 完整文件路径（documentId），用于在文件头部显示父目录路径 */
  documentId?: string;
  /** 接受单个修改 */
  onAccept: (id: string) => Promise<void>;
  /** 拒绝单个修改 */
  onReject: (id: string) => void;
  /** 全部接受 */
  onAcceptAll: () => Promise<void>;
  /** 全部拒绝 */
  onRejectAll: () => void;
  /** 当前处理中的修改 ID */
  processingId?: string;
  /** 是否显示全局加载状态 */
  isLoading?: boolean;
  /** 上下文行数（折叠阈值，默认 3） */
  contextLines?: number;
}

// ==================== 子组件 ====================

/**
 * 文件头部组件
 */
function FileHeader({
  fileName,
  documentId,
  stats,
}: {
  fileName: string;
  /** 完整文件路径（documentId），用于提取父目录展示 */
  documentId?: string;
  stats: { added: number; removed: number };
}) {
  // 从完整路径中提取父目录路径的尾部 2 段
  const dirPath = documentId
    ? documentId
        .replace(/[\\/]+/g, '/') // 统一分隔符
        .replace(/\/[^/]+$/, '') // 去掉文件名
        .split('/')
        .slice(-2) // 取尾部 2 段
        .join('/')
    : '';

  return (
    <div className={styles.fileHeader}>
      <div className={styles.fileInfo}>
        <svg
          className={styles.fileIcon}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 2h5l3 3v9H4V2z" />
          <path d="M9 2v3h3" />
        </svg>
        <span className={styles.fileName}>{fileName}</span>
        {dirPath && <span className={styles.filePath}>{dirPath}</span>}
      </div>
      <div className={styles.statsContainer}>
        <span className={styles.statsAdded}>+{stats.added}</span>
        <span className={styles.statsRemoved}>-{stats.removed}</span>
      </div>
    </div>
  );
}

/**
 * 底部操作栏组件
 */
function FooterActions({
  stats,
  onAcceptAll,
  onRejectAll,
  isLoading,
}: {
  stats: { pending: number; failed: number };
  onAcceptAll: () => Promise<void>;
  onRejectAll: () => void;
  isLoading: boolean;
}) {
  const { t } = useI18n();
  const hasPending = stats.pending > 0;

  return (
    <div className={styles.footer}>
      <div className={styles.footerActions}>
        <button
          className={styles.acceptAllBtn}
          onClick={onAcceptAll}
          disabled={isLoading || !hasPending}
        >
          <CheckCheck size={16} />
          {t('diff.acceptAll')}
        </button>
        <button
          className={styles.rejectAllBtn}
          onClick={onRejectAll}
          disabled={isLoading || !hasPending}
        >
          <X size={16} />
          {t('diff.rejectAll')}
        </button>
      </div>
      <div className={styles.footerStats}>
        {t('diff.pendingStats', { pending: stats.pending, failed: stats.failed })}
      </div>
    </div>
  );
}

/**
 * 空状态组件
 */
function EmptyState() {
  const { t } = useI18n();

  return (
    <div className={styles.emptyState}>
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="24" cy="24" r="18" />
        <path d="M16 24l6 6 10-12" />
      </svg>
      <p>{t('diff.noModifications')}</p>
    </div>
  );
}

// ==================== 渲染项类型 ====================

interface RenderItem {
  type: 'context-line' | 'diff-block' | 'collapsed';
  key: string;
  // 上下文行
  line?: FullFileDiffLine;
  // 修改块
  modificationId?: string;
  lines?: FullFileDiffLine[];
  status?: ModificationApplyResult['status'];
  // 折叠区域
  regionIndex?: number;
  lineCount?: number;
}

interface LargeDiffSummary {
  oldLines: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
  pending: number;
  failed: number;
}

interface VirtualLayout {
  offsets: number[];
  heights: number[];
  totalHeight: number;
}

function getEstimatedWrapChars(containerWidth: number): number {
  if (containerWidth <= 0) return 80;

  const textWidth = Math.max(160, containerWidth - ESTIMATED_LINE_CHROME_WIDTH);
  return Math.max(MIN_ESTIMATED_WRAP_CHARS, Math.floor(textWidth / ESTIMATED_MONO_CHAR_WIDTH));
}

function estimateWrappedLineHeight(content: string | undefined, wrapChars: number): number {
  const lineCount = Math.max(
    1,
    Math.min(MAX_ESTIMATED_LINE_WRAP, Math.ceil((content?.length ?? 0) / wrapChars))
  );
  return lineCount * ESTIMATED_LINE_HEIGHT;
}

function estimateRenderItemHeight(item: RenderItem, wrapChars: number): number {
  switch (item.type) {
    case 'context-line':
      return estimateWrappedLineHeight(item.line?.content, wrapChars);
    case 'diff-block':
      return Math.max(
        ESTIMATED_LINE_HEIGHT,
        (item.lines ?? []).reduce(
          (total, line) => total + estimateWrappedLineHeight(line.content, wrapChars),
          4
        )
      );
    case 'collapsed':
      return ESTIMATED_COLLAPSED_HEIGHT;
    default:
      return ESTIMATED_LINE_HEIGHT;
  }
}

function buildVirtualLayout(
  items: RenderItem[],
  measuredHeights: Map<string, number>,
  containerWidth: number
): VirtualLayout {
  const offsets: number[] = [];
  const heights: number[] = [];
  const wrapChars = getEstimatedWrapChars(containerWidth);
  let totalHeight = 0;

  for (const item of items) {
    offsets.push(totalHeight);
    const height = measuredHeights.get(item.key) ?? estimateRenderItemHeight(item, wrapChars);
    heights.push(height);
    totalHeight += height;
  }

  return {
    offsets,
    heights,
    totalHeight,
  };
}

function findFirstVisibleIndex(layout: VirtualLayout, targetOffset: number): number {
  if (layout.offsets.length === 0) return 0;

  let low = 0;
  let high = layout.offsets.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = layout.offsets[mid] ?? 0;
    const end = start + (layout.heights[mid] ?? ESTIMATED_LINE_HEIGHT);

    if (end < targetOffset) {
      low = mid + 1;
    } else {
      result = mid;
      high = mid - 1;
    }
  }

  return result;
}

function findLastVisibleIndex(layout: VirtualLayout, targetOffset: number): number {
  if (layout.offsets.length === 0) return -1;

  let low = 0;
  let high = layout.offsets.length - 1;
  let result = layout.offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = layout.offsets[mid] ?? 0;

    if (start <= targetOffset) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function clampVisibleRange(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number
): { startIndex: number; endIndex: number } {
  const startOffset = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
  const endOffset =
    scrollTop + Math.max(viewportHeight, DEFAULT_VIEWPORT_HEIGHT) + VIRTUAL_OVERSCAN_PX;
  const startIndex = findFirstVisibleIndex(layout, startOffset);
  const endIndex = findLastVisibleIndex(layout, endOffset);

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
  };
}

function isMostlyWholeFileReplace(
  originalContent: string,
  mod: ModificationApplyResult,
  searchLines: number
): boolean {
  if (mod.modification.operation !== 'REPLACE') return false;
  if (mod.modification.search === originalContent) return true;

  const originalLines = countTextLines(originalContent);
  const coversMatchedRange =
    mod.matchResult.startLine <= 1 && mod.matchResult.endLine >= Math.max(1, originalLines - 1);
  const coversMostContent =
    mod.modification.search.length >= originalContent.length * 0.8 &&
    searchLines >= Math.max(1, Math.floor(originalLines * 0.8));

  return coversMatchedRange || coversMostContent;
}

function countChangedDiffLines(mod: ModificationApplyResult): {
  addedLines: number;
  removedLines: number;
} {
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of mod.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        addedLines++;
      } else if (line.type === 'remove') {
        removedLines++;
      }
    }
  }

  return { addedLines, removedLines };
}

function getLargeDiffSummary(
  originalContent: string,
  modifications: ModificationApplyResult[]
): LargeDiffSummary | null {
  if (modifications.length !== 1) return null;

  const [mod] = modifications;
  if (!mod) return null;

  const search = mod.modification.search;
  const replace = mod.modification.replace ?? '';
  const oldLines = countTextLines(search);
  const newLines = countTextLines(replace);

  if (!isMostlyWholeFileReplace(originalContent, mod, oldLines)) {
    return null;
  }

  const maxSideLines = Math.max(oldLines, newLines);
  const { addedLines, removedLines } = countChangedDiffLines(mod);
  const changedLines = addedLines + removedLines;

  if (
    maxSideLines < LARGE_REPLACE_SINGLE_SIDE_LINE_LIMIT ||
    changedLines < LARGE_REPLACE_CHANGED_LINE_LIMIT
  ) {
    return null;
  }

  return {
    oldLines,
    newLines,
    addedLines,
    removedLines,
    pending: modifications.filter((item) => item.status === 'pending').length,
    failed: modifications.filter((item) => item.status === 'failed').length,
  };
}

function LargeDiffSummaryView({ summary }: { summary: LargeDiffSummary }) {
  const { t } = useI18n();

  return (
    <div className={styles.largeDiffSummary}>
      <AlertTriangle size={22} className={styles.largeDiffIcon} />
      <div className={styles.largeDiffBody}>
        <h3>{t('diff.largeDiffSummaryTitle')}</h3>
        <p>
          {t('diff.largeDiffSummaryDescription', {
            oldLines: summary.oldLines,
            newLines: summary.newLines,
            added: summary.addedLines,
            removed: summary.removedLines,
          })}
        </p>
        <div className={styles.largeDiffMeta}>
          <span>{t('diff.largeDiffOldLines', { count: summary.oldLines })}</span>
          <span>{t('diff.largeDiffNewLines', { count: summary.newLines })}</span>
          <span>
            {t('diff.largeDiffChangedLines', { count: summary.addedLines + summary.removedLines })}
          </span>
        </div>
      </div>
    </div>
  );
}

interface VirtualizedDiffContentProps {
  items: RenderItem[];
  resetKey: string;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  onToggleRegion: (regionIndex: number) => void;
  processingId?: string;
  syntaxHighlight?: DiffSyntaxHighlightData | null;
}

/**
 * 虚拟化 Diff 内容区域
 *
 * 仅挂载视口附近的 Diff 行和修改块，保持现有视觉样式不变，
 * 避免长文件 Diff 一次性创建大量 DOM 节点导致 WebView 主线程卡顿。
 */
function VirtualizedDiffContent({
  items,
  resetKey,
  onAccept,
  onReject,
  onToggleRegion,
  processingId,
  syntaxHighlight,
}: VirtualizedDiffContentProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);

  const scheduleMeasureUpdate = useCallback(() => {
    if (measureFrameRef.current !== null) return;

    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      setMeasureVersion((version) => version + 1);
    });
  }, []);

  const updateMeasuredHeight = useCallback(
    (key: string, height: number) => {
      const nextHeight = Math.max(1, Math.ceil(height));
      const previousHeight = rowHeightsRef.current.get(key);
      if (previousHeight !== undefined && Math.abs(previousHeight - nextHeight) <= 1) {
        return;
      }

      rowHeightsRef.current.set(key, nextHeight);
      scheduleMeasureUpdate();
    },
    [scheduleMeasureUpdate]
  );

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.virtualKey;
        if (!key) continue;
        updateMeasuredHeight(key, entry.contentRect.height);
      }
    });

    rowObserverRef.current = observer;
    rowElementsRef.current.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
      rowObserverRef.current = null;
    };
  }, [updateMeasuredHeight]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const updateViewport = () => {
      const nextHeight = contentEl.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
      const nextWidth = contentEl.clientWidth;

      setViewportHeight((previousHeight) =>
        Math.abs(previousHeight - nextHeight) > 1 ? nextHeight : previousHeight
      );

      setContainerWidth((previousWidth) => {
        if (Math.abs(previousWidth - nextWidth) <= 1) {
          return previousWidth;
        }

        rowHeightsRef.current.clear();
        scheduleMeasureUpdate();
        return nextWidth;
      });
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(contentEl);

    return () => observer.disconnect();
  }, [scheduleMeasureUpdate]);

  useEffect(() => {
    const contentEl = contentRef.current;
    rowElementsRef.current.forEach((node) => rowObserverRef.current?.unobserve(node));
    rowElementsRef.current.clear();
    rowHeightsRef.current.clear();
    setScrollTop(0);
    setMeasureVersion((version) => version + 1);

    if (contentEl) {
      contentEl.scrollTop = 0;
    }
  }, [resetKey]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current);
      }
    },
    []
  );

  const layout = useMemo(() => {
    void measureVersion;
    return buildVirtualLayout(items, rowHeightsRef.current, containerWidth);
  }, [items, measureVersion, containerWidth]);

  const { startIndex, endIndex } = useMemo(
    () => clampVisibleRange(layout, scrollTop, viewportHeight),
    [layout, scrollTop, viewportHeight]
  );

  const virtualPadding = useMemo(() => {
    const top = layout.offsets[startIndex] ?? 0;
    const endTop = layout.offsets[endIndex] ?? top;
    const endHeight = layout.heights[endIndex] ?? 0;

    return {
      top,
      bottom: Math.max(0, layout.totalHeight - endTop - endHeight),
    };
  }, [layout, startIndex, endIndex]);

  const visibleItems = useMemo(() => {
    const result: RenderItem[] = [];
    for (let index = startIndex; index <= endIndex; index++) {
      const item = items[index];
      if (!item) continue;
      result.push(item);
    }
    return result;
  }, [items, startIndex, endIndex]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(pendingScrollTopRef.current);
    });
  }, []);

  const setRowElement = useCallback(
    (key: string, node: HTMLDivElement | null) => {
      const previousNode = rowElementsRef.current.get(key);
      if (previousNode && previousNode !== node) {
        rowObserverRef.current?.unobserve(previousNode);
        rowElementsRef.current.delete(key);
      }

      if (!node) return;

      rowElementsRef.current.set(key, node);
      rowObserverRef.current?.observe(node);
      updateMeasuredHeight(key, node.getBoundingClientRect().height);
    },
    [updateMeasuredHeight]
  );

  const renderItem = useCallback(
    (item: RenderItem) => {
      switch (item.type) {
        case 'context-line':
          if (!item.line) return null;
          return (
            <DiffLine
              line={item.line}
              showLineNumbers={true}
              syntaxTokens={getDiffLineTokens(item.line, syntaxHighlight ?? null)}
            />
          );

        case 'diff-block': {
          const { modificationId, lines, status } = item;
          if (!modificationId || !lines || !status) return null;
          return (
            <DiffBlock
              modificationId={modificationId}
              lines={lines}
              status={status}
              onAccept={() => onAccept(modificationId)}
              onReject={() => onReject(modificationId)}
              isProcessing={processingId === modificationId}
              syntaxHighlight={syntaxHighlight}
            />
          );
        }

        case 'collapsed': {
          const { lineCount, regionIndex } = item;
          if (lineCount === undefined || regionIndex === undefined) return null;
          return (
            <CollapsedLines lineCount={lineCount} onExpand={() => onToggleRegion(regionIndex)} />
          );
        }

        default:
          return null;
      }
    },
    [onAccept, onReject, onToggleRegion, processingId, syntaxHighlight]
  );

  return (
    <div ref={contentRef} className={styles.content} onScroll={handleScroll}>
      <div className={styles.virtualSpacer} style={{ minHeight: layout.totalHeight }}>
        {virtualPadding.top > 0 && (
          <div style={{ height: virtualPadding.top }} aria-hidden="true" />
        )}
        {visibleItems.map((item) => (
          <div
            key={item.key}
            ref={(node) => setRowElement(item.key, node)}
            data-virtual-key={item.key}
            className={styles.virtualRow}
          >
            {renderItem(item)}
          </div>
        ))}
        {virtualPadding.bottom > 0 && (
          <div style={{ height: virtualPadding.bottom }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ==================== 主组件 ====================

export function FullFileDiffViewer({
  originalContent,
  modifications,
  fileName,
  documentId,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  processingId,
  isLoading = false,
  contextLines = 3,
}: FullFileDiffViewerProps) {
  // 构建全文 Diff 数据
  const largeDiffSummary = useMemo(
    () => getLargeDiffSummary(originalContent, modifications),
    [originalContent, modifications]
  );

  const fullDiffData = useMemo(() => {
    if (modifications.length === 0 || !fileName || largeDiffSummary) {
      return null;
    }

    return measureRendererWork(
      'FullFileDiffViewer.buildFullFileDiff',
      {
        fileName,
        originalChars: originalContent.length,
        originalLines: countTextLines(originalContent),
        modifications: modifications.length,
        contextLines,
      },
      () => buildFullFileDiff(originalContent, modifications, fileName, contextLines)
    );
  }, [originalContent, modifications, fileName, contextLines, largeDiffSummary]);

  useEffect(() => {
    if (!largeDiffSummary) return;

    logger.warn('[FullFileDiffViewer] large diff rendering skipped', {
      fileName,
      documentId,
      summary: largeDiffSummary,
    });
  }, [fileName, documentId, largeDiffSummary]);

  // 折叠区域状态（可展开/收起）
  const [collapsibleRegions, setCollapsibleRegions] = useState<CollapsibleRegion[]>([]);

  // 当 fullDiffData 变化时，重置折叠区域
  useEffect(() => {
    setCollapsibleRegions(fullDiffData?.collapsibleRegions ?? []);
  }, [fullDiffData]);

  // 切换折叠区域展开状态
  const handleToggleRegion = useCallback((regionIndex: number) => {
    setCollapsibleRegions((prev) => toggleRegionExpanded(prev, regionIndex));
  }, []);

  // 构建修改 ID 到修改数据的映射
  const modificationMap = useMemo(() => {
    const map = new Map<string, ModificationApplyResult>();
    for (const mod of modifications) {
      map.set(mod.modificationId, mod);
    }
    return map;
  }, [modifications]);

  // 构建渲染项列表
  const renderItems = useMemo(() => {
    if (!fullDiffData) return [];

    const items: RenderItem[] = [];
    const { lines } = fullDiffData;
    const processedModIds = new Set<string>();

    let i = 0;
    while (i < lines.length) {
      // 检查是否在折叠区域内
      const collapsedRegion = collapsibleRegions.find(
        (r) => !r.isExpanded && i >= r.startIndex && i <= r.endIndex
      );

      if (collapsedRegion) {
        // 添加折叠占位符
        const regionIndex = collapsibleRegions.indexOf(collapsedRegion);
        items.push({
          type: 'collapsed',
          key: `collapsed-${regionIndex}`,
          regionIndex,
          lineCount: collapsedRegion.lineCount,
        });
        // 跳过折叠区域内的所有行
        i = collapsedRegion.endIndex + 1;
        continue;
      }

      const line = lines[i];
      if (!line) {
        i++;
        continue;
      }

      if (line.modificationId && !processedModIds.has(line.modificationId)) {
        // 遇到新的修改块，收集该修改的所有行
        processedModIds.add(line.modificationId);
        const modId = line.modificationId;
        const modLines: FullFileDiffLine[] = [];

        // 收集属于同一修改的所有连续行
        while (i < lines.length) {
          const currentLine = lines[i];
          if (currentLine?.modificationId !== modId) break;
          modLines.push(currentLine);
          i++;
        }

        const mod = modificationMap.get(modId);
        items.push({
          type: 'diff-block',
          key: `diff-${modId}`,
          modificationId: modId,
          lines: modLines,
          status: mod?.status ?? 'pending',
        });
      } else if (!line.modificationId) {
        // 上下文行
        items.push({
          type: 'context-line',
          key: `line-${i}`,
          line,
        });
        i++;
      } else {
        // 已处理的修改行，跳过
        i++;
      }
    }

    return items;
  }, [fullDiffData, collapsibleRegions, modificationMap]);

  const syntaxHighlight = useDiffSyntaxHighlight(
    originalContent,
    fullDiffData?.lines ?? EMPTY_FULL_DIFF_LINES,
    fileName
  );

  // 空状态：无修改或无文件
  if (modifications.length === 0 || !fileName) {
    return (
      <div className={styles.container}>
        <EmptyState />
      </div>
    );
  }

  if (largeDiffSummary) {
    return (
      <div className={styles.container}>
        <FileHeader
          fileName={fileName}
          documentId={documentId}
          stats={{ added: largeDiffSummary.addedLines, removed: largeDiffSummary.removedLines }}
        />
        <div className={styles.content}>
          <LargeDiffSummaryView summary={largeDiffSummary} />
        </div>
        <FooterActions
          stats={{
            pending: largeDiffSummary.pending,
            failed: largeDiffSummary.failed,
          }}
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
          isLoading={isLoading}
        />
      </div>
    );
  }

  if (!fullDiffData) {
    return (
      <div className={styles.container}>
        <EmptyState />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* 文件头部 */}
      <FileHeader
        fileName={fileName}
        documentId={documentId}
        stats={{ added: fullDiffData.stats.added, removed: fullDiffData.stats.removed }}
      />

      {/* Diff 内容区域 */}
      <VirtualizedDiffContent
        items={renderItems}
        resetKey={`${documentId ?? ''}:${fileName}`}
        onAccept={onAccept}
        onReject={onReject}
        onToggleRegion={handleToggleRegion}
        processingId={processingId}
        syntaxHighlight={syntaxHighlight}
      />

      {/* 底部操作栏 */}
      <FooterActions
        stats={{
          pending: fullDiffData.stats.pending,
          failed: fullDiffData.stats.failed,
        }}
        onAcceptAll={onAcceptAll}
        onRejectAll={onRejectAll}
        isLoading={isLoading}
      />
    </div>
  );
}
