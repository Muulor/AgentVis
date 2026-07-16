import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyEmbeddingError,
  EmbeddingRequestError,
  EmbeddingService,
} from '../EmbeddingService';
import type { ResolvedEmbeddingRoute } from '../RagConnectionConfig';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  getLogger: () => loggerMocks,
}));

function makeRoute(profileId: string): ResolvedEmbeddingRoute {
  return {
    mode: 'custom',
    provider: 'custom',
    protocol: 'openai',
    endpointUrl: 'https://api.example.com/v1/embeddings',
    modelId: 'embed-v1',
    authMode: 'bearer',
    profileId,
  };
}

function makeGeminiRoute(): ResolvedEmbeddingRoute {
  return {
    mode: 'custom',
    provider: 'custom',
    protocol: 'gemini',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelId: 'gemini-embedding-2',
    authMode: 'google_api_key',
    outputDimension: 768,
    profileId: 'rag-embedding:v1:custom:gemini-native-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

describe('EmbeddingService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('routes custom requests explicitly and isolates cache by profile and purpose', async () => {
    let route = makeRoute('rag-embedding:v1:custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { texts: string[] };
      return {
        embeddings: request.texts.map(() => [1, 0]),
        dimension: 2,
        model: 'embed-v1',
      };
    });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
    });

    await service.encode('same text', 'query');
    await service.encode('same text', 'query');
    await service.encode('same text', 'document');
    route = makeRoute('rag-embedding:v1:custom:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await service.encode('same text', 'query');

    expect(invokeFn).toHaveBeenCalledTimes(3);
    expect(invokeFn).toHaveBeenNthCalledWith(
      1,
      'cloud_embedding_encode',
      expect.objectContaining({
        request: expect.objectContaining({
          provider: 'custom',
          endpointUrl: 'https://api.example.com/v1/embeddings',
          protocol: 'openai',
          authMode: 'bearer',
          profileId: 'rag-embedding:v1:custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          purpose: 'query',
        }),
      })
    );
    expect(
      invokeFn.mock.calls.some((call) => JSON.stringify(call).toLowerCase().includes('gitee'))
    ).toBe(false);
  });

  it('clears the timeout timer after a successful request', async () => {
    vi.useFakeTimers();
    const service = new EmbeddingService({
      routeResolver: () => makeRoute('rag-embedding:v1:custom:cccccccccccccccccccccccccccccccc'),
      invokeFn: vi.fn().mockResolvedValue({
        embeddings: [[1, 0]],
        dimension: 2,
        model: 'embed-v1',
      }),
    });

    await service.encode('timer cleanup');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('passes Gemini native protocol, purpose, and output dimensionality to Rust', async () => {
    const invokeFn = vi.fn().mockResolvedValue({
      embeddings: [[1, 0]],
      dimension: 2,
      model: 'gemini-embedding-2',
    });
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
    });

    await service.encode('find this', 'query');

    expect(invokeFn).toHaveBeenCalledWith('cloud_embedding_encode', {
      request: {
        provider: 'custom',
        model: 'gemini-embedding-2',
        texts: ['find this'],
        endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
        protocol: 'gemini',
        authMode: 'google_api_key',
        profileId: 'rag-embedding:v1:custom:gemini-native-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        purpose: 'query',
        outputDimensionality: 768,
      },
    });
  });

  it('serializes concurrent Gemini calls and spaces their start times', async () => {
    vi.useFakeTimers();
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { texts: string[] };
      return {
        embeddings: request.texts.map(() => [1, 0]),
        dimension: 2,
        model: 'gemini-embedding-2',
      };
    });
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
      geminiRequestIntervalMs: 1_000,
    });

    const first = service.encode('first document', 'document');
    const second = service.encode('second document', 'document');
    await vi.advanceTimersByTimeAsync(0);

    expect(invokeFn).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent Gemini work behind the active request retry cooldown', async () => {
    vi.useFakeTimers();
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce('Google Gemini Embedding API returned HTTP 429')
      .mockResolvedValue({
        embeddings: [[1, 0]],
        dimension: 2,
        model: 'gemini-embedding-2',
      });
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
      geminiRequestIntervalMs: 1_000,
      geminiRetryBaseDelayMs: 10_000,
      geminiRetryMaxDelayMs: 10_000,
      randomFn: () => 0,
    });

    const first = service.encode('first retrying document', 'document');
    const second = service.encode('queued document', 'document');
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeFn).toHaveBeenCalledTimes(2);
    await expect(first).resolves.toEqual([1, 0]);

    await vi.advanceTimersByTimeAsync(999);
    expect(invokeFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(3);
  });

  it('retries safe Gemini transient failures with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce('LLM API call failed: Google Gemini Embedding API returned HTTP 429')
      .mockRejectedValueOnce('LLM API call failed: Google Gemini Embedding API returned HTTP 503')
      .mockResolvedValue({
        embeddings: [[1, 0]],
        dimension: 2,
        model: 'gemini-embedding-2',
      });
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
      geminiRequestIntervalMs: 0,
      geminiMaxRetries: 3,
      geminiRetryBaseDelayMs: 10,
      geminiRetryMaxDelayMs: 100,
      randomFn: () => 0,
    });

    const result = service.encode('retry me', 'document');
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(3);
  });

  it('caps Gemini retries and exposes only a safe classified error', async () => {
    vi.useFakeTimers();
    const providerError =
      'LLM API call failed: Google Gemini Embedding API returned HTTP 429; body=secret-api-key';
    const invokeFn = vi.fn().mockRejectedValue(providerError);
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
      geminiRequestIntervalMs: 0,
      geminiMaxRetries: 2,
      geminiRetryBaseDelayMs: 10,
      geminiRetryMaxDelayMs: 100,
      randomFn: () => 0,
    });

    const result = service.encode('eventually fail', 'document');
    const rejection = expect(result).rejects.toMatchObject({
      name: 'EmbeddingRequestError',
      protocol: 'gemini',
      code: 'HTTP_429',
      category: 'rate_limit',
      httpStatus: 429,
      attemptCount: 3,
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(invokeFn).toHaveBeenCalledTimes(3);
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(EmbeddingRequestError);
      expect(String(error)).not.toContain('secret-api-key');
      expect(classifyEmbeddingError(error)).toEqual({
        category: 'rate_limit',
        code: 'HTTP_429',
        httpStatus: 429,
        retryable: true,
      });
    });
  });

  it('classifies a safe Gemini reason through bounded error causes', () => {
    const providerError = new Error('Google Gemini Embedding API returned HTTP 503; body=secret');
    const rebuildError = new Error('RAG_INDEX_REBUILD_FAILED');
    const activationError = new Error('RAG_ACTIVATION_REBUILD_FAILED');
    (rebuildError as Error & { cause: unknown }).cause = providerError;
    (activationError as Error & { cause: unknown }).cause = rebuildError;

    expect(classifyEmbeddingError(activationError)).toEqual({
      category: 'transient',
      code: 'HTTP_503',
      httpStatus: 503,
      retryable: true,
    });

    const cyclicError = new Error('RAG_ACTIVATION_REBUILD_FAILED');
    (cyclicError as Error & { cause: unknown }).cause = cyclicError;
    expect(classifyEmbeddingError(cyclicError)).toEqual({
      category: 'other',
      code: 'OTHER',
      retryable: false,
    });
  });

  it('does not retry connection tests for either protocol', async () => {
    const geminiInvoke = vi.fn().mockRejectedValue('Google Gemini Embedding API returned HTTP 429');
    const geminiService = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn: geminiInvoke,
    });

    await expect(geminiService.testConnection(makeGeminiRoute())).rejects.toMatchObject({
      code: 'HTTP_429',
      attemptCount: 1,
    });
    expect(geminiInvoke).toHaveBeenCalledTimes(1);

    const openAiInvoke = vi.fn().mockRejectedValue('Custom RAG Embedding API returned HTTP 429');
    const openAiService = new EmbeddingService({
      routeResolver: () => makeRoute('rag-embedding:v1:custom:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
      invokeFn: openAiInvoke,
    });

    await expect(
      openAiService.testConnection(
        makeRoute('rag-embedding:v1:custom:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      )
    ).rejects.toMatchObject({
      name: 'EmbeddingRequestError',
      protocol: 'openai',
      code: 'HTTP_429',
      attemptCount: 1,
    });
    expect(openAiInvoke).toHaveBeenCalledTimes(1);
  });

  it('retries OpenAI-compatible rate limits and transient failures', async () => {
    vi.useFakeTimers();
    const route = makeRoute('rag-embedding:v1:custom:openai-retry');
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce('Custom RAG Embedding API returned HTTP 429')
      .mockRejectedValueOnce('Custom RAG Embedding API returned HTTP 503')
      .mockResolvedValue({
        embeddings: [[1, 0]],
        dimension: 2,
        model: 'embed-v1',
      });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
      openAiMaxRetries: 3,
      openAiRetryBaseDelayMs: 10,
      openAiRetryMaxDelayMs: 100,
      randomFn: () => 0,
    });

    const result = service.encode('retry compatible provider', 'document');
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(3);
  });

  it('honors a bounded server retry-after hint for OpenAI-compatible providers', async () => {
    vi.useFakeTimers();
    const route = makeRoute('rag-embedding:v1:custom:openai-retry-after');
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce(
        'Custom RAG Embedding API returned HTTP 429; retry-after-ms=60000; body=secret'
      )
      .mockResolvedValue({
        embeddings: [[1, 0]],
        dimension: 2,
        model: 'embed-v1',
      });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
      openAiMaxRetries: 1,
      openAiRetryBaseDelayMs: 10,
      openAiRetryMaxDelayMs: 100,
      randomFn: () => 0,
    });

    const result = service.encode('respect provider cooldown', 'document');
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(invokeFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient OpenAI-compatible client errors', async () => {
    const route = makeRoute('rag-embedding:v1:custom:openai-client-error');
    const invokeFn = vi
      .fn()
      .mockRejectedValue('Custom RAG Embedding API returned HTTP 400; body=secret-api-key');
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
    });

    const result = service.encode('invalid request', 'document');
    await expect(result).rejects.toMatchObject({
      name: 'EmbeddingRequestError',
      protocol: 'openai',
      code: 'HTTP_400',
      category: 'client',
      attemptCount: 1,
    });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain('secret-api-key');
    });
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it('recursively splits HTTP 400 batches and preserves result order and cache entries', async () => {
    const route = makeRoute('rag-embedding:v1:custom:openai-adaptive-batch');
    const texts = ['secret-alpha', 'secret-beta', 'secret-gamma', 'secret-delta'];
    const vectors = new Map(texts.map((text, index) => [text, [index + 1, 0]]));
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { texts: string[] };
      if (request.texts.length > 1) {
        throw new Error('Custom RAG Embedding API returned HTTP 400; body=provider-secret');
      }
      const text = request.texts[0] ?? '';
      return {
        embeddings: [vectors.get(text)],
        dimension: 2,
        model: 'embed-v1',
      };
    });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
    });

    await expect(service.encodeBatch(texts, 'document')).resolves.toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    expect(invokeFn).toHaveBeenCalledTimes(7);
    expect(
      invokeFn.mock.calls.map((call) => {
        const request = call[1]?.request as { texts: string[] };
        return request.texts;
      })
    ).toEqual([
      texts,
      texts.slice(0, 2),
      texts.slice(0, 1),
      texts.slice(1, 2),
      texts.slice(2),
      texts.slice(2, 3),
      texts.slice(3),
    ]);

    const splitLogs = loggerMocks.warn.mock.calls.filter(
      ([message]) => message === '[EmbeddingService] Splitting HTTP 400 embedding batch'
    );
    expect(splitLogs).toHaveLength(3);
    expect(splitLogs[0]?.[1]).toEqual({
      itemCount: 4,
      totalUtf8Bytes: 47,
      maxItemUtf8Bytes: 12,
    });
    expect(JSON.stringify(splitLogs)).not.toContain('secret-alpha');
    expect(JSON.stringify(splitLogs)).not.toContain('provider-secret');

    await expect(service.encodeBatch(texts, 'document')).resolves.toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    expect(invokeFn).toHaveBeenCalledTimes(7);
  });

  it('applies adaptive HTTP 400 splitting to Gemini batches', async () => {
    const route = makeGeminiRoute();
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { texts: string[] };
      if (request.texts.length > 1) {
        throw new Error('Google Gemini Embedding API returned HTTP 400; body=secret');
      }
      return {
        embeddings: [[request.texts[0] === 'first' ? 1 : 2, 0]],
        dimension: 2,
        model: 'gemini-embedding-2',
      };
    });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
      geminiRequestIntervalMs: 0,
    });

    await expect(service.encodeBatch(['first', 'second'], 'document')).resolves.toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(invokeFn).toHaveBeenCalledTimes(3);
  });

  it('does not split other client errors or retryable HTTP failures', async () => {
    vi.useFakeTimers();
    const route = makeRoute('rag-embedding:v1:custom:openai-no-adaptive-batch');
    const unauthorizedInvoke = vi
      .fn()
      .mockRejectedValue('Custom RAG Embedding API returned HTTP 401');
    const unauthorizedService = new EmbeddingService({
      routeResolver: () => route,
      invokeFn: unauthorizedInvoke,
    });

    await expect(
      unauthorizedService.encodeBatch(['first', 'second'], 'document')
    ).rejects.toMatchObject({ code: 'HTTP_401', attemptCount: 1 });
    expect(unauthorizedInvoke).toHaveBeenCalledTimes(1);

    const rateLimitedInvoke = vi
      .fn()
      .mockRejectedValueOnce('Custom RAG Embedding API returned HTTP 429')
      .mockResolvedValue({
        embeddings: [
          [1, 0],
          [2, 0],
        ],
        dimension: 2,
        model: 'embed-v1',
      });
    const rateLimitedService = new EmbeddingService({
      routeResolver: () => route,
      invokeFn: rateLimitedInvoke,
      openAiMaxRetries: 1,
      openAiRetryBaseDelayMs: 10,
      openAiRetryMaxDelayMs: 10,
      randomFn: () => 0,
    });

    const result = rateLimitedService.encodeBatch(['first', 'second'], 'document');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(rateLimitedInvoke).toHaveBeenCalledTimes(2);
    for (const call of rateLimitedInvoke.mock.calls) {
      expect((call[1]?.request as { texts: string[] }).texts).toEqual(['first', 'second']);
    }
  });

  it('stops adaptive splitting when its abort signal is cancelled', async () => {
    const route = makeRoute('rag-embedding:v1:custom:openai-abort-adaptive-batch');
    const controller = new AbortController();
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { texts: string[] };
      if (request.texts.length > 1) {
        throw new Error('Custom RAG Embedding API returned HTTP 400');
      }
      controller.abort();
      return { embeddings: [[1, 0]], dimension: 2, model: 'embed-v1' };
    });
    const service = new EmbeddingService({
      routeResolver: () => route,
      invokeFn,
    });

    await expect(
      service.encodeBatchWithRoute(['first', 'second'], route, 'document', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeFn).toHaveBeenCalledTimes(2);
  });

  it('isolates retry queues by embedding profile', async () => {
    vi.useFakeTimers();
    const slowRoute = makeRoute('rag-embedding:v1:custom:slow-profile');
    const fastRoute = makeRoute('rag-embedding:v1:custom:fast-profile');
    const invokeFn = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args?.request as { profileId: string };
      if (request.profileId === slowRoute.profileId && invokeFn.mock.calls.length === 1) {
        throw new Error('Custom RAG Embedding API returned HTTP 429');
      }
      return { embeddings: [[1, 0]], dimension: 2, model: 'embed-v1' };
    });
    const service = new EmbeddingService({
      routeResolver: () => slowRoute,
      invokeFn,
      openAiMaxRetries: 1,
      openAiRetryBaseDelayMs: 10_000,
      openAiRetryMaxDelayMs: 10_000,
      randomFn: () => 0,
    });

    const slow = service.encodeWithRoute('slow', slowRoute, 'document');
    await vi.advanceTimersByTimeAsync(0);
    const fast = service.encodeWithRoute('fast', fastRoute, 'document');
    await vi.advanceTimersByTimeAsync(0);

    await expect(fast).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(slow).resolves.toEqual([1, 0]);
    expect(invokeFn).toHaveBeenCalledTimes(3);
  });

  it('can cancel a Gemini retry backoff before another provider request starts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const invokeFn = vi.fn().mockRejectedValue('Google Gemini Embedding API returned HTTP 429');
    const service = new EmbeddingService({
      routeResolver: makeGeminiRoute,
      invokeFn,
      geminiRequestIntervalMs: 0,
      geminiRetryBaseDelayMs: 10_000,
      geminiRetryMaxDelayMs: 10_000,
      randomFn: () => 0,
    });

    const result = service.encodeWithRoute(
      'cancel retry',
      makeGeminiRoute(),
      'document',
      controller.signal
    );
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeFn).toHaveBeenCalledTimes(1);

    controller.abort();
    await rejection;
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed partial vectors instead of caching empty results', async () => {
    const service = new EmbeddingService({
      routeResolver: () => makeRoute('rag-embedding:v1:custom:dddddddddddddddddddddddddddddddd'),
      invokeFn: vi.fn().mockResolvedValue({
        embeddings: [[]],
        dimension: 2,
        model: 'embed-v1',
      }),
    });

    await expect(service.encode('invalid')).rejects.toThrow('RAG_EMBEDDING_VECTOR_INVALID');
    expect(service.getCacheSize()).toBe(0);
  });
});
