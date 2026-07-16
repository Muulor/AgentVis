/**
 * EmbeddingService - profile-aware RAG embedding client.
 *
 * A top-level encode call resolves one immutable route snapshot. Cache entries
 * are isolated by embedding profile and purpose, so switching providers or
 * models can never reuse vectors from another semantic space.
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import type { EmbeddingPurpose } from '@/types/rag';
import {
  resolveRagEmbeddingRoute,
  subscribeToEmbeddingProfileChanges,
  type ResolvedEmbeddingRoute,
} from './RagConnectionConfig';
import { LruCache } from './LruCache';

const logger = getLogger('EmbeddingService');

export const SEMANTIC_SIMILARITY_THRESHOLD = 0.75;
const MAX_EMBEDDING_CACHE_SIZE = 1000;
const EMBEDDING_BATCH_SIZE = 25;
/** Renderer IPC fallback; Rust enforces the actual 15-second network timeout. */
const EMBEDDING_TIMEOUT_MS = 18_000;
/** Conservative request spacing, not a claim about any Gemini account quota. */
const GEMINI_REQUEST_INTERVAL_MS = 1_000;
const GEMINI_MAX_RETRIES = 5;
const GEMINI_RETRY_BASE_DELAY_MS = 2_000;
const GEMINI_RETRY_MAX_DELAY_MS = 30_000;
const OPENAI_COMPATIBLE_REQUEST_INTERVAL_MS = 0;
const OPENAI_COMPATIBLE_MAX_RETRIES = 6;
const OPENAI_COMPATIBLE_RETRY_BASE_DELAY_MS = 2_000;
const OPENAI_COMPATIBLE_RETRY_MAX_DELAY_MS = 60_000;
/** A custom endpoint cannot force the renderer to sleep indefinitely. */
const MAX_SERVER_RETRY_AFTER_MS = 120_000;
const RETRYABLE_EMBEDDING_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface CloudEmbeddingResponse {
  embeddings: number[][];
  dimension: number;
  model: string;
}

type InvokeFunction = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type SafeEmbeddingFailureCategory =
  | 'rate_limit'
  | 'timeout'
  | 'transient'
  | 'client'
  | 'other';

export interface SafeEmbeddingFailure {
  category: SafeEmbeddingFailureCategory;
  code: string;
  httpStatus?: number;
  retryAfterMs?: number;
  retryable: boolean;
}

/**
 * Error exposed outside the provider retry boundary.
 *
 * It intentionally retains only a stable code/status and never the provider
 * response body, request text, endpoint, or credential.
 */
export class EmbeddingRequestError extends Error {
  readonly protocol: ResolvedEmbeddingRoute['protocol'];
  readonly code: string;
  readonly category: SafeEmbeddingFailureCategory;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly attemptCount: number;

  constructor(
    protocol: ResolvedEmbeddingRoute['protocol'],
    failure: SafeEmbeddingFailure,
    attemptCount: number
  ) {
    super(`RAG_EMBEDDING_${protocol.toUpperCase()}_${failure.code}`);
    this.name = 'EmbeddingRequestError';
    this.protocol = protocol;
    this.code = failure.code;
    this.category = failure.category;
    this.httpStatus = failure.httpStatus;
    this.retryAfterMs = failure.retryAfterMs;
    this.retryable = failure.retryable;
    this.attemptCount = attemptCount;
  }
}

/** Return a safe, body-free classification for renderer logs and UI mapping. */
export function classifyEmbeddingError(error: unknown): SafeEmbeddingFailure {
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 6 && current !== undefined; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    const failure = classifySingleEmbeddingError(current);
    if (failure.code !== 'OTHER') return failure;

    if (!(current instanceof Error) || !('cause' in current)) break;
    current = (current as Error & { cause?: unknown }).cause;
  }

  return { category: 'other', code: 'OTHER', retryable: false };
}

