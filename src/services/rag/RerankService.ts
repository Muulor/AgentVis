/**
 * RerankService - SiliconFlow 重排序服务
 *
 * 复用 SiliconFlow API Key 调用 bge-reranker-v2-m3，对 RAG 候选片段做二阶段排序。
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('RerankService');

const DEFAULT_PROVIDER = 'siliconflow';
export const SILICONFLOW_RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
const RERANK_TIMEOUT_MS = 15_000;

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  index: number;
  score: number;
}

interface CloudRerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
  model: string;
}

interface RerankServiceOptions {
  timeoutMs?: number;
}

/**
 * SiliconFlow Rerank 服务
 */
export class RerankService {
  private timeoutMs: number;

  constructor(options: RerankServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number = candidates.length
  ): Promise<RerankResult[]> {
    if (!query.trim() || candidates.length === 0 || topN <= 0) {
      return [];
    }

    const documents = candidates.map((candidate) => candidate.text);
    const response = await this.callRerankApi(query, documents, Math.min(topN, candidates.length));
    const seen = new Set<number>();

    return response.results
      .filter((result) => {
        if (
          !Number.isFinite(result.index) ||
          result.index < 0 ||
          result.index >= candidates.length ||
          seen.has(result.index)
        ) {
          return false;
        }

        seen.add(result.index);
        return true;
      })
      .map((result) => ({
        id: candidates[result.index]?.id ?? '',
        index: result.index,
        score: result.relevance_score,
      }))
      .filter((result) => result.id)
      .sort((a, b) => b.score - a.score);
  }

  private callRerankApi(
    query: string,
    documents: string[],
    topN: number
  ): Promise<CloudRerankResponse> {
    const apiCall = invoke<CloudRerankResponse>('cloud_rerank_documents', {
      request: {
        provider: DEFAULT_PROVIDER,
        model: SILICONFLOW_RERANK_MODEL,
        query,
        documents,
        topN,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Rerank API request timed out (>${this.timeoutMs}ms, provider: ${DEFAULT_PROVIDER}).`
          )
        );
      }, this.timeoutMs);
    });

    logger.trace('[RerankService] 调用 SiliconFlow rerank:', {
      model: SILICONFLOW_RERANK_MODEL,
      candidateCount: documents.length,
      topN,
    });

    return Promise.race([apiCall, timeoutPromise]);
  }
}

export const rerankService = new RerankService();
