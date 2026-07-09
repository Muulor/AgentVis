import { describe, expect, it } from 'vitest';
import { buildWidgetUndoRetractionPlan, type WidgetUndoMessage } from '../widgetUndo';

function msg(
    id: string,
    role: WidgetUndoMessage['role'],
    agentId = 'agent-a',
    metadata?: WidgetUndoMessage['metadata']
): WidgetUndoMessage {
    return {
        id,
        role,
        agentId,
        metadata,
    };
}

describe('widgetUndo', () => {
    it('returns null when there is no widget user message', () => {
        const plan = buildWidgetUndoRetractionPlan([
            msg('u1', 'user'),
            msg('a1', 'assistant'),
        ]);

        expect(plan).toBeNull();
    });

    it('retracts from the latest widget user message through cancelled assistant output', () => {
        const messages = [
            msg('u1', 'user'),
            msg('a1', 'assistant'),
            msg('wu1', 'user', 'agent-a', { source: 'widget' }),
            msg('a2', 'assistant'),
            msg('a3', 'assistant'),
        ];

        const plan = buildWidgetUndoRetractionPlan(messages);

        expect(plan?.startIndex).toBe(2);
        expect(plan?.retainedMessages.map(m => m.id)).toEqual(['u1', 'a1']);
        expect(plan?.messagesToRetract.map(m => m.id)).toEqual(['wu1', 'a2', 'a3']);
        expect(plan?.agentGroups.get('agent-a')).toEqual({
            firstId: 'wu1',
            messageIds: ['wu1', 'a2', 'a3'],
        });
    });

    it('groups hub retraction by each message agent id', () => {
        const messages = [
            msg('u1', 'user', 'hub-1'),
            msg('wu1', 'user', 'agent-a', { source: 'widget' }),
            msg('a1', 'assistant', 'agent-a'),
            msg('u2', 'user', 'agent-b'),
            msg('a2', 'assistant', 'agent-b'),
        ];

        const plan = buildWidgetUndoRetractionPlan(messages);

        expect(plan?.retainedMessages.map(m => m.id)).toEqual(['u1']);
        expect(plan?.agentGroups.get('agent-a')).toEqual({
            firstId: 'wu1',
            messageIds: ['wu1', 'a1'],
        });
        expect(plan?.agentGroups.get('agent-b')).toEqual({
            firstId: 'u2',
            messageIds: ['u2', 'a2'],
        });
    });

    it('detects widget metadata stored as a JSON string', () => {
        const plan = buildWidgetUndoRetractionPlan([
            msg('u1', 'user'),
            msg('wu1', 'user', 'agent-a', '{"source":"widget"}'),
            msg('a1', 'assistant'),
        ]);

        expect(plan?.startIndex).toBe(1);
        expect(plan?.messagesToRetract.map(m => m.id)).toEqual(['wu1', 'a1']);
    });

    it('can target a specific widget bubble id instead of the latest widget message', () => {
        const messages = [
            msg('u1', 'user'),
            msg('wu1', 'user', 'agent-a', { source: 'widget', widgetBubbleId: 'bubble-1' }),
            msg('a1', 'assistant'),
            msg('wu2', 'user', 'agent-a', { source: 'widget', widgetBubbleId: 'bubble-2' }),
            msg('a2', 'assistant'),
        ];

        const plan = buildWidgetUndoRetractionPlan(messages, { widgetBubbleId: 'bubble-1' });

        expect(plan?.startIndex).toBe(1);
        expect(plan?.messagesToRetract.map(m => m.id)).toEqual(['wu1', 'a1', 'wu2', 'a2']);
    });
});
