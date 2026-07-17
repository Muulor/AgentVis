/**
 * Model registry capability invariants.
 */

import { describe, expect, it } from 'vitest';
import {
  getContextWindowSize,
  getModelsByProvider,
  getProviders,
  getSupportedReasoningPresets,
  getUnregisteredReasoningPresetRoutes,
  getUnregisteredSharedReasoningOutputBudgetRoutes,
  modelUsesSharedReasoningOutputBudget,
  normalizeReasoningPreset,
} from '../modelRegistry';

describe('modelRegistry context windows', () => {
  it('keeps the canonical provider model IDs for the GPT-5.6 family', () => {
    const openAiModelIds = getModelsByProvider('openai').map((model) => model.id);

    expect(openAiModelIds).toContain('gpt-5.6-sol');
    expect(openAiModelIds).toContain('gpt-5.6-terra');
    expect(openAiModelIds).toContain('gpt-5.6-luna');
  });

  it('resolves duplicate model IDs by provider route', () => {
    expect(getContextWindowSize('gpt-5.4', 'openai')).toBe(1_050_000);
    expect(getContextWindowSize('gpt-5.4', 'local')).toBe(400_000);
    expect(getContextWindowSize('MiniMax-M3', 'minimax')).toBe(1_000_000);
    expect(getContextWindowSize('MiniMax-M3', 'volcengine')).toBe(512_000);
  });

  it('registers the OpenRouter Step 3.7 Flash route with its exact context window', () => {
    expect(getContextWindowSize('stepfun/step-3.7-flash', 'openrouter')).toBe(256_000);
    expect(getModelsByProvider('openrouter').map((model) => model.id)).toContain(
      'stepfun/step-3.7-flash'
    );
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
    expect(modelUsesSharedReasoningOutputBudget('MiniMax-M3', 'minimax')).toBe(true);
    expect(modelUsesSharedReasoningOutputBudget('GLM-5.1', 'zhipu-coding')).toBe(true);
    expect(modelUsesSharedReasoningOutputBudget('GLM-5.2', 'zhipu-coding')).toBe(true);
    expect(modelUsesSharedReasoningOutputBudget('xiaomi/mimo-v2.5', 'openrouter')).toBe(true);
    expect(modelUsesSharedReasoningOutputBudget('stepfun/step-3.7-flash', 'openrouter')).toBe(true);
  });

  it('keeps compatible local routes opt-in instead of inferring reasoning by model ID', () => {
    expect(modelUsesSharedReasoningOutputBudget('Kimi-K2.7-Code', 'local')).toBe(false);
    expect(modelUsesSharedReasoningOutputBudget('MiniMax-M3', 'local')).toBe(false);
  });
});

