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

import {
  memo,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type UIEvent,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCheck, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import styles from './FullFileDiffViewer.module.css';
import { DiffLine } from './DiffLine';
import { DiffBlock, DiffBlockActions } from './DiffBlock';
import { CollapsedLines } from './CollapsedLines';
import {
  getDiffLineTokens,
  useDiffSyntaxHighlight,
  type DiffSyntaxHighlightData,
} from './DiffSyntaxHighlight';
import { buildFullFileDiff } from '../../services/fast-apply/FullFileDiffBuilder';
import { countTextLines, measureRendererWork } from '@services/diagnostics/rendererHealth';
import { getLogger } from '@services/logger';
import {
  buildDiffRenderItems,
  buildVirtualLayout,
  clampVisibleRange,
  DEFAULT_DIFF_VIEWPORT_HEIGHT as DEFAULT_VIEWPORT_HEIGHT,
  getLargeDiffSummary,
  resolveCollapsibleRegions,
  toggleCollapsibleRegionRevision,
  updateExpandedDiffLines,
  type CollapsibleRegionRevisionState,
  type DiffRenderItem,
  type LargeDiffSummary,
} from './FullFileDiffModel';
import type { ModificationApplyResult, FullFileDiffLine } from '../../services/fast-apply/types';

const logger = getLogger('FullFileDiffViewer');

// Keep this module's runtime exports component-only so Vite can preserve provider boundaries.
const EMPTY_FULL_DIFF_LINES: FullFileDiffLine[] = [];
const EMPTY_EXPANDED_LINES: ReadonlySet<FullFileDiffLine> = new Set();

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

function LargeDiffSummaryView({
  summary,
  onAccept,
  onReject,
  processingId,
}: {
  summary: LargeDiffSummary;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  processingId?: string;
}) {
  const { t } = useI18n();
  const guarded = summary.guardedModification;

  return (
    <div className={styles.largeDiffSummary}>
      <AlertTriangle size={22} className={styles.largeDiffIcon} />
      <div className={styles.largeDiffBody}>
        <h3>{t('diff.largeDiffSummaryTitle')}</h3>
        <p>
          {t('diff.largeDiffSummaryDescription', {
            oldLines: guarded.oldLines,
            newLines: guarded.newLines,
            added: guarded.addedLines,
            removed: guarded.removedLines,
          })}
        </p>
        <div className={styles.largeDiffMeta}>
          <span>{t('diff.largeDiffOldLines', { count: guarded.oldLines })}</span>
          <span>{t('diff.largeDiffNewLines', { count: guarded.newLines })}</span>
          <span>
            {t('diff.largeDiffChangedLines', {
              count: guarded.addedLines + guarded.removedLines,
            })}
          </span>
        </div>
        <div className={styles.largeDiffItems}>
          {summary.modifications.map((modification) => (
            <div
              key={modification.modificationId}
              className={styles.largeDiffItem}
              data-modification-summary-id={modification.modificationId}
            >
              <div className={styles.largeDiffItemBody}>
                <span className={styles.largeDiffItemLabel} title={modification.label}>
                  {modification.label}
                </span>
                <div className={styles.largeDiffMeta}>
                  <span>{t('diff.largeDiffOldLines', { count: modification.oldLines })}</span>
                  <span>{t('diff.largeDiffNewLines', { count: modification.newLines })}</span>
                  <span>
                    {t('diff.largeDiffChangedLines', {
                      count: modification.addedLines + modification.removedLines,
                    })}
                  </span>
                </div>
              </div>
              <DiffBlockActions
                modificationId={modification.modificationId}
                status={modification.status}
                onAccept={() => {
                  void onAccept(modification.modificationId);
                }}
                onReject={() => onReject(modification.modificationId)}
                isProcessing={processingId === modification.modificationId}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface VirtualizedDiffContentProps {
  items: DiffRenderItem[];
  resetKey: string;
  dataRevision: FullFileDiffLine[];
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  onToggleRegion: (regionIndex: number) => void;
  processingId?: string;
  syntaxHighlight?: DiffSyntaxHighlightData | null;
}

interface VirtualDiffRowProps {
  item: DiffRenderItem;
  onElement: (key: string, node: HTMLDivElement | null) => void;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => void;
  onToggleRegion: (regionIndex: number) => void;
  processingId?: string;
  syntaxHighlight?: DiffSyntaxHighlightData | null;
  expandedLines: ReadonlySet<FullFileDiffLine>;
  onLongLineExpandedChange: (line: FullFileDiffLine, expanded: boolean) => void;
}

/** 渲染一个有界的虚拟行，并保持 DOM ref 在相同 item 生命周期内稳定。 */
const VirtualDiffRow = memo(function VirtualDiffRow({
  item,
  onElement,
  onAccept,
  onReject,
  onToggleRegion,
  processingId,
  syntaxHighlight,
  expandedLines,
  onLongLineExpandedChange,
}: VirtualDiffRowProps) {
  const setElement = useCallback(
    (node: HTMLDivElement | null) => onElement(item.key, node),
    [item.key, onElement]
  );
  const acceptModification = useCallback(() => {
    if (item.type === 'diff-actions') {
      void onAccept(item.modificationId);
    }
  }, [item, onAccept]);
  const rejectModification = useCallback(() => {
    if (item.type === 'diff-actions') {
      onReject(item.modificationId);
    }
  }, [item, onReject]);
  const expandRegion = useCallback(() => {
    if (item.type === 'collapsed') {
      onToggleRegion(item.regionIndex);
    }
  }, [item, onToggleRegion]);

  let content: ReactNode;
  switch (item.type) {
    case 'context-line':
      content = (
        <DiffLine
          line={item.line}
          showLineNumbers={true}
          syntaxTokens={getDiffLineTokens(item.line, syntaxHighlight ?? null)}
          isLongLineExpanded={expandedLines.has(item.line)}
          onLongLineExpandedChange={(expanded) => onLongLineExpandedChange(item.line, expanded)}
        />
      );
      break;
    case 'diff-lines':
      content = (
        <DiffBlock
          modificationId={item.modificationId}
          lines={item.lines}
          status={item.status}
          syntaxHighlight={syntaxHighlight}
          expandedLines={expandedLines}
          onLongLineExpandedChange={onLongLineExpandedChange}
        />
      );
      break;
    case 'diff-actions':
      content = (
        <DiffBlockActions
          modificationId={item.modificationId}
          status={item.status}
          onAccept={acceptModification}
          onReject={rejectModification}
          isProcessing={processingId === item.modificationId}
        />
      );
      break;
    case 'collapsed':
      content = <CollapsedLines lineCount={item.lineCount} onExpand={expandRegion} />;
      break;
  }

  return (
    <div ref={setElement} data-virtual-key={item.key} className={styles.virtualRow}>
      {content}
    </div>
  );
});

/**
 * 虚拟化 Diff 内容区域
 *
 * 仅挂载视口附近的 Diff 行和修改块，保持现有视觉样式不变，
 * 避免长文件 Diff 一次性创建大量 DOM 节点导致 WebView 主线程卡顿。
 */
function VirtualizedDiffContent({
  items,
  resetKey,
  dataRevision,
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
  const containerWidthRef = useRef(0);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [expandedLinesByDocument, setExpandedLinesByDocument] = useState<
    Map<string, ReadonlySet<FullFileDiffLine>>
  >(new Map());
  const expandedLines = expandedLinesByDocument.get(resetKey) ?? EMPTY_EXPANDED_LINES;

  const handleLongLineExpandedChange = useCallback(
    (line: FullFileDiffLine, expanded: boolean) => {
      for (const item of items) {
        const containsLine =
          (item.type === 'context-line' && item.line === line) ||
          (item.type === 'diff-lines' && item.lines.includes(line));
        if (containsLine) {
          rowHeightsRef.current.delete(item.key);
          break;
        }
      }
      setExpandedLinesByDocument((current) =>
        updateExpandedDiffLines(current, resetKey, line, expanded)
      );
    },
    [items, resetKey]
  );

  const scheduleMeasureUpdate = useCallback(() => {
    if (measureFrameRef.current !== null) return;

    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      rowElementsRef.current.forEach((node, key) => {
        rowHeightsRef.current.set(key, Math.max(1, Math.ceil(node.getBoundingClientRect().height)));
      });
      const nextScrollTop = contentRef.current?.scrollTop ?? 0;
      pendingScrollTopRef.current = nextScrollTop;
      setScrollTop(nextScrollTop);
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

      if (Math.abs(containerWidthRef.current - nextWidth) > 1) {
        containerWidthRef.current = nextWidth;
        rowHeightsRef.current.clear();
        setContainerWidth(nextWidth);
        scheduleMeasureUpdate();
      }
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(contentEl);

    return () => observer.disconnect();
  }, [scheduleMeasureUpdate]);

  useLayoutEffect(() => {
    const contentEl = contentRef.current;
    // Keep mounted rows observed. React can reuse the same keyed DOM nodes for a new diff
    // revision, so clearing this registry here would prevent their new heights being measured.
    rowHeightsRef.current.clear();
    pendingScrollTopRef.current = 0;
    setExpandedLinesByDocument(new Map());
    setScrollTop(0);
    setMeasureVersion((version) => version + 1);

    if (contentEl) {
      contentEl.scrollTop = 0;
    }
  }, [dataRevision, resetKey]);

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
    return buildVirtualLayout(items, rowHeightsRef.current, containerWidth, expandedLines);
  }, [items, measureVersion, containerWidth, expandedLines]);
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
    const result: DiffRenderItem[] = [];
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

  const setRowElement = useCallback((key: string, node: HTMLDivElement | null) => {
    const previousNode = rowElementsRef.current.get(key);
    if (previousNode === node) return;

    if (previousNode) {
      rowObserverRef.current?.unobserve(previousNode);
      rowElementsRef.current.delete(key);
    }

    if (!node) return;

    rowElementsRef.current.set(key, node);
    rowObserverRef.current?.observe(node);
  }, []);

  return (
    <div ref={contentRef} className={styles.content} onScroll={handleScroll}>
      <div className={styles.virtualSpacer} style={{ minHeight: layout.totalHeight }}>
        {virtualPadding.top > 0 && (
          <div style={{ height: virtualPadding.top }} aria-hidden="true" />
        )}
        {visibleItems.map((item) => (
          <VirtualDiffRow
            key={item.key}
            item={item}
            onElement={setRowElement}
            onAccept={onAccept}
            onReject={onReject}
            onToggleRegion={onToggleRegion}
            processingId={processingId}
            syntaxHighlight={syntaxHighlight}
            expandedLines={expandedLines}
            onLongLineExpandedChange={handleLongLineExpandedChange}
          />
        ))}
        {virtualPadding.bottom > 0 && (
          <div style={{ height: virtualPadding.bottom }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ==================== 主组件 ====================

function FullFileDiffViewerComponent({
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

  const [collapsibleRegionState, setCollapsibleRegionState] =
    useState<CollapsibleRegionRevisionState | null>(null);
  const collapsibleRegions = useMemo(
    () =>
      fullDiffData
        ? resolveCollapsibleRegions(
            fullDiffData.lines,
            fullDiffData.collapsibleRegions,
            collapsibleRegionState
          )
        : [],
    [collapsibleRegionState, fullDiffData]
  );

  // Apply expansion state synchronously to the current revision. A cold mount must never
  // render the entire file once before its collapsed regions become available.
  const handleToggleRegion = useCallback(
    (regionIndex: number) => {
      if (!fullDiffData) return;

      setCollapsibleRegionState((current) =>
        toggleCollapsibleRegionRevision(
          fullDiffData.lines,
          fullDiffData.collapsibleRegions,
          current,
          regionIndex
        )
      );
    },
    [fullDiffData]
  );

  // 构建渲染项列表
  const renderItems = useMemo(
    () =>
      fullDiffData
        ? buildDiffRenderItems(fullDiffData.lines, collapsibleRegions, modifications)
        : [],
    [fullDiffData, collapsibleRegions, modifications]
  );

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
          <LargeDiffSummaryView
            summary={largeDiffSummary}
            onAccept={onAccept}
            onReject={onReject}
            processingId={processingId}
          />
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
        dataRevision={fullDiffData.lines}
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

export const FullFileDiffViewer = memo(FullFileDiffViewerComponent);
