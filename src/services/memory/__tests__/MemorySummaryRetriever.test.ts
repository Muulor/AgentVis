import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySummaryRetriever, type MemorySummaryItem } from '../MemorySummaryRetriever';

const searchRelevantMock = vi.hoisted(() => vi.fn());

vi.mock('../MemoryVectorIndex', () => ({
  getMemoryVectorIndex: () => ({
    searchRelevant: searchRelevantMock,
  }),
}));

describe('MemorySummaryRetriever', () => {
  let retriever: MemorySummaryRetriever;

  beforeEach(() => {
    retriever = new MemorySummaryRetriever();
    searchRelevantMock.mockReset();
  });

  it('moves a summary up when embedding and BM25 both hit it', async () => {
    const summaries = [
      createSummary({
        id: 'semantic-only',
        content: 'The team discussed semantic memory recall and context loading.',
        createdAt: 100,
      }),
      createSummary({
        id: 'hybrid-hit',
        content: 'The decision was to use RRF fusion for memory summaries.',
        confirmedDecisions: ['RRF fusion should combine BM25 and embedding results.'],
        createdAt: 90,
      }),
    ];
    searchRelevantMock.mockResolvedValue([
      createSearchResult('semantic-only', 0.92),
      createSearchResult('hybrid-hit', 0.86),
    ]);

    const result = await retriever.retrieve('agent-1', 'RRF fusion', summaries, {
      topK: 2,
      threshold: 0.4,
    });

    expect(result.isDegraded).toBe(false);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['hybrid-hit', 'semantic-only']);
  });

  it('allows BM25-only recall when the query contains a file-name strong anchor', async () => {
    const summaries = [
      createSummary({
        id: 'target',
        content: 'A memory summary retriever was introduced.',
        mentionedFiles: ['src/services/memory/MemorySummaryRetriever.ts'],
        createdAt: 100,
      }),
      createSummary({
        id: 'other',
        content: 'The chat sender loaded memory context.',
        mentionedFiles: ['src/hooks/useChatSender.ts'],
        createdAt: 200,
      }),
    ];
    searchRelevantMock.mockResolvedValue([]);

    const result = await retriever.retrieve(
      'agent-1',
      'MemorySummaryRetriever.ts 召回策略',
      summaries,
      { topK: 3, threshold: 0.4 }
    );

    expect(result.isDegraded).toBe(false);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['target']);
  });

  it('drops BM25-only matches caused only by low-value generic terms', async () => {
    const summaries = [
      createSummary({
        id: 'generic-old',
        content: '之前讨论的方案还有一个问题，需要继续确认。',
        createdAt: 100,
      }),
      createSummary({
        id: 'recent',
        content: 'Newer unrelated memory state.',
        createdAt: 300,
      }),
    ];
    searchRelevantMock.mockResolvedValue([]);

    const result = await retriever.retrieve('agent-1', '之前那个方案问题', summaries, {
      topK: 1,
      threshold: 0.4,
    });

    expect(result.isDegraded).toBe(true);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['recent']);
  });

  it('falls back to recent summaries when embedding and BM25 produce no usable result', async () => {
    const summaries = [
      createSummary({ id: 'old', content: 'Old memory state.', createdAt: 100 }),
      createSummary({ id: 'middle', content: 'Middle memory state.', createdAt: 200 }),
      createSummary({ id: 'new', content: 'New memory state.', createdAt: 300 }),
    ];
    searchRelevantMock.mockResolvedValue([]);

    const result = await retriever.retrieve('agent-1', 'totally unrelated', summaries, {
      topK: 2,
      threshold: 0.4,
    });

    expect(result.isDegraded).toBe(true);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['new', 'middle']);
  });

  it('uses BM25 strong-anchor results when embedding search throws', async () => {
    const summaries = [
      createSummary({
        id: 'target',
        content: 'The TypeScript implementation lives in MemorySummaryRetriever.ts.',
        mentionedFiles: ['src/services/memory/MemorySummaryRetriever.ts'],
        createdAt: 100,
      }),
      createSummary({
        id: 'recent',
        content: 'Recent unrelated state.',
        createdAt: 300,
      }),
    ];
    searchRelevantMock.mockRejectedValue(new Error('embedding unavailable'));

    const result = await retriever.retrieve(
      'agent-1',
      'src/services/memory/MemorySummaryRetriever.ts',
      summaries,
      { topK: 2, threshold: 0.4 }
    );

    expect(result.isDegraded).toBe(false);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['target']);
  });

  it('does not backfill unrelated summaries after RRF gating', async () => {
    const summaries = [
      createSummary({
        id: 'target',
        content: 'The final implementation edits MemorySummaryRetriever.ts.',
        mentionedFiles: ['src/services/memory/MemorySummaryRetriever.ts'],
        createdAt: 100,
      }),
      createSummary({ id: 'other-1', content: 'Other state.', createdAt: 300 }),
      createSummary({ id: 'other-2', content: 'Another state.', createdAt: 200 }),
    ];
    searchRelevantMock.mockResolvedValue([]);

    const result = await retriever.retrieve('agent-1', 'MemorySummaryRetriever.ts', summaries, {
      topK: 3,
      threshold: 0.4,
    });

    expect(result.isDegraded).toBe(false);
    expect(result.summaries.map((summary) => summary.id)).toEqual(['target']);
  });
});

function createSummary(overrides: Partial<MemorySummaryItem>): MemorySummaryItem {
  return {
    id: 'summary-1',
    content: 'Default memory summary.',
    createdAt: 100,
    ...overrides,
  };
}

function createSearchResult(memoryId: string, score: number) {
  return {
    memoryId,
    memoryType: 'summary',
    content: `summary ${memoryId}`,
    score,
  };
}
