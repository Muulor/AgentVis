/**
 * RagService - RAG 服务主类
 *
 * 整合 DocumentChunker、VectorStore、HybridRetriever、ContextProvider，
 * 提供完整的 RAG 工作流接口。
 *
 * 使用 Hybrid Search + RRF 融合策略：
 * Embedding Top30 + BM25 Top30 → RRF 融合 → Parent 聚合 → Top 3-4
 */

import type { Chunk, ChunkingConfig, RetrievalConfig, SearchResult } from '../../types';
import { invoke } from '@tauri-apps/api/core';
import { DocumentChunker, createDocumentChunker } from './DocumentChunker';
import { VectorStore, getVectorStore } from './VectorStore';
import {
  HybridRetriever,
  createHybridRetriever,
  type HybridRetrieverConfig,
} from './HybridRetriever';
import { ContextProvider, createContextProvider, type FormatOptions } from './ContextProvider';
import { embeddingService } from './EmbeddingService';
import { getBM25Index } from './BM25Index';
import { buildBm25IndexText, buildEmbeddingIndexText } from './RagQueryPreprocessor';
import { createDocumentOverviewChunk } from './DocumentOverviewBuilder';
import { getLogger } from '@services/logger';
import { ragIndexCoordinator } from './RagIndexCoordinator';
import { encodeEmbeddingInputs, withEmbeddingAggregationMetadata } from './EmbeddingInputPlanner';

const logger = getLogger('RagService');

/** RAG 服务配置 */
export interface RagServiceConfig {
  chunking?: Partial<ChunkingConfig>;
  retrieval?: Partial<RetrievalConfig>;
  hybrid?: Partial<HybridRetrieverConfig>;
  format?: Partial<FormatOptions>;
  /** 是否启用混合检索（默认 true） */
  enableHybridSearch?: boolean;
}

/**
 * RagService 类
 *
 * 提供完整的 RAG 工作流：索引、检索、格式化
 */
export class RagService {
  private documentChunker: DocumentChunker;
  private vectorStore: VectorStore;
  private hybridRetriever: HybridRetriever;
  private contextProvider: ContextProvider;
  private enableHybridSearch: boolean;
  private bm25RebuildAttemptedAgents: Set<string> = new Set();

  constructor(config: RagServiceConfig = {}) {
    this.documentChunker = createDocumentChunker(config.chunking);
    this.vectorStore = getVectorStore();
    this.hybridRetriever = createHybridRetriever(config.hybrid);
    // 默认关闭匹配度显示：RRF 融合分数（~0.015）显示为 "2%" 会误导 LLM，
    // 开发者可通过 HybridRetriever 的 trace 日志查看完整的 embScore/bm25Score 明细
    this.contextProvider = createContextProvider({ showScore: false, ...config.format });
    this.enableHybridSearch = config.enableHybridSearch ?? true;
  }

  private isMemoryVectorChunk(resultOrChunk: SearchResult | SearchResult['chunk']): boolean {
    const chunk = 'chunk' in resultOrChunk ? resultOrChunk.chunk : resultOrChunk;
    return Boolean(chunk.metadata.memoryType ?? chunk.metadata.memoryId);
  }

  /**
   * Rebuild the in-memory BM25 index from persisted vector chunks when needed.
   *
   * BM25 intentionally stays in the renderer process, so app/renderer restart
   * loses it while SQLite vector rows remain. This restores keyword recall
   * before the first hybrid search after restart.
   */
  private async ensureBm25Index(agentId: string): Promise<void> {
    if (this.bm25RebuildAttemptedAgents.has(agentId)) {
      return;
    }

    try {
      const bm25Index = getBM25Index();
      const chunks = await this.vectorStore.listChunks(agentId);
      let rebuiltCount = 0;

      for (const chunk of chunks) {
        if (this.isMemoryVectorChunk(chunk)) {
          continue;
        }

        const bm25Text = buildBm25IndexText({
          fileName: chunk.metadata.fileName,
          filePath: chunk.metadata.filePath,
          sectionPath: chunk.metadata.sectionPath,
          heading: chunk.metadata.heading,
          content: chunk.content,
        });
        bm25Index.addDocument(agentId, chunk.id, bm25Text, chunk.documentId);
        rebuiltCount++;
      }

      this.bm25RebuildAttemptedAgents.add(agentId);
      logger.trace('[RagService] BM25 rebuilt from persisted chunks:', {
        agentId,
        rebuiltCount,
        persistedChunkCount: chunks.length,
      });
    } catch (error) {
      logger.warn('[RagService] BM25 rebuild failed:', error);
    }
  }

