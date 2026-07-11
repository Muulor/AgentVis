import { describe, expect, it, vi } from 'vitest';
import { SubAgentRunner, type LLMCaller, type LLMResponse } from '../SubAgentRunner';
import type { SubAgentSpec } from '../../brain/types';
import type { TaskContext } from '../types';
import { DEFAULT_LOOP_CONFIG } from '../types';

const createSpec = (overrides: Partial<SubAgentSpec> = {}): SubAgentSpec => ({
  role: 'api-retry-tester',
  allowedTools: ['read'],
  terminationCondition: 'complete',
  loopConfig: {
    ...DEFAULT_LOOP_CONFIG,
    initialBudget: 5,
    maxSteps: 5,
  },
  ...overrides,
});

const createContext = (): TaskContext => ({
  cwd: '/test',
  files: [],
});

const installImmediateRetryTimers = (): ReturnType<typeof vi.spyOn> => {
  const retryDelaysMs = new Set([3000, 8000, 20000]);
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  setTimeoutSpy.mockImplementation(
    (
      handler: Parameters<typeof setTimeout>[0],
      timeout?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      if (
        typeof timeout === 'number' &&
        retryDelaysMs.has(timeout) &&
        typeof handler === 'function'
      ) {
        queueMicrotask(() => handler(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }
  );
  return setTimeoutSpy;
};

describe('SubAgentRunner API retry', () => {
  it('retries transient 524 API errors and preserves the same SA decision step', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    try {
      const callWithContext = vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          error: 'API returned an error (524 <unknown status code>): error code: 524',
        } satisfies LLMResponse)
        .mockResolvedValueOnce({
          content: 'Recovered TASK_COMPLETE',
          rawToolCalls: [],
        } satisfies LLMResponse);
      const mockCaller: LLMCaller = {
        callWithContext,
      };
      const runner = new SubAgentRunner(mockCaller);
      runner.setToolExecutor(vi.fn());

      const runPromise = runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

      const result = await runPromise;

      expect(callWithContext).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
      expect(result.status).toBe('completed');
      expect(result.observations).toContain('Recovered TASK_COMPLETE');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('fails after exhausting transient API retries', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    try {
      const callWithContext = vi.fn().mockResolvedValue({
        content: '',
        error: 'API returned an error (524 <unknown status code>): error code: 524',
      } satisfies LLMResponse);
      const mockCaller: LLMCaller = {
        callWithContext,
      };
      const runner = new SubAgentRunner(mockCaller);
      runner.setToolExecutor(vi.fn());

      const runPromise = runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

      const result = await runPromise;

      expect(callWithContext).toHaveBeenCalledTimes(4);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20000);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('524');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('does not retry 413 payload-too-large API errors', async () => {
    const mockCaller: LLMCaller = {
      callWithContext: vi.fn().mockResolvedValue({
        content: '',
        error: 'API returned an error (413 Payload Too Large): rate_limit_exceeded',
      } satisfies LLMResponse),
    };
    const runner = new SubAgentRunner(mockCaller);
    runner.setToolExecutor(vi.fn());

    const result = await runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

    expect(mockCaller.callWithContext).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('413');
  });
});
