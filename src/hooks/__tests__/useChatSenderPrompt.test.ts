import { describe, expect, it } from 'vitest';
import {
    buildChatModeIdentityPrompt,
    buildChatQuoteContext,
    getChatContextSectionTitle,
    NO_CONVERSATION_HISTORY,
    type ChatContextBlockType,
} from '../useChatSenderPrompt';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;
const JSON_FENCE_PATTERN = /```(echarts|widget-choices|widget-chart|widget-tree)\s*\n([\s\S]*?)```/g;

function extractJsonFencedBlocks(prompt: string): Array<{ fence: string; content: string }> {
    return [...prompt.matchAll(JSON_FENCE_PATTERN)].map(match => ({
        fence: match[1] ?? '',
        content: (match[2] ?? '').trim(),
    }));
}

describe('useChatSender chat prompt invariants', () => {
    it('keeps system-owned chat prompt text in English', () => {
        const prompt = buildChatModeIdentityPrompt('Astra');

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('## Identity Awareness');
        expect(prompt).toContain('Use the user\'s language for user-visible prose');
        expect(prompt).toContain('Current time:');
    });

    it('preserves required visual and widget capabilities', () => {
        const prompt = buildChatModeIdentityPrompt('Astra');

        for (const fence of ['echarts', 'widget-choices', 'widget-chart', 'widget-tree']) {
            expect(prompt).toContain(`\`\`\`${fence}`);
        }

        expect(prompt).toContain('mermaid.js');
    });

    it('keeps JSON examples parseable', () => {
        const blocks = extractJsonFencedBlocks(buildChatModeIdentityPrompt('Astra'));

        expect(blocks.length).toBeGreaterThanOrEqual(8);

        for (const block of blocks) {
            expect(() => JSON.parse(block.content), `${block.fence} example should be valid JSON`)
                .not.toThrow();
        }
    });

    it('formats quoted context with English model-visible labels', () => {
        const result = buildChatQuoteContext([
            { agentName: 'Planner', content: 'First note' },
            { content: 'Second note' },
        ]);

        expect(result).toBe([
            '> [Quoted from Planner]:',
            '> First note',
            '',
            '> [Quoted from Hub]:',
            '> Second note',
        ].join('\n'));
        expect(result).not.toMatch(HAN_CHARACTER_PATTERN);
    });

    it('cleans visual blocks from quoted context', () => {
        const result = buildChatQuoteContext([
            {
                agentName: 'Planner',
                content: 'Original Master Brain answer\n```echarts\n{"series":[]}\n```',
            },
        ]);

        expect(result).toContain('Original Master Brain answer');
        expect(result).not.toContain('echarts');
    });

    it('formats context section titles with English model-visible labels', () => {
        const types: ChatContextBlockType[] = ['quotes', 'rag', 'attachment', 'facts', 'summaries'];

        for (const type of types) {
            const title = getChatContextSectionTitle(type);
            expect(title).not.toMatch(HAN_CHARACTER_PATTERN);
            expect(title).toMatch(/^## /);
        }

        expect(getChatContextSectionTitle('rag')).toContain('Knowledge Base Reference Content');
        expect(NO_CONVERSATION_HISTORY).toBe('(No conversation history)');
    });
});