  /**
   * 索引文档
   *
   * 将文档分块、向量化并存储到向量数据库
   * 同时更新 BM25 索引
   *
   * @param agentId - Agent ID
   * @param documentId - 文档 ID
   * @param content - 文档内容
   * @param metadata - 文档元数据
   * @param onProgress - 进度回调
   * @returns 索引的块数量
   */
  async indexDocument(
    agentId: string,
    documentId: string,
    content: string,
    metadata: {
      fileName?: string;
      filePath?: string;
      documentType?: 'markdown' | 'text' | 'code';
    } = {},
    onProgress?: (current: number, total: number) => void
  ): Promise<number> {
    // 第一步：分块（使用 Parent-Child 层级分块）
    const result = this.documentChunker.chunkWithHierarchy(content, agentId, documentId, metadata);

    // 使用 Child 块进行向量化（用于检索）
    const childChunks = result.childChunks;

    if (childChunks.length === 0) {
      logger.trace('[RagService] 文档分块后为空，跳过索引');
      return 0;
    }

    const overviewChunk = createDocumentOverviewChunk({
      agentId,
      documentId,
      content,
      metadata,
      childChunkCount: childChunks.length,
      parentChunkCount: result.parentChunks.length,
    });
    const chunks: Chunk[] = overviewChunk ? [overviewChunk, ...childChunks] : childChunks;

    logger.trace('[RagService] 文档分块完成:', {
      childChunks: result.childChunks.length,
      parentChunks: result.parentChunks.length,
      overviewChunks: overviewChunk ? 1 : 0,
    });

    // 第二步：批量向量化
    const texts = chunks.map((chunk) =>
      buildEmbeddingIndexText({
        fileName: chunk.metadata.fileName,
        filePath: chunk.metadata.filePath,
        sectionPath: chunk.metadata.sectionPath,
        heading: chunk.metadata.heading,
        content: chunk.content,
      })
    );
    const writerLease = await ragIndexCoordinator.acquireWriter();
    try {
      const embeddingRoute = embeddingService.getActiveRoute();
      const embeddingResults = await encodeEmbeddingInputs(texts, (expandedTexts) =>
        embeddingService.encodeBatchWithRoute(expandedTexts, embeddingRoute, 'document')
      );

      // 第三步：存储到向量数据库 + BM25 索引
      const bm25Index = getBM25Index();

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embeddingResult = embeddingResults[i];
        if (!chunk || !embeddingResult) {
          throw new Error('RAG_EMBEDDING_RESULT_COUNT_MISMATCH');
        }
        if (embeddingService.getActiveProfileId() !== embeddingRoute.profileId) {
          throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_INDEX');
        }

        // 向量存储
        await this.vectorStore.insert(
          {
            ...chunk,
            metadata: withEmbeddingAggregationMetadata(
              chunk.metadata,
              embeddingResult.segmentCount
            ),
          },
          embeddingResult.embedding,
          embeddingRoute.profileId
        );

        // BM25 索引使用元数据增强文本，便于文件名/路径/章节标题类 query 命中。
        // 向量检索和最终注入仍使用 chunk.content，避免元数据污染语义上下文。
        const bm25Text = buildBm25IndexText({
          fileName: chunk.metadata.fileName,
          filePath: chunk.metadata.filePath,
          sectionPath: chunk.metadata.sectionPath,
          heading: chunk.metadata.heading,
          content: chunk.content,
        });
        bm25Index.addDocument(agentId, chunk.id, bm25Text, documentId);

        if (onProgress) {
          onProgress(i + 1, chunks.length);
        }
      }

      logger.trace('[RagService] 索引完成:', {
        agentId,
        documentId,
        chunkCount: chunks.length,
        bm25Stats: bm25Index.getStats(agentId),
      });

      return chunks.length;
    } finally {
      writerLease.release();
    }
  }

  /**
   * 检索相关内容
   *
   * 使用 Hybrid Search + RRF 融合策略
   *
   * @param agentId - Agent ID
   * @param query - 查询文本
   * @param options - 检索选项
   * @returns 检索结果
   */
  async retrieve(
    agentId: string,
    query: string,
    options?: Partial<RetrievalConfig & HybridRetrieverConfig>
  ): Promise<SearchResult[]> {
    // 诊断日志：检查索引状态
    try {
      const status = await this.vectorStore.getStatus(agentId);
      logger.trace('[RagService] 索引状态:', {
        agentId,
        chunkCount: status.chunkCount,
        documentCount: status.documentCount,
      });

      if (status.chunkCount === 0) {
        logger.warn('[RagService] 警告：该 Agent 没有向量索引数据');
        return [];
      }
    } catch (statusError) {
      logger.warn('[RagService] 获取索引状态失败:', statusError);
    }

    if (this.enableHybridSearch) {
      await this.ensureBm25Index(agentId);
    }

    let results: SearchResult[];

    if (this.enableHybridSearch) {
      // 桥接 topK → finalTopK：调用方传入的 RetrievalConfig.topK 映射到
      // Hybrid 模式的最终输出数量，避免 topK 在 Hybrid 模式下静默失效
      const hybridOptions: Partial<HybridRetrieverConfig> = { ...options };
      if (options?.topK !== undefined && options.finalTopK === undefined) {
        hybridOptions.finalTopK = options.topK;
      }
      // 使用混合检索
      results = await this.hybridRetriever.retrieve(agentId, query, hybridOptions);
      logger.trace('[RagService] Hybrid 检索结果数量:', results.length);
    } else {
      // 使用传统向量检索
      const embeddingRoute = embeddingService.getActiveRoute();
      const queryEmbedding = await embeddingService.encodeWithRoute(query, embeddingRoute, 'query');
      results = await this.vectorStore.search(
        agentId,
        queryEmbedding,
        options?.topK ?? 5,
        embeddingRoute.mode === 'custom' ? -1 : (options?.threshold ?? 0.4),
        undefined,
        embeddingRoute.profileId
      );
      logger.trace(
        '[RagService] Vector 检索结果数量:',
        results.length,
        '阈值:',
        options?.threshold ?? 0.4
      );
    }

    // 过滤掉记忆系统索引的数据（memory_fact_* / memory_summary_*）
    // 记忆数据由 MemoryContextProvider 独立注入到 Prompt，此处仅返回知识库文档
    const beforeFilter = results.length;
    results = results.filter((r) => !this.isMemoryVectorChunk(r));
    if (results.length < beforeFilter) {
      logger.trace(`[RagService] 已过滤 ${beforeFilter - results.length} 条记忆索引结果`);
    }

    return results;
  }

  /**
   * 检索并格式化为上下文字符串
   */
  async retrieveAndFormat(
    agentId: string,
    query: string,
    options?: Partial<RetrievalConfig & HybridRetrieverConfig>
  ): Promise<string> {
    const results = await this.retrieve(agentId, query, options);
    return this.contextProvider.format(results);
  }

  /**
   * 检索并格式化为 Markdown
   */
  async retrieveAndFormatMarkdown(
    agentId: string,
    query: string,
    options?: Partial<RetrievalConfig & HybridRetrieverConfig>
  ): Promise<string> {
    const results = await this.retrieve(agentId, query, options);
    return this.contextProvider.formatMarkdown(results);
  }

  /**
   * 删除文档索引
   *
   * @param agentId - Agent ID
   * @param documentId - 文档 ID
   */
  async deleteDocumentIndex(agentId: string, documentId: string): Promise<void> {
    logger.trace('[RagService] deleteDocumentIndex 开始:', { agentId, documentId });
    const writerLease = await ragIndexCoordinator.acquireWriter();
    try {
      const deletedCount = await this.vectorStore.deleteByDocument(agentId, documentId);

      // file_write / deliverable indexing 会在索引前幂等清理旧向量。
      // 新文件或首次索引时没有旧向量是正常情况，保留 trace 供深度排查即可。
      if (deletedCount === 0) {
        logger.trace('[RagService] deleteDocumentIndex 未找到旧向量数据:', {
          agentId,
          documentId,
        });
      }

      // 清除 BM25 索引中属于该文档的所有块
      getBM25Index().removeByDocumentId(agentId, documentId);
    } finally {
      writerLease.release();
    }
  }

  /**
   * 删除 Agent 的所有索引
   *
   * @param agentId - Agent ID
   */
  async deleteAgentIndex(agentId: string): Promise<void> {
    const writerLease = await ragIndexCoordinator.acquireWriter();
    try {
      await this.vectorStore.deleteByAgent(agentId);
      getBM25Index().clearAgent(agentId);
      this.bm25RebuildAttemptedAgents.delete(agentId);
    } finally {
      writerLease.release();
    }
  }

  /**
   * 获取索引状态
   */
  async getIndexStatus(agentId: string) {
    const vectorStatus = await this.vectorStore.getStatus(agentId);
    const bm25Stats = getBM25Index().getStats(agentId);

    return {
      ...vectorStatus,
      bm25DocumentCount: bm25Stats.documentCount,
      bm25TermCount: bm25Stats.termCount,
    };
  }

  /**
   * 诊断方法：列出 DB 中当前 Agent 的所有 document_id
   *
   * 用于删除后对比验证，确认向量数据是否真正被清除
   */
  async listIndexedDocumentIds(agentId: string): Promise<string[]> {
    return invoke<string[]>('rag_list_document_ids', { agentId });
  }

  /**
   * 获取内部组件（用于高级用法）
   */
  getComponents() {
    return {
      documentChunker: this.documentChunker,
      vectorStore: this.vectorStore,
      hybridRetriever: this.hybridRetriever,
      contextProvider: this.contextProvider,
    };
  }
}

// 单例实例
let ragServiceInstance: RagService | null = null;

/**
 * 获取 RagService 单例
 */
export function getRagService(config?: RagServiceConfig): RagService {
  ragServiceInstance ??= new RagService(config);
  return ragServiceInstance;
}

/**
 * 创建 RagService 实例
 * @deprecated 使用 getRagService() 获取单例
 */
export function createRagService(config?: RagServiceConfig): RagService {
  return getRagService(config);
}
