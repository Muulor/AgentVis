/**
 * LoopGovernor 循环治理器
 *
 * 职责：
 * - 预算管理（初始化、递减、耗尽检测）
 * - 进度追踪（连续无进展检测）
 * - 工具震荡检测（连续调用同一工具）
 * - 过度授权检测（子 Agent 创建数量限制）
 * - 风险评估（累积风险、阈值触发）
 *
 * 设计原则：
 * - LoopGovernor 独立于 FSM，由 FSM Actions 调用
 * - 所有终止条件有明确优先级
 * - 状态可通过 getSnapshot 完整获取
 */

import { PLANNING_CONSTANTS } from '../PlanningConstants';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * 治理器配置
 */
export interface GovernorConfig {
  /** 初始预算（默认 20） */
  initialBudget: number;
  /** 风险阈值（默认 0.8） */
  riskThreshold: number;
  /** 最大子 Agent 数量（默认 5） */
  maxSubAgents: number;
  /** 工具震荡检测阈值（默认 3，连续调用同一工具的次数） */
  toolThrashingThreshold: number;
}

/**
 * 默认配置
 *
 * 使用 PLANNING_CONSTANTS 中的统一配置值
 */
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  initialBudget: PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET,
  riskThreshold: PLANNING_CONSTANTS.LOOP_GOVERNOR_RISK_THRESHOLD,
  maxSubAgents: PLANNING_CONSTANTS.LOOP_GOVERNOR_MAX_SUB_AGENTS,
  toolThrashingThreshold: PLANNING_CONSTANTS.LOOP_GOVERNOR_TOOL_THRASHING_THRESHOLD,
};

/**
 * 观察结果（每次循环结束后的输入）
 */
export interface Observation {
  /** 本次循环是否有进展 */
  madeProgress: boolean;
  /** 风险变化量（正值增加风险，负值降低） */
  riskDelta: number;
  /** 调用的工具名称（可选） */
  toolCalled?: string;
  /** 是否创建了子 Agent（可选） */
  subAgentSpawned?: boolean;
}

/**
 * 终止原因
 */
export type TerminateReason =
  | 'consecutive_no_progress' // 连续无进展
  | 'tool_thrashing_detected' // 工具震荡
  | 'over_delegation' // 过度授权
  | 'risk_exceeded' // 风险超阈值
  | 'budget_exhausted'; // 预算耗尽

/**
 * 治理决策
 */
export type GovernorDecision =
  | { action: 'CONTINUE' }
  | { action: 'TERMINATE'; reason: TerminateReason };

/**
 * 状态快照
 */
export interface GovernorSnapshot {
  /** 剩余预算 */
  budgetRemaining: number;
  /** 初始预算（用于 UI 进度计算） */
  initialBudget: number;
  /** 当前风险分数 */
  riskScore: number;
  /** 连续无进展次数 */
  consecutiveNoProgress: number;
  /** 已创建的子 Agent 数量 */
  subAgentCount: number;
  /** 工具调用历史（用于震荡检测） */
  toolCallHistory: string[];
}

// ═══════════════════════════════════════════════════════════════
// Sub-Agent 预算控制类型（动态决策机制）
// ═══════════════════════════════════════════════════════════════

/**
 * Sub-Agent 预算配置（用于循环执行时的资源管控）
 *
 * 在 Sub-Agent 动态决策 Loop 中，追踪各类资源消耗，
 * 确保执行不会超出预定边界。
 */
export interface SubAgentBudget {
  /** 当前剩余迭代次数 */
  remainingIterations: number;
  /** 最大可追加预算（EXTEND_BUDGET 的上限） */
  maxExtendableBudget: number;
  /** 已消耗 Token */
  usedTokens: number;
  /** Token 上限 */
  maxTokens: number;
}

/**
 * 预算检查结果
 */
export interface BudgetCheckResult {
  /** 是否允许继续执行 */
  allowed: boolean;
  /** 不允许时的原因 */
  reason?: string;
}

/**
 * 延长预算检查结果
 */
export interface ExtendBudgetCheckResult {
  /** 是否允许延长 */
  allowed: boolean;
  /** 最大允许延长的迭代次数 */
  maxAllowed: number;
  /** 不允许时的原因 */
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════
// LoopGovernor 实现
// ═══════════════════════════════════════════════════════════════

/**
 * 循环治理器
 *
 * 基于架构设计文档 §5.4 LoopGovernor 规范实现
 * 终止条件检测优先级：
 * 1. 连续无进展（consecutive_no_progress）
 * 2. 工具震荡（tool_thrashing_detected）
 * 3. 过度授权（over_delegation）
 * 4. 风险超阈值（risk_exceeded）
 * 5. 预算耗尽（budget_exhausted）
 */
export class LoopGovernor {
  private config: GovernorConfig;
  private budget: number;
  private riskScore: number;
  private consecutiveNoProgress: number;
  private subAgentCount: number;
  private toolCallHistory: string[];

  constructor(config?: Partial<GovernorConfig>) {
    this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...config };
    // over_delegation 检测的语义是"SA 派遣次数超出预算上限"，
    // 应与 initialBudget 保持一致，否则 budget > maxSubAgents 时会提前误触发。
    // 例：budget=7 时第6次SA完成后 subAgentCount(6) > maxSubAgents(5) → 错误终止。
    // 修复：maxSubAgents 跟随 initialBudget（除非调用方显式传入 maxSubAgents 覆盖）。
    if (config?.maxSubAgents === undefined) {
      this.config.maxSubAgents = this.config.initialBudget;
    }
    this.budget = this.config.initialBudget;
    this.riskScore = 0;
    this.consecutiveNoProgress = 0;
    this.subAgentCount = 0;
    this.toolCallHistory = [];
  }

