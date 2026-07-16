import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk } from '../../../types';
import { VectorStore } from '../VectorStore';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('VectorStore', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('passes the frontend chunk id to the backend when indexing', async () => {
    invokeMock.mockResolvedValue({ id: 'chunk_frontend_1', success: true });

    const store = new VectorStore();
    const chunk: Chunk = {
      id: 'chunk_frontend_1',
      agentId: 'agent-1',
      documentId: 'doc-1',
      chunkIndex: 0,
      content: 'alpha content',
      metadata: {
        documentType: 'text',
        fileName: 'guide.md',
      },
      createdAt: 1000,
    };

    await store.insert(chunk, [0.1, 0.2]);

    expect(invokeMock).toHaveBeenCalledWith('rag_index_chunk', {
      params: expect.objectContaining({
        chunk_id: 'chunk_frontend_1',
        metadata: JSON.stringify({
          documentType: 'text',
          fileName: 'guide.md',
          embeddingProfileId: 'rag-embedding:v1:siliconflow:BAAI/bge-m3',
          embeddingDimension: 2,
        }),
      }),
    });
  });

  it('passes the active profile to vector search', async () => {
    invokeMock.mockResolvedValue([]);
    const store = new VectorStore();

    await store.search('agent-1', [1, 0], 5, 0.3);

    expect(invokeMock).toHaveBeenCalledWith('rag_search', {
      params: expect.objectContaining({
        expected_embedding_profile_id: 'rag-embedding:v1:siliconflow:BAAI/bge-m3',
      }),
    });
  });

  it('uses the stable agent-list and transactional batch-update IPC contracts', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'rag_list_vector_agent_ids') return Promise.resolve(['agent-1']);
      if (command === 'rag_batch_update_chunk_embeddings') return Promise.resolve(1);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const store = new VectorStore();
    const updates = [
      {
        chunkId: 'chunk-1',
        embedding: [1, 0],
        metadata: JSON.stringify({
          embeddingProfileId: 'profile-1',
          embeddingDimension: 2,
        }),
      },
    ];

    await expect(store.listVectorAgentIds()).resolves.toEqual(['agent-1']);
    await expect(store.batchUpdateChunkEmbeddings('agent-1', updates)).resolves.toBe(1);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'rag_list_vector_agent_ids');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'rag_batch_update_chunk_embeddings', {
      agentId: 'agent-1',
      updates,
    });
  });

  it('treats malformed and non-object persisted metadata as stale empty metadata', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'rag_list_chunks') {
        return Promise.resolve([
          {
            chunk_id: 'bad-json',
            document_id: 'doc-1',
            chunk_index: 0,
            content: 'bad json',
            metadata: '{broken',
            created_at: 1,
          },
          {
            chunk_id: 'array-json',
            document_id: 'doc-1',
            chunk_index: 1,
            content: 'array json',
            metadata: '[]',
            created_at: 1,
          },
        ]);
      }
      if (command === 'rag_search') {
        return Promise.resolve([
          {
            chunk_id: 'primitive-json',
            document_id: 'doc-1',
            content: 'primitive json',
            metadata: 'null',
            score: 0.5,
            distance: 0.5,
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const store = new VectorStore();

    const chunks = await store.listChunks('agent-1');
    const results = await store.search('agent-1', [1, 0]);

    expect(chunks.map((chunk) => chunk.metadata)).toEqual([{}, {}]);
    expect(results[0]?.chunk.metadata).toEqual({});
  });
});
