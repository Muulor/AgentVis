import { describe, expect, it } from 'vitest';
import {
    appendUniqueContextToken,
    buildDisplayContent,
    buildContextTokenPrefix,
    removeContextToken,
    type InputContextToken,
} from '../inputContextTokens';

const skillToken: InputContextToken = {
    id: 'skill:Marketing-Ideas',
    type: 'skill',
    label: 'Marketing-Ideas',
    semanticText: 'Use Marketing-Ideas:',
};

describe('inputContextTokens', () => {
    it('appends tokens without duplicating ids', () => {
        const tokens = appendUniqueContextToken([], skillToken);
        expect(appendUniqueContextToken(tokens, skillToken)).toEqual(tokens);
    });

    it('removes tokens by id', () => {
        expect(removeContextToken([skillToken], 'skill:Marketing-Ideas')).toEqual([]);
    });

    it('builds a stable semantic prefix for agent input', () => {
        const secondToken: InputContextToken = {
            id: 'skill:theme-factory',
            type: 'skill',
            label: 'theme-factory',
            semanticText: 'Use theme-factory:',
        };

        expect(buildContextTokenPrefix([skillToken, secondToken])).toBe(
            'Use Marketing-Ideas: Use theme-factory:'
        );
    });

    it('builds display content from text and token parts', () => {
        expect(buildDisplayContent([
            { type: 'text', text: 'Read ' },
            { type: 'token', token: skillToken },
            { type: 'text', text: ' please' },
        ])).toBe('Read Marketing-Ideas please');
    });
});
