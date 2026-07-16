import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  getDefaultModelIdForProvider,
  getProviderIds,
  isValidProvider,
} from '@/config/modelRegistry';
import type {
  CustomEmbeddingConfig,
  CustomGeminiEmbeddingConfig,
  CustomOpenAiEmbeddingConfig,
  CustomRerankerConfig,
  GeminiEmbeddingModelId,
  GeminiEmbeddingOutputDimension,
  RagServiceMode,
} from '@/types/rag';

/**
 * LLM 提供商类型
 *
 * 使用 string 而非硬编码联合类型，因为用户可通过配置文件自定义模型列表。
 * 运行时通过 modelRegistry.isValidProvider() 校验有效性。
 */
type LlmProvider = string;

/**
 * 主题偏好类型
 */
type ThemePreference = 'light' | 'dark' | 'system';

const DEFAULT_PROVIDER = 'local';
const LEGACY_HARDCODED_DEFAULT_MODEL = 'gemini-3-flash';

/**
 * 任务完成通知内容模式
 */
export type TaskCompletionNotificationContentMode = 'summary' | 'private';

/**
 * 设置状态类型
 */
export interface SettingsState {
  // API Keys (加密存储在 Rust 端，这里仅标记是否已配置)
  apiKeyConfigured: Record<string, boolean>;

  // 主题偏好（支持跟随系统）
  themePreference: ThemePreference;

  // 默认模型配置
  defaultProvider: LlmProvider;
  defaultModel: string;

  // 本地模型配置
  localLlmModelPath: string | null;
  localEmbeddingModelPath: string | null;
  nGpuLayers: number;
  nCtx: number;

  // 记忆系统 LLM 配置（摘要/事实提取）
  /** 记忆系统使用的 LLM 供应商（空值时跟随 defaultProvider） */
  memoryProvider: string;
  /** 记忆系统使用的 LLM 模型（空值时跟随 defaultModel） */
  memoryModel: string;

  // Local provider 配置
  localApiUrl: string;

  // 图像生成服务配置（仅供 generate_image 工具使用，不进入主模型选择器）
  imageGenerationModel: string;
  imageGenerationApiUrl: string;
  imageGenerationUseStreaming: boolean;

  // RAG 配置
  ragTopK: number;
  ragThreshold: number;
  ragChunkSize: number;
  ragServiceMode: RagServiceMode;
  customEmbeddingConfig: CustomEmbeddingConfig;
  customRerankerConfig: CustomRerankerConfig;

  // 桌面通知配置
  taskCompletionNotificationsEnabled: boolean;
  taskCompletionNotificationsBackgroundOnly: boolean;
  taskCompletionNotificationContentMode: TaskCompletionNotificationContentMode;

  // Actions
  setApiKeyConfigured: (provider: LlmProvider, configured: boolean) => void;
  setThemePreference: (preference: ThemePreference) => void;
  setDefaultProvider: (provider: LlmProvider) => void;
  setDefaultModel: (model: string) => void;
  setLocalLlmModelPath: (path: string | null) => void;
  setLocalEmbeddingModelPath: (path: string | null) => void;
  setNGpuLayers: (layers: number) => void;
  setNCtx: (ctx: number) => void;
  setMemoryProvider: (provider: string) => void;
  setMemoryModel: (model: string) => void;
  setLocalApiUrl: (url: string) => void;
  setImageGenerationModel: (model: string) => void;
  setImageGenerationApiUrl: (url: string) => void;
  setImageGenerationUseStreaming: (enabled: boolean) => void;
  setRagServiceMode: (mode: RagServiceMode) => void;
  setCustomEmbeddingConfig: (
    config: CustomEmbeddingConfig | Partial<CustomEmbeddingConfig>
  ) => void;
  setCustomRerankerConfig: (config: CustomRerankerConfig | Partial<CustomRerankerConfig>) => void;
  setRagConnectionSettings: (settings: {
    mode: RagServiceMode;
    embedding: CustomEmbeddingConfig;
    reranker: CustomRerankerConfig;
  }) => void;
  setTaskCompletionNotificationsEnabled: (enabled: boolean) => void;
  setTaskCompletionNotificationsBackgroundOnly: (backgroundOnly: boolean) => void;
  setTaskCompletionNotificationContentMode: (mode: TaskCompletionNotificationContentMode) => void;
}

/**
 * 从注册表动态生成 apiKeyConfigured 初始值
 *
 * 避免在 store 中硬编码供应商列表，新增供应商时只需修改 modelRegistry.ts
 */
function buildDefaultApiKeyConfigured(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const id of getProviderIds()) {
    result[id] = false;
  }
  return result;
}

function normalizeApiKeyConfigured(config?: Record<string, boolean>): Record<string, boolean> {
  const result = buildDefaultApiKeyConfigured();
  for (const id of getProviderIds()) {
    result[id] = Boolean(config?.[id]);
  }
  return result;
}

function normalizeNotificationContentMode(
  mode: unknown,
  fallback: TaskCompletionNotificationContentMode
): TaskCompletionNotificationContentMode {
  return mode === 'summary' || mode === 'private' ? mode : fallback;
}

