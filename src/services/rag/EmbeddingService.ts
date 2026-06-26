/**
 * EmbeddingService - 统一 Embedding 服务
 *
 * 整合原 memory/EmbeddingAdapter 功能，作为全局唯一的 Embedding 服务。
 * 
 * 功能：
 * 1. 文本向量化（单条/批量）
 * 2. 余弦相似度计算
 * 3. 语义相似性判断
 * 4. 内存缓存（避免重复 API 请求）
 * 
 * 后端实现：SiliconFlow BAAI/bge-m3 (1024 维，免费，8K 上下文)
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import { LruCache } from './LruCache';

const logger = getLogger('EmbeddingService');

// ============================================================================
// 配置常量
// ============================================================================

/** 语义相似度阈值 - 超过此值视为相似（0.75 适合中文长句匹配） */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.75;

/** 默认 Embedding Provider */
const DEFAULT_PROVIDER = 'siliconflow';

/** 默认 Embedding 模型 */
const DEFAULT_MODEL = 'BAAI/bge-m3';

/** Fallback Embedding Provider（SiliconFlow 不可用时自动降级） */
const FALLBACK_PROVIDER = 'giteeai';

/** Fallback Embedding 模型（Gitee AI 的 bge-m3 模型名不带 BAAI/ 前缀） */
const FALLBACK_MODEL = 'bge-m3';

/** Embedding 缓存最大条目数 —— 每条约 8KB (1024 维 float64) */
const MAX_EMBEDDING_CACHE_SIZE = 1000;

/** 每批最大文本数量 —— 避免超出 Embedding API 单次请求限制 */
const EMBEDDING_BATCH_SIZE = 25;

/**
 * Embedding API 单次调用超时时间（毫秒）
 *
 * 网络断开时 Tauri invoke 会等待系统 TCP 超时（可能长达数分钟），
 * 此值强制在 15s 内失败，使上层能及时降级，避免阻塞整个消息流程。
 */
const EMBEDDING_TIMEOUT_MS = 15_000;

// ============================================================================
// 类型定义
// ============================================================================

/** 云端 Embedding 响应 */
interface CloudEmbeddingResponse {
    /** 编码后的向量列表 */
    embeddings: number[][];
    /** 向量维度 */
    dimension: number;
    /** 使用的模型 */
    model: string;
}

/** Embedding 服务接口 */
export interface IEmbeddingService {
    /** 将单个文本转换为向量 */
    encode(text: string): Promise<number[]>;
    /** 批量向量化 */
    encodeBatch(texts: string[]): Promise<number[][]>;
    /** 计算余弦相似度 */
    cosineSimilarity(a: number[], b: number[]): number;
    /** 判断两段文本是否语义相似 */
    isSemanticallySimilar(textA: string, textB: string, threshold?: number): Promise<boolean>;
    /** 清空缓存 */
    clearCache(): void;
    /** 获取缓存大小 */
    getCacheSize(): number;
}

// ============================================================================
// 统一 Embedding 服务类
// ============================================================================

/**
 * 统一 Embedding 服务
 * 
 * 使用 cloud_embedding_encode 后端命令，调用 SiliconFlow BAAI/bge-m3 API
 */
export class EmbeddingService implements IEmbeddingService {
    /** Embedding 缓存（LRU 淘汰，避免无限增长） */
    private cache = new LruCache<string, number[]>(MAX_EMBEDDING_CACHE_SIZE);

    /** 当前处于激活状态的 Provider（用于在批量处理中锁定 fallback 状态） */
    private activeProvider = DEFAULT_PROVIDER;
    private activeModel = DEFAULT_MODEL;

