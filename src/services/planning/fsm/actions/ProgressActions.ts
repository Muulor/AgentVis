/**
 * Progress 相关 Action 函数
 *
 * 用于进度跟踪、工具调用记录等
 */

import type { FSMContext, FSMEvent, ActionFn } from '../types';

// ═══════════════════════════════════════════════════════════════
// 进度操作
// ═══════════════════════════════════════════════════════════════

/**
 * 记录有进展
 *
 * 同时重置连续无进展计数
 */
export const recordProgress: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.progress = true;
  ctx.consecutiveNoProgress = 0;
};

/**
 * 记录无进展
 *
 * 增加连续无进展计数
 */
export const recordNoProgress: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.progress = false;
  ctx.consecutiveNoProgress++;
};

/**
 * 重置所有进度相关状态
 */
export const resetProgress: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.progress = false;
  ctx.consecutiveNoProgress = 0;
  ctx.toolCallHistory = [];
};

// ═══════════════════════════════════════════════════════════════
// 工具调用记录
// ═══════════════════════════════════════════════════════════════

/**
 * 记录工具调用
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param toolName - 工具名称
 */
export const recordToolCall = (ctx: FSMContext, _event: FSMEvent, toolName: string): void => {
  ctx.toolCallHistory.push(toolName);
};

/**
 * 创建记录工具调用 Action
 */
export const createRecordToolCallAction = (toolName: string): ActionFn<FSMEvent> => {
  return (ctx: FSMContext) => {
    ctx.toolCallHistory.push(toolName);
  };
};

/**
 * 清空工具调用历史
 */
export const clearToolCallHistory: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.toolCallHistory = [];
};

// ═══════════════════════════════════════════════════════════════
// 子 Agent 计数
// ═══════════════════════════════════════════════════════════════

/**
 * 增加子 Agent 创建计数
 */
export const incrementSubAgentCount: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.subAgentSpawnCount++;
};

/**
 * 重置子 Agent 计数
 */
export const resetSubAgentCount: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.subAgentSpawnCount = 0;
};
