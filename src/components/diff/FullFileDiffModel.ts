/**
 * FullFileDiffModel - pure rendering, guard, and virtualization calculations for full-file diffs.
 *
 * Kept separate from the React viewer so Vite Fast Refresh can safely reload the component module.
 */

import { countTextLines } from '@services/diagnostics/rendererHealth';
import type {
  CollapsibleRegion,
  FullFileDiffLine,
  ModificationApplyResult,
} from '../../services/fast-apply/types';
import { buildDiffLinePreview, buildExpandedDiffLinePreview } from './DiffLinePreview';

const LARGE_REPLACE_SINGLE_SIDE_LINE_LIMIT = 10_000;
const LARGE_REPLACE_CHANGED_LINE_LIMIT = 1000;
const VIRTUAL_OVERSCAN_PX = 720;
export const DEFAULT_DIFF_VIEWPORT_HEIGHT = 600;
const ESTIMATED_LINE_HEIGHT = 24;
const ESTIMATED_COLLAPSED_HEIGHT = 36;
const ESTIMATED_LINE_CHROME_WIDTH = 88;
const ESTIMATED_MONO_CHAR_WIDTH = 8;
const MIN_ESTIMATED_WRAP_CHARS = 24;
const TRUNCATION_CONTROL_ESTIMATED_CHARS = 32;
export const DIFF_RENDER_CHUNK_SIZE = 32;

interface ContextLineRenderItem {
  type: 'context-line';
  key: string;
  line: FullFileDiffLine;
}

interface DiffLinesRenderItem {
  type: 'diff-lines';
  key: string;
  modificationId: string;
  lines: FullFileDiffLine[];
  status: ModificationApplyResult['status'];
}

interface DiffActionsRenderItem {
  type: 'diff-actions';
  key: string;
  modificationId: string;
  status: ModificationApplyResult['status'];
}

interface CollapsedRenderItem {
  type: 'collapsed';
  key: string;
  regionIndex: number;
  lineCount: number;
}

export type DiffRenderItem =
  | ContextLineRenderItem
  | DiffLinesRenderItem
  | DiffActionsRenderItem
  | CollapsedRenderItem;

export interface LargeDiffModificationSummary {
  modificationId: string;
  label: string;
  status: ModificationApplyResult['status'];
  oldLines: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
}

export interface LargeDiffSummary {
  guardedModification: LargeDiffModificationSummary;
  modifications: LargeDiffModificationSummary[];
  addedLines: number;
  removedLines: number;
  pending: number;
  failed: number;
}

export interface VirtualLayout {
  offsets: number[];
  heights: number[];
  totalHeight: number;
}

export type ExpandedDiffLinesByDocument = ReadonlyMap<string, ReadonlySet<FullFileDiffLine>>;

export interface CollapsibleRegionRevisionState {
  dataRevision: FullFileDiffLine[];
  regions: CollapsibleRegion[];
}

/** Uses expansion overrides only for the exact diff revision that created them. */
export function resolveCollapsibleRegions(
  dataRevision: FullFileDiffLine[],
  defaultRegions: CollapsibleRegion[],
  revisionState: CollapsibleRegionRevisionState | null
): CollapsibleRegion[] {
  return revisionState?.dataRevision === dataRevision ? revisionState.regions : defaultRegions;
}

export function toggleCollapsibleRegionRevision(
  dataRevision: FullFileDiffLine[],
  defaultRegions: CollapsibleRegion[],
  revisionState: CollapsibleRegionRevisionState | null,
  regionIndex: number
): CollapsibleRegionRevisionState {
  const currentRegions = resolveCollapsibleRegions(dataRevision, defaultRegions, revisionState);

  return {
    dataRevision,
    regions: currentRegions.map((region, index) =>
      index === regionIndex ? { ...region, isExpanded: !region.isExpanded } : region
    ),
  };
}

/** Immutably updates expanded long lines for one document and drops stale document state. */
export function updateExpandedDiffLines(
  current: ExpandedDiffLinesByDocument,
  documentKey: string,
  line: FullFileDiffLine,
  expanded: boolean
): Map<string, ReadonlySet<FullFileDiffLine>> {
  const documentLines = new Set(current.get(documentKey));

  if (expanded) {
    documentLines.add(line);
  } else {
    documentLines.delete(line);
  }

  const next = new Map<string, ReadonlySet<FullFileDiffLine>>();
  if (documentLines.size > 0) {
    next.set(documentKey, documentLines);
  }
  return next;
}

