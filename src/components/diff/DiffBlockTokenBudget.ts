/**
 * DiffBlockTokenBudget - cumulative syntax-token DOM budget for one virtual Diff block.
 */

import type { Token } from 'prism-react-renderer';

export const MAX_DIFF_BLOCK_SYNTAX_TOKENS = 2048;

export function applyDiffBlockSyntaxTokenBudget(
  tokenLines: readonly (Token[] | undefined)[],
  maxTokens: number = MAX_DIFF_BLOCK_SYNTAX_TOKENS
): Array<Token[] | undefined> {
  let remainingTokens = Math.max(0, Math.floor(maxTokens));

  return tokenLines.map((tokens) => {
    if (!tokens || tokens.length === 0) return tokens;
    if (tokens.length > remainingTokens) return undefined;

    remainingTokens -= tokens.length;
    return tokens;
  });
}