    /**
     * 带超时和 fallback 的 Embedding API 调用
     *
     * 优先调用 SiliconFlow，失败后自动降级到 Gitee AI（若已配置 API Key）。
     * 两者使用相同的 bge-m3 模型（1024 维），向量完全兼容。
     * 使用 Promise.race 在指定时间内强制失败，避免网络断开时
     * Tauri invoke 永久 pending 阻塞上层调用链。
     *
     * @param texts - 要编码的文本列表
     * @param timeoutMs - 超时毫秒数，默认 EMBEDDING_TIMEOUT_MS
     * @returns CloudEmbeddingResponse
     */
    private async encodeWithTimeout(
        texts: string[],
        timeoutMs: number = EMBEDDING_TIMEOUT_MS
    ): Promise<CloudEmbeddingResponse> {
        // 如果当前已经降级，直接使用 fallback
        if (this.activeProvider === FALLBACK_PROVIDER) {
            return await this.callEmbeddingApi(this.activeProvider, this.activeModel, texts, timeoutMs);
        }

        // 尝试主提供商
        try {
            return await this.callEmbeddingApi(this.activeProvider, this.activeModel, texts, timeoutMs);
        } catch (primaryError) {
            logger.warn(
                `[EmbeddingService] 主提供商 ${this.activeProvider} 失败，尝试 fallback: ${String(primaryError)}`
            );

            // 检查 fallback 提供商是否已配置 API Key
            try {
                const hasFallbackKey = await invoke<boolean>('get_giteeai_api_key_status');
                if (!hasFallbackKey) {
                    // Fallback 未配置，抛出原始错误
                    throw primaryError;
                }

                logger.info(`[EmbeddingService] 降级到 fallback 提供商: ${FALLBACK_PROVIDER}，并在本次批处理中保持`);
                
                // 切换激活状态，避免后续批次重复重试失败的主提供商
                this.activeProvider = FALLBACK_PROVIDER;
                this.activeModel = FALLBACK_MODEL;
                
                return await this.callEmbeddingApi(this.activeProvider, this.activeModel, texts, timeoutMs);
            } catch (fallbackError) {
                // Fallback 也失败，报告两个错误信息便于调试
                logger.error(
                    `[EmbeddingService] Fallback 提供商 ${FALLBACK_PROVIDER} 也失败: ${String(fallbackError)}`
                );
                throw primaryError;
            }
        }
    }

    /**
     * 调用单个 Embedding 提供商的 API（带超时保护）
     */
    private callEmbeddingApi(
        provider: string,
        model: string,
        texts: string[],
        timeoutMs: number
    ): Promise<CloudEmbeddingResponse> {
        const apiCall = invoke<CloudEmbeddingResponse>('cloud_embedding_encode', {
            request: { provider, model, texts },
        });

        // 超时 Promise：到期后以明确错误 reject，使上层 catch 能区分超时 vs 其他错误
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(
                    `Embedding API request timed out (>${timeoutMs}ms, provider: ${provider}). ` +
                    'Check the network connection or embedding service configuration.'
                ));
            }, timeoutMs);
        });

        return Promise.race([apiCall, timeoutPromise]);
    }

    /**
     * 获取单个文本的 Embedding 向量
     * 
     * @param text - 要编码的文本
     * @returns Embedding 向量 (1024 维)
     */
    async encode(text: string): Promise<number[]> {
        // 每次独立调用重置状态
        this.activeProvider = DEFAULT_PROVIDER;
        this.activeModel = DEFAULT_MODEL;

        // 先检查缓存
        const cached = this.cache.get(text);
        if (cached) {
            return cached;
        }

        try {
            // 使用超时包装防止网络断开时永久阻塞
            const response = await this.encodeWithTimeout([text]);

            const embedding = response.embeddings[0] ?? [];

            // 存入缓存
            this.cache.set(text, embedding);

            return embedding;
        } catch (error) {
            logger.error('[EmbeddingService] 获取 Embedding 失败:', error);
            throw error;
        }
    }

    /**
     * 批量获取文本的 Embedding 向量
     * 
     * @param texts - 要编码的文本列表
     * @returns Embedding 向量列表
     */
    async encodeBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        // 每次批处理开始前重置状态，允许从之前的降级中恢复
        this.activeProvider = DEFAULT_PROVIDER;
        this.activeModel = DEFAULT_MODEL;

        // 分离已缓存和未缓存的文本
        const results: number[][] = Array<number[]>(texts.length);
        const uncachedTexts: string[] = [];
        const uncachedIndices: number[] = [];

        for (let i = 0; i < texts.length; i++) {
            const text = texts[i];
            if (text === undefined) continue;
            const cached = this.cache.get(text);
            if (cached) {
                results[i] = cached;
            } else {
                uncachedTexts.push(text);
                uncachedIndices.push(i);
            }
        }

        // 如果有未缓存的，调用 API
        if (uncachedTexts.length > 0) {
            try {
                // 按 EMBEDDING_BATCH_SIZE 分批调用 API，避免超出单次请求限制
                // 每批使用超时包装，防止网络断开时永久阻塞
                for (let batchStart = 0; batchStart < uncachedTexts.length; batchStart += EMBEDDING_BATCH_SIZE) {
                    const batchTexts = uncachedTexts.slice(batchStart, batchStart + EMBEDDING_BATCH_SIZE);

                    const response = await this.encodeWithTimeout(batchTexts);

                    // 填充结果并更新缓存
                    for (let i = 0; i < batchTexts.length; i++) {
                        const globalIndex = batchStart + i;
                        const text = uncachedTexts[globalIndex];
                        const resultIndex = uncachedIndices[globalIndex];
                        if (text === undefined || resultIndex === undefined) continue;
                        const embedding = response.embeddings[i] ?? [];

                        results[resultIndex] = embedding;
                        this.cache.set(text, embedding);
                    }
                }
            } catch (error) {
                logger.error('[EmbeddingService] 批量获取 Embedding 失败:', error);
                throw error;
            }
        }

        return results;
    }

    /**
     * 计算两个向量的 Cosine 相似度
     * 
     * @param a - 向量 A
     * @param b - 向量 B
     * @returns 相似度 (0-1)
     */
    cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length || a.length === 0) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            const valA = a[i] ?? 0;
            const valB = b[i] ?? 0;
            dotProduct += valA * valB;
            normA += valA * valA;
            normB += valB * valB;
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    /**
     * 判断两段文本是否语义相似
     * 
     * @param textA - 文本 A
     * @param textB - 文本 B
     * @param threshold - 相似度阈值，默认 0.75
     * @returns 是否相似
     */
    async isSemanticallySimilar(
        textA: string,
        textB: string,
        threshold: number = SEMANTIC_SIMILARITY_THRESHOLD
    ): Promise<boolean> {
        try {
            const [embeddingA, embeddingB] = await Promise.all([
                this.encode(textA),
                this.encode(textB),
            ]);

            const similarity = this.cosineSimilarity(embeddingA, embeddingB);
            logger.trace(`[EmbeddingService] 相似度: ${similarity.toFixed(3)} (阈值: ${threshold})`);

            return similarity >= threshold;
        } catch (error) {
            logger.warn('[EmbeddingService] 语义相似度判断失败，降级为 false:', error);
            return false;
        }
    }

    /**
     * 清空 Embedding 缓存
     * 
     * 用于测试或内存管理
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * 获取缓存大小
     */
    getCacheSize(): number {
        return this.cache.size;
    }
}

