/**
 * FSM 可视化 Store
 *
 * 管理 FSM 思维链可视化的 UI 状态
 *
 * 采用 per-contextId 隔离存储，支持多 Agent 并发运行时各自独立显示思考过程。
 * UI 展开/折叠偏好为全局共享，内容数据（思维链、FSM 状态等）按 contextId 分区。
 *
 * per-contextId 隔离，支持多 Agent 并发
 */

import { create } from 'zustand';
import type {
  ThinkingPhase,
  ThinkingPhaseEvent,
  ReasoningTraceEvent,
  SubAgentObservationEvent,
} from '../services/planning/agent-loop';
import type { AgentServiceState } from '../services/planning/fsm/types';
import type { GovernorSnapshot } from '../services/planning/agent-loop/LoopGovernor';
import type { MasterBrainDecision } from '../services/planning/brain/types';
import type { SubAgentSpec, SubAgentOutput } from '../services/planning/sub-agents/types';
import { upsertSubAgentObservationEvent } from '../services/planning/utils/SubAgentObservationEvents';

// ==================== 类型定义 ====================

/**
 * 单个思维步骤（一次 Master Brain 迭代）
 *
 * 每步包含分析、规划、决策三个阶段的内容，最终合并为连贯文字
 */
export interface ThinkingStep {
  /** 步骤序号（从1开始） */
  stepNumber: number;
  /** 分析阶段内容 */
  analyzing: string;
  /** 规划阶段内容 */
  planning: string;
  /** 决策阶段内容 */
  decided: string;
  /** 当前活跃阶段（用于流式显示） */
  activePhase?: ThinkingPhase;
  /** 是否已完成 */
  isCompleted: boolean;
  /** 开始时间 */
  startTime: Date;
}

/**
 * Master Brain provider reasoning_content 流状态
 *
 * 与结构化 Decision/Thought 状态分开维护，避免推理流污染最终决策摘要。
 */
export interface ReasoningTraceState {
  /** 当前累计的 reasoning_content */
  content: string;
  /** 是否正在流式接收 */
  isStreaming: boolean;
  /** 是否已经完成本轮推理 */
  isCompleted: boolean;
  /** 开始时间 */
  startedAt?: Date;
  /** 完成时间 */
  completedAt?: Date;
}

/**
 * Sub-Agent 记录
 */
export interface SubAgentRecord {
  /** 规格 */
  spec: SubAgentSpec;
  /** 状态 */
  status: 'spawned' | 'running' | 'completed' | 'failed';
  /** 输出（如果已完成） */
  output?: SubAgentOutput;
  /** 错误信息（如果失败） */
  error?: string;
  /** 创建时间 */
  createdAt: Date;
  /** 完成时间 */
  completedAt?: Date;
}

/**
 * 单个 Context 的可视化内容状态
 *
 * 每个 Agent/Hub 独立维护自己的思维链和 FSM 数据，
 * 防止多 Agent 并发运行时数据互相污染。
 */
export interface ContextVisualizationState {
  // ═══ 思维链状态（按步存储） ═══
  thinkingSteps: ThinkingStep[];
  activePhase: ThinkingPhase;
  isThinking: boolean;
  currentDecision: MasterBrainDecision | null;
  reasoningTrace: ReasoningTraceState;

  // ═══ FSM 状态 ═══
  currentFSMState: AgentServiceState;
  fsmStateHistory: Array<{ from: AgentServiceState; to: AgentServiceState; timestamp: Date }>;

  // ═══ 治理器指标 ═══
  metricsSnapshot: GovernorSnapshot | null;

  // ═══ Sub-Agent 状态 ═══
  subAgents: Record<string, SubAgentRecord>;
  subAgentObservations: SubAgentObservationEvent[];
  isSubAgentRunning: boolean;
}

/**
 * FSM 可视化 Store 顶层状态
 */
