/**
 * DiffSyntaxHighlight - Diff 语法高亮数据生成
 *
 * 在空闲时段按安全行片段执行 Prism token 化，并按行号提供给虚拟化 Diff。
 * 超过整文件、单行或 token 预算时返回纯文本降级，避免高亮工作阻塞 Diff 审批交互。
 */

import { startTransition, useEffect, useState } from 'react';
import { normalizeTokens, Prism, type Token } from 'prism-react-renderer';
import { getCodeLanguage } from '@services/file-types';
import {
  measureRendererWork,
  reportRendererHealthSnapshot,
  setRendererHealthStage,
} from '@services/diagnostics/rendererHealth';
import type { FullFileDiffLine } from '../../services/fast-apply/types';

export const DIFF_SYNTAX_HIGHLIGHT_LIMITS = {
  maxTotalChars: 300_000,
  maxLines: 6_000,
  maxLineChars: 8 * 1_024,
  maxTokensPerLine: 640,
} as const;

const IDLE_TIMEOUT_MS = 300;
const LONG_LINE_CONTEXT_EDGE_CHARS = 512;
const IDENTIFIER_CANDIDATE_TYPE = 'diff-identifier-candidate';
const JAVASCRIPT_FAMILY_LANGUAGES = new Set(['javascript', 'typescript', 'jsx', 'tsx']);
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g;

export interface DiffSyntaxHighlightData {
  language: string;
  oldLines: Token[][];
  newLines: Token[][];
  stats: DiffSyntaxHighlightStats;
}

export type DiffSyntaxHighlightFallbackReason =
  | 'line-too-long'
  | 'token-limit-exceeded'
  | 'context-state-unknown';

export interface DiffSyntaxHighlightStats {
  oldTokenCount: number;
  newTokenCount: number;
  maxLineChars: number;
  maxTokensPerLine: number;
  highlightedLineCount: number;
  fallbackLineCount: number;
  fallbackReasons: Record<DiffSyntaxHighlightFallbackReason, number>;
}

interface TokenizeCodeResult {
  lines: Token[][];
  tokenCount: number;
  maxLineChars: number;
  maxTokensPerLine: number;
  highlightedLineCount: number;
  fallbackReasons: Record<DiffSyntaxHighlightFallbackReason, number>;
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
    originalContent.length > DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxTotalChars
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
      newLineCount > DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLines ||
      originalContent.length + newContentLength + newLineCount - 1 >
        DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxTotalChars
    ) {
      return false;
    }
  }

  const oldLineCount = originalContent.split(
    '\n',
    DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLines + 1
  ).length;
  return oldLineCount <= DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLines;
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

function tokenizeCodeChunk(code: string, language: string): Token[][] {
  const grammar = Prism.languages[language];
  if (!grammar) return [];
  const tokens = normalizeTokens(Prism.tokenize(code, grammar));
  return enrichJavaScriptSyntaxTokens(tokens, language);
}

function createFallbackReasonCounts(): Record<DiffSyntaxHighlightFallbackReason, number> {
  return {
    'line-too-long': 0,
    'token-limit-exceeded': 0,
    'context-state-unknown': 0,
  };
}

type JavaScriptFrame =
  | { kind: 'code'; templateExpressionDepth: number | null }
  | { kind: 'block-comment' }
  | { kind: 'string'; quote: "'" | '"'; continued: boolean }
  | { kind: 'template' };

interface JavaScriptContextState {
  frames: JavaScriptFrame[];
  uncertain: boolean;
}

type MarkupMode = 'data' | 'comment' | 'cdata' | 'tag' | 'script' | 'style';

interface MarkupContextState {
  mode: MarkupMode;
  tagName: string | null;
  tagClosing: boolean;
  tagQuote: "'" | '"' | null;
  lastTagNonWhitespace: string | null;
  javascript: JavaScriptContextState;
}

