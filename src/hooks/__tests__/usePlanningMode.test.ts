import { describe, expect, it } from 'vitest';
import {
    getPlanningHistoryEffectiveContent,
    isMessagePresentInList,
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
});
