/**
 * Log 相关 Action 函数
 *
 * 用于决策日志记录、失败记录等
 */

import type {
  FSMContext,
  FSMEvent,
  ActionFn,
  DecisionLogEntry,
  MasterBrainDecisionType,
} from '../types';

// ═══════════════════════════════════════════════════════════════
// 决策日志
// ═══════════════════════════════════════════════════════════════

/**
 * 决策日志输入
 */
export interface DecisionLogInput {
  /** 决策类型 */
  decisionType: MasterBrainDecisionType;
  /** 输入摘要 */
  inputSummary: string;
}

/**
 * 添加决策日志条目
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param input - 日志输入
 */
export const persistDecisionLog = (
  ctx: FSMContext,
  _event: FSMEvent,
  input: DecisionLogInput
): void => {
  const entry: DecisionLogEntry = {
    timestamp: new Date(),
    decisionType: input.decisionType,
    inputSummary: input.inputSummary,
  };

  ctx.decisionLog.push(entry);
};

/**
 * 创建决策日志 Action
 */
export const createPersistDecisionLogAction = (
  decisionType: MasterBrainDecisionType,
  inputSummary: string
): ActionFn<FSMEvent> => {
  return (ctx: FSMContext) => {
    ctx.decisionLog.push({
      timestamp: new Date(),
      decisionType,
      inputSummary,
    });
  };
};

// ═══════════════════════════════════════════════════════════════
// 失败记录
// ═══════════════════════════════════════════════════════════════

/**
 * 记录失败信息
 *
 * 更新最后一条决策日志的执行结果
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param error - 错误信息
 */
export const recordFailure = (ctx: FSMContext, _event: FSMEvent, error: string): void => {
  if (ctx.decisionLog.length === 0) {
    return;
  }

  const lastEntry = ctx.decisionLog[ctx.decisionLog.length - 1];
  if (lastEntry) {
    lastEntry.executionResult = {
      success: false,
      error,
    };
  }
};

/**
 * 记录成功信息
 *
 * @param ctx - FSM 上下文
 * @param _event - 事件（未使用）
 * @param output - 输出内容
 */
export const recordSuccess = (ctx: FSMContext, _event: FSMEvent, output?: unknown): void => {
  if (ctx.decisionLog.length === 0) {
    return;
  }

  const lastEntry = ctx.decisionLog[ctx.decisionLog.length - 1];
  if (lastEntry) {
    lastEntry.executionResult = {
      success: true,
      output,
    };
  }
};

// ═══════════════════════════════════════════════════════════════
// 日志管理
// ═══════════════════════════════════════════════════════════════

/**
 * 清空决策日志
 */
export const clearDecisionLog: ActionFn<FSMEvent> = (ctx: FSMContext): void => {
  ctx.decisionLog = [];
};

/**
 * 从事件 payload 提取决策并存储到 context
 *
 * 用于 DECISION_RECEIVED 转移
 */
export const storeDecision: ActionFn<FSMEvent> = (ctx: FSMContext, event: FSMEvent): void => {
  if (event.type === 'DECISION_RECEIVED' && 'payload' in event) {
    ctx.currentDecision = event.payload;
  }
};

/**
 * 从 USER_REQUEST 事件提取 sessionId 存储到 context
 */
export const storeSession: ActionFn<FSMEvent> = (ctx: FSMContext, event: FSMEvent): void => {
  if (event.type === 'USER_REQUEST' && 'payload' in event) {
    ctx.sessionId = event.payload.sessionId;
  }
};

/**
 * 获取最后一条决策日志
 */
export const getLastDecision = (ctx: FSMContext): DecisionLogEntry | undefined => {
  if (ctx.decisionLog.length === 0) {
    return undefined;
  }
  return ctx.decisionLog[ctx.decisionLog.length - 1];
};
