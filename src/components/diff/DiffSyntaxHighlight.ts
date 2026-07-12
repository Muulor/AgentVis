/**
 * DiffSyntaxHighlight - Diff 语法高亮数据生成
 *
 * 在空闲时段为原始/新版本代码各执行一次 Prism token 化，并按行号提供给虚拟化 Diff。
 * 超过预算或语言未知时返回纯文本降级，避免高亮工作阻塞 Diff 审批交互。
 */

import { startTransition, useEffect, useState } from 'react';
import { normalizeTokens, Prism, type Token } from 'prism-react-renderer';
import { getCodeLanguage } from '@services/file-types';
import type { FullFileDiffLine } from '../../services/fast-apply/types';

const MAX_HIGHLIGHT_CHARS = 300_000;
const MAX_HIGHLIGHT_LINES = 6_000;
const IDLE_TIMEOUT_MS = 300;
const IDENTIFIER_CANDIDATE_TYPE = 'diff-identifier-candidate';
const JAVASCRIPT_FAMILY_LANGUAGES = new Set(['javascript', 'typescript', 'jsx', 'tsx']);
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g;

export interface DiffSyntaxHighlightData {
  language: string;
  oldLines: Token[][];
  newLines: Token[][];
}

interface ScheduledHighlightData extends DiffSyntaxHighlightData {
  originalContent: string;
  sourceLines: FullFileDiffLine[];
}

export function shouldHighlightDiff(
  originalContent: string,
  lines: FullFileDiffLine[],
  language: string
): boolean {
  if (
    lines.length === 0 ||
    language === 'text' ||
    !Prism.languages[language] ||
    originalContent.length > MAX_HIGHLIGHT_CHARS
  ) {
    return false;
  }

  let newLineCount = 0;
  let newContentLength = 0;
  for (const line of lines) {
    if (line.type === 'remove') continue;
    newLineCount++;
    newContentLength += line.content.length;

    if (
      newLineCount > MAX_HIGHLIGHT_LINES ||
      originalContent.length + newContentLength + newLineCount - 1 > MAX_HIGHLIGHT_CHARS
    ) {
      return false;
    }
  }

  const oldLineCount = originalContent.split('\n', MAX_HIGHLIGHT_LINES + 1).length;
  return oldLineCount <= MAX_HIGHLIGHT_LINES;
}

export function buildNewContent(lines: FullFileDiffLine[]): string {
  const content: string[] = [];

  for (const line of lines) {
    if (line.type !== 'remove') {
      content.push(line.content);
    }
  }

  return content.join('\n');
}

function splitPlainToken(token: Token): Token[] {
  if (!token.types.includes('plain')) return [token];

  const result: Token[] = [];
  let cursor = 0;
  IDENTIFIER_PATTERN.lastIndex = 0;

  for (const match of token.content.matchAll(IDENTIFIER_PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      result.push({ types: token.types, content: token.content.slice(cursor, start) });
    }

    result.push({
      types: [IDENTIFIER_CANDIDATE_TYPE],
      content: match[0],
    });
    cursor = start + match[0].length;
  }

  if (cursor < token.content.length || result.length === 0) {
    result.push({ types: token.types, content: token.content.slice(cursor) });
  }

  return result;
}

function splitPlainIdentifiers(tokens: Token[][], language: string): Token[][] {
  const isTsx = language === 'tsx' || language === 'jsx';
  let jsxDepth = 0;
  let jsxExpressionDepth = 0;
  let pendingTag: 'open' | 'close' | null = null;

  return tokens.map((line) => {
    const nextLine: Token[] = [];

    for (const token of line) {
      const isTagPunctuation = token.types.includes('tag') && token.types.includes('punctuation');
      const isJsxText = isTsx && jsxDepth > 0 && jsxExpressionDepth === 0 && pendingTag === null;

      if (isTagPunctuation) {
        if (token.content === '<') {
          pendingTag = 'open';
        } else if (token.content === '</') {
          pendingTag = 'close';
        } else if (token.content === '/>') {
          pendingTag = null;
        } else if (token.content === '>') {
          if (pendingTag === 'open') jsxDepth++;
          if (pendingTag === 'close') jsxDepth = Math.max(0, jsxDepth - 1);
          pendingTag = null;
        }
      } else if (isTsx && jsxDepth > 0) {
        if (jsxExpressionDepth === 0 && token.content === '{') {
          jsxExpressionDepth = 1;
        } else if (jsxExpressionDepth > 0) {
          if (token.content === '{') jsxExpressionDepth++;
          if (token.content === '}') jsxExpressionDepth--;
        }
      }

      nextLine.push(...(isJsxText ? [token] : splitPlainToken(token)));
    }

    return nextLine;
  });
}

