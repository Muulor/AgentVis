/**
 * HybridRetriever - 混合检索器
 *
 * 实现 Hybrid Search + RRF 融合策略：
 * 1. Embedding Top 30
 * 2. BM25 Top 30
 * 3. RRF 融合 → Top 20
 * 4. Parent 聚合（去重）
 * 5. 同源优先
 * 6. Top 3-4 parent chunks → LLM
 */

import type { Chunk, SearchResult } from '../../types';
import { VectorStore, getVectorStore } from './VectorStore';
import { BM25Index, getBM25Index } from './BM25Index';
import { embeddingService } from './EmbeddingService';
import { preprocessRagQuery, type RagQueryPreprocessResult } from './RagQueryPreprocessor';
import { rerankService } from './RerankService';
import { getLogger } from '@services/logger';
import type { ResolvedEmbeddingRoute, ResolvedRerankerRoute } from './RagConnectionConfig';

const logger = getLogger('HybridRetriever');

/** Hybrid 检索配置 */
export interface HybridRetrieverConfig {
  /** Embedding 检索数量 */
  embeddingTopK: number;
  /** BM25 检索数量 */
  bm25TopK: number;
  /** RRF 融合后保留数量 */
  rrfTopK: number;
  /** 最终返回的 Parent 块数量 */
  finalTopK: number;
  /** RRF k 参数 (默认 60) */
  rrfK: number;
  /** Embedding 相似度阈值 */
  embeddingThreshold: number;
  /** 是否启用 Parent 聚合 */
  enableParentAggregation: boolean;
  /** 每个 Parent 组最多展开的 Child 数量（防止大文件注入过多内容） */
  maxChunksPerParent: number;
  /** Whether final hits should be expanded with sibling chunks from the same parent. */
  enableParentContextRestore: boolean;
  /** Maximum characters to inject for each restored parent context. */
  parentContextMaxChars: number;
  /** Whether to drop weak final candidates instead of always filling finalTopK. */
  enableFinalRelevanceFilter: boolean;
  /** Minimum embedding score for a final result when it also has lexical grounding. */
  finalEmbeddingThreshold: number;
  /** Minimum embedding score for a final result without lexical grounding. */
  strongFinalEmbeddingThreshold: number;
  /** 是否启用 BM25 多片段检索 */
  enableBm25MultiFragment: boolean;
  /** 每个片段的 BM25 召回数量 */
  bm25FragmentTopK: number;
  /** 是否启用 SiliconFlow reranker */
  enableRerank: boolean;
  /** 进入 reranker 的候选数量 */
  rerankTopK: number;
  /** Rerank 成功时保留候选的最低相关性分数 */
  rerankMinScore: number;
  /** Rerank 强相关分数，达到后可跳过词面锚点要求 */
  strongRerankScoreThreshold: number;
}

const DEFAULT_HYBRID_CONFIG: HybridRetrieverConfig = {
  embeddingTopK: 30,
  bm25TopK: 30,
  rrfTopK: 20,
  finalTopK: 4,
  rrfK: 60,
  embeddingThreshold: 0.3,
  enableParentAggregation: true,
  maxChunksPerParent: 4,
  enableParentContextRestore: true,
  parentContextMaxChars: 2200,
  enableFinalRelevanceFilter: true,
  finalEmbeddingThreshold: 0.45,
  strongFinalEmbeddingThreshold: 0.62,
  enableBm25MultiFragment: true,
  bm25FragmentTopK: 10,
  enableRerank: true,
  rerankTopK: 20,
  rerankMinScore: 0.08,
  strongRerankScoreThreshold: 0.2,
};

const BROAD_QUERY_BM25_ONLY_RRF_WEIGHT = 0.35;
const BROAD_QUERY_SELECTION_POOL_MULTIPLIER = 4;
const BROAD_QUERY_DOCUMENT_OVERVIEW_RRF_WEIGHT = 1.2;
const RRF_SOURCE_ADDITIONAL_SCORE_WEIGHT = 0.1;
const RERANK_SOURCE_ADDITIONAL_SCORE_WEIGHT = 0.01;
const RERANK_SOURCE_SCORE_SCALE_THRESHOLD = 0.08;
const BROAD_QUERY_DOCUMENT_OVERVIEW_RERANK_BONUS = 0.05;
const BROAD_QUERY_DOCUMENT_OVERVIEW_RRF_SOURCE_WEIGHT = 1.08;
const BROAD_OVERVIEW_SOURCE_PATTERN =
  /features?|capabilit(?:y|ies)|overview|\u7279\u6027|\u6838\u5fc3\u7279\u6027|\u529f\u80fd\u5b9a\u4f4d|\u80fd\u529b\u6269\u5c55/i;
const FINAL_RELEVANCE_ENGLISH_TERM_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
const FINAL_RELEVANCE_FILE_TERM_PATTERN = /[\p{L}\p{N}_./\\-]+\.[A-Za-z0-9]{1,8}/gu;
const FINAL_RELEVANCE_HAN_RUN_PATTERN = /\p{Script=Han}+/gu;
const SCRIPT_PROFILE_HAN_PATTERN = /\p{Script=Han}/u;
const SCRIPT_PROFILE_LATIN_PATTERN = /[A-Za-z]/;
const CROSS_LANGUAGE_SEMANTIC_MIN_EMBEDDING_SCORE = 0.52;
const CROSS_LANGUAGE_SEMANTIC_MIN_RERANK_SCORE = 0.08;
const CROSS_LANGUAGE_QUERY_MIN_SIGNAL_CHARS = 2;
const CROSS_LANGUAGE_CANDIDATE_MIN_SIGNAL_CHARS = 20;
const CROSS_LANGUAGE_DOMINANT_RATIO = 0.65;
const CROSS_LANGUAGE_SECONDARY_MAX_RATIO = 0.25;
const FINAL_RELEVANCE_CHINESE_STOP_PART_PATTERN =
  /什么|哪些|哪个|如何|怎么|怎样|是否|进行|一下|请问|帮我|看看|介绍|说明|描述|总结|概述|这个|那个|这些|那些|一个|一种|以及|然后|如果|因为|所以|里面|里的|中的|上的|下的|的是|有的|是|的|了|有|吗|呢|啊|吧|和|与|在|中|里|上|下|对|把|给/g;
const LOW_VALUE_RELEVANCE_TERMS = new Set([
  'agentvis',
  'agent',
  'agents',
  'document',
  'overview',
  'guide',
  'intro',
  'introduction',
  'feature',
  'features',
  'capability',
  'capabilities',
  '功能',
  '机制',
  '文档',
  '介绍',
  '概述',
  '说明',
]);
const BROAD_OVERVIEW_CUE_TERMS = new Set([
  '特性',
  '核心特性',
  '功能',
  '能力',
  '亮点',
  'feature',
  'features',
  'capability',
  'capabilities',
  'overview',
]);