function classifySingleEmbeddingError(error: unknown): SafeEmbeddingFailure {
  if (error instanceof EmbeddingRequestError) {
    return {
      category: error.category,
      code: error.code,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
      retryable: error.retryable,
    };
  }

  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const statusMatch = /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (statusMatch?.[1]) {
    const httpStatus = Number(statusMatch[1]);
    const retryable = RETRYABLE_EMBEDDING_HTTP_STATUSES.has(httpStatus);
    const retryAfterMatch = /\bretry-after-ms\s*[=:]\s*(\d+)\b/i.exec(message);
    const rawRetryAfterMs = retryAfterMatch?.[1] ? Number(retryAfterMatch[1]) : undefined;
    const retryAfterMs =
      rawRetryAfterMs !== undefined && Number.isFinite(rawRetryAfterMs)
        ? Math.min(MAX_SERVER_RETRY_AFTER_MS, Math.max(0, Math.round(rawRetryAfterMs)))
        : undefined;
    return {
      category:
        httpStatus === 429
          ? 'rate_limit'
          : retryable
            ? 'transient'
            : httpStatus >= 400 && httpStatus < 500
              ? 'client'
              : 'other',
      code: `HTTP_${httpStatus}`,
      httpStatus,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      retryable,
    };
  }

  if (/RAG_EMBEDDING_TIMEOUT|\btimeout\b|timed out/i.test(message)) {
    return { category: 'timeout', code: 'TIMEOUT', retryable: true };
  }
  if (/failed \((?:connect|request|read)\)/i.test(message)) {
    return { category: 'transient', code: 'TRANSIENT_NETWORK', retryable: true };
  }
  return { category: 'other', code: 'OTHER', retryable: false };
}

export interface EmbeddingConnectionTestResult {
  dimension: number;
  model: string;
  latencyMs: number;
}

export interface EmbeddingServiceOptions {
  timeoutMs?: number;
  routeResolver?: () => ResolvedEmbeddingRoute;
  invokeFn?: InvokeFunction;
  geminiRequestIntervalMs?: number;
  geminiMaxRetries?: number;
  geminiRetryBaseDelayMs?: number;
  geminiRetryMaxDelayMs?: number;
  openAiRequestIntervalMs?: number;
  openAiMaxRetries?: number;
  openAiRetryBaseDelayMs?: number;
  openAiRetryMaxDelayMs?: number;
  randomFn?: () => number;
}

interface EmbeddingRequestLane {
  queue: Promise<void>;
  nextRequestAt: number;
}

export interface IEmbeddingService {
  encode(text: string, purpose?: EmbeddingPurpose): Promise<number[]>;
  encodeBatch(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
  getActiveProfileId(): string;
  cosineSimilarity(a: number[], b: number[]): number;
  isSemanticallySimilar(textA: string, textB: string, threshold?: number): Promise<boolean>;
  clearCache(): void;
  getCacheSize(): number;
}

export class EmbeddingService implements IEmbeddingService {
  private readonly cache = new LruCache<string, number[]>(MAX_EMBEDDING_CACHE_SIZE);
  private readonly timeoutMs: number;
  private readonly routeResolver: () => ResolvedEmbeddingRoute;
  private readonly invokeFn: InvokeFunction;
  private readonly geminiRequestIntervalMs: number;
  private readonly geminiMaxRetries: number;
  private readonly geminiRetryBaseDelayMs: number;
  private readonly geminiRetryMaxDelayMs: number;
  private readonly openAiRequestIntervalMs: number;
  private readonly openAiMaxRetries: number;
  private readonly openAiRetryBaseDelayMs: number;
  private readonly openAiRetryMaxDelayMs: number;
  private readonly randomFn: () => number;
  private readonly requestLanes = new Map<string, EmbeddingRequestLane>();

