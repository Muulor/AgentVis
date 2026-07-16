import { describe, expect, it } from 'vitest';
import { isRagEmbeddingConnectionReady } from '../setupCredentialStatus';
import type { CustomEmbeddingConfig } from '@/types/rag';

const customEmbedding: CustomEmbeddingConfig = {
  providerName: 'Example',
  protocol: 'openai',
  endpointUrl: 'https://example.com/v1/embeddings',
  modelId: 'example-embedding',
  authMode: 'bearer',
};

describe('isRagEmbeddingConnectionReady', () => {
  it('requires the SiliconFlow credential in recommended mode', () => {
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'siliconflow',
        customEmbeddingConfig: customEmbedding,
        credentialConfigured: false,
      })
    ).toBe(false);
  });

  it('accepts a valid custom bearer connection only when its credential exists', () => {
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: customEmbedding,
        credentialConfigured: true,
      })
    ).toBe(true);
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: customEmbedding,
        credentialConfigured: false,
      })
    ).toBe(false);
  });

  it('accepts a valid no-auth custom connection without a stored credential', () => {
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: { ...customEmbedding, authMode: 'none' },
        credentialConfigured: false,
      })
    ).toBe(true);
  });

  it('requires the dedicated credential for a valid Gemini connection', () => {
    const geminiEmbedding: CustomEmbeddingConfig = {
      providerName: 'Google Gemini',
      protocol: 'gemini',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-embedding-2',
      authMode: 'google_api_key',
      outputDimension: 768,
    };

    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: geminiEmbedding,
        credentialConfigured: false,
      })
    ).toBe(false);
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: geminiEmbedding,
        credentialConfigured: true,
      })
    ).toBe(true);
  });

  it('rejects incomplete custom connection details regardless of authentication', () => {
    expect(
      isRagEmbeddingConnectionReady({
        mode: 'custom',
        customEmbeddingConfig: { ...customEmbedding, endpointUrl: '', authMode: 'none' },
        credentialConfigured: false,
      })
    ).toBe(false);
  });
});
