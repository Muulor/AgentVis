/**
 * DiffLinePreview - long-line rendering budgets and UTF-16-safe previews.
 *
 * Kept separate from the React component so Vite Fast Refresh sees a component-only module.
 */

export const MAX_RENDERED_DIFF_LINE_CHARS = 8 * 1024;
export const MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS = 64 * 1024;
const LONG_LINE_PREVIEW_EDGE_CHARS = 1024;
const EXPANDED_LONG_LINE_PREVIEW_EDGE_CHARS = MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS / 2;

export interface DiffLinePreview {
  isTruncated: boolean;
  leading: string;
  trailing: string;
  omittedChars: number;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function getSafeLeadingEnd(content: string, requestedEnd: number): number {
  if (
    requestedEnd > 0 &&
    requestedEnd < content.length &&
    isHighSurrogate(content.charCodeAt(requestedEnd - 1)) &&
    isLowSurrogate(content.charCodeAt(requestedEnd))
  ) {
    return requestedEnd - 1;
  }

  return requestedEnd;
}

function getSafeTrailingStart(content: string, requestedStart: number): number {
  if (
    requestedStart > 0 &&
    requestedStart < content.length &&
    isHighSurrogate(content.charCodeAt(requestedStart - 1)) &&
    isLowSurrogate(content.charCodeAt(requestedStart))
  ) {
    return requestedStart + 1;
  }

  return requestedStart;
}

function buildBoundedDiffLinePreview(
  content: string,
  maxRenderedChars: number,
  edgeChars: number
): DiffLinePreview {
  if (content.length <= maxRenderedChars) {
    return {
      isTruncated: false,
      leading: content,
      trailing: '',
      omittedChars: 0,
    };
  }

  const leadingEnd = getSafeLeadingEnd(content, edgeChars);
  const trailingStart = getSafeTrailingStart(content, content.length - edgeChars);

  return {
    isTruncated: true,
    leading: content.slice(0, leadingEnd),
    trailing: content.slice(trailingStart),
    omittedChars: trailingStart - leadingEnd,
  };
}

export function buildDiffLinePreview(content: string): DiffLinePreview {
  return buildBoundedDiffLinePreview(
    content,
    MAX_RENDERED_DIFF_LINE_CHARS,
    LONG_LINE_PREVIEW_EDGE_CHARS
  );
}

export function buildExpandedDiffLinePreview(content: string): DiffLinePreview {
  return buildBoundedDiffLinePreview(
    content,
    MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS,
    EXPANDED_LONG_LINE_PREVIEW_EDGE_CHARS
  );
}
