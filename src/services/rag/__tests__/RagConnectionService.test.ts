import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RagConnectionSettingsInput } from '../RagConnectionConfig';
import { useSettingsStore } from '@/stores/settingsStore';
import { ragIndexCoordinator } from '../RagIndexCoordinator';

const embeddingTestMock = vi.hoisted(() => vi.fn());
const rerankerTestMock = vi.hoisted(() => vi.fn());
const rebuildMock = vi.hoisted(() => vi.fn());
const rebuildState = vi.hoisted(() => ({ running: false }));

vi.mock('../EmbeddingService', () => ({
  embeddingService: {
    testConnection: embeddingTestMock,
    clearCache: vi.fn(),
  },
}));

vi.mock('../RerankService', () => ({
  rerankService: {
    testConnection: rerankerTestMock,
  },
}));

vi.mock('../RagIndexRebuildService', () => ({
  RagIndexRebuildError: class extends Error {},
  ragIndexRebuildService: {
    isRunning: () => rebuildState.running,
    rebuildAll: rebuildMock,
  },
}));

import {
  activateRagConnection,
  retryActiveRagIndexRebuild,
  testRagEmbeddingConnection,
  testRagRerankerConnection,
} from '../RagConnectionService';

function makeSettings(): RagConnectionSettingsInput {
  return {
    ragServiceMode: 'custom',
    customEmbeddingConfig: {
      providerName: 'Embedding provider',
      protocol: 'openai',
      endpointUrl: 'https://embedding.example.com/v1/embeddings',
      modelId: 'embed-v1',
      authMode: 'bearer',
    },
    customRerankerConfig: {
      enabled: true,
      providerName: 'Rerank provider',
      protocol: 'jina_cohere',
      endpointUrl: 'https://rerank.example.com/v1/rerank',
      modelId: 'rerank-v1',
      authMode: 'bearer',
    },
  };
}

function makeGeminiSettings(
  overrides: Partial<
    Extract<RagConnectionSettingsInput['customEmbeddingConfig'], { protocol: 'gemini' }>
  > = {}
): RagConnectionSettingsInput {
  const settings = makeSettings();
  settings.customEmbeddingConfig = {
    providerName: 'Google Gemini',
    protocol: 'gemini',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelId: 'gemini-embedding-2',
    authMode: 'google_api_key',
    outputDimension: 768,
    ...overrides,
  };
  return settings;
}

