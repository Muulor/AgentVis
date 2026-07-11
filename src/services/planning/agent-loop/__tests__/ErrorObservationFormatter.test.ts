/**
 * ErrorObservationFormatter 测试
 *
 * 验证 Agent Loop 错误分类和用户可见失败消息。
 */

import { describe, expect, it } from 'vitest';
import {
  classifyAgentLoopError,
  formatAgentLoopFailureMessage,
  getAgentLoopErrorKindForTerminationReason,
} from '../ErrorObservationFormatter';

describe('ErrorObservationFormatter', () => {
  it('classifies stream transfer errors before generic abort wording', () => {
    const result = classifyAgentLoopError(
      'Task aborted. LLM API call failed with a stream transfer error: terminating loop'
    );

    expect(result.kind).toBe('stream_idle_timeout');
  });

  it('classifies provider API errors', () => {
    const result = classifyAgentLoopError('LLM API call failed: 429 Too Many Requests');

    expect(result.kind).toBe('provider_api_error');
  });

  it('classifies manual stop errors', () => {
    const result = classifyAgentLoopError(new DOMException('User aborted the task', 'AbortError'));

    expect(result.kind).toBe('manual_stop');
    expect(classifyAgentLoopError('cancelled').kind).toBe('manual_stop');
  });

  it('classifies checkpoint and Sub-Agent circuit-breaker errors', () => {
    expect(classifyAgentLoopError('high_risk_checkpoint_failed').kind).toBe('checkpoint_failure');
    expect(classifyAgentLoopError('Sub-Agent failed 4 consecutive times').kind).toBe(
      'sub_agent_failure_circuit_breaker'
    );
  });

  it('maps known Sub-Agent termination reasons to categorized error kinds', () => {
    expect(getAgentLoopErrorKindForTerminationReason('api_error')).toBe('provider_api_error');
    expect(getAgentLoopErrorKindForTerminationReason('cancelled')).toBe('manual_stop');
    expect(getAgentLoopErrorKindForTerminationReason('high_risk_checkpoint_failed')).toBe(
      'checkpoint_failure'
    );
    expect(getAgentLoopErrorKindForTerminationReason('consecutive_failures')).toBe(
      'sub_agent_failure_circuit_breaker'
    );
  });

  it('formats localized failure messages with progress preservation and details', () => {
    const message = formatAgentLoopFailureMessage('LLM API call failed: 503 Service Unavailable');

    expect(message).toContain('Agent 执行失败');
    expect(message).toContain('Provider API 调用失败');
    expect(message).toContain('已保留已完成的任务进展');
    expect(message).toContain('503 Service Unavailable');
  });
});
