import { describe, expect, it } from 'vitest';
import type { CustomEmbeddingConfig } from '@/types/rag';
import { getCustomEmbeddingCredentialKind, shouldApplyCredentialRefresh } from '../SetupChecklist';

describe('getCustomEmbeddingCredentialKind', () => {
  it('keeps OpenAI and Gemini Embedding credentials in separate fixed slots', () => {
    const openAiConfig: CustomEmbeddingConfig = {
      providerName: 'Example',
      protocol: 'openai',
      endpointUrl: 'https://example.com/v1/embeddings',
      modelId: 'example-embedding',
      authMode: 'bearer',
    };
    const geminiConfig: CustomEmbeddingConfig = {
      providerName: 'Google Gemini',
      protocol: 'gemini',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-embedding-2',
      authMode: 'google_api_key',
      outputDimension: 768,
    };

    expect(getCustomEmbeddingCredentialKind(openAiConfig)).toBe('embedding');
    expect(getCustomEmbeddingCredentialKind(geminiConfig)).toBe('gemini_embedding');
  });
});

describe('SetupChecklist credential refresh concurrency guard', () => {
  it('accepts only the latest credential request result', () => {
    expect(shouldApplyCredentialRefresh(7, 7)).toBe(true);
    expect(shouldApplyCredentialRefresh(6, 7)).toBe(false);
  });
});
