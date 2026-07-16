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
