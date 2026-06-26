/**
 * VisualEnhancerService - 可视化增强服务
 *
 * 职责：
 * 1. 判断 MB 的 response 是否适合可视化增强
 * 2. 调用 LLM 将纯文本增强为带有 Widget/ECharts/Mermaid 格式的版本
 * 3. 增强失败时安全降级为原始内容
 *
 * @module services/planning/visual-enhancer/VisualEnhancerService
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import {
    buildVisualEnhancerSystemPrompt,
    buildVisualEnhancerUserPrompt,
} from './VisualEnhancerPrompt';

const logger = getLogger('VisualEnhancerService');

// ============================================================================
// 常量
// ============================================================================

/** 短回复阈值：低于此字符数直接跳过增强 */
const SHORT_RESPONSE_THRESHOLD = 200;

/** 列表项触发阈值：超过此数量的列表项才计入指标 */
const LIST_ITEM_THRESHOLD = 4;

/** 报告长度触发阈值：超过此字符数才计入指标 */
const LONG_REPORT_THRESHOLD = 800;

/** 指标命中阈值：至少命中多少个指标才触发增强 */
const INDICATOR_HIT_THRESHOLD = 2;

/** 增强结果最小长度比例：增强后内容不低于原始的此比例 */
const MIN_ENHANCED_LENGTH_RATIO = 0.6;

/** 默认超时毫秒数（增强器需要处理完整报告+生成增强版本，120 秒更安全） */
const DEFAULT_TIMEOUT_MS = 120_000;
const CHARS_PER_TOKEN_ESTIMATE = 2.5;

