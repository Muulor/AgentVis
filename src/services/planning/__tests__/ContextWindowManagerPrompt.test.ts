import { describe, expect, it } from 'vitest';
import { ContextWindowManager } from '../ContextWindowManager';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;

describe('ContextWindowManager prompt text invariants', () => {
    it('formats empty history with an English model-visible placeholder', () => {
        const manager = new ContextWindowManager();

        expect(manager.formatHistory([], 1000)).toBe('(No conversation history)');
    });

    it('formats history roles and truncation fallbacks in English', () => {
        const manager = new ContextWindowManager();
        const formatted = manager.formatHistory([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ], 1000);
        const omitted = manager.formatHistory([
            { role: 'user', content: 'this message cannot fit the tiny budget' },
        ], 1);

        expect(formatted).toContain('**User**:\nhello');
        expect(formatted).toContain('**Agent**:\nhi there');
        expect(formatted).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(omitted).toBe('(History too long; omitted)');
    });

    it('returns English full-history text from prepareContext', async () => {
        const manager = new ContextWindowManager();

        const prepared = await manager.prepareContext([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ], '', 'default');

        expect(prepared.conversationHistory).toContain('**User**:\nhello');
        expect(prepared.conversationHistory).toContain('**Agent**:\nhi there');
        expect(prepared.conversationHistory).not.toMatch(HAN_CHARACTER_PATTERN);
    });
});
