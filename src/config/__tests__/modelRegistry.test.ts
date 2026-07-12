/**
 * Model registry capability invariants.
 */

import { describe, expect, it } from 'vitest';
import {
  getProviders,
  getUnregisteredSharedReasoningOutputBudgetRoutes,
  modelUsesSharedReasoningOutputBudget,
} from '../modelRegistry';

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
