import { describe, expect, it } from 'vitest';
import { buildCategoryConsolidatorPrompt } from '../CategoryConsolidator';
import { EvidenceRetriever } from '../EvidenceRetriever';
import { buildMemoryExtractorPrompt } from '../FactExtractor';
import { MemoryContextProvider } from '../MemoryContextProvider';
import { SOURCE_LANGUAGE_PRESERVATION_RULES } from '../PromptLanguagePolicy';
import { buildPriorStateText, buildSummaryPrompt } from '../SummaryManager';
import { buildCurrentTimePrompt, formatRelativeTime, formatTimestamp } from '@services/utils/TimeUtils';
import type { MemoryCandidate } from '../types';
import type { MemoryItem } from '../MemoryContextProvider';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;

function createEnglishCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
    return {
        id: 'candidate_1',
        agentId: 'agent_1',
        content: 'The user prefers concise implementation notes.',
        category: 'preference_style',
        occurrenceCount: 2,
        firstSeenAt: Date.now() - 1000,
        lastSeenAt: Date.now(),
        userConfirmed: true,
        score: 8,
        contextMessages: [
            { role: 'user', content: 'Please keep the explanation short.' },
            { role: 'assistant', content: 'Understood, I will keep it concise.' },
        ],
        ...overrides,
    };
}

