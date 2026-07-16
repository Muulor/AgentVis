/**
 * RerankService - route-aware second-stage RAG ranking.
 *
 * Built-in mode uses SiliconFlow. Custom mode supports explicit Jina/Cohere
 * and Voyage profiles, or can disable reranking entirely.
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import {
  resolveRagRerankerRoute,
  SILICONFLOW_RERANKER_MODEL,
  type ResolvedRerankerRoute,
} from './RagConnectionConfig';

const logger = getLogger('RerankService');
/** Renderer IPC fallback; Rust enforces the actual 15-second network timeout. */
const RERANK_TIMEOUT_MS = 18_000;

export { SILICONFLOW_RERANKER_MODEL as SILICONFLOW_RERANK_MODEL };

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

type InvokeFunction = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface RerankConnectionTestResult {
  resultCount: number;
  model: string;
  latencyMs: number;
}

export interface RerankServiceOptions {
  timeoutMs?: number;
  routeResolver?: () => ResolvedRerankerRoute;
  invokeFn?: InvokeFunction;
}

export class RerankService {
  private readonly timeoutMs: number;
  private readonly routeResolver: () => ResolvedRerankerRoute;
  private readonly invokeFn: InvokeFunction;

  constructor(options: RerankServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS;
    this.routeResolver = options.routeResolver ?? resolveRagRerankerRoute;
    this.invokeFn = options.invokeFn ?? (invoke as InvokeFunction);
  }

  getActiveRoute(): ResolvedRerankerRoute {
    return this.routeResolver();
  }

  isEnabled(): boolean {
    return this.getActiveRoute().enabled;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number = candidates.length
  ): Promise<RerankResult[]> {
    const route = this.getActiveRoute();
    return this.rerankWithRoute(query, candidates, topN, route);
  }

  async rerankWithRoute(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
    route: ResolvedRerankerRoute
  ): Promise<RerankResult[]> {
    if (!route.enabled || !query.trim() || candidates.length === 0 || topN <= 0) {
      return [];
    }
    this.assertUsableRoute(route);

    const documents = candidates.map((candidate) => candidate.text);
    const response = await this.callRerankApi(
      route,
      query,
      documents,
      Math.min(topN, candidates.length),
      'rerank'
    );
    return this.mapResults(response, candidates);
  }

  async testConnection(route: ResolvedRerankerRoute): Promise<RerankConnectionTestResult> {
    this.assertUsableRoute({ ...route, enabled: true });
    const startedAt = performance.now();
    const response = await this.callRerankApi(
      { ...route, enabled: true },
      'AgentVis',
      ['AgentVis desktop agent application', 'Unrelated weather forecast'],
      2,
      'test'
    );
    const candidates: RerankCandidate[] = [
      { id: 'relevant', text: '' },
      { id: 'unrelated', text: '' },
    ];
    const results = this.mapResults(response, candidates);
    if (results.length === 0) throw new Error('RAG_RERANK_RESULT_INVALID');
    return {
      resultCount: results.length,
      model: response.model,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  private async callRerankApi(
    route: ResolvedRerankerRoute,
    query: string,
    documents: string[],
    topN: number,
    purpose: 'rerank' | 'test'
  ): Promise<CloudRerankResponse> {
    const request = {
      provider: route.provider,
      model: route.modelId,
      query,
      documents,
      topN,
      endpointUrl: route.endpointUrl,
      protocol: route.protocol,
      authMode: route.authMode,
      purpose,
    };
    logger.trace('[RerankService] Calling reranker:', {
      provider: route.provider,
      protocol: route.protocol,
      model: route.modelId,
      candidateCount: documents.length,
      topN,
    });

    const apiCall = this.invokeFn('cloud_rerank_documents', {
      request,
    }) as Promise<CloudRerankResponse>;
    return this.withTimeout(apiCall, route.provider);
  }

  private mapResults(response: CloudRerankResponse, candidates: RerankCandidate[]): RerankResult[] {
    const seen = new Set<number>();
    return response.results
      .filter((result) => {
        if (
          !Number.isInteger(result.index) ||
          result.index < 0 ||
          result.index >= candidates.length ||
          !Number.isFinite(result.relevance_score) ||
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

  private async withTimeout<T>(promise: Promise<T>, provider: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`RAG_RERANK_TIMEOUT:${provider}:${this.timeoutMs}`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private assertUsableRoute(route: ResolvedRerankerRoute): void {
    if (!route.modelId) throw new Error('RAG_RERANK_ROUTE_INVALID');
    if (route.provider === 'custom' && !route.endpointUrl) {
      throw new Error('RAG_CUSTOM_RERANKER_CONFIG_INVALID');
    }
  }
}

export const rerankService = new RerankService();
