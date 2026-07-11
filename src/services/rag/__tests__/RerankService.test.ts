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

    const expectation = expect(promise).rejects.toThrow('Rerank API request timed out');
    await vi.advanceTimersByTimeAsync(10);
    await expectation;

    vi.useRealTimers();
  });
});