  /**
   * 重置治理器状态
   *
   * @param config 可选的新配置
   */
  reset(config?: Partial<GovernorConfig>): void {
    if (config) {
      this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...config };
      // 与构造函数保持一致：maxSubAgents 跟随 initialBudget（除非显式覆盖）
      if (config.maxSubAgents === undefined) {
        this.config.maxSubAgents = this.config.initialBudget;
      }
    }
    this.budget = this.config.initialBudget;
    this.riskScore = 0;
    this.consecutiveNoProgress = 0;
    this.subAgentCount = 0;
    this.toolCallHistory = [];
  }

  /**
   * 评估观察结果，决定是否继续
   *
   * @param observation 本次循环的观察结果
   * @returns 治理决策（CONTINUE 或 TERMINATE）
   */
  evaluate(observation: Observation): GovernorDecision {
    // 更新进度追踪
    if (observation.madeProgress) {
      this.consecutiveNoProgress = 0;
    } else {
      this.consecutiveNoProgress++;
    }

    // 更新工具调用历史
    if (observation.toolCalled) {
      this.toolCallHistory.push(observation.toolCalled);
    } else {
      // 无工具调用时，清空历史以打断震荡检测
      this.toolCallHistory = [];
    }

    // 更新子 Agent 计数
    if (observation.subAgentSpawned) {
      this.subAgentCount++;
    }

    // 更新风险分数（确保不低于 0）
    // 预留扩展位：当前主流程 riskDelta 默认为 0，运行时风险主要由工具级安全策略、
    // 高风险 Checkpoint 和 SA 内部终止保护承担。未来若深化全局风险评分，可在调用端接入。
    this.riskScore = Math.max(0, this.riskScore + observation.riskDelta);

    // ═══ 按优先级检测终止条件 ═══

    // 1. 连续无进展检测（最高优先级）
    if (this.consecutiveNoProgress >= 2) {
      return { action: 'TERMINATE', reason: 'consecutive_no_progress' };
    }

    // 2. 工具震荡检测
    if (this.detectToolThrashing()) {
      return { action: 'TERMINATE', reason: 'tool_thrashing_detected' };
    }

    // 3. 过度授权检测
    if (this.subAgentCount > this.config.maxSubAgents) {
      return { action: 'TERMINATE', reason: 'over_delegation' };
    }

    // 4. 风险阈值检测
    if (this.riskScore > this.config.riskThreshold) {
      return { action: 'TERMINATE', reason: 'risk_exceeded' };
    }

    // 5. 预算检测（在所有检测之后递减）
    this.budget--;
    if (this.budget <= 0) {
      return { action: 'TERMINATE', reason: 'budget_exhausted' };
    }

    return { action: 'CONTINUE' };
  }

  /**
   * 获取当前状态快照
   */
  getSnapshot(): GovernorSnapshot {
    return {
      budgetRemaining: this.budget,
      initialBudget: this.config.initialBudget,
      riskScore: this.riskScore,
      consecutiveNoProgress: this.consecutiveNoProgress,
      subAgentCount: this.subAgentCount,
      toolCallHistory: [...this.toolCallHistory],
    };
  }

  /**
   * 检测工具震荡：最近 N 次是否调用同一工具
   *
   * N = toolThrashingThreshold
   */
  private detectToolThrashing(): boolean {
    const threshold = this.config.toolThrashingThreshold;
    const history = this.toolCallHistory;

    if (history.length < threshold) {
      return false;
    }

    // 检查最后 N 次调用是否相同
    const lastN = history.slice(-threshold);
    return lastN.every((tool) => tool === lastN[0]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Sub-Agent 预算控制方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检查 Sub-Agent 预算
   *
   * 验证 Sub-Agent 是否还有足够的资源继续执行。
   * 检查优先级：迭代次数 > 工具调用次数 > Token 消耗
   *
   * @param budget - Sub-Agent 当前预算状态
   * @returns 预算检查结果
   */
  checkSubAgentBudget(budget: SubAgentBudget): BudgetCheckResult {
    // 1. 检查迭代次数（最高优先级）
    if (budget.remainingIterations <= 0) {
      return { allowed: false, reason: 'iteration_budget_exhausted' };
    }

    // 2. 检查 Token 消耗
    if (budget.usedTokens >= budget.maxTokens) {
      return { allowed: false, reason: 'token_budget_exhausted' };
    }

    return { allowed: true };
  }

  /**
   * 检查是否允许延长预算
   *
   * 验证 Master Brain 的 EXTEND_BUDGET 请求是否在允许范围内。
   *
   * @param budget - Sub-Agent 当前预算状态
   * @param requestedExtension - 请求延长的迭代次数
   * @returns 延长预算检查结果
   */
  canExtendBudget(budget: SubAgentBudget, requestedExtension: number): ExtendBudgetCheckResult {
    const maxAllowed = budget.maxExtendableBudget;

    // 检查是否已达硬上限（此时无法延长）
    if (budget.remainingIterations <= 0 && maxAllowed <= 0) {
      return {
        allowed: false,
        maxAllowed: 0,
        reason: 'hard_limit_reached',
      };
    }

    // 检查是否超过最大可追加预算
    if (requestedExtension > maxAllowed) {
      return {
        allowed: false,
        maxAllowed,
        reason: 'extension_exceeds_max_allowed',
      };
    }

    return { allowed: true, maxAllowed };
  }
}
