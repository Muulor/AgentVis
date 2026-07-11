/**
 * Sub-Agent 模块导出
 *
 * 阶段3：子智能体系统
 */

// ═══════════════════════════════════════════════════════════════
// 类型导出
// ═══════════════════════════════════════════════════════════════

export * from './types';

// ═══════════════════════════════════════════════════════════════
// 核心组件
// ═══════════════════════════════════════════════════════════════

export {
  SubAgentFactory,
  subAgentFactory,
  type SubAgentInstance,
  type FactoryResult,
} from './SubAgentFactory';

export { SubAgentRunner, subAgentRunner, type LLMCaller, type LLMResponse } from './SubAgentRunner';

export {
  SubAgentPromptBuilder,
  subAgentPromptBuilder,
  type PromptBuildOptions,
} from './SubAgentPromptBuilder';