/** RRF 融合结果 */
interface FusedResult {
  chunkId: string;
  chunk: Chunk;
  rrfScore: number;
  rerankScore?: number;
  rawRerankScore?: number;
  embeddingScore?: number;
  bm25Score?: number;
  embeddingRank?: number;
  bm25Rank?: number;
}

/** Parent 聚合结果 */
interface AggregatedResult {
  parentChunkId: string | null;
  sectionPath: string;
  chunks: Chunk[];
  scoredChunks: Array<{ chunk: Chunk; score: number }>;
  rawScore: number;
  bestScore: number;
  totalScore: number;
  sourceFile: string | null;
  hasRerankScore?: boolean;
}

interface RelevanceTerm {
  value: string;
  isLowValue: boolean;
  isBroadOverviewCue: boolean;
}

interface FinalRelevanceDecision {
  keep: boolean;
  reason: string;
  embeddingScore?: number;
  rerankScore?: number;
  lexicalHitCount: number;
  usefulLexicalHitCount: number;
}

interface FinalRelevanceEvidence {
  lexical: { hitCount: number; usefulHitCount: number };
  hasUsefulLexicalMatch: boolean;
  crossLanguageSemanticMatch: boolean;
}

interface ScriptProfile {
  hanChars: number;
  latinChars: number;
  signalChars: number;
  hanRatio: number;
  latinRatio: number;
}

/**
 * HybridRetriever 类
 *
 * 实现 Embedding + BM25 混合检索，使用 RRF 算法融合排序
 */
export class HybridRetriever {
  private config: HybridRetrieverConfig;
  private vectorStore: VectorStore;
  private bm25Index: BM25Index;

