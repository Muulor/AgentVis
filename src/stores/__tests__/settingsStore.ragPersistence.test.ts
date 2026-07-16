/**
 * Regression coverage for persisted RAG connection settings.
 *
 * The storage fixture intentionally omits the Embedding protocol to represent
 * the OpenAI-compatible shape written before protocol selection was added.
 */

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const memoryStorage: Record<string, string> = {
    'agentvis-settings': JSON.stringify({
      state: {
        ragServiceMode: 'custom',
        ragTopK: 9,
        customEmbeddingConfig: {
          providerName: 'Example',
          endpointUrl: 'https://api.example.com/v1/embeddings',
          modelId: 'example/embed-v1',
          authMode: 'bearer',
        },
      },
    }),
  };

  globalThis.localStorage = {
    getItem: (key: string) => memoryStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage[key] = value;
    },
    removeItem: (key: string) => {
      Reflect.deleteProperty(memoryStorage, key);
    },
    clear: () => {
      Object.keys(memoryStorage).forEach((key) => Reflect.deleteProperty(memoryStorage, key));
    },
    get length() {
      return Object.keys(memoryStorage).length;
    },
    key: (index: number) => Object.keys(memoryStorage)[index] ?? null,
  } as Storage;
});

import { resolveRagEmbeddingRoute } from '@/services/rag/RagConnectionConfig';
import { useSettingsStore } from '../settingsStore';

describe('settingsStore persisted RAG migration', () => {
  it('hydrates a legacy OpenAI-compatible connection without changing its fields or profile', () => {
    const state = useSettingsStore.getState();

    expect(state.ragServiceMode).toBe('custom');
    expect(state.ragTopK).toBe(9);
    expect(state.customEmbeddingConfig).toEqual({
      providerName: 'Example',
      protocol: 'openai',
      endpointUrl: 'https://api.example.com/v1/embeddings',
      modelId: 'example/embed-v1',
      authMode: 'bearer',
    });
    expect(resolveRagEmbeddingRoute(state).profileId).toBe(
      'rag-embedding:v1:custom:6c37e210fff7ef71bfb68bcdb5eb79f7'
    );
  });
});
