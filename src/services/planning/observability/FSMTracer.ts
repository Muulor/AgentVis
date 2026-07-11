/**
 * FSMTracer - FSM 状态追踪器
 *
 * 职责：
 * - 记录所有 FSM 状态转移
 * - 生成完整执行轨迹
 * - 支持导出到 JSON 文件（Debug）
 *
 * 设计原则：
 * - 同步记录，避免异步带来的顺序问题
 * - 轻量存储，仅保存必要信息
 */

import type { AgentServiceState, FSMEvent, FSMTraceEntry } from '../fsm/types';
import type { FSMTrace } from './types';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * Trace 结果类型
 */
export type TraceOutcome = 'success' | 'error' | 'cancelled' | 'timeout';

/**
 * 记录条目输入（不含 timestamp，由 Tracer 自动添加）
 */
export type TraceEntryInput = Omit<FSMTraceEntry<AgentServiceState, FSMEvent>, 'timestamp'>;

// ═══════════════════════════════════════════════════════════════
// FSMTracer 实现
// ═══════════════════════════════════════════════════════════════

/**
 * FSM 状态追踪器
 *
 * 记录完整的 FSM 执行轨迹，支持 Debug 和回放分析
 */
export class FSMTracer {
  private sessionId: string | null = null;
  private startTime: Date | null = null;
  private endTime: Date | null = null;
  private entries: FSMTraceEntry<AgentServiceState, FSMEvent>[] = [];
  private outcome: TraceOutcome | undefined = undefined;

  /**
   * 启动新会话
   *
   * 生成唯一 sessionId 并重置所有状态
   */
  startSession(): void {
    this.sessionId = crypto.randomUUID();
    this.startTime = new Date();
    this.endTime = null;
    this.entries = [];
    this.outcome = undefined;
  }

  /**
   * 结束当前会话
   *
   * @param outcome 最终结果
   */
  endSession(outcome: TraceOutcome): void {
    this.endTime = new Date();
    this.outcome = outcome;
  }

  /**
   * 检查会话是否活跃
   */
  isSessionActive(): boolean {
    return this.sessionId !== null && this.startTime !== null;
  }

  /**
   * 记录状态转移
   *
   * @param entry 转移记录（不含 timestamp）
   * @throws 如果没有活跃会话
   */
  record(entry: TraceEntryInput): void {
    if (!this.isSessionActive()) {
      throw new Error('No active session. Call startSession() first.');
    }

    this.entries.push({
      ...entry,
      timestamp: new Date(),
    });
  }

  /**
   * 获取完整执行轨迹
   */
  getFullTrace(): FSMTrace {
    return {
      sessionId: this.sessionId ?? '',
      startTime: this.startTime ?? new Date(),
      timeline: [...this.entries],
      outcome: this.outcome ?? 'success',
      endTime: this.endTime ?? undefined,
      totalDuration: this.calculateDuration(),
    };
  }

  /**
   * 导出为 JSON 字符串
   *
   * @returns 格式化的 JSON 字符串
   */
  exportToJSON(): string {
    const trace = this.getFullTrace();
    return JSON.stringify(trace, null, 2);
  }

  /**
   * 计算总耗时（毫秒）
   */
  private calculateDuration(): number | undefined {
    if (!this.startTime) {
      return undefined;
    }

    const end = this.endTime ?? new Date();
    return end.getTime() - this.startTime.getTime();
  }
}
