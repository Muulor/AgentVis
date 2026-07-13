/**
 * Provider-neutral context token estimator tests.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateGeneratedTokens,
  estimateRequestTokens,
  estimateTextTokens,
  normalizeReportedTokenCount,
} from '../tokenEstimator';

describe('tokenEstimator', () => {
  it('uses the shared mixed-language heuristic', () => {
    expect(estimateTextTokens('你好')).toBe(2);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('你好abcd')).toBe(3);
  });

  it('counts protocol fields, reasoning and tool calls', () => {
    const base = estimateRequestTokens([{ role: 'assistant', content: 'done' }]);
    const rich = estimateRequestTokens([
      {
        role: 'assistant',
        content: 'done',
        reasoningContent: 'reason',
        toolCalls: [{ name: 'read', args: { path: 'README.md' }, id: 'call-1' }],
      },
    ]);

    expect(rich).toBeGreaterThan(base);
    expect(
      estimateGeneratedTokens({
        content: 'done',
        reasoningContent: 'reason',
        toolCalls: [{ name: 'read', args: { path: 'README.md' } }],
      })
    ).toBeGreaterThan(estimateTextTokens('done'));
  });

  it('uses a fixed media estimate instead of base64 length', () => {
    const shortImage = estimateRequestTokens([
      { role: 'user', content: 'inspect', images: [{ data: 'a' }] },
    ]);
    const longImage = estimateRequestTokens([
      { role: 'user', content: 'inspect', images: [{ data: 'a'.repeat(100_000) }] },
    ]);

    expect(shortImage).toBe(longImage);
    expect(shortImage).toBeGreaterThanOrEqual(DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it('counts tool definitions from the final request', () => {
    const withoutTools = estimateRequestTokens([{ role: 'user', content: 'read it' }]);
    const withTools = estimateRequestTokens([{ role: 'user', content: 'read it' }], {
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    });

    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it('restores backend-staged large file content from retained size metadata', () => {
    const compactReference = estimateGeneratedTokens({
      toolCalls: [{ name: 'file_write', args: { contentStaged: true } }],
    });
    const stagedLargeContent = estimateGeneratedTokens({
      toolCalls: [
        {
          name: 'file_write',
          args: {
            content: '[Large file_write content staged before WebView IPC]',
            contentStaged: true,
            contentBytes: 90_000,
            contentChars: 90_000,
          },
        },
      ],
    });

    expect(stagedLargeContent).toBeGreaterThan(compactReference + 20_000);
  });

  it('preserves valid provider-reported zero values', () => {
    expect(normalizeReportedTokenCount(0)).toBe(0);
    expect(normalizeReportedTokenCount(12.9)).toBe(12);
    expect(normalizeReportedTokenCount(-1)).toBeUndefined();
    expect(normalizeReportedTokenCount(Number.NaN)).toBeUndefined();
  });
});
