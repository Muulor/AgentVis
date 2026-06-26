/**
 * Agent Loop 错误观察格式化器
 *
 * 将底层错误归类为用户和 Master Brain 都能理解的终止类型。
 */

import { translate } from '@/i18n';

export type AgentLoopErrorKind =
    | 'manual_stop'
    | 'provider_api_error'
    | 'stream_idle_timeout'
    | 'checkpoint_failure'
    | 'sub_agent_failure_circuit_breaker'
    | 'empty_mb_decision'
    | 'unknown';

export interface AgentLoopErrorClassification {
    kind: AgentLoopErrorKind;
    rawMessage: string;
}

interface FormatAgentLoopFailureOptions {
    kind?: AgentLoopErrorKind;
    details?: string;
    includeRawDetail?: boolean;
}

const EMPTY_MB_DECISION_PATTERNS = [
    'mb_empty_decision_content',
    'no executable final decision content',
    '没有返回可执行的最终决策内容',
];

const STREAM_IDLE_TIMEOUT_PATTERNS = [
    'streaming response idle timeout',
    'stream idle timeout',
    'stream transfer error',
    'without data',
    'without response headers',
    'idle timeout',
];

const MANUAL_STOP_PATTERNS = [
    'cancelled',
    'canceled',
    'user cancelled',
    'user canceled',
    'manually cancelled',
    'manually canceled',
    'request cancelled',
    'request canceled',
    'tool execution cancelled',
    '命令执行已取消',
    '文件写入已取消',
    '用户取消',
    '手动停止',
];

const CHECKPOINT_FAILURE_PATTERNS = [
    'high_risk_checkpoint_failed',
    'checkpoint_failed',
    'checkpoint failed',
    'failed to parse checkpoint decision',
    'checkpoint 失败',
    'checkpoint 解析失败',
];

const SUB_AGENT_CIRCUIT_BREAKER_PATTERNS = [
    'sub-agent failed',
    'consecutive_failures',
    'max_spawn_retries',
    'consecutive times',
    '连续失败',
    '熔断',
];

const PROVIDER_API_ERROR_PATTERNS = [
    'llm api call failed',
    'llm 调用失败',
    'api error',
    'api call failed',
    'api request',
    'provider api',
    'rate limit',
    'quota',
    'too many requests',
    'service unavailable',
    'bad request',
    'error sending request',
    'response decoding',
    'connection reset',
    'econnreset',
    'econnrefused',
    'etimedout',
    'network',
    'dns',
    '401',
    '403',
    '404',
    '413',
    '429',
    '500',
    '503',
];

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function includesAny(normalizedMessage: string, patterns: string[]): boolean {
    return patterns.some(pattern => normalizedMessage.includes(pattern));
}

function normalizeDetails(details: string): string {
    const normalized = details.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 500) return normalized;
    return `${normalized.slice(0, 500)}...`;
}

export function classifyAgentLoopError(error: unknown): AgentLoopErrorClassification {
    const rawMessage = extractErrorMessage(error);
    const normalizedMessage = rawMessage.toLowerCase();
    const errorName = error instanceof Error ? error.name.toLowerCase() : '';

    if (errorName === 'mbemptydecisioncontenterror' ||
        includesAny(normalizedMessage, EMPTY_MB_DECISION_PATTERNS)) {
        return { kind: 'empty_mb_decision', rawMessage };
    }

    if (includesAny(normalizedMessage, STREAM_IDLE_TIMEOUT_PATTERNS)) {
        return { kind: 'stream_idle_timeout', rawMessage };
    }

    if (errorName === 'aborterror' || includesAny(normalizedMessage, MANUAL_STOP_PATTERNS)) {
        return { kind: 'manual_stop', rawMessage };
    }

    if (includesAny(normalizedMessage, CHECKPOINT_FAILURE_PATTERNS)) {
        return { kind: 'checkpoint_failure', rawMessage };
    }

    if (includesAny(normalizedMessage, SUB_AGENT_CIRCUIT_BREAKER_PATTERNS)) {
        return { kind: 'sub_agent_failure_circuit_breaker', rawMessage };
    }

    if (includesAny(normalizedMessage, PROVIDER_API_ERROR_PATTERNS)) {
        return { kind: 'provider_api_error', rawMessage };
    }

    return { kind: 'unknown', rawMessage };
}

export function getAgentLoopErrorKindForTerminationReason(reason?: string): AgentLoopErrorKind | null {
    switch (reason) {
        case 'cancelled':
            return 'manual_stop';
        case 'api_error':
            return 'provider_api_error';
        case 'high_risk_checkpoint_failed':
            return 'checkpoint_failure';
        case 'consecutive_failures':
            return 'sub_agent_failure_circuit_breaker';
        default:
            return null;
    }
}

export function getAgentLoopErrorSummary(kind: AgentLoopErrorKind): string {
    switch (kind) {
        case 'manual_stop':
            return translate('chat.agentError.manualStop');
        case 'provider_api_error':
            return translate('chat.agentError.providerApiError');
        case 'stream_idle_timeout':
            return translate('chat.agentError.streamIdleTimeout');
        case 'checkpoint_failure':
            return translate('chat.agentError.checkpointFailure');
        case 'sub_agent_failure_circuit_breaker':
            return translate('chat.agentError.subAgentCircuitBreaker');
        case 'empty_mb_decision':
            return translate('chat.agentError.emptyMbDecision');
        case 'unknown':
            return translate('chat.agentError.unknown');
    }
}

export function formatAgentLoopFailureMessage(
    error: unknown,
    options: FormatAgentLoopFailureOptions = {}
): string {
    const classification = classifyAgentLoopError(error);
    const kind = options.kind ?? classification.kind;
    const details = options.details ??
        (options.includeRawDetail === false ? '' : classification.rawMessage);
    const normalizedDetails = details ? normalizeDetails(details) : '';

    const lines = [
        `**${translate('chat.agentError.title')}**`,
        '',
        getAgentLoopErrorSummary(kind),
        '',
        translate('chat.agentError.progressPreserved'),
    ];

    if (normalizedDetails) {
        lines.push('', translate('chat.agentError.details', { details: normalizedDetails }));
    }

    return lines.join('\n');
}