  constructor(config: Partial<HybridRetrieverConfig> = {}) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config };
    this.vectorStore = getVectorStore();
    this.bm25Index = getBM25Index();
  }

  /**
   * 混合检索
   *
   * @param agentId - Agent ID
   * @param query - 查询文本
   * @param options - 检索选项
   * @returns 检索结果列表
   */
  async retrieve(
    agentId: string,
    query: string,
    options: Partial<HybridRetrieverConfig> = {}
  ): Promise<SearchResult[]> {
    const config = { ...this.config, ...options };
    const embeddingRoute = embeddingService.getActiveRoute();
    const rerankerRoute = rerankService.getActiveRoute();
    const useBuiltinScoreCalibration = embeddingRoute.mode === 'siliconflow';

    logger.trace('[HybridRetriever] 开始混合检索:', {
      agentId,
      query: query.substring(0, 80),
      finalTopK: config.finalTopK,
    });

    // 轻量 Query Preprocess：仅增强 BM25，不影响 Embedding 语义检索
    const preprocessedQuery = preprocessRagQuery(query);
    if (preprocessedQuery.extractedTerms.length > 0 || preprocessedQuery.fragments.length > 0) {
      logger.trace('[HybridRetriever] Query Preprocess:', {
        bm25Query: preprocessedQuery.bm25Query.substring(0, 120),
        extractedTerms: preprocessedQuery.extractedTerms,
        fragments: preprocessedQuery.fragments.map((fragment) => fragment.substring(0, 80)),
        isFocusedQuery: preprocessedQuery.isFocusedQuery,
      });
    }

    // 1. Embedding 检索 Top 30（使用原始 query，保持语义纯净）
    const embeddingResults = await this.embeddingSearch(agentId, query, config, embeddingRoute);
    logger.trace('[HybridRetriever] Embedding 结果:', embeddingResults.length, '条');

    // 2. BM25 检索 Top 30（使用增强 query + 可选多片段检索，提升关键词命中率）
    const bm25Results = await this.bm25Search(
      agentId,
      preprocessedQuery.bm25Query,
      config,
      preprocessedQuery.fragments
    );
    logger.trace('[HybridRetriever] BM25 结果:', bm25Results.length, '条');

    // 如果两个都没有结果，直接返回空
    if (embeddingResults.length === 0 && bm25Results.length === 0) {
      logger.trace('[HybridRetriever] 无检索结果');
      return [];
    }

    // 3. RRF 融合
    let fusedResults = this.rrfFusion(
      embeddingResults,
      bm25Results,
      config,
      preprocessedQuery.isBroadOverviewQuery
    );
    logger.trace('[HybridRetriever] RRF 融合后:', fusedResults.length, '条');

    // 诊断日志：输出 RRF Top20 完整排序明细，用于后续 bad case 分析
    this.logRrfTopK(fusedResults, config.rrfTopK);

    // 4. Rerank 二阶段重排：失败时自动保留 RRF 结果
    fusedResults = await this.rerankFusedResults(
      query,
      fusedResults,
      config,
      rerankerRoute,
      useBuiltinScoreCalibration
    );

    // 5. Parent 聚合（如果启用）
    let finalResults: SearchResult[];

    if (config.enableParentAggregation) {
      const aggregated = this.aggregateByParent(
        fusedResults.slice(0, config.rrfTopK),
        preprocessedQuery.isFocusedQuery
      );
      logger.trace('[HybridRetriever] Parent 聚合后:', aggregated.length, '组');

      // 诊断日志：输出每个 Parent 组的详情
      for (const agg of aggregated) {
        logger.trace(
          `[HybridRetriever]   📁 parent=${agg.parentChunkId?.substring(0, 12) ?? 'N/A'}`,
          `| source=${agg.sourceFile ?? 'N/A'}`,
          `| section=${agg.sectionPath.substring(0, 60) || 'N/A'}`,
          `| children=${agg.chunks.length}`,
          `| bestScore=${agg.bestScore.toFixed(4)}`,
          `| rawScore=${agg.rawScore.toFixed(4)}`,
          `| totalScore=${agg.totalScore.toFixed(4)}`
        );
      }

      // 5. 同源优先排序
      const prioritized = this.prioritizeSameSource(
        aggregated,
        preprocessedQuery.isBroadOverviewQuery
      );

      const maxPerParent = config.maxChunksPerParent;
      if (preprocessedQuery.isFocusedQuery) {
        // 章节/后记/书评等聚焦型问题需要连续上下文，优先展开最相关 parent。
        finalResults = this.expandFocusedParentResults(
          prioritized.slice(0, config.finalTopK),
          Math.max(maxPerParent, config.finalTopK),
          config.finalTopK
        );
      } else {
        // 泛问题先给最强来源更多证据，再少量穿插辅助来源。
        finalResults = this.selectBalancedParentResults(
          this.getSelectionPool(
            prioritized,
            config.finalTopK,
            preprocessedQuery.isBroadOverviewQuery
          ),
          maxPerParent,
          config.finalTopK,
          preprocessedQuery.isBroadOverviewQuery
        );
      }
    } else {
      // 不聚合，直接返回融合结果
      finalResults = fusedResults.slice(0, config.finalTopK).map((r) => ({
        chunk: r.chunk,
        score: r.rrfScore,
      }));
    }

    logger.trace('[HybridRetriever] 候选最终结果:', finalResults.length, '条');

    // 6. 排除记忆事实（memory_fact_*）
    // 事实已通过 MemoryContextProvider 直接注入身份层，RAG 检索是冗余且噪音大的
    // 摘要（memory_summary_*）保留，因为语义丰富适合语义检索
    const MEMORY_FACT_PREFIX = 'memory_fact_';
    const factFilteredCount = finalResults.length;
    finalResults = finalResults.filter((r) => !r.chunk.documentId.startsWith(MEMORY_FACT_PREFIX));
    if (finalResults.length < factFilteredCount) {
      logger.trace(`[HybridRetriever] 排除记忆事实: ${factFilteredCount} → ${finalResults.length}`);
    }

    // 7. 基于原始 embedding 余弦相似度过滤低质量结果
    // RRF 分数是排名融合分数（量级 0.01~0.02），不适合做相关度判断
    // 因此用原始 embeddingScore 做二次门控，丢弃语义不相关的结果
    const embeddingScoreMap = new Map<string, number>();
    const rerankScoreMap = new Map<string, number>();
    for (const fused of fusedResults) {
      if (fused.embeddingScore !== undefined) {
        embeddingScoreMap.set(fused.chunkId, fused.embeddingScore);
      }
      if (fused.rerankScore !== undefined) {
        rerankScoreMap.set(fused.chunkId, fused.rerankScore);
      }
    }

    if (useBuiltinScoreCalibration) {
      const beforeFilterCount = finalResults.length;
      finalResults = finalResults.filter((r) => {
        const rerankScore = rerankScoreMap.get(r.chunk.id);
        if (rerankScore !== undefined && rerankScore >= config.strongRerankScoreThreshold) {
          return true;
        }

        const embScore = embeddingScoreMap.get(r.chunk.id);
        // 仅 BM25 命中（无 embedding score）的结果保留，交由 RRF 排序决定
        if (embScore === undefined) return true;
        return embScore >= config.embeddingThreshold;
      });

      if (finalResults.length < beforeFilterCount) {
        logger.trace(
          `[HybridRetriever] embedding 阈值过滤: ${beforeFilterCount} → ${finalResults.length}`,
          `(threshold=${config.embeddingThreshold})`
        );
      }
    }

    finalResults = this.applyFinalRelevanceGate(
      finalResults,
      fusedResults,
      preprocessedQuery,
      config,
      !useBuiltinScoreCalibration
    );

    finalResults = this.orderBroadOverviewResultsByRerankScore(
      finalResults,
      fusedResults,
      preprocessedQuery.isBroadOverviewQuery
    );

    finalResults = this.restoreParentContexts(
      finalResults,
      config.enableParentContextRestore && !preprocessedQuery.isBroadOverviewQuery,
      config.parentContextMaxChars
    );

    logger.trace('[HybridRetriever] 最终结果:', finalResults.length, '条');

    // 诊断日志：打印每条结果的来源和内容片段，便于排查 RAG 清理是否生效
    for (const result of finalResults) {
      const embScore = embeddingScoreMap.get(result.chunk.id);
      logger.trace(
        `[HybridRetriever]   📄 documentId=${result.chunk.documentId}`,
        `| fileName=${result.chunk.metadata.fileName ?? 'N/A'}`,
        `| rrfScore=${result.score.toFixed(4)}`,
        `| embScore=${embScore?.toFixed(4) ?? 'N/A'}`,
        `| parentContext=${result.chunk.metadata.isParentContextRestored ? 'restored' : 'child'}`,
        `| content=${result.chunk.content.substring(0, 100)}...`
      );
    }
    return finalResults;
  }

  /**
   * Embedding 向量检索
   */
  private async embeddingSearch(
    agentId: string,
    query: string,
    config: HybridRetrieverConfig,
    route: ResolvedEmbeddingRoute
  ): Promise<Array<{ chunk: Chunk; score: number; rank: number }>> {
    try {
      // 将查询向量化
      const queryEmbedding = await embeddingService.encodeWithRoute(query, route, 'query');

      // 执行向量检索
      const results = await this.vectorStore.search(
        agentId,
        queryEmbedding,
        config.embeddingTopK,
        route.mode === 'custom' ? -1 : config.embeddingThreshold,
        undefined,
        route.profileId
      );

      // 添加排名信息
      return results.map((r, index) => ({
        chunk: r.chunk,
        score: r.score,
        rank: index + 1,
      }));
    } catch {
      logger.error('[HybridRetriever] Embedding 检索失败');
      return [];
    }
  }

  /**
   * BM25 关键词检索
   */
  private async bm25Search(
    agentId: string,
    query: string,
    config: HybridRetrieverConfig,
    fragments: string[] = []
  ): Promise<Array<{ chunk: Chunk; score: number; rank: number }>> {
    try {
      const bm25Results = this.searchBm25WithFragments(agentId, query, fragments, config);

      // 获取对应的 Chunk 内容
      const results: Array<{ chunk: Chunk; score: number; rank: number }> = [];

      for (let i = 0; i < bm25Results.length; i++) {
        const result = bm25Results[i];
        if (!result) continue;

        // 从 VectorStore 获取完整 Chunk 信息
        const chunk = await this.getChunkById(agentId, result.docId);
        if (chunk) {
          results.push({
            chunk,
            score: result.score,
            rank: i + 1,
          });
        }
      }

      return results;
    } catch {
      logger.error('[HybridRetriever] BM25 检索失败');
      return [];
    }
  }

  /**
   * BM25 检索：主 query + 多片段 query 合并。
   *
   * 多片段只用于 BM25，避免增加 embedding 调用和后端向量扫描成本。
   */
  private searchBm25WithFragments(
    agentId: string,
    query: string,
    fragments: string[],
    config: HybridRetrieverConfig
  ): Array<{ docId: string; score: number }> {
    const combined = new Map<
      string,
      { docId: string; score: number; hitCount: number; bestRank: number }
    >();

    const mergeResults = (
      results: Array<{ docId: string; score: number }>,
      weight: number
    ): void => {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result) continue;

        const weightedScore = result.score * weight;
        const existing = combined.get(result.docId);
        if (existing) {
          existing.score = Math.max(existing.score, weightedScore);
          existing.hitCount += 1;
          existing.bestRank = Math.min(existing.bestRank, i + 1);
        } else {
          combined.set(result.docId, {
            docId: result.docId,
            score: weightedScore,
            hitCount: 1,
            bestRank: i + 1,
          });
        }
      }
    };

    mergeResults(this.bm25Index.search(agentId, query, config.bm25TopK), 1);

    if (config.enableBm25MultiFragment && fragments.length > 0) {
      for (const fragment of fragments) {
        mergeResults(this.bm25Index.search(agentId, fragment, config.bm25FragmentTopK), 0.85);
      }
    }

    const merged = Array.from(combined.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
        return a.bestRank - b.bestRank;
      })
      .slice(0, config.bm25TopK)
      .map(({ docId, score }) => ({ docId, score }));

    if (config.enableBm25MultiFragment && fragments.length > 0) {
      logger.trace('[HybridRetriever] BM25 多片段合并:', {
        fragmentCount: fragments.length,
        mergedCount: merged.length,
      });
    }

    return merged;
  }

  /**
   * 根据 ID 获取 Chunk
   *
   * 注意：这是简化实现，实际应从 VectorStore 或数据库获取
   */
  private async getChunkById(agentId: string, chunkId: string): Promise<Chunk | null> {
    try {
      // 尝试从 vectorStore 获取
      const chunk = await this.vectorStore.getChunkById(agentId, chunkId);
      return chunk;
    } catch {
      return null;
    }
  }

  /**
   * RRF 融合算法
   *
   * Reciprocal Rank Fusion: score = Σ 1/(k + rank)
   */
  private rrfFusion(
    embeddingResults: Array<{ chunk: Chunk; score: number; rank: number }>,
    bm25Results: Array<{ chunk: Chunk; score: number; rank: number }>,
    config: HybridRetrieverConfig,
    isBroadOverviewQuery: boolean = false
  ): FusedResult[] {
    const fusedMap = new Map<string, FusedResult>();
    const k = config.rrfK;
    const downweightBm25Only = isBroadOverviewQuery && embeddingResults.length > 0;

    // 处理 Embedding 结果
    for (const result of embeddingResults) {
      const chunkId = result.chunk.id;
      const rrfContribution =
        this.getEmbeddingRrfContributionWeight(result.chunk, isBroadOverviewQuery) /
        (k + result.rank);

      const existing = fusedMap.get(chunkId);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.embeddingScore = result.score;
        existing.embeddingRank = result.rank;
      } else {
        fusedMap.set(chunkId, {
          chunkId,
          chunk: result.chunk,
          rrfScore: rrfContribution,
          embeddingScore: result.score,
          embeddingRank: result.rank,
        });
      }
    }

    // 处理 BM25 结果
    for (const result of bm25Results) {
      const chunkId = result.chunk.id;

      const existing = fusedMap.get(chunkId);
      const contributionWeight = this.getBm25RrfContributionWeight(
        result.chunk,
        Boolean(existing),
        downweightBm25Only
      );
      const rrfContribution = contributionWeight / (k + result.rank);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.bm25Score = result.score;
        existing.bm25Rank = result.rank;
      } else {
        fusedMap.set(chunkId, {
          chunkId,
          chunk: result.chunk,
          rrfScore: rrfContribution,
          bm25Score: result.score,
          bm25Rank: result.rank,
        });
      }
    }

    // 按 RRF 分数排序
    const fusedResults = Array.from(fusedMap.values());
    fusedResults.sort((a, b) => b.rrfScore - a.rrfScore);

    return fusedResults;
  }

  private async rerankFusedResults(
    query: string,
    fusedResults: FusedResult[],
    config: HybridRetrieverConfig,
    route: ResolvedRerankerRoute,
    useBuiltinScoreCalibration: boolean
  ): Promise<FusedResult[]> {
    if (
      !config.enableRerank ||
      !route.enabled ||
      fusedResults.length <= 1 ||
      config.rerankTopK <= 1
    ) {
      return fusedResults;
    }

    const candidateCount = Math.min(config.rerankTopK, fusedResults.length);
    const candidates = fusedResults.slice(0, candidateCount);

    try {
      const reranked = await rerankService.rerankWithRoute(
        query,
        candidates.map((result) => ({
          id: result.chunkId,
          text: this.buildRerankDocumentText(result.chunk),
        })),
        candidateCount,
        route
      );

      if (reranked.length === 0) {
        throw new Error('Rerank API returned no usable results');
      }

      const fusedById = new Map(candidates.map((result) => [result.chunkId, result]));
      const rerankedResults: FusedResult[] = [];
      for (let rerankIndex = 0; rerankIndex < reranked.length; rerankIndex++) {
        const result = reranked[rerankIndex];
        if (!result) continue;
        if (useBuiltinScoreCalibration && result.score < config.rerankMinScore) {
          continue;
        }

        const fused = fusedById.get(result.id);
        if (!fused) {
          continue;
        }

        const rankOnlyScore = 1 / (config.rrfK + rerankIndex + 1);
        const effectiveScore = useBuiltinScoreCalibration ? result.score : rankOnlyScore;
        rerankedResults.push({
          ...fused,
          rrfScore: effectiveScore,
          rerankScore: effectiveScore,
          rawRerankScore: result.score,
        });
      }

      logger.trace('[HybridRetriever] Rerank 完成:', {
        candidateCount,
        returnedCount: reranked.length,
        keptCount: rerankedResults.length,
        rerankMinScore: config.rerankMinScore,
      });

      return rerankedResults;
    } catch {
      logger.warn('[HybridRetriever] Rerank 失败，降级使用 RRF 结果');
      return fusedResults;
    }
  }

  private buildRerankDocumentText(chunk: Chunk): string {
    const parts = [
      chunk.metadata.fileName ? `Document: ${chunk.metadata.fileName}` : '',
      chunk.metadata.sectionPath ? `Section: ${chunk.metadata.sectionPath}` : '',
      chunk.metadata.heading ? `Heading: ${chunk.metadata.heading}` : '',
      chunk.content,
    ].filter(Boolean);

    return this.truncateText(parts.join('\n\n'), 3000);
  }

  private getBm25RrfContributionWeight(
    chunk: Chunk,
    alreadyHasEmbeddingHit: boolean,
    downweightBm25Only: boolean
  ): number {
    if (alreadyHasEmbeddingHit || !downweightBm25Only) {
      return 1;
    }

    return this.isBroadOverviewSourceCandidate(chunk) ? 1 : BROAD_QUERY_BM25_ONLY_RRF_WEIGHT;
  }

  private getEmbeddingRrfContributionWeight(chunk: Chunk, isBroadOverviewQuery: boolean): number {
    if (isBroadOverviewQuery && chunk.metadata.isDocumentOverview) {
      return BROAD_QUERY_DOCUMENT_OVERVIEW_RRF_WEIGHT;
    }

    return 1;
  }

  private isBroadOverviewSourceCandidate(chunk: Chunk): boolean {
    const text = [
      chunk.metadata.fileName,
      chunk.metadata.sectionPath,
      chunk.metadata.heading,
      chunk.content.slice(0, 240),
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n');

    return BROAD_OVERVIEW_SOURCE_PATTERN.test(text);
  }

  /**
   * Parent 聚合
   *
   * 将属于同一 Parent 的 Child 块聚合在一起
   */
  private aggregateByParent(
    fusedResults: FusedResult[],
    isFocusedQuery: boolean
  ): AggregatedResult[] {
    const aggregatedMap = new Map<string, AggregatedResult>();

    for (const result of fusedResults) {
      // 使用 parentChunkId 或 chunk.id 作为聚合键
      const parentId = result.chunk.metadata.parentChunkId ?? result.chunk.id;
      const sectionPath = result.chunk.metadata.sectionPath ?? '';
      const sourceFile = result.chunk.metadata.fileName ?? null;

      const existing = aggregatedMap.get(parentId);
      if (existing) {
        existing.chunks.push(result.chunk);
        existing.scoredChunks.push({ chunk: result.chunk, score: result.rrfScore });
        existing.rawScore += result.rrfScore;
        existing.bestScore = Math.max(existing.bestScore, result.rrfScore);
        existing.hasRerankScore =
          (existing.hasRerankScore ?? false) || result.rerankScore !== undefined;
      } else {
        aggregatedMap.set(parentId, {
          parentChunkId: parentId,
          sectionPath,
          chunks: [result.chunk],
          scoredChunks: [{ chunk: result.chunk, score: result.rrfScore }],
          rawScore: result.rrfScore,
          bestScore: result.rrfScore,
          totalScore: result.rrfScore,
          sourceFile,
          hasRerankScore: result.rerankScore !== undefined,
        });
      }
    }

    // Parent 分数以最佳 child 为主，少量保留多命中奖励。
    // 纯累加会让长文档/泛文档靠命中数量压过最相关的单条命中。
    const aggregatedResults = Array.from(aggregatedMap.values());
    for (const agg of aggregatedResults) {
      const additionalScore = agg.rawScore - agg.bestScore;
      const additionalWeight = isFocusedQuery ? 0.15 : 0.01;
      const diversityBonus = isFocusedQuery ? Math.log1p(agg.chunks.length) * 0.001 : 0;
      agg.totalScore = agg.bestScore + additionalScore * additionalWeight + diversityBonus;
      agg.scoredChunks.sort((a, b) => b.score - a.score);
    }

    // 按调整后的 Parent 分数排序
    aggregatedResults.sort((a, b) => b.totalScore - a.totalScore);

    return aggregatedResults;
  }

  /**
   * 泛问题输出 child chunk。
   *
   * 最强 Parent 先占一小段预算，用于保留关键细节；随后再穿插其它 Parent，
   * 避免过度平均导致主文档的细节被挤出实际注入窗口。
   */
  private selectBalancedParentResults(
    aggregated: AggregatedResult[],
    maxPerParent: number,
    targetCount: number,
    preferSourceDiversity: boolean = false
  ): SearchResult[] {
    const results: SearchResult[] = [];
    const seenContent = new Set<string>();
    if (targetCount <= 0 || aggregated.length === 0) return results;

    const perParent = aggregated.map((agg, index) => ({
      children: agg.scoredChunks.slice(0, maxPerParent),
      cursor: 0,
      sourceFile: agg.sourceFile ?? '__no_source__',
      index,
    }));

    const primary = perParent[0];
    if (!primary) return results;
    const primaryQuota = preferSourceDiversity
      ? 1
      : Math.min(maxPerParent, targetCount, Math.max(1, Math.ceil(targetCount / 2)));
    this.appendUniqueChildren(results, primary, primaryQuota, targetCount, seenContent);

    while (results.length < targetCount) {
      let appended = false;
      const sourceCounts = this.countSelectedSources(results);
      const roundGroups = [...perParent.slice(1), primary].sort((a, b) => {
        const sourceCountDiff =
          (sourceCounts.get(a.sourceFile) ?? 0) - (sourceCounts.get(b.sourceFile) ?? 0);
        if (sourceCountDiff !== 0) return sourceCountDiff;
        return a.index - b.index;
      });

      for (const group of roundGroups) {
        if (this.appendUniqueChildren(results, group, 1, targetCount, seenContent)) {
          appended = true;
        }
        if (results.length >= targetCount) break;
      }

      if (!appended) break;
    }

    return results;
  }

  private getSelectionPool(
    aggregated: AggregatedResult[],
    finalTopK: number,
    useBroadOverviewPool: boolean
  ): AggregatedResult[] {
    const poolSize = useBroadOverviewPool
      ? Math.max(finalTopK, finalTopK * BROAD_QUERY_SELECTION_POOL_MULTIPLIER)
      : finalTopK;
    return aggregated.slice(0, poolSize);
  }

  private countSelectedSources(results: SearchResult[]): Map<string, number> {
    const sourceCounts = new Map<string, number>();

    for (const result of results) {
      const source = result.chunk.metadata.fileName ?? '__no_source__';
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }

    return sourceCounts;
  }

  /**
   * 聚焦型问题按 Parent 连续展开，并尽量保留文档阅读顺序。
   */
  private expandFocusedParentResults(
    aggregated: AggregatedResult[],
    maxPerParent: number,
    targetCount: number
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const agg of aggregated) {
      const children = agg.scoredChunks.slice(0, maxPerParent).sort((a, b) => {
        const aIndex = a.chunk.chunkIndex;
        const bIndex = b.chunk.chunkIndex;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return b.score - a.score;
      });

      for (const child of children) {
        results.push({
          chunk: child.chunk,
          score: child.score,
        });

        if (results.length >= targetCount) {
          return results;
        }
      }
    }

    return results;
  }

  private appendUniqueChildren(
    results: SearchResult[],
    group: { children: Array<{ chunk: Chunk; score: number }>; cursor: number },
    quota: number,
    targetCount: number,
    seenContent: Set<string>
  ): boolean {
    let appended = 0;

    while (
      appended < quota &&
      results.length < targetCount &&
      group.cursor < group.children.length
    ) {
      const child = group.children[group.cursor++];
      if (!child) continue;

      const contentKey = this.getContentDedupeKey(child.chunk);
      if (seenContent.has(contentKey)) continue;

      seenContent.add(contentKey);
      results.push({
        chunk: child.chunk,
        score: child.score,
      });
      appended++;
    }

    return appended > 0;
  }

  private getContentDedupeKey(chunk: Chunk): string {
    const normalizedPrefix = chunk.content.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${chunk.documentId}:${normalizedPrefix}`;
  }

  private applyFinalRelevanceGate(
    results: SearchResult[],
    fusedResults: FusedResult[],
    preprocessedQuery: RagQueryPreprocessResult,
    config: HybridRetrieverConfig,
    customRankOnly: boolean = false
  ): SearchResult[] {
    if (results.length === 0) {
      return results;
    }
    if (!config.enableFinalRelevanceFilter && !customRankOnly) {
      return results;
    }

    const fusedByChunkId = new Map(fusedResults.map((result) => [result.chunkId, result]));
    const relevanceTerms = this.buildFinalRelevanceTerms(preprocessedQuery);
    const dropped: Array<{ chunkId: string; fileName?: string; reason: string }> = [];

    const filtered = results.filter((result) => {
      const decision = this.getFinalRelevanceDecision(
        result.chunk,
        fusedByChunkId.get(result.chunk.id),
        relevanceTerms,
        preprocessedQuery,
        config,
        customRankOnly
      );

      if (!decision.keep) {
        dropped.push({
          chunkId: result.chunk.id,
          fileName: result.chunk.metadata.fileName,
          reason: decision.reason,
        });
      }

      return decision.keep;
    });

    if (filtered.length < results.length) {
      logger.trace(
        `[HybridRetriever] final relevance gate: ${results.length} → ${filtered.length}`,
        {
          termCount: relevanceTerms.length,
          dropped,
          finalEmbeddingThreshold: config.finalEmbeddingThreshold,
          strongFinalEmbeddingThreshold: config.strongFinalEmbeddingThreshold,
          strongRerankScoreThreshold: config.strongRerankScoreThreshold,
        }
      );
    }

    return filtered;
  }

  private getFinalRelevanceDecision(
    chunk: Chunk,
    fused: FusedResult | undefined,
    relevanceTerms: RelevanceTerm[],
    preprocessedQuery: RagQueryPreprocessResult,
    config: HybridRetrieverConfig,
    customRankOnly: boolean = false
  ): FinalRelevanceDecision {
    const rerankScore = fused?.rerankScore;
    const embeddingScore = fused?.embeddingScore;
    const evidence = this.getFinalRelevanceEvidence(
      chunk,
      fused,
      relevanceTerms,
      preprocessedQuery,
      config
    );
    const { lexical, hasUsefulLexicalMatch } = evidence;

    if (customRankOnly) {
      return {
        keep: hasUsefulLexicalMatch,
        reason: hasUsefulLexicalMatch
          ? 'custom_rank_with_lexical_grounding'
          : 'custom_rank_missing_lexical_grounding',
        embeddingScore,
        rerankScore,
        lexicalHitCount: lexical.hitCount,
        usefulLexicalHitCount: lexical.usefulHitCount,
      };
    }

    if (rerankScore !== undefined && rerankScore >= config.strongRerankScoreThreshold) {
      return {
        keep: true,
        reason: 'strong_rerank',
        embeddingScore,
        rerankScore,
        lexicalHitCount: lexical.hitCount,
        usefulLexicalHitCount: lexical.usefulHitCount,
      };
    }

    if (evidence.crossLanguageSemanticMatch) {
      return {
        keep: true,
        reason: 'cross_language_semantic_match',
        embeddingScore,
        rerankScore,
        lexicalHitCount: lexical.hitCount,
        usefulLexicalHitCount: lexical.usefulHitCount,
      };
    }

    if (embeddingScore !== undefined) {
      if (embeddingScore >= config.strongFinalEmbeddingThreshold) {
        return {
          keep: true,
          reason: 'strong_embedding',
          embeddingScore,
          rerankScore,
          lexicalHitCount: lexical.hitCount,
          usefulLexicalHitCount: lexical.usefulHitCount,
        };
      }

      if (embeddingScore >= config.finalEmbeddingThreshold && hasUsefulLexicalMatch) {
        return {
          keep: true,
          reason: 'embedding_with_lexical_grounding',
          embeddingScore,
          rerankScore,
          lexicalHitCount: lexical.hitCount,
          usefulLexicalHitCount: lexical.usefulHitCount,
        };
      }

      return {
        keep: false,
        reason: hasUsefulLexicalMatch
          ? `embedding_below_threshold:${embeddingScore.toFixed(4)}`
          : `missing_lexical_grounding:${embeddingScore.toFixed(4)}`,
        embeddingScore,
        rerankScore,
        lexicalHitCount: lexical.hitCount,
        usefulLexicalHitCount: lexical.usefulHitCount,
      };
    }

    if (fused?.bm25Score !== undefined && hasUsefulLexicalMatch) {
      return {
        keep: true,
        reason: 'bm25_with_lexical_grounding',
        rerankScore,
        lexicalHitCount: lexical.hitCount,
        usefulLexicalHitCount: lexical.usefulHitCount,
      };
    }

    return {
      keep: false,
      reason:
        fused?.bm25Score !== undefined
          ? 'bm25_without_useful_lexical_grounding'
          : 'missing_relevance_signal',
      rerankScore,
      lexicalHitCount: lexical.hitCount,
      usefulLexicalHitCount: lexical.usefulHitCount,
    };
  }

  private getFinalRelevanceEvidence(
    chunk: Chunk,
    fused: FusedResult | undefined,
    relevanceTerms: RelevanceTerm[],
    preprocessedQuery: RagQueryPreprocessResult,
    config: HybridRetrieverConfig
  ): FinalRelevanceEvidence {
    const lexical = this.getLexicalRelevance(
      chunk,
      relevanceTerms,
      preprocessedQuery.isBroadOverviewQuery
    );
    const hasUsefulLexicalMatch = lexical.usefulHitCount > 0;
    const searchableText = this.buildFinalRelevanceSearchableText(chunk);

    return {
      lexical,
      hasUsefulLexicalMatch,
      crossLanguageSemanticMatch: this.isCrossLanguageSemanticMatch(
        preprocessedQuery.originalQuery,
        searchableText,
        fused?.embeddingScore,
        fused?.rerankScore,
        config,
        lexical.usefulHitCount
      ),
    };
  }

  private orderBroadOverviewResultsByRerankScore(
    results: SearchResult[],
    fusedResults: FusedResult[],
    isBroadOverviewQuery: boolean
  ): SearchResult[] {
    if (!isBroadOverviewQuery || results.length <= 1) {
      return results;
    }

    const rerankScoreMap = new Map<string, number>();
    for (const fused of fusedResults) {
      if (fused.rerankScore !== undefined) {
        rerankScoreMap.set(fused.chunkId, fused.rerankScore);
      }
    }

    if (rerankScoreMap.size === 0) {
      return results;
    }

    return [...results].sort((a, b) => {
      const scoreA = rerankScoreMap.get(a.chunk.id) ?? a.score;
      const scoreB = rerankScoreMap.get(b.chunk.id) ?? b.score;
      return scoreB - scoreA;
    });
  }

  private buildFinalRelevanceTerms(preprocessedQuery: RagQueryPreprocessResult): RelevanceTerm[] {
    const terms = new Map<string, RelevanceTerm>();

    const addTerm = (rawTerm: string): void => {
      const normalized = this.normalizeRelevanceText(rawTerm);
      if (normalized.length < 2) return;

      terms.set(normalized, {
        value: normalized,
        isLowValue: LOW_VALUE_RELEVANCE_TERMS.has(normalized),
        isBroadOverviewCue: BROAD_OVERVIEW_CUE_TERMS.has(normalized),
      });
    };

    for (const term of preprocessedQuery.extractedTerms) {
      addTerm(term);
    }

    for (const match of preprocessedQuery.originalQuery.matchAll(
      FINAL_RELEVANCE_FILE_TERM_PATTERN
    )) {
      addTerm(match[0]);
      addTerm(match[0].replace(/\.[A-Za-z0-9]{1,8}$/, ''));
    }

    for (const match of preprocessedQuery.originalQuery.matchAll(
      FINAL_RELEVANCE_ENGLISH_TERM_PATTERN
    )) {
      addTerm(match[0]);
    }

    for (const match of preprocessedQuery.originalQuery.matchAll(FINAL_RELEVANCE_HAN_RUN_PATTERN)) {
      const parts = match[0]
        .replace(FINAL_RELEVANCE_CHINESE_STOP_PART_PATTERN, ' ')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2);

      for (const part of parts) {
        addTerm(part);
      }
    }

    return Array.from(terms.values());
  }

  private getLexicalRelevance(
    chunk: Chunk,
    relevanceTerms: RelevanceTerm[],
    isBroadOverviewQuery: boolean
  ): { hitCount: number; usefulHitCount: number } {
    if (relevanceTerms.length === 0) {
      return { hitCount: 0, usefulHitCount: 0 };
    }

    const searchableText = this.normalizeRelevanceText(
      this.buildFinalRelevanceSearchableText(chunk)
    );
    const compactSearchableText = searchableText.replace(/\s+/g, '');
    let hitCount = 0;
    let usefulHitCount = 0;

    for (const term of relevanceTerms) {
      const compactTerm = term.value.replace(/\s+/g, '');
      if (!searchableText.includes(term.value) && !compactSearchableText.includes(compactTerm)) {
        continue;
      }

      hitCount++;
      if (!term.isLowValue || (isBroadOverviewQuery && term.isBroadOverviewCue)) {
        usefulHitCount++;
      }
    }

    return { hitCount, usefulHitCount };
  }

  private buildFinalRelevanceSearchableText(chunk: Chunk): string {
    return [
      chunk.metadata.fileName,
      chunk.metadata.heading,
      chunk.metadata.sectionPath,
      chunk.content,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n');
  }

  private isCrossLanguageSemanticMatch(
    query: string,
    candidateText: string,
    embeddingScore: number | undefined,
    rerankScore: number | undefined,
    config: HybridRetrieverConfig,
    usefulLexicalHitCount: number
  ): boolean {
    if (usefulLexicalHitCount > 0) {
      return false;
    }
    if (
      embeddingScore === undefined ||
      embeddingScore < CROSS_LANGUAGE_SEMANTIC_MIN_EMBEDDING_SCORE
    ) {
      return false;
    }

    const minimumRerankScore = Math.max(
      config.rerankMinScore,
      CROSS_LANGUAGE_SEMANTIC_MIN_RERANK_SCORE
    );
    if (rerankScore === undefined || rerankScore < minimumRerankScore) {
      return false;
    }

    const queryProfile = this.getScriptProfile(query);
    const candidateProfile = this.getScriptProfile(candidateText);

    return (
      (this.isHanDominant(queryProfile, CROSS_LANGUAGE_QUERY_MIN_SIGNAL_CHARS) &&
        this.isLatinDominant(candidateProfile, CROSS_LANGUAGE_CANDIDATE_MIN_SIGNAL_CHARS)) ||
      (this.isLatinDominant(queryProfile, CROSS_LANGUAGE_QUERY_MIN_SIGNAL_CHARS) &&
        this.isHanDominant(candidateProfile, CROSS_LANGUAGE_CANDIDATE_MIN_SIGNAL_CHARS))
    );
  }

  private getScriptProfile(text: string): ScriptProfile {
    let hanChars = 0;
    let latinChars = 0;

    for (const char of text) {
      if (SCRIPT_PROFILE_HAN_PATTERN.test(char)) {
        hanChars++;
      } else if (SCRIPT_PROFILE_LATIN_PATTERN.test(char)) {
        latinChars++;
      }
    }

    const signalChars = hanChars + latinChars;

    return {
      hanChars,
      latinChars,
      signalChars,
      hanRatio: signalChars > 0 ? hanChars / signalChars : 0,
      latinRatio: signalChars > 0 ? latinChars / signalChars : 0,
    };
  }

  private isHanDominant(profile: ScriptProfile, minSignalChars: number): boolean {
    return (
      profile.hanChars >= minSignalChars &&
      profile.hanRatio >= CROSS_LANGUAGE_DOMINANT_RATIO &&
      profile.latinRatio <= CROSS_LANGUAGE_SECONDARY_MAX_RATIO
    );
  }

  private isLatinDominant(profile: ScriptProfile, minSignalChars: number): boolean {
    return (
      profile.latinChars >= minSignalChars &&
      profile.latinRatio >= CROSS_LANGUAGE_DOMINANT_RATIO &&
      profile.hanRatio <= CROSS_LANGUAGE_SECONDARY_MAX_RATIO
    );
  }

  private normalizeRelevanceText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private restoreParentContexts(
    results: SearchResult[],
    enabled: boolean,
    maxChars: number
  ): SearchResult[] {
    if (!enabled || maxChars <= 0 || results.length === 0) {
      return results;
    }

    const restoredResults: SearchResult[] = [];
    const restoredParentKeys = new Set<string>();
    let restoredCount = 0;
    let skippedDuplicateCount = 0;

    for (const result of results) {
      const parentKey = this.getParentContextKey(result.chunk);
      if (!parentKey) {
        restoredResults.push(result);
        continue;
      }

      if (restoredParentKeys.has(parentKey)) {
        skippedDuplicateCount++;
        continue;
      }

      const restored = this.restoreParentContext(result, maxChars);
      restoredResults.push(restored);

      if (restored.chunk.metadata.isParentContextRestored) {
        restoredParentKeys.add(parentKey);
        restoredCount++;
      }
    }

    if (restoredCount > 0 || skippedDuplicateCount > 0) {
      logger.trace('[HybridRetriever] Parent context restore:', {
        restoredCount,
        skippedDuplicateCount,
        resultCount: results.length,
        finalCount: restoredResults.length,
      });
    }

    return restoredResults;
  }

  private restoreParentContext(result: SearchResult, maxChars: number): SearchResult {
    const parentChunkId = result.chunk.metadata.parentChunkId;
    if (!parentChunkId) {
      return result;
    }

    const siblingChunks = this.vectorStore.getCachedChunksByParent(
      result.chunk.agentId,
      result.chunk.documentId,
      parentChunkId
    );

    if (siblingChunks.length <= 1) {
      return result;
    }

    const content = this.buildRestoredParentContent(result.chunk, siblingChunks, maxChars);
    if (!content || content === result.chunk.content) {
      return result;
    }

    return {
      ...result,
      chunk: {
        ...result.chunk,
        content,
        metadata: {
          ...result.chunk.metadata,
          isParentContextRestored: true,
        },
      },
    };
  }

  private getParentContextKey(chunk: Chunk): string | null {
    const parentChunkId = chunk.metadata.parentChunkId;
    if (!parentChunkId || chunk.metadata.isParent || chunk.metadata.isDocumentOverview) {
      return null;
    }

    return `${chunk.agentId}\u0000${chunk.documentId}\u0000${parentChunkId}`;
  }

  private buildRestoredParentContent(
    hitChunk: Chunk,
    siblingChunks: Chunk[],
    maxChars: number
  ): string {
    const sorted = [...siblingChunks].sort((a, b) => {
      if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
      return a.id.localeCompare(b.id);
    });
    const hitIndex = sorted.findIndex((chunk) => chunk.id === hitChunk.id);
    if (hitIndex < 0) {
      return hitChunk.content;
    }

    const fullParentContent = this.joinParentContextChunks(sorted);
    if (fullParentContent.length <= maxChars) {
      return fullParentContent;
    }

    const selectedIndexes = new Set<number>([hitIndex]);
    let selectedLength = sorted[hitIndex]?.content.length ?? 0;

    const tryAddIndex = (index: number): void => {
      const chunk = sorted[index];
      if (!chunk || selectedIndexes.has(index)) return;

      const separatorCost = selectedIndexes.size > 0 ? 2 : 0;
      const candidateLength = chunk.content.trim().length + separatorCost;
      if (selectedLength + candidateLength <= maxChars) {
        selectedIndexes.add(index);
        selectedLength += candidateLength;
      }
    };

    if (hitIndex > 0) {
      tryAddIndex(0);
    }

    let left = hitIndex - 1;
    let right = hitIndex + 1;
    while (left >= 0 || right < sorted.length) {
      if (left >= 0) {
        tryAddIndex(left);
        left--;
      }

      if (right < sorted.length) {
        tryAddIndex(right);
        right++;
      }
    }

    const restoredContent = this.joinParentContextChunks(
      sorted.filter((_chunk, index) => selectedIndexes.has(index))
    );

    return this.truncateText(restoredContent, maxChars);
  }

  private joinParentContextChunks(chunks: Chunk[]): string {
    return chunks
      .map((chunk) => chunk.content.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  private truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    if (maxChars <= 3) {
      return text.slice(0, maxChars);
    }

    return `${text.slice(0, maxChars - 3).trimEnd()}...`;
  }

  private prioritizeSameSource(
    aggregated: AggregatedResult[],
    isBroadOverviewQuery: boolean = false
  ): AggregatedResult[] {
    // 按来源文件分组
    const bySource = new Map<string, AggregatedResult[]>();

    for (const result of aggregated) {
      const source = result.sourceFile ?? '__no_source__';
      if (!bySource.has(source)) {
        bySource.set(source, []);
      }
      const sourceResults = bySource.get(source);
      if (sourceResults) {
        sourceResults.push(result);
      }
    }

    // 计算每个来源的分数：仍以该来源最佳 Parent 为主，少量保留同源聚合奖励。
    // 避免长文档来源靠多个中等 Parent 命中覆盖更精准来源。
    const sourceScores = new Map<string, number>();
    for (const [source, results] of bySource) {
      const scores = results.map((result) =>
        this.getSourcePriorityScore(result, isBroadOverviewQuery)
      );
      const bestScore = Math.max(...scores);
      const additionalScore = scores.reduce((sum, score) => sum + score, 0) - bestScore;
      const additionalWeight = this.hasRerankScaleScores(results)
        ? RERANK_SOURCE_ADDITIONAL_SCORE_WEIGHT
        : RRF_SOURCE_ADDITIONAL_SCORE_WEIGHT;
      sourceScores.set(source, bestScore + additionalScore * additionalWeight);
    }

    // 按来源总分排序
    const sortedSources = Array.from(sourceScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source]) => source);

    // 重新排列结果：优先返回得分最高来源的结果
    const prioritized: AggregatedResult[] = [];
    for (const source of sortedSources) {
      const results = [...(bySource.get(source) ?? [])].sort(
        (a, b) =>
          this.getSourcePriorityScore(b, isBroadOverviewQuery) -
          this.getSourcePriorityScore(a, isBroadOverviewQuery)
      );
      prioritized.push(...results);
    }

    return prioritized;
  }

  private getSourcePriorityScore(result: AggregatedResult, isBroadOverviewQuery: boolean): number {
    if (!isBroadOverviewQuery || !this.isDocumentOverviewAggregatedResult(result)) {
      return result.totalScore;
    }

    return result.hasRerankScore
      ? result.totalScore + BROAD_QUERY_DOCUMENT_OVERVIEW_RERANK_BONUS
      : result.totalScore * BROAD_QUERY_DOCUMENT_OVERVIEW_RRF_SOURCE_WEIGHT;
  }

  private isDocumentOverviewAggregatedResult(result: AggregatedResult): boolean {
    return result.chunks.some((chunk) => chunk.metadata.isDocumentOverview);
  }

  private hasRerankScaleScores(results: AggregatedResult[]): boolean {
    return results.some(
      (result) =>
        result.hasRerankScore === true || result.bestScore >= RERANK_SOURCE_SCORE_SCALE_THRESHOLD
    );
  }

  // ==================== 诊断日志 ====================

  /**
   * 输出 RRF Top-K 完整排序明细
   *
   * 用于诊断「正确文档在 Top20 但未进最终 Top4」的场景，
   * 仅 trace 级别输出，生产环境无性能影响。
   */
  private logRrfTopK(fusedResults: FusedResult[], topK: number): void {
    const displayCount = Math.min(fusedResults.length, topK);
    logger.trace(`[HybridRetriever] ── RRF Top${displayCount} 排序明细 ──`);

    for (let i = 0; i < displayCount; i++) {
      const r = fusedResults[i];
      if (!r) continue;
      logger.trace(
        `[HybridRetriever]   #${i + 1}`,
        `| rrfScore=${r.rrfScore.toFixed(5)}`,
        `| embRank=${r.embeddingRank ?? '-'}`,
        `| embScore=${r.embeddingScore?.toFixed(4) ?? '-'}`,
        `| bm25Rank=${r.bm25Rank ?? '-'}`,
        `| bm25Score=${r.bm25Score?.toFixed(4) ?? '-'}`,
        `| doc=${r.chunk.documentId.substring(0, 30)}`,
        `| file=${r.chunk.metadata.fileName ?? 'N/A'}`,
        `| content=${r.chunk.content.substring(0, 80).replace(/\n/g, '↵')}...`
      );
    }
  }

  // ==================== 配置管理 ====================

  /**
   * 更新配置
   */
  updateConfig(config: Partial<HybridRetrieverConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): HybridRetrieverConfig {
    return { ...this.config };
  }
}

// 单例实例
let hybridRetrieverInstance: HybridRetriever | null = null;

/**
 * 获取 HybridRetriever 单例
 */
export function getHybridRetriever(): HybridRetriever {
  hybridRetrieverInstance ??= new HybridRetriever();
  return hybridRetrieverInstance;
}

/**
 * 创建新的 HybridRetriever 实例
 */
export function createHybridRetriever(config?: Partial<HybridRetrieverConfig>): HybridRetriever {
  return new HybridRetriever(config);
}
