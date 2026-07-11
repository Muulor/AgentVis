/**
 * Budget 相关 Guard 函数
 *
 * Guard 函数必须是纯函数（无副作用）
 */

import type { FSMContext, FSMEvent, GuardFn } from '../types';

// ═══════════════════════════════════════════════════════════════
// 预算检查
// ═══════════════════════════════════════════════════════════════

/**
 * 检查循环预算是否剩余
 *
 * @param ctx - FSM 上下文
 * @returns 预算 > 0 返回 true
 */
export const loopBudgetRemaining: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.loopBudget > 0;
};

/**
 * 检查预算剩余且有进展
 *
 * 用于决定是否继续循环
 */
export const loopBudgetRemainingAndProgress: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.loopBudget > 0 && ctx.progress;
};

/**
 * 检查预算是否耗尽
 */
export const budgetExhausted: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.loopBudget <= 0;
};

// ═══════════════════════════════════════════════════════════════
// 风险检查
// ═══════════════════════════════════════════════════════════════

/** 默认风险阈值 */
const DEFAULT_RISK_THRESHOLD = 0.7;

/**
 * 检查风险分数是否超过阈值
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param threshold - 风险阈值，默认 0.7
 */
export const riskExceeded = (
  ctx: FSMContext,
  _event: FSMEvent,
  threshold: number = DEFAULT_RISK_THRESHOLD
): boolean => {
  return ctx.riskScore > threshold;
};

/**
 * 创建带阈值参数的风险检查 Guard
 *
 * @param threshold - 风险阈值
 */
export const createRiskExceededGuard = (
  threshold: number = DEFAULT_RISK_THRESHOLD
): GuardFn<FSMEvent> => {
  return (ctx: FSMContext) => ctx.riskScore > threshold;
};
