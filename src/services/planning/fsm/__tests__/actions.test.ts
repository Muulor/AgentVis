/**
 * Action 函数单元测试
 */

import { describe, it, expect } from 'vitest';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';

// Budget Actions
import {
  initLoopBudget,
  decrementBudget,
  incrementBudget,
  updateRiskScore,
} from '../actions/BudgetActions';

// Progress Actions
import {
  recordProgress,
  recordNoProgress,
  resetProgress,
  recordToolCall,
  incrementSubAgentCount,
} from '../actions/ProgressActions';

// Log Actions
import { persistDecisionLog, recordFailure, clearDecisionLog } from '../actions/LogActions';

import type { FSMContext, FSMEvent } from '../types';

// ═══════════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════════

const createMockContext = (overrides?: Partial<FSMContext>): FSMContext => ({
  loopBudget: 10,
  riskScore: 0,
  progress: false,
  decisionLog: [],
  activeSubAgents: new Map(),
  toolCallHistory: [],
  consecutiveNoProgress: 0,
  subAgentSpawnCount: 0,
  ...overrides,
});

const createMockEvent = (type: string = 'TEST', payload?: unknown): FSMEvent =>
  ({
    type: type as FSMEvent['type'],
    payload,
  }) as FSMEvent;

// ═══════════════════════════════════════════════════════════════
// Budget Actions 测试
// ═══════════════════════════════════════════════════════════════

describe('Budget Actions', () => {
  describe('initLoopBudget', () => {
    it('应该初始化循环预算为默认值（来自 PlanningConstants）', () => {
      const ctx = createMockContext({ loopBudget: 0 });
      initLoopBudget(ctx, createMockEvent());
      // 默认值来自 PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET
      expect(ctx.loopBudget).toBe(PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET);
    });

    it('应该可以指定初始预算值', () => {
      const ctx = createMockContext({ loopBudget: 0 });
      initLoopBudget(ctx, createMockEvent(), 15);
      expect(ctx.loopBudget).toBe(15);
    });
  });

  describe('decrementBudget', () => {
    it('应该减少预算', async () => {
      const ctx = createMockContext({ loopBudget: 10 });
      await decrementBudget(ctx, createMockEvent());
      expect(ctx.loopBudget).toBe(9);
    });

    it('预算不应变为负数', async () => {
      const ctx = createMockContext({ loopBudget: 0 });
      await decrementBudget(ctx, createMockEvent());
      expect(ctx.loopBudget).toBe(0);
    });
  });

  describe('incrementBudget', () => {
    it('应该增加预算', () => {
      const ctx = createMockContext({ loopBudget: 5 });
      incrementBudget(ctx, createMockEvent(), 3);
      expect(ctx.loopBudget).toBe(8);
    });
  });

  describe('updateRiskScore', () => {
    it('应该更新风险分数', () => {
      const ctx = createMockContext({ riskScore: 0.3 });
      updateRiskScore(ctx, createMockEvent(), 0.2);
      expect(ctx.riskScore).toBe(0.5);
    });

    it('风险分数不应超过 1', () => {
      const ctx = createMockContext({ riskScore: 0.9 });
      updateRiskScore(ctx, createMockEvent(), 0.3);
      expect(ctx.riskScore).toBe(1);
    });

    it('风险分数不应低于 0', () => {
      const ctx = createMockContext({ riskScore: 0.2 });
      updateRiskScore(ctx, createMockEvent(), -0.5);
      expect(ctx.riskScore).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Progress Actions 测试
// ═══════════════════════════════════════════════════════════════

describe('Progress Actions', () => {
  describe('recordProgress', () => {
    it('应该记录进展并重置连续无进展计数', async () => {
      const ctx = createMockContext({
        progress: false,
        consecutiveNoProgress: 3,
      });
      await recordProgress(ctx, createMockEvent());
      expect(ctx.progress).toBe(true);
      expect(ctx.consecutiveNoProgress).toBe(0);
    });
  });

  describe('recordNoProgress', () => {
    it('应该记录无进展并增加计数', async () => {
      const ctx = createMockContext({
        progress: true,
        consecutiveNoProgress: 1,
      });
      await recordNoProgress(ctx, createMockEvent());
      expect(ctx.progress).toBe(false);
      expect(ctx.consecutiveNoProgress).toBe(2);
    });
  });

  describe('resetProgress', () => {
    it('应该重置所有进度相关状态', async () => {
      const ctx = createMockContext({
        progress: true,
        consecutiveNoProgress: 5,
        toolCallHistory: ['read', 'file_write'],
      });
      await resetProgress(ctx, createMockEvent());
      expect(ctx.progress).toBe(false);
      expect(ctx.consecutiveNoProgress).toBe(0);
      expect(ctx.toolCallHistory).toHaveLength(0);
    });
  });

  describe('recordToolCall', () => {
    it('应该记录工具调用历史', () => {
      const ctx = createMockContext({ toolCallHistory: ['read'] });
      recordToolCall(ctx, createMockEvent(), 'file_write');
      expect(ctx.toolCallHistory).toEqual(['read', 'file_write']);
    });
  });

  describe('incrementSubAgentCount', () => {
    it('应该增加子 Agent 计数', async () => {
      const ctx = createMockContext({ subAgentSpawnCount: 2 });
      await incrementSubAgentCount(ctx, createMockEvent());
      expect(ctx.subAgentSpawnCount).toBe(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Log Actions 测试
// ═══════════════════════════════════════════════════════════════

describe('Log Actions', () => {
  describe('persistDecisionLog', () => {
    it('应该添加决策日志条目', () => {
      const ctx = createMockContext({ decisionLog: [] });
      persistDecisionLog(ctx, createMockEvent(), {
        decisionType: 'SPAWN_SUB_AGENT',
        inputSummary: '测试输入',
      });

      expect(ctx.decisionLog).toHaveLength(1);
      expect(ctx.decisionLog[0]).toMatchObject({
        decisionType: 'SPAWN_SUB_AGENT',
        inputSummary: '测试输入',
      });
      expect(ctx.decisionLog[0]!.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('recordFailure', () => {
    it('应该记录失败信息', () => {
      const ctx = createMockContext({
        decisionLog: [
          {
            timestamp: new Date(),
            decisionType: 'SPAWN_SUB_AGENT',
            inputSummary: 'test',
          },
        ],
      });

      recordFailure(ctx, createMockEvent(), '执行失败');

      const lastEntry = ctx.decisionLog[ctx.decisionLog.length - 1];
      expect(lastEntry!.executionResult).toEqual({
        success: false,
        error: '执行失败',
      });
    });
  });

  describe('clearDecisionLog', () => {
    it('应该清空决策日志', async () => {
      const ctx = createMockContext({
        decisionLog: [
          { timestamp: new Date(), decisionType: 'SPAWN_SUB_AGENT', inputSummary: 'test' },
        ],
      });
      await clearDecisionLog(ctx, createMockEvent());
      expect(ctx.decisionLog).toHaveLength(0);
    });
  });
});
