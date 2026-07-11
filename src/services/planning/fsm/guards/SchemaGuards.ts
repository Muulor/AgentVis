/**
 * Schema 相关 Guard 函数
 *
 * 用于 JSON Schema 校验
 */

import type { FSMContext, FSMEvent, GuardFn } from '../types';

// ═══════════════════════════════════════════════════════════════
// Schema 校验
// ═══════════════════════════════════════════════════════════════

/**
 * 检查当前决策是否存在
 */
export const hasCurrentDecision: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.currentDecision !== undefined;
};

/**
 * 检查决策类型是否有效
 *
 * 有效类型：SPAWN_SUB_AGENT, REQUEST_MORE_INPUT, RESPOND_TO_USER
 */
export const decisionTypeValid: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  if (!ctx.currentDecision) {
    return false;
  }

  const validTypes = ['SPAWN_SUB_AGENT', 'REQUEST_MORE_INPUT', 'RESPOND_TO_USER'];

  return validTypes.includes(ctx.currentDecision.decision);
};

/**
 * 检查输入是否有效（基于事件 payload）
 *
 * 需要在 FSM 定义中结合具体事件使用
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const hasValidPayload = <E extends FSMEvent>(_ctx: FSMContext, event: E): boolean => {
  // 类型断言检查 payload 是否存在
  const eventWithPayload = event as { payload?: unknown };
  return 'payload' in eventWithPayload && eventWithPayload.payload !== undefined;
};

/**
 * 检查会话 ID 是否存在
 */
export const hasSessionId: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.sessionId !== undefined && ctx.sessionId.length > 0;
};

/**
 * 检查活跃子 Agent 是否存在
 */
export const hasActiveSubAgents: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.activeSubAgents.size > 0;
};

/**
 * 检查活跃子 Agent 是否为空
 */
export const noActiveSubAgents: GuardFn<FSMEvent> = (ctx: FSMContext): boolean => {
  return ctx.activeSubAgents.size === 0;
};
