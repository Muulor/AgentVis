/**
 * MemorySummaryRetriever - 记忆摘要混合召回器
 *
 * 面向摘要层的轻量检索策略：以 embedding 语义召回为主，使用 BM25 + RRF
 * 对文件名、代码符号、明确术语等强锚点进行排序纠偏和补召回。
 */

import { BM25Index } from '../rag/BM25Index';
import { getMemoryVectorIndex, type MemorySearchResult } from './MemoryVectorIndex';
import type { OpenQuestion } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('MemorySummaryRetriever');

const DEFAULT_RRF_K = 60;
const DEFAULT_EMBEDDING_WEIGHT = 1.0;
const DEFAULT_BM25_WEIGHT = 0.35;
const DEFAULT_BM25_STRONG_ANCHOR_WEIGHT = 0.55;
const SUMMARY_AGENT_SCOPE = '__memory_summary__';

const LOW_VALUE_TERMS = new Set([
  'previous',
  'last',
  'recent',
  'continue',
  'summary',
  'memory',
  'question',
  'problem',
  'issue',
  'plan',
  'solution',
  'approach',
  'mechanism',
  'feature',
  'thing',
  'that',
  'this',
  '之前',
  '上次',
  '刚才',
  '继续',
  '方案',
  '问题',
  '机制',
  '记忆',
  '摘要',
  '这个',
  '那个',
  '之前那个',
]);