export const DEFAULT_CUSTOM_EMBEDDING_CONFIG: CustomOpenAiEmbeddingConfig = {
  providerName: '',
  protocol: 'openai',
  endpointUrl: '',
  modelId: '',
  authMode: 'bearer',
};

export const GEMINI_EMBEDDING_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_EMBEDDING_MODELS = [
  'gemini-embedding-2',
  'gemini-embedding-001',
] as const satisfies readonly GeminiEmbeddingModelId[];
export const GEMINI_EMBEDDING_OUTPUT_DIMENSIONS = [
  768, 1536, 3072,
] as const satisfies readonly GeminiEmbeddingOutputDimension[];
export const DEFAULT_GEMINI_EMBEDDING_MODEL: GeminiEmbeddingModelId = 'gemini-embedding-2';
export const DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION: GeminiEmbeddingOutputDimension = 768;
export const DEFAULT_GEMINI_EMBEDDING_CONFIG: CustomGeminiEmbeddingConfig = {
  providerName: 'Google Gemini',
  protocol: 'gemini',
  endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
  modelId: DEFAULT_GEMINI_EMBEDDING_MODEL,
  authMode: 'google_api_key',
  outputDimension: DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
};

export const DEFAULT_CUSTOM_RERANKER_CONFIG: CustomRerankerConfig = {
  enabled: false,
  providerName: '',
  protocol: 'jina_cohere',
  endpointUrl: '',
  modelId: '',
  authMode: 'bearer',
};

export function normalizeRagServiceMode(value: unknown): RagServiceMode {
  return value === 'custom' ? 'custom' : 'siliconflow';
}

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return hasControlCharacters(value) ? value : value.trim();
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export function normalizeRagEndpointUrl(value: unknown, fallback: string = ''): string {
  const trimmed = normalizeText(value, fallback);
  if (!trimmed) return '';
  if (hasControlCharacters(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function normalizeCustomEmbeddingConfig(
  value: unknown,
  fallback: CustomEmbeddingConfig = DEFAULT_CUSTOM_EMBEDDING_CONFIG
): CustomEmbeddingConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const protocol =
    input.protocol === 'gemini'
      ? 'gemini'
      : input.protocol === 'openai'
        ? 'openai'
        : input.protocol === undefined
          ? fallback.protocol
          : 'openai';

  if (protocol === 'gemini') {
    const fallbackModel =
      fallback.protocol === 'gemini' ? fallback.modelId : DEFAULT_GEMINI_EMBEDDING_MODEL;
    const fallbackDimension =
      fallback.protocol === 'gemini'
        ? fallback.outputDimension
        : DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION;
    return {
      providerName: 'Google Gemini',
      protocol,
      endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
      modelId: isGeminiEmbeddingModel(input.modelId) ? input.modelId : fallbackModel,
      authMode: 'google_api_key',
      outputDimension: isGeminiEmbeddingOutputDimension(input.outputDimension)
        ? input.outputDimension
        : fallbackDimension,
    };
  }

  const openAiFallback =
    fallback.protocol === 'openai' ? fallback : DEFAULT_CUSTOM_EMBEDDING_CONFIG;
  return {
    providerName: normalizeText(input.providerName, openAiFallback.providerName),
    protocol,
    endpointUrl: normalizeRagEndpointUrl(input.endpointUrl, openAiFallback.endpointUrl),
    modelId: normalizeText(input.modelId, openAiFallback.modelId),
    authMode:
      input.authMode === 'none' || input.authMode === 'bearer'
        ? input.authMode
        : openAiFallback.authMode,
  };
}

function isGeminiEmbeddingModel(value: unknown): value is GeminiEmbeddingModelId {
  return GEMINI_EMBEDDING_MODELS.some((model) => model === value);
}

function isGeminiEmbeddingOutputDimension(value: unknown): value is GeminiEmbeddingOutputDimension {
  return GEMINI_EMBEDDING_OUTPUT_DIMENSIONS.some((dimension) => dimension === value);
}

export function normalizeCustomRerankerConfig(
  value: unknown,
  fallback: CustomRerankerConfig = DEFAULT_CUSTOM_RERANKER_CONFIG
): CustomRerankerConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback.enabled,
    providerName: normalizeText(input.providerName, fallback.providerName),
    protocol:
      input.protocol === 'voyage' || input.protocol === 'jina_cohere'
        ? input.protocol
        : fallback.protocol,
    endpointUrl: normalizeRagEndpointUrl(input.endpointUrl, fallback.endpointUrl),
    modelId: normalizeText(input.modelId, fallback.modelId),
    authMode:
      input.authMode === 'none' || input.authMode === 'bearer' ? input.authMode : fallback.authMode,
  };
}

