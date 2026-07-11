/**
 * 观测性系统类型定义
 *
 * 用于 FSM 状态追踪、思维链可视化、决策日志等
 */

import type {
  AgentServiceState,
  FSMEvent,
  FSMTraceEntry,
  MasterBrainDecisionType,
} from '../fsm/types';

// ═══════════════════════════════════════════════════════════════
// FSM 执行追踪
// ═══════════════════════════════════════════════════════════════

/**
 * FSM 完整执行轨迹
 *
 * 记录一次完整会话的所有状态转移
 */
export interface FSMTrace {
  /** 会话 ID */
  sessionId: string;
  /** 开始时间 */
  startTime: Date;
  /** 时间线（所有转移记录） */
  timeline: FSMTraceEntry<AgentServiceState, FSMEvent>[];
  /** 最终结果 */
  outcome: 'success' | 'error' | 'cancelled' | 'timeout';
  /** 结束时间 */
  endTime?: Date;
  /** 总耗时（ms） */
  totalDuration?: number;
}

// ═══════════════════════════════════════════════════════════════
// 思维链可视化
// ═══════════════════════════════════════════════════════════════

/**
 * OODA 阶段
 */
export type ThoughtPhase = 'observe' | 'orient' | 'decide' | 'act';

/**
 * 思维步骤
 *
 * 用于可视化 LLM 的思维过程
 */
export interface ThoughtStep {
  /** OODA 阶段 */
  phase: ThoughtPhase;
  /** LLM 的内部思考 */
  thought: string;
  /** 对决策的信心度 (0-1) */
  confidence: number;
  /** 考虑过的替代方案 */
  alternatives?: string[];
  /** 风险备注 */
  riskNotes?: string;
  /** 时间戳 */
  timestamp?: Date;
}

/**
 * OODA 阶段与 FSM 状态的映射
 */
export const OODA_PHASE_MAPPING: Record<AgentServiceState, ThoughtPhase | null> = {
  IDLE: null,
  PREPARE_CONTEXT: 'observe',
  MASTER_DECISION: 'orient',
  DISPATCH: 'decide',
  OBSERVE: 'act',
  EVALUATE: 'orient',
  TERMINATE: null,
};

// ═══════════════════════════════════════════════════════════════
// 决策日志（可持久化）
// ═══════════════════════════════════════════════════════════════

/**
 * 持久化决策日志条目
 *
 * 与 FSMContext 中的 DecisionLogEntry 类似，但更完整
 */
export interface PersistentDecisionLogEntry {
  /** 唯一 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 时间戳 */
  timestamp: Date;
  /** 决策类型 */
  decisionType: MasterBrainDecisionType;
  /** 决策理由 */
  rationale: string;
  /** 风险评估 */
  riskAssessment: {
    level: 'low' | 'medium' | 'high';
    notes: string;
  };
  /** 输入摘要（不存完整 context） */
  inputSummary: string;
  /** 执行结果 */
  executionResult?: {
    success: boolean;
    output?: unknown;
    error?: string;
    duration?: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// Agent Loop 回调接口
// ═══════════════════════════════════════════════════════════════

/**
 * 工具执行结果
 */
export interface ToolResult {
  /** 工具名称 */
  toolName: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（ms） */
  duration?: number;
}

/**
 * Sub-Agent 规格
 */
export interface SubAgentSpec {
  /** 单一职责描述 */
  role: string;
  /** 工具白名单 */
  allowedTools: string[];
  /** 终止条件（可选） */
  terminationCondition?: string;
}

/**
 * Sub-Agent 输出
 */
export interface SubAgentOutput {
  /** 状态 */
  status: 'completed' | 'failed';
  /** 输出是否有效 */
  outputValid: boolean;
  /** 观察结果 */
  observations: string;
  /** 不确定性变化量 */
  uncertaintyDelta: number;
  /** 错误信息 */
  error?: string;
}

/**
 * Agent Loop 回调接口
 *
 * 用于实时通知 UI 和观测系统
 */
export interface AgentLoopCallbacks {
  // ═══ FSM 状态变化 ═══
  onStateChange?: (from: AgentServiceState, to: AgentServiceState) => void;

  // ═══ 思维链可视化 ═══
  onThought?: (step: ThoughtStep) => void;

  // ═══ 决策通知 ═══
  onDecision?: (decision: {
    type: MasterBrainDecisionType;
    rationale: string;
    riskLevel: 'low' | 'medium' | 'high';
  }) => void;

  // ═══ Sub-Agent 生命周期 ═══
  onSubAgentSpawn?: (spec: SubAgentSpec) => void;
  onSubAgentComplete?: (id: string, output: SubAgentOutput) => void;
  onSubAgentFail?: (id: string, error: string) => void;

  // ═══ 工具执行 ═══
  onToolStart?: (toolName: string, args: unknown) => void;
  onToolEnd?: (result: ToolResult) => void;

  // ═══ 循环治理 ═══
  onBudgetUpdate?: (remaining: number, total: number) => void;
  onRiskUpdate?: (score: number, threshold: number) => void;
  onProgressUpdate?: (progress: boolean, consecutiveNoProgress: number) => void;

  // ═══ 错误处理 ═══
  onError?: (error: Error, recoverable: boolean) => void;
}
