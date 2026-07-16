/**
 * RAG connection routing and profile helpers.
 *
 * Non-secret settings live in settingsStore. API keys stay in the fixed Rust
 * credential slots selected by the resolved route's provider and purpose.
 */

import {
  DEFAULT_GEMINI_EMBEDDING_CONFIG,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
  GEMINI_EMBEDDING_ENDPOINT,
  GEMINI_EMBEDDING_MODELS,
  GEMINI_EMBEDDING_OUTPUT_DIMENSIONS,
  normalizeCustomEmbeddingConfig,
  normalizeCustomRerankerConfig,
  normalizeRagEndpointUrl,
  normalizeRagServiceMode,
  useSettingsStore,
  type SettingsState,
} from '@/stores/settingsStore';
import type {
  CustomEmbeddingConfig,
  CustomRerankerConfig,
  EmbeddingPurpose,
  GeminiEmbeddingOutputDimension,
  RagEndpointAuthMode,
  RagServiceMode,
} from '@/types/rag';

export const SILICONFLOW_EMBEDDING_MODEL = 'BAAI/bge-m3';
export const SILICONFLOW_RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3';
export const SILICONFLOW_EMBEDDING_ENDPOINT = 'https://api.siliconflow.cn/v1/embeddings';
export const SILICONFLOW_RERANKER_ENDPOINT = 'https://api.siliconflow.cn/v1/rerank';
export const SILICONFLOW_EMBEDDING_PROFILE_ID = 'rag-embedding:v1:siliconflow:BAAI/bge-m3';
export const GEMINI_EMBEDDING_API_VERSION = 'v1beta';
export const GEMINI_EMBEDDING_PROFILE_STRATEGY = 'gemini-native-v1';
export const GEMINI_EMBEDDING_PURPOSE_POLICY = 'gemini-purpose-policy-v1';

export interface RagConnectionSettingsInput {
  ragServiceMode: RagServiceMode;
  customEmbeddingConfig: CustomEmbeddingConfig;
  customRerankerConfig: CustomRerankerConfig;
}

interface ResolvedEmbeddingRouteBase {
  mode: RagServiceMode;
  provider: 'siliconflow' | 'custom';
  modelId: string;
  profileId: string;
}

export interface ResolvedOpenAiEmbeddingRoute extends ResolvedEmbeddingRouteBase {
  protocol: 'openai';
  endpointUrl?: string;
  authMode: Exclude<RagEndpointAuthMode, 'google_api_key'>;
  outputDimension?: never;
}

export interface ResolvedGeminiEmbeddingRoute extends ResolvedEmbeddingRouteBase {
  mode: 'custom';
  provider: 'custom';
  protocol: 'gemini';
  endpointUrl: string;
  authMode: 'google_api_key';
  outputDimension: GeminiEmbeddingOutputDimension;
}

export type ResolvedEmbeddingRoute = ResolvedOpenAiEmbeddingRoute | ResolvedGeminiEmbeddingRoute;

export interface ResolvedRerankerRoute {
  mode: RagServiceMode;
  enabled: boolean;
  provider: 'siliconflow' | 'custom';
  protocol: 'jina_cohere' | 'voyage';
  endpointUrl?: string;
  modelId: string;
  authMode: Exclude<RagEndpointAuthMode, 'google_api_key'>;
}

type SettingsSource = Pick<
  SettingsState,
  'ragServiceMode' | 'customEmbeddingConfig' | 'customRerankerConfig'
>;

export function normalizeRagConnectionSettings(value: {
  ragServiceMode?: unknown;
  customEmbeddingConfig?: unknown;
  customRerankerConfig?: unknown;
}): RagConnectionSettingsInput {
  return {
    ragServiceMode: normalizeRagServiceMode(value.ragServiceMode),
    customEmbeddingConfig: normalizeCustomEmbeddingConfig(value.customEmbeddingConfig),
    customRerankerConfig: normalizeCustomRerankerConfig(value.customRerankerConfig),
  };
}

