/**
 * FullFileDiffViewer 虚拟行构建回归测试
 *
 * 验证 whole-file REPLACE 的未变化上下文会折叠，且修改行按有界小块渲染。
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@components/ui';
import { FullFileDiffViewer } from '../FullFileDiffViewer';
import {
  buildDiffRenderItems,
  buildVirtualLayout,
  clampVisibleRange,
  DIFF_RENDER_CHUNK_SIZE,
  getLargeDiffSummary,
  resolveCollapsibleRegions,
  toggleCollapsibleRegionRevision,
  updateExpandedDiffLines,
  type DiffRenderItem,
} from '../FullFileDiffModel';
import { buildFullFileDiff } from '../../../services/fast-apply/FullFileDiffBuilder';
import type {
  DiffResult,
  FullFileDiffLine,
  ModificationApplyResult,
} from '../../../services/fast-apply/types';

function createWholeFileReplace(): { content: string; modification: ModificationApplyResult } {
  const originalLines = Array.from({ length: 566 }, (_, index) => `<p>line ${index + 1}</p>`);
  const removedLines = originalLines.slice(278, 286);
  const addedLines = Array.from({ length: 10 }, (_, index) => `<p>changed ${index + 1}</p>`);
  const replacementLines = [
    ...originalLines.slice(0, 278),
    ...addedLines,
    ...originalLines.slice(286),
  ];
  const content = originalLines.join('\n');
  const replacement = replacementLines.join('\n');
  const diff: DiffResult = {
    oldContent: content,
    newContent: replacement,
    hasChanges: true,
    hunks: [
      {
        oldStart: 279,
        oldLines: removedLines.length,
        newStart: 279,
        newLines: addedLines.length,
        lines: [
          ...removedLines.map((line, index) => ({
            type: 'remove' as const,
            content: line,
            oldLineNumber: 279 + index,
          })),
          ...addedLines.map((line, index) => ({
            type: 'add' as const,
            content: line,
            newLineNumber: 279 + index,
          })),
        ],
      },
    ],
  };

  return {
    content,
    modification: {
      modificationId: 'whole-file-replace',
      modification: {
        file: 'large.html',
        operation: 'REPLACE',
        search: content,
        replace: replacement,
      },
      matchResult: {
        success: true,
        matchLevel: 'exact',
        confidence: 1,
        startLine: 1,
        endLine: originalLines.length,
        matchedContent: content,
      },
      diff,
      status: 'pending',
    },
  };
}

function createGuardedWholeFileReplace(): {
  content: string;
  modification: ModificationApplyResult;
} {
  const originalLines = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`);
  const content = originalLines.join('\n');
  const removedLines = Array.from({ length: 500 }, (_, index) => ({
    type: 'remove' as const,
    content: `old ${index}`,
    oldLineNumber: index + 1,
  }));
  const addedLines = Array.from({ length: 500 }, (_, index) => ({
    type: 'add' as const,
    content: `new ${index}`,
    newLineNumber: index + 1,
  }));

  return {
    content,
    modification: {
      modificationId: 'guarded-whole-file-replace',
      modification: {
        file: 'huge.html',
        operation: 'REPLACE',
        search: content,
        replace: content,
      },
      matchResult: {
        success: true,
        matchLevel: 'exact',
        confidence: 1,
        startLine: 1,
        endLine: originalLines.length,
        matchedContent: content,
      },
      diff: {
        oldContent: content,
        newContent: content,
        hasChanges: true,
        hunks: [
          {
            oldStart: 1,
            oldLines: removedLines.length,
            newStart: 1,
            newLines: addedLines.length,
            lines: [...removedLines, ...addedLines],
          },
        ],
      },
      status: 'pending',
    },
  };
}

function createSmallModification(): ModificationApplyResult {
  return {
    modificationId: 'small-change',
    modification: {
      file: 'huge.html',
      operation: 'REPLACE',
      search: 'before',
      replace: 'after',
    },
    matchResult: {
      success: true,
      matchLevel: 'exact',
      confidence: 1,
      startLine: 5000,
      endLine: 5000,
      matchedContent: 'before',
    },
    diff: {
      oldContent: 'before',
      newContent: 'after',
      hasChanges: true,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { type: 'remove', content: 'before', oldLineNumber: 1 },
            { type: 'add', content: 'after', newLineNumber: 1 },
          ],
        },
      ],
    },
    status: 'pending',
  };
}

describe('buildDiffRenderItems', () => {
  it('does not turn a +10/-8 whole-file REPLACE into one large virtual row', () => {
    const { content, modification } = createWholeFileReplace();
    const fullDiff = buildFullFileDiff(content, [modification], 'large.html', 3);
    const expandedRegions = fullDiff.collapsibleRegions.map((region) => ({
      ...region,
      isExpanded: true,
    }));
    const items = buildDiffRenderItems(fullDiff.lines, expandedRegions, [modification]);
    const lineItems = items.filter((item) => item.type === 'diff-lines');

    expect(fullDiff.stats).toMatchObject({ added: 10, removed: 8 });
    expect(fullDiff.lines.length).toBeGreaterThan(566);
    expect(lineItems.length).toBeGreaterThan(10);
    expect(lineItems.reduce((total, item) => total + item.lines.length, 0)).toBe(
      fullDiff.lines.length
    );
    expect(Math.max(...lineItems.map((item) => item.lines.length))).toBeLessThanOrEqual(
      DIFF_RENDER_CHUNK_SIZE
    );
    expect(items.filter((item) => item.type === 'diff-actions')).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({
      type: 'diff-actions',
      modificationId: modification.modificationId,
    });
  });

  it('folds long unchanged context even when it belongs to the modification', () => {
    const { content, modification } = createWholeFileReplace();
    const fullDiff = buildFullFileDiff(content, [modification], 'large.html', 3);
    const items = buildDiffRenderItems(fullDiff.lines, fullDiff.collapsibleRegions, [modification]);
    const collapsedItems = items.filter((item) => item.type === 'collapsed');

    expect(fullDiff.collapsibleRegions.length).toBeGreaterThan(0);
    expect(collapsedItems.length).toBeGreaterThan(0);
    expect(collapsedItems.some((item) => item.lineCount > 200)).toBe(true);

    const foldedContext = fullDiff.collapsibleRegions.flatMap((region) =>
      fullDiff.lines.slice(region.startIndex, region.endIndex + 1)
    );
    expect(foldedContext.every((line) => line.type === 'context')).toBe(true);
    expect(foldedContext.some((line) => line.modificationId === modification.modificationId)).toBe(
      true
    );

    const expandedRegions = fullDiff.collapsibleRegions.map((region) => ({
      ...region,
      isExpanded: true,
    }));
    const expandedItems = buildDiffRenderItems(fullDiff.lines, expandedRegions, [modification]);
    const firstCollapsedLineItem = items.find((item) => item.type === 'diff-lines');
    const firstExpandedLineItem = expandedItems.find((item) => item.type === 'diff-lines');

    expect(firstCollapsedLineItem?.key).not.toBe(firstExpandedLineItem?.key);

    const layout = buildVirtualLayout(items, new Map(), 760, new Set());
    const initialRange = clampVisibleRange(layout, 0, 1_000);
    expect(
      items
        .slice(initialRange.startIndex, initialRange.endIndex + 1)
        .some((item) => item.type === 'collapsed')
    ).toBe(true);
  });

  it('renders collapsed placeholders on the cold render instead of one stale first chunk', () => {
    const { content, modification } = createWholeFileReplace();
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          TooltipProvider,
          null,
          createElement(FullFileDiffViewer, {
            originalContent: content,
            modifications: [modification],
            fileName: 'large.html',
            documentId: '/workspace/large.html',
            onAccept: async () => undefined,
            onReject: () => undefined,
            onAcceptAll: async () => undefined,
            onRejectAll: () => undefined,
          })
        )
      )
    );

    expect(html).toContain('data-virtual-key="collapsed-3-274"');
    expect(html).toContain('Expand 272 more lines');
    expect(html).not.toContain('&lt;p&gt;line 4&lt;/p&gt;');
  });
});

describe('collapsible region revision state', () => {
  it('uses cold-start regions synchronously and ignores overrides from an older revision', () => {
    const { content, modification } = createWholeFileReplace();
    const fullDiff = buildFullFileDiff(content, [modification], 'large.html', 3);

    expect(resolveCollapsibleRegions(fullDiff.lines, fullDiff.collapsibleRegions, null)).toBe(
      fullDiff.collapsibleRegions
    );

    const expandedState = toggleCollapsibleRegionRevision(
      fullDiff.lines,
      fullDiff.collapsibleRegions,
      null,
      0
    );
    expect(
      resolveCollapsibleRegions(fullDiff.lines, fullDiff.collapsibleRegions, expandedState)[0]
        ?.isExpanded
    ).toBe(true);

    const nextRevision = [...fullDiff.lines];
    expect(
      resolveCollapsibleRegions(nextRevision, fullDiff.collapsibleRegions, expandedState)
    ).toBe(fullDiff.collapsibleRegions);
    expect(fullDiff.collapsibleRegions[0]?.isExpanded).toBe(false);
  });
});

describe('large diff guard', () => {
  it('guards a huge mostly-whole-file REPLACE even when other modifications exist', () => {
    const { content, modification } = createGuardedWholeFileReplace();
    const smallModification = createSmallModification();

    const summary = getLargeDiffSummary(content, [modification, smallModification]);

    expect(summary).not.toBeNull();
    expect(summary?.guardedModification.modificationId).toBe(modification.modificationId);
    expect(summary?.modifications.map((item) => item.modificationId)).toEqual([
      modification.modificationId,
      smallModification.modificationId,
    ]);
    expect(summary?.modifications.every((item) => item.status === 'pending')).toBe(true);
  });

  it('renders one identifiable approval row for every guarded modification', () => {
    const { content, modification } = createGuardedWholeFileReplace();
    const smallModification = createSmallModification();
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          TooltipProvider,
          null,
          createElement(FullFileDiffViewer, {
            originalContent: content,
            modifications: [modification, smallModification],
            fileName: 'huge.html',
            documentId: '/workspace/huge.html',
            onAccept: async () => undefined,
            onReject: () => undefined,
            onAcceptAll: async () => undefined,
            onRejectAll: () => undefined,
          })
        )
      )
    );

    for (const item of [modification, smallModification]) {
      expect(html).toContain(`data-modification-summary-id="${item.modificationId}"`);
      expect(html).toContain(`data-modification-id="${item.modificationId}"`);
    }
    expect(html.match(/data-modification-summary-id=/g)).toHaveLength(2);
    expect(html.match(/data-modification-id=/g)).toHaveLength(2);
  });
});

describe('long-line expansion state', () => {
  it('keeps expansion by line and drops stale document state when switching documents', () => {
    const line: FullFileDiffLine = {
      type: 'context',
      content: 'long line',
      absoluteLineNumber: 206,
      oldLineNumber: 206,
      newLineNumber: 206,
    };
    let state = new Map<string, ReadonlySet<FullFileDiffLine>>();

    state = updateExpandedDiffLines(state, 'document-a', line, true);
    expect(state.get('document-a')?.has(line)).toBe(true);
    expect(state.get('document-b')).toBeUndefined();

    state = updateExpandedDiffLines(state, 'document-b', line, true);
    expect(state.get('document-a')).toBeUndefined();
    expect(state.get('document-b')?.has(line)).toBe(true);

    state = updateExpandedDiffLines(state, 'document-b', line, false);
    expect(state.get('document-a')).toBeUndefined();
    expect(state.get('document-b')).toBeUndefined();
  });

  it('does not reuse expansion when the same document receives new line objects', () => {
    const previousLine: FullFileDiffLine = {
      type: 'context',
      content: 'old content',
      absoluteLineNumber: 206,
    };
    const nextLine: FullFileDiffLine = {
      ...previousLine,
      content: 'new content',
    };
    const state = updateExpandedDiffLines(new Map(), 'document-a', previousLine, true);

    expect(state.get('document-a')?.has(previousLine)).toBe(true);
    expect(state.get('document-a')?.has(nextLine)).toBe(false);
  });
});

describe('virtual long-line layout', () => {
  it('re-estimates an expanded long row when the panel width changes', () => {
    const longLine: FullFileDiffLine = {
      type: 'context',
      content: `const DATA = [${'"entry",'.repeat(7_100)}];`,
      absoluteLineNumber: 206,
      oldLineNumber: 206,
      newLineNumber: 206,
    };
    const nextLine: FullFileDiffLine = {
      type: 'context',
      content: 'const COUNTRIES = [];',
      absoluteLineNumber: 207,
      oldLineNumber: 207,
      newLineNumber: 207,
    };
    const items: DiffRenderItem[] = [
      { type: 'context-line', key: 'line-206', line: longLine },
      { type: 'context-line', key: 'line-207', line: nextLine },
    ];
    const expandedLines = new Set([longLine]);
    const narrowLayout = buildVirtualLayout(items, new Map(), 420, expandedLines);
    const wideLayout = buildVirtualLayout(items, new Map(), 900, expandedLines);
    const collapsedLayout = buildVirtualLayout(items, new Map(), 900, new Set());

    expect(narrowLayout.heights[0]).toBeGreaterThan(wideLayout.heights[0]!);
    expect(wideLayout.heights[0]).toBeGreaterThan(80 * 24);
    expect(wideLayout.heights[0]).toBeGreaterThan(collapsedLayout.heights[0]!);

    const rangeNearLongLineEnd = clampVisibleRange(wideLayout, wideLayout.heights[0]! - 200, 600);
    expect(rangeNearLongLineEnd.endIndex).toBeGreaterThanOrEqual(1);

    const rangeAfterResizeClamp = clampVisibleRange(
      wideLayout,
      wideLayout.totalHeight + 1_000,
      600
    );
    expect(rangeAfterResizeClamp).toEqual({ startIndex: 1, endIndex: 1 });
  });
});