type LongLineContextState =
  | { kind: 'javascript'; state: JavaScriptContextState }
  | { kind: 'markup'; state: MarkupContextState };

function createJavaScriptContextState(): JavaScriptContextState {
  return {
    frames: [{ kind: 'code', templateExpressionDepth: null }],
    uncertain: false,
  };
}

function cloneJavaScriptContextState(state: JavaScriptContextState): JavaScriptContextState {
  return {
    frames: state.frames.map((frame) => ({ ...frame })),
    uncertain: state.uncertain,
  };
}

function finishJavaScriptLine(state: JavaScriptContextState): void {
  const frame = state.frames.at(-1);
  if (frame?.kind !== 'string') return;

  if (frame.continued) {
    frame.continued = false;
  } else {
    state.frames.pop();
  }
}

/**
 * Track only lexical state that can affect later lines. This intentionally is not a
 * highlighter: ambiguous regular-expression and JSX boundaries make the state uncertain,
 * which causes a plain-text fallback instead of guessing.
 */
function scanJavaScriptSegment(
  source: string,
  state: JavaScriptContextState,
  language: string,
  finishLine: boolean
): void {
  let index = 0;

  while (index < source.length) {
    const frame = state.frames.at(-1);
    const character = source[index] ?? '';
    const nextCharacter = source[index + 1] ?? '';

    if (!frame) {
      state.uncertain = true;
      break;
    }

    if (frame.kind === 'block-comment') {
      const closeIndex = source.indexOf('*/', index);
      if (closeIndex === -1) {
        index = source.length;
      } else {
        state.frames.pop();
        index = closeIndex + 2;
      }
      continue;
    }

    if (frame.kind === 'string') {
      if (character === '\\') {
        if (index + 1 < source.length) {
          index += 2;
        } else {
          frame.continued = true;
          index++;
        }
      } else if (character === frame.quote) {
        state.frames.pop();
        index++;
      } else {
        index++;
      }
      continue;
    }

    if (frame.kind === 'template') {
      if (character === '\\') {
        index = Math.min(source.length, index + 2);
      } else if (character === '`') {
        state.frames.pop();
        index++;
      } else if (character === '$' && nextCharacter === '{') {
        state.frames.push({ kind: 'code', templateExpressionDepth: 1 });
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      index = source.length;
    } else if (character === '/' && nextCharacter === '*') {
      state.frames.push({ kind: 'block-comment' });
      index += 2;
    } else if (character === '/') {
      // A parser is required to distinguish division from a regular-expression literal.
      state.uncertain = true;
      index++;
    } else if (character === "'" || character === '"') {
      state.frames.push({ kind: 'string', quote: character, continued: false });
      index++;
    } else if (character === '`') {
      state.frames.push({ kind: 'template' });
      index++;
    } else if (
      (language === 'jsx' || language === 'tsx') &&
      character === '<' &&
      /[A-Za-z/]/.test(nextCharacter)
    ) {
      // JSX text/tag parsing is context sensitive; never infer it with this bounded scanner.
      state.uncertain = true;
      index++;
    } else if (frame.templateExpressionDepth !== null && character === '{') {
      frame.templateExpressionDepth++;
      index++;
    } else if (frame.templateExpressionDepth !== null && character === '}') {
      frame.templateExpressionDepth--;
      if (frame.templateExpressionDepth === 0) state.frames.pop();
      index++;
    } else {
      index++;
    }
  }

  if (finishLine) finishJavaScriptLine(state);
}

function createMarkupContextState(): MarkupContextState {
  return {
    mode: 'data',
    tagName: null,
    tagClosing: false,
    tagQuote: null,
    lastTagNonWhitespace: null,
    javascript: createJavaScriptContextState(),
  };
}

function cloneMarkupContextState(state: MarkupContextState): MarkupContextState {
  return {
    ...state,
    javascript: cloneJavaScriptContextState(state.javascript),
  };
}

function findRawClosingTag(
  source: string,
  lowerSource: string,
  startIndex: number,
  tagName: string
): number {
  const needle = `</${tagName}`;
  let matchIndex = lowerSource.indexOf(needle, startIndex);

  while (matchIndex !== -1) {
    const afterName = source[matchIndex + needle.length];
    if (afterName === undefined || /[\s/>]/.test(afterName)) return matchIndex;
    matchIndex = lowerSource.indexOf(needle, matchIndex + needle.length);
  }

  return -1;
}

function finishMarkupTag(state: MarkupContextState): void {
  const tagName = state.tagName;
  const isSelfClosing = state.lastTagNonWhitespace === '/';

  if (!state.tagClosing && !isSelfClosing && tagName === 'script') {
    state.mode = 'script';
    state.javascript = createJavaScriptContextState();
  } else if (!state.tagClosing && !isSelfClosing && tagName === 'style') {
    state.mode = 'style';
  } else {
    state.mode = 'data';
  }

  state.tagName = null;
  state.tagClosing = false;
  state.tagQuote = null;
  state.lastTagNonWhitespace = null;
}

function tryStartMarkupTag(
  source: string,
  index: number,
  state: MarkupContextState
): number | undefined {
  let cursor = index + 1;
  while (/\s/.test(source[cursor] ?? '')) cursor++;

  const tagClosing = source[cursor] === '/';
  if (tagClosing) cursor++;
  while (/\s/.test(source[cursor] ?? '')) cursor++;

  const markerCharacter = source[cursor];
  const marker = markerCharacter === '!' || markerCharacter === '?' ? markerCharacter : '';
  if (marker) cursor++;
  if (!/[A-Za-z]/.test(source[cursor] ?? '')) return undefined;

  const nameStart = cursor;
  cursor++;
  while (/[\w:-]/.test(source[cursor] ?? '')) cursor++;
  const tagName = source.slice(nameStart, cursor).toLowerCase();

  state.mode = 'tag';
  state.tagClosing = tagClosing;
  state.tagName = tagName;
  state.tagQuote = null;
  state.lastTagNonWhitespace = tagName.at(-1) ?? marker;
  return cursor;
}

function scanMarkupLine(source: string, state: MarkupContextState): void {
  const lowerSource = source.toLowerCase();
  let index = 0;

  while (index < source.length) {
    if (state.mode === 'comment') {
      const closeIndex = source.indexOf('-->', index);
      if (closeIndex === -1) return;
      state.mode = 'data';
      index = closeIndex + 3;
      continue;
    }

    if (state.mode === 'cdata') {
      const closeIndex = source.indexOf(']]>', index);
      if (closeIndex === -1) return;
      state.mode = 'data';
      index = closeIndex + 3;
      continue;
    }

    if (state.mode === 'script') {
      const closeIndex = findRawClosingTag(source, lowerSource, index, 'script');
      if (closeIndex === -1) {
        scanJavaScriptSegment(source.slice(index), state.javascript, 'javascript', true);
        return;
      }

      scanJavaScriptSegment(source.slice(index, closeIndex), state.javascript, 'javascript', false);
      state.mode = 'tag';
      state.tagName = 'script';
      state.tagClosing = true;
      state.tagQuote = null;
      state.lastTagNonWhitespace = 't';
      index = closeIndex + '</script'.length;
      continue;
    }

    if (state.mode === 'style') {
      const closeIndex = findRawClosingTag(source, lowerSource, index, 'style');
      if (closeIndex === -1) return;
      state.mode = 'tag';
      state.tagName = 'style';
      state.tagClosing = true;
      state.tagQuote = null;
      state.lastTagNonWhitespace = 'e';
      index = closeIndex + '</style'.length;
      continue;
    }

    if (state.mode === 'tag') {
      const character = source[index] ?? '';
      if (state.tagQuote) {
        if (character === state.tagQuote) state.tagQuote = null;
      } else if (character === "'" || character === '"') {
        state.tagQuote = character;
      } else if (character === '>') {
        finishMarkupTag(state);
      } else if (!/\s/.test(character)) {
        state.lastTagNonWhitespace = character;
      }
      index++;
      continue;
    }

    if (source.startsWith('<!--', index)) {
      state.mode = 'comment';
      index += 4;
    } else if (source.startsWith('<![CDATA[', index)) {
      state.mode = 'cdata';
      index += '<![CDATA['.length;
    } else if (source[index] === '<') {
      index = tryStartMarkupTag(source, index, state) ?? index + 1;
    } else {
      index++;
    }
  }
}

function createLongLineContextState(language: string): LongLineContextState | null {
  if (JAVASCRIPT_FAMILY_LANGUAGES.has(language)) {
    return { kind: 'javascript', state: createJavaScriptContextState() };
  }
  if (language === 'html' || language === 'markup') {
    return { kind: 'markup', state: createMarkupContextState() };
  }
  return null;
}

function cloneLongLineContextState(state: LongLineContextState): LongLineContextState {
  return state.kind === 'javascript'
    ? { kind: 'javascript', state: cloneJavaScriptContextState(state.state) }
    : { kind: 'markup', state: cloneMarkupContextState(state.state) };
}

function scanLongLineContext(
  sourceLine: string,
  language: string,
  state: LongLineContextState
): void {
  if (state.kind === 'javascript') {
    scanJavaScriptSegment(sourceLine, state.state, language, true);
  } else {
    scanMarkupLine(sourceLine, state.state);
  }
}

function areJavaScriptContextStatesEqual(
  left: JavaScriptContextState,
  right: JavaScriptContextState
): boolean {
  if (left.uncertain || right.uncertain || left.frames.length !== right.frames.length) {
    return false;
  }

  return left.frames.every((frame, index) => {
    const other = right.frames[index];
    if (frame.kind !== other?.kind) return false;
    if (frame.kind === 'code' && other.kind === 'code') {
      return frame.templateExpressionDepth === other.templateExpressionDepth;
    }
    if (frame.kind === 'string' && other.kind === 'string') {
      return frame.quote === other.quote && frame.continued === other.continued;
    }
    return true;
  });
}

function areLongLineContextStatesEqual(
  left: LongLineContextState,
  right: LongLineContextState
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'javascript' && right.kind === 'javascript') {
    return areJavaScriptContextStatesEqual(left.state, right.state);
  }
  if (left.kind !== 'markup' || right.kind !== 'markup') return false;
  if (left.state.mode === 'style' || right.state.mode === 'style') return false;

  return (
    left.state.mode === right.state.mode &&
    left.state.tagName === right.state.tagName &&
    left.state.tagClosing === right.state.tagClosing &&
    left.state.tagQuote === right.state.tagQuote &&
    left.state.lastTagNonWhitespace === right.state.lastTagNonWhitespace &&
    (left.state.mode !== 'script' ||
      areJavaScriptContextStatesEqual(left.state.javascript, right.state.javascript))
  );
}