export function getRagConnectionSettingsSnapshot(): RagConnectionSettingsInput {
  const state = useSettingsStore.getState();
  return normalizeRagConnectionSettings(state);
}

function isValidEndpointUrl(endpointUrl: string): boolean {
  if (endpointUrl.length > 2048 || hasControlCharacters(endpointUrl)) return false;
  try {
    const url = new URL(endpointUrl);
    const host = url.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || isIpv4LoopbackHost(host) || host === '[::1]';
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isIpv4LoopbackHost(host: string): boolean {
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export function isCustomEmbeddingConfigValid(value: unknown): boolean {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const rawEndpoint = typeof input.endpointUrl === 'string' ? input.endpointUrl : '';
  const rawModel = typeof input.modelId === 'string' ? input.modelId : '';
  if (hasControlCharacters(rawEndpoint) || hasControlCharacters(rawModel)) return false;
  const config = normalizeCustomEmbeddingConfig(value);

  if (config.protocol === 'gemini') {
    if (
      (input.modelId !== undefined && !isGeminiEmbeddingModel(input.modelId)) ||
      (input.outputDimension !== undefined &&
        !isGeminiEmbeddingOutputDimension(input.outputDimension))
    ) {
      return false;
    }
    return (
      config.endpointUrl === GEMINI_EMBEDDING_ENDPOINT &&
      isGeminiEmbeddingModel(config.modelId) &&
      isGeminiEmbeddingOutputDimension(config.outputDimension)
    );
  }

  return Boolean(
    config.modelId &&
    config.modelId.length <= 256 &&
    !hasControlCharacters(config.modelId) &&
    isValidEndpointUrl(config.endpointUrl)
  );
}

export function isCustomRerankerConfigValid(value: unknown): boolean {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const config = normalizeCustomRerankerConfig(value);
  if (!config.enabled) return true;
  const rawEndpoint = typeof input.endpointUrl === 'string' ? input.endpointUrl : '';
  const rawModel = typeof input.modelId === 'string' ? input.modelId : '';
  if (hasControlCharacters(rawEndpoint) || hasControlCharacters(rawModel)) return false;
  return Boolean(
    config.modelId &&
    config.modelId.length <= 256 &&
    !hasControlCharacters(config.modelId) &&
    isValidEndpointUrl(config.endpointUrl)
  );
}

export function buildCustomEmbeddingProfileId(config: CustomEmbeddingConfig): string {
  const normalized = normalizeCustomEmbeddingConfig(config);
  if (normalized.protocol === 'gemini') {
    const canonicalInput = JSON.stringify([
      GEMINI_EMBEDDING_PROFILE_STRATEGY,
      GEMINI_EMBEDDING_API_VERSION,
      normalized.modelId,
      normalized.outputDimension,
      GEMINI_EMBEDDING_PURPOSE_POLICY,
    ]);
    return `rag-embedding:v1:custom:${GEMINI_EMBEDDING_PROFILE_STRATEGY}:${hashProfileInput(canonicalInput)}`;
  }

  const endpoint = normalizeRagEndpointUrl(normalized.endpointUrl);
  const canonicalInput = JSON.stringify([normalized.protocol, endpoint, normalized.modelId]);
  return `rag-embedding:v1:custom:${hashProfileInput(canonicalInput)}`;
}

/** Deterministic 128-bit fingerprint built from four independently seeded FNV-1a lanes. */
function hashProfileInput(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d];
  return seeds
    .map((seed, lane) => {
      let hash = seed >>> 0;
      for (const byte of bytes) {
        hash ^= (byte + lane * 31) & 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hash ^= hash >>> 16;
      hash = Math.imul(hash, 0x85ebca6b) >>> 0;
      hash ^= hash >>> 13;
      hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
      hash ^= hash >>> 16;
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}

export function resolveRagEmbeddingRoute(
  source: SettingsSource | RagConnectionSettingsInput = useSettingsStore.getState()
): ResolvedEmbeddingRoute {
  const mode = normalizeRagServiceMode(source.ragServiceMode);
  if (mode === 'siliconflow') {
    return {
      mode,
      provider: 'siliconflow',
      protocol: 'openai',
      modelId: SILICONFLOW_EMBEDDING_MODEL,
      authMode: 'bearer',
      profileId: SILICONFLOW_EMBEDDING_PROFILE_ID,
    };
  }

  const config = normalizeCustomEmbeddingConfig(source.customEmbeddingConfig);
  if (config.protocol === 'gemini') {
    return {
      mode,
      provider: 'custom',
      protocol: config.protocol,
      endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
      modelId: config.modelId,
      authMode: config.authMode,
      outputDimension: config.outputDimension,
      profileId: buildCustomEmbeddingProfileId(config),
    };
  }

  return {
    mode,
    provider: 'custom',
    protocol: config.protocol,
    endpointUrl: config.endpointUrl,
    modelId: config.modelId,
    authMode: config.authMode,
    profileId: buildCustomEmbeddingProfileId(config),
  };
}

export function resolveRagRerankerRoute(
  source: SettingsSource | RagConnectionSettingsInput = useSettingsStore.getState()
): ResolvedRerankerRoute {
  const mode = normalizeRagServiceMode(source.ragServiceMode);
  if (mode === 'siliconflow') {
    return {
      mode,
      enabled: true,
      provider: 'siliconflow',
      protocol: 'jina_cohere',
      modelId: SILICONFLOW_RERANKER_MODEL,
      authMode: 'bearer',
    };
  }

  const config = normalizeCustomRerankerConfig(source.customRerankerConfig);
  return {
    mode,
    enabled: config.enabled,
    provider: 'custom',
    protocol: config.protocol,
    endpointUrl: config.endpointUrl,
    modelId: config.modelId,
    authMode: config.authMode,
  };
}

export function getActiveEmbeddingProfileId(): string {
  return resolveRagEmbeddingRoute().profileId;
}

export function isUsingCustomRagService(): boolean {
  return useSettingsStore.getState().ragServiceMode === 'custom';
}

export function subscribeToEmbeddingProfileChanges(
  listener: (nextProfileId: string, previousProfileId: string) => void
): () => void {
  let previousProfileId = getActiveEmbeddingProfileId();
  return useSettingsStore.subscribe((state) => {
    const nextProfileId = resolveRagEmbeddingRoute(state).profileId;
    if (nextProfileId === previousProfileId) return;
    const oldProfileId = previousProfileId;
    previousProfileId = nextProfileId;
    listener(nextProfileId, oldProfileId);
  });
}

export function assertValidRagConnectionSettings(settings: RagConnectionSettingsInput): void {
  if (settings.ragServiceMode !== 'custom') return;
  if (!isCustomEmbeddingConfigValid(settings.customEmbeddingConfig)) {
    throw new Error('RAG_CUSTOM_EMBEDDING_CONFIG_INVALID');
  }
  if (!isCustomRerankerConfigValid(settings.customRerankerConfig)) {
    throw new Error('RAG_CUSTOM_RERANKER_CONFIG_INVALID');
  }
}

export type { EmbeddingPurpose };

export {
  DEFAULT_GEMINI_EMBEDDING_CONFIG,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
  GEMINI_EMBEDDING_ENDPOINT,
  GEMINI_EMBEDDING_MODELS,
  GEMINI_EMBEDDING_OUTPUT_DIMENSIONS,
  normalizeCustomEmbeddingConfig,
  normalizeCustomRerankerConfig,
  normalizeRagEndpointUrl,
  normalizeRagServiceMode,
};

function isGeminiEmbeddingModel(value: unknown): boolean {
  return GEMINI_EMBEDDING_MODELS.some((model) => model === value);
}

function isGeminiEmbeddingOutputDimension(value: unknown): boolean {
  return GEMINI_EMBEDDING_OUTPUT_DIMENSIONS.some((dimension) => dimension === value);
}
