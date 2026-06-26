import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk } from '../../../types';
import { getBM25Index } from '../BM25Index';
import { HybridRetriever } from '../HybridRetriever';

const invokeMock = vi.hoisted(() => vi.fn());
const encodeMock = vi.hoisted(() => vi.fn());
const rerankMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('../EmbeddingService', () => ({
    embeddingService: {
        encode: encodeMock,
    },
}));

vi.mock('../RerankService', () => ({
    rerankService: {
        rerank: rerankMock,
    },
}));

function makeChunk(input: {
    id: string;
    parentId: string;
    fileName: string;
    content: string;
    chunkIndex?: number;
    isDocumentOverview?: boolean;
}): Chunk {
    return {
        id: input.id,
        agentId: 'agent-rerank',
        documentId: input.fileName,
        chunkIndex: input.chunkIndex ?? 0,
        content: input.content,
        metadata: {
            fileName: input.fileName,
            parentChunkId: input.parentId,
            sectionPath: '#',
            isDocumentOverview: input.isDocumentOverview,
        },
        createdAt: 0,
    };
}

function mockVectorSearch(chunks: Chunk[], scores?: number[]) {
    invokeMock.mockImplementation((command: string) => {
        if (command === 'rag_search') {
            return Promise.resolve(chunks.map((chunk, index) => ({
                chunk_id: chunk.id,
                document_id: chunk.documentId,
                chunk_index: chunk.chunkIndex,
                content: chunk.content,
                metadata: JSON.stringify(chunk.metadata),
                score: scores?.[index] ?? 0.7 - index * 0.05,
                distance: 0,
                created_at: chunk.createdAt,
            })));
        }

        return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
}

describe('HybridRetriever rerank integration', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        encodeMock.mockReset();
        rerankMock.mockReset();
        getBM25Index().clearAgent('agent-rerank');
        encodeMock.mockResolvedValue([1, 0]);
    });

    it('promotes a lower RRF candidate when reranker scores it higher', async () => {
        const first = makeChunk({
            id: 'rrf-first',
            parentId: 'parent-first',
            fileName: 'first.md',
            content: 'alpha shallow overview',
        });
        const second = makeChunk({
            id: 'rrf-second',
            parentId: 'parent-second',
            fileName: 'second.md',
            content: 'precise answer for alpha implementation details',
        });
        mockVectorSearch([first, second]);
        rerankMock.mockResolvedValue([
            { id: 'rrf-second', index: 1, score: 0.34 },
            { id: 'rrf-first', index: 0, score: 0.12 },
        ]);

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'alpha details', { finalTopK: 2 });

        expect(rerankMock).toHaveBeenCalledTimes(1);
        expect(results.map(result => result.chunk.id)).toEqual(['rrf-second', 'rrf-first']);
        expect(results.map(result => result.score)).toEqual([0.34, 0.12]);
    });

    it('drops reranker results below the minimum score without backfilling finalTopK', async () => {
        const relevant = makeChunk({
            id: 'relevant',
            parentId: 'parent-relevant',
            fileName: 'relevant.md',
            content: 'alpha relevant answer',
        });
        const weak = makeChunk({
            id: 'weak',
            parentId: 'parent-weak',
            fileName: 'weak.md',
            content: 'unrelated implementation note',
        });
        mockVectorSearch([relevant, weak]);
        rerankMock.mockResolvedValue([
            { id: 'relevant', index: 0, score: 0.22 },
            { id: 'weak', index: 1, score: 0.03 },
        ]);

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'alpha', { finalTopK: 2 });

        expect(results.map(result => result.chunk.id)).toEqual(['relevant']);
    });

    it('keeps strong rerank results even when the old embedding threshold is low-confidence', async () => {
        const semantic = makeChunk({
            id: 'semantic',
            parentId: 'parent-semantic',
            fileName: 'semantic.md',
            content: 'precise implementation guidance written with different wording',
        });
        const weak = makeChunk({
            id: 'weak-low-confidence',
            parentId: 'parent-weak',
            fileName: 'weak.md',
            content: 'unrelated note',
        });
        mockVectorSearch([semantic, weak], [0.01, 0.01]);
        rerankMock.mockResolvedValue([
            { id: 'semantic', index: 0, score: 0.33 },
            { id: 'weak-low-confidence', index: 1, score: 0.03 },
        ]);

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'alpha', { finalTopK: 2 });

        expect(results.map(result => result.chunk.id)).toEqual(['semantic']);
    });

    it('puts the highest reranked document overview first for broad feature queries', async () => {
        const sandboxDns = makeChunk({
            id: 'sandbox-dns',
            parentId: 'sandbox-dns-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: '在 DNS 前识别 sslip.io nip.io xip.io 中编码的 private metadata IPv4',
        });
        const featureOverview = makeChunk({
            id: 'features-overview',
            parentId: 'features-overview',
            fileName: 'features_deep_dive.md',
            content: '# Document Overview\nFile: features_deep_dive.md\nTitle: AgentVis 四大核心特性深度技术解析',
            chunkIndex: -1,
            isDocumentOverview: true,
        });
        const safetyOverview = makeChunk({
            id: 'safety-overview',
            parentId: 'safety-overview',
            fileName: 'AgentVis Agent 行为安全防护机制.md',
            content: '# AgentVis Agent 行为安全防护机制\nAgent 具备调用 Shell 命令和读写文件能力',
        });
        const sandboxBrowser = makeChunk({
            id: 'sandbox-browser',
            parentId: 'sandbox-browser-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: 'agent-browser 是当前默认闭环路径',
        });
        const sandboxGoals = makeChunk({
            id: 'sandbox-goals',
            parentId: 'sandbox-goals-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: '二、核心目标与非目标',
        });
        mockVectorSearch([
            sandboxDns,
            featureOverview,
            safetyOverview,
            sandboxBrowser,
            sandboxGoals,
        ], [0.6001, 0.6006, 0.6192, 0.5901, 0.5831]);
        rerankMock.mockResolvedValue([
            { id: 'features-overview', index: 1, score: 0.9972 },
            { id: 'safety-overview', index: 2, score: 0.9631 },
            { id: 'sandbox-dns', index: 0, score: 0.9616 },
            { id: 'sandbox-goals', index: 4, score: 0.9609 },
            { id: 'sandbox-browser', index: 3, score: 0.9436 },
        ]);

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'AgentVis有什么特性', { finalTopK: 5 });

        expect(results.map(result => result.chunk.id)).toEqual([
            'features-overview',
            'safety-overview',
            'sandbox-dns',
            'sandbox-goals',
            'sandbox-browser',
        ]);
    });

    it('falls back to the existing RRF and gate path when reranker fails', async () => {
        const first = makeChunk({
            id: 'fallback-first',
            parentId: 'parent-first',
            fileName: 'first.md',
            content: 'alpha first answer',
        });
        const second = makeChunk({
            id: 'fallback-second',
            parentId: 'parent-second',
            fileName: 'second.md',
            content: 'alpha second answer',
        });
        mockVectorSearch([first, second]);
        rerankMock.mockRejectedValue(new Error('rerank unavailable'));

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'alpha', { finalTopK: 2 });

        expect(rerankMock).toHaveBeenCalledTimes(1);
        expect(results.map(result => result.chunk.id)).toEqual(['fallback-first', 'fallback-second']);
    });

    it('does not call reranker for a single candidate', async () => {
        const only = makeChunk({
            id: 'only',
            parentId: 'parent-only',
            fileName: 'only.md',
            content: 'alpha only answer',
        });
        mockVectorSearch([only]);

        const retriever = new HybridRetriever();
        const results = await retriever.retrieve('agent-rerank', 'alpha', { finalTopK: 1 });

        expect(rerankMock).not.toHaveBeenCalled();
        expect(results.map(result => result.chunk.id)).toEqual(['only']);
    });
});
