import { describe, expect, it, vi } from 'vitest';
import { translate } from '@/i18n';
import { SubAgentRunner, type LLMCaller, type LLMResponse } from '../SubAgentRunner';
import type { SubAgentSpec } from '../../brain/types';
import { DEFAULT_LOOP_CONFIG, type TaskContext } from '../types';

const createSpec = (): SubAgentSpec => ({
  role: 'output-truncation-tester',
  allowedTools: ['file_write'],
  terminationCondition: 'complete',
  loopConfig: {
    ...DEFAULT_LOOP_CONFIG,
    initialBudget: 5,
    maxSteps: 5,
  },
});

const createContext = (): TaskContext => ({
  cwd: '/workspace',
  files: [],
});

const createTruncatedWriteResponse = (finishReason: string): LLMResponse => ({
  content: 'Writing the generated page.',
  finishReason,
  rawToolCalls: [
    {
      name: 'file_write',
      args: {
        path: '/workspace/index.html',
        content: '<!doctype html><html><body>incomplete',
      },
    },
  ],
});

describe('SubAgentRunner output truncation safety', () => {
  it('discards a token-truncated file_write response without executing it', async () => {
    const callWithContext = vi
      .fn()
      .mockResolvedValueOnce(createTruncatedWriteResponse('MAX_TOKENS'))
      .mockResolvedValueOnce({
        content: 'Stopped safely. TASK_COMPLETE',
        finishReason: 'stop',
        rawToolCalls: [],
      } satisfies LLMResponse);
    const toolExecutor = vi.fn();
    const runner = new SubAgentRunner({ callWithContext } satisfies LLMCaller);
    runner.setToolExecutor(toolExecutor);

    const result = await runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

    expect(callWithContext).toHaveBeenCalledTimes(2);
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.toolCalls).toEqual([]);
    expect(callWithContext.mock.calls[1]?.[3]).toContain(
      translate('chat.subAgentOutputTruncatedRetryInstruction', { reason: 'MAX_TOKENS' }).split(
        '\n'
      )[0]
    );
  });

  it('retries once after truncation and can execute a complete replacement write', async () => {
    const completeContent = '<!doctype html><html><body>complete</body></html>';
    const callWithContext = vi
      .fn()
      .mockResolvedValueOnce(createTruncatedWriteResponse('length'))
      .mockResolvedValueOnce({
        content: 'Writing a short complete skeleton.',
        finishReason: 'stop',
        rawToolCalls: [
          {
            name: 'file_write',
            args: {
              path: '/workspace/index.html',
              content: completeContent,
            },
          },
        ],
      } satisfies LLMResponse)
      .mockResolvedValueOnce({
        content: 'Write completed. TASK_COMPLETE',
        finishReason: 'stop',
        rawToolCalls: [],
      } satisfies LLMResponse);
    const toolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'File written',
    });
    const runner = new SubAgentRunner({ callWithContext } satisfies LLMCaller);
    runner.setToolExecutor(toolExecutor);

    const result = await runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

    expect(callWithContext).toHaveBeenCalledTimes(3);
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(
      {
        name: 'file_write',
        args: {
          path: '/workspace/index.html',
          content: completeContent,
        },
      },
      { signal: undefined }
    );
    expect(result.status).toBe('completed');
    expect(result.toolCalls).toEqual(['file_write']);
  });

  it('fails after a second token-truncated response and never executes either write', async () => {
    const callWithContext = vi
      .fn()
      .mockResolvedValueOnce(createTruncatedWriteResponse('max_output_tokens'))
      .mockResolvedValueOnce(createTruncatedWriteResponse('incomplete'));
    const toolExecutor = vi.fn();
    const runner = new SubAgentRunner({ callWithContext } satisfies LLMCaller);
    runner.setToolExecutor(toolExecutor);

    const result = await runner.runWithDynamicLoop(createSpec(), createContext(), vi.fn(), []);

    expect(callWithContext).toHaveBeenCalledTimes(2);
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.outputValid).toBe(false);
    expect(result.executionStatus).toBe('failure');
    expect(result.toolCalls).toEqual([]);
    expect(result.error).toBe(
      translate('chat.subAgentOutputTruncatedFailure', { reason: 'incomplete' })
    );
  });
});
