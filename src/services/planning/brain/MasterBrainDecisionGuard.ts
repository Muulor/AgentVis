/**
 * MasterBrainDecisionGuard - MB 决策输出纠错重试的共享契约
 *
 * 统一管理流式异常与解析异常共用的一次语义重试额度，避免不同层级
 * 各自重试而放大调用次数。
 */

export type MbDecisionRetryReason =
    | 'empty_content'
    | 'anomalous_content'
    | 'reasoning_repetition'
    | 'tool_call_envelope'
    | 'truncated_output'
    | 'reasoning_transport_truncated'
    | 'aggressive_repair'
    | 'malformed_json'
    | 'schema_invalid'
    | 'meta_output'
    | 'plain_text';

export interface MbDecisionRetryCorrection {
    reason: MbDecisionRetryReason;
    detail?: string;
}

export interface MbDecisionRetryState {
    attemptsUsed: number;
    lastReason?: MbDecisionRetryReason;
}

export const MB_DECISION_SEMANTIC_RETRY_LIMIT = 1;

export function createMbDecisionRetryState(): MbDecisionRetryState {
    return { attemptsUsed: 0 };
}

export function tryConsumeMbDecisionRetry(
    state: MbDecisionRetryState,
    reason: MbDecisionRetryReason,
): boolean {
    if (state.attemptsUsed >= MB_DECISION_SEMANTIC_RETRY_LIMIT) {
        return false;
    }

    state.attemptsUsed += 1;
    state.lastReason = reason;
    return true;
}