describe('RagConnectionService connection tests', () => {
  beforeEach(() => {
    const initial = makeSettings();
    useSettingsStore.getState().setRagConnectionSettings({
      mode: 'siliconflow',
      embedding: initial.customEmbeddingConfig,
      reranker: initial.customRerankerConfig,
    });
    embeddingTestMock
      .mockReset()
      .mockResolvedValue({ dimension: 3, model: 'embed-v1', latencyMs: 1 });
    rerankerTestMock
      .mockReset()
      .mockResolvedValue({ resultCount: 2, model: 'rerank-v1', latencyMs: 1 });
    rebuildMock.mockReset().mockResolvedValue({
      profileId: 'custom-profile',
      rebuiltChunkCount: 0,
      skippedChunkCount: 0,
      rebuiltAgentCount: 0,
      totalAgentCount: 0,
    });
    rebuildState.running = false;
  });

  it('tests embedding even when the independent reranker draft is incomplete', async () => {
    const settings = makeSettings();
    settings.customRerankerConfig.endpointUrl = '';
    await expect(testRagEmbeddingConnection(settings)).resolves.toMatchObject({ dimension: 3 });
    expect(embeddingTestMock).toHaveBeenCalledTimes(1);
  });

  it('tests reranker even when the independent embedding draft is incomplete', async () => {
    const settings = makeSettings();
    settings.customEmbeddingConfig.endpointUrl = '';
    await expect(testRagRerankerConnection(settings)).resolves.toMatchObject({ resultCount: 2 });
    expect(rerankerTestMock).toHaveBeenCalledTimes(1);
  });

  it('rejects activation and retry calls that overlap an activation pre-test', async () => {
    let releaseTest:
      | ((value: { dimension: number; model: string; latencyMs: number }) => void)
      | undefined;
    embeddingTestMock.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseTest = resolve;
      })
    );
    const settings = makeSettings();
    const first = activateRagConnection(settings);

    await expect(activateRagConnection(settings)).rejects.toThrow(
      'RAG_CONNECTION_ACTIVATION_IN_PROGRESS'
    );
    await expect(retryActiveRagIndexRebuild()).rejects.toThrow(
      'RAG_CONNECTION_ACTIVATION_IN_PROGRESS'
    );

    releaseTest?.({ dimension: 3, model: 'embed-v1', latencyMs: 1 });
    await first;
  });

  it('waits for an active vector writer before committing the target profile', async () => {
    const writer = await ragIndexCoordinator.acquireWriter();
    const activation = activateRagConnection(makeSettings());

    await Promise.resolve();
    await Promise.resolve();
    expect(useSettingsStore.getState().ragServiceMode).toBe('siliconflow');

    writer.release();
    await activation;
    expect(useSettingsStore.getState().ragServiceMode).toBe('custom');
  });

  it('rejects every settings activation while an index rebuild is running', async () => {
    rebuildState.running = true;
    await expect(activateRagConnection(makeSettings())).rejects.toThrow(
      'RAG_CONNECTION_ACTIVATION_IN_PROGRESS'
    );
  });

  it('rebuilds with the target Gemini profile and tested dimension when switching from OpenAI', async () => {
    const active = makeSettings();
    useSettingsStore.getState().setRagConnectionSettings({
      mode: active.ragServiceMode,
      embedding: active.customEmbeddingConfig,
      reranker: active.customRerankerConfig,
    });
    const target = makeGeminiSettings();

    const result = await activateRagConnection(target, {
      testEmbedding: false,
      expectedEmbeddingDimension: 768,
    });

    expect(result.embeddingProfileChanged).toBe(true);
    expect(result.activeProfileId).toMatch(
      /^rag-embedding:v1:custom:gemini-native-v1:[a-f0-9]{32}$/
    );
    expect(rebuildMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          protocol: 'gemini',
          modelId: 'gemini-embedding-2',
          outputDimension: 768,
          profileId: result.activeProfileId,
        }),
        expectedDimension: 768,
      })
    );
  });

  it('rebuilds with the target OpenAI profile when switching back from Gemini', async () => {
    const active = makeGeminiSettings();
    useSettingsStore.getState().setRagConnectionSettings({
      mode: active.ragServiceMode,
      embedding: active.customEmbeddingConfig,
      reranker: active.customRerankerConfig,
    });
    const target = makeSettings();

    const result = await activateRagConnection(target, {
      testEmbedding: false,
      expectedEmbeddingDimension: 3,
    });

    expect(result.embeddingProfileChanged).toBe(true);
    expect(rebuildMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          protocol: 'openai',
          modelId: 'embed-v1',
          profileId: result.activeProfileId,
        }),
        expectedDimension: 3,
      })
    );
  });

  it.each([
    {
      label: 'model',
      target: { modelId: 'gemini-embedding-001' as const },
      expectedModel: 'gemini-embedding-001',
      expectedDimension: 768,
    },
    {
      label: 'dimension',
      target: { outputDimension: 1536 as const },
      expectedModel: 'gemini-embedding-2',
      expectedDimension: 1536,
    },
  ])(
    'rebuilds a new Gemini profile when the $label changes',
    async ({ target, expectedModel, expectedDimension }) => {
      const active = makeGeminiSettings();
      useSettingsStore.getState().setRagConnectionSettings({
        mode: active.ragServiceMode,
        embedding: active.customEmbeddingConfig,
        reranker: active.customRerankerConfig,
      });
      const next = makeGeminiSettings(target);

      const result = await activateRagConnection(next, {
        testEmbedding: false,
        expectedEmbeddingDimension: expectedDimension,
      });

      expect(result.embeddingProfileChanged).toBe(true);
      expect(rebuildMock).toHaveBeenCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({
            protocol: 'gemini',
            modelId: expectedModel,
            outputDimension: expectedDimension,
            profileId: result.activeProfileId,
          }),
          expectedDimension,
        })
      );
    }
  );

  it('applies a same-profile OpenAI metadata change without testing or rebuilding', async () => {
    const active = makeSettings();
    useSettingsStore.getState().setRagConnectionSettings({
      mode: active.ragServiceMode,
      embedding: active.customEmbeddingConfig,
      reranker: active.customRerankerConfig,
    });
    const next = makeSettings();
    next.customEmbeddingConfig.providerName = 'Renamed provider';

    const result = await activateRagConnection(next);

    expect(result.embeddingProfileChanged).toBe(false);
    expect(result.rebuild).toBeNull();
    expect(embeddingTestMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().customEmbeddingConfig.providerName).toBe('Renamed provider');
  });
});
