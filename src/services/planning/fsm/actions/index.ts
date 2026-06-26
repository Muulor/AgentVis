/**
 * Action 函数注册表
 *
 * 统一导出所有 Action 函数，并提供按名称查找的注册表
 */

// 导出所有 Action 函数
export * from './BudgetActions';
export * from './ProgressActions';
export * from './LogActions';

import type { FSMEvent, ActionFn } from '../types';

// Budget Actions
import {
    initLoopBudget,
    decrementBudget,
    resetRiskScore,
} from './BudgetActions';

// Progress Actions
import {
    recordProgress,
    recordNoProgress,
    resetProgress,
    clearToolCallHistory,
    incrementSubAgentCount,
    resetSubAgentCount,
} from './ProgressActions';

// Log Actions
import { clearDecisionLog, storeDecision, storeSession } from './LogActions';

// ═══════════════════════════════════════════════════════════════
// Action 注册表
// ═══════════════════════════════════════════════════════════════

/**
 * 简单 Action 名称到函数的映射
 *
 * 用于 YAML FSM 定义解析
 * 注意：只包含无参数的 Action
 */
export const ACTION_REGISTRY: Record<string, ActionFn<FSMEvent>> = {
    // Budget Actions
    initLoopBudget: (ctx, event) => initLoopBudget(ctx, event),
    decrementBudget,
    resetRiskScore,

    // Progress Actions
    recordProgress,
    recordNoProgress,
    resetProgress,
    clearToolCallHistory,
    incrementSubAgentCount,
    resetSubAgentCount,

    // Log Actions
    clearDecisionLog,
    storeDecision,
    storeSession,
};

/**
 * 根据名称获取 Action 函数
 *
 * @param name - Action 名称
 * @returns Action 函数，如果未找到返回 undefined
 */
export const getAction = (name: string): ActionFn<FSMEvent> | undefined => {
    return ACTION_REGISTRY[name];
};

/**
 * 检查 Action 是否注册
 */
export const hasAction = (name: string): boolean => {
    return name in ACTION_REGISTRY;
};
