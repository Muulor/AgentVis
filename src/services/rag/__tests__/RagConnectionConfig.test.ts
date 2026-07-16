import { describe, expect, it } from 'vitest';
import type {
  CustomEmbeddingConfig,
  CustomGeminiEmbeddingConfig,
  CustomRerankerConfig,
} from '@/types/rag';
import {
  buildCustomEmbeddingProfileId,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
  GEMINI_EMBEDDING_ENDPOINT,
  isCustomEmbeddingConfigValid,
  isCustomRerankerConfigValid,
  normalizeCustomEmbeddingConfig,
  normalizeRagEndpointUrl,
  resolveRagEmbeddingRoute,
  SILICONFLOW_EMBEDDING_PROFILE_ID,
} from '../RagConnectionConfig';

const baseEmbedding: CustomEmbeddingConfig = {
  providerName: 'Example',
  protocol: 'openai',
  endpointUrl: 'https://api.example.com/v1/embeddings',
  modelId: 'example/embed-v1',
  authMode: 'bearer',
};

const baseGeminiEmbedding: CustomGeminiEmbeddingConfig = {
  providerName: 'Google Gemini',
  protocol: 'gemini',
  endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
  modelId: 'gemini-embedding-2',
  authMode: 'google_api_key',
  outputDimension: 768,
};

