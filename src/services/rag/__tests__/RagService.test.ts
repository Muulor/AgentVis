import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBM25Index } from '../BM25Index';
import { ragIndexCoordinator } from '../RagIndexCoordinator';
import { RagService } from '../RagService';

const invokeMock = vi.hoisted(() => vi.fn());
const encodeMock = vi.hoisted(() => vi.fn());
const encodeBatchMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../EmbeddingService', () => ({
  embeddingService: {
    getActiveRoute: () => ({
      mode: 'siliconflow',
      provider: 'siliconflow',
      protocol: 'openai',
      modelId: 'BAAI/bge-m3',
      authMode: 'bearer',
      profileId: 'rag-embedding:v1:siliconflow:BAAI/bge-m3',
    }),
    getActiveProfileId: () => 'rag-embedding:v1:siliconflow:BAAI/bge-m3',
    encodeWithRoute: encodeMock,
    encodeBatchWithRoute: encodeBatchMock,
  },
}));

describe('RagService', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    encodeMock.mockReset();
    encodeBatchMock.mockReset();
    getBM25Index().clearAgent('agent-1');
  });

  it('rebuilds BM25 from persisted knowledge chunks before hybrid retrieval', async () => {
    encodeMock.mockResolvedValue([1, 0]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'rag_get_status') {
        return Promise.resolve({
          agent_id: 'agent-1',
          document_count: 2,
          chunk_count: 2,
          last_updated_at: 1000,
        });
      }
      if (command === 'rag_list_chunks') {
        return Promise.resolve([
          {
            chunk_id: 'chunk_persisted_1',
            document_id: 'doc-1',
            chunk_index: 0,
            content: 'persistent alpha guide',
            metadata: JSON.stringify({
              documentType: 'text',
              fileName: 'guide.md',
            }),
            created_at: 1000,
          },
          {
            chunk_id: 'memory_summary_1_0',
            document_id: 'memory_summary_1',
            chunk_index: 0,
            content: 'alpha memory summary',
            metadata: JSON.stringify({
              memoryType: 'summary',
              memoryId: 'summary-1',
            }),
            created_at: 1000,
          },
        ]);
      }
      if (command === 'rag_search') {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const service = new RagService();
    const results = await service.retrieve('agent-1', 'alpha', { topK: 5 });

    expect(invokeMock).toHaveBeenCalledWith('rag_list_chunks', { agentId: 'agent-1' });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('chunk_persisted_1');
    expect(results[0]?.chunk.documentId).toBe('doc-1');
    expect(getBM25Index().getStats('agent-1').documentCount).toBe(1);
  });

  it('rebuilds BM25 once even when the in-memory index is partially populated', async () => {
    getBM25Index().addDocument('agent-1', 'chunk_new_file', 'newly indexed beta file', 'doc-new');
    encodeMock.mockResolvedValue([1, 0]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'rag_get_status') {
        return Promise.resolve({
          agent_id: 'agent-1',
          document_count: 2,
          chunk_count: 2,
          last_updated_at: 1000,
        });
      }
      if (command === 'rag_list_chunks') {
        return Promise.resolve([
          {
            chunk_id: 'chunk_persisted_old',
            document_id: 'doc-old',
            chunk_index: 0,
            content: 'persistent alpha guide',
            metadata: JSON.stringify({
              documentType: 'text',
              fileName: 'old-guide.md',
            }),
            created_at: 1000,
          },
          {
            chunk_id: 'chunk_new_file',
            document_id: 'doc-new',
            chunk_index: 0,
            content: 'newly indexed beta file',
            metadata: JSON.stringify({
              documentType: 'text',
              fileName: 'new-guide.md',
            }),
            created_at: 1001,
          },
        ]);
      }
      if (command === 'rag_search') {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const service = new RagService();
    const results = await service.retrieve('agent-1', 'alpha', { topK: 5 });

    expect(invokeMock).toHaveBeenCalledWith('rag_list_chunks', { agentId: 'agent-1' });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('chunk_persisted_old');
    expect(getBM25Index().getStats('agent-1').documentCount).toBe(2);
  });

  it('keeps knowledge documents whose documentId starts with memory_', async () => {
    encodeMock.mockResolvedValue([1, 0]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'rag_get_status') {
        return Promise.resolve({
          agent_id: 'agent-1',
          document_count: 1,
          chunk_count: 1,
          last_updated_at: 1000,
        });
      }
      if (command === 'rag_list_chunks') {
        return Promise.resolve([
          {
            chunk_id: 'chunk_memory_notes',
            document_id: 'memory_notes.md',
            chunk_index: 0,
            content: 'project memory notes alpha',
            metadata: JSON.stringify({
              documentType: 'text',
              fileName: 'memory_notes.md',
            }),
            created_at: 1000,
          },
          {
            chunk_id: 'chunk_memory_summary',
            document_id: 'memory_summary_1',
            chunk_index: 0,
            content: 'internal memory alpha',
            metadata: JSON.stringify({
              memoryType: 'summary',
              memoryId: 'summary-1',
            }),
            created_at: 1001,
          },
        ]);
      }
      if (command === 'rag_search') {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const service = new RagService();
    const results = await service.retrieve('agent-1', 'alpha', { topK: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('chunk_memory_notes');
    expect(results[0]?.chunk.documentId).toBe('memory_notes.md');
    expect(getBM25Index().getStats('agent-1').documentCount).toBe(1);
  });
  it('uses metadata-augmented text for embeddings while storing raw chunk content', async () => {
    interface RagIndexPayload {
      params: {
        chunk_id: string;
        content: string;
        metadata: string;
      };
    }

    const content = [
      '# Core Features',
      'AgentVis provides feature details for workflows, memory, context, skills, controlled networks, and audit visibility.',
      'This paragraph keeps the chunk above the minimum size while staying in one child chunk for a focused indexing test.',
    ].join('\n\n');

    encodeBatchMock.mockResolvedValue([
      [0.1, 0.2, 0.3],
      [0.2, 0.3, 0.4],
    ]);
    invokeMock.mockImplementation((command: string, payload?: RagIndexPayload) => {
      if (command === 'rag_index_chunk') {
        return Promise.resolve({
          id: payload?.params.chunk_id ?? 'chunk-id',
          success: true,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const service = new RagService();
    const count = await service.indexDocument('agent-1', 'doc-features', content, {
      fileName: 'features_deep_dive.md',
      filePath: 'D:\\AgentVis\\docs\\AgentVis docs\\features_deep_dive.md',
      documentType: 'markdown',
    });

    const embeddingTexts = encodeBatchMock.mock.calls[0]?.[0] as string[] | undefined;
    const insertCalls = invokeMock.mock.calls.filter((call) => call[0] === 'rag_index_chunk');
    const overviewPayload = insertCalls[0]?.[1] as RagIndexPayload | undefined;
    const childPayload = insertCalls[1]?.[1] as RagIndexPayload | undefined;

    expect(count).toBe(2);
    expect(embeddingTexts).toHaveLength(2);
    expect(embeddingTexts?.[0]).toContain('Document: features_deep_dive.md');
    expect(embeddingTexts?.[0]).toContain('features_deep_dive');
    expect(embeddingTexts?.[0]).toContain('\u7279\u6027');
    expect(embeddingTexts?.[0]).toContain('Document Overview');
    expect(embeddingTexts?.[1]).toContain('Section: # Core Features');
    expect(embeddingTexts?.[1]).toContain('AgentVis provides feature details');

    expect(overviewPayload?.params.content).toContain('# Document Overview');
    expect(overviewPayload?.params.metadata).toContain('"isDocumentOverview":true');
    expect(childPayload?.params.content).toContain('AgentVis provides feature details');
    expect(childPayload?.params.content).not.toContain('Document: features_deep_dive.md');
    expect(childPayload?.params.metadata).toContain('features_deep_dive.md');
  });

  it('bounds final metadata-enriched inputs without multiplying persisted chunks', async () => {
    interface RagIndexPayload {
      params: {
        chunk_id: string;
        content: string;
        metadata: string;
      };
    }

    const longHeading = `# ${'metadata-heading-'.repeat(500)}`;
    const content = `${longHeading}\n\n${'Indexable body content. '.repeat(12)}`;
    encodeBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map((_text, index) => [index + 1, 1])
    );
    invokeMock.mockImplementation((command: string, payload?: RagIndexPayload) => {
      if (command === 'rag_index_chunk') {
        return Promise.resolve({
          id: payload?.params.chunk_id ?? 'chunk-id',
          success: true,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const count = await new RagService().indexDocument('agent-1', 'long-section-path.md', content, {
      fileName: 'long-section-path.md',
      documentType: 'markdown',
    });

    const physicalInputs = encodeBatchMock.mock.calls[0]?.[0] as string[];
    const insertCalls = invokeMock.mock.calls.filter((call) => call[0] === 'rag_index_chunk');
    const insertPayloads = insertCalls.map((call) => call[1] as RagIndexPayload);
    const aggregatedPayloads = insertPayloads.filter((payload) => {
      const metadata = JSON.parse(payload.params.metadata) as {
        embeddingAggregationVersion?: string;
        embeddingSegmentCount?: number;
      };
      return metadata.embeddingAggregationVersion === 'utf8-window-weighted-v1';
    });

    expect(physicalInputs.length).toBeGreaterThan(count);
    expect(
      physicalInputs.every((text) => new TextEncoder().encode(text).byteLength <= 6 * 1024)
    ).toBe(true);
    expect(insertCalls).toHaveLength(count);
    expect(aggregatedPayloads.length).toBeGreaterThan(0);
    for (const payload of aggregatedPayloads) {
      const metadata = JSON.parse(payload.params.metadata) as {
        embeddingProfileId?: string;
        embeddingDimension?: number;
        embeddingSegmentCount?: number;
      };
      expect(metadata.embeddingProfileId).toBe('rag-embedding:v1:siliconflow:BAAI/bge-m3');
      expect(metadata.embeddingDimension).toBe(2);
      expect(metadata.embeddingSegmentCount).toBeGreaterThan(1);
      expect(payload.params.content).not.toContain('Section:');
    }
  });

  it('does not persist partial knowledge indexes when embedding is rate-limited', async () => {
    const rateLimitError = new Error('RAG_GEMINI_EMBEDDING_HTTP_429');
    const content = [
      '# Large document',
      'This document is long enough to produce an indexable child chunk for the failure-path test.',
      'Embedding must finish before any SQLite or BM25 writes become visible.',
    ].join('\n\n');
    encodeBatchMock.mockRejectedValue(rateLimitError);

    const service = new RagService();

    await expect(
      service.indexDocument('agent-1', 'rate-limited.md', content, {
        fileName: 'rate-limited.md',
        filePath: 'D:\\AgentVis\\rate-limited.md',
        documentType: 'markdown',
      })
    ).rejects.toBe(rateLimitError);

    expect(invokeMock).not.toHaveBeenCalledWith('rag_index_chunk', expect.anything());
    expect(getBM25Index().getStats('agent-1').documentCount).toBe(0);

    const writerLease = await ragIndexCoordinator.acquireWriter();
    writerLease.release();
  });
});