describe('modelRegistry reasoning preset capabilities', () => {
  it('keeps every configurable reasoning route attached to a built-in model', () => {
    expect(getUnregisteredReasoningPresetRoutes()).toEqual([]);
  });

  it('exposes only distinct verified levels for provider-scoped routes', () => {
    expect(getSupportedReasoningPresets('openai', 'gpt-5.4')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.4-mini')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.4-nano')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.5')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.6-sol')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.6-terra')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedReasoningPresets('openai', 'gpt-5.6-luna')).toEqual([
      'recommended',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedReasoningPresets('anthropic', 'claude-sonnet-4-6')).toEqual([
      'recommended',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(getSupportedReasoningPresets('deepseek', 'deepseek-v4-pro')).toEqual([
      'recommended',
      'none',
      'high',
      'max',
    ]);
    expect(getSupportedReasoningPresets('volcengine', 'deepseek-v4-pro')).toEqual([
      'recommended',
      'none',
      'high',
      'max',
    ]);
    expect(getSupportedReasoningPresets('volcengine', 'kimi-k2.6')).toEqual([
      'recommended',
      'none',
    ]);
    expect(getSupportedReasoningPresets('volcengine', 'Kimi-K2.7-Code')).toEqual(['recommended']);
    expect(getSupportedReasoningPresets('volcengine', 'MiniMax-M3')).toEqual([
      'recommended',
      'none',
    ]);
    expect(getSupportedReasoningPresets('stepfun', 'step-3.7-flash')).toEqual([
      'recommended',
      'low',
      'medium',
      'high',
    ]);
    expect(getSupportedReasoningPresets('zhipu', 'glm-5.1')).toEqual(['recommended', 'none']);
    expect(getSupportedReasoningPresets('zhipu-coding', 'GLM-5.1')).toEqual([
      'recommended',
      'none',
    ]);
    expect(getSupportedReasoningPresets('zhipu-coding', 'GLM-5.2')).toEqual([
      'recommended',
      'none',
      'high',
      'max',
    ]);
    expect(getSupportedReasoningPresets('minimax', 'MiniMax-M3')).toEqual([
      'recommended',
      'none',
      'high',
    ]);
    expect(getSupportedReasoningPresets('openrouter', 'xiaomi/mimo-v2.5')).toEqual([
      'recommended',
      'none',
    ]);
    expect(getSupportedReasoningPresets('openrouter', 'minimax/minimax-m3')).toEqual([
      'recommended',
      'none',
    ]);
    expect(getSupportedReasoningPresets('openrouter', 'stepfun/step-3.7-flash')).toEqual([
      'recommended',
      'low',
      'medium',
      'high',
    ]);
  });

  it('keeps local, custom, and unverified routes recommended-only', () => {
    expect(getSupportedReasoningPresets('local', 'gpt-5.4')).toEqual(['recommended']);
    expect(getSupportedReasoningPresets('openrouter', 'vendor/unverified-reasoning-model')).toEqual(
      ['recommended']
    );
    expect(getSupportedReasoningPresets('zhipu-coding', 'GLM-4.7')).toEqual(['recommended']);
    expect(getSupportedReasoningPresets('minimax', 'MiniMax-M2.7')).toEqual(['recommended']);
    expect(getSupportedReasoningPresets('openai', 'user-model')).toEqual(['recommended']);
  });

  it('resets stale or unsupported persisted selections to recommended', () => {
    expect(normalizeReasoningPreset('openai', 'gpt-5.5', 'xhigh')).toBe('xhigh');
    expect(normalizeReasoningPreset('openai', 'gpt-5.4', 'minimal')).toBe('recommended');
    expect(normalizeReasoningPreset('anthropic', 'claude-sonnet-4-6', 'xhigh')).toBe('recommended');
    expect(normalizeReasoningPreset('deepseek', 'deepseek-v4-pro', 'none')).toBe('none');
    expect(normalizeReasoningPreset('minimax', 'MiniMax-M3', 'none')).toBe('none');
    expect(normalizeReasoningPreset('minimax', 'MiniMax-M2.7', 'none')).toBe('recommended');
    expect(normalizeReasoningPreset('volcengine', 'MiniMax-M3', 'none')).toBe('none');
    expect(normalizeReasoningPreset('zhipu-coding', 'GLM-5.2', 'max')).toBe('max');
    expect(normalizeReasoningPreset('openrouter', 'xiaomi/mimo-v2.5', 'none')).toBe('none');
    expect(normalizeReasoningPreset('openrouter', 'xiaomi/mimo-v2.5', 'high')).toBe('recommended');
    expect(normalizeReasoningPreset('openrouter', 'minimax/minimax-m3', 'high')).toBe(
      'recommended'
    );
    expect(normalizeReasoningPreset('openrouter', 'stepfun/step-3.7-flash', 'none')).toBe(
      'recommended'
    );
    expect(normalizeReasoningPreset('volcengine', 'Kimi-K2.7-Code', 'none')).toBe('recommended');
    expect(normalizeReasoningPreset('volcengine', 'Kimi-K2.7-Code', 'high')).toBe('recommended');
    expect(normalizeReasoningPreset('gemini', 'gemini-3.1-pro-preview', 'minimal')).toBe(
      'recommended'
    );
    expect(normalizeReasoningPreset('local', 'gpt-5.4', 'high')).toBe('recommended');
    expect(normalizeReasoningPreset('openai', 'gpt-5.4', null)).toBe('recommended');
  });
});
