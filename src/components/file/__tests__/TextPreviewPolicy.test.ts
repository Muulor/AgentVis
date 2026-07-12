import { describe, expect, it } from 'vitest';
import {
  decideTextPreview,
  getTextPreviewKind,
  type TextPreviewAnalysis,
} from '../TextPreviewPolicy';

function analysis(overrides: Partial<TextPreviewAnalysis> = {}): TextPreviewAnalysis {
  return {
    totalBytes: 100,
    scannedBytes: 100,
    lineCount: 10,
    maxLineBytes: 40,
    markdownLinkCount: 0,
    markdownImageCount: 0,
    markdownTableRowCount: 0,
    markdownTableCellCount: 0,
    maxCodeBlockBytes: 0,
    scanTruncated: false,
    ...overrides,
  };
}

describe('TextPreviewPolicy', () => {
  it('classifies renderer-specific text kinds', () => {
    expect(getTextPreviewKind('README.md')).toBe('markdown');
    expect(getTextPreviewKind('index.html')).toBe('html');
    expect(getTextPreviewKind('main.ts')).toBe('code');
    expect(getTextPreviewKind('notes.txt')).toBe('plainText');
  });

  it('keeps small low-complexity Markdown in rich mode', () => {
    expect(decideTextPreview('README.md', 64 * 1024, analysis()).mode).toBe('rich');
  });

  it('routes large Markdown to bounded safe mode', () => {
    const size = 640 * 1024;
    const decision = decideTextPreview(
      'README.md',
      size,
      analysis({ totalBytes: size, scannedBytes: size })
    );
    expect(decision.mode).toBe('safe');
    expect(decision.reason).toBe('fileSize');
  });

  it('routes structurally dense Markdown to bounded safe mode', () => {
    const decision = decideTextPreview(
      'table.md',
      200 * 1024,
      analysis({ markdownTableCellCount: 2_500 })
    );
    expect(decision.mode).toBe('safe');
    expect(decision.reason).toBe('tableComplexity');
  });

  it('routes very large text files to external-first mode', () => {
    const decision = decideTextPreview('server.log', 9 * 1024 * 1024);
    expect(decision.mode).toBe('external');
    expect(decision.reason).toBe('hardLimit');
  });

  it('uses analyzed bytes when the listed file size is stale', () => {
    const actualSize = 9 * 1024 * 1024;
    const decision = decideTextPreview(
      'growing.md',
      64 * 1024,
      analysis({ totalBytes: actualSize, scannedBytes: 4 * 1024 * 1024, scanTruncated: true })
    );

    expect(decision.mode).toBe('external');
    expect(decision.reason).toBe('hardLimit');
    expect(decision.size).toBe(actualSize);
  });
});