function getEstimatedWrapChars(containerWidth: number): number {
  if (containerWidth <= 0) return 80;

  const textWidth = Math.max(160, containerWidth - ESTIMATED_LINE_CHROME_WIDTH);
  return Math.max(MIN_ESTIMATED_WRAP_CHARS, Math.floor(textWidth / ESTIMATED_MONO_CHAR_WIDTH));
}

function getEstimatedRenderedChars(
  line: FullFileDiffLine,
  expandedLines: ReadonlySet<FullFileDiffLine>
): number {
  const preview = expandedLines.has(line)
    ? buildExpandedDiffLinePreview(line.content)
    : buildDiffLinePreview(line.content);

  if (!preview.isTruncated) return preview.leading.length;

  return preview.leading.length + preview.trailing.length + TRUNCATION_CONTROL_ESTIMATED_CHARS;
}

function estimateWrappedLineHeight(
  line: FullFileDiffLine,
  wrapChars: number,
  expandedLines: ReadonlySet<FullFileDiffLine>
): number {
  const renderedChars = getEstimatedRenderedChars(line, expandedLines);
  return Math.max(1, Math.ceil(renderedChars / wrapChars)) * ESTIMATED_LINE_HEIGHT;
}

function estimateRenderItemHeight(
  item: DiffRenderItem,
  wrapChars: number,
  expandedLines: ReadonlySet<FullFileDiffLine>
): number {
  switch (item.type) {
    case 'context-line':
      return estimateWrappedLineHeight(item.line, wrapChars, expandedLines);
    case 'diff-lines':
      return Math.max(
        ESTIMATED_LINE_HEIGHT,
        item.lines.reduce(
          (total, line) => total + estimateWrappedLineHeight(line, wrapChars, expandedLines),
          0
        )
      );
    case 'diff-actions':
    case 'collapsed':
      return ESTIMATED_COLLAPSED_HEIGHT;
  }
}

export function buildVirtualLayout(
  items: DiffRenderItem[],
  measuredHeights: ReadonlyMap<string, number>,
  containerWidth: number,
  expandedLines: ReadonlySet<FullFileDiffLine>
): VirtualLayout {
  const offsets: number[] = [];
  const heights: number[] = [];
  const wrapChars = getEstimatedWrapChars(containerWidth);
  let totalHeight = 0;

  for (const item of items) {
    offsets.push(totalHeight);
    const height =
      measuredHeights.get(item.key) ?? estimateRenderItemHeight(item, wrapChars, expandedLines);
    heights.push(height);
    totalHeight += height;
  }

  return { offsets, heights, totalHeight };
}

function findFirstVisibleIndex(layout: VirtualLayout, targetOffset: number): number {
  if (layout.offsets.length === 0) return 0;

  let low = 0;
  let high = layout.offsets.length - 1;
  let result = layout.offsets.length - 1;

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

export function clampVisibleRange(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number
): { startIndex: number; endIndex: number } {
  const startOffset = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
  const endOffset =
    scrollTop + Math.max(viewportHeight, DEFAULT_DIFF_VIEWPORT_HEIGHT) + VIRTUAL_OVERSCAN_PX;
  const startIndex = findFirstVisibleIndex(layout, startOffset);
  const endIndex = findLastVisibleIndex(layout, endOffset);

  return { startIndex, endIndex: Math.max(startIndex, endIndex) };
}

function isMostlyWholeFileReplace(
  originalContent: string,
  mod: ModificationApplyResult,
  searchLines: number,
  originalLines: number
): boolean {
  if (mod.modification.operation !== 'REPLACE') return false;
  if (mod.modification.search === originalContent) return true;

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
      if (line.type === 'add') addedLines++;
      if (line.type === 'remove') removedLines++;
    }
  }

  return { addedLines, removedLines };
}

function summarizeModification(mod: ModificationApplyResult): LargeDiffModificationSummary {
  const { addedLines, removedLines } = countChangedDiffLines(mod);
  const description = mod.modification.description?.trim();

  return {
    modificationId: mod.modificationId,
    label: description === undefined || description.length === 0 ? mod.modificationId : description,
    status: mod.status,
    oldLines: countTextLines(mod.modification.search),
    newLines: countTextLines(mod.modification.replace ?? ''),
    addedLines,
    removedLines,
  };
}

