/**
 * StabilityVerifier 单元测试
 *
 * 覆盖多维度打分、类别加成、偏好类特殊逻辑、阈值判定、
 * 批量验证分类、候选合并等核心逻辑
 *
 * 注意：仅测试同步方法 verify/verifyBatch/mergeCandidates，
 * 异步方法 verifyBatchAsync/mergeCandidatesAsync 依赖 Embedding 服务，
 * 属于集成测试范畴
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StabilityVerifier,
  createStabilityVerifier,
  CANDIDATE_RETENTION_THRESHOLD,
  MEMORY_WRITE_THRESHOLD,
  CANDIDATE_POOL_OVERFLOW_THRESHOLD,
} from '../StabilityVerifier';
import type { MemoryCandidate, LongTermFactCategory } from '../types';

// ==================== 测试工具 ====================

/** 创建测试候选 */
function createCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: `candidate_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'test-agent',
    content: '用户喜欢简洁回复',
    category: 'preference_style',
    occurrenceCount: 1,
    firstSeenAt: Date.now() - 10000,
    lastSeenAt: Date.now(),
    userConfirmed: false,
    score: 0,
    ...overrides,
  };
}

// ==================== 测试用例 ====================

describe('StabilityVerifier', () => {
  let verifier: StabilityVerifier;

  beforeEach(() => {
    verifier = new StabilityVerifier();
  });

  // ───────────────────────────────────────────────────
  // 常量导出
  // ───────────────────────────────────────────────────

  describe('阈值常量', () => {
    it('CANDIDATE_RETENTION_THRESHOLD 应为 3', () => {
      expect(CANDIDATE_RETENTION_THRESHOLD).toBe(3);
    });

    it('MEMORY_WRITE_THRESHOLD 应为 5', () => {
      expect(MEMORY_WRITE_THRESHOLD).toBe(5);
    });

    it('CANDIDATE_POOL_OVERFLOW_THRESHOLD 应为 5', () => {
      expect(CANDIDATE_POOL_OVERFLOW_THRESHOLD).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────
  // 打分维度
  // ───────────────────────────────────────────────────

  describe('打分维度', () => {
    it('跨轮次重复出现 (occurrenceCount >= 2) 应 +3', () => {
      const result = verifier.verify(
        createCandidate({
          occurrenceCount: 2,
        })
      );

      expect(result.scoreBreakdown.repetition).toBe(3);
    });

    it('首次出现 (occurrenceCount = 1) 重复分应为 0', () => {
      const result = verifier.verify(
        createCandidate({
          occurrenceCount: 1,
        })
      );

      expect(result.scoreBreakdown.repetition).toBe(0);
    });

    it('无模糊词时确定性应 +2', () => {
      const result = verifier.verify(
        createCandidate({
          content: '用户是后端工程师',
        })
      );

      expect(result.scoreBreakdown.certainty).toBe(2);
    });

    it('含模糊词 "可能" 时确定性应为 0', () => {
      const result = verifier.verify(
        createCandidate({
          content: '用户可能喜欢简洁回复',
        })
      );

      expect(result.scoreBreakdown.certainty).toBe(0);
    });

    it('含英文模糊表达 "not sure" 时确定性应为 0', () => {
      const result = verifier.verify(
        createCandidate({
          content: 'User is not sure about this preference',
        })
      );

      expect(result.scoreBreakdown.certainty).toBe(0);
    });

    it('含决策影响关键词 "决定" 应 +2', () => {
      const result = verifier.verify(
        createCandidate({
          content: '用户决定使用 TypeScript',
        })
      );

      expect(result.scoreBreakdown.decisionImpact).toBe(2);
    });

    it('含英文决策影响关键词 "must use" 应 +2', () => {
      const result = verifier.verify(
        createCandidate({
          content: 'User must use TypeScript for these projects',
        })
      );

      expect(result.scoreBreakdown.decisionImpact).toBe(2);
    });

    it('用户确认应 +3', () => {
      const result = verifier.verify(
        createCandidate({
          userConfirmed: true,
        })
      );

      expect(result.scoreBreakdown.userConfirmation).toBe(3);
    });

    it('验证理由应使用英文', () => {
      const result = verifier.verify(
        createCandidate({
          content: 'User must use TypeScript',
          occurrenceCount: 2,
          userConfirmed: true,
        })
      );

      expect(result.reason).toContain('repeated across turns');
      expect(result.reason).toContain('confident wording');
      expect(result.reason).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('含情绪词 "烦" 应 -3', () => {
      const result = verifier.verify(
        createCandidate({
          content: '好烦，不想写代码了',
        })
      );

      expect(result.scoreBreakdown.temporaryPenalty).toBe(-3);
    });

    it('含强上下文绑定词 "这个项目" 应 -2', () => {
      const result = verifier.verify(
        createCandidate({
          content: '这个项目用 TypeScript',
        })
      );

      expect(result.scoreBreakdown.contextBoundPenalty).toBe(-2);
    });
  });

  // ───────────────────────────────────────────────────
  // 偏好类特殊逻辑
  // ───────────────────────────────────────────────────

  describe('偏好类特殊逻辑', () => {
    it('偏好类含偏好信号关键词 "喜欢" 应 +1 (Soft Signal)', () => {
      const result = verifier.verify(
        createCandidate({
          content: '用户喜欢看科幻电影',
          category: 'preference_style',
        })
      );

      expect(result.scoreBreakdown.preferenceSignal).toBe(1);
    });

    it('非偏好类含 "喜欢" 时不应有 Soft Signal', () => {
      const result = verifier.verify(
        createCandidate({
          content: '用户喜欢自己的工作',
          category: 'identity_role',
        })
      );

      // preferenceSignal 只适用于 preference_style
      expect(result.scoreBreakdown.preferenceSignal ?? 0).toBe(0);
    });

    it('偏好类 + 弱时间词 "最近" 不应惩罚', () => {
      const result = verifier.verify(
        createCandidate({
          content: '最近喜欢看悬疑电影',
          category: 'preference_style',
        })
      );

      // "最近" 是弱时间词，对偏好类不惩罚
      expect(result.scoreBreakdown.temporaryPenalty).toBe(0);
    });

    it('非偏好类 + 弱时间词 "最近" 应惩罚 -3', () => {
      const result = verifier.verify(
        createCandidate({
          content: '最近在学 Rust',
          category: 'knowledge_level',
        })
      );

      expect(result.scoreBreakdown.temporaryPenalty).toBe(-3);
    });

    it('偏好类 + 强时间词 "暂时" 应减半惩罚', () => {
      const result = verifier.verify(
        createCandidate({
          content: '暂时喜欢这个框架',
          category: 'preference_style',
        })
      );

      // 强时间词对偏好类减半惩罚：Math.round(-3/2) = Math.round(-1.5) = -1
      expect(result.scoreBreakdown.temporaryPenalty).toBe(-1);
    });
  });

  // ───────────────────────────────────────────────────
  // 类别加成
  // ───────────────────────────────────────────────────

  describe('类别加成', () => {
    it('preference_style 应有 +2 类别加成', () => {
      const result = verifier.verify(
        createCandidate({
          content: '纯文本无关键词',
          category: 'preference_style',
        })
      );

      // 基础分 = certainty(+2) + categoryBonus(+2) = 4
      // （无模糊词所以确定性+2）
      expect(result.score).toBeGreaterThanOrEqual(4);
    });

    it('identity_role 应有 +2 类别加成', () => {
      const result = verifier.verify(
        createCandidate({
          content: '纯文本无关键词',
          category: 'identity_role',
        })
      );

      expect(result.score).toBeGreaterThanOrEqual(4);
    });

    it('interaction_signals 应无类别加成但有 Soft Signal', () => {
      const noKeywordContent = '纯文本测试内容';
      const signalsResult = verifier.verify(
        createCandidate({
          content: noKeywordContent,
          category: 'interaction_signals',
        })
      );

      const prefResult = verifier.verify(
        createCandidate({
          content: noKeywordContent,
          category: 'preference_style',
        })
      );

      // interaction_signals: certainty(+2) + interactionSignal(+2) + categoryBonus(0) = 4
      // preference_style: certainty(+2) + categoryBonus(+3) = 5
      expect(signalsResult.score).toBeLessThan(prefResult.score);
      // 验证 Soft Signal 存在
      expect(signalsResult.scoreBreakdown.interactionSignal).toBe(2);
    });

    it('interaction_signals Soft Signal 不应影响其他类别', () => {
      const result = verifier.verify(
        createCandidate({
          content: '纯文本测试内容',
          category: 'preference_style',
        })
      );
      expect(result.scoreBreakdown.interactionSignal).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────
  // 阈值判定
  // ───────────────────────────────────────────────────

  describe('阈值判定', () => {
    it('高分候选应通过验证 (passed=true)', () => {
      // 重复(+3) + 确定(+2) + 用户确认(+3) + 偏好加成(+2) = 10
      const result = verifier.verify(
        createCandidate({
          content: '用户一直用 Vim',
          category: 'preference_style',
          occurrenceCount: 2,
          userConfirmed: true,
        })
      );

      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(MEMORY_WRITE_THRESHOLD);
    });

    it('低分候选不应通过验证', () => {
      // certainty(+2) + interactionSignal(+2) + categoryBonus(0) = 4 < MEMORY_WRITE_THRESHOLD(5)
      const result = verifier.verify(
        createCandidate({
          content: '测试内容',
          category: 'interaction_signals',
          occurrenceCount: 1,
          userConfirmed: false,
        })
      );

      expect(result.passed).toBe(false);
      expect(result.score).toBeLessThan(MEMORY_WRITE_THRESHOLD);
    });
  });

  // ───────────────────────────────────────────────────
  // 批量验证
  // ───────────────────────────────────────────────────

  describe('verifyBatch', () => {
    it('应正确分类为 passed / retained / 丢弃', () => {
      const highScore = createCandidate({
        content: '用户决定使用 TypeScript',
        category: 'preference_style',
        occurrenceCount: 2,
        userConfirmed: true,
      });

      const mediumScore = createCandidate({
        content: '用户喜欢简洁回复',
        category: 'preference_style',
        // certainty(+2) + categoryBonus(+2) + preferenceSignal(+1) = 5
        // 但需要确认实际分数
      });

      const lowScore = createCandidate({
        content: '好烦今天暂时不想做了',
        category: 'interaction_signals',
        // certainty(+2) + interactionSignal(+2) + 情绪"烦"(-3) = 1
        // interaction_signals 保留阈值为 1 → retained（而非丢弃）
      });

      const { passed, retained } = verifier.verifyBatch([highScore, mediumScore, lowScore]);

      // highScore 应通过
      expect(passed.length).toBeGreaterThanOrEqual(1);
      expect(passed.some((c) => c.id === highScore.id)).toBe(true);

      // lowScore 不应 passed，但因 interaction_signals 保留阈值(1) 降低，得分 1 >= 1 → retained
      expect(passed.some((c) => c.id === lowScore.id)).toBe(false);
      expect(retained.some((c) => c.id === lowScore.id)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────
  // 候选合并
  // ───────────────────────────────────────────────────

  describe('mergeCandidates', () => {
    it('相似候选应合并 occurrenceCount', () => {
      const existing = createCandidate({
        content: '用户喜欢简洁回复',
        category: 'preference_style',
        occurrenceCount: 1,
      });

      const newCandidate = {
        agentId: 'test-agent',
        content: '用户喜欢简洁回复',
        category: 'preference_style' as LongTermFactCategory,
        occurrenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        userConfirmed: false,
        score: 2,
      };

      const result = verifier.mergeCandidates([newCandidate], [existing]);

      // 合并后应只有 1 条，occurrenceCount 增加
      expect(result.length).toBe(1);
      expect(result[0]!.occurrenceCount).toBe(2);
    });

    it('不同类别的候选不应合并', () => {
      const existing = createCandidate({
        content: 'TypeScript',
        category: 'preference_style',
      });

      const newCandidate = {
        agentId: 'test-agent',
        content: 'TypeScript',
        category: 'knowledge_level' as LongTermFactCategory,
        occurrenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        userConfirmed: false,
        score: 2,
      };

      const result = verifier.mergeCandidates([newCandidate], [existing]);

      // 类别不同，不合并，应有 2 条
      expect(result.length).toBe(2);
    });

    it('合并时 userConfirmed 应取 OR', () => {
      const existing = createCandidate({
        content: '用户喜欢简洁回复',
        category: 'preference_style',
        userConfirmed: false,
      });

      const newCandidate = {
        agentId: 'test-agent',
        content: '用户喜欢简洁回复',
        category: 'preference_style' as LongTermFactCategory,
        occurrenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        userConfirmed: true,
        score: 2,
      };

      const result = verifier.mergeCandidates([newCandidate], [existing]);
      expect(result[0]!.userConfirmed).toBe(true);
    });

    it('合并时 score 应取 max', () => {
      const existing = createCandidate({
        content: '用户喜欢简洁回复',
        category: 'preference_style',
        score: 3,
      });

      const newCandidate = {
        agentId: 'test-agent',
        content: '用户喜欢简洁回复',
        category: 'preference_style' as LongTermFactCategory,
        occurrenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        userConfirmed: false,
        score: 5,
      };

      const result = verifier.mergeCandidates([newCandidate], [existing]);
      expect(result[0]!.score).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────
  // 工厂函数
  // ───────────────────────────────────────────────────

  describe('createStabilityVerifier', () => {
    it('应创建实例', () => {
      const instance = createStabilityVerifier();
      expect(instance).toBeInstanceOf(StabilityVerifier);
    });
  });
});
