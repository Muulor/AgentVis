import type { SubAgentObservationEvent } from '../agent-loop/types';

/**
 * Insert a Sub-Agent observation, or update the pending tool row when the final
 * status for the same tool call arrives.
 */
export function upsertSubAgentObservationEvent(
    observations: SubAgentObservationEvent[],
    event: SubAgentObservationEvent
): void {
    if (event.reasoningTrace) {
        if (event.reasoningTrace.content.trim().length > 0) {
            const transientStepIndex = observations.findIndex(
                item => item.transient
                    && !item.reasoningTrace
                    && item.step === event.step
                    && item.runId === event.runId
            );
            if (transientStepIndex >= 0) {
                observations.splice(transientStepIndex, 1);
            }
        }

        const existingReasoningIndex = observations.findIndex(
            item => item.reasoningTrace && item.step === event.step && item.runId === event.runId
        );
        if (existingReasoningIndex >= 0) {
            const previous = observations[existingReasoningIndex];
            if (previous) {
                const mergedReasoningTrace: NonNullable<SubAgentObservationEvent['reasoningTrace']> = {
                    content: event.reasoningTrace.content,
                };
                const isStreaming = event.reasoningTrace.isStreaming ?? previous.reasoningTrace?.isStreaming;
                const completed = event.reasoningTrace.completed ?? previous.reasoningTrace?.completed;
                if (isStreaming !== undefined) {
                    mergedReasoningTrace.isStreaming = isStreaming;
                }
                if (completed !== undefined) {
                    mergedReasoningTrace.completed = completed;
                }

                observations[existingReasoningIndex] = {
                    ...previous,
                    ...event,
                    thinking: event.thinking.trim().length > 0 ? event.thinking : previous.thinking,
                    reasoningTrace: mergedReasoningTrace,
                    timestamp: event.timestamp,
                };
            }
            return;
        }

        observations.push(event);
        return;
    }

    const transientStepIndex = event.step === undefined ? -1 : observations.findIndex(
        item => item.transient && item.step === event.step && item.runId === event.runId
    );
    if (!event.transient && transientStepIndex >= 0) {
        observations[transientStepIndex] = event;
        return;
    }

    if (event.transient && event.step !== undefined) {
        const existingTransientIndex = observations.findIndex(
            item => item.transient && item.step === event.step && item.runId === event.runId
        );
        if (existingTransientIndex >= 0) {
            observations[existingTransientIndex] = event;
            return;
        }
    }

    const toolCallId = event.toolAction?.toolCallId;
    if (!toolCallId) {
        observations.push(event);
        return;
    }

    const existingIndex = observations.findIndex(
        item => item.toolAction?.toolCallId === toolCallId && item.runId === event.runId
    );
    if (existingIndex < 0) {
        observations.push(event);
        return;
    }

    const previous = observations[existingIndex];
    if (!previous) {
        observations.push(event);
        return;
    }

    const mergedToolAction = previous.toolAction && event.toolAction ? {
        ...previous.toolAction,
        ...event.toolAction,
        success: event.toolAction.success ?? previous.toolAction.success,
    } : event.toolAction ?? previous.toolAction;

    observations[existingIndex] = {
        ...previous,
        ...event,
        thinking: event.thinking.trim().length > 0 ? event.thinking : previous.thinking,
        transient: event.transient ?? previous.transient,
        toolAction: mergedToolAction,
        result: event.result ?? previous.result,
        step: event.step ?? previous.step,
    };
}