interface FlatToken {
  token: Token;
  lineIndex: number;
  tokenIndex: number;
}

function isSignificantToken(token: Token): boolean {
  return token.content.trim().length > 0;
}

function getSignificantNeighbor(
  tokens: FlatToken[],
  startIndex: number,
  direction: -1 | 1
): number | undefined {
  for (
    let index = startIndex + direction;
    index >= 0 && index < tokens.length;
    index += direction
  ) {
    const entry = tokens[index];
    if (entry && isSignificantToken(entry.token)) return index;
  }

  return undefined;
}

function buildParameterRanges(tokens: FlatToken[]): Array<[number, number]> {
  const stack: number[] = [];
  const pairs: Array<[number, number]> = [];

  for (let index = 0; index < tokens.length; index++) {
    const content = tokens[index]?.token.content;
    if (content === '(') {
      stack.push(index);
    } else if (content === ')') {
      const openIndex = stack.pop();
      if (openIndex !== undefined) pairs.push([openIndex, index]);
    }
  }

  return pairs.filter(([openIndex, closeIndex]) => {
    const beforeOpenIndex = getSignificantNeighbor(tokens, openIndex, -1);
    const beforeOpen = beforeOpenIndex === undefined ? undefined : tokens[beforeOpenIndex]?.token;
    const beforeBeforeOpenIndex =
      beforeOpenIndex === undefined
        ? undefined
        : getSignificantNeighbor(tokens, beforeOpenIndex, -1);
    const beforeBeforeOpen =
      beforeBeforeOpenIndex === undefined ? undefined : tokens[beforeBeforeOpenIndex]?.token;
    const afterCloseIndex = getSignificantNeighbor(tokens, closeIndex, 1);
    const afterClose = afterCloseIndex === undefined ? undefined : tokens[afterCloseIndex]?.token;

    const followsFunctionKeyword =
      beforeOpen?.content === 'function' ||
      (beforeOpen?.types.includes('function') === true && beforeBeforeOpen?.content === 'function');
    const isArrowFunction = afterClose?.content === '=>';
    const isMethodDeclaration =
      beforeOpen?.types.includes('function') === true &&
      (afterClose?.content === '{' || afterClose?.content === ':');

    return followsFunctionKeyword || isArrowFunction || isMethodDeclaration;
  });
}

function buildParameterMask(tokens: FlatToken[]): boolean[] {
  const changes = Array<number>(tokens.length + 1).fill(0);

  for (const [start, end] of buildParameterRanges(tokens)) {
    changes[start + 1] = (changes[start + 1] ?? 0) + 1;
    changes[end] = (changes[end] ?? 0) - 1;
  }

  const mask = Array<boolean>(tokens.length).fill(false);
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    depth += changes[index] ?? 0;
    mask[index] = depth > 0;
  }

  return mask;
}

function classifyIdentifier(tokens: FlatToken[], index: number, parameterMask: boolean[]): string {
  const previousIndex = getSignificantNeighbor(tokens, index, -1);
  const nextIndex = getSignificantNeighbor(tokens, index, 1);
  const previous = previousIndex === undefined ? undefined : tokens[previousIndex]?.token;
  const next = nextIndex === undefined ? undefined : tokens[nextIndex]?.token;
  const content = tokens[index]?.token.content ?? '';

  if (previous?.content === '.' || previous?.content === '?.') return 'property-access';

  const isParameter = parameterMask[index] === true || next?.content === '=>';
  if (previous?.content === ':' && /^[A-Z]/.test(content)) return 'type-name';
  if (isParameter) return 'parameter';
  if (next?.content === ':') return 'property';

  return 'variable';
}

