/**
 * VectorStore - 向量存储接口
 *
 * 封装 Tauri IPC 调用，提供向量存储和检索的前端接口。
 * 实际向量由 Rust 后端持久化到 SQLite，并在检索时执行 cosine 排序。
 */

import { invoke } from '@tauri-apps/api/core';
import type { Chunk, SearchResult, IndexStatus, ChunkMetadata } from '../../types';
import { LruCache } from './LruCache';
import { getLogger } from '@services/logger';
import { getActiveEmbeddingProfileId } from './RagConnectionConfig';

const logger = getLogger('VectorStore');

function parseChunkMetadata(serialized: string): ChunkMetadata {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ChunkMetadata)
      : {};
  } catch {
    return {};
  }
}

/** 向量插入参数（snake_case 匹配 Rust 后端） */
interface InsertParams {
  chunk_id: string;
  agent_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  metadata: string; // JSON 序列化的 ChunkMetadata
}

interface InsertResponse {
  id: string;
  success: boolean;
}

/** 搜索参数（snake_case 匹配 Rust 后端） */
interface SearchParams {
  agent_id: string;
  query_embedding: number[];
  top_k: number;
  threshold: number;
  /** 可选的 document_id 前缀过滤，用于隔离不同类型的向量条目 */
  document_id_prefix?: string;
  /** Only vectors produced by this semantic-space profile may participate. */
  expected_embedding_profile_id: string;
}

export interface ChunkEmbeddingUpdate {
  chunkId: string;
  embedding: number[];
  metadata: string;
}

interface PersistedChunkResponse {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: string;
  created_at: number;
}

/** Chunk 缓存最大条目数 —— 约覆盖 5-10 篇中等文档的全部 chunk */
const MAX_CHUNK_CACHE_SIZE = 2000;

/**
 * VectorStore 类
 *
 * 提供向量存储的 TypeScript 接口
 */
export class VectorStore {
  // Chunk 缓存：用于 BM25 检索后获取完整 Chunk 信息（LRU 淘汰策略）
  private chunkCache: LruCache<string, Chunk> = new LruCache(MAX_CHUNK_CACHE_SIZE);

  /**
   * 插入文档块及其向量
   *
   * @param chunk - 文档块
   * @param embedding - 向量表示
   */
  async insert(
    chunk: Chunk,
    embedding: number[],
    embeddingProfileId: string = getActiveEmbeddingProfileId()
  ): Promise<void> {
    const persistedChunk: Chunk = {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        embeddingProfileId,
        embeddingDimension: embedding.length,
      },
    };
    const params: InsertParams = {
      chunk_id: persistedChunk.id,
      agent_id: persistedChunk.agentId,
      document_id: persistedChunk.documentId,
      chunk_index: persistedChunk.chunkIndex,
      content: persistedChunk.content,
      embedding,
      metadata: JSON.stringify(persistedChunk.metadata),
    };

    const response = await invoke<InsertResponse>('rag_index_chunk', { params });
    if (response.id !== persistedChunk.id) {
      logger.warn('[VectorStore] Backend returned a different chunk id:', {
        frontendChunkId: persistedChunk.id,
        backendChunkId: response.id,
      });
    }