describe('RagConnectionConfig', () => {
  it('uses the fixed built-in SiliconFlow profile', () => {
    expect(
      resolveRagEmbeddingRoute({
        ragServiceMode: 'siliconflow',
        customEmbeddingConfig: baseEmbedding,
        customRerankerConfig: {} as CustomRerankerConfig,
      }).profileId
    ).toBe(SILICONFLOW_EMBEDDING_PROFILE_ID);
  });

  it('builds a short stable fingerprint and isolates endpoint/model changes', () => {
    const first = buildCustomEmbeddingProfileId(baseEmbedding);
    const canonicalEquivalent = buildCustomEmbeddingProfileId({
      ...baseEmbedding,
      endpointUrl: ' https://API.EXAMPLE.COM/v1/embeddings/ ',
    });
    const changedEndpoint = buildCustomEmbeddingProfileId({
      ...baseEmbedding,
      endpointUrl: 'https://api.example.com/v2/embeddings',
    });
    const changedModel = buildCustomEmbeddingProfileId({
      ...baseEmbedding,
      modelId: 'example/embed-v2',
    });
    const changedDisplayAndAuth = buildCustomEmbeddingProfileId({
      ...baseEmbedding,
      providerName: 'Renamed provider',
      authMode: 'none',
    });

    expect(first).toBe(canonicalEquivalent);
    expect(first).toBe('rag-embedding:v1:custom:6c37e210fff7ef71bfb68bcdb5eb79f7');
    expect(first).toMatch(/^rag-embedding:v1:custom:[a-f0-9]{32}$/);
    expect(first.length).toBeLessThan(80);
    expect(changedEndpoint).not.toBe(first);
    expect(changedModel).not.toBe(first);
    expect(changedDisplayAndAuth).toBe(first);
  });

  it('uses a versioned Gemini-native fingerprint with model and dimension isolation', () => {
    const first = buildCustomEmbeddingProfileId(baseGeminiEmbedding);
    const changedDimension = buildCustomEmbeddingProfileId({
      ...baseGeminiEmbedding,
      outputDimension: 1536,
    });
    const changedModel = buildCustomEmbeddingProfileId({
      ...baseGeminiEmbedding,
      modelId: 'gemini-embedding-001' as const,
    });
    const changedDisplayAndEndpoint = buildCustomEmbeddingProfileId({
      ...baseGeminiEmbedding,
      providerName: 'Renamed',
      endpointUrl: 'https://example.invalid/v1',
    });

    expect(first).toMatch(/^rag-embedding:v1:custom:gemini-native-v1:[a-f0-9]{32}$/);
    expect(first).toBe('rag-embedding:v1:custom:gemini-native-v1:45e310f13014a41976787a5e1b296d90');
    expect(changedDimension).not.toBe(first);
    expect(changedModel).not.toBe(first);
    expect(changedDisplayAndEndpoint).toBe(first);
  });

  it('allows HTTP only for loopback endpoints and rejects fragments/userinfo', () => {
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: 'http://127.0.0.2:8080/v1/embeddings',
        authMode: 'none',
      })
    ).toBe(true);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: 'http://api.example.com/v1/embeddings',
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: 'http://127.attacker.example/v1/embeddings',
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: 'https://user:secret@api.example.com/v1/embeddings',
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: 'https://api.example.com/v1/embeddings#fragment',
      })
    ).toBe(false);
  });

  it('enforces backend endpoint and model limits before activation', () => {
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        modelId: 'm'.repeat(257),
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        endpointUrl: `https://api.example.com/${'x'.repeat(2048)}`,
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        modelId: 'embed\u0000model',
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseEmbedding,
        modelId: 'embed\u0085model',
      })
    ).toBe(false);
  });

  it('normalizes nested partial config field-by-field without discarding siblings', () => {
    const normalized = normalizeCustomEmbeddingConfig(
      { modelId: '  replacement-model  ' },
      baseEmbedding
    );
    expect(normalized).toEqual({
      ...baseEmbedding,
      endpointUrl: normalizeRagEndpointUrl(baseEmbedding.endpointUrl),
      modelId: 'replacement-model',
    });
  });

  it('normalizes Gemini to its fixed endpoint, API-key auth, allowlist, and defaults', () => {
    const normalized = normalizeCustomEmbeddingConfig({
      protocol: 'gemini',
      providerName: 'Untrusted display name',
      endpointUrl: 'https://example.invalid/embeddings',
      authMode: 'none',
    });

    expect(normalized).toEqual({
      providerName: 'Google Gemini',
      protocol: 'gemini',
      endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
      modelId: DEFAULT_GEMINI_EMBEDDING_MODEL,
      authMode: 'google_api_key',
      outputDimension: DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
    });
    expect(isCustomEmbeddingConfigValid(normalized)).toBe(true);
  });

  it('rejects unsupported Gemini models and dimensions before activation', () => {
    expect(
      isCustomEmbeddingConfigValid({
        ...baseGeminiEmbedding,
        modelId: 'text-embedding-004',
      })
    ).toBe(false);
    expect(
      isCustomEmbeddingConfigValid({
        ...baseGeminiEmbedding,
        outputDimension: 1024,
      })
    ).toBe(false);
  });

  it('falls legacy and unknown stored protocols back to OpenAI semantics', () => {
    expect(
      normalizeCustomEmbeddingConfig({
        providerName: 'Legacy provider',
        endpointUrl: 'https://legacy.example/v1/embeddings',
        modelId: 'legacy-model',
        authMode: 'bearer',
      })
    ).toEqual({
      providerName: 'Legacy provider',
      protocol: 'openai',
      endpointUrl: 'https://legacy.example/v1/embeddings',
      modelId: 'legacy-model',
      authMode: 'bearer',
    });
    expect(
      normalizeCustomEmbeddingConfig({
        protocol: 'unknown',
        endpointUrl: 'https://unknown.example/v1/embeddings',
        modelId: 'unknown-model',
      }).protocol
    ).toBe('openai');
  });

  it('resolves Gemini with only fixed native request fields', () => {
    const route = resolveRagEmbeddingRoute({
      ragServiceMode: 'custom',
      customEmbeddingConfig: {
        ...baseGeminiEmbedding,
        endpointUrl: 'https://example.invalid/v1',
      },
      customRerankerConfig: {} as CustomRerankerConfig,
    });

    expect(route).toMatchObject({
      mode: 'custom',
      provider: 'custom',
      protocol: 'gemini',
      endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
      modelId: 'gemini-embedding-2',
      authMode: 'google_api_key',
      outputDimension: 768,
    });
  });

  it('treats a disabled custom reranker as valid without endpoint details', () => {
    expect(isCustomRerankerConfigValid({ enabled: false })).toBe(true);
    expect(isCustomRerankerConfigValid({ enabled: true })).toBe(false);
  });
});
