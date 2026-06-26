/**
 * Guard 函数注册表
 *
 * 统一导出所有 Guard 函数，并提供按名称查找的注册表
 */

// 导出所有 Guard 函数
export * from './BudgetGuards';
export * from './ProgressGuards';
export * from './SchemaGuards';

import type { FSMEvent, GuardFn } from '../types';

// Budget Guards
import {
    loopBudgetRemaining,
    loopBudgetRemainingAndProgress,
    budgetExhausted,
    createRiskExceededGuard,
} from './BudgetGuards';

// Progress Guards
import {
    hasProgress,
    createNoProgressGuard,
    createToolThrashingGuard,
    createOverDelegationGuard,
} from './ProgressGuards';

// Schema Guards
import {
    hasCurrentDecision,
    decisionTypeValid,
    hasSessionId,
    hasActiveSubAgents,
    noActiveSubAgents,
} from './SchemaGuards';

// ═══════════════════════════════════════════════════════════════
// Guard 注册表
// ═══════════════════════════════════════════════════════════════

/**
 * Guard 名称到函数的映射
 *
 * 用于 YAML FSM 定义解析
 */
export const GUARD_REGISTRY: Record<string, GuardFn<FSMEvent>> = {
    // Budget Guards
    loopBudgetRemaining,
    loopBudgetRemainingAndProgress,
    budgetExhausted,
    riskExceeded: createRiskExceededGuard(),

    // Progress Guards
    hasProgress,
    consecutiveNoProgressExceeded: createNoProgressGuard(),
    toolThrashingDetected: createToolThrashingGuard(),
    overDelegationDetected: createOverDelegationGuard(),

    // Schema Guards
    hasCurrentDecision,
    decisionTypeValid,
    hasSessionId,
    hasActiveSubAgents,
    noActiveSubAgents,
};

/**
 * 根据名称获取 Guard 函数
 *
 * @param name - Guard 名称
 * @returns Guard 函数，如果未找到返回 undefined
 */
export const getGuard = (name: string): GuardFn<FSMEvent> | undefined => {
    return GUARD_REGISTRY[name];
};

/**
 * 检查 Guard 是否注册
 */
export const hasGuard = (name: string): boolean => {
    return name in GUARD_REGISTRY;
};
