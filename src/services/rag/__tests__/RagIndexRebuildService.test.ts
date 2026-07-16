import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk, CustomEmbeddingConfig } from '@/types/rag';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveRagEmbeddingRoute } from '../RagConnectionConfig';
import { ragIndexCoordinator } from '../RagIndexCoordinator';
import type { ChunkEmbeddingUpdate, VectorStore } from '../VectorStore';

const encodeBatchWithRouteMock = vi.hoisted(() => vi.fn());
const clearEmbeddingCacheMock = vi.hoisted(() => vi.fn());
const clearAnchorCacheMock = vi.hoisted(() => vi.fn());

vi.mock('../EmbeddingService', () => ({
  embeddingService: {
    encodeBatchWithRoute: encodeBatchWithRouteMock,
    clearCache: clearEmbeddingCacheMock,
  },
}));

vi.mock('../../memory/SemanticAnchors', () => ({
  clearAnchorCache: clearAnchorCacheMock,
}));

import { RagIndexRebuildError, RagIndexRebuildService } from '../RagIndexRebuildService';

const customEmbedding: CustomEmbeddingConfig = {
  providerName: 'Test',
  protocol: 'openai',
  endpointUrl: 'https://api.example.com/v1/embeddings',
  modelId: 'embed-v1',
  authMode: 'bearer',
};

function activateCustom(): void {
  useSettingsStore.getState().setRagConnectionSettings({
    mode: 'custom',
    embedding: customEmbedding,
    reranker: {
      enabled: false,
      providerName: '',
      protocol: 'jina_cohere',
      endpointUrl: '',
      modelId: '',
      authMode: 'bearer',
    },
  });
}

function makeChunk(input: {
  id: string;
  agentId: string;
  content: string;
  profileId?: string;
  dimension?: number;
  memory?: boolean;
}): Chunk {
  return {
    id: input.id,
    agentId: input.agentId,
    documentId: input.memory ? `memory_summary_${input.id}` : `doc-${input.id}`,
    chunkIndex: 0,
    content: input.content,
    metadata: {
      fileName: input.memory ? undefined : `${input.id}.md`,
      memoryType: input.memory ? 'summary' : undefined,
      memoryId: input.memory ? input.id : undefined,
      embeddingProfileId: input.profileId,
      embeddingDimension: input.dimension,
    },
    createdAt: 1,
  };
}

