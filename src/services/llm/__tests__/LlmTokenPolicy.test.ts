import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTPUT_MAX_TOKENS,
  getLlmTokenPolicy,
  LLM_TOKEN_POLICIES,
  SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS,
} from '../LlmTokenPolicy';

describe('LlmTokenPolicy', () => {
  it('uses 32K with a 24K parameter fallback for ordinary sub-agents', () => {
    expect(getLlmTokenPolicy('subAgent')).toEqual({
      primaryMaxTokens: 32_768,
      parameterFallbackMaxTokens: 24_576,
    });
  });

  it('uses 32K for general single-call profiles and 24K for skill audit', () => {
    expect(DEFAULT_OUTPUT_MAX_TOKENS).toBe(32_768);
    expect(SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS).toBe(24_576);
    expect(LLM_TOKEN_POLICIES.chat.primaryMaxTokens).toBe(32_768);
    expect(LLM_TOKEN_POLICIES.memory.primaryMaxTokens).toBe(32_768);
    expect(LLM_TOKEN_POLICIES.visualEnhancer.primaryMaxTokens).toBe(32_768);
    expect(LLM_TOKEN_POLICIES.skillAudit).toEqual({ primaryMaxTokens: 24_576 });
  });

  it('keeps image-generation transport on its existing 32K budget', () => {
    expect(LLM_TOKEN_POLICIES.imageGeneration).toEqual({ primaryMaxTokens: 32_768 });
  });
});
