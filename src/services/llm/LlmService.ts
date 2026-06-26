/**
 * LlmService - LLM 服务封装
 * 
 * 封装 Tauri LLM commands，提供统一的 LLM 调用接口。
 * 支持多 Provider (OpenAI/Anthropic/Gemini/ZhipuAI) 和流式输出。
 */

import { invoke } from '@tauri-apps/api/core';
import type {
    ChatMessage,
    ChatOptions,
    StreamCallbacks,
    ConnectionTestResult,
} from './types';
import { getDefaultModelIdForProvider } from '@/config/modelRegistry';

// ==================== 默认配置 ====================

const DEFAULT_PROVIDER = 'local';

const DEFAULT_OPTIONS: Required<ChatOptions> = {
    provider: DEFAULT_PROVIDER,
    model: getDefaultModelIdForProvider(DEFAULT_PROVIDER),
    temperature: 1,
    maxTokens: 24576,
    stream: true,
};

// ==================== 错误类型 ====================

/**
 * LLM 服务错误
 */
export class LlmServiceError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly provider?: string
    ) {
        super(message);
        this.name = 'LlmServiceError';
    }
}

// ==================== 服务类 ====================

/**
 * LLM 服务类
 * 
 * 提供统一的 LLM 调用接口，支持多 Provider 和流式输出
 */
export class LlmService {
    private defaultProvider: string;
    private defaultModel: string;

    constructor(config: Partial<ChatOptions> = {}) {
        this.defaultProvider = config.provider ?? DEFAULT_OPTIONS.provider;
        this.defaultModel = config.model ?? DEFAULT_OPTIONS.model;
    }

    /**
     * 同步聊天（等待完整响应）
     * 
     * @param messages - 聊天消息列表
     * @param options - 聊天选项
     * @returns 完整响应内容
     */
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        const mergedOptions = this.mergeOptions(options);

        try {
            // 调用 Tauri command（非流式模式）
            const result = await invoke<string>('llm_chat', {
                provider: mergedOptions.provider,
                model: mergedOptions.model,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
                temperature: mergedOptions.temperature,
                maxTokens: mergedOptions.maxTokens,
                stream: false,
            });

            return result;
        } catch (error) {
            throw this.wrapError(error, mergedOptions.provider);
        }
    }

    /**
     * 流式聊天
     * 
     * @param messages - 聊天消息列表
     * @param callbacks - 流式回调
     * @param options - 聊天选项
     * @returns 完整响应内容
     */
    async chatStream(
        messages: ChatMessage[],
        callbacks: StreamCallbacks,
        options?: ChatOptions
    ): Promise<string> {
        const mergedOptions = this.mergeOptions(options);
        let fullContent = '';

        try {
            // 调用 Tauri command（流式模式）
            // 注意：实际的流式实现需要使用 Tauri 的 event 系统
            // 这里暂时使用简化的实现
            const result = await invoke<string>('llm_chat', {
                provider: mergedOptions.provider,
                model: mergedOptions.model,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
                temperature: mergedOptions.temperature,
                maxTokens: mergedOptions.maxTokens,
                stream: true,
            });

            // 模拟流式输出（后续可以改为真正的 event stream）
            fullContent = result;
            if (callbacks.onChunk) {
                callbacks.onChunk(result);
            }
            if (callbacks.onComplete) {
                callbacks.onComplete(fullContent);
            }

            return fullContent;
        } catch (error) {
            const wrappedError = this.wrapError(error, mergedOptions.provider);
            if (callbacks.onError) {
                callbacks.onError(wrappedError);
            }
            throw wrappedError;
        }
    }

    /**
     * 测试 Provider 连接
     * 
     * @param provider - Provider ID
     * @returns 测试结果
     */
    async testConnection(provider: string): Promise<ConnectionTestResult> {
        const startTime = Date.now();

        try {
            await invoke<boolean>('llm_test_connection', { provider });
            return {
                success: true,
                latencyMs: Date.now() - startTime,
            };
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }


    /**
     * 设置默认 Provider
     */
    setDefaultProvider(provider: string): void {
        this.defaultProvider = provider;
    }

    /**
     * 设置默认模型
     */
    setDefaultModel(model: string): void {
        this.defaultModel = model;
    }

    /**
     * 获取当前默认配置
     */
    getDefaults(): { provider: string; model: string } {
        return {
            provider: this.defaultProvider,
            model: this.defaultModel,
        };
    }

    // ==================== 私有方法 ====================

    /**
     * 合并配置选项
     */
    private mergeOptions(options?: ChatOptions): Required<ChatOptions> {
        return {
            provider: options?.provider ?? this.defaultProvider,
            model: options?.model ?? this.defaultModel,
            temperature: options?.temperature ?? DEFAULT_OPTIONS.temperature,
            maxTokens: options?.maxTokens ?? DEFAULT_OPTIONS.maxTokens,
            stream: options?.stream ?? DEFAULT_OPTIONS.stream,
        };
    }

    /**
     * 包装错误
     */
    private wrapError(error: unknown, provider?: string): LlmServiceError {
        if (error instanceof LlmServiceError) {
            return error;
        }

        const message = error instanceof Error ? error.message : String(error);

        // 根据错误信息分类
        if (message.includes('API key')) {
            return new LlmServiceError('API key is missing or invalid', 'API_KEY_ERROR', provider);
        }
        if (message.includes('timeout') || message.includes('Timeout')) {
            return new LlmServiceError('Request timed out', 'TIMEOUT_ERROR', provider);
        }
        if (message.includes('network') || message.includes('Network')) {
            return new LlmServiceError('Network connection failed', 'NETWORK_ERROR', provider);
        }

        return new LlmServiceError(message, 'UNKNOWN_ERROR', provider);
    }
}

// ==================== 导出 ====================

/** 默认 LLM 服务实例 */
export const llmService = new LlmService();

/**
 * 创建 LlmService 实例
 */
export function createLlmService(config?: Partial<ChatOptions>): LlmService {
    return new LlmService(config);
}