const QUOTED_PHRASE_PATTERN = /["'`“”‘’]([^"'`“”‘’]{2,80})["'`“”‘’]/g;
const FILE_LIKE_PATTERN = /(?:[A-Za-z]:[\\/])?(?:[\w@.-]+[\\/])*[\w@.-]+\.[A-Za-z0-9]{1,12}/g;
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\b/g;
const CHINESE_RUN_PATTERN = /[\u4e00-\u9fff]{2,12}/g;

type AnchorKind = 'phrase' | 'file' | 'extension' | 'identifier' | 'chinese';

interface StrongAnchor {
  value: string;
  kind: AnchorKind;
}

interface FusedSummary<TSummary extends MemorySummaryItem> {
  summary: TSummary;
  rrfScore: number;
  embeddingScore?: number;
  bm25Score?: number;
  bm25Rank?: number;
}

export interface MemorySummaryRetrieverOptions {
  /** 返回数量 */
  topK: number;
  /** embedding 相似度阈值 */
  threshold: number;
  /** RRF k 参数 */
  rrfK?: number;
  /** embedding RRF 权重 */
  embeddingWeight?: number;
  /** BM25 默认 RRF 权重 */
  bm25Weight?: number;
  /** query 含强锚点时 BM25 RRF 权重 */
  bm25StrongAnchorWeight?: number;
}

export interface MemorySummaryRetrieveResult<TSummary extends MemorySummaryItem> {
  summaries: TSummary[];
  isDegraded: boolean;
}

export interface MemorySummaryItem {
  id: string;
  content: string;
  createdAt: number;
  keyPoints?: string[];
  topics?: string[];
  mentionedFiles?: string[];
  confirmedDecisions?: string[];
  openQuestions?: OpenQuestion[];
  invalidatedPoints?: string[];
}

export class MemorySummaryRetriever {
  async retrieve<TSummary extends MemorySummaryItem>(
    agentId: string,
    userQuery: string,
    allSummaries: TSummary[],
    options: MemorySummaryRetrieverOptions
  ): Promise<MemorySummaryRetrieveResult<TSummary>> {
    const topK = Math.max(1, options.topK);
    const candidateTopK = Math.max(topK * 3, 8);
    const anchors = extractStrongAnchors(userQuery);
    const bm25Results = this.searchBm25(allSummaries, userQuery, candidateTopK);
    let embeddingResults: MemorySearchResult[] = [];

    try {
      embeddingResults = await getMemoryVectorIndex().searchRelevant(agentId, userQuery, {
        memoryType: 'summary',
        topK: candidateTopK,
        threshold: options.threshold,
      });
    } catch {
      logger.warn('[MemorySummaryRetriever] embedding 摘要召回失败，尝试 BM25 强锚点兜底');
    }

    const fused = this.fuseResults(allSummaries, embeddingResults, bm25Results, anchors, options);
    const selected = fused
      .filter((item) => this.shouldKeep(item, anchors))
      .slice(0, topK)
      .map((item) => item.summary);

    if (selected.length > 0) {
      logger.trace('[MemorySummaryRetriever] 摘要混合召回成功:', {
        total: allSummaries.length,
        selected: selected.length,
        embeddingResults: embeddingResults.length,
        bm25Results: bm25Results.length,
        anchors: anchors.map((anchor) => anchor.value),
      });
      return { summaries: selected, isDegraded: false };
    }

    logger.trace('[MemorySummaryRetriever] 摘要混合召回无可用结果，降级为最近摘要');
    return {
      summaries: getRecentSummaries(allSummaries, topK),
      isDegraded: true,
    };
  }

  private searchBm25(
    summaries: MemorySummaryItem[],
    query: string,
    topK: number
  ): Array<{ summaryId: string; score: number; rank: number }> {
    const bm25 = new BM25Index();

    for (const summary of summaries) {
      bm25.addDocument(SUMMARY_AGENT_SCOPE, summary.id, buildSummaryIndexText(summary));
    }

    return bm25.search(SUMMARY_AGENT_SCOPE, query, topK).map((result, index) => ({
      summaryId: result.docId,
      score: result.score,
      rank: index + 1,
    }));
  }

  private fuseResults<TSummary extends MemorySummaryItem>(
    allSummaries: TSummary[],
    embeddingResults: MemorySearchResult[],
    bm25Results: Array<{ summaryId: string; score: number; rank: number }>,
    anchors: StrongAnchor[],
    options: MemorySummaryRetrieverOptions
  ): Array<FusedSummary<TSummary>> {
    const summariesById = new Map(allSummaries.map((summary) => [summary.id, summary]));
    const fusedById = new Map<string, FusedSummary<TSummary>>();
    const rrfK = options.rrfK ?? DEFAULT_RRF_K;
    const embeddingWeight = options.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT;
    const bm25Weight =
      anchors.length > 0
        ? (options.bm25StrongAnchorWeight ?? DEFAULT_BM25_STRONG_ANCHOR_WEIGHT)
        : (options.bm25Weight ?? DEFAULT_BM25_WEIGHT);

    embeddingResults.forEach((result, index) => {
      const summary = summariesById.get(result.memoryId);
      if (!summary) return;

      const rank = index + 1;
      const contribution = embeddingWeight / (rrfK + rank);
      const existing = fusedById.get(summary.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.embeddingScore = result.score;
      } else {
        fusedById.set(summary.id, {
          summary,
          rrfScore: contribution,
          embeddingScore: result.score,
        });
      }
    });

    for (const result of bm25Results) {
      const summary = summariesById.get(result.summaryId);
      if (!summary) continue;

      const contribution = bm25Weight / (rrfK + result.rank);
      const existing = fusedById.get(summary.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.bm25Score = result.score;
        existing.bm25Rank = result.rank;
      } else {
        fusedById.set(summary.id, {
          summary,
          rrfScore: contribution,
          bm25Score: result.score,
          bm25Rank: result.rank,
        });
      }
    }

    return [...fusedById.values()].sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) {
        return b.rrfScore - a.rrfScore;
      }
      return b.summary.createdAt - a.summary.createdAt;
    });
  }

  private shouldKeep<TSummary extends MemorySummaryItem>(
    item: FusedSummary<TSummary>,
    anchors: StrongAnchor[]
  ): boolean {
    if (item.embeddingScore !== undefined) {
      return true;
    }

    if (item.bm25Score === undefined || anchors.length === 0) {
      return false;
    }

    return hasStrongAnchorMatch(item.summary, anchors);
  }
}

export const memorySummaryRetriever = new MemorySummaryRetriever();

export function buildSummaryIndexText(summary: MemorySummaryItem): string {
  const parts: string[] = [summary.content];

  pushLabeledList(parts, 'Topics', summary.topics);
  pushLabeledList(parts, 'Files', summary.mentionedFiles);
  pushList(parts, summary.keyPoints);
  pushList(parts, summary.confirmedDecisions);
  pushOpenQuestions(parts, summary.openQuestions);
  pushList(parts, summary.invalidatedPoints);

  return parts.join(' ');
}

function pushLabeledList(parts: string[], label: string, values?: string[]): void {
  if (values && values.length > 0) {
    parts.push(`${label}: ${values.join(' ')}`);
  }
}

function pushList(parts: string[], values?: string[]): void {
  if (values && values.length > 0) {
    parts.push(values.join(' '));
  }
}

function pushOpenQuestions(parts: string[], questions?: OpenQuestion[]): void {
  if (!questions || questions.length === 0) {
    return;
  }

  const questionTexts = questions.map((question) => {
    const keywords = question.keywords?.join(' ') ?? '';
    return `${question.question} ${question.scope} ${keywords}`.trim();
  });

  pushList(parts, questionTexts);
}

function getRecentSummaries<TSummary extends MemorySummaryItem>(
  summaries: TSummary[],
  topK: number
): TSummary[] {
  return [...summaries].sort((a, b) => b.createdAt - a.createdAt).slice(0, topK);
}

function extractStrongAnchors(query: string): StrongAnchor[] {
  const anchors: StrongAnchor[] = [];

  for (const match of query.matchAll(QUOTED_PHRASE_PATTERN)) {
    addAnchor(anchors, match[1], 'phrase');
  }

  for (const match of query.matchAll(FILE_LIKE_PATTERN)) {
    const fileLike = match[0];
    addAnchor(anchors, fileLike, 'file');
    const fileName = fileLike.split(/[\\/]/).at(-1);
    addAnchor(anchors, fileName, 'file');
    const extension = fileName?.match(/\.[A-Za-z0-9]{1,12}$/)?.[0];
    addAnchor(anchors, extension, 'extension');
  }

  for (const match of query.matchAll(IDENTIFIER_PATTERN)) {
    const token = match[0];
    if (isStrongIdentifier(token)) {
      addAnchor(anchors, token, 'identifier');
    }
  }

  for (const match of query.matchAll(CHINESE_RUN_PATTERN)) {
    const token = match[0];
    if (isStrongChineseTerm(token)) {
      addAnchor(anchors, token, 'chinese');
    }
  }

  return dedupeAnchors(anchors);
}

function addAnchor(anchors: StrongAnchor[], rawValue: string | undefined, kind: AnchorKind): void {
  const value = normalizeAnchor(rawValue);
  if (!value || LOW_VALUE_TERMS.has(value)) {
    return;
  }

  anchors.push({ value, kind });
}

function dedupeAnchors(anchors: StrongAnchor[]): StrongAnchor[] {
  const seen = new Set<string>();
  const deduped: StrongAnchor[] = [];

  for (const anchor of anchors) {
    const key = `${anchor.kind}:${anchor.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(anchor);
  }

  return deduped;
}

function normalizeAnchor(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’.,;:!?，。；：！？]+$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isStrongIdentifier(token: string): boolean {
  if (LOW_VALUE_TERMS.has(token.toLowerCase())) {
    return false;
  }

  return (
    /[A-Z][a-z]+[A-Z]/.test(token) ||
    /[a-z][A-Z]/.test(token) ||
    /[_$.]/.test(token) ||
    /\d/.test(token) ||
    /^[A-Z]{2,10}$/.test(token)
  );
}

function isStrongChineseTerm(token: string): boolean {
  if (LOW_VALUE_TERMS.has(token)) {
    return false;
  }

  return ![...LOW_VALUE_TERMS].some((term) => /[\u4e00-\u9fff]/.test(term) && token.includes(term));
}

function hasStrongAnchorMatch(summary: MemorySummaryItem, anchors: StrongAnchor[]): boolean {
  const haystack = normalizeAnchor(buildSummaryIndexText(summary));
  return anchors.some((anchor) => anchor.kind !== 'extension' && haystack.includes(anchor.value));
}
