/**
 * Exec 超时观测辅助
 *
 * 只把显式传入 exec tool call 的 timeout 暴露给实时 UI。
 * 默认超时不提示，避免每一步都产生噪声。
 */

import type { SubAgentObservationEvent } from '../agent-loop/types';

export interface PendingExecTimeoutStatus {
    timeoutSeconds: number;
    startedAtMs: number;
}

function normalizePositiveSeconds(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }

    const seconds = Math.floor(value);
    return seconds >= 1 ? seconds : undefined;
}

export function getExplicitExecTimeoutSeconds(
    toolName: string,
    args: Record<string, unknown>
): number | undefined {
    if (toolName !== 'exec') return undefined;
    return normalizePositiveSeconds(args.timeout);
}

export function getPendingExecTimeoutStatus(
    observations: SubAgentObservationEvent[]
): PendingExecTimeoutStatus | undefined {
    for (let index = observations.length - 1; index >= 0; index--) {
        const observation = observations[index];
        if (!observation) {
            continue;
        }

        const action = observation.toolAction;
        if (action?.tool !== 'exec' || action.success !== undefined) {
            continue;
        }

        const timeoutSeconds = normalizePositiveSeconds(action.timeoutSeconds);
        if (timeoutSeconds !== undefined) {
            return {
                timeoutSeconds,
                startedAtMs: observation.timestamp,
            };
        }
    }

    return undefined;
}

export function getPendingExecTimeoutSeconds(
    observations: SubAgentObservationEvent[]
): number | undefined {
    return getPendingExecTimeoutStatus(observations)?.timeoutSeconds;
}

export function getElapsedExecTimeoutSeconds(
    startedAtMs: number,
    nowMs: number,
    timeoutSeconds: number
): number {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) {
        return 0;
    }

    const elapsedSeconds = Math.floor(Math.max(0, nowMs - startedAtMs) / 1000);
    return Math.min(elapsedSeconds, timeoutSeconds);
}
