import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getDefaultModelIdForProvider, getProviderIds, isValidProvider } from '@/config/modelRegistry';

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
interface SettingsState {
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
    fallback: TaskCompletionNotificationContentMode,
): TaskCompletionNotificationContentMode {
    return mode === 'summary' || mode === 'private' ? mode : fallback;
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
            nCtx: 24576,
            memoryProvider: '',  // 空值表示跟随 defaultProvider
            memoryModel: '',    // 空值表示跟随 defaultModel
            localApiUrl: 'http://127.0.0.1:8050/v1',
            imageGenerationModel: 'gpt-image-2',
            imageGenerationApiUrl: '',
            imageGenerationUseStreaming: false,
            ragTopK: 5,
            ragThreshold: 0.7,
            ragChunkSize: 500,
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
            setTaskCompletionNotificationsEnabled: (enabled) => set({ taskCompletionNotificationsEnabled: enabled }),
            setTaskCompletionNotificationsBackgroundOnly: (backgroundOnly) => set({
                taskCompletionNotificationsBackgroundOnly: backgroundOnly,
            }),
            setTaskCompletionNotificationContentMode: (mode) => set({
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
                const fallbackDefaultModel = getDefaultModelIdForProvider(defaultProvider)
                    || current.defaultModel;
                const persistedDefaultModel = typeof merged.defaultModel === 'string'
                    ? merged.defaultModel
                    : '';
                const defaultModel = persistedDefaultModel === LEGACY_HARDCODED_DEFAULT_MODEL
                    ? fallbackDefaultModel
                    : persistedDefaultModel || fallbackDefaultModel;

                return {
                    ...merged,
                    apiKeyConfigured: normalizeApiKeyConfigured(merged.apiKeyConfigured),
                    defaultProvider,
                    defaultModel,
                    memoryProvider: !merged.memoryProvider || isValidProvider(merged.memoryProvider)
                        ? merged.memoryProvider
                        : current.memoryProvider,
                    taskCompletionNotificationContentMode: normalizeNotificationContentMode(
                        merged.taskCompletionNotificationContentMode,
                        current.taskCompletionNotificationContentMode,
                    ),
                };
            },
        }
    )
);
