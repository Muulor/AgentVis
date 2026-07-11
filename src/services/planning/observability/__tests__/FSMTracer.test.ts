/**
 * FSMTracer 单元测试
 *
 * 测试 FSM 状态追踪器的核心功能：
 * - 会话管理（启动、重置）
 * - 状态转移记录
 * - 轨迹获取
 * - 结果判定
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FSMTracer } from '../FSMTracer';
import type { FSMEvent } from '../../fsm/types';

describe('FSMTracer', () => {
  let tracer: FSMTracer;

  beforeEach(() => {
    tracer = new FSMTracer();
  });

  // ═══════════════════════════════════════════════════════════════
  // 会话管理测试
  // ═══════════════════════════════════════════════════════════════

  describe('会话管理', () => {
    it('startSession 应生成唯一 sessionId', () => {
      tracer.startSession();
      const trace1 = tracer.getFullTrace();

      tracer.startSession();
      const trace2 = tracer.getFullTrace();

      expect(trace1.sessionId).toBeTruthy();
      expect(trace2.sessionId).toBeTruthy();
      expect(trace1.sessionId).not.toBe(trace2.sessionId);
    });

    it('startSession 应设置 startTime', () => {
      const before = new Date();
      tracer.startSession();
      const after = new Date();

      const trace = tracer.getFullTrace();
      expect(trace.startTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(trace.startTime.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('startSession 应清空已有记录', () => {
      tracer.startSession();
      tracer.record({
        iteration: 1,
        fromState: 'IDLE',
        toState: 'PREPARE_CONTEXT',
        event: { type: 'USER_REQUEST' } as FSMEvent,
        actionsExecuted: [],
        budgetSnapshot: { remaining: 20, risk: 0, progress: true },
        duration: 10,
      });

      tracer.startSession();
      const trace = tracer.getFullTrace();

      expect(trace.timeline).toHaveLength(0);
    });

    it('isSessionActive 应正确返回会话状态', () => {
      expect(tracer.isSessionActive()).toBe(false);

      tracer.startSession();
      expect(tracer.isSessionActive()).toBe(true);
    });

    it('endSession 应设置结束时间和总耗时', () => {
      tracer.startSession();

      // 模拟一些时间流逝
      tracer.endSession('success');

      const trace = tracer.getFullTrace();
      expect(trace.endTime).toBeDefined();
      expect(trace.totalDuration).toBeDefined();
      expect(trace.outcome).toBe('success');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 记录测试
  // ═══════════════════════════════════════════════════════════════

  describe('状态转移记录', () => {
    beforeEach(() => {
      tracer.startSession();
    });

    it('record 应添加带时间戳的条目', () => {
      const before = new Date();

      tracer.record({
        iteration: 1,
        fromState: 'IDLE',
        toState: 'PREPARE_CONTEXT',
        event: { type: 'USER_REQUEST' } as FSMEvent,
        actionsExecuted: ['initContext'],
        budgetSnapshot: { remaining: 20, risk: 0, progress: true },
        duration: 15,
      });

      const after = new Date();
      const trace = tracer.getFullTrace();

      expect(trace.timeline).toHaveLength(1);
      expect(trace.timeline[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(trace.timeline[0]!.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('record 应按顺序累积条目', () => {
      tracer.record({
        iteration: 1,
        fromState: 'IDLE',
        toState: 'PREPARE_CONTEXT',
        event: { type: 'USER_REQUEST' } as FSMEvent,
        actionsExecuted: [],
        budgetSnapshot: { remaining: 20, risk: 0, progress: true },
        duration: 10,
      });

      tracer.record({
        iteration: 2,
        fromState: 'PREPARE_CONTEXT',
        toState: 'MASTER_DECISION',
        event: { type: 'CONTEXT_READY' } as FSMEvent,
        actionsExecuted: ['prepareDecision'],
        budgetSnapshot: { remaining: 19, risk: 0, progress: true },
        duration: 20,
      });

      const trace = tracer.getFullTrace();

      expect(trace.timeline).toHaveLength(2);
      expect(trace.timeline[0]!.fromState).toBe('IDLE');
      expect(trace.timeline[1]!.fromState).toBe('PREPARE_CONTEXT');
    });

    it('record 应保留所有字段', () => {
      tracer.record({
        iteration: 3,
        fromState: 'MASTER_DECISION',
        toState: 'DISPATCH',
        event: { type: 'DECISION_RECEIVED' } as FSMEvent,
        guardResult: true,
        actionsExecuted: ['dispatchAction', 'logDecision'],
        budgetSnapshot: {
          remaining: 15,
          risk: 0.2,
          progress: true,
        },
        duration: 50,
      });

      const trace = tracer.getFullTrace();
      const entry = trace.timeline[0];

      expect(entry!.iteration).toBe(3);
      expect(entry!.fromState).toBe('MASTER_DECISION');
      expect(entry!.toState).toBe('DISPATCH');
      expect(entry!.guardResult).toBe(true);
      expect(entry!.actionsExecuted).toEqual(['dispatchAction', 'logDecision']);
      expect(entry!.budgetSnapshot.remaining).toBe(15);
      expect(entry!.duration).toBe(50);
    });

    it('未启动会话时 record 应抛出错误', () => {
      const freshTracer = new FSMTracer();

      expect(() =>
        freshTracer.record({
          iteration: 1,
          fromState: 'IDLE',
          toState: 'PREPARE_CONTEXT',
          event: { type: 'USER_REQUEST' } as FSMEvent,
          actionsExecuted: [],
          budgetSnapshot: { remaining: 20, risk: 0, progress: true },
          duration: 10,
        })
      ).toThrow('No active session');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 轨迹获取测试
  // ═══════════════════════════════════════════════════════════════

  describe('轨迹获取', () => {
    it('getFullTrace 应返回完整结构', () => {
      tracer.startSession();

      const trace = tracer.getFullTrace();

      expect(trace).toHaveProperty('sessionId');
      expect(trace).toHaveProperty('startTime');
      expect(trace).toHaveProperty('timeline');
      expect(trace).toHaveProperty('outcome');
    });

    it('未结束会话时 outcome 应为 undefined 或默认值', () => {
      tracer.startSession();

      const trace = tracer.getFullTrace();

      // 未明确结束时，outcome 可以是 undefined 或有默认值
      expect(['success', 'error', 'cancelled', 'timeout', undefined]).toContain(trace.outcome);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 结果判定测试
  // ═══════════════════════════════════════════════════════════════

  describe('结果判定', () => {
    beforeEach(() => {
      tracer.startSession();
    });

    it('endSession 应设置正确的 outcome', () => {
      tracer.endSession('error');
      expect(tracer.getFullTrace().outcome).toBe('error');
    });

    it('endSession 应设置 cancelled outcome', () => {
      tracer.endSession('cancelled');
      expect(tracer.getFullTrace().outcome).toBe('cancelled');
    });

    it('endSession 应设置 timeout outcome', () => {
      tracer.endSession('timeout');
      expect(tracer.getFullTrace().outcome).toBe('timeout');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 导出测试
  // ═══════════════════════════════════════════════════════════════

  describe('轨迹导出', () => {
    it('exportToJSON 应返回有效的 JSON 字符串', () => {
      tracer.startSession();
      tracer.record({
        iteration: 1,
        fromState: 'IDLE',
        toState: 'PREPARE_CONTEXT',
        event: { type: 'USER_REQUEST' } as FSMEvent,
        actionsExecuted: [],
        budgetSnapshot: { remaining: 20, risk: 0, progress: true },
        duration: 10,
      });

      const jsonStr = tracer.exportToJSON();
      const parsed = JSON.parse(jsonStr);

      expect(parsed.sessionId).toBe(tracer.getFullTrace().sessionId);
      expect(parsed.timeline).toHaveLength(1);
    });

    it('exportToJSON 应格式化输出', () => {
      tracer.startSession();
      const jsonStr = tracer.exportToJSON();

      // 检查是否包含换行符（格式化的标志）
      expect(jsonStr).toContain('\n');
    });
  });
});
