/**
 * MemoryVectorIndex - 记忆向量索引服务
 *
 * 统一封装事实/摘要的向量索引逻辑，复用 RAG 基础设施。
 *
 * 职责：
 * 1. 为事实和摘要创建向量索引
 * 2. 支持语义检索已索引的记忆
 * 3. 管理记忆向量的生命周期（删除/更新）
 *
 * documentId 命名规范：
 * - 事实：memory_fact_{factId}
 * - 摘要：memory_summary_{summaryId}
 */

import { embeddingService } from '../rag/EmbeddingService';
import { getVectorStore, VectorStore } from '../rag/VectorStore';
import type { Chunk, SearchResult } from '../../types';
import type { LongTermFactCategory } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('MemoryVectorIndex');

// ============================================================================
// 类型定义
// ============================================================================

/** 记忆类型 */
export type MemoryType = 'fact' | 'summary';

/** 记忆向量索引元数据 */
interface MemoryVectorMetadata {
  /** 记忆类型 */
  memoryType: MemoryType;
  /** 原始记忆 ID */
  memoryId: string;
  /** 事实类别（仅事实类型有值） */
  category?: LongTermFactCategory;
  /** 索引时间 */
  indexedAt: number;
}

/** 检索选项 */
export interface MemorySearchOptions {
  /** 返回数量，默认 5 */
  topK?: number;
  /** 相似度阈值，默认 0.35（摘要召回宾可多给不可遗漏，后续有 topK 截断） */
  threshold?: number;
  /** 过滤记忆类型 */
  memoryType?: MemoryType;
  /** 过滤事实类别 */
  category?: LongTermFactCategory;
}

/** 检索结果 */
export interface MemorySearchResult {
  /** 记忆 ID */
  memoryId: string;
  /** 记忆类型 */
  memoryType: MemoryType;
  /** 内容 */
  content: string;
  /** 相似度分数 */
  score: number;
  /** 事实类别（仅事实类型有值） */
  category?: LongTermFactCategory;
}

// ============================================================================
// 常量
// ============================================================================

/** 事实 documentId 前缀 */
const FACT_DOC_PREFIX = 'memory_fact_';

/** 摘要 documentId 前缀 */
const SUMMARY_DOC_PREFIX = 'memory_summary_';

// ============================================================================
// MemoryVectorIndex 类
// ============================================================================

/**
 * 记忆向量索引服务
 */
export class MemoryVectorIndex {
  private vectorStore: VectorStore;

  constructor() {
    this.vectorStore = getVectorStore();
  }

  /**
   * 为事实创建向量索引
   *
   * @param agentId - Agent ID
   * @param factId - 事实 ID
   * @param content - 事实内容
   * @param category - 事实类别
   */
  async indexFact(
    agentId: string,
    factId: string,
    content: string,
    category: LongTermFactCategory
  ): Promise<void> {
    const documentId = `${FACT_DOC_PREFIX}${factId}`;

    try {
      // 生成 Embedding
      const embedding = await embeddingService.encode(content);

      // 构建 Chunk
      const chunk: Chunk = {
        id: `${documentId}_0`,
        agentId,
        documentId,
        chunkIndex: 0,
        content,
        metadata: {
          memoryType: 'fact',
          memoryId: factId,
          category,
          indexedAt: Date.now(),
        },
        createdAt: Date.now(),
      };

      // 存入向量库
      await this.vectorStore.insert(chunk, embedding);

      logger.trace(`[MemoryVectorIndex]  已索引事实: ${factId} (${category})`);
    } catch (error) {
      logger.error(`[MemoryVectorIndex]  索引事实失败: ${factId}`, error);
      // 索引失败不阻塞主流程
    }
  }

  /**
   * 为摘要创建向量索引
   *
   * @param agentId - Agent ID
   * @param summaryId - 摘要 ID
   * @param content - 摘要内容
   */
  async indexSummary(agentId: string, summaryId: string, content: string): Promise<void> {
    const documentId = `${SUMMARY_DOC_PREFIX}${summaryId}`;

    try {
      // 先删除旧向量（upsert 语义），防止补索引或重复调用产生重复 chunk
      await this.vectorStore.deleteByDocument(agentId, documentId);

      // 生成 Embedding
      const embedding = await embeddingService.encode(content);

      // 构建 Chunk
      const chunk: Chunk = {
        id: `${documentId}_0`,
        agentId,
        documentId,
        chunkIndex: 0,
        content,
        metadata: {
          memoryType: 'summary',
          memoryId: summaryId,
          indexedAt: Date.now(),
        },
        createdAt: Date.now(),
      };

      // 存入向量库
      await this.vectorStore.insert(chunk, embedding);

      logger.trace(`[MemoryVectorIndex]  已索引摘要: ${summaryId}`);
    } catch (error) {
      logger.error(`[MemoryVectorIndex]  索引摘要失败: ${summaryId}`, error);
      // 重新抛出异常，让上层（saveSummary）能感知失败并加入重试队列
      throw error;
    }
  }

