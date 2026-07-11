/**
 * Sub-Agent 类型定义测试
 *
 * 测试统一输出类型、工厂函数和 Loop 配置守卫
 *
 * 设计说明：
 * 移除固定分类后，不再有类型守卫（isResearchAgentOutput 等）。
 * 输出类型统一为 SubAgentOutput，createFailedOutput 只接收 error 参数。
 */

import { describe, it, expect } from 'vitest';
import { createFailedOutput, DEFAULT_LOOP_CONFIG, type SubAgentOutput } from '../types';

// ═══════════════════════════════════════════════════════════════
// SubAgentOutput 结构测试
// ═══════════════════════════════════════════════════════════════

describe('SubAgentOutput 结构', () => {
  it('应支持完成状态', () => {
    const output: SubAgentOutput = {
      status: 'completed',
      outputValid: true,
      observations: '任务完成',
      uncertaintyDelta: -0.1,
    };

    expect(output.status).toBe('completed');
    expect(output.outputValid).toBe(true);
    expect(output.observations).toBe('任务完成');
  });

  it('应支持失败状态', () => {
    const output: SubAgentOutput = {
      status: 'failed',
      outputValid: false,
      observations: '',
      uncertaintyDelta: 0,
      error: '执行超时',
    };

    expect(output.status).toBe('failed');
    expect(output.error).toBe('执行超时');
  });

  it('应支持可选字段', () => {
    const output: SubAgentOutput = {
      status: 'completed',
      outputValid: true,
      observations: '文件已写入',
      uncertaintyDelta: 0,
      requiresInteraction: true,
      toolCalls: ['file_write', 'read'],
      observedEffects: '创建了 output.txt',
      executionStatus: 'success',
    };

    expect(output.requiresInteraction).toBe(true);
    expect(output.toolCalls).toContain('file_write');
    expect(output.observedEffects).toBe('创建了 output.txt');
    expect(output.executionStatus).toBe('success');
  });
});

// ═══════════════════════════════════════════════════════════════
// createFailedOutput 测试
// ═══════════════════════════════════════════════════════════════

describe('createFailedOutput', () => {
  it('应创建统一的失败输出', () => {
    const errorMessage = '工具调用失败';
    const output = createFailedOutput(errorMessage);

    expect(output.status).toBe('failed');
    expect(output.outputValid).toBe(false);
    expect(output.observations).toBe('');
    expect(output.uncertaintyDelta).toBe(0);
    expect(output.error).toBe(errorMessage);
  });

  it('失败输出不应包含 agentType（已移除分类）', () => {
    const output = createFailedOutput('error');
    // 统一输出不再有 agentType 字段
    expect((output as unknown as Record<string, unknown>)['agentType']).toBeUndefined();
  });

  it('不同错误信息应正确传递', () => {
    const errors = ['LLM 超时', '策略违规', '工具权限不足'];

    errors.forEach((err) => {
      const output = createFailedOutput(err);
      expect(output.error).toBe(err);
      expect(output.status).toBe('failed');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// DEFAULT_LOOP_CONFIG 测试
// ═══════════════════════════════════════════════════════════════

describe('DEFAULT_LOOP_CONFIG', () => {
  it('应有合理的默认值', () => {
    expect(DEFAULT_LOOP_CONFIG.initialBudget).toBeGreaterThan(0);
    expect(DEFAULT_LOOP_CONFIG.checkpointInterval).toBeGreaterThan(0);
    expect(DEFAULT_LOOP_CONFIG.maxSteps).toBeGreaterThan(0);
  });

  it('应包含终止信号模式', () => {
    expect(DEFAULT_LOOP_CONFIG.terminationPatterns.length).toBeGreaterThan(0);
    expect(DEFAULT_LOOP_CONFIG.terminationPatterns).toContain('TASK_COMPLETE');
  });

  it('maxSteps 应大于 initialBudget（作为熔断机制）', () => {
    expect(DEFAULT_LOOP_CONFIG.maxSteps).toBeGreaterThan(DEFAULT_LOOP_CONFIG.initialBudget);
  });
});
