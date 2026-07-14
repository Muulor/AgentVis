/**
 * Import-map and module-source analysis for project preview routing.
 *
 * The helpers in this module are dependency-free and side-effect-free so they
 * can be used before any untrusted preview project is materialized or started.
 */

import { normalizeProjectRelativePath } from './projectPathPolicy';
import type { ProjectFile } from './types';

export interface HtmlImportMapAnalysis {
  hasImportMap: boolean;
  validImportMapCount: number;
  invalidImportMapCount: number;
  imports: Readonly<Record<string, string>>;
  scopes: ImportMapScopes;
  moduleEntries: readonly string[];
  inlineModuleSources: readonly string[];
  baseHref: string | null;
}

export type ImportMapScopes = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface ParsedImportMap {
  imports: Readonly<Record<string, string>>;
  scopes: ImportMapScopes;
}

interface ScriptElement {
  attributes: Readonly<Record<string, string>>;
  content: string;
}

interface SourceToken {
  kind: 'identifier' | 'string' | 'punctuation';
  value: string;
}

const INERT_SCRIPT_CONTAINERS = [
  'iframe',
  'noembed',
  'noscript',
  'style',
  'template',
  'textarea',
  'title',
  'xmp',
] as const;
const INERT_BASE_CONTAINERS = [...INERT_SCRIPT_CONTAINERS, 'script'] as const;

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const DRIVE_QUALIFIED_PATH = /^[a-z]:/i;
const NODE_BUILTIN_PACKAGE_ROOTS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z\d_$]/;
const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnStringProperty(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function parseStringMappings(value: unknown): Readonly<Record<string, string>> | null {
  if (value !== undefined && !isRecord(value)) return null;

  const mappings: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [specifier, address] of Object.entries(value)) {
      if (typeof address === 'string') setOwnStringProperty(mappings, specifier, address);
    }
  }
  return Object.freeze(mappings);
}

function parseImportMap(jsonSource: string): ParsedImportMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSource) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const imports = parseStringMappings(parsed['imports']);
  if (imports === null) return null;

  const scopesValue = parsed['scopes'];
  if (scopesValue !== undefined && !isRecord(scopesValue)) return null;
  const scopes: Record<string, Readonly<Record<string, string>>> = {};
  if (isRecord(scopesValue)) {
    for (const [scopePrefix, mappingsValue] of Object.entries(scopesValue)) {
      const mappings = parseStringMappings(mappingsValue);
      if (mappings === null) return null;
      Object.defineProperty(scopes, scopePrefix, {
        configurable: true,
        enumerable: true,
        value: mappings,
        writable: true,
      });
    }
  }

  return { imports, scopes: Object.freeze(scopes) };
}

/** Parse the top-level `imports` object from an import-map JSON script. */
export function parseImportMapImports(jsonSource: string): Readonly<Record<string, string>> | null {
  return parseImportMap(jsonSource)?.imports ?? null;
}

/** Analyze active script elements in an HTML document. */
export function analyzeHtmlImports(html: string): HtmlImportMapAnalysis {
  const imports: Record<string, string> = {};
  const scopes: Record<string, Record<string, string>> = {};
  const moduleEntries = new Set<string>();
  const inlineModuleSources: string[] = [];
  let hasImportMap = false;
  let validImportMapCount = 0;
  let invalidImportMapCount = 0;

  for (const script of scanScriptElements(html)) {
    const type = (script.attributes['type'] ?? '').trim().toLowerCase();
    if (type === 'importmap') {
      hasImportMap = true;
      const parsedImportMap = parseImportMap(script.content);
      if (parsedImportMap === null) {
        invalidImportMapCount += 1;
      } else {
        validImportMapCount += 1;
        for (const [specifier, address] of Object.entries(parsedImportMap.imports)) {
          setOwnStringProperty(imports, specifier, address);
        }
        for (const [scopePrefix, mappings] of Object.entries(parsedImportMap.scopes)) {
          const mergedMappings = Object.prototype.hasOwnProperty.call(scopes, scopePrefix)
            ? (scopes[scopePrefix] ?? {})
            : {};
          for (const [specifier, address] of Object.entries(mappings)) {
            setOwnStringProperty(mergedMappings, specifier, address);
          }
          Object.defineProperty(scopes, scopePrefix, {
            configurable: true,
            enumerable: true,
            value: mergedMappings,
            writable: true,
          });
        }
      }
      continue;
    }

    const source = script.attributes['src'];
    if (type === 'module') {
      if (source !== undefined && isLocalModuleEntry(source)) {
        moduleEntries.add(source.trim());
      } else if (source === undefined && script.content.trim()) {
        inlineModuleSources.push(script.content);
      }
    }
  }

  return {
    hasImportMap,
    validImportMapCount,
    invalidImportMapCount,
    imports: Object.freeze(imports),
    scopes: Object.freeze(
      Object.fromEntries(
        Object.entries(scopes).map(([scopePrefix, mappings]) => [
          scopePrefix,
          Object.freeze(mappings),
        ])
      )
    ),
    moduleEntries: Object.freeze([...moduleEntries]),
    inlineModuleSources: Object.freeze(inlineModuleSources),
    baseHref: findFirstActiveBaseHref(html),
  };
}

