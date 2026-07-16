import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RerankService } from '../RerankService';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('RerankService', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('calls SiliconFlow rerank with fixed model and returns ranked scores', async () => {
    invokeMock.mockResolvedValue({
      model: 'BAAI/bge-reranker-v2-m3',
      results: [
        { index: 1, relevance_score: 0.42 },
        { index: 0, relevance_score: 0.2 },
      ],
    });

    const service = new RerankService();
    const results = await service.rerank(
      'alpha query',
      [
        {
          id: 'chunk-a',
          text: 'first candidate',
        },
        {
          id: 'chunk-b',
          text: 'second candidate',
        },
      ],
      2
    );

    expect(invokeMock).toHaveBeenCalledWith('cloud_rerank_documents', {
      request: {
        provider: 'siliconflow',
        model: 'BAAI/bge-reranker-v2-m3',
        endpointUrl: undefined,
        protocol: 'jina_cohere',
        authMode: 'bearer',
        purpose: 'rerank',
        query: 'alpha query',
        documents: ['first candidate', 'second candidate'],
        topN: 2,
      },
    });
    expect(results).toEqual([
      { id: 'chunk-b', index: 1, score: 0.42 },
      { id: 'chunk-a', index: 0, score: 0.2 },
    ]);
  });

  it('times out rerank requests so retrieval can fall back', async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValue(new Promise(() => undefined));

    const service = new RerankService({ timeoutMs: 10 });
    const promise = service.rerank(
      'alpha query',
      [
        {
          id: 'chunk-a',
          text: 'first candidate',
        },
        {
          id: 'chunk-b',
          text: 'second candidate',
        },
      ],
      2
    );

    const expectation = expect(promise).rejects.toThrow('RAG_RERANK_TIMEOUT:siliconflow:10');
    await vi.advanceTimersByTimeAsync(10);
    await expectation;

    vi.useRealTimers();
  });

  it('supports a custom Voyage route and does nothing when the route is disabled', async () => {
    const route = {
      mode: 'custom' as const,
      enabled: true,
      provider: 'custom' as const,
      protocol: 'voyage' as const,
      endpointUrl: 'https://api.voyageai.com/v1/rerank',
      modelId: 'rerank-2.5',
      authMode: 'bearer' as const,
    };
    invokeMock.mockResolvedValue({
      model: route.modelId,
      results: [{ index: 0, relevance_score: 0.5 }],
    });
    const service = new RerankService({ routeResolver: () => route });

    await service.rerank('query', [{ id: 'a', text: 'candidate' }]);
    expect(invokeMock).toHaveBeenCalledWith('cloud_rerank_documents', {
      request: expect.objectContaining({
        provider: 'custom',
        protocol: 'voyage',
        endpointUrl: route.endpointUrl,
        model: route.modelId,
        purpose: 'rerank',
      }),
    });

    const disabled = new RerankService({
      routeResolver: () => ({ ...route, enabled: false }),
    });
    invokeMock.mockClear();
    await expect(disabled.rerank('query', [{ id: 'a', text: 'candidate' }])).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