  /**
   * 删除事实向量索引
   *
   * @param agentId - Agent ID
   * @param factId - 事实 ID
   */
  async deleteFact(agentId: string, factId: string): Promise<void> {
    const documentId = `${FACT_DOC_PREFIX}${factId}`;

    try {
      await this.vectorStore.deleteByDocument(agentId, documentId);
      logger.trace(`[MemoryVectorIndex] 已删除事实索引: ${factId}`);
    } catch (error) {
      logger.warn(`[MemoryVectorIndex] 删除事实索引失败: ${factId}`, error);
    }
  }

  /**
   * 删除摘要向量索引
   *
   * @param agentId - Agent ID
   * @param summaryId - 摘要 ID
   */
  async deleteSummary(agentId: string, summaryId: string): Promise<void> {
    const documentId = `${SUMMARY_DOC_PREFIX}${summaryId}`;

    try {
      await this.vectorStore.deleteByDocument(agentId, documentId);
      logger.trace(`[MemoryVectorIndex] 已删除摘要索引: ${summaryId}`);
    } catch (error) {
      logger.warn(`[MemoryVectorIndex] 删除摘要索引失败: ${summaryId}`, error);
    }
  }

  /**
   * 语义检索相关记忆
   *
   * @param agentId - Agent ID
   * @param query - 查询文本
   * @param options - 检索选项
   * @returns 检索结果
   */
  async searchRelevant(
    agentId: string,
    query: string,
    options: MemorySearchOptions = {}
  ): Promise<MemorySearchResult[]> {
    const { topK = 5, threshold = 0.35 } = options;

    logger.trace(`[MemoryVectorIndex]  开始语义检索:`, {
      agentId: agentId.substring(0, 8) + '...',
      query: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
      threshold,
      topK,
      memoryType: options.memoryType,
    });

    try {
      // 生成查询向量
      const queryEmbedding = await embeddingService.encode(query);

      // 根据记忆类型构建 document_id 前缀，在 Rust 层精确过滤
      // 避免摘要、事实孤儿向量、知识库文档互相干扰
      const prefixMap: Record<MemoryType, string> = {
        summary: SUMMARY_DOC_PREFIX,
        fact: FACT_DOC_PREFIX,
      };
      const documentIdPrefix = options.memoryType ? prefixMap[options.memoryType] : undefined;

      // 执行向量检索（Rust 层已按 document_id 前缀过滤，topK*2 留余量即可）
      const results = await this.vectorStore.search(
        agentId,
        queryEmbedding,
        topK * 2,
        threshold,
        documentIdPrefix
      );

      logger.trace(
        `[MemoryVectorIndex]  原始检索结果: ${results.length} 条`,
        results.length > 0 ? { scores: results.map((r) => r.score.toFixed(3)) } : ''
      );

      // 过滤和转换结果
      const filtered = this.filterAndTransform(results, options);

      logger.trace(
        `[MemoryVectorIndex]  过滤后结果: ${filtered.length} 条`,
        filtered.length > 0 ? { memoryIds: filtered.map((r) => r.memoryId.substring(0, 8)) } : ''
      );

      // 限制返回数量
      return filtered.slice(0, topK);
    } catch (error) {
      logger.error('[MemoryVectorIndex] 语义检索失败:', error);
      return [];
    }
  }

  /**
   * 过滤和转换检索结果
   */
  private filterAndTransform(
    results: SearchResult[],
    options: MemorySearchOptions
  ): MemorySearchResult[] {
    const transformed: MemorySearchResult[] = [];
    let skippedNonMemory = 0;
    let skippedTypeMismatch = 0;

    for (const result of results) {
      const metadata = result.chunk.metadata as unknown as Partial<MemoryVectorMetadata>;

      // 跳过非记忆类型的结果（如知识库文档）
      if (!metadata.memoryType || !metadata.memoryId) {
        skippedNonMemory++;
        continue;
      }

      // 按记忆类型过滤
      if (options.memoryType && metadata.memoryType !== options.memoryType) {
        skippedTypeMismatch++;
        continue;
      }

      // 按类别过滤（仅事实）
      if (options.category && metadata.category !== options.category) {
        continue;
      }

      transformed.push({
        memoryId: metadata.memoryId,
        memoryType: metadata.memoryType,
        content: result.chunk.content,
        score: result.score,
        category: metadata.category,
      });
    }

    // 诊断日志：当有结果被过滤时记录原因
    if (skippedNonMemory > 0 || skippedTypeMismatch > 0) {
      logger.trace(
        `[MemoryVectorIndex] 过滤详情: 跳过非记忆=${skippedNonMemory}, 类型不匹配=${skippedTypeMismatch}, 保留=${transformed.length}`
      );
    }

    // 按分数降序排序
    transformed.sort((a, b) => b.score - a.score);

    return transformed;
  }
}

// ============================================================================
// 导出
// ============================================================================

/** 全局单例 */
let memoryVectorIndexInstance: MemoryVectorIndex | null = null;

/**
 * 获取 MemoryVectorIndex 单例
 */
export function getMemoryVectorIndex(): MemoryVectorIndex {
  memoryVectorIndexInstance ??= new MemoryVectorIndex();
  return memoryVectorIndexInstance;
}

/**
 * 创建新的 MemoryVectorIndex 实例
 *
 * 通常应使用 getMemoryVectorIndex() 单例
 */
export function createMemoryVectorIndex(): MemoryVectorIndex {
  return new MemoryVectorIndex();
}