/**
 * Select the dependency-free static route for a root import-map application.
 * A root package manifest always wins because that project has an explicit
 * package-manager contract.
 */
export function shouldUseStaticImportMapPreview(files: readonly ProjectFile[]): boolean {
  let rootHtml: string | null = null;
  const namedRootHtml: string[] = [];
  let hasRootPackageManifest = false;

  for (const file of files) {
    const normalizedPath = normalizeProjectRelativePath(file.path).toLowerCase();
    if (normalizedPath === 'package.json') hasRootPackageManifest = true;
    if (normalizedPath === 'index.html') rootHtml = file.content;
    if (!normalizedPath.includes('/') && normalizedPath.endsWith('.html')) {
      namedRootHtml.push(file.content);
    }
  }

  if (rootHtml === null && namedRootHtml.length === 1) rootHtml = namedRootHtml[0] ?? null;

  if (hasRootPackageManifest || rootHtml === null) return false;

  const analysis = analyzeHtmlImports(rootHtml);
  return analysis.validImportMapCount > 0 && analysis.invalidImportMapCount === 0;
}

/** Return the npm package root represented by a bare module specifier. */
export function getBarePackageRoot(specifier: string): string | null {
  if (
    specifier.length === 0 ||
    specifier.trim() !== specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    specifier.startsWith('#') ||
    DRIVE_QUALIFIED_PATH.test(specifier) ||
    URL_SCHEME.test(specifier)
  ) {
    return null;
  }

  const segments = specifier.split('/');
  const firstSegment = segments[0];
  if (!firstSegment) return null;

  if (firstSegment.startsWith('@')) {
    const packageName = segments[1];
    if (firstSegment.length === 1 || !packageName) return null;
    return `${firstSegment}/${packageName}`;
  }

  if (NODE_BUILTIN_PACKAGE_ROOTS.has(firstSegment)) return null;
  return firstSegment;
}

/** Collect module specifiers from imports, re-exports, and literal dynamic imports. */
export function collectModuleSpecifiers(source: string): string[] {
  const tokens = tokenizeSource(source);
  const specifiers = new Set<string>();

  const addSpecifier = (specifier: string): void => {
    specifiers.add(specifier);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'identifier') continue;

    const next = tokens[index + 1];
    if (token.value === 'import' && tokens[index - 1]?.value !== '.') {
      if (next?.value === '.') continue;
      const dynamicSpecifier = tokens[index + 2];
      if (next?.value === '(' && dynamicSpecifier?.kind === 'string') {
        addSpecifier(dynamicSpecifier.value);
        continue;
      }
      if (next?.kind === 'string') {
        addSpecifier(next.value);
        continue;
      }
    }
    if (token.value === 'from' && next?.kind === 'string') addSpecifier(next.value);
  }

  return [...specifiers];
}

/**
 * Collect bare specifiers from static imports, re-exports, and literal dynamic
 * imports. Relative paths, absolute paths, URL schemes, and Node built-ins
 * (with or without the `node:` prefix) are intentionally ignored.
 */
export function collectBareImportSpecifiers(source: string): string[] {
  return collectModuleSpecifiers(source).filter(
    (specifier) => getBarePackageRoot(specifier) !== null
  );
}

