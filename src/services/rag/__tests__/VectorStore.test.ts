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
            }),
        });
    });
});
