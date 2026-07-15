/**
 * Planning 模式聊天区的自动滚动信号。
 *
 * 将会改变可视内容高度的 Master Brain 与 Sub-Agent 状态压缩为轻量签名，
 * 供 ChatHistory 的外部 store 订阅判断是否需要滚动到底部。
 */

export interface PlanningAutoScrollState {
  thinkingSteps: ReadonlyArray<{
    analyzing: string;
    planning: string;
    decided: string;
  }>;
  reasoningTrace?: {
    content: string;
    isStreaming: boolean;
    isCompleted: boolean;
  };
  subAgentObservations: ReadonlyArray<{
    thinking: string;
    reasoningTrace?: {
      content: string;
      isStreaming?: boolean;
      completed?: boolean;
    };
    transient?: boolean;
    toolAction?: {
      success?: boolean;
    };
    result?: string;
    timestamp: number;
  }>;
  currentDecision: unknown;
}

export function getPlanningAutoScrollSignal(state: PlanningAutoScrollState): string {
  const lastStep = state.thinkingSteps[state.thinkingSteps.length - 1];
  const lastStepContentLength = lastStep
    ? lastStep.analyzing.length + lastStep.planning.length + lastStep.decided.length
    : 0;
  const reasoningTrace = state.reasoningTrace;
  const lastObservation = state.subAgentObservations[state.subAgentObservations.length - 1];
  const lastToolSuccess = lastObservation?.toolAction?.success;

  return [
    state.thinkingSteps.length,
    lastStepContentLength,
    reasoningTrace?.content.length ?? 0,
    reasoningTrace?.isStreaming ? 1 : 0,
    reasoningTrace?.isCompleted ? 1 : 0,
    state.subAgentObservations.length,
    lastObservation?.timestamp ?? 0,
    lastObservation?.thinking.length ?? 0,
    lastObservation?.reasoningTrace?.content.length ?? 0,
    lastObservation?.reasoningTrace?.isStreaming ? 1 : 0,
    lastObservation?.reasoningTrace?.completed ? 1 : 0,
    lastObservation?.transient ? 1 : 0,
    lastToolSuccess === undefined ? 0 : lastToolSuccess ? 2 : 1,
    lastObservation?.result?.length ?? 0,
    state.currentDecision == null ? 0 : 1,
  ].join(':');
}
