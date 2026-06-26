import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryContextProvider, type MemoryItem } from '../MemoryContextProvider';

const invokeMock = vi.hoisted(() => vi.fn());
const summaryRetrieveMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('../MemorySummaryRetriever', () => ({
    memorySummaryRetriever: {
        retrieve: summaryRetrieveMock,
    },
}));

describe('MemoryContextProvider evidence budget', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        summaryRetrieveMock.mockReset();
        summaryRetrieveMock.mockImplementation(async (_agentId: string, _query: string, allSummaries: MemoryItem[]) => ({
            summaries: allSummaries,
            isDegraded: false,
        }));
    });

    it('expands evidence only for the top recalled summary and defaults to one turn', async () => {
        setupInvokeMock();

        const provider = new MemoryContextProvider();
        const context = await provider.getMemoryContext('agent-1', {
            userQuery: '所以分析股票要像调查宁德时代这种维度来做对吗',
        });

        const [topSummary, otherSummary] = context.summaries;
        expect(topSummary?.openQuestions?.[0]?.evidenceSlices?.map(slice => `${slice.turnId}:${slice.speaker}`))
            .toEqual(['2:user', '2:assistant']);
        expect(otherSummary?.openQuestions?.[0]?.evidenceSlices).toBeUndefined();
        expect(getMessageBatchCalls()).toHaveLength(1);
    });

    it('allows two turns only for process-style queries', async () => {
        setupInvokeMock();

        const provider = new MemoryContextProvider();
        const context = await provider.getMemoryContext('agent-1', {
            userQuery: '请回顾完整过程，怎么从模拟选股到宁德时代分析',
        });

        const [topSummary, otherSummary] = context.summaries;
        expect(topSummary?.openQuestions?.[0]?.evidenceSlices?.map(slice => `${slice.turnId}:${slice.speaker}`))
            .toEqual(['2:user', '2:assistant', '1:user', '1:assistant']);
        expect(otherSummary?.openQuestions?.[0]?.evidenceSlices).toBeUndefined();
        expect(getMessageBatchCalls()).toHaveLength(1);
    });

    it('does not expand evidence for generic process wording', async () => {
        setupInvokeMock();

        const provider = new MemoryContextProvider();
        const context = await provider.getMemoryContext('agent-1', {
            userQuery: '模拟盘操作过程中要注意什么',
        });

        const [topSummary] = context.summaries;
        expect(topSummary?.openQuestions?.[0]?.evidenceSlices?.map(slice => `${slice.turnId}:${slice.speaker}`))
            .toEqual(['2:user', '2:assistant']);
        expect(getMessageBatchCalls()).toHaveLength(1);
    });
});

function setupInvokeMock(): void {
    invokeMock.mockImplementation((command: string, payload?: { ids?: string[] }) => {
        if (command === 'memory_get_context') {
            return Promise.resolve({
                facts: [],
                summaries: [
                    createSummary({
                        id: 'top-summary',
                        sourceMessageIds: JSON.stringify(['top-u1', 'top-a1', 'top-u2', 'top-a2']),
                    }),
                    createSummary({
                        id: 'other-summary',
                        createdAt: 200,
                        sourceMessageIds: JSON.stringify(['other-u1', 'other-a1']),
                    }),
                ],
            });
        }

        if (command === 'message_get_batch') {
            const ids = payload?.ids ?? [];
            return Promise.resolve(ids.map(id => MESSAGE_FIXTURES[id]).filter(Boolean));
        }

        return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
}

function getMessageBatchCalls(): unknown[] {
    return invokeMock.mock.calls.filter(call => call[0] === 'message_get_batch');
}

function createSummary(overrides: Partial<MemoryItem> = {}): MemoryItem {
    return {
        id: 'summary-1',
        agentId: 'agent-1',
        layer: 'summary',
        content: '股票分析摘要。',
        category: null,
        importance: null,
        sourceMessageIds: null,
        metadataJson: JSON.stringify({
            openQuestions: [{
                question: '用户是否需要进一步查看宁德时代的细分详细数据',
                scope: '个股分析',
                reason: '需要根据前文股票分析内容继续展开。',
                turnHint: [2],
                keywords: ['宁德时代', '股票分析', '模拟选股'],
            }],
        }),
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

const MESSAGE_FIXTURES: Record<string, {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
}> = {
    'top-u1': {
        id: 'top-u1',
        role: 'user',
        content: '要不帮我查查现在哪个股比较适合模拟？',
        createdAt: 1,
    },
    'top-a1': {
        id: 'top-a1',
        role: 'assistant',
        content: '推荐模拟标的包括招商银行、美的集团、宁德时代，适合比较不同股票分析思路。',
        createdAt: 2,
    },
    'top-u2': {
        id: 'top-u2',
        role: 'user',
        content: '宁德时代好像最近都比较火，能否展开分析一下',
        createdAt: 3,
    },
    'top-a2': {
        id: 'top-a2',
        role: 'assistant',
        content: '宁德时代核心分析摘要，包含公司地位、财务数据、核心竞争力、近期事件、机构观点和风险提示。',
        createdAt: 4,
    },
    'other-u1': {
        id: 'other-u1',
        role: 'user',
        content: '同花顺跟实时行情一样吗？',
        createdAt: 5,
    },
    'other-a1': {
        id: 'other-a1',
        role: 'assistant',
        content: '同花顺模拟盘行情和真实市场一致，只是资金为虚拟资金。',
        createdAt: 6,
    },
};
