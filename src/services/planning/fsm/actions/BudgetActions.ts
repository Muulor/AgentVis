/**
 * Budget 相关 Action 函数
 *
 * Action 函数可以有副作用，用于修改上下文
 */

import type { FSMContext, FSMEvent, ActionFn } from '../types';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 默认初始循环预算（从 PlanningConstants 统一取值） */
export const DEFAULT_LOOP_BUDGET = PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET;

// ═══════════════════════════════════════════════════════════════
// 预算操作
// ═══════════════════════════════════════════════════════════════

/**
 * 初始化循环预算
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param initialBudget - 初始预算，默认从 PLANNING_CONSTANTS 取值
 */
export const initLoopBudget = (
    ctx: FSMContext,
    _event: FSMEvent,
    initialBudget: number = DEFAULT_LOOP_BUDGET
): void => {
    ctx.loopBudget = initialBudget;
};

/**
 * 创建初始化预算 Action（可绑定参数）
 */
export const createInitLoopBudgetAction = (
    initialBudget: number = DEFAULT_LOOP_BUDGET
): ActionFn<FSMEvent> => {
    return (ctx: FSMContext) => {
        ctx.loopBudget = initialBudget;
    };
};

/**
 * 减少循环预算
 *
 * 预算不会变为负数
 */
export const decrementBudget: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
    if (ctx.loopBudget > 0) {
        ctx.loopBudget--;
    }
};

/**
 * 增加循环预算
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param amount - 增加的数量
 */
export const incrementBudget = (
    ctx: FSMContext,
    _event: FSMEvent,
    amount: number = 1
): void => {
    ctx.loopBudget += amount;
};

// ═══════════════════════════════════════════════════════════════
// 风险分数操作
// ═══════════════════════════════════════════════════════════════

/**
 * 更新风险分数
 *
 * 分数限制在 [0, 1] 范围内
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param delta - 变化量（可正可负）
 */
export const updateRiskScore = (
    ctx: FSMContext,
    _event: FSMEvent,
    delta: number
): void => {
    ctx.riskScore = Math.max(0, Math.min(1, ctx.riskScore + delta));
};

/**
 * 重置风险分数
 */
export const resetRiskScore: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
    ctx.riskScore = 0;
};
