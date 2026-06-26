/**
 * Planning Engine 模块导出
 *
 * AgentService + AgentLoop + AgentSession（LLM 驱动 + Function Calling）
 */

// ==================== 新架构：Agent 系统 ====================

export {
    AgentService,
    getOrCreateAgentService,
    destroyAgentService,
    clearAllAgentServices,
} from './AgentService';

export type {
    AgentServiceConfig,
    ProcessMessageOptions,
} from './AgentService';

export {
    AgentLoop,
    AgentSession,
    createAgentSession,
} from './agent-loop';

export type {
    AgentMessage,
    MessageRole,
    LoopState,
    TerminationReason,
    AgentLoopConfig,
    AgentLoopCallbacks,
    AgentLoopResult,
    AgentSessionConfig,
    RuntimeContext,
} from './agent-loop';



// ==================== 核心组件 ====================

// DiffGenerator 重新导出自 fast-apply 模块（使用 LCS 算法的完整实现）
export { DiffGenerator, diffGenerator } from '../fast-apply';
export type { DiffHunk, DiffLine } from '../fast-apply/types';

export {
    PLANNING_CONSTANTS,
} from './PlanningConstants';

export type {
    PlanningConstantsType,
} from './PlanningConstants';

// ==================== 工具模块 ====================

export {
    FileWriter,
    fileWriter,
    ChunkProcessor,
    chunkProcessor,
} from './utils';

export type {
    SaveOptions,
    SaveResult,
    FileCategory,
    ChunkConfig,
    FileChunk,
    ProcessOptions,
    ProcessResult,
} from './utils';

// ==================== 上下文窗口管理器 ====================

export {
    ContextWindowManager,
    contextWindowManager,
} from './ContextWindowManager';

export type {
    ChatMessage as ContextChatMessage,
    ContextBudget,
    PreparedContext,
} from './ContextWindowManager';



// ==================== Tools 模块 ====================

export {
    toolRegistry,
    initializeTools,
} from './tools';

export type {
    Tool,
    ToolCall,
    ToolResult,
} from './tools/types';

// ==================== FSM 引擎（阶段1） ====================

export * from './fsm';

// ==================== Brain 系统（阶段2） ====================

export * from './brain';

// ==================== Sub-Agent 系统（阶段3） ====================

export * from './sub-agents';

// ==================== 观测性系统（阶段4） ====================

// 显式导出核心组件（避免与其他模块的类型冲突）
export {
    FSMTracer,
    DecisionLogger,
    ThoughtVisualizer,
} from './observability';

export type {
    // FSMTracer 类型
    TraceOutcome,
    TraceEntryInput,
    // DecisionLogger 类型
    DecisionLogInput,
    ExecutionResult,
    DecisionStatistics,
    // observability/types 类型
    FSMTrace,
    ThoughtPhase,
    PersistentDecisionLogEntry,
} from './observability';

// ==================== FSM 扩展类型 ====================

// 思维链步骤类型（用于 UI 可视化）
export type { ThoughtStep } from './agent-loop/types';