interface FSMVisualizationState {
  // ═══ 展开/折叠状态（全局共享，UI 偏好） ═══
  isThinkingExpanded: boolean;
  isReasoningExpanded: boolean;
  isFSMStateExpanded: boolean;
  isSubAgentsExpanded: boolean;
  isTimelineExpanded: boolean;

  // ═══ Per-Context 内容状态 ═══
  contextStates: Record<string, ContextVisualizationState>;
}

/**
 * FSM 可视化 Actions
 *
 * 所有内容写入操作均携带 contextId，确保数据路由到正确的 Context 槽位。
 */
interface FSMVisualizationActions {
  // ═══ 展开/折叠操作（全局） ═══
  toggleThinkingExpanded: () => void;
  toggleReasoningExpanded: () => void;
  toggleFSMStateExpanded: () => void;
  toggleSubAgentsExpanded: () => void;
  toggleTimelineExpanded: () => void;

  // ═══ 内容写入操作（按 contextId 隔离） ═══
  handleThinkingPhaseEvent: (event: ThinkingPhaseEvent, contextId: string) => void;
  handleReasoningTraceEvent: (event: ReasoningTraceEvent, contextId: string) => void;
  setCurrentDecision: (decision: MasterBrainDecision | null, contextId: string) => void;
  handleFSMStateChange: (from: AgentServiceState, to: AgentServiceState, contextId: string) => void;
  updateMetrics: (snapshot: GovernorSnapshot, contextId: string) => void;
  recordSubAgentSpawn: (id: string, spec: SubAgentSpec, contextId: string) => void;
  recordSubAgentComplete: (id: string, output: SubAgentOutput, contextId: string) => void;
  recordSubAgentFail: (id: string, error: string, contextId: string) => void;
  addSubAgentObservation: (event: SubAgentObservationEvent, contextId: string) => void;
  setSubAgentRunning: (running: boolean, contextId: string) => void;

  // ═══ 重置（清空指定 Context 的状态） ═══
  reset: (contextId: string) => void;

  // ═══ 读取辅助 ═══
  /** 获取指定 Context 的可视化状态（不存在时返回初始空状态） */
  getContextState: (contextId: string) => ContextVisualizationState;
}

// ==================== 初始状态 ====================

function createInitialReasoningTraceState(): ReasoningTraceState {
  return {
    content: '',
    isStreaming: false,
    isCompleted: false,
  };
}

/**
 * 单个 Context 的初始内容状态
 */
const initialContextState: ContextVisualizationState = {
  thinkingSteps: [],
  activePhase: 'IDLE',
  isThinking: false,
  currentDecision: null,
  reasoningTrace: createInitialReasoningTraceState(),
  currentFSMState: 'IDLE',
  fsmStateHistory: [],
  metricsSnapshot: null,
  subAgents: {},
  subAgentObservations: [],
  isSubAgentRunning: false,
};

/** 创建初始 Context 状态的深拷贝 */
function createInitialContextState(): ContextVisualizationState {
  return {
    ...initialContextState,
    thinkingSteps: [],
    reasoningTrace: createInitialReasoningTraceState(),
    fsmStateHistory: [],
    subAgents: {},
    subAgentObservations: [],
  };
}

/**
 * 从 contextStates 中安全读取，不存在时返回初始状态
 */
function resolveContext(
  contextStates: Record<string, ContextVisualizationState>,
  contextId: string
): ContextVisualizationState {
  return contextStates[contextId] ?? createInitialContextState();
}

/**
 * Store 顶层初始状态
 */
const initialState: FSMVisualizationState = {
  isThinkingExpanded: true,
  isReasoningExpanded: false,
  isFSMStateExpanded: false,
  isSubAgentsExpanded: false,
  isTimelineExpanded: false,
  contextStates: {},
};

// ==================== Store 创建 ====================

/**
 * FSM 可视化 Store
 */
