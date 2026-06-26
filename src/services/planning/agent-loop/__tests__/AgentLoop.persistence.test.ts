import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AgentLoop } from '../AgentLoop';
import type { AgentSession } from '../AgentSession';
import type { AgentLoopResult, TerminationReason } from '../types';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

const PERSIST_MARKER = '\n\nMB decision progress (system-injected context for the next decision)';

function createSession(messages: unknown[]): AgentSession {
    return {
        id: 'test-session',
        getMessages: vi.fn().mockReturnValue(messages),
        addMessage: vi.fn(),
        getModelId: vi.fn().mockReturnValue('test-model'),
        getLastPreparedContext: vi.fn().mockReturnValue(null),
        getToolOutputBudget: vi.fn().mockReturnValue(null),
    } as unknown as AgentSession;
}

function createLoop(messages: unknown[]): AgentLoop {
    vi.mocked(invoke).mockResolvedValue({ type: 'text', content: '' });
    return new AgentLoop(
        { providerId: 'test-provider', modelId: 'test-model' },
        createSession(messages)
    );
}

function buildResult(
    loop: AgentLoop,
    reason: TerminationReason
): AgentLoopResult {
    return (loop as unknown as {
        buildResult: (reason: TerminationReason) => AgentLoopResult;
    }).buildResult(reason);
}

describe('AgentLoop cross-request persistence result handling', () => {
    it('strips injected planning context from UI content while preserving persistContent', () => {
        const persistedContent = [
            '用户可见的中断说明',
            `${PERSIST_MARKER}:`,
            '需要继续使用已有搜索结果完成任务',
            '',
            'MB last dispatched task:',
            '继续整理报告',
        ].join('\n');
        const loop = createLoop([
            { role: 'user', content: '请继续' },
            { role: 'assistant', content: persistedContent },
        ]);

        const result = buildResult(loop, 'error');

        expect(result.success).toBe(true);
        expect(result.content).toBe('用户可见的中断说明');
        expect(result.persistContent).toBe(persistedContent);
    });

    it('does not reuse a historical assistant message when cancellation happens before a new assistant response', () => {
        const loop = createLoop([
            { role: 'user', content: '上一轮请求' },
            { role: 'assistant', content: '上一轮 assistant 回复，不应重复显示' },
            { role: 'user', content: '本轮请求' },
        ]);
        (loop as unknown as { historyMessageCount: number }).historyMessageCount = 2;

        const result = buildResult(loop, 'cancelled');

        expect(result.success).toBe(true);
        expect(result.content).toBe('');
        expect(result.persistContent).toBe('');
    });
});