    // 缓存 chunk 用于 BM25 检索
    this.chunkCache.set(persistedChunk.id, persistedChunk);
  }

  /**
   * 根据 ID 获取缓存的 Chunk
   *
   * @param agentId - Agent ID (用于验证)
   * @param chunkId - Chunk ID
   * @returns Chunk 或 null
   */
  getChunkById(agentId: string, chunkId: string): Promise<Chunk | null> {
    const cached = this.chunkCache.get(chunkId);
    if (cached?.agentId === agentId) {
      return Promise.resolve(cached);
    }
    return Promise.resolve(null);
  }

  /**
   * 手动缓存 Chunk
   *
   * @param chunk - 要缓存的 Chunk
   */
  cacheChunk(chunk: Chunk): void {
    this.chunkCache.set(chunk.id, chunk);
  }

  /**
   * Return cached child chunks that belong to the same persisted parent.
   *
   * The cache is warmed by listChunks() during BM25 rebuild, and by insert()
   * during fresh indexing. This keeps parent-context restore local to the
   * renderer without adding another backend query.
   */
  getCachedChunksByParent(agentId: string, documentId: string, parentChunkId: string): Chunk[] {
    return this.chunkCache
      .values()
      .filter(
        (chunk) =>
          chunk.agentId === agentId &&
          chunk.documentId === documentId &&
          chunk.metadata.parentChunkId === parentChunkId &&
          !chunk.metadata.isParent &&
          !chunk.metadata.isDocumentOverview
      )
      .sort((a, b) => {
        if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
        return a.id.localeCompare(b.id);
      });
  }

  /**
   * List persisted chunks for an agent and warm the local chunk cache.
   *
   * Used to rebuild in-memory BM25 state after renderer/app restart.
   */
  async listChunks(agentId: string): Promise<Chunk[]> {
    const rows = await invoke<PersistedChunkResponse[]>('rag_list_chunks', { agentId });
    const chunks = rows.map((row) => {
      const chunk: Chunk = {
        id: row.chunk_id,
        agentId,
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        metadata: parseChunkMetadata(row.metadata),
        createdAt: row.created_at > 0 ? row.created_at * 1000 : Date.now(),
      };
      this.chunkCache.set(chunk.id, chunk);
      return chunk;
    });

    return chunks;
  }

  /**
   * 清除 Agent 的缓存
   */
  clearCache(agentId: string): void {
    this.chunkCache.deleteWhere((_key, chunk) => chunk.agentId === agentId);
  }

  /**
   * 批量插入文档块
   *
   * @param chunks - 文档块列表
   * @param embeddings - 对应的向量列表
   */
  async insertBatch(
    chunks: Chunk[],
    embeddings: number[][],
    embeddingProfileId: string = getActiveEmbeddingProfileId()
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error('chunks and embeddings count mismatch');
    }

    // 分批处理，每批最多 100 个
    const batchSize = 100;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batchChunks = chunks.slice(i, i + batchSize);
      const batchEmbeddings = embeddings.slice(i, i + batchSize);

      // 并行插入当前批次
      await Promise.all(
        batchChunks.map((chunk, idx) => {
          const embedding = batchEmbeddings[idx];
          if (!embedding) {
            throw new Error(`Missing embedding at index ${idx}`);
          }
          return this.insert(chunk, embedding, embeddingProfileId);
        })
      );
    }
  }

  /**
   * 向量相似度搜索
   *
   * @param agentId - Agent ID
   * @param queryEmbedding - 查询向量
   * @param topK - 返回结果数量
   * @param threshold - 相似度阈值
   * @returns 搜索结果列表
   */
  async search(
    agentId: string,
    queryEmbedding: number[],
    topK: number = 5,
    threshold: number = 0.7,
    documentIdPrefix?: string,
    expectedEmbeddingProfileId: string = getActiveEmbeddingProfileId()
  ): Promise<SearchResult[]> {
    // 使用 snake_case 匹配 Rust 后端的 SearchParams 结构
    const params: SearchParams = {
      agent_id: agentId,
      query_embedding: queryEmbedding,
      top_k: topK,
      threshold,
      document_id_prefix: documentIdPrefix,
      expected_embedding_profile_id: expectedEmbeddingProfileId,
    };

    const results = await invoke<
      Array<{
        chunk_id: string;
        document_id: string;
        content: string;
        metadata: string;
        score: number;
        distance: number;
      }>
    >('rag_search', { params });

    return results.map((r) => ({
      chunk: {
        id: r.chunk_id,
        agentId,
        documentId: r.document_id,
        chunkIndex: this.chunkCache.get(r.chunk_id)?.chunkIndex ?? 0,
        content: r.content,
        metadata: parseChunkMetadata(r.metadata),
        createdAt: Date.now(),
      },
      score: r.score,
      distance: r.distance,
    }));
  }

  /** List every Agent namespace that currently owns persisted vectors. */
  listVectorAgentIds(): Promise<string[]> {
    return invoke<string[]>('rag_list_vector_agent_ids');
  }

  /** Transactionally replace a set of vectors and their profile metadata for one Agent. */
  async batchUpdateChunkEmbeddings(
    agentId: string,
    updates: ChunkEmbeddingUpdate[]
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const updatedCount = await invoke<number>('rag_batch_update_chunk_embeddings', {
      agentId,
      updates,
    });

    for (const update of updates) {
      const cached = this.chunkCache.get(update.chunkId);
      if (cached?.agentId !== agentId) continue;
      this.chunkCache.set(update.chunkId, {
        ...cached,
        metadata: parseChunkMetadata(update.metadata),
      });
    }
    return updatedCount;
  }

  /**
   * 删除指定 Agent 的所有索引
   *
   * @param agentId - Agent ID
   */
  async deleteByAgent(agentId: string): Promise<void> {
    const count = await invoke<number>('rag_delete_by_agent', { agentId });
    // 同步清除内存缓存，保持数据一致性
    this.clearCache(agentId);
    logger.trace('[deleteByAgent] 完成:', { agentId, deletedCount: count });
  }

  /**
   * 删除指定文档的索引
   *
   * @param agentId - Agent ID
   * @param documentId - 文档 ID
   * @returns 实际删除的向量条目数
   */
  async deleteByDocument(agentId: string, documentId: string): Promise<number> {
    const count = await invoke<number>('rag_delete_by_document', { agentId, documentId });
    // 清除已删除文档的缓存条目
    const cacheEvicted = this.chunkCache.deleteWhere(
      (_key, chunk) => chunk.agentId === agentId && chunk.documentId === documentId
    );
    logger.trace('[deleteByDocument] 完成:', {
      agentId,
      documentId,
      sqlDeletedCount: count,
      cacheEvictedCount: cacheEvicted,
    });
    return count;
  }

  /**
   * 获取索引状态
   *
   * @param agentId - Agent ID
   * @returns 索引状态信息
   */
  async getStatus(agentId: string): Promise<IndexStatus> {
    const status = await invoke<{
      agent_id: string;
      document_count: number;
      chunk_count: number;
      last_updated_at?: number;
    }>('rag_get_status', { agentId });

    return {
      agentId: status.agent_id,
      documentCount: status.document_count,
      chunkCount: status.chunk_count,
      lastUpdatedAt: status.last_updated_at,
    };
  }
}

// 单例实例
let vectorStoreInstance: VectorStore | null = null;

/**
 * 获取 VectorStore 单例
 *
 * 确保所有模块共享同一个 chunkCache
 */
export function getVectorStore(): VectorStore {
  vectorStoreInstance ??= new VectorStore();
  return vectorStoreInstance;
}