/**
 * Settings Store - 管理全局设置和 API 配置
 *
 * 使用 zustand persist 中间件持久化到 localStorage
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // 初始状态
      apiKeyConfigured: buildDefaultApiKeyConfigured(),
      themePreference: 'system',
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: getDefaultModelIdForProvider(DEFAULT_PROVIDER),
      localLlmModelPath: null,
      localEmbeddingModelPath: null,
      nGpuLayers: -1,
      nCtx: 32768,
      memoryProvider: '', // 空值表示跟随 defaultProvider
      memoryModel: '', // 空值表示跟随 defaultModel
      localApiUrl: 'http://127.0.0.1:8050/v1',
      imageGenerationModel: 'gpt-image-2',
      imageGenerationApiUrl: '',
      imageGenerationUseStreaming: false,
      ragTopK: 5,
      ragThreshold: 0.7,
      ragChunkSize: 500,
      ragServiceMode: 'siliconflow',
      customEmbeddingConfig: { ...DEFAULT_CUSTOM_EMBEDDING_CONFIG },
      customRerankerConfig: { ...DEFAULT_CUSTOM_RERANKER_CONFIG },
      taskCompletionNotificationsEnabled: true,
      taskCompletionNotificationsBackgroundOnly: true,
      taskCompletionNotificationContentMode: 'summary',

      // Actions
      setApiKeyConfigured: (provider, configured) =>
        set((state) => ({
          apiKeyConfigured: {
            ...state.apiKeyConfigured,
            [provider]: configured,
          },
        })),
      setThemePreference: (preference) => set({ themePreference: preference }),
      setDefaultProvider: (provider) => set({ defaultProvider: provider }),
      setDefaultModel: (model) => set({ defaultModel: model }),
      setLocalLlmModelPath: (path) => set({ localLlmModelPath: path }),
      setLocalEmbeddingModelPath: (path) => set({ localEmbeddingModelPath: path }),
      setNGpuLayers: (layers) => set({ nGpuLayers: layers }),
      setNCtx: (ctx) => set({ nCtx: ctx }),
      setMemoryProvider: (provider) => set({ memoryProvider: provider }),
      setMemoryModel: (model) => set({ memoryModel: model }),
      setLocalApiUrl: (url) => set({ localApiUrl: url }),
      setImageGenerationModel: (model) => set({ imageGenerationModel: model }),
      setImageGenerationApiUrl: (url) => set({ imageGenerationApiUrl: url }),
      setImageGenerationUseStreaming: (enabled) => set({ imageGenerationUseStreaming: enabled }),
      setRagServiceMode: (mode) => set({ ragServiceMode: normalizeRagServiceMode(mode) }),
      setCustomEmbeddingConfig: (config) =>
        set((state) => ({
          customEmbeddingConfig: normalizeCustomEmbeddingConfig(
            config,
            state.customEmbeddingConfig
          ),
        })),
      setCustomRerankerConfig: (config) =>
        set((state) => ({
          customRerankerConfig: normalizeCustomRerankerConfig(config, state.customRerankerConfig),
        })),
      setRagConnectionSettings: ({ mode, embedding, reranker }) =>
        set((state) => ({
          ragServiceMode: normalizeRagServiceMode(mode),
          customEmbeddingConfig: normalizeCustomEmbeddingConfig(
            embedding,
            state.customEmbeddingConfig
          ),
          customRerankerConfig: normalizeCustomRerankerConfig(reranker, state.customRerankerConfig),
        })),
      setTaskCompletionNotificationsEnabled: (enabled) =>
        set({ taskCompletionNotificationsEnabled: enabled }),
      setTaskCompletionNotificationsBackgroundOnly: (backgroundOnly) =>
        set({
          taskCompletionNotificationsBackgroundOnly: backgroundOnly,
        }),
      setTaskCompletionNotificationContentMode: (mode) =>
        set({
          taskCompletionNotificationContentMode: mode,
        }),
    }),
    {
      name: 'agentvis-settings',
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<SettingsState> | undefined;
        const merged = {
          ...current,
          ...persistedState,
        };
        const defaultProvider = isValidProvider(merged.defaultProvider)
          ? merged.defaultProvider
          : current.defaultProvider;
        const fallbackDefaultModel =
          getDefaultModelIdForProvider(defaultProvider) || current.defaultModel;
        const persistedDefaultModel =
          typeof merged.defaultModel === 'string' ? merged.defaultModel : '';
        const defaultModel =
          persistedDefaultModel === LEGACY_HARDCODED_DEFAULT_MODEL
            ? fallbackDefaultModel
            : persistedDefaultModel || fallbackDefaultModel;

        return {
          ...merged,
          apiKeyConfigured: normalizeApiKeyConfigured(merged.apiKeyConfigured),
          defaultProvider,
          defaultModel,
          memoryProvider:
            !merged.memoryProvider || isValidProvider(merged.memoryProvider)
              ? merged.memoryProvider
              : current.memoryProvider,
          taskCompletionNotificationContentMode: normalizeNotificationContentMode(
            merged.taskCompletionNotificationContentMode,
            current.taskCompletionNotificationContentMode
          ),
          ragServiceMode: normalizeRagServiceMode(merged.ragServiceMode),
          customEmbeddingConfig: normalizeCustomEmbeddingConfig(
            merged.customEmbeddingConfig,
            current.customEmbeddingConfig
          ),
          customRerankerConfig: normalizeCustomRerankerConfig(
            merged.customRerankerConfig,
            current.customRerankerConfig
          ),
        };
      },
    }
  )
);
