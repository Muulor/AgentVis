/**
 * Lightweight query preprocessing for RAG keyword retrieval.
 *
 * The output is intentionally BM25-only. Embedding search should keep using the
 * original query so semantic recall is not skewed by symbolic terms.
 */

export interface RagQueryPreprocessResult {
  originalQuery: string;
  bm25Query: string;
  fragments: string[];
  extractedTerms: string[];
  isFocusedQuery: boolean;
  isBroadOverviewQuery: boolean;
}

const MAX_FRAGMENTS = 4;
const MIN_FRAGMENT_LENGTH = 4;
const LOW_VALUE_SYMBOL_PARTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'md',
  'mdx',
  'json',
  'yaml',
  'yml',
  'py',
  'rs',
  'css',
  'scss',
  'html',
]);
const BRANDED_COMPOUND_TERMS = new Set(['agentvis']);
const FOCUSED_QUERY_PATTERN =
  /\u300a[^\u300b]{1,80}\u300b|translator(?:'s)? note|translator.{0,40}(?:reflection|review|afterword|postscript|note)|afterword|postscript|preface|foreword|book review|reading reflection|reader response|appendix|reading guide|chapter\s+\d+|section\s+\d+|\u8bd1\u8005|\u8bd1\u540e|\u540e\u8bb0|\u5e8f\u8a00|\u524d\u8a00|\u8bfb\u540e\u611f|\u4e66\u8bc4|\u8bc4\u8bba|\u611f\u60f3|\u8d4f\u6790|\u7ae0\u8282|\u9644\u5f55|\u5bfc\u8bfb|\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\d]+[\u7ae0\u8282\u7bc7\u56de]/i;
const BROAD_OVERVIEW_QUERY_PATTERN =
  /(\u6709\u4ec0\u4e48|\u90fd\u6709\u54ea\u4e9b|\u54ea\u4e9b|\u4ecb\u7ecd|\u6982\u8ff0|\u603b\u7ed3|\u8bf4\u8bf4).{0,20}(\u7279\u6027|\u7279\u70b9|\u529f\u80fd|\u80fd\u529b|\u4eae\u70b9)|(\u7279\u6027|\u7279\u70b9|\u529f\u80fd|\u80fd\u529b|\u4eae\u70b9).{0,20}(\u6709\u4ec0\u4e48|\u90fd\u6709\u54ea\u4e9b|\u54ea\u4e9b|\u4ecb\u7ecd|\u6982\u8ff0|\u603b\u7ed3)|what (features|capabilities)|what can .{0,40} do|(show|tell|introduce|summarize|describe).{0,40}(features|capabilities|overview|introduction)|(features|capabilities).{0,20}(of|for)/i;
const BROAD_OVERVIEW_ALIAS_TERMS = [
  '\u7279\u6027',
  '\u6838\u5fc3\u7279\u6027',
  '\u529f\u80fd',
  '\u529f\u80fd\u5b9a\u4f4d',
  '\u80fd\u529b',
  '\u4eae\u70b9',
  'feature',
  'features',
  'capability',
  'capabilities',
  'overview',
];

/**
 * Build the BM25 query and optional fragment queries from a user query.
 */
export function preprocessRagQuery(query: string): RagQueryPreprocessResult {
  const normalizedQuery = query.trim();
  const extractedTerms = extractQueryTerms(normalizedQuery);
  const isFocusedQuery = isFocusedRetrievalQuery(normalizedQuery);
  const isBroadOverviewQuery = isBroadOverviewRetrievalQuery(normalizedQuery);
  if (isBroadOverviewQuery) {
    addBroadOverviewAliasTerms(extractedTerms);
  }
  const bm25Query = appendTerms(normalizedQuery, extractedTerms);

  // fragment 保持原始文本，不做 appendTerms 增强。
  // 关键词提取已在主 bm25Query 上统一完成，fragment 的作用是
  // 从不同语义角度命中 BM25，重复追加提取词会导致双重计分。
  const fragments = splitQueryToFragments(normalizedQuery);

  return {
    originalQuery: query,
    bm25Query,
    fragments,
    extractedTerms,
    isFocusedQuery,
    isBroadOverviewQuery,
  };
}

/**
 * Build metadata-augmented text for BM25 indexing.
 *
 * This text is not embedded and is not returned to the LLM. It exists only so
 * filename/path/section queries can participate in keyword retrieval.
 */
export function buildBm25IndexText(input: {
  fileName?: string;
  filePath?: string;
  sectionPath?: string;
  heading?: string;
  content: string;
}): string {
  const metadataText = [input.fileName, input.filePath, input.sectionPath, input.heading]
    .filter((part): part is string => Boolean(part?.trim()))
    .flatMap((part) => expandMetadataTerm(part));

  return [...metadataText, input.content].join('\n');
}

/**
 * Build compact metadata-augmented text for embedding indexing.
 *
 * The stored chunk content remains raw. This text is only sent to the embedding
 * model so document titles and section headings can participate in semantic
 * recall. Full paths are intentionally ignored to avoid path noise.
 */
export function buildEmbeddingIndexText(input: {
  fileName?: string;
  filePath?: string;
  sectionPath?: string;
  heading?: string;
  content: string;
}): string {
  const metadataText = [
    buildEmbeddingMetadataLine('Document', input.fileName, true),
    buildEmbeddingMetadataLine('Section', input.sectionPath, false),
    buildEmbeddingMetadataLine('Heading', input.heading, false),
  ].filter((part): part is string => Boolean(part));

  if (metadataText.length === 0) {
    return input.content;
  }

  return [...metadataText, '', input.content].join('\n');
}

function appendTerms(query: string, terms: string[]): string {
  const queryLower = query.toLowerCase();
  const appendedTerms = terms.filter((term) => {
    const lowerTerm = term.toLowerCase();
    return !(BRANDED_COMPOUND_TERMS.has(lowerTerm) && queryLower.includes(lowerTerm));
  });
  if (appendedTerms.length === 0) return query;
  return `${query} ${appendedTerms.join(' ')}`;
}

function splitQueryToFragments(query: string): string[] {
  const fragments = query
    .split(/\r?\n|[；;。!?！？]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH)
    .slice(0, MAX_FRAGMENTS);

  if (fragments.length <= 1) {
    return [];
  }

  return fragments;
}

function extractQueryTerms(query: string): string[] {
  const extracted = new Set<string>();

  // Filenames / path-like terms, including Chinese filenames.
  const filePattern = /[\p{L}\p{N}_./\\-]+\.[A-Za-z0-9]{1,8}/gu;
  for (const match of query.matchAll(filePattern)) {
    addExpandedTerm(extracted, match[0]);
  }

  // Code symbols: PascalCase, camelCase, snake_case, and mixed alnum tokens.
  const symbolPattern = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
  for (const match of query.matchAll(symbolPattern)) {
    addExpandedTerm(extracted, match[0]);
  }

  // Quoted short phrases are often deliberate search targets.
  const quotedPattern = /["'“”‘’`]([^"'“”‘’`]{2,60})["'“”‘’`]/g;
  for (const match of query.matchAll(quotedPattern)) {
    const phrase = match[1]?.trim();
    if (phrase) {
      addExpandedTerm(extracted, phrase);
    }
  }

  addReadingAliasTerms(extracted, query);

  return Array.from(extracted);
}

function isFocusedRetrievalQuery(query: string): boolean {
  return FOCUSED_QUERY_PATTERN.test(query);
}

function isBroadOverviewRetrievalQuery(query: string): boolean {
  return BROAD_OVERVIEW_QUERY_PATTERN.test(query);
}

function addBroadOverviewAliasTerms(target: string[]): void {
  for (const term of BROAD_OVERVIEW_ALIAS_TERMS) {
    if (!target.includes(term)) {
      target.push(term);
    }
  }
}

function addReadingAliasTerms(target: Set<string>, query: string): void {
  const hasChineseTranslatorTerm = query.includes('\u8bd1\u8005');
  const hasChineseAfterwordTerm = query.includes('\u540e\u8bb0');

  if (
    (hasChineseTranslatorTerm &&
      /(\u8bfb\u540e\u611f|\u8bfb\u540e|\u611f\u60f3|\u4e66\u8bc4|\u8bc4\u8bba|\u8d4f\u6790|\u540e\u8bb0)/.test(
        query
      )) ||
    (/translator/i.test(query) &&
      /(review|reflection|commentary|afterword|postscript|note)/i.test(query))
  ) {
    target.add('\u8bd1\u8005\u540e\u8bb0');
    target.add('\u8bd1\u540e\u8bb0');
    target.add('\u540e\u8bb0');
    target.add('translator note');
    target.add("translator's note");
    target.add('translator afterword');
    target.add('afterword');
  }

  if (hasChineseAfterwordTerm || /(afterword|postscript)/i.test(query)) {
    target.add('\u8bd1\u8005\u540e\u8bb0');
    target.add('\u8bd1\u540e\u8bb0');
    target.add('afterword');
    target.add('postscript');
  }

  if (/\u5e8f\u8a00|\u524d\u8a00/.test(query) || /(preface|foreword)/i.test(query)) {
    target.add('\u5e8f\u8a00');
    target.add('\u524d\u8a00');
    target.add('preface');
    target.add('foreword');
  }
}

function expandMetadataTerm(term: string): string[] {
  const expanded = new Set<string>();
  addExpandedTerm(expanded, term);
  return Array.from(expanded);
}

function buildEmbeddingMetadataLine(
  label: string,
  value: string | undefined,
  includeExpandedTerms: boolean
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const expandedTerms = includeExpandedTerms
    ? expandMetadataTerm(trimmed).filter((term) => term !== trimmed)
    : [];
  const aliasTerms = getEmbeddingMetadataAliases(trimmed);
  const supplementalTerms = [...new Set([...expandedTerms, ...aliasTerms])];

  if (supplementalTerms.length === 0) {
    return `${label}: ${trimmed}`;
  }

  return `${label}: ${trimmed} ${supplementalTerms.join(' ')}`;
}

function getEmbeddingMetadataAliases(value: string): string[] {
  const aliases = new Set<string>();

  if (/features?|capabilit(?:y|ies)/i.test(value)) {
    aliases.add('\u7279\u6027');
    aliases.add('\u6838\u5fc3\u7279\u6027');
    aliases.add('\u529f\u80fd');
    aliases.add('\u80fd\u529b');
    aliases.add('features');
    aliases.add('capabilities');
  }

  if (/overview|introduction|intro/i.test(value)) {
    aliases.add('\u6982\u8ff0');
    aliases.add('\u4ecb\u7ecd');
    aliases.add('overview');
    aliases.add('introduction');
  }

  return Array.from(aliases);
}

function addExpandedTerm(target: Set<string>, rawTerm: string): void {
  const cleaned = rawTerm.trim();
  if (cleaned.length < 2) return;

  target.add(cleaned);

  const withoutExtension = cleaned.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  if (withoutExtension !== cleaned && withoutExtension.length >= 2) {
    target.add(withoutExtension);
  }

  if (!BRANDED_COMPOUND_TERMS.has(cleaned.toLowerCase())) {
    for (const part of splitSymbolLikeTerm(cleaned)) {
      if (part.length >= 2) {
        target.add(part);
      }
    }
  }
}

function splitSymbolLikeTerm(term: string): string[] {
  const normalized = term
    .replace(/[./\\-]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

  return normalized
    .split(/_+/)
    .filter((part) => part.length >= 2 && !LOW_VALUE_SYMBOL_PARTS.has(part));
}
