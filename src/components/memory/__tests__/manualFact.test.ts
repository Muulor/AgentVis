import { describe, expect, it } from 'vitest';
import { buildManualFactCreateRequest, isManualFactMetadata } from '../manualFact';

describe('manualFact helpers', () => {
    it('builds a fact-layer create request with manual source metadata', () => {
        const request = buildManualFactCreateRequest({
            agentId: 'agent-1',
            content: '用户希望 Agent 避免重复解释基础概念',
            category: 'task_experience',
        });

        expect(request).toEqual({
            agentId: 'agent-1',
            layer: 'fact',
            content: '用户希望 Agent 避免重复解释基础概念',
            category: 'task_experience',
            importance: 5,
            sourceMessageIds: null,
            metadataJson: JSON.stringify({ source: 'manual' }),
        });
    });

    it('recognizes manual fact metadata and ignores malformed metadata', () => {
        expect(isManualFactMetadata(JSON.stringify({ source: 'manual' }))).toBe(true);
        expect(isManualFactMetadata(JSON.stringify({ source: 'extractor' }))).toBe(false);
        expect(isManualFactMetadata('{broken json')).toBe(false);
        expect(isManualFactMetadata(null)).toBe(false);
    });
});