/** Collapse collected bare specifiers to their registry package roots. */
export function collectBareImportPackageRoots(source: string): string[] {
  const roots = new Set<string>();
  for (const specifier of collectBareImportSpecifiers(source)) {
    const root = getBarePackageRoot(specifier);
    if (root !== null) roots.add(root);
  }
  return [...roots];
}

/** Match the exact and trailing-slash prefix forms defined by import maps. */
export function isImportMapSpecifierMapped(
  specifier: string,
  imports: Readonly<Record<string, string>>
): boolean {
  return resolveImportMapSpecifier(specifier, imports) !== null;
}

/** Resolve an exact or longest trailing-slash prefix mapping to its address. */
export function resolveImportMapSpecifier(
  specifier: string,
  imports: Readonly<Record<string, string>>
): string | null {
  if (Object.prototype.hasOwnProperty.call(imports, specifier)) return imports[specifier] ?? null;

  let bestKey: string | null = null;
  let bestAddress: string | null = null;
  for (const [key, address] of Object.entries(imports)) {
    if (
      key.endsWith('/') &&
      address.endsWith('/') &&
      specifier.startsWith(key) &&
      (bestKey === null || key.length > bestKey.length)
    ) {
      bestKey = key;
      bestAddress = address;
    }
  }
  return bestKey === null || bestAddress === null
    ? null
    : `${bestAddress}${specifier.slice(bestKey.length)}`;
}

/** Normalize URL-like import-map keys and all addresses against the document base URL. */
export function normalizeImportMapImports(
  imports: Readonly<Record<string, string>>,
  baseUrl: string
): Readonly<Record<string, string>> | null {
  let normalizedBase: string;
  try {
    normalizedBase = new URL(baseUrl).href;
  } catch {
    return null;
  }

  const normalized: Record<string, string> = {};
  for (const [key, address] of Object.entries(imports)) {
    if (!key) return null;
    try {
      const normalizedKey = isUrlLikeModuleSpecifier(key) ? new URL(key, normalizedBase).href : key;
      const normalizedAddress = new URL(address, normalizedBase).href;
      if (normalizedKey.endsWith('/') && !normalizedAddress.endsWith('/')) return null;
      setOwnStringProperty(normalized, normalizedKey, normalizedAddress);
    } catch {
      return null;
    }
  }
  return Object.freeze(normalized);
}

/** Normalize scope prefixes and their mappings against the import-map document URL. */
export function normalizeImportMapScopes(
  scopes: ImportMapScopes,
  baseUrl: string
): ImportMapScopes | null {
  let normalizedBase: string;
  try {
    normalizedBase = new URL(baseUrl).href;
  } catch {
    return null;
  }

  const normalizedScopes: Record<string, Readonly<Record<string, string>>> = {};
  for (const [scopePrefix, mappings] of Object.entries(scopes)) {
    try {
      const normalizedPrefix = new URL(scopePrefix, normalizedBase).href;
      const normalizedMappings = normalizeImportMapImports(mappings, normalizedBase);
      if (normalizedMappings === null) return null;
      Object.defineProperty(normalizedScopes, normalizedPrefix, {
        configurable: true,
        enumerable: true,
        value: normalizedMappings,
        writable: true,
      });
    } catch {
      return null;
    }
  }
  return Object.freeze(normalizedScopes);
}

/** Resolve a specifier exactly as the browser sees it from one module referrer. */
export function resolveImportMapSpecifierForReferrer(
  specifier: string,
  normalizedImports: Readonly<Record<string, string>>,
  referrerUrl: string,
  normalizedScopes: ImportMapScopes = {}
): string | null {
  try {
    const normalizedSpecifier = isUrlLikeModuleSpecifier(specifier)
      ? new URL(specifier, referrerUrl).href
      : specifier;
    const matchingScopes = Object.entries(normalizedScopes)
      .filter(([scopePrefix]) => referrerUrl.startsWith(scopePrefix))
      .sort(([left], [right]) => right.length - left.length);
    for (const [, mappings] of matchingScopes) {
      const scopedResolution = resolveImportMapSpecifier(normalizedSpecifier, mappings);
      if (scopedResolution !== null) return scopedResolution;
    }
    return resolveImportMapSpecifier(normalizedSpecifier, normalizedImports);
  } catch {
    return null;
  }
}

function isUrlLikeModuleSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    URL_SCHEME.test(specifier)
  );
}

function isLocalModuleEntry(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('\\') &&
    !trimmed.startsWith('#') &&
    !DRIVE_QUALIFIED_PATH.test(trimmed) &&
    !URL_SCHEME.test(trimmed)
  );
}

function scanScriptElements(html: string): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) break;

    if (lowerHtml.startsWith('<!--', tagStart)) {
      const commentEnd = lowerHtml.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const inertContainer = INERT_SCRIPT_CONTAINERS.find(
      (tagName) =>
        lowerHtml.startsWith(`<${tagName}`, tagStart) &&
        isTagNameBoundary(html[tagStart + tagName.length + 1])
    );
    if (inertContainer) {
      const openingEnd = findTagEnd(html, tagStart + inertContainer.length + 1);
      if (openingEnd < 0) break;
      const closingStart = findClosingTag(lowerHtml, openingEnd + 1, inertContainer);
      if (closingStart < 0) break;
      const closingEnd = findTagEnd(html, closingStart + inertContainer.length + 2);
      cursor = closingEnd < 0 ? html.length : closingEnd + 1;
      continue;
    }

    if (!lowerHtml.startsWith('<script', tagStart) || !isTagNameBoundary(html[tagStart + 7])) {
      cursor = tagStart + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 7);
    if (tagEnd < 0) break;

    const rawAttributes = html.slice(tagStart + 7, tagEnd);
    const attributes = parseHtmlAttributes(rawAttributes);

    const closingStart = findClosingScriptTag(lowerHtml, tagEnd + 1);
    if (closingStart < 0) {
      scripts.push({ attributes, content: html.slice(tagEnd + 1) });
      break;
    }

    scripts.push({ attributes, content: html.slice(tagEnd + 1, closingStart) });
    const closingEnd = findTagEnd(html, closingStart + 8);
    cursor = closingEnd < 0 ? html.length : closingEnd + 1;
  }

  return scripts;
}

function findFirstActiveBaseHref(html: string): string | null {
  const lowerHtml = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) return null;
    if (lowerHtml.startsWith('<!--', tagStart)) {
      const commentEnd = lowerHtml.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const inertContainer = INERT_BASE_CONTAINERS.find(
      (tagName) =>
        lowerHtml.startsWith(`<${tagName}`, tagStart) &&
        isTagNameBoundary(html[tagStart + tagName.length + 1])
    );
    if (inertContainer) {
      const openingEnd = findTagEnd(html, tagStart + inertContainer.length + 1);
      if (openingEnd < 0) return null;
      const closingStart = findClosingTag(lowerHtml, openingEnd + 1, inertContainer);
      if (closingStart < 0) return null;
      const closingEnd = findTagEnd(html, closingStart + inertContainer.length + 2);
      cursor = closingEnd < 0 ? html.length : closingEnd + 1;
      continue;
    }

    if (lowerHtml.startsWith('<base', tagStart) && isTagNameBoundary(html[tagStart + 5])) {
      const tagEnd = findTagEnd(html, tagStart + 5);
      if (tagEnd < 0) return null;
      const attributes = parseHtmlAttributes(html.slice(tagStart + 5, tagEnd));
      return attributes['href'] ?? null;
    }
    cursor = tagStart + 1;
  }

  return null;
}

function findClosingScriptTag(lowerHtml: string, start: number): number {
  return findClosingTag(lowerHtml, start, 'script');
}

function findClosingTag(lowerHtml: string, start: number, tagName: string): number {
  let cursor = start;
  while (cursor < lowerHtml.length) {
    const candidate = lowerHtml.indexOf(`</${tagName}`, cursor);
    if (candidate < 0) return -1;
    const boundaryIndex = candidate + tagName.length + 2;
    if (isTagNameBoundary(lowerHtml[boundaryIndex])) return candidate;
    cursor = boundaryIndex;
  }
  return -1;
}

function isTagNameBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s/>]/.test(character);
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseHtmlAttributes(source: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (cursor >= source.length || source[cursor] === '/') break;

    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor] ?? '')) cursor += 1;
    const name = source.slice(nameStart, cursor).toLowerCase();
    if (name.length === 0) {
      cursor += 1;
      continue;
    }

    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    let value = '';
    if (source[cursor] === '=') {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        value = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < source.length && !/[\s>]/.test(source[cursor] ?? '')) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }

    if (!Object.prototype.hasOwnProperty.call(attributes, name)) {
      setOwnStringProperty(attributes, name, decodeHtmlEntities(value));
    }
  }

  return Object.freeze(attributes);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi,
    (match, decimal: string | undefined, hexadecimal: string | undefined, named: string) => {
      if (decimal !== undefined) return safeCodePoint(Number.parseInt(decimal, 10), match);
      if (hexadecimal !== undefined) return safeCodePoint(Number.parseInt(hexadecimal, 16), match);
      const namedEntities: Record<string, string> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"',
      };
      return namedEntities[named.toLowerCase()] ?? match;
    }
  );
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

function tokenizeSource(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  let canStartRegex = true;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === undefined) break;

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor + 2);
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor + 2);
      continue;
    }
    if (character === '/' && canStartRegex) {
      cursor = skipRegexLiteral(source, cursor + 1);
      canStartRegex = false;
      continue;
    }
    if (character === '"' || character === "'") {
      const literal = readStringLiteral(source, cursor, character);
      tokens.push({ kind: 'string', value: literal.value });
      cursor = literal.end;
      canStartRegex = false;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplateLiteral(source, cursor + 1);
      canStartRegex = false;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      const start = cursor;
      cursor += 1;
      while (IDENTIFIER_PART.test(source[cursor] ?? '')) cursor += 1;
      const value = source.slice(start, cursor);
      tokens.push({ kind: 'identifier', value });
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(value);
      continue;
    }

    tokens.push({ kind: 'punctuation', value: character });
    cursor += 1;
    canStartRegex = ![')', ']', '}', '.', '+'].includes(character);
  }

  return tokens;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf('*/', start);
  return end < 0 ? source.length : end + 2;
}

function skipRegexLiteral(source: string, start: number): number {
  let inCharacterClass = false;
  let escaped = false;

  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    if (character === ']') inCharacterClass = false;
    if (character === '/' && !inCharacterClass) {
      cursor += 1;
      while (/[A-Za-z]/.test(source[cursor] ?? '')) cursor += 1;
      return cursor;
    }
    if (character === '\n' || character === '\r') return cursor;
  }

  return source.length;
}

function skipTemplateLiteral(source: string, start: number): number {
  let escaped = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '`') {
      return cursor + 1;
    }
  }
  return source.length;
}

function readStringLiteral(
  source: string,
  start: number,
  quote: '"' | "'"
): { value: string; end: number } {
  let value = '';
  let cursor = start + 1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === quote) return { value, end: cursor + 1 };
    if (character !== '\\') {
      value += character ?? '';
      cursor += 1;
      continue;
    }

    const escaped = source[cursor + 1];
    if (escaped === undefined) return { value, end: source.length };
    if (escaped === '\n') {
      cursor += 2;
      continue;
    }
    if (escaped === '\r') {
      cursor += source[cursor + 2] === '\n' ? 3 : 2;
      continue;
    }

    const simpleEscapes: Record<string, string> = {
      '0': '\0',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
    };
    const simpleEscape = simpleEscapes[escaped];
    if (simpleEscape !== undefined) {
      value += simpleEscape;
      cursor += 2;
      continue;
    }

    if (escaped === 'x') {
      const hexadecimal = source.slice(cursor + 2, cursor + 4);
      if (/^[\da-f]{2}$/i.test(hexadecimal)) {
        value += String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        cursor += 4;
        continue;
      }
    }
    if (escaped === 'u') {
      const hexadecimal = source.slice(cursor + 2, cursor + 6);
      if (/^[\da-f]{4}$/i.test(hexadecimal)) {
        value += String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        cursor += 6;
        continue;
      }
    }

    value += escaped;
    cursor += 2;
  }

  return { value, end: source.length };
}
