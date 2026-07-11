/**
 * LLMAdapter - LLM 服务适配器
 *
 * 封装 LLM API 调用，支持 OpenAI 兼容的 API。
 * 支持动态模式：每次调用时从 settingsStore 实时读取 memoryProvider/memoryModel，
 * 确保 MemoryService 缓存实例在 UI 设置切换后立即生效。
 */

import { invoke } from '@tauri-apps/api/core';
import type { LLMService } from './types';
import { getLogger } from '@services/logger';
import { useSettingsStore } from '@stores/settingsStore';
import {
  classifyLlmRetry,
  getLlmRetryDelayMs,
  MEMORY_LLM_RETRY_DELAYS_MS,
} from '@services/planning/utils/LlmRetryPolicy';

const logger = getLogger('LLMAdapter');

/** LLM 配置 */
interface LLMConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * 动态模式：每次 generate 调用时从 settingsStore 实时读取 provider/model
   * 用于 MemoryService 等长生命周期缓存场景，确保 UI 切换设置后立即生效
   */
  dynamic?: boolean;
}

/** 默认配置（使用动态解析，运行时从 settingsStore 读取） */
const DEFAULT_CONFIG: LLMConfig = {
  provider: '',
  model: '',
  temperature: 1,
  maxTokens: 24576,
};

// ============================================================================
// 重试配置常量
// ============================================================================

/** 最大重试次数（包含首次尝试） */
const EMPTY_RESPONSE_MAX_RETRIES = 1;
const MEMORY_LLM_MAX_ATTEMPTS = MEMORY_LLM_RETRY_DELAYS_MS.length + 1;

/** 重试间隔（毫秒） */
const EMPTY_RESPONSE_RETRY_DELAY_MS = 1000;

/**
 * LLM 适配器类
 *
 * 通过 Tauri IPC 调用 Rust 后端的 LLM Gateway
 */
export class LLMAdapter implements LLMService {
  private config: LLMConfig;

  constructor(config: Partial<LLMConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 解析当前有效的 provider 和 model
   *
   * 动态模式下每次调用从 settingsStore 实时读取，确保 UI 设置切换立即生效；
   * 静态模式下直接返回构造时的固定配置。
   */
  private resolveProviderAndModel(): { provider: string; model: string } {
    if (!this.config.dynamic) {
      return { provider: this.config.provider, model: this.config.model };
    }

    // 动态解析：从 settingsStore 实时读取记忆系统配置
    const state = useSettingsStore.getState();
    const { memoryProvider, memoryModel, defaultProvider, defaultModel } = state;

    // 优先使用独立配置的记忆系统 LLM，空值时回退到全局默认
    return {
      provider: memoryProvider || defaultProvider || this.config.provider,
      model: memoryModel || defaultModel || this.config.model,
    };
  }

  /**
   * 生成文本
   *
   * @param prompt - 提示词
   * @param options - 生成选项
   * @returns 生成的文本
   */
  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const { provider, model } = this.resolveProviderAndModel();
    const messages = [{ role: 'user', content: prompt }];

    logger.trace('[LLMAdapter]  generate 调用开始');
    logger.trace('[LLMAdapter] Provider:', provider);
    logger.trace('[LLMAdapter] Model:', model);
    logger.trace('[LLMAdapter] Prompt 长度:', prompt.length);
    logger.trace('[LLMAdapter] max_tokens:', options?.maxTokens ?? this.config.maxTokens);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MEMORY_LLM_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await invoke<{ content: string }>('llm_chat', {
          request: {
            provider,
            model,
            messages,
            temperature: options?.temperature ?? this.config.temperature,
            max_tokens: options?.maxTokens ?? this.config.maxTokens,
            stream: false,
          },
        });

        logger.trace('[LLMAdapter]  调用成功');
        logger.trace('[LLMAdapter] 响应长度:', response.content.length);

        // 检测空响应
        if (!response.content || response.content.trim().length === 0) {
          logger.warn(
            `[LLMAdapter]  收到空响应 (尝试 ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES + 1})`
          );

          if (attempt <= EMPTY_RESPONSE_MAX_RETRIES) {
            logger.trace(`[LLMAdapter] 等待 ${EMPTY_RESPONSE_RETRY_DELAY_MS}ms 后重试...`);
            await this.sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
            continue;
          }

          // 最后一次尝试仍然失败
          throw new Error(
            'LLM API returned an empty response. The service may be rate-limited or temporarily unavailable.'
          );
        }

        logger.trace('[LLMAdapter] 响应前200字:', response.content.substring(0, 200));
        return response.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryClassification = classifyLlmRetry(error);

        if (retryClassification.shouldRetry && attempt < MEMORY_LLM_MAX_ATTEMPTS) {
          const waitMs = getLlmRetryDelayMs(attempt, MEMORY_LLM_RETRY_DELAYS_MS);
          logger.warn(
            `[LLMAdapter] generate 可重试 API 错误 (${retryClassification.reason})，` +
              `等待 ${waitMs}ms 后重试 (${attempt}/${MEMORY_LLM_RETRY_DELAYS_MS.length})`,
            error
          );
          await this.sleep(waitMs);
          continue;
        }

        logger.error(`[LLMAdapter] generate 调用失败 (${retryClassification.reason}):`, error);
        throw lastError;
      }
    }

    throw lastError ?? new Error('LLM call failed');
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 使用系统提示词生成
   *
   * 支持重试机制（与 generate 方法保持一致）
   */
  async generateWithSystem(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const { provider, model } = this.resolveProviderAndModel();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MEMORY_LLM_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await invoke<{ content: string }>('llm_chat', {
          request: {
            provider,
            model,
            messages,
            temperature: options?.temperature ?? this.config.temperature,
            max_tokens: options?.maxTokens ?? this.config.maxTokens,
            stream: false,
          },
        });

        // 检测空响应
        if (!response.content || response.content.trim().length === 0) {
          logger.warn(
            `[LLMAdapter]  generateWithSystem 收到空响应 (尝试 ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES + 1})`
          );

          if (attempt <= EMPTY_RESPONSE_MAX_RETRIES) {
            logger.trace(`[LLMAdapter] 等待 ${EMPTY_RESPONSE_RETRY_DELAY_MS}ms 后重试...`);
            await this.sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
            continue;
          }

          throw new Error(
            'LLM API returned an empty response. The service may be rate-limited or temporarily unavailable.'
          );
        }

        return response.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryClassification = classifyLlmRetry(error);

        if (retryClassification.shouldRetry && attempt < MEMORY_LLM_MAX_ATTEMPTS) {
          const waitMs = getLlmRetryDelayMs(attempt, MEMORY_LLM_RETRY_DELAYS_MS);
          logger.warn(
            `[LLMAdapter] generateWithSystem 可重试 API 错误 (${retryClassification.reason})，` +
              `等待 ${waitMs}ms 后重试 (${attempt}/${MEMORY_LLM_RETRY_DELAYS_MS.length})`,
            error
          );
          await this.sleep(waitMs);
          continue;
        }

        logger.error(
          `[LLMAdapter] generateWithSystem 调用失败 (${retryClassification.reason}):`,
          error
        );
        throw lastError;
      }
    }

    throw lastError ?? new Error('LLM call failed');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 创建 LLM 适配器实例
 */
export function createLLMAdapter(config?: Partial<LLMConfig>): LLMAdapter {
  return new LLMAdapter(config);
}
