/**
 * TextPreviewPolicy - 文本类文件预览预算
 *
 * 根据渲染器成本、文件大小和 Markdown 结构复杂度，在完整渲染、
 * 有界安全预览和外部应用打开之间做统一决策。
 */

import { isCodeFile, isHtmlFile, isMarkdownFile } from '@services/file-types';

export type TextPreviewKind = 'markdown' | 'code' | 'html' | 'plainText';
export type TextPreviewMode = 'rich' | 'safe' | 'external';
export type TextPreviewReason =
  | 'withinBudget'
  | 'fileSize'
  | 'lineCount'
  | 'longLine'
  | 'linkCount'
  | 'tableComplexity'
  | 'codeBlockSize'
  | 'hardLimit';

export interface TextPreviewAnalysis {
  totalBytes: number;
  scannedBytes: number;
  lineCount: number;
  maxLineBytes: number;
  markdownLinkCount: number;
  markdownImageCount: number;
  markdownTableRowCount: number;
  markdownTableCellCount: number;
  maxCodeBlockBytes: number;
  scanTruncated: boolean;
}

export interface TextPreviewDecision {
  kind: TextPreviewKind;
  mode: TextPreviewMode;
  reason: TextPreviewReason;
  size: number;
  analysis?: TextPreviewAnalysis;
}

export interface TextFileWindow {
  content: string;
  startByte: number;
  nextByte: number;
  totalBytes: number;
  eof: boolean;
}

export const TEXT_PREVIEW_WINDOW_BYTES = 64 * 1024;
export const TEXT_PREVIEW_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

export function createInlineTextWindow(bytes: Uint8Array, start: number): TextFileWindow {
  const startByte = Math.max(0, Math.min(Math.trunc(start), bytes.length));
  let nextByte = Math.min(startByte + TEXT_PREVIEW_WINDOW_BYTES, bytes.length);

  // 如果窗口末端落在 UTF-8 多字节字符中间，回退到该字符的起始位置。
  while (nextByte < bytes.length && nextByte > startByte) {
    const boundaryByte = bytes[nextByte];
    if (boundaryByte === undefined || (boundaryByte & 0xc0) !== 0x80) break;
    nextByte -= 1;
  }

  const content = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(startByte, nextByte)
  );
  return {
    content,
    startByte,
    nextByte,
    totalBytes: bytes.length,
    eof: nextByte >= bytes.length,
  };
}

const RICH_SIZE_LIMITS: Record<TextPreviewKind, number> = {
  markdown: 512 * 1024,
  code: 384 * 1024,
  html: 500 * 1024,
  plainText: 1024 * 1024,
};

const MAX_RICH_LINES = 8_000;
const MAX_RICH_LINE_BYTES = 128 * 1024;
const MAX_MARKDOWN_LINKS = 1_000;
const MAX_MARKDOWN_TABLE_CELLS = 2_000;
const MAX_MARKDOWN_TABLE_ROWS = 300;
const MAX_MARKDOWN_CODE_BLOCK_BYTES = 100 * 1024;

export function getTextPreviewKind(fileName: string): TextPreviewKind {
  if (isMarkdownFile(fileName)) return 'markdown';
  if (isHtmlFile(fileName)) return 'html';
  if (isCodeFile(fileName)) return 'code';
  return 'plainText';
}

export function decideTextPreview(
  fileName: string,
  size: number,
  analysis?: TextPreviewAnalysis
): TextPreviewDecision {
  const kind = getTextPreviewKind(fileName);
  // 文件列表中的大小可能在预览前已经过期；完成后端分析后，以本次读取到的
  // 实际元数据为准，避免持续写入中的文件绕过全文渲染硬上限。
  const effectiveSize = analysis?.totalBytes ?? size;
  const base = { kind, size: effectiveSize, ...(analysis ? { analysis } : {}) };

  if (effectiveSize > TEXT_PREVIEW_HARD_LIMIT_BYTES) {
    return { ...base, mode: 'external', reason: 'hardLimit' };
  }
  if (effectiveSize > RICH_SIZE_LIMITS[kind]) {
    return { ...base, mode: 'safe', reason: 'fileSize' };
  }
  if (!analysis) {
    return { ...base, mode: 'rich', reason: 'withinBudget' };
  }
  if (analysis.lineCount > MAX_RICH_LINES) {
    return { ...base, mode: 'safe', reason: 'lineCount' };
  }
  if (analysis.maxLineBytes > MAX_RICH_LINE_BYTES) {
    return { ...base, mode: 'safe', reason: 'longLine' };
  }
  if (kind === 'markdown') {
    if (analysis.markdownTableCellCount > MAX_MARKDOWN_TABLE_CELLS) {
      return { ...base, mode: 'safe', reason: 'tableComplexity' };
    }
    if (analysis.markdownTableRowCount > MAX_MARKDOWN_TABLE_ROWS) {
      return { ...base, mode: 'safe', reason: 'tableComplexity' };
    }
    if (analysis.markdownLinkCount > MAX_MARKDOWN_LINKS) {
      return { ...base, mode: 'safe', reason: 'linkCount' };
    }
    if (analysis.maxCodeBlockBytes > MAX_MARKDOWN_CODE_BLOCK_BYTES) {
      return { ...base, mode: 'safe', reason: 'codeBlockSize' };
    }
  }

  return { ...base, mode: 'rich', reason: 'withinBudget' };
}