describe('memory prompt invariants', () => {
    it('keeps the memory extractor system-owned prompt text in English', () => {
        const prompt = buildMemoryExtractorPrompt(createEnglishCandidate());

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('User: Please keep the explanation short.');
        expect(prompt).toContain('Assistant: Understood, I will keep it concise.');
        expect(prompt).toContain('userConfirmed: yes');
    });

    it('adds hard source-language preservation rules to memory extraction prompts', () => {
        const extractorPrompt = buildMemoryExtractorPrompt(createEnglishCandidate({
            content: '用户偏好中文回答。',
            contextMessages: [
                { role: 'user', content: '以后请用中文总结重点。' },
                { role: 'assistant', content: '好的，我会用中文总结。' },
            ],
        }));
        const consolidatorPrompt = buildCategoryConsolidatorPrompt('preference_style', [
            { id: 'fact_1', content: '用户偏好中文回答。', confidence: 0.82 },
        ]);
        const summaryPrompt = buildSummaryPrompt('[#1 User] 以后请用中文总结重点。', null);

        for (const prompt of [extractorPrompt, consolidatorPrompt, summaryPrompt]) {
            expect(prompt).toContain(SOURCE_LANGUAGE_PRESERVATION_RULES);
            expect(prompt).toContain(
                'Do not translate them into English merely because these instructions are written in English.'
            );
        }

        expect(extractorPrompt).toContain('用户偏好中文回答。');
        expect(extractorPrompt).toContain('User: 以后请用中文总结重点。');
        expect(consolidatorPrompt).toContain('1. "用户偏好中文回答。" (confidence: 0.82)');
        expect(summaryPrompt).toContain('[#1 User] 以后请用中文总结重点。');
    });

    it('preserves memory extractor schema fields and category enums', () => {
        const prompt = buildMemoryExtractorPrompt(createEnglishCandidate());
        const requiredTokens = [
            'identity_role',
            'preference_style',
            'long_term_goal',
            'knowledge_level',
            'interaction_signals',
            '"extract"',
            '"reason"',
            '"category"',
            '"candidate_fact"',
            '"confidence"',
            '"notes"',
        ];

        for (const token of requiredTokens) {
            expect(prompt).toContain(token);
        }
    });

    it('keeps the category consolidator prompt in English with schema fields intact', () => {
        const prompt = buildCategoryConsolidatorPrompt('preference_style', [
            { id: 'fact_1', content: 'The user prefers concise replies.', confidence: 0.82 },
            { id: 'fact_2', content: 'The user asks for short implementation notes.', confidence: 0.76 },
        ]);

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('category: preference_style');
        expect(prompt).toContain('1. "The user prefers concise replies." (confidence: 0.82)');

        for (const token of [
            '"write"',
            '"reason"',
            '"category"',
            '"long_term_fact"',
            '"confidence"',
            '"merged_from_indices"',
            '"rejected_indices"',
            '"notes"',
        ]) {
            expect(prompt).toContain(token);
        }
    });

    it('keeps the summary prompt in English and preserves state schema fields', () => {
        const priorState = {
            confirmedDecisions: ['Use BM25 and vector retrieval together.'],
            openQuestions: [{ question: 'How should reranking be tuned?', scope: 'retrieval_strategy' }],
        };
        const conversations = [
            '[#1 User] Let us keep hybrid retrieval but postpone reranking.',
            '[#2 Assistant] Agreed, hybrid retrieval stays and reranking is deferred.',
        ].join('\n');
        const prompt = buildSummaryPrompt(conversations, priorState);

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('Historically Confirmed Decisions');
        expect(prompt).toContain('Historical Open Questions');
        expect(prompt).toContain('confirmedDecisions must only extract conclusions');

        for (const token of [
            '"summary"',
            '"keyPoints"',
            '"topics"',
            '"mentionedFiles"',
            '"confirmedDecisions"',
            '"openQuestions"',
            '"question"',
            '"scope"',
            '"reason"',
            '"turnHint"',
            '"keywords"',
            '"invalidatedPoints"',
        ]) {
            expect(prompt).toContain(token);
        }
    });

    it('keeps the summary JSON example parseable', () => {
        const prompt = buildSummaryPrompt('[#1 User] Ship the minimal fix.', null);
        const jsonStart = prompt.indexOf('{\n  "summary"');
        const jsonEnd = prompt.lastIndexOf('\n}');
        const jsonExample = prompt.slice(jsonStart, jsonEnd + 2);

        expect(jsonStart).toBeGreaterThanOrEqual(0);
        expect(jsonEnd).toBeGreaterThan(jsonStart);
        expect(() => JSON.parse(jsonExample)).not.toThrow();
    });

    it('uses an English no-prior-state placeholder', () => {
        expect(buildPriorStateText(null)).toBe(
            '(No prior state. This is the first conversation summary for this Agent.)'
        );
    });

    it('keeps memory context fact prompts in English while preserving fact content', () => {
        const provider = new MemoryContextProvider();
        const now = Date.now();
        const facts: MemoryItem[] = [
            createMemoryItem({ content: 'The user is a backend engineer.', category: 'identity_role', updatedAt: now }),
            createMemoryItem({ content: 'The user prefers concise replies.', category: 'preference_style', updatedAt: now }),
            createMemoryItem({ content: 'The user is preparing for system design interviews.', category: 'long_term_goal', updatedAt: now - 2 * 60 * 60 * 1000 }),
            createMemoryItem({ content: 'The user is comfortable with TypeScript.', category: 'knowledge_level', updatedAt: now - 24 * 60 * 60 * 1000 }),
            createMemoryItem({ content: 'The user often weighs speed against implementation quality.', category: 'interaction_signals', updatedAt: now - 7 * 24 * 60 * 60 * 1000 }),
            createMemoryItem({ content: 'On Windows, prefer findstr over grep.', category: 'task_experience', updatedAt: now }),
        ];

        const prompt = [
            provider.buildBindingFactsPrompt(facts),
            provider.buildContextFactsPrompt(facts),
            provider.buildTaskExperiencePrompt(facts),
        ].filter(Boolean).join('\n\n');

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('# Confirmed Identity And Preferences');
        expect(prompt).toContain('## User Identity');
        expect(prompt).toContain('## User Preferences');
        expect(prompt).toContain('# Factual Background From User Interactions');
        expect(prompt).toContain('## Long-Term Goals');
        expect(prompt).toContain('## Knowledge Background');
        expect(prompt).toContain('## Interaction Signals Worth Noticing');
        expect(prompt).toContain('# Historical Task Execution Experience');
        expect(prompt).toContain('The user prefers concise replies.');
        expect(prompt).toContain('On Windows, prefer findstr over grep.');
    });

    it('keeps summary memory context prompts in English with state labels intact', () => {
        const provider = new MemoryContextProvider();
        const prompt = provider.buildSummariesPrompt([
            createMemoryItem({
                content: 'Hybrid retrieval was selected as the current approach.',
                layer: 'summary',
                createdAt: Date.UTC(2026, 2, 8, 8, 18),
                confirmedDecisions: ['Keep BM25 plus vector retrieval.'],
                openQuestions: [{
                    question: 'How should reranking be tuned?',
                    scope: 'retrieval_strategy',
                    reason: 'The exact threshold was not decided.',
                    evidenceSlices: [{
                        turnId: 2,
                        speaker: 'user',
                        content: 'Let us postpone reranking until we have metrics.',
                    }],
                }],
                invalidatedPoints: ['The vector-only retrieval plan was rejected.'],
            }),
        ]) ?? '';

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('## Early Conversation State');
        expect(prompt).toContain('Confirmed decisions:');
        expect(prompt).toContain('Open questions:');
        expect(prompt).toContain('Evidence for precise trace-back:');
        expect(prompt).toContain('Invalidated points:');
        expect(prompt).toContain('[Turn 2 - User]');
    });

    it('keeps EvidenceRetriever prompt formatting in English', () => {
        const retriever = new EvidenceRetriever();
        const prompt = retriever.formatForPrompt(
            {
                question: 'How should reranking be tuned?',
                scope: 'retrieval_strategy',
                reason: 'The exact threshold was not decided.',
            },
            [{
                turnId: 2,
                speaker: 'assistant',
                content: 'We can tune reranking after collecting metrics.',
                tokenCount: 12,
                relevanceScore: 0.7,
            }]
        );

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(prompt).toContain('[Unresolved Question]');
        expect(prompt).toContain('[Relevant Conversation Evidence - reference only]');
        expect(prompt).toContain('[Turn 2 - Assistant]');
    });

    it('keeps time prompt helpers in English', () => {
        const currentTimePrompt = buildCurrentTimePrompt();

        expect(currentTimePrompt).not.toMatch(HAN_CHARACTER_PATTERN);
        expect(currentTimePrompt).toMatch(/^Current time: \d{4}-\d{2}-\d{2}T/);
        expect(formatTimestamp(Number.NaN)).toBe('Unknown time');
        expect(formatRelativeTime(Date.now() - 2 * 60 * 60 * 1000)).toBe('2 hours ago');
        expect(formatRelativeTime(Date.now() + 1000)).toBe('Unknown time');
    });
});

function createMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
    const now = Date.now();

    return {
        id: 'memory_1',
        agentId: 'agent_1',
        layer: 'fact',
        content: 'The user prefers concise replies.',
        category: 'preference_style',
        importance: 3,
        sourceMessageIds: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
