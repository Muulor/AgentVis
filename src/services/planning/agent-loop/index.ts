/**
 * Agent Loop 模块入口
 *
 * 导出 AgentLoop 核心类和相关类型
 */

// ==================== 核心类导出 ====================
export { AgentLoop } from './AgentLoop';
export { AgentSession, createAgentSession } from './AgentSession';
export { LoopGovernor, DEFAULT_GOVERNOR_CONFIG } from './LoopGovernor';

// ==================== 类型导出 ====================
export type {
  AgentMessage,
  MessageRole,
  LoopState,
  TerminationReason,
  AgentLoopConfig,
  AgentLoopCallbacks,
  AgentLoopResult,
  LLMRequestWithTools,
  LLMResponseWithTools,
  // FSM 可视化类型
  ThinkingPhase,
  ThinkingPhaseEvent,
  ReasoningTraceEvent,
  // Sub-Agent 实时观测类型
  SubAgentObservationEvent,
} from './types';

export type { AgentSessionConfig, RuntimeContext } from './AgentSession';

export type {
  GovernorConfig,
  Observation,
  TerminateReason,
  GovernorDecision,
  GovernorSnapshot,
} from './LoopGovernor';