  constructor(options: EmbeddingServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS;
    this.routeResolver = options.routeResolver ?? resolveRagEmbeddingRoute;
    this.invokeFn = options.invokeFn ?? (invoke as InvokeFunction);
    this.geminiRequestIntervalMs = Math.max(
      0,
      options.geminiRequestIntervalMs ?? GEMINI_REQUEST_INTERVAL_MS
    );
    this.geminiMaxRetries = Math.max(0, options.geminiMaxRetries ?? GEMINI_MAX_RETRIES);
    this.geminiRetryBaseDelayMs = Math.max(
      0,
      options.geminiRetryBaseDelayMs ?? GEMINI_RETRY_BASE_DELAY_MS
    );
    this.geminiRetryMaxDelayMs = Math.max(
      this.geminiRetryBaseDelayMs,
      options.geminiRetryMaxDelayMs ?? GEMINI_RETRY_MAX_DELAY_MS
    );
    this.openAiRequestIntervalMs = Math.max(
      0,
      options.openAiRequestIntervalMs ?? OPENAI_COMPATIBLE_REQUEST_INTERVAL_MS
    );
    this.openAiMaxRetries = Math.max(0, options.openAiMaxRetries ?? OPENAI_COMPATIBLE_MAX_RETRIES);
    this.openAiRetryBaseDelayMs = Math.max(
      0,
      options.openAiRetryBaseDelayMs ?? OPENAI_COMPATIBLE_RETRY_BASE_DELAY_MS
    );
    this.openAiRetryMaxDelayMs = Math.max(
      this.openAiRetryBaseDelayMs,
      options.openAiRetryMaxDelayMs ?? OPENAI_COMPATIBLE_RETRY_MAX_DELAY_MS
    );
    this.randomFn = options.randomFn ?? Math.random;
  }

  getActiveRoute(): ResolvedEmbeddingRoute {
    return this.routeResolver();
  }

  getActiveProfileId(): string {
    return this.getActiveRoute().profileId;
  }

  async encode(text: string, purpose: EmbeddingPurpose = 'generic'): Promise<number[]> {
    const route = this.getActiveRoute();
    return this.encodeWithRoute(text, route, purpose);
  }

  async encodeWithRoute(
    text: string,
    route: ResolvedEmbeddingRoute,
    purpose: EmbeddingPurpose = 'generic',
    signal?: AbortSignal
  ): Promise<number[]> {
    const [embedding] = await this.encodeBatchWithRoute([text], route, purpose, signal);
    return embedding ?? [];
  }

  async encodeBatch(texts: string[], purpose: EmbeddingPurpose = 'generic'): Promise<number[][]> {
    const route = this.getActiveRoute();
    return this.encodeBatchWithRoute(texts, route, purpose);
  }

  async encodeBatchWithRoute(
    texts: string[],
    route: ResolvedEmbeddingRoute,
    purpose: EmbeddingPurpose = 'generic',
    signal?: AbortSignal
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.assertUsableRoute(route);

    const results: number[][] = Array<number[]>(texts.length);
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let index = 0; index < texts.length; index++) {
      const value = texts[index];
      if (value === undefined) continue;
      const cacheKey = this.buildCacheKey(route.profileId, purpose, value);
      const cached = purpose === 'test' ? undefined : this.cache.get(cacheKey);
      if (cached) {
        results[index] = cached;
      } else {
        uncachedTexts.push(value);
        uncachedIndices.push(index);
      }
    }

    try {
      for (
        let batchStart = 0;
        batchStart < uncachedTexts.length;
        batchStart += EMBEDDING_BATCH_SIZE
      ) {
        const batchTexts = uncachedTexts.slice(batchStart, batchStart + EMBEDDING_BATCH_SIZE);
        const response = await this.callEmbeddingApiWithAdaptiveBatching(
          route,
          batchTexts,
          purpose,
          signal
        );

        for (let index = 0; index < batchTexts.length; index++) {
          const globalIndex = batchStart + index;
          const text = uncachedTexts[globalIndex];
          const resultIndex = uncachedIndices[globalIndex];
          const embedding = response.embeddings[index];
          if (text === undefined || resultIndex === undefined || !embedding) continue;
          results[resultIndex] = embedding;
          if (purpose !== 'test') {
            this.cache.set(this.buildCacheKey(route.profileId, purpose, text), embedding);
          }
        }
      }
    } catch (error) {
      if (this.isAbortError(error)) throw error;
      const safeFailure = classifyEmbeddingError(error);
      logger.error('[EmbeddingService] Embedding request failed', {
        protocol: route.protocol,
        reason: safeFailure.code,
        category: safeFailure.category,
      });
      throw error;
    }

