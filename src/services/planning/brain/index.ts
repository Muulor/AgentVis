/**
 * Brain 系统模块导出
 *
 * 自主智能体决策核心
 */

// 核心类
export { MasterBrain, type LLMServiceInterface } from './MasterBrain';
export { MasterBrainPrompt } from './MasterBrainPrompt';
export { DecisionParser, DecisionParseError } from './DecisionParser';
export {
    createMbDecisionRetryState,
    tryConsumeMbDecisionRetry,
    MB_DECISION_SEMANTIC_RETRY_LIMIT,
    type MbDecisionRetryCorrection,
    type MbDecisionRetryReason,
    type MbDecisionRetryState,
} from './MasterBrainDecisionGuard';

export {
    parseCheckpointDecision,
    safeParseCheckpointDecision,
    CheckpointDecisionSchema,
} from './CheckpointDecisionParser';

// 类型导出
export type {
    // 输入契约
    MasterBrainInput,
    UserIntent,
    MemorySnapshot,
    MemoryItem,
    RAGEvidence,
    ToolCatalogEntry,

    // 决策类型
    MasterBrainDecision,
    DecisionType,
    SpawnSubAgentDecision,
    RequestMoreInputDecision,
    RespondToUserDecision,

    // 辅助类型
    SubAgentSpec,
    RiskAssessment,
    DecisionNextStep,
} from './types';

// 类型守卫
export {
    isValidDecisionType,
    isSpawnSubAgentDecision,
} from './types';

// 工厂函数
export {
    createEmptyMemorySnapshot,
    createDefaultRiskAssessment,
} from './types';