export function enrichJavaScriptSyntaxTokens(tokens: Token[][], language: string): Token[][] {
  if (!JAVASCRIPT_FAMILY_LANGUAGES.has(language)) return tokens;

  const enriched = splitPlainIdentifiers(tokens, language);
  const flatTokens: FlatToken[] = [];
  enriched.forEach((line, lineIndex) => {
    line.forEach((token, tokenIndex) => flatTokens.push({ token, lineIndex, tokenIndex }));
  });
  const parameterMask = buildParameterMask(flatTokens);

  for (let index = 0; index < flatTokens.length; index++) {
    const entry = flatTokens[index];
    if (!entry?.token.types.includes(IDENTIFIER_CANDIDATE_TYPE)) continue;
    const line = enriched[entry.lineIndex];
    if (!line) continue;

    line[entry.tokenIndex] = {
      types: [classifyIdentifier(flatTokens, index, parameterMask)],
      content: entry.token.content,
    };
  }

  return enriched;
}

function tokenizeCode(code: string, language: string): Token[][] {
  const grammar = Prism.languages[language];
  if (!grammar) return [];
  const tokens = normalizeTokens(Prism.tokenize(code, grammar));
  return enrichJavaScriptSyntaxTokens(tokens, language);
}

export function buildDiffSyntaxHighlight(
  originalContent: string,
  lines: FullFileDiffLine[],
  language: string
): DiffSyntaxHighlightData | null {
  if (!shouldHighlightDiff(originalContent, lines, language)) return null;

  try {
    return {
      language,
      oldLines: tokenizeCode(originalContent, language),
      newLines: tokenizeCode(buildNewContent(lines), language),
    };
  } catch {
    return null;
  }
}

export function getDiffLineTokens(
  line: FullFileDiffLine,
  highlight: DiffSyntaxHighlightData | null
): Token[] | undefined {
  if (!highlight) return undefined;

  const lineNumber = line.type === 'remove' ? line.oldLineNumber : line.newLineNumber;
  const source = line.type === 'remove' ? highlight.oldLines : highlight.newLines;
  const tokens = lineNumber ? source[lineNumber - 1] : undefined;

  if (tokens?.map((token) => token.content).join('') !== line.content) {
    return undefined;
  }

  return tokens;
}

export function useDiffSyntaxHighlight(
  originalContent: string,
  lines: FullFileDiffLine[],
  fileName: string
): DiffSyntaxHighlightData | null {
  const language = getCodeLanguage(fileName);
  const [scheduledData, setScheduledData] = useState<ScheduledHighlightData | null>(null);
  const isCurrent =
    scheduledData?.originalContent === originalContent &&
    scheduledData.sourceLines === lines &&
    scheduledData.language === language;

  useEffect(() => {
    if (!shouldHighlightDiff(originalContent, lines, language)) return;

    let cancelled = false;
    const run = () => {
      const highlight = buildDiffSyntaxHighlight(originalContent, lines, language);
      if (cancelled || !highlight) return;

      startTransition(() => {
        setScheduledData({
          ...highlight,
          originalContent,
          sourceLines: lines,
        });
      });
    };

    let cancelScheduledWork: () => void;
    if (typeof window.requestIdleCallback === 'function') {
      const requestId = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      cancelScheduledWork = () => window.cancelIdleCallback(requestId);
    } else {
      const timeoutId = window.setTimeout(run, 16);
      cancelScheduledWork = () => window.clearTimeout(timeoutId);
    }

    return () => {
      cancelled = true;
      cancelScheduledWork();
    };
  }, [language, lines, originalContent]);

  return isCurrent ? scheduledData : null;
}
