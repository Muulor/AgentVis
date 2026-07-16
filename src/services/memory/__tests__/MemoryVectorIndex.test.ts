/**
 * MemoryVectorIndex final embedding input and persistence tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryVectorIndex } from '../MemoryVectorIndex';

const invokeMock = vi.hoisted(() => vi.fn());
const encodeBatchMock = vi.hoisted(() => vi.fn());

const PROFILE_ID = 'rag-embedding:v1:siliconflow:BAAI/bge-m3';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../../rag/EmbeddingService', () => ({
  embeddingService: {
    getActiveRoute: () => ({
      mode: 'siliconflow',
      provider: 'siliconflow',
      protocol: 'openai',
      modelId: 'BAAI/bge-m3',
      authMode: 'bearer',
      profileId: PROFILE_ID,
    }),
    getActiveProfileId: () => PROFILE_ID,
    encodeBatchWithRoute: encodeBatchMock,
  },
}));

interface RagIndexPayload {
  params: {
    chunk_id: string;
    document_id: string;
    content: string;
    embedding: number[];
    metadata: string;
  };
}

describe('MemoryVectorIndex', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    encodeBatchMock.mockReset();
  });

  it('windows a long summary while persisting one complete logical memory row', async () => {
    const content = `SUMMARY_HEAD_${'记忆内容🙂'.repeat(1_200)}_SUMMARY_TAIL`;
    encodeBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map((_text, index) => [index + 1, 1])
    );
    invokeMock.mockImplementation((command: string, payload?: RagIndexPayload) => {
      if (command === 'rag_delete_by_document') return Promise.resolve(1);
      if (command === 'rag_index_chunk') {
        return Promise.resolve({ id: payload?.params.chunk_id, success: true });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await new MemoryVectorIndex().indexSummary('agent-1', 'summary-1', content);

    const physicalInputs = encodeBatchMock.mock.calls[0]?.[0] as string[];
    const insertCalls = invokeMock.mock.calls.filter((call) => call[0] === 'rag_index_chunk');
    const payload = insertCalls[0]?.[1] as RagIndexPayload | undefined;
    const metadata = JSON.parse(payload?.params.metadata ?? '{}') as {
      memoryType?: string;
      memoryId?: string;
      embeddingProfileId?: string;
      embeddingDimension?: number;
      embeddingAggregationVersion?: string;
      embeddingSegmentCount?: number;
    };

    expect(physicalInputs.length).toBeGreaterThan(1);
    expect(
      physicalInputs.every((text) => new TextEncoder().encode(text).byteLength <= 6 * 1024)
    ).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(payload?.params.document_id).toBe('memory_summary_summary-1');
    expect(payload?.params.content).toBe(content);
    expect(metadata).toMatchObject({
      memoryType: 'summary',
      memoryId: 'summary-1',
      embeddingProfileId: PROFILE_ID,
      embeddingDimension: 2,
      embeddingAggregationVersion: 'utf8-window-weighted-v1',
      embeddingSegmentCount: physicalInputs.length,
    });
    expect(encodeBatchMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('keeps a short fact vector unchanged without aggregation metadata', async () => {
    encodeBatchMock.mockResolvedValue([[3, 4]]);
    invokeMock.mockImplementation((command: string, payload?: RagIndexPayload) => {
      if (command === 'rag_index_chunk') {
        return Promise.resolve({ id: payload?.params.chunk_id, success: true });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await new MemoryVectorIndex().indexFact('agent-1', 'fact-1', 'short fact', 'preference_style');

    const payload = invokeMock.mock.calls[0]?.[1] as RagIndexPayload | undefined;
    const metadata = JSON.parse(payload?.params.metadata ?? '{}') as Record<string, unknown>;
    expect(payload?.params.embedding).toEqual([3, 4]);
    expect(payload?.params.content).toBe('short fact');
    expect(metadata).toMatchObject({
      memoryType: 'fact',
      memoryId: 'fact-1',
      category: 'preference_style',
      embeddingProfileId: PROFILE_ID,
      embeddingDimension: 2,
    });
    expect(metadata).not.toHaveProperty('embeddingAggregationVersion');
    expect(metadata).not.toHaveProperty('embeddingSegmentCount');
  });

  it('does not delete an existing summary row when remote embedding fails', async () => {
    const embeddingError = new Error('RAG_EMBEDDING_OPENAI_HTTP_400');
    encodeBatchMock.mockRejectedValue(embeddingError);

    await expect(
      new MemoryVectorIndex().indexSummary('agent-1', 'summary-1', 'replacement summary')
    ).rejects.toBe(embeddingError);

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