export function getLargeDiffSummary(
  originalContent: string,
  modifications: ModificationApplyResult[]
): LargeDiffSummary | null {
  const originalLines = countTextLines(originalContent);
  const summaries = modifications.map(summarizeModification);
  const guardedIndex = modifications.findIndex((mod, index) => {
    const summary = summaries[index];
    if (
      !summary ||
      !isMostlyWholeFileReplace(originalContent, mod, summary.oldLines, originalLines)
    ) {
      return false;
    }

    return (
      Math.max(summary.oldLines, summary.newLines) >= LARGE_REPLACE_SINGLE_SIDE_LINE_LIMIT &&
      summary.addedLines + summary.removedLines >= LARGE_REPLACE_CHANGED_LINE_LIMIT
    );
  });
  const guardedModification = summaries[guardedIndex];
  if (!guardedModification) return null;

  return {
    guardedModification,
    modifications: summaries,
    addedLines: summaries.reduce((total, summary) => total + summary.addedLines, 0),
    removedLines: summaries.reduce((total, summary) => total + summary.removedLines, 0),
    pending: modifications.filter((item) => item.status === 'pending').length,
    failed: modifications.filter((item) => item.status === 'failed').length,
  };
}

/** Builds bounded virtual rows so even a whole-file replacement does not create one huge DOM tree. */
export function buildDiffRenderItems(
  lines: FullFileDiffLine[],
  regions: CollapsibleRegion[],
  modifications: ModificationApplyResult[],
  chunkSize: number = DIFF_RENDER_CHUNK_SIZE
): DiffRenderItem[] {
  const items: DiffRenderItem[] = [];
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));
  const modificationStatus = new Map(
    modifications.map((modification) => [modification.modificationId, modification.status])
  );
  const collapsedRegionByStart = new Map<number, { region: CollapsibleRegion; index: number }>();
  regions.forEach((region, index) => {
    if (!region.isExpanded) collapsedRegionByStart.set(region.startIndex, { region, index });
  });

  const lastLineIndexByModification = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.modificationId) lastLineIndexByModification.set(line.modificationId, index);
  });
  const completedModifications = [...lastLineIndexByModification.entries()].sort(
    ([, leftIndex], [, rightIndex]) => leftIndex - rightIndex
  );

  let completedModificationIndex = 0;
  let pendingChunk:
    | { modificationId: string; startIndex: number; lines: FullFileDiffLine[] }
    | undefined;

  const flushPendingChunk = () => {
    if (!pendingChunk) return;

    const { modificationId, startIndex, lines: chunkLines } = pendingChunk;
    items.push({
      type: 'diff-lines',
      key: `diff-${modificationId}-lines-${startIndex}-${startIndex + chunkLines.length - 1}`,
      modificationId,
      lines: chunkLines,
      status: modificationStatus.get(modificationId) ?? 'pending',
    });
    pendingChunk = undefined;
  };

  const appendCompletedModificationActions = (processedThroughIndex: number) => {
    while (completedModificationIndex < completedModifications.length) {
      const completed = completedModifications[completedModificationIndex];
      if (!completed || completed[1] > processedThroughIndex) break;

      flushPendingChunk();
      const [modificationId] = completed;
      items.push({
        type: 'diff-actions',
        key: `diff-${modificationId}-actions`,
        modificationId,
        status: modificationStatus.get(modificationId) ?? 'pending',
      });
      completedModificationIndex++;
    }
  };

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const collapsed = collapsedRegionByStart.get(lineIndex);
    if (collapsed) {
      flushPendingChunk();
      items.push({
        type: 'collapsed',
        key: `collapsed-${collapsed.region.startIndex}-${collapsed.region.endIndex}`,
        regionIndex: collapsed.index,
        lineCount: collapsed.region.lineCount,
      });
      appendCompletedModificationActions(collapsed.region.endIndex);
      lineIndex = collapsed.region.endIndex + 1;
      continue;
    }

    const line = lines[lineIndex];
    if (!line) {
      lineIndex++;
      continue;
    }

    if (line.modificationId) {
      if (
        pendingChunk &&
        (pendingChunk.modificationId !== line.modificationId ||
          pendingChunk.lines.length >= normalizedChunkSize)
      ) {
        flushPendingChunk();
      }
      pendingChunk ??= { modificationId: line.modificationId, startIndex: lineIndex, lines: [] };
      pendingChunk.lines.push(line);

      if (pendingChunk.lines.length >= normalizedChunkSize) flushPendingChunk();
    } else {
      flushPendingChunk();
      items.push({ type: 'context-line', key: `line-${lineIndex}`, line });
    }

    appendCompletedModificationActions(lineIndex);
    lineIndex++;
  }

  flushPendingChunk();
  appendCompletedModificationActions(Number.POSITIVE_INFINITY);
  return items;
}
