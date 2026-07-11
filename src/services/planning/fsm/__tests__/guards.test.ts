/**
 * Guard 函数单元测试
 */

import { describe, it, expect } from 'vitest';

// Budget Guards
import {
  loopBudgetRemaining,
  loopBudgetRemainingAndProgress,
  budgetExhausted,
  riskExceeded,
} from '../guards/BudgetGuards';

// Progress Guards
import {
  consecutiveNoProgressExceeded,
  hasProgress,
  toolThrashingDetected,
  overDelegationDetected,
} from '../guards/ProgressGuards';

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

const createMockEvent = (type: string = 'TEST'): FSMEvent =>
  ({
    type: type as FSMEvent['type'],
  }) as FSMEvent;

// ═══════════════════════════════════════════════════════════════
// Budget Guards 测试
// ═══════════════════════════════════════════════════════════════

describe('Budget Guards', () => {
  describe('loopBudgetRemaining', () => {
    it('预算大于 0 应返回 true', () => {
      const ctx = createMockContext({ loopBudget: 5 });
      expect(loopBudgetRemaining(ctx, createMockEvent())).toBe(true);
    });

    it('预算等于 0 应返回 false', () => {
      const ctx = createMockContext({ loopBudget: 0 });
      expect(loopBudgetRemaining(ctx, createMockEvent())).toBe(false);
    });

    it('预算小于 0 应返回 false', () => {
      const ctx = createMockContext({ loopBudget: -1 });
      expect(loopBudgetRemaining(ctx, createMockEvent())).toBe(false);
    });
  });

  describe('loopBudgetRemainingAndProgress', () => {
    it('预算充足且有进展应返回 true', () => {
      const ctx = createMockContext({ loopBudget: 5, progress: true });
      expect(loopBudgetRemainingAndProgress(ctx, createMockEvent())).toBe(true);
    });

    it('预算充足但无进展应返回 false', () => {
      const ctx = createMockContext({ loopBudget: 5, progress: false });
      expect(loopBudgetRemainingAndProgress(ctx, createMockEvent())).toBe(false);
    });

    it('预算耗尽但有进展应返回 false', () => {
      const ctx = createMockContext({ loopBudget: 0, progress: true });
      expect(loopBudgetRemainingAndProgress(ctx, createMockEvent())).toBe(false);
    });
  });

  describe('budgetExhausted', () => {
    it('预算等于 0 应返回 true', () => {
      const ctx = createMockContext({ loopBudget: 0 });
      expect(budgetExhausted(ctx, createMockEvent())).toBe(true);
    });

    it('预算大于 0 应返回 false', () => {
      const ctx = createMockContext({ loopBudget: 1 });
      expect(budgetExhausted(ctx, createMockEvent())).toBe(false);
    });
  });

  describe('riskExceeded', () => {
    it('风险分数超过阈值应返回 true', () => {
      const ctx = createMockContext({ riskScore: 0.9 });
      expect(riskExceeded(ctx, createMockEvent(), 0.8)).toBe(true);
    });

    it('风险分数低于阈值应返回 false', () => {
      const ctx = createMockContext({ riskScore: 0.5 });
      expect(riskExceeded(ctx, createMockEvent(), 0.8)).toBe(false);
    });

    it('使用默认阈值 0.7', () => {
      const ctx = createMockContext({ riskScore: 0.75 });
      expect(riskExceeded(ctx, createMockEvent())).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Progress Guards 测试
// ═══════════════════════════════════════════════════════════════

describe('Progress Guards', () => {
  describe('consecutiveNoProgressExceeded', () => {
    it('连续无进展达到阈值应返回 true', () => {
      const ctx = createMockContext({ consecutiveNoProgress: 2 });
      expect(consecutiveNoProgressExceeded(ctx, createMockEvent())).toBe(true);
    });

    it('连续无进展超过阈值应返回 true', () => {
      const ctx = createMockContext({ consecutiveNoProgress: 5 });
      expect(consecutiveNoProgressExceeded(ctx, createMockEvent())).toBe(true);
    });

    it('连续无进展低于阈值应返回 false', () => {
      const ctx = createMockContext({ consecutiveNoProgress: 1 });
      expect(consecutiveNoProgressExceeded(ctx, createMockEvent())).toBe(false);
    });

    it('自定义阈值测试', () => {
      const ctx = createMockContext({ consecutiveNoProgress: 3 });
      expect(consecutiveNoProgressExceeded(ctx, createMockEvent(), 3)).toBe(true);
      expect(consecutiveNoProgressExceeded(ctx, createMockEvent(), 4)).toBe(false);
    });
  });

  describe('hasProgress', () => {
    it('有进展应返回 true', () => {
      const ctx = createMockContext({ progress: true });
      expect(hasProgress(ctx, createMockEvent())).toBe(true);
    });

    it('无进展应返回 false', () => {
      const ctx = createMockContext({ progress: false });
      expect(hasProgress(ctx, createMockEvent())).toBe(false);
    });
  });

  describe('toolThrashingDetected', () => {
    it('连续 3 次调用相同工具应返回 true', () => {
      const ctx = createMockContext({
        toolCallHistory: ['read', 'read', 'read'],
      });
      expect(toolThrashingDetected(ctx, createMockEvent())).toBe(true);
    });

    it('连续调用不同工具应返回 false', () => {
      const ctx = createMockContext({
        toolCallHistory: ['read', 'file_write', 'read'],
      });
      expect(toolThrashingDetected(ctx, createMockEvent())).toBe(false);
    });

    it('调用历史不足 3 次应返回 false', () => {
      const ctx = createMockContext({
        toolCallHistory: ['read', 'read'],
      });
      expect(toolThrashingDetected(ctx, createMockEvent())).toBe(false);
    });

    it('自定义阈值测试', () => {
      const ctx = createMockContext({
        toolCallHistory: ['read', 'read', 'read', 'read', 'read'],
      });
      expect(toolThrashingDetected(ctx, createMockEvent(), 5)).toBe(true);
    });
  });

  describe('overDelegationDetected', () => {
    it('子 Agent 创建超过限制应返回 true', () => {
      const ctx = createMockContext({ subAgentSpawnCount: 6 });
      expect(overDelegationDetected(ctx, createMockEvent())).toBe(true);
    });

    it('子 Agent 创建未超过限制应返回 false', () => {
      const ctx = createMockContext({ subAgentSpawnCount: 3 });
      expect(overDelegationDetected(ctx, createMockEvent())).toBe(false);
    });

    it('自定义限制测试', () => {
      const ctx = createMockContext({ subAgentSpawnCount: 3 });
      expect(overDelegationDetected(ctx, createMockEvent(), 3)).toBe(true);
      expect(overDelegationDetected(ctx, createMockEvent(), 4)).toBe(false);
    });
  });
});