export const useFSMVisualizationStore = create<FSMVisualizationState & FSMVisualizationActions>(
  (set, get) => ({
    ...initialState,

    // ═══ 展开/折叠操作（全局共享） ═══
    toggleThinkingExpanded: () =>
      set((state) => ({ isThinkingExpanded: !state.isThinkingExpanded })),

    toggleReasoningExpanded: () =>
      set((state) => ({ isReasoningExpanded: !state.isReasoningExpanded })),

    toggleFSMStateExpanded: () =>
      set((state) => ({ isFSMStateExpanded: !state.isFSMStateExpanded })),

    toggleSubAgentsExpanded: () =>
      set((state) => ({ isSubAgentsExpanded: !state.isSubAgentsExpanded })),

    toggleTimelineExpanded: () =>
      set((state) => ({ isTimelineExpanded: !state.isTimelineExpanded })),

    // ═══ 思维链事件处理（按 contextId 路由） ═══
    handleThinkingPhaseEvent: (event: ThinkingPhaseEvent, contextId: string) => {
      const { type, phase, content } = event;

      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        const steps = [...ctx.thinkingSteps];

        switch (type) {
          case 'START': {
            // ANALYZING 开始时创建新步骤
            if (phase === 'ANALYZING') {
              const newStep: ThinkingStep = {
                stepNumber: steps.length + 1,
                analyzing: '',
                planning: '',
                decided: '',
                activePhase: phase,
                isCompleted: false,
                startTime: new Date(),
              };
              steps.push(newStep);
            } else if (steps.length > 0) {
              // 其他阶段只更新当前步骤的活跃阶段
              const currentStep = steps[steps.length - 1];
              if (!currentStep) return state;
              steps[steps.length - 1] = {
                ...currentStep,
                activePhase: phase,
              };
            }
            return {
              contextStates: {
                ...state.contextStates,
                [contextId]: {
                  ...ctx,
                  ...(phase === 'ANALYZING'
                    ? { reasoningTrace: createInitialReasoningTraceState() }
                    : {}),
                  thinkingSteps: steps,
                  activePhase: phase,
                  isThinking: phase !== 'IDLE',
                },
              },
            };
          }

          case 'CONTENT': {
            if (steps.length === 0) return state;
            const currentStep = steps[steps.length - 1];
            if (!currentStep) return state;

            // 根据阶段更新对应字段（直接覆盖，不累积）
            steps[steps.length - 1] = {
              ...currentStep,
              analyzing: phase === 'ANALYZING' ? (content ?? '') : currentStep.analyzing,
              planning: phase === 'PLANNING' ? (content ?? '') : currentStep.planning,
              decided: phase === 'DECIDED' ? (content ?? '') : currentStep.decided,
            };
            return {
              contextStates: {
                ...state.contextStates,
                [contextId]: { ...ctx, thinkingSteps: steps },
              },
            };
          }

          case 'COMPLETE': {
            // DECIDED 完成时标记当前步骤完成
            if (phase === 'DECIDED' && steps.length > 0) {
              const currentStep = steps[steps.length - 1];
              if (currentStep) {
                steps[steps.length - 1] = {
                  ...currentStep,
                  activePhase: undefined,
                  isCompleted: true,
                };
              }
            }
            return {
              contextStates: {
                ...state.contextStates,
                [contextId]: {
                  ...ctx,
                  thinkingSteps: steps,
                  isThinking: phase !== 'DECIDED',
                },
              },
            };
          }

          default:
            return state;
        }
      });
    },

    handleReasoningTraceEvent: (event: ReasoningTraceEvent, contextId: string) => {
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        const currentTrace =
          (ctx as Partial<ContextVisualizationState>).reasoningTrace ??
          createInitialReasoningTraceState();

        switch (event.type) {
          case 'START': {
            return {
              isReasoningExpanded: true,
              contextStates: {
                ...state.contextStates,
                [contextId]: {
                  ...ctx,
                  reasoningTrace: {
                    content: event.content ?? '',
                    isStreaming: true,
                    isCompleted: false,
                    startedAt: new Date(),
                    completedAt: undefined,
                  },
                },
              },
            };
          }

          case 'CONTENT': {
            return {
              isReasoningExpanded: true,
              contextStates: {
                ...state.contextStates,
                [contextId]: {
                  ...ctx,
                  reasoningTrace: {
                    ...currentTrace,
                    content: event.content ?? '',
                    isStreaming: true,
                    isCompleted: false,
                    startedAt: currentTrace.startedAt ?? new Date(),
                    completedAt: undefined,
                  },
                },
              },
            };
          }

          case 'COMPLETE': {
            const content = event.content ?? currentTrace.content;
            return {
              isReasoningExpanded: false,
              contextStates: {
                ...state.contextStates,
                [contextId]: {
                  ...ctx,
                  reasoningTrace: {
                    ...currentTrace,
                    content,
                    isStreaming: false,
                    isCompleted: Boolean(content),
                    completedAt: new Date(),
                  },
                },
              },
            };
          }

          default:
            return state;
        }
      });
    },

    setCurrentDecision: (decision: MasterBrainDecision | null, contextId: string) =>
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: { ...ctx, currentDecision: decision },
          },
        };
      }),

    // ═══ FSM 状态处理 ═══
    handleFSMStateChange: (from: AgentServiceState, to: AgentServiceState, contextId: string) => {
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: {
              ...ctx,
              currentFSMState: to,
              fsmStateHistory: [...ctx.fsmStateHistory, { from, to, timestamp: new Date() }],
            },
          },
        };
      });
    },

    // ═══ 治理器指标处理 ═══
    updateMetrics: (snapshot: GovernorSnapshot, contextId: string) =>
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: { ...ctx, metricsSnapshot: snapshot },
          },
        };
      }),

    // ═══ Sub-Agent 生命周期处理 ═══
    recordSubAgentSpawn: (id: string, spec: SubAgentSpec, contextId: string) => {
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: {
              ...ctx,
              subAgents: {
                ...ctx.subAgents,
                [id]: { spec, status: 'spawned', createdAt: new Date() },
              },
            },
          },
        };
      });
    },

    recordSubAgentComplete: (id: string, output: SubAgentOutput, contextId: string) => {
      const ctx = resolveContext(get().contextStates, contextId);
      const current = ctx.subAgents[id];
      if (!current) return;

      set((state) => {
        const latestCtx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: {
              ...latestCtx,
              subAgents: {
                ...latestCtx.subAgents,
                [id]: { ...current, status: 'completed', output, completedAt: new Date() },
              },
            },
          },
        };
      });
    },

    recordSubAgentFail: (id: string, error: string, contextId: string) => {
      const ctx = resolveContext(get().contextStates, contextId);
      const current = ctx.subAgents[id];
      if (!current) return;

      set((state) => {
        const latestCtx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: {
              ...latestCtx,
              subAgents: {
                ...latestCtx.subAgents,
                [id]: { ...current, status: 'failed', error, completedAt: new Date() },
              },
            },
          },
        };
      });
    },

    // ═══ Sub-Agent 实时观测 ═══
    addSubAgentObservation: (event: SubAgentObservationEvent, contextId: string) => {
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        const observations = [...ctx.subAgentObservations];
        upsertSubAgentObservationEvent(observations, event);

        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: {
              ...ctx,
              subAgentObservations: observations,
            },
          },
        };
      });
    },

    setSubAgentRunning: (running: boolean, contextId: string) =>
      set((state) => {
        const ctx = resolveContext(state.contextStates, contextId);
        return {
          contextStates: {
            ...state.contextStates,
            [contextId]: { ...ctx, isSubAgentRunning: running },
          },
        };
      }),

    // ═══ 重置指定 Context ═══
    reset: (contextId: string) =>
      set((state) => ({
        contextStates: {
          ...state.contextStates,
          [contextId]: createInitialContextState(),
        },
      })),

    // ═══ 读取辅助 ═══
    getContextState: (contextId: string): ContextVisualizationState => {
      return resolveContext(get().contextStates, contextId);
    },
  })
);
