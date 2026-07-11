/**
 * LoopGovernor Sub-Agent 预算控制测试
 *
 * 测试 Sub-Agent 专用的预算管理功能：
 * - checkSubAgentBudget: 检查是否有足够资源继续执行
 * - canExtendBudget: 检查是否允许延长预算
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LoopGovernor, type SubAgentBudget } from '../LoopGovernor';

describe('LoopGovernor Sub-Agent Budget', () => {
  let governor: LoopGovernor;

  beforeEach(() => {
    governor = new LoopGovernor();
  });

  // ═══════════════════════════════════════════════════════════════
  // checkSubAgentBudget 测试
  // ═══════════════════════════════════════════════════════════════

  describe('checkSubAgentBudget', () => {
    it('迭代次数超限返回 false', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 5,
        usedTokens: 0,
        maxTokens: 10000,
      };

      const result = governor.checkSubAgentBudget(budget);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('iteration_budget_exhausted');
    });

    it('Token 超限返回 false', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 3,
        maxExtendableBudget: 5,
        usedTokens: 10000,
        maxTokens: 10000,
      };

      const result = governor.checkSubAgentBudget(budget);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('token_budget_exhausted');
    });

    it('预算充足返回 true', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 3,
        maxExtendableBudget: 5,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.checkSubAgentBudget(budget);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('检查优先级：迭代次数 > Token', () => {
      // 所有资源都超限，应该返回迭代次数超限
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 0,
        usedTokens: 15000,
        maxTokens: 10000,
      };

      const result = governor.checkSubAgentBudget(budget);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('iteration_budget_exhausted');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // canExtendBudget 测试
  // ═══════════════════════════════════════════════════════════════

  describe('canExtendBudget', () => {
    it('请求超过 maxExtendableBudget 时返回 false', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 3,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.canExtendBudget(budget, 5);

      expect(result.allowed).toBe(false);
      expect(result.maxAllowed).toBe(3);
      expect(result.reason).toBe('extension_exceeds_max_allowed');
    });

    it('未超限时返回 true 及 maxAllowed', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 5,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.canExtendBudget(budget, 3);

      expect(result.allowed).toBe(true);
      expect(result.maxAllowed).toBe(5);
      expect(result.reason).toBeUndefined();
    });

    it('已达硬上限时禁止延长', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 0,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.canExtendBudget(budget, 1);

      expect(result.allowed).toBe(false);
      expect(result.maxAllowed).toBe(0);
      expect(result.reason).toBe('hard_limit_reached');
    });

    it('请求延长 0 次时返回 true', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 2,
        maxExtendableBudget: 3,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.canExtendBudget(budget, 0);

      expect(result.allowed).toBe(true);
      expect(result.maxAllowed).toBe(3);
    });

    it('请求刚好等于 maxExtendableBudget 时返回 true', () => {
      const budget: SubAgentBudget = {
        remainingIterations: 0,
        maxExtendableBudget: 5,
        usedTokens: 5000,
        maxTokens: 10000,
      };

      const result = governor.canExtendBudget(budget, 5);

      expect(result.allowed).toBe(true);
      expect(result.maxAllowed).toBe(5);
    });
  });
});