// ============================================================================
// 单例导出
// ============================================================================

/** 全局单例实例 */
export const embeddingService = new EmbeddingService();

/**
 * 创建 EmbeddingService 实例
 * 
 * 通常应使用 embeddingService 单例，仅在需要独立缓存时创建新实例
 */
export function createEmbeddingService(): EmbeddingService {
    return new EmbeddingService();
}

// ============================================================================
// 便捷函数导出（向后兼容 memory/EmbeddingAdapter）
// ============================================================================

/**
 * 获取文本的 Embedding 向量
 * @deprecated 建议直接使用 embeddingService.encode()
 */
export async function getEmbedding(text: string): Promise<number[]> {
    return embeddingService.encode(text);
}

/**
 * 批量获取文本的 Embedding 向量
 * @deprecated 建议直接使用 embeddingService.encodeBatch()
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
    return embeddingService.encodeBatch(texts);
}

/**
 * 计算 Cosine 相似度
 * @deprecated 建议直接使用 embeddingService.cosineSimilarity()
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    return embeddingService.cosineSimilarity(a, b);
}

/**
 * 判断两段文本是否语义相似
 * @deprecated 建议直接使用 embeddingService.isSemanticallySimilar()
 */
export async function isSemanticallySimilar(textA: string, textB: string): Promise<boolean> {
    return embeddingService.isSemanticallySimilar(textA, textB);
}

/**
 * 清空 Embedding 缓存
 * @deprecated 建议直接使用 embeddingService.clearCache()
 */
export function clearEmbeddingCache(): void {
    embeddingService.clearCache();
}

/**
 * 获取缓存大小
 * @deprecated 建议直接使用 embeddingService.getCacheSize()
 */
export function getEmbeddingCacheSize(): number {
    return embeddingService.getCacheSize();
}
