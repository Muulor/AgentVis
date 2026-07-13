import { describe, expect, it } from 'vitest';
import type { Token } from 'prism-react-renderer';
import {
  applyDiffBlockSyntaxTokenBudget,
  MAX_DIFF_BLOCK_SYNTAX_TOKENS,
} from '../DiffBlockTokenBudget';

function createTokens(count: number): Token[] {
  return Array.from({ length: count }, () => ({
    content: 'x',
    types: ['plain'],
  }));
}

describe('DiffBlock syntax token budget', () => {
  it('bounds the cumulative token DOM for a 32-line virtual block', () => {
    const tokenLines = Array.from({ length: 32 }, () => createTokens(503));

    const bounded = applyDiffBlockSyntaxTokenBudget(tokenLines);
    const renderedTokenCount = bounded.reduce((total, tokens) => total + (tokens?.length ?? 0), 0);

    expect(renderedTokenCount).toBeLessThanOrEqual(MAX_DIFF_BLOCK_SYNTAX_TOKENS);
    expect(renderedTokenCount).toBeLessThan(32 * 503);
    expect(bounded.some((tokens) => tokens === undefined)).toBe(true);
  });
});
