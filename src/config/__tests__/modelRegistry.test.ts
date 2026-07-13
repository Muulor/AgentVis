/**
 * Model registry capability invariants.
 */

import { describe, expect, it } from 'vitest';
import {
  getContextWindowSize,
  getProviders,
  getUnregisteredSharedReasoningOutputBudgetRoutes,
  modelUsesSharedReasoningOutputBudget,
} from '../modelRegistry';

describe('modelRegistry context windows', () => {
  it('resolves duplicate model IDs by provider route', () => {
    expect(getContextWindowSize('gpt-5.4', 'openai')).toBe(1_050_000);
    expect(getContextWindowSize('gpt-5.4', 'local')).toBe(400_000);
    expect(getContextWindowSize('MiniMax-M3', 'minimax')).toBe(1_000_000);
    expect(getContextWindowSize('MiniMax-M3', 'volcengine')).toBe(512_000);
  });

  it('keeps model-only callers backward compatible', () => {
    expect(getContextWindowSize('gpt-5.4')).toBe(1_050_000);
  });

  it('does not borrow a same-named model window from another provider', () => {
    expect(getContextWindowSize('gpt-5.4', 'unknown-provider')).toBe(128_000);
  });
});

describe('modelRegistry provider protocols', () => {
  it('routes the Xiaomi token plan through its OpenAI-compatible endpoint', () => {
    expect(getProviders().find((provider) => provider.id === 'xiaomi-mimo')?.protocol).toBe(
      'openai'
    );
  });
});

describe('modelRegistry reasoning output budget capabilities', () => {
  it('keeps every shared-reasoning route attached to a built-in model', () => {
    expect(getUnregisteredSharedReasoningOutputBudgetRoutes()).toEqual([]);
  });

  it('recognizes case-sensitive provider model IDs after route normalization', () => {
    expect(modelUsesSharedReasoningOutputBudget('Kimi-K2.7-Code', 'volcengine')).toBe(true);
    expect(modelUsesSharedReasoningOutputBudget('MiniMax-M3', 'volcengine')).toBe(true);
  });

  it('keeps compatible local routes opt-in instead of inferring reasoning by model ID', () => {
    expect(modelUsesSharedReasoningOutputBudget('Kimi-K2.7-Code', 'local')).toBe(false);
    expect(modelUsesSharedReasoningOutputBudget('MiniMax-M3', 'local')).toBe(false);
  });
});