    for (let index = 0; index < texts.length; index++) {
      if (!results[index]) throw new Error('RAG_EMBEDDING_RESULT_COUNT_MISMATCH');
    }
    return results;
  }

  async testConnection(
    route: ResolvedEmbeddingRoute,
    signal?: AbortSignal
  ): Promise<EmbeddingConnectionTestResult> {
    const startedAt = performance.now();
    const response = await this.callEmbeddingApi(
      route,
      ['AgentVis connection test'],
      'test',
      signal
    );
    this.assertValidResponse(response, 1);
    return {
      dimension: response.dimension,
      model: response.model,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
      const valueA = a[index] ?? 0;
      const valueB = b[index] ?? 0;
      dotProduct += valueA * valueB;
      normA += valueA * valueA;
      normB += valueB * valueB;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  async isSemanticallySimilar(
    textA: string,
    textB: string,
    threshold: number = SEMANTIC_SIMILARITY_THRESHOLD
  ): Promise<boolean> {
    try {
      const route = this.getActiveRoute();
      const [embeddingA, embeddingB] = await Promise.all([
        this.encodeWithRoute(textA, route),
        this.encodeWithRoute(textB, route),
      ]);
      return this.cosineSimilarity(embeddingA, embeddingB) >= threshold;
    } catch {
      logger.warn('[EmbeddingService] Semantic comparison failed; using false');
      return false;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  private async callEmbeddingApi(
    route: ResolvedEmbeddingRoute,
    texts: string[],
    purpose: EmbeddingPurpose,
    signal?: AbortSignal
  ): Promise<CloudEmbeddingResponse> {
    this.assertUsableRoute(route);
    const request = {
      provider: route.provider,
      model: route.modelId,
      texts,
      endpointUrl: route.endpointUrl,
      protocol: route.protocol,
      authMode: route.authMode,
      profileId: route.profileId,
      purpose,
      ...(route.protocol === 'gemini' ? { outputDimensionality: route.outputDimension } : {}),
    };
    const invokeOnce = () => {
      this.throwIfAborted(signal);
      const apiCall = Promise.resolve().then(
        () =>
          this.invokeFn('cloud_embedding_encode', {
            request,
          }) as Promise<CloudEmbeddingResponse>
      );
      return this.withTimeout(apiCall, route.provider, signal);
    };

    const lane = this.getRequestLane(route.profileId);
    return this.enqueueEmbeddingOperation(
      lane,
      () => this.callWithRetry(route.protocol, lane, invokeOnce, purpose, signal),
      signal
    );
  }

  /**
   * Some compatible providers reject an otherwise valid multi-item request with
   * HTTP 400 when the aggregate batch exceeds an undocumented constraint. Split
   * only that exact failure so retryable errors keep their normal backoff and a
   * deterministic single-item rejection remains visible to the caller.
   */
  private async callEmbeddingApiWithAdaptiveBatching(
    route: ResolvedEmbeddingRoute,
    texts: string[],
    purpose: EmbeddingPurpose,
    signal?: AbortSignal
  ): Promise<CloudEmbeddingResponse> {
    try {
      const response = await this.callEmbeddingApi(route, texts, purpose, signal);
      this.assertValidResponse(response, texts.length);
      return response;
    } catch (error) {
      if (this.isAbortError(error)) throw error;

      const safeFailure = classifyEmbeddingError(error);
      if (safeFailure.code !== 'HTTP_400' || texts.length <= 1) throw error;

      this.throwIfAborted(signal);
      logger.warn(
        '[EmbeddingService] Splitting HTTP 400 embedding batch',
        this.getSafeBatchMetrics(texts)
      );

      const splitIndex = Math.ceil(texts.length / 2);
      const left = await this.callEmbeddingApiWithAdaptiveBatching(
        route,
        texts.slice(0, splitIndex),
        purpose,
        signal
      );
      this.throwIfAborted(signal);
      const right = await this.callEmbeddingApiWithAdaptiveBatching(
        route,
        texts.slice(splitIndex),
        purpose,
        signal
      );

      const response = {
        embeddings: [...left.embeddings, ...right.embeddings],
        dimension: left.dimension,
        model: left.model,
      };
      this.assertValidResponse(response, texts.length);
      return response;
    }
  }

  private async callWithRetry<T>(
    protocol: ResolvedEmbeddingRoute['protocol'],
    lane: EmbeddingRequestLane,
    invokeOnce: () => Promise<T>,
    purpose: EmbeddingPurpose,
    signal?: AbortSignal
  ): Promise<T> {
    const policy = this.getRetryPolicy(protocol);
    const maxAttempts = purpose === 'test' ? 1 : policy.maxRetries + 1;

    for (let attemptCount = 1; attemptCount <= maxAttempts; attemptCount++) {
      this.throwIfAborted(signal);
      try {
        await this.waitForRequestSlot(lane, policy.requestIntervalMs, signal);
        return await invokeOnce();
      } catch (error) {
        if (this.isAbortError(error)) throw error;

        const safeFailure = classifyEmbeddingError(error);
        const mayRetry = safeFailure.retryable && attemptCount < maxAttempts;
        if (!mayRetry) {
          if (safeFailure.retryable) {
            const cooldownMs = this.getRetryDelayMs(
              attemptCount - 1,
              policy.retryBaseDelayMs,
              policy.retryMaxDelayMs,
              safeFailure.retryAfterMs
            );
            lane.nextRequestAt = Math.max(lane.nextRequestAt, Date.now() + cooldownMs);
          }
          throw new EmbeddingRequestError(protocol, safeFailure, attemptCount);
        }

        const delayMs = this.getRetryDelayMs(
          attemptCount - 1,
          policy.retryBaseDelayMs,
          policy.retryMaxDelayMs,
          safeFailure.retryAfterMs
        );
        lane.nextRequestAt = Math.max(lane.nextRequestAt, Date.now() + delayMs);
        logger.warn('[EmbeddingService] Retrying Embedding request', {
          protocol,
          reason: safeFailure.code,
          category: safeFailure.category,
          retry: attemptCount,
          maxRetries: policy.maxRetries,
          delayMs,
        });
        await this.wait(delayMs, signal);
      }
    }

    throw new EmbeddingRequestError(
      protocol,
      { category: 'other', code: 'OTHER', retryable: false },
      maxAttempts
    );
  }

  private getRetryPolicy(protocol: ResolvedEmbeddingRoute['protocol']): {
    requestIntervalMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  } {
    if (protocol === 'gemini') {
      return {
        requestIntervalMs: this.geminiRequestIntervalMs,
        maxRetries: this.geminiMaxRetries,
        retryBaseDelayMs: this.geminiRetryBaseDelayMs,
        retryMaxDelayMs: this.geminiRetryMaxDelayMs,
      };
    }
    return {
      requestIntervalMs: this.openAiRequestIntervalMs,
      maxRetries: this.openAiMaxRetries,
      retryBaseDelayMs: this.openAiRetryBaseDelayMs,
      retryMaxDelayMs: this.openAiRetryMaxDelayMs,
    };
  }

  private getRequestLane(profileId: string): EmbeddingRequestLane {
    const existing = this.requestLanes.get(profileId);
    if (existing) return existing;
    const lane: EmbeddingRequestLane = { queue: Promise.resolve(), nextRequestAt: 0 };
    this.requestLanes.set(profileId, lane);
    return lane;
  }

  private enqueueEmbeddingOperation<T>(
    lane: EmbeddingRequestLane,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const run = async () => {
      this.throwIfAborted(signal);
      return operation();
    };

    const request = lane.queue.then(run);
    lane.queue = request.then(
      () => undefined,
      () => undefined
    );
    return request;
  }

  private async waitForRequestSlot(
    lane: EmbeddingRequestLane,
    requestIntervalMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const waitMs = Math.max(0, lane.nextRequestAt - Date.now());
    if (waitMs > 0) await this.wait(waitMs, signal);
    this.throwIfAborted(signal);
    lane.nextRequestAt = Date.now() + requestIntervalMs;
  }

  private getRetryDelayMs(
    retryCount: number,
    retryBaseDelayMs: number,
    retryMaxDelayMs: number,
    retryAfterMs?: number
  ): number {
    const exponentialDelay = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** retryCount);
    const jitterMultiplier = 0.5 + Math.min(1, Math.max(0, this.randomFn())) * 0.5;
    const fallbackDelayMs = Math.max(1, Math.round(exponentialDelay * jitterMultiplier));
    const safeRetryAfterMs =
      retryAfterMs === undefined
        ? 0
        : Math.min(MAX_SERVER_RETRY_AFTER_MS, Math.max(0, Math.round(retryAfterMs)));
    return Math.max(fallbackDelayMs, safeRetryAfterMs);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    provider: string,
    signal?: AbortSignal
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`RAG_EMBEDDING_TIMEOUT:${provider}:${this.timeoutMs}`));
      }, this.timeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      const onAbort = () => reject(this.createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });

    try {
      this.throwIfAborted(signal);
      return await Promise.race([promise, timeoutPromise, abortPromise]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeAbortListener?.();
    }
  }

  private wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        reject(this.createAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.createAbortError();
  }

  private createAbortError(): Error {
    const error = new Error('RAG_EMBEDDING_ABORTED');
    error.name = 'AbortError';
    return error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private getSafeBatchMetrics(texts: string[]): {
    itemCount: number;
    totalUtf8Bytes: number;
    maxItemUtf8Bytes: number;
  } {
    const encoder = new TextEncoder();
    let totalUtf8Bytes = 0;
    let maxItemUtf8Bytes = 0;

    for (const text of texts) {
      const byteLength = encoder.encode(text).byteLength;
      totalUtf8Bytes += byteLength;
      maxItemUtf8Bytes = Math.max(maxItemUtf8Bytes, byteLength);
    }

    return { itemCount: texts.length, totalUtf8Bytes, maxItemUtf8Bytes };
  }

  private assertUsableRoute(route: ResolvedEmbeddingRoute): void {
    if (!route.modelId || !route.profileId) {
      throw new Error('RAG_EMBEDDING_ROUTE_INVALID');
    }
    if (route.provider === 'custom' && !route.endpointUrl) {
      throw new Error('RAG_CUSTOM_EMBEDDING_CONFIG_INVALID');
    }
  }

  private assertValidResponse(response: CloudEmbeddingResponse, expectedCount: number): void {
    if (
      response.embeddings.length !== expectedCount ||
      !Number.isInteger(response.dimension) ||
      response.dimension <= 0
    ) {
      throw new Error('RAG_EMBEDDING_RESULT_COUNT_MISMATCH');
    }

    for (const embedding of response.embeddings) {
      if (
        embedding.length !== response.dimension ||
        embedding.length === 0 ||
        embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('RAG_EMBEDDING_VECTOR_INVALID');
      }
    }
  }

  private buildCacheKey(profileId: string, purpose: EmbeddingPurpose, text: string): string {
    return `${profileId}\u0000${purpose}\u0000${text}`;
  }
}

export const embeddingService = new EmbeddingService();

subscribeToEmbeddingProfileChanges((nextProfileId, previousProfileId) => {
  embeddingService.clearCache();
  void import('../memory/SemanticAnchors').then(({ clearAnchorCache }) => clearAnchorCache());
  logger.info('[EmbeddingService] Active profile changed; dependent caches cleared:', {
    previousProfileId,
    nextProfileId,
  });
});

export function createEmbeddingService(options: EmbeddingServiceOptions = {}): EmbeddingService {
  return new EmbeddingService(options);
}

export async function getEmbedding(text: string): Promise<number[]> {
  return embeddingService.encode(text);
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  return embeddingService.encodeBatch(texts);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return embeddingService.cosineSimilarity(a, b);
}

export async function isSemanticallySimilar(textA: string, textB: string): Promise<boolean> {
  return embeddingService.isSemanticallySimilar(textA, textB);
}

export function clearEmbeddingCache(): void {
  embeddingService.clearCache();
}

export function getEmbeddingCacheSize(): number {
  return embeddingService.getCacheSize();
}
