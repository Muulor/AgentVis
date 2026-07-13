import { describe, expect, it } from 'vitest';
import {
  buildDiffSyntaxHighlight,
  buildNewContent,
  DIFF_SYNTAX_HIGHLIGHT_LIMITS,
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

  it('highlights an 8 KB line but falls back to plain text above the line budget', () => {
    const atLimit = 'x'.repeat(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    const overLimit = `${atLimit}x`;
    const atLimitLines = toContextLines(atLimit);
    const overLimitLines = toContextLines(overLimit);
    const atLimitHighlight = buildDiffSyntaxHighlight(atLimit, atLimitLines, 'html');
    const overLimitHighlight = buildDiffSyntaxHighlight(overLimit, overLimitLines, 'html');

    expect(getDiffLineTokens(atLimitLines[0]!, atLimitHighlight)).toBeDefined();
    expect(getDiffLineTokens(overLimitLines[0]!, overLimitHighlight)).toBeUndefined();
    expect(overLimitHighlight?.stats.fallbackReasons['line-too-long']).toBe(2);
    expect(overLimitHighlight?.stats.maxLineChars).toBe(
      DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars + 1
    );
  });

  it('keeps ordinary lines highlighted in an 86 KB diff with one 57 KB line', () => {
    const ordinaryLines = Array.from(
      { length: 565 },
      (_, index) => `const ordinaryValue${index} = "${'a'.repeat(24)}";`
    );
    const longLineIndex = 205;
    ordinaryLines.splice(longLineIndex, 0, `const payload = "${'x'.repeat(57_000)}";`);
    const code = ordinaryLines.join('\n');
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'javascript');

    expect(code.length).toBeGreaterThan(80 * 1_024);
    expect(lines).toHaveLength(566);
    expect(highlight).not.toBeNull();
    expect(getDiffLineTokens(lines[longLineIndex]!, highlight)).toBeUndefined();
    expect(getDiffLineTokens(lines[longLineIndex - 1]!, highlight)).toBeDefined();
    expect(getDiffLineTokens(lines[longLineIndex + 1]!, highlight)).toBeDefined();
    expect(highlight?.stats.fallbackReasons['line-too-long']).toBe(2);
    expect(highlight?.stats.maxLineChars).toBeGreaterThan(57_000);
  });

  it('preserves embedded script grammar after a skipped long HTML line', () => {
    const longDataLine = `  const DATA = [${'"entry",'.repeat(7_100)}];`;
    const sourceLines = Array.from(
      { length: 566 },
      (_, index) => `<div id="line-${index + 1}"></div>`
    );
    sourceLines[0] = '<html>';
    sourceLines[204] = '<script>';
    sourceLines[205] = longDataLine;
    for (let lineIndex = 206; lineIndex <= 304; lineIndex++) {
      sourceLines[lineIndex] = `const marker${lineIndex + 1} = DATA.length;`;
    }
    sourceLines[305] = '</script>';
    sourceLines[306] = '<section id="after-script">After</section>';
    sourceLines[565] = '</html>';
    const code = sourceLines.join('\n');
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'html');
    const tokensAt = (lineNumber: number) => getDiffLineTokens(lines[lineNumber - 1]!, highlight);

    expect(longDataLine.length).toBeGreaterThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    expect(tokensAt(206)).toBeUndefined();
    for (const lineNumber of [207, 280, 298, 305]) {
      expect(tokensAt(lineNumber)?.some((token) => token.types.includes('keyword'))).toBe(true);
    }
    expect(tokensAt(306)?.some((token) => token.types.includes('tag'))).toBe(true);
    expect(tokensAt(307)?.some((token) => token.types.includes('tag'))).toBe(true);
  });

  it('highlights a dense 207-like script line without relaxing the long-line guard', () => {
    const denseCountriesLine = `const COUNTRIES = [${Array.from(
      { length: 26 },
      (_, index) => `{"name": "Country ${index}", "count": ${index}, "val": ${index}.5}`
    ).join(', ')}];`;
    const sourceLines = [
      '<script>',
      `const DATA = [${'"entry",'.repeat(7_100)}];`,
      denseCountriesLine,
      'const INDUSTRIES = [{"name": "Artificial Intelligence", "count": 1}];',
      '</script>',
    ];
    const code = sourceLines.join('\n');
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'html');
    const tokensAt = (lineNumber: number) => getDiffLineTokens(lines[lineNumber - 1]!, highlight);

    expect(sourceLines[1]!.length).toBeGreaterThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    expect(tokensAt(2)).toBeUndefined();
    expect(tokensAt(3)?.some((token) => token.types.includes('keyword'))).toBe(true);
    expect(tokensAt(3)?.length).toBeGreaterThan(512);
    expect(tokensAt(3)?.length).toBeLessThanOrEqual(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxTokensPerLine);
    expect(tokensAt(4)?.some((token) => token.types.includes('keyword'))).toBe(true);
  });

  it('falls back after a block comment opens inside the omitted long-line context', () => {
    const longLine = `const payload = "${'x'.repeat(1_000)}"; /* hidden ${'x'.repeat(9_000)}`;
    const code = ['const before = true;', longLine, 'const after = true;'].join('\n');
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'javascript');

    expect(longLine.length).toBeGreaterThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    expect(getDiffLineTokens(lines[0]!, highlight)).toBeDefined();
    expect(getDiffLineTokens(lines[1]!, highlight)).toBeUndefined();
    expect(getDiffLineTokens(lines[2]!, highlight)).toBeUndefined();
    expect(highlight?.stats.fallbackReasons['context-state-unknown']).toBe(2);
  });

  it('falls back instead of extending a block comment after its close was omitted', () => {
    const longLine = `${'x'.repeat(1_000)} */ const hidden = true; ${'x'.repeat(9_000)}`;
    const code = ['const before = true;', '/* open', longLine, 'const after = true;'].join('\n');
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'javascript');

    expect(longLine.length).toBeGreaterThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    expect(getDiffLineTokens(lines[0]!, highlight)).toBeDefined();
    expect(getDiffLineTokens(lines[2]!, highlight)).toBeUndefined();
    expect(getDiffLineTokens(lines[3]!, highlight)).toBeUndefined();
    expect(highlight?.stats.fallbackReasons['context-state-unknown']).toBe(2);
  });

  it.each([
    {
      name: 'template literal',
      language: 'javascript',
      sourceLines: [
        'const before = true;',
        `${'x'.repeat(1_000)} \`hidden ${'x'.repeat(9_000)}`,
        'const after = true;',
      ],
    },
    {
      name: 'embedded script close tag',
      language: 'html',
      sourceLines: [
        '<script>',
        `const payload = "${'x'.repeat(1_000)}"; </script> ${'x'.repeat(9_000)}`,
        '<section>After</section>',
      ],
    },
  ])(
    'falls back when an omitted $name changes the following grammar',
    ({ language, sourceLines }) => {
      const code = sourceLines.join('\n');
      const lines = toContextLines(code);
      const highlight = buildDiffSyntaxHighlight(code, lines, language);

      expect(sourceLines[1]!.length).toBeGreaterThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
      expect(getDiffLineTokens(lines[1]!, highlight)).toBeUndefined();
      expect(getDiffLineTokens(lines[2]!, highlight)).toBeUndefined();
      expect(highlight?.stats.fallbackReasons['context-state-unknown']).toBe(2);
    }
  );

  it('falls back when enriched tokens exceed the per-line DOM budget', () => {
    const tokenHeavyLine = `${'value + '.repeat(600)}value;`;
    const code = `${tokenHeavyLine}\nconst ordinary = true;`;
    const lines = toContextLines(code);
    const highlight = buildDiffSyntaxHighlight(code, lines, 'javascript');

    expect(tokenHeavyLine.length).toBeLessThan(DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars);
    expect(getDiffLineTokens(lines[0]!, highlight)).toBeUndefined();
    expect(getDiffLineTokens(lines[1]!, highlight)).toBeDefined();
    expect(highlight?.stats.maxTokensPerLine).toBeGreaterThan(
      DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxTokensPerLine
    );
    expect(highlight?.stats.fallbackReasons['token-limit-exceeded']).toBe(2);
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
