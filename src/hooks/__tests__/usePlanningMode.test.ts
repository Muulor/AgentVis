import { describe, expect, it } from 'vitest';
import {
    getPlanningHistoryEffectiveContent,
    isPlanningCheckpointMessage,
    isRecoverablePlanningCheckpointMessage,
    isMessagePresentInList,
    trimPlanningCheckpointTextFromTail,
} from '../usePlanningMode';

const PERSIST_MARKER = '\n\nMB decision progress (system-injected context for the next decision)';

describe('usePlanningMode helpers', () => {
    it('detects whether the original user message is still present', () => {
        const messages = [
            { id: 'user-1' },
            { id: 'assistant-1' },
        ];

        expect(isMessagePresentInList(messages, 'user-1')).toBe(true);
        expect(isMessagePresentInList(messages, 'deleted-user')).toBe(false);
        expect(isMessagePresentInList(messages, null)).toBe(true);
    });

    it('uses assistant metadata.persistContent when rebuilding Planning history', () => {
        const persistedContent = [
            '可见回复',
            `${PERSIST_MARKER}:`,
            'MB rationale for next turn',
            '',
            'SA observations for continuation',
        ].join('\n');

        const content = getPlanningHistoryEffectiveContent({
            role: 'assistant',
            content: '可见回复',
            metadata: {
                persistContent: persistedContent,
            },
        });

        expect(content).toBe(persistedContent);
    });

    it('does not apply persistContent from user metadata to Planning history content', () => {
        const content = getPlanningHistoryEffectiveContent({
            role: 'user',
            content: '用户原始消息',
            metadata: {
                persistContent: '不应进入 historyMessages 的用户侧内容',
            },
        });

        expect(content).toBe('用户原始消息');
    });

    it('trims checkpoint text from the tail so latest progress survives', () => {
        const text = [
            'old step should be dropped',
            'middle step',
            'latest reliable step',
        ].join('\n');

        const trimmed = trimPlanningCheckpointTextFromTail(text, 48, '[older omitted]');

        expect(trimmed).toContain('[older omitted]');
        expect(trimmed).toContain('latest reliable step');
        expect(trimmed).not.toContain('old step should be dropped');
        expect(trimmed.length).toBeLessThanOrEqual(48);
    });

    it('recognizes recoverable checkpoint messages only when their source user still exists', () => {
        const checkpoint = {
            role: 'assistant' as const,
            metadata: {
                mode: 'planning',
                responseType: 'agent_loop_checkpoint',
                agentLoopStatus: 'running',
                createdUserMessageId: 'user-1',
            },
        };

        expect(isPlanningCheckpointMessage(checkpoint)).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'user-1' }])).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'other-user' }])).toBe(false);
    });

    it('does not recover abandoned checkpoint messages', () => {
        const checkpoint = {
            role: 'assistant' as const,
            metadata: {
                mode: 'planning',
                responseType: 'agent_loop_checkpoint_abandoned',
                agentLoopStatus: 'abandoned',
                recoverable: false,
                createdUserMessageId: 'user-1',
            },
        };

        expect(isPlanningCheckpointMessage(checkpoint)).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'user-1' }])).toBe(false);
    });
});
