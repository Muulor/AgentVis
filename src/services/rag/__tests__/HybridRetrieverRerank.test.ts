import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk } from '../../../types';
import { getBM25Index } from '../BM25Index';
import { HybridRetriever } from '../HybridRetriever';

const invokeMock = vi.hoisted(() => vi.fn());
const encodeMock = vi.hoisted(() => vi.fn());
const rerankMock = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({
  mode: 'siliconflow' as 'siliconflow' | 'custom',
  rerankerEnabled: true,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../EmbeddingService', () => ({
  embeddingService: {
    getActiveRoute: () => ({
      mode: routeState.mode,
      provider: routeState.mode === 'custom' ? 'custom' : 'siliconflow',
      protocol: 'openai',
      endpointUrl:
        routeState.mode === 'custom' ? 'https://api.example.com/v1/embeddings' : undefined,
      modelId: 'BAAI/bge-m3',
      authMode: 'bearer',
      profileId:
        routeState.mode === 'custom'
          ? 'rag-embedding:v1:custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          : 'rag-embedding:v1:siliconflow:BAAI/bge-m3',
    }),
    encodeWithRoute: encodeMock,
  },
}));

vi.mock('../RerankService', () => ({
  rerankService: {
    getActiveRoute: () => ({
      mode: routeState.mode,
      enabled: routeState.rerankerEnabled,
      provider: routeState.mode === 'custom' ? 'custom' : 'siliconflow',
      protocol: 'jina_cohere',
      endpointUrl: routeState.mode === 'custom' ? 'https://api.example.com/v1/rerank' : undefined,
      modelId: 'BAAI/bge-reranker-v2-m3',
      authMode: 'bearer',
    }),
    rerankWithRoute: rerankMock,
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
      return Promise.resolve(
        chunks.map((chunk, index) => ({
          chunk_id: chunk.id,
          document_id: chunk.documentId,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          metadata: JSON.stringify(chunk.metadata),
          score: scores?.[index] ?? 0.7 - index * 0.05,
          distance: 0,
          created_at: chunk.createdAt,
        }))
      );
    }

    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
}

describe('HybridRetriever rerank integration', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    encodeMock.mockReset();
    rerankMock.mockReset();
    routeState.mode = 'siliconflow';
    routeState.rerankerEnabled = true;
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
    expect(results.map((result) => result.chunk.id)).toEqual(['rrf-second', 'rrf-first']);
    expect(results.map((result) => result.score)).toEqual([0.34, 0.12]);
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

    expect(results.map((result) => result.chunk.id)).toEqual(['relevant']);
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

    expect(results.map((result) => result.chunk.id)).toEqual(['semantic']);
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
      content:
        '# Document Overview\nFile: features_deep_dive.md\nTitle: AgentVis 四大核心特性深度技术解析',
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
    mockVectorSearch(
      [sandboxDns, featureOverview, safetyOverview, sandboxBrowser, sandboxGoals],
      [0.6001, 0.6006, 0.6192, 0.5901, 0.5831]
    );
    rerankMock.mockResolvedValue([
      { id: 'features-overview', index: 1, score: 0.9972 },
      { id: 'safety-overview', index: 2, score: 0.9631 },
      { id: 'sandbox-dns', index: 0, score: 0.9616 },
      { id: 'sandbox-goals', index: 4, score: 0.9609 },
      { id: 'sandbox-browser', index: 3, score: 0.9436 },
    ]);

    const retriever = new HybridRetriever();
    const results = await retriever.retrieve('agent-rerank', 'AgentVis有什么特性', {
      finalTopK: 5,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([
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
    expect(results.map((result) => result.chunk.id)).toEqual(['fallback-first', 'fallback-second']);
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
    expect(results.map((result) => result.chunk.id)).toEqual(['only']);
  });

  it('uses arbitrary custom rerank scores only for ordering when lexical grounding exists', async () => {
    routeState.mode = 'custom';
    const first = makeChunk({
      id: 'custom-low',
      parentId: 'custom-low-parent',
      fileName: 'low.md',
      content: 'alpha implementation reference',
    });
    const second = makeChunk({
      id: 'custom-lower',
      parentId: 'custom-lower-parent',
      fileName: 'lower.md',
      content: 'alpha implementation details',
    });
    mockVectorSearch([first, second], [0.01, 0.001]);
    rerankMock.mockResolvedValue([
      { id: second.id, index: 1, score: 0.002 },
      { id: first.id, index: 0, score: 0.001 },
    ]);

    const results = await new HybridRetriever().retrieve('agent-rerank', 'alpha implementation', {
      finalTopK: 2,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([second.id, first.id]);
  });

  it('keeps custom selection stable when raw score magnitudes change but rank order does not', async () => {
    routeState.mode = 'custom';
    const chunks = [
      makeChunk({
        id: 'rank-first',
        parentId: 'rank-first-parent',
        fileName: 'first.md',
        content: 'alpha implementation first',
      }),
      makeChunk({
        id: 'rank-second',
        parentId: 'rank-second-parent',
        fileName: 'second.md',
        content: 'alpha implementation second',
      }),
      makeChunk({
        id: 'rank-third',
        parentId: 'rank-third-parent',
        fileName: 'third.md',
        content: 'alpha implementation third',
      }),
    ];
    mockVectorSearch(chunks);
    rerankMock.mockResolvedValueOnce([
      { id: 'rank-third', index: 2, score: 0.999999 },
      { id: 'rank-second', index: 1, score: 0.000002 },
      { id: 'rank-first', index: 0, score: 0.000001 },
    ]);
    const firstRun = await new HybridRetriever().retrieve('agent-rerank', 'alpha implementation', {
      finalTopK: 2,
    });

    rerankMock.mockResolvedValueOnce([
      { id: 'rank-third', index: 2, score: 0.51 },
      { id: 'rank-second', index: 1, score: 0.5 },
      { id: 'rank-first', index: 0, score: 0.49 },
    ]);
    const secondRun = await new HybridRetriever().retrieve('agent-rerank', 'alpha implementation', {
      finalTopK: 2,
    });

    expect(firstRun.map((result) => result.chunk.id)).toEqual(['rank-third', 'rank-second']);
    expect(secondRun.map((result) => result.chunk.id)).toEqual(
      firstRun.map((result) => result.chunk.id)
    );
  });

  it('does not let a high custom rerank score bypass lexical grounding', async () => {
    routeState.mode = 'custom';
    const first = makeChunk({
      id: 'custom-ungrounded-a',
      parentId: 'custom-ungrounded-a-parent',
      fileName: 'a.md',
      content: 'weather and rainfall only',
    });
    const second = makeChunk({
      id: 'custom-ungrounded-b',
      parentId: 'custom-ungrounded-b-parent',
      fileName: 'b.md',
      content: 'cooking instructions only',
    });
    mockVectorSearch([first, second], [0.99, 0.98]);
    rerankMock.mockResolvedValue([
      { id: first.id, index: 0, score: 0.999 },
      { id: second.id, index: 1, score: 0.998 },
    ]);

    const results = await new HybridRetriever().retrieve('agent-rerank', 'zebra protocol', {
      finalTopK: 2,
      enableFinalRelevanceFilter: false,
    });
    expect(results).toEqual([]);
  });

  it('skips a disabled custom reranker and keeps the RRF path', async () => {
    routeState.mode = 'custom';
    routeState.rerankerEnabled = false;
    const first = makeChunk({
      id: 'custom-disabled-a',
      parentId: 'custom-disabled-a-parent',
      fileName: 'a.md',
      content: 'alpha implementation reference',
    });
    const second = makeChunk({
      id: 'custom-disabled-b',
      parentId: 'custom-disabled-b-parent',
      fileName: 'b.md',
      content: 'alpha implementation details',
    });
    mockVectorSearch([first, second]);

    const results = await new HybridRetriever().retrieve('agent-rerank', 'alpha implementation', {
      finalTopK: 2,
    });

    expect(rerankMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });
});