function findUnsafeLongLineContextIndex(
  sourceLines: string[],
  tokenizationLines: string[],
  longLineIndexes: Set<number>,
  language: string
): number | undefined {
  if (longLineIndexes.size === 0) return undefined;

  let state = createLongLineContextState(language);
  if (!state) return Math.min(...longLineIndexes);

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
    const sourceLine = sourceLines[lineIndex] ?? '';
    if (!longLineIndexes.has(lineIndex)) {
      scanLongLineContext(sourceLine, language, state);
      continue;
    }

    const actualState = cloneLongLineContextState(state);
    const surrogateState = cloneLongLineContextState(state);
    scanLongLineContext(sourceLine, language, actualState);
    scanLongLineContext(tokenizationLines[lineIndex] ?? '', language, surrogateState);
    if (!areLongLineContextStatesEqual(actualState, surrogateState)) return lineIndex;
    state = actualState;
  }

  return undefined;
}

function buildLongLineContextSurrogate(sourceLine: string): string {
  let prefixEnd = Math.min(LONG_LINE_CONTEXT_EDGE_CHARS, sourceLine.length);
  if (
    prefixEnd < sourceLine.length &&
    prefixEnd > 0 &&
    /[\uD800-\uDBFF]/.test(sourceLine[prefixEnd - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(sourceLine[prefixEnd] ?? '')
  ) {
    prefixEnd--;
  }

  let suffixStart = Math.max(0, sourceLine.length - LONG_LINE_CONTEXT_EDGE_CHARS);
  if (
    suffixStart > 0 &&
    suffixStart < sourceLine.length &&
    /[\uD800-\uDBFF]/.test(sourceLine[suffixStart - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(sourceLine[suffixStart] ?? '')
  ) {
    suffixStart++;
  }

  return `${sourceLine.slice(0, prefixEnd)} ${sourceLine.slice(suffixStart)}`;
}

/**
 * Tokenize one bounded surrogate document so grammar state can cross a skipped long line.
 * Keeping a small prefix and suffix preserves common delimiters such as quotes, semicolons,
 * and closing tags without sending the full pathological line to Prism. The original long
 * line still receives an empty token array and is rendered as plain text.
 */
function tokenizeCode(code: string, language: string): TokenizeCodeResult {
  const sourceLines = code.split('\n');
  const lines: Token[][] = Array.from({ length: sourceLines.length }, () => []);
  const fallbackReasons = createFallbackReasonCounts();
  const longLineIndexes = new Set<number>();
  let tokenCount = 0;
  let maxLineChars = 0;
  let maxTokensPerLine = 0;
  let highlightedLineCount = 0;

  const tokenizationLines = sourceLines.map((sourceLine, lineIndex) => {
    maxLineChars = Math.max(maxLineChars, sourceLine.length);
    if (sourceLine.length <= DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxLineChars) {
      return sourceLine;
    }

    longLineIndexes.add(lineIndex);
    fallbackReasons['line-too-long']++;
    return buildLongLineContextSurrogate(sourceLine);
  });
  const unsafeContextIndex = findUnsafeLongLineContextIndex(
    sourceLines,
    tokenizationLines,
    longLineIndexes,
    language
  );
  const tokenizationEnd = unsafeContextIndex ?? tokenizationLines.length - 1;
  const tokenizedLines = tokenizeCodeChunk(
    tokenizationLines.slice(0, tokenizationEnd + 1).join('\n'),
    language
  );

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
    if (longLineIndexes.has(lineIndex)) continue;
    if (unsafeContextIndex !== undefined && lineIndex > unsafeContextIndex) {
      fallbackReasons['context-state-unknown']++;
      continue;
    }

    const sourceLine = sourceLines[lineIndex] ?? '';
    const tokens = tokenizedLines[lineIndex] ?? [];
    const renderedContent = tokens.map((token) => token.content).join('');

    if (renderedContent !== sourceLine) continue;

    maxTokensPerLine = Math.max(maxTokensPerLine, tokens.length);
    if (tokens.length > DIFF_SYNTAX_HIGHLIGHT_LIMITS.maxTokensPerLine) {
      fallbackReasons['token-limit-exceeded']++;
      continue;
    }

    lines[lineIndex] = tokens;
    tokenCount += tokens.length;
    highlightedLineCount++;
  }

  return {
    lines,
    tokenCount,
    maxLineChars,
    maxTokensPerLine,
    highlightedLineCount,
    fallbackReasons,
  };
}

export function buildDiffSyntaxHighlight(
  originalContent: string,
  lines: FullFileDiffLine[],
  language: string
): DiffSyntaxHighlightData | null {
  if (!shouldHighlightDiff(originalContent, lines, language)) return null;

  try {
    const oldResult = tokenizeCode(originalContent, language);
    const newResult = tokenizeCode(buildNewContent(lines), language);
    const fallbackReasons = createFallbackReasonCounts();
    for (const reason of Object.keys(fallbackReasons) as DiffSyntaxHighlightFallbackReason[]) {
      fallbackReasons[reason] =
        oldResult.fallbackReasons[reason] + newResult.fallbackReasons[reason];
    }

    return {
      language,
      oldLines: oldResult.lines,
      newLines: newResult.lines,
      stats: {
        oldTokenCount: oldResult.tokenCount,
        newTokenCount: newResult.tokenCount,
        maxLineChars: Math.max(oldResult.maxLineChars, newResult.maxLineChars),
        maxTokensPerLine: Math.max(oldResult.maxTokensPerLine, newResult.maxTokensPerLine),
        highlightedLineCount: oldResult.highlightedLineCount + newResult.highlightedLineCount,
        fallbackLineCount: Object.values(fallbackReasons).reduce(
          (total, count) => total + count,
          0
        ),
        fallbackReasons,
      },
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
    let firstPaintFrame: number | null = null;
    let secondPaintFrame: number | null = null;
    let clearCommitStage: (() => void) | null = null;

    const clearCommitToPaint = () => {
      if (firstPaintFrame !== null) {
        window.cancelAnimationFrame(firstPaintFrame);
        firstPaintFrame = null;
      }
      if (secondPaintFrame !== null) {
        window.cancelAnimationFrame(secondPaintFrame);
        secondPaintFrame = null;
      }
      clearCommitStage?.();
      clearCommitStage = null;
    };

    const run = () => {
      const diagnosticDetails = {
        language,
        oldChars: originalContent.length,
        diffLines: lines.length,
        tokenizeMs: 0,
        oldTokens: 0,
        newTokens: 0,
        maxLineChars: 0,
        maxTokensPerLine: 0,
        fallbackLineCount: 0,
        fallbackReason: null as string | null,
      };
      const highlight = measureRendererWork('diff-highlight:tokenize', diagnosticDetails, () => {
        const startedAt = performance.now();
        const result = buildDiffSyntaxHighlight(originalContent, lines, language);
        diagnosticDetails.tokenizeMs = Math.round(performance.now() - startedAt);

        if (result) {
          diagnosticDetails.oldTokens = result.stats.oldTokenCount;
          diagnosticDetails.newTokens = result.stats.newTokenCount;
          diagnosticDetails.maxLineChars = result.stats.maxLineChars;
          diagnosticDetails.maxTokensPerLine = result.stats.maxTokensPerLine;
          diagnosticDetails.fallbackLineCount = result.stats.fallbackLineCount;
          const fallbackReason = (
            Object.entries(result.stats.fallbackReasons) as Array<
              [DiffSyntaxHighlightFallbackReason, number]
            >
          )
            .filter(([, count]) => count > 0)
            .map(([reason]) => reason)
            .join(',');
          diagnosticDetails.fallbackReason = fallbackReason || null;
        }

        return result;
      });
      if (cancelled || !highlight) return;

      clearCommitStage = setRendererHealthStage(
        'diff-highlight:commit-to-paint',
        diagnosticDetails
      );
      reportRendererHealthSnapshot();
      startTransition(() => {
        setScheduledData({
          ...highlight,
          originalContent,
          sourceLines: lines,
        });
      });
      firstPaintFrame = window.requestAnimationFrame(() => {
        firstPaintFrame = null;
        secondPaintFrame = window.requestAnimationFrame(() => {
          secondPaintFrame = null;
          clearCommitStage?.();
          clearCommitStage = null;
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
      clearCommitToPaint();
    };
  }, [language, lines, originalContent]);

  return isCurrent ? scheduledData : null;
}
