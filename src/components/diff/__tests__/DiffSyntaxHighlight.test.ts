import { describe, expect, it } from 'vitest';
import {
  buildDiffSyntaxHighlight,
  buildNewContent,
  getDiffLineTokens,
  shouldHighlightDiff,
} from '../DiffSyntaxHighlight';
import type { FullFileDiffLine } from '../../../services/fast-apply/types';

const diffLines: FullFileDiffLine[] = [
  {
    type: 'remove',
    content: '<div class="old">',
    absoluteLineNumber: 1,
    oldLineNumber: 1,
    modificationId: 'mod-1',
  },
  {
    type: 'add',
    content: '<div class="new">',
    absoluteLineNumber: 1,
    newLineNumber: 1,
    modificationId: 'mod-1',
  },
  {
    type: 'context',
    content: '</div>',
    absoluteLineNumber: 2,
    oldLineNumber: 2,
    newLineNumber: 2,
  },
];

function toContextLines(content: string): FullFileDiffLine[] {
  return content.split('\n').map((line, index) => ({
    type: 'context',
    content: line,
    absoluteLineNumber: index + 1,
    oldLineNumber: index + 1,
    newLineNumber: index + 1,
  }));
}

function hasTokenType(
  highlight: ReturnType<typeof buildDiffSyntaxHighlight>,
  content: string,
  type: string
): boolean {
  return (
    highlight?.newLines
      .flat()
      .some((token) => token.content === content && token.types.includes(type)) ?? false
  );
}

describe('DiffSyntaxHighlight', () => {
  it('rebuilds the new side without removed lines', () => {
    expect(buildNewContent(diffLines)).toBe('<div class="new">\n</div>');
  });

  it('tokenizes old and new sides once and resolves tokens by their own line numbers', () => {
    const highlight = buildDiffSyntaxHighlight('<div class="old">\n</div>', diffLines, 'html');

    expect(highlight).not.toBeNull();
    expect(
      getDiffLineTokens(diffLines[0]!, highlight)
        ?.map((token) => token.content)
        .join('')
    ).toBe('<div class="old">');
    expect(
      getDiffLineTokens(diffLines[1]!, highlight)
        ?.map((token) => token.content)
        .join('')
    ).toBe('<div class="new">');
    expect(
      getDiffLineTokens(diffLines[1]!, highlight)?.some((token) => token.types.length > 1)
    ).toBe(true);
  });

  it('falls back to plain text for unknown languages and oversized diffs', () => {
    expect(shouldHighlightDiff('a', diffLines, 'text')).toBe(false);
    expect(shouldHighlightDiff('a', diffLines, 'unknown-language')).toBe(false);

    const oversizedLine = { ...diffLines[1]!, content: 'x'.repeat(300_001) };
    expect(shouldHighlightDiff('a', [oversizedLine], 'html')).toBe(false);
  });

  it('does not apply tokens when line content and line-number mapping disagree', () => {
    const highlight = buildDiffSyntaxHighlight('<div class="old">\n</div>', diffLines, 'html');
    const mismatchedLine = { ...diffLines[1]!, content: '<span>different</span>' };

    expect(getDiffLineTokens(mismatchedLine, highlight)).toBeUndefined();
  });

  it('enriches TypeScript plain identifiers without changing source content', () => {
    const code = [
      'function build(items: RenderItem[], width: number) {',
      '  const result = items.map(item => item.width);',
      '  return { schemaVersion: result, width };',
      '}',
    ].join('\n');
    const highlight = buildDiffSyntaxHighlight(code, toContextLines(code), 'typescript');

    expect(
      highlight?.newLines.map((line) => line.map((token) => token.content).join('')).join('\n')
    ).toBe(code);
    expect(hasTokenType(highlight, 'items', 'parameter')).toBe(true);
    expect(hasTokenType(highlight, 'width', 'parameter')).toBe(true);
    expect(hasTokenType(highlight, 'RenderItem', 'type-name')).toBe(true);
    expect(hasTokenType(highlight, 'result', 'variable')).toBe(true);
    expect(hasTokenType(highlight, 'item', 'parameter')).toBe(true);
    expect(hasTokenType(highlight, 'width', 'property-access')).toBe(true);
    expect(hasTokenType(highlight, 'schemaVersion', 'property')).toBe(true);
  });

  it('keeps JSX child text plain while enriching identifiers inside expressions', () => {
    const code = 'const view = <div>Hello world {user.name}</div>;';
    const highlight = buildDiffSyntaxHighlight(code, toContextLines(code), 'tsx');
    const childTextToken = highlight?.newLines
      .flat()
      .find((token) => token.content.includes('world'));

    expect(childTextToken?.types).toContain('plain');
    expect(hasTokenType(highlight, 'view', 'variable')).toBe(true);
    expect(hasTokenType(highlight, 'user', 'variable')).toBe(true);
  });
});
