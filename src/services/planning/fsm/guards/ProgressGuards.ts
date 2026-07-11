/**
 * Progress 相关 Guard 函数
 *
 * 用于进度跟踪、失败模式检测
 */

import type { FSMContext, FSMEvent, GuardFn } from '../types';

// ═══════════════════════════════════════════════════════════════
// 进度检查
// ═══════════════════════════════════════════════════════════════

/** 默认连续无进展阈值 */
const DEFAULT_NO_PROGRESS_THRESHOLD = 2;

/**
 * 检查连续无进展次数是否超过阈值
 *
 * 失败感知：连续 2 次无进展 → TERMINATE
 */
export const consecutiveNoProgressExceeded = (
  ctx: FSMContext,
  _event: FSMEvent,
  threshold: number = DEFAULT_NO_PROGRESS_THRESHOLD
): boolean => {
  return ctx.consecutiveNoProgress >= threshold;
};

/**
 * 创建带阈值参数的无进展检查 Guard
 */
export const createNoProgressGuard = (
  threshold: number = DEFAULT_NO_PROGRESS_THRESHOLD
): GuardFn<FSMEvent> => {
  return (ctx: FSMContext) => ctx.consecutiveNoProgress >= threshold;
};

/**
 * 检查是否有进展
 */
export const hasProgress: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.progress;
};

// ═══════════════════════════════════════════════════════════════
// 失败模式检测
// ═══════════════════════════════════════════════════════════════

/** 默认工具震荡阈值 */
const DEFAULT_TOOL_THRASHING_THRESHOLD = 3;

/**
 * 检测工具震荡（Tool Thrashing）
 *
 * 连续 3 次调用同一工具 → TERMINATE
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param threshold - 阈值，默认 3
 */
export const toolThrashingDetected = (
  ctx: FSMContext,
  _event: FSMEvent,
  threshold: number = DEFAULT_TOOL_THRASHING_THRESHOLD
): boolean => {
  const history = ctx.toolCallHistory;

  if (history.length < threshold) {
    return false;
  }

  // 检查最后 N 次是否都是同一工具
  const lastN = history.slice(-threshold);
  return lastN.every((tool) => tool === lastN[0]);
};

/**
 * 创建带阈值参数的工具震荡检测 Guard
 */
export const createToolThrashingGuard = (
  threshold: number = DEFAULT_TOOL_THRASHING_THRESHOLD
): GuardFn<FSMEvent> => {
  return (ctx: FSMContext) => {
    const history = ctx.toolCallHistory;
    if (history.length < threshold) return false;
    const lastN = history.slice(-threshold);
    return lastN.every((tool) => tool === lastN[0]);
  };
};

/** 默认子 Agent 创建限制 */
const DEFAULT_MAX_SUB_AGENTS = 5;

/**
 * 检测过度授权（Over-delegation）
 *
 * 创建 > 5 个子 Agent → TERMINATE
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param maxAgents - 最大子 Agent 数量，默认 5
 */
export const overDelegationDetected = (
  ctx: FSMContext,
  _event: FSMEvent,
  maxAgents: number = DEFAULT_MAX_SUB_AGENTS
): boolean => {
  return ctx.subAgentSpawnCount >= maxAgents;
};

/**
 * 创建带限制参数的过度授权检测 Guard
 */
export const createOverDelegationGuard = (
  maxAgents: number = DEFAULT_MAX_SUB_AGENTS
): GuardFn<FSMEvent> => {
  return (ctx: FSMContext) => ctx.subAgentSpawnCount >= maxAgents;
};