describe('RagIndexRebuildService', () => {
  beforeEach(() => {
    activateCustom();
    encodeBatchWithRouteMock.mockReset();
    clearEmbeddingCacheMock.mockReset();
    clearAnchorCacheMock.mockReset();
    encodeBatchWithRouteMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => [1, 0, 0])
    );
  });

  afterEach(() => {
    useSettingsStore.getState().setRagServiceMode('siliconflow');
  });

  it('rebuilds only stale chunks and makes retries idempotent', async () => {
    const route = resolveRagEmbeddingRoute();
    const chunksByAgent = new Map<string, Chunk[]>([
      [
        'agent-a',
        [
          makeChunk({
            id: 'current',
            agentId: 'agent-a',
            content: 'already current',
            profileId: route.profileId,
            dimension: 3,
          }),
          makeChunk({ id: 'knowledge', agentId: 'agent-a', content: 'knowledge body' }),
        ],
      ],
      [
        'agent-b',
        [makeChunk({ id: 'memory', agentId: 'agent-b', content: 'raw memory', memory: true })],
      ],
    ]);
    const batchUpdate = vi.fn(
      async (agentId: string, updates: ChunkEmbeddingUpdate[]): Promise<number> => {
        const chunks = chunksByAgent.get(agentId) ?? [];
        for (const update of updates) {
          const chunk = chunks.find((candidate) => candidate.id === update.chunkId);
          if (chunk) chunk.metadata = JSON.parse(update.metadata) as Chunk['metadata'];
        }
        return updates.length;
      }
    );
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a', 'agent-b']),
      getStatus: vi.fn(async (agentId: string) => ({
        agentId,
        documentCount: 1,
        chunkCount: chunksByAgent.get(agentId)?.length ?? 0,
      })),
      listChunks: vi.fn(async (agentId: string) => chunksByAgent.get(agentId) ?? []),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;
    const service = new RagIndexRebuildService(vectorStore);
    const progressUpdates: Array<{ phase: string; completedChunks: number }> = [];

    const first = await service.rebuildAll({
      route,
      expectedDimension: 3,
      onProgress: ({ phase, completedChunks }) => {
        progressUpdates.push({ phase, completedChunks });
      },
    });

    expect(first).toMatchObject({ rebuiltChunkCount: 2, skippedChunkCount: 1 });
    expect(encodeBatchWithRouteMock).toHaveBeenCalledTimes(2);
    expect(encodeBatchWithRouteMock.mock.calls[0]?.[0]?.[0]).toContain('Document: knowledge.md');
    expect(encodeBatchWithRouteMock.mock.calls[1]?.[0]).toEqual(['raw memory']);
    expect(progressUpdates.filter((progress) => progress.phase === 'embedding')).toEqual([
      { phase: 'embedding', completedChunks: 1 },
      { phase: 'embedding', completedChunks: 2 },
    ]);
    for (const updates of batchUpdate.mock.calls.map((call) => call[1])) {
      for (const update of updates) {
        expect(JSON.parse(update.metadata)).toMatchObject({
          embeddingProfileId: route.profileId,
          embeddingDimension: 3,
        });
      }
    }

    const second = await service.rebuildAll({ route, expectedDimension: 3 });
    expect(second).toMatchObject({ rebuiltChunkCount: 0, skippedChunkCount: 3 });
    expect(encodeBatchWithRouteMock).toHaveBeenCalledTimes(2);
  });

  it('persists provider-sized checkpoints and resumes after a later batch fails', async () => {
    const route = resolveRagEmbeddingRoute();
    const chunks = Array.from({ length: 30 }, (_, index) =>
      makeChunk({
        id: `chunk-${index}`,
        agentId: 'agent-a',
        content: `chunk body ${index}`,
      })
    );
    const rateLimitError = new Error('Google Gemini Embedding API returned HTTP 429');
    encodeBatchWithRouteMock
      .mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
      .mockRejectedValueOnce(rateLimitError)
      .mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const batchUpdate = vi.fn(async (_agentId: string, updates: ChunkEmbeddingUpdate[]) => {
      for (const update of updates) {
        const chunk = chunks.find((candidate) => candidate.id === update.chunkId);
        if (chunk) chunk.metadata = JSON.parse(update.metadata) as Chunk['metadata'];
      }
      return updates.length;
    });
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: chunks.length,
      }),
      listChunks: vi.fn().mockImplementation(async () => chunks),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;
    const service = new RagIndexRebuildService(vectorStore);

    const firstError = await service
      .rebuildAll({ route, expectedDimension: 3 })
      .catch((cause: unknown) => cause);

    expect(firstError).toBeInstanceOf(RagIndexRebuildError);
    expect((firstError as RagIndexRebuildError).cause).toBe(rateLimitError);
    expect((firstError as RagIndexRebuildError).progress).toMatchObject({
      phase: 'embedding',
      completedChunks: 25,
      totalChunks: 30,
      completedAgents: 0,
    });
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate.mock.calls[0]?.[1]).toHaveLength(25);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.metadata.embeddingProfileId === route.profileId &&
          chunk.metadata.embeddingDimension === 3
      )
    ).toHaveLength(25);

    const retry = await service.rebuildAll({ route, expectedDimension: 3 });

    expect(retry).toMatchObject({
      rebuiltChunkCount: 5,
      skippedChunkCount: 25,
      rebuiltAgentCount: 1,
    });
    expect(encodeBatchWithRouteMock).toHaveBeenCalledTimes(3);
    expect(encodeBatchWithRouteMock.mock.calls.map((call) => call[0])).toHaveLength(3);
    expect(encodeBatchWithRouteMock.mock.calls[0]?.[0]).toHaveLength(25);
    expect(encodeBatchWithRouteMock.mock.calls[1]?.[0]).toHaveLength(5);
    expect(encodeBatchWithRouteMock.mock.calls[2]?.[0]).toHaveLength(5);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[1]?.[1]).toHaveLength(5);
  });

  it('windows oversized legacy text, aggregates by new UTF-8 bytes, and preserves normal vectors', async () => {
    const route = resolveRagEmbeddingRoute();
    const chunks = [
      makeChunk({
        id: 'normal-before',
        agentId: 'agent-a',
        content: 'normal before',
        memory: true,
      }),
      makeChunk({
        id: 'oversized',
        agentId: 'agent-a',
        content: 'x'.repeat(12_000),
        memory: true,
        profileId: route.profileId,
        dimension: 2,
      }),
      makeChunk({
        id: 'normal-after',
        agentId: 'agent-a',
        content: 'normal after',
        memory: true,
      }),
    ];
    const providerVectors = [
      [3, 4],
      [1, 0],
      [0, 1],
      [1, 1],
      [8, 6],
    ];
    encodeBatchWithRouteMock.mockImplementationOnce(async (texts: string[]) => {
      expect(texts).toHaveLength(providerVectors.length);
      return providerVectors;
    });
    const batchUpdate = vi.fn(async (_agentId: string, updates: ChunkEmbeddingUpdate[]) => {
      for (const update of updates) {
        const chunk = chunks.find((candidate) => candidate.id === update.chunkId);
        if (chunk) chunk.metadata = JSON.parse(update.metadata) as Chunk['metadata'];
      }
      return updates.length;
    });
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: chunks.length,
      }),
      listChunks: vi.fn().mockImplementation(async () => chunks),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;
    const service = new RagIndexRebuildService(vectorStore);

    const first = await service.rebuildAll({ route, expectedDimension: 2 });

    expect(first).toMatchObject({ rebuiltChunkCount: 3, skippedChunkCount: 0 });
    const expandedTexts = encodeBatchWithRouteMock.mock.calls[0]?.[0] as string[];
    expect(expandedTexts[0]).toBe('normal before');
    expect(expandedTexts[4]).toBe('normal after');
    const windows = expandedTexts.slice(1, 4);
    expect(windows.map((window) => new TextEncoder().encode(window).byteLength)).toEqual([
      6144, 6144, 736,
    ]);
    expect(windows[0]?.slice(-512)).toBe(windows[1]?.slice(0, 512));
    expect(windows[1]?.slice(-512)).toBe(windows[2]?.slice(0, 512));

    const updates = batchUpdate.mock.calls[0]?.[1] ?? [];
    expect(updates.map((update) => update.chunkId)).toEqual([
      'normal-before',
      'oversized',
      'normal-after',
    ]);
    expect(updates[0]?.embedding).toEqual([3, 4]);
    expect(updates[2]?.embedding).toEqual([8, 6]);
    const weightedX = 6144 + 224 / Math.SQRT2;
    const weightedY = 5632 + 224 / Math.SQRT2;
    const expectedNorm = Math.hypot(weightedX, weightedY);
    expect(updates[1]?.embedding[0]).toBeCloseTo(weightedX / expectedNorm, 12);
    expect(updates[1]?.embedding[1]).toBeCloseTo(weightedY / expectedNorm, 12);
    expect(JSON.parse(updates[1]?.metadata ?? '{}')).toMatchObject({
      embeddingAggregationVersion: 'utf8-window-weighted-v1',
      embeddingSegmentCount: 3,
      embeddingProfileId: route.profileId,
      embeddingDimension: 2,
    });
    expect(JSON.parse(updates[0]?.metadata ?? '{}')).not.toHaveProperty(
      'embeddingAggregationVersion'
    );

    const retry = await service.rebuildAll({ route, expectedDimension: 2 });
    expect(retry).toMatchObject({ rebuiltChunkCount: 0, skippedChunkCount: 3 });
    expect(encodeBatchWithRouteMock).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledTimes(1);

    const oversizedChunk = chunks.find((chunk) => chunk.id === 'oversized');
    if (!oversizedChunk) throw new Error('missing oversized test chunk');
    oversizedChunk.metadata.embeddingSegmentCount = 2;
    encodeBatchWithRouteMock.mockImplementationOnce(async (texts: string[]) =>
      texts.map(() => [1, 0])
    );

    const mismatchedSegmentRetry = await service.rebuildAll({ route, expectedDimension: 2 });
    expect(mismatchedSegmentRetry).toMatchObject({ rebuiltChunkCount: 1, skippedChunkCount: 2 });
    expect(encodeBatchWithRouteMock).toHaveBeenCalledTimes(2);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses Unicode-safe overlapping windows that cover every source code point', async () => {
    const route = resolveRagEmbeddingRoute();
    const content = Array.from(
      { length: 1_100 },
      (_, index) => `${index.toString(36).padStart(4, '0')}汉🙂|`
    ).join('');
    const chunk = makeChunk({
      id: 'unicode',
      agentId: 'agent-a',
      content,
      memory: true,
    });
    encodeBatchWithRouteMock.mockImplementationOnce(async (texts: string[]) =>
      texts.map(() => [1, 0])
    );
    const batchUpdate = vi.fn(
      async (_agentId: string, updates: ChunkEmbeddingUpdate[]) => updates.length
    );
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: 1,
      }),
      listChunks: vi.fn().mockResolvedValue([chunk]),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;

    await new RagIndexRebuildService(vectorStore).rebuildAll({
      route,
      expectedDimension: 2,
    });

    const windows = encodeBatchWithRouteMock.mock.calls[0]?.[0] as string[];
    expect(windows.length).toBeGreaterThan(1);
    let coveredEnd = 0;
    let priorStart = -1;
    for (const window of windows) {
      expect(new TextEncoder().encode(window).byteLength).toBeLessThanOrEqual(6 * 1024);
      expect(window).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(window).not.toMatch(/[\uD800-\uDBFF]$/u);
      const start = content.indexOf(window);
      expect(start).toBeGreaterThan(priorStart);
      expect(start).toBeLessThanOrEqual(coveredEnd);
      expect(start + window.length).toBeGreaterThan(coveredEnd);
      expect(content.slice(start, start + window.length)).toBe(window);
      priorStart = start;
      coveredEnd = start + window.length;
    }
    expect(coveredEnd).toBe(content.length);
    expect(batchUpdate.mock.calls[0]?.[1]).toHaveLength(1);
    expect(batchUpdate.mock.calls[0]?.[1]?.[0]?.embedding).toEqual([1, 0]);
  });

  it('rejects zero-norm window vectors before aggregating an oversized chunk', async () => {
    const route = resolveRagEmbeddingRoute();
    encodeBatchWithRouteMock.mockImplementationOnce(async (texts: string[]) =>
      texts.map(() => [0, 0])
    );
    const batchUpdate = vi.fn();
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: 1,
      }),
      listChunks: vi.fn().mockResolvedValue([
        makeChunk({
          id: 'zero-window',
          agentId: 'agent-a',
          content: 'x'.repeat(7_000),
          memory: true,
        }),
      ]),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;

    const error = await new RagIndexRebuildService(vectorStore)
      .rebuildAll({ route, expectedDimension: 2 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RagIndexRebuildError);
    expect((error as RagIndexRebuildError).cause).toMatchObject({
      message: 'RAG_REBUILD_WINDOW_EMBEDDING_NORM_INVALID',
    });
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['unexpected dimension', [1, 0], 'RAG_REBUILD_EMBEDDING_DIMENSION_MISMATCH'],
    ['non-finite value', [1, Number.NaN, 0], 'RAG_REBUILD_EMBEDDING_NOT_FINITE'],
  ])('rejects an embedding with %s before persistence', async (_label, embedding, message) => {
    const route = resolveRagEmbeddingRoute();
    encodeBatchWithRouteMock.mockResolvedValueOnce([embedding]);
    const batchUpdate = vi.fn();
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: 1,
      }),
      listChunks: vi
        .fn()
        .mockResolvedValue([makeChunk({ id: 'invalid', agentId: 'agent-a', content: 'body' })]),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;

    const error = await new RagIndexRebuildService(vectorStore)
      .rebuildAll({ route, expectedDimension: 3 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RagIndexRebuildError);
    expect((error as RagIndexRebuildError).cause).toMatchObject({ message });
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('rejects overlapping rebuilds', async () => {
    let releaseAgentList: ((value: string[]) => void) | undefined;
    const agentList = new Promise<string[]>((resolve) => {
      releaseAgentList = resolve;
    });
    const vectorStore = {
      listVectorAgentIds: vi.fn(() => agentList),
    } as unknown as VectorStore;
    const service = new RagIndexRebuildService(vectorStore);
    const route = resolveRagEmbeddingRoute();

    const first = service.rebuildAll({ route, expectedDimension: 3 });
    await expect(service.rebuildAll({ route, expectedDimension: 3 })).rejects.toThrow(
      'RAG_INDEX_REBUILD_IN_PROGRESS'
    );
    releaseAgentList?.([]);
    await first;
  });

  it('stops before a database update if the active profile changes', async () => {
    const route = resolveRagEmbeddingRoute();
    encodeBatchWithRouteMock.mockImplementationOnce(async () => {
      useSettingsStore.getState().setRagServiceMode('siliconflow');
      return [[1, 0, 0]];
    });
    const batchUpdate = vi.fn();
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: 1,
      }),
      listChunks: vi
        .fn()
        .mockResolvedValue([makeChunk({ id: 'stale', agentId: 'agent-a', content: 'stale' })]),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;
    const service = new RagIndexRebuildService(vectorStore);

    const error = await service
      .rebuildAll({ route, expectedDimension: 3 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RagIndexRebuildError);
    expect((error as RagIndexRebuildError).cause).toMatchObject({
      message: 'RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD',
    });
    expect(batchUpdate).not.toHaveBeenCalled();
    expect(service.isRunning()).toBe(false);
    const writerAfterFailure = await ragIndexCoordinator.acquireWriter();
    writerAfterFailure.release();
  });

  it('rebuilds same-profile vectors when the provider dimension drifts', async () => {
    const route = resolveRagEmbeddingRoute();
    const chunk = makeChunk({
      id: 'dimension-drift',
      agentId: 'agent-a',
      content: 'same model alias, new dimension',
      profileId: route.profileId,
      dimension: 3,
    });
    encodeBatchWithRouteMock.mockResolvedValue([[1, 0, 0, 0]]);
    const batchUpdate = vi.fn(async (_agentId: string, updates: ChunkEmbeddingUpdate[]) => {
      chunk.metadata = JSON.parse(updates[0]?.metadata ?? '{}') as Chunk['metadata'];
      return updates.length;
    });
    const vectorStore = {
      listVectorAgentIds: vi.fn().mockResolvedValue(['agent-a']),
      getStatus: vi.fn().mockResolvedValue({
        agentId: 'agent-a',
        documentCount: 1,
        chunkCount: 1,
      }),
      listChunks: vi.fn().mockResolvedValue([chunk]),
      batchUpdateChunkEmbeddings: batchUpdate,
    } as unknown as VectorStore;

    const result = await new RagIndexRebuildService(vectorStore).rebuildAll({
      route,
      expectedDimension: 4,
    });

    expect(result).toMatchObject({ rebuiltChunkCount: 1, skippedChunkCount: 0 });
    expect(chunk.metadata.embeddingDimension).toBe(4);
  });
});