/** 已包含可视化格式的检测模式（这些格式无需再增强） */
const EXISTING_VISUAL_PATTERNS = [
    /```widget(?:-[\w]+)?/,
    /```echarts/,
    /```mermaid/,
];

/** 数据分析类关键词（命中时表示内容适合可视化） */
const DATA_ANALYSIS_KEYWORDS = new RegExp([
    'compare', 'comparison', 'versus', 'vs', 'kpi', 'distribution', 'region',
    'layout', 'trend', 'salary', 'rank', 'ranking', 'share', 'growth',
    'increase', 'decrease', 'decline', 'statistics', 'analysis', 'market',
    'competitor', 'competitive', 'data', 'percentage', 'metric', 'dimension',
    'cycle', 'period', 'quantity', 'score', 'rating', 'review', 'evaluation',
    'process', 'workflow', 'step', 'parallel', 'branch', 'status', 'chart',
    'table', 'view', 'framework', 'architecture', 'structure', 'module', 'core',
    'organization', 'composition', 'scope', 'forecast', 'scale', 'category',
    'classification', 'breakdown', 'relationship', 'planning', 'timeline',
    'sequence', 'order', 'space', 'hierarchy', 'layer', 'progression', 'dynamic',
    'path', 'direction', 'forward', 'reverse', 'next step', 'line chart',
    'bar chart', 'donut chart', 'scatter plot', 'dashboard', 'mind map', 'logic',
    'collaboration', 'interaction', 'option', 'choice', 'mode',
    '\\u5bf9\\u6bd4|\\u6bd4\\u8f83|\\u5206\\u5e03|\\u533a\\u57df|\\u5e03\\u5c40|\\u8d8b\\u52bf|\\u85aa\\u8d44|\\u6392\\u540d|\\u5360\\u6bd4|\\u589e\\u957f|\\u4e0a\\u5347|\\u4e0b\\u964d|\\u4e0b\\u6c89|\\u7edf\\u8ba1|\\u5206\\u6790|\\u5e02\\u573a|\\u7ade\\u54c1|\\u4efd\\u989d|\\u6570\\u636e|\\u767e\\u5206\\u6bd4|\\u6307\\u6807|\\u7ef4\\u5ea6|\\u591a\\u7ef4|\\u5468\\u671f|\\u6570\\u91cf|\\u8bc4\\u5206|\\u8bc4\\u6d4b|\\u6d41\\u7a0b|\\u8fc7\\u7a0b|\\u6b65\\u9aa4|\\u5e76\\u884c|\\u5206\\u652f|\\u72b6\\u6001|\\u8bc4\\u4f30|\\u56fe\\u8868|\\u5217\\u8868|\\u89c6\\u56fe|\\u6846\\u67b6|\\u67b6\\u6784|\\u7ed3\\u6784|\\u6a21\\u5757|\\u6838\\u5fc3|\\u7ec4\\u7ec7|\\u7ec4\\u5408|\\u96c6\\u5408|\\u7ec4\\u6210|\\u8303\\u56f4|\\u524d\\u666f|\\u89c4\\u6a21|\\u5206\\u7c7b|\\u5206\\u89e3|\\u7c7b\\u522b|\\u5173\\u7cfb|\\u8054\\u7cfb|\\u89c4\\u5212|\\u65f6\\u5e8f|\\u987a\\u5e8f|\\u6392\\u5217|\\u7a7a\\u95f4|\\u5c42\\u7ea7|\\u5c42\\u6b21|\\u9012\\u8fdb|\\u9012\\u51cf|\\u4f20\\u9012|\\u52a8\\u6001|\\u8def\\u5f84|\\u65b9\\u5411|\\u6b63\\u5411|\\u53cd\\u5411|\\u5de5\\u4f5c\\u6d41|\\u4e0b\\u4e00\\u6b65|\\u6298\\u7ebf\\u56fe|\\u67f1\\u72b6\\u56fe|\\u73af\\u5f62\\u56fe|\\u6563\\u70b9\\u56fe|\\u4eea\\u8868\\u76d8|\\u601d\\u7ef4\\u5bfc\\u56fe|\\u601d\\u7ef4|\\u903b\\u8f91|\\u534f\\u4f5c|\\u4ea4\\u4e92|\\u9009\\u9879|\\u9009\\u62e9|\\u6a21\\u5f0f',
].join('|'), 'i');

const QUANTIFIED_VALUE_PATTERN = /\d+(?:\.\d+)?\s*(?:[\u4e07\u4ebf\u5343\u767e]|k|m|b|bn|thousand|million|billion|trillion|users?|records?|items?|rows?|columns?|steps?|tasks?|points?|metrics?)/i;

function getPositiveTokenCount(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}

// ============================================================================
// 类型定义
// ============================================================================

/** 可视化增强选项 */
export interface VisualEnhanceOptions {
    /** LLM Provider */
    provider: string;
    /** 模型名称 */
    model: string;
    /** 超时毫秒数（默认 60000） */
    timeoutMs?: number;
    /** Local 代理 API URL */
    baseUrl?: string;
    /**
     * 流式输出回调：每次收到 delta 时调用，传入当前累积的完整内容
     * 用于 UI 实时渲染增强结果（避免等 LLM 完全输出后才显示）
     */
    onStreamDelta?: (accumulatedContent: string) => void;
    /** 外部取消信号（例如用户点击停止按钮） */
    signal?: AbortSignal;
    /** 流式会话创建后回调，用于 UI 层登记后端取消 sessionId */
    onSessionStart?: (sessionId: string) => void;
    /** 流式会话结束/清理后回调 */
    onSessionEnd?: (sessionId: string) => void;
    tokenContextId?: string;
}

/** 可视化增强结果 */
export interface VisualEnhanceResult {
    /** 增强后的内容（可能与原始相同） */
    content: string;
    /** 是否进行了增强 */
    enhanced: boolean;
    /** 跳过/失败原因（仅当 enhanced=false 时） */
    reason?: string;
}

// ============================================================================
// 服务实现
// ============================================================================

/**
 * 判断 response 是否适合可视化增强
 *
 * 使用启发式指标组合判断，避免对不适合的内容进行不必要的 LLM 调用。
 * 返回 true 表示应该尝试增强，false 表示跳过。
 *
 * 判断逻辑：
 * - 短回复（< 200 字符）直接跳过
 * - 已含交互格式直接跳过
 * - 5 个指标满足 2+ 个时触发
 */
export function shouldEnhance(response: string): boolean {
    // 短回复无需增强
    if (response.length < SHORT_RESPONSE_THRESHOLD) {
        return false;
    }

    // 已包含可视化格式，无需再增强
    for (const pattern of EXISTING_VISUAL_PATTERNS) {
        if (pattern.test(response)) {
            return false;
        }
    }

    // 启发式指标评估
    const indicators = [
        // 指标 1: 含百分比数据
        /\d+[%\uFF05]/.test(response),
        // 指标 2: 含数量级数据（中英文数量表达）
        QUANTIFIED_VALUE_PATTERN.test(response),
        // 指标 3: 4+ 项列表（Markdown 无序列表）
        (response.match(/\n[-•*]\s/g) ?? []).length >= LIST_ITEM_THRESHOLD,
        // 指标 4: 数据分析类关键词
        DATA_ANALYSIS_KEYWORDS.test(response),
        // 指标 5: 较长报告
        response.length > LONG_REPORT_THRESHOLD,
    ];

    const hitCount = indicators.filter(Boolean).length;
    return hitCount >= INDICATOR_HIT_THRESHOLD;
}

/**
 * 执行可视化增强
 *
 * 调用 LLM 将纯文本 response 增强为带有交互格式的版本。
 * 内部先调用 shouldEnhance 判断，不适合时直接返回原始内容。
 *
 * 降级策略：
 * - shouldEnhance 返回 false → 返回原始内容
 * - LLM 调用失败 → 返回原始内容
 * - 超时 → 返回原始内容
 * - 增强结果校验不通过 → 返回原始内容
 */
export async function enhance(
    response: string,
    options: VisualEnhanceOptions
): Promise<VisualEnhanceResult> {
    // 触发判断
    if (!shouldEnhance(response)) {
        return {
            content: response,
            enhanced: false,
            reason: 'content_not_suitable',
        };
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
        // 构建增强 Prompt
        const systemPrompt = buildVisualEnhancerSystemPrompt();
        const userPrompt = buildVisualEnhancerUserPrompt(response);

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        // 诊断日志：记录调用参数和计时
        const startTime = Date.now();
        logger.debug('[VisualEnhancer] 开始流式 LLM 调用', {
            provider: options.provider,
            model: options.model,
            baseUrl: options.baseUrl ?? '(none)',
            responseLength: response.length,
            timeoutMs,
        });

        // 使用流式调用（llm_chat_stream）替代非流式（llm_chat）
        // 原因：火山引擎等 provider 的非流式接口对大 payload 有超时问题，
        // 系统中 MB/SA/Chat 模式均使用流式调用规避此问题。
        const enhancedContent = await collectStreamResponse(
            messages,
            options,
            options.onStreamDelta,
            timeoutMs,
        );

        logger.trace('[VisualEnhancer] 流式 LLM 调用完成', {
            elapsed: `${Date.now() - startTime}ms`,
            contentLength: enhancedContent.length,
        });

        // 结果校验：增强后内容不应过短（防止 LLM 输出空或摘要式回复）
        if (enhancedContent.length < response.length * MIN_ENHANCED_LENGTH_RATIO) {
            logger.warn(
                '[VisualEnhancer] 增强结果过短，降级使用原始内容',
                { original: response.length, enhanced: enhancedContent.length }
            );
            return {
                content: response,
                enhanced: false,
                reason: 'enhanced_too_short',
            };
        }

        logger.trace(
            '[VisualEnhancer] ✨ 增强成功',
            { original: response.length, enhanced: enhancedContent.length }
        );

        return {
            content: enhancedContent,
            enhanced: true,
        };
    } catch (error) {
        // 所有错误（包括超时）安全降级为原始内容
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[VisualEnhancer] 增强失败，降级使用原始内容:', errorMessage);

        return {
            content: response,
            enhanced: false,
            reason: `enhance_failed: ${errorMessage}`,
        };
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 通过流式调用收集完整响应
 *
 * 使用 llm_chat_stream Tauri 命令 + listen('llm-stream-chunk') 事件监听，
 * 收集所有 delta chunk 拼接为完整内容。
 * 与 useChatSender 中 Chat 模式的流式调用模式一致。
 */
async function collectStreamResponse(
    messages: Array<{ role: string; content: string }>,
    options: VisualEnhanceOptions,
    onStreamDelta?: (accumulatedContent: string) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
    const { listen } = await import('@tauri-apps/api/event');

    // 生成唯一 session ID 用于过滤事件
    const sessionId = `visual-enhance-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<string>((resolve, reject) => {
        let accumulatedContent = '';
        let unlistenFn: (() => void) | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        let streamStarted = false;

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (options.signal) {
                options.signal.removeEventListener('abort', handleAbort);
            }
            unlistenFn?.();
            unlistenFn = null;
            options.onSessionEnd?.(sessionId);
        };

        const cancelBackendStream = () => {
            if (!streamStarted) return;
            invoke('llm_cancel_stream', { sessionId }).catch((err: unknown) => {
                logger.warn('[VisualEnhancer] 取消后端流失败:', err);
            });
        };

        const finishResolve = (content: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(content);
        };

        const finishReject = (error: Error, cancelBackend = false) => {
            if (settled) return;
            settled = true;
            if (cancelBackend) {
                cancelBackendStream();
            }
            cleanup();
            reject(error);
        };

        const handleAbort = () => {
            finishReject(new Error('visual_enhance_cancelled'), true);
        };

        if (options.signal?.aborted) {
            reject(new Error('visual_enhance_cancelled'));
            return;
        }

        // 注册事件监听
        listen<{
            sessionId: string;
            delta: string;
            done: boolean;
            error: string | null;
            inputTokens?: number;
            outputTokens?: number;
        }>('llm-stream-chunk', (event) => {
            // 仅处理当前 session 的事件
            if (event.payload.sessionId !== sessionId) return;
            if (settled || options.signal?.aborted) return;

            if (event.payload.error) {
                finishReject(new Error(event.payload.error));
                return;
            }

            accumulatedContent += event.payload.delta;

            // 流式回调：将当前累积内容实时推送给调用方（如 UI 渲染层）
            if (onStreamDelta) {
                onStreamDelta(accumulatedContent);
            }

            if (event.payload.done) {
                // 流完成，上报 token 用量
                void reportVisualEnhancerTokens(
                    messages,
                    accumulatedContent,
                    event.payload.inputTokens,
                    event.payload.outputTokens,
                    options.tokenContextId
                );
                finishResolve(accumulatedContent);
            }
        }).then(unlisten => {
            if (settled) {
                unlisten();
                return;
            }
            unlistenFn = unlisten;
            options.signal?.addEventListener('abort', handleAbort, { once: true });
            timeoutId = setTimeout(() => {
                finishReject(new Error(`visual_enhance_timeout: ${timeoutMs}ms`), true);
            }, timeoutMs);

            // 构建 request
            const request: Record<string, unknown> = {
                provider: options.provider,
                model: options.model,
                messages,
                temperature: 1,
                max_tokens: 24576,
            };
            if (options.baseUrl) {
                request.base_url = options.baseUrl;
            }

            // 发起流式 LLM 调用
            streamStarted = true;
            options.onSessionStart?.(sessionId);
            invoke('llm_chat_stream', {
                request,
                sessionId,
            }).catch((err: unknown) => {
                finishReject(err instanceof Error ? err : new Error(String(err)));
            });
        }).catch((err: unknown) => {
            finishReject(err instanceof Error ? err : new Error(String(err)));
        });
    });
}

/**
 * 上报 VisualEnhancer 的 token 用量到 statusStore
 *
 * 支持精确 API usage 或 fallback 字符估算
 */
async function reportVisualEnhancerTokens(
    messages: Array<{ role: string; content: string }>,
    outputContent: string,
    apiInputTokens?: number,
    apiOutputTokens?: number,
    tokenContextId?: string
): Promise<void> {
    try {
        const { useStatusStore } = await import('@stores/statusStore');
        const statusState = useStatusStore.getState();
        const resolvedTokenContextId = tokenContextId
            ?? (await import('@stores/agentStore')).useAgentStore.getState().currentAgentId;
        if (!resolvedTokenContextId) return;

        const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const estimatedInput = Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE);
        const estimatedOutput = Math.ceil(outputContent.length / CHARS_PER_TOKEN_ESTIMATE);
        statusState.addTokenUsage(
            resolvedTokenContextId,
            getPositiveTokenCount(apiInputTokens) ?? estimatedInput,
            getPositiveTokenCount(apiOutputTokens) ?? estimatedOutput
        );
    } catch {
        // statusStore 访问失败不影响主流程
    }
}
