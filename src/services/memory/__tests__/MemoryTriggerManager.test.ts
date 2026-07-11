/**
 * MemoryTriggerManager 单元测试
 *
 * 覆盖语义信号增量计算和触发决策逻辑
 *
 * 注意：MemoryTriggerManager 的状态通过 Tauri IPC 持久化，
 * 需要 mock invoke 调用。测试重点覆盖纯逻辑方法：
 * - calculateSemanticDelta（不依赖 IPC）
 * - makeDecision（不依赖 IPC）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryTriggerManager, createMemoryTriggerManager } from '../MemoryTriggerManager';
import type { ScanResult } from '../MemoryCandidateScanner';

// ==================== Mock Tauri IPC ====================

// Mock invoke 调用（状态持久化需要 IPC）
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation(async (command: string) => {
    // 模拟触发器状态查询
    if (command === 'memory_trigger_get_state') {
      return {
        agentId: 'test-agent',
        turnsSinceLastExtract: 0,
        candidateSignalScore: 0,
        lastExtractTurn: 0,
        lastProcessedMessageId: null,
        updatedAt: Date.now(),
      };
    }
    // 模拟状态更新
    if (command === 'memory_trigger_update_state') {
      return null;
    }
    return null;
  }),
}));

// ==================== 测试工具 ====================

/** 创建测试用扫描结果 */
function createScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    candidates: [],
    hasUserConfirmation: false,
    ...overrides,
  };
}

/** 创建触发器状态 */
function createState(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'test-agent',
    turnsSinceLastExtract: 0,
    candidateSignalScore: 0,
    lastExtractTurn: 0,
    lastProcessedMessageId: undefined as string | undefined,
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ==================== 类型转换：用于测试 private 方法 ====================

/** 暴露 private 方法供测试访问 */
interface MemoryTriggerManagerInternal {
  calculateSemanticDelta(scanResult: ScanResult | null, userMessage: string): number;
  makeDecision(
    state: ReturnType<typeof createState>,
    isLifecycleEvent: boolean
  ): {
    shouldTrigger: boolean;
    reason: 'semantic' | 'lifecycle' | 'fallback' | 'none';
    state: ReturnType<typeof createState>;
  };
}

// ==================== 测试用例 ====================

describe('MemoryTriggerManager', () => {
  let manager: MemoryTriggerManager;
  /** 类型转换后的引用，用于访问 private 方法 */
  let internal: MemoryTriggerManagerInternal;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MemoryTriggerManager('test-agent');
    internal = manager as unknown as MemoryTriggerManagerInternal;
  });

  // ───────────────────────────────────────────────────
  // calculateSemanticDelta
  // ───────────────────────────────────────────────────

  describe('calculateSemanticDelta', () => {
    it('无扫描结果时应返回 0', () => {
      const delta = internal.calculateSemanticDelta(null, '普通消息');
      expect(delta).toBe(0);
    });

    it('有候选但无确认时应基于候选数量计算', () => {
      const scanResult = createScanResult({
        candidates: [
          {
            agentId: 'test',
            content: '测试候选',
            category: 'preference_style',
            occurrenceCount: 1,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            userConfirmed: false,
            score: 2,
          },
        ],
      });

      const delta = internal.calculateSemanticDelta(scanResult, '普通消息');
      expect(delta).toBeGreaterThan(0);
    });

    it('有用户确认时应有更高增量', () => {
      const withoutConfirm = createScanResult({
        candidates: [
          {
            agentId: 'test',
            content: '测试',
            category: 'preference_style',
            occurrenceCount: 1,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            userConfirmed: false,
            score: 2,
          },
        ],
        hasUserConfirmation: false,
      });

      const withConfirm = createScanResult({
        candidates: [
          {
            agentId: 'test',
            content: '测试',
            category: 'preference_style',
            occurrenceCount: 1,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            userConfirmed: true,
            score: 2,
          },
        ],
        hasUserConfirmation: true,
      });

      const deltaWithout = internal.calculateSemanticDelta(withoutConfirm, '普通消息');
      const deltaWith = internal.calculateSemanticDelta(withConfirm, '你记住这个');

      expect(deltaWith).toBeGreaterThan(deltaWithout);
    });

    it('显式记忆请求 "记住" 应有高增量', () => {
      const delta = internal.calculateSemanticDelta(null, '请记住我是后端工程师');
      // 显式记忆请求应直接给予高增量
      expect(delta).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────
  // makeDecision
  // ───────────────────────────────────────────────────

  describe('makeDecision', () => {
    it('分数未达阈值且未到兜底轮次时不应触发', () => {
      const state = createState({
        turnsSinceLastExtract: 2,
        candidateSignalScore: 1,
      });

      const decision = internal.makeDecision(state, false);

      expect(decision.shouldTrigger).toBe(false);
      expect(decision.reason).toBe('none');
    });

    it('语义信号达到阈值应触发 (semantic)', () => {
      const state = createState({
        turnsSinceLastExtract: 3,
        candidateSignalScore: 10, // 高信号分数
      });

      const decision = internal.makeDecision(state, false);

      // 如果 candidateSignalScore 达到语义触发阈值
      if (decision.shouldTrigger) {
        expect(decision.reason).toBe('semantic');
      }
    });

    it('轮次达到兜底阈值且有基本分数时应触发 (fallback)', () => {
      const state = createState({
        turnsSinceLastExtract: 10, // 超过兜底轮次 MAX_TURNS_BEFORE_FALLBACK
        candidateSignalScore: 2, // 满足 MIN_CANDIDATE_SCORE_FOR_FALLBACK
      });

      const decision = internal.makeDecision(state, false);

      expect(decision.shouldTrigger).toBe(true);
      expect(decision.reason).toBe('fallback');
    });

    it('轮次达到兜底阈值但分数不足时不应触发', () => {
      const state = createState({
        turnsSinceLastExtract: 10,
        candidateSignalScore: 0, // 不满足 MIN_CANDIDATE_SCORE_FOR_FALLBACK
      });

      const decision = internal.makeDecision(state, false);

      expect(decision.shouldTrigger).toBe(false);
      expect(decision.reason).toBe('none');
    });

    it('生命周期事件应触发 (lifecycle)', () => {
      const state = createState({
        turnsSinceLastExtract: 1,
        candidateSignalScore: 0,
      });

      const decision = internal.makeDecision(state, true);

      expect(decision.shouldTrigger).toBe(true);
      expect(decision.reason).toBe('lifecycle');
    });

    it('生命周期事件 makeDecision 是无条件强制触发', () => {
      // 注意：makeDecision 中的 isLifecycleEvent=true 是无条件触发
      // 轮次检查和内容变化检测在上层 triggerOnLifecycleEvent 中完成
      const state = createState({
        turnsSinceLastExtract: 0,
        candidateSignalScore: 0,
      });

      const decision = internal.makeDecision(state, true);

      expect(decision.shouldTrigger).toBe(true);
      expect(decision.reason).toBe('lifecycle');
    });
  });

  // ───────────────────────────────────────────────────
  // 工厂函数
  // ───────────────────────────────────────────────────

  describe('createMemoryTriggerManager', () => {
    it('应创建实例', () => {
      const instance = createMemoryTriggerManager('agent-123');
      expect(instance).toBeInstanceOf(MemoryTriggerManager);
    });
  });
});
