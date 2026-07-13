import { describe, it, expect, vi } from 'vitest';
import { SubAgentRunner, type LLMCaller, type LLMResponse } from '../SubAgentRunner';
import type { SubAgentSpec, CheckpointCallback } from '../../brain/types';
import type { TaskContext, AccumulatedMessage } from '../types';
import type { SubAgentObservationEvent } from '../../agent-loop/types';
import { TaskArtifactStore } from '../../artifact/TaskArtifactStore';
import { useStatusStore } from '@stores/statusStore';
import { translate } from '@/i18n';

function generateLargeText(marker: string, lineCount = 700): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `path: /src/large-result.ts line ${index}: ${marker} ${'x'.repeat(100)}`
  ).join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SubAgentRunner - Tool Calls Summary', () => {
  it('retries an empty text decision with stricter guidance', async () => {
    const receivedInstructions: Array<string | undefined> = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            _accumulatedContext: AccumulatedMessage[],
            additionalInstructions?: string
          ): Promise<LLMResponse> => {
            receivedInstructions.push(additionalInstructions);
            callCount++;
            if (callCount === 1) {
              return { content: '', rawToolCalls: [] };
            }
            if (callCount === 2) {
              return {
                content: 'Retrying with a concrete action.',
                rawToolCalls: [{ name: 'read', args: { path: '/test.md' } }],
              };
            }
            return {
              content: 'Task completed. TASK_COMPLETE',
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'Read complete',
    });
    const observations: SubAgentObservationEvent[] = [];
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);
    runner.setObservationCallback((event) => observations.push(event));

    const spec: SubAgentSpec = {
      role: 'Reader',
      allowedTools: ['read'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['Task completed'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(mockToolExecutor).toHaveBeenCalledTimes(1);
    expect(receivedInstructions[0]).toBeUndefined();
    expect(receivedInstructions[1]).toContain(
      translate('chat.subAgentEmptyDecisionRetryInstruction').split('\n')[0]
    );
    expect(observations[0]?.toolAction).toBeUndefined();
    expect(observations[0]?.thinking.trim().length).toBeGreaterThan(0);
  });

  it('warns after consecutive text-only decisions and terminates if the next decision still has no tool call', async () => {
    const receivedInstructions: Array<string | undefined> = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            _accumulatedContext: AccumulatedMessage[],
            additionalInstructions?: string
          ): Promise<LLMResponse> => {
            receivedInstructions.push(additionalInstructions);
            callCount++;
            return {
              content: `Text-only decision ${callCount}`,
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'Tool executed',
    });
    const observations: SubAgentObservationEvent[] = [];
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);
    runner.setObservationCallback((event) => observations.push(event));

    const spec: SubAgentSpec = {
      role: 'Reader',
      allowedTools: ['read'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['Task completed'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(mockToolExecutor).not.toHaveBeenCalled();
    expect(callCount).toBe(3);
    expect(receivedInstructions[0]).toBeUndefined();
    expect(receivedInstructions[1]).toBeUndefined();
    expect(receivedInstructions[2]).toContain('TASK_COMPLETE');
    expect(observations.some((event) => event.thinking.includes('2'))).toBe(true);
    expect(output.observedEffects).toContain(
      translate('chat.subAgentObservedEffects', {
        count: 0,
        tools: '',
      })
    );
  });

  it('does not treat the same exec command in different workdirs as an identical repeat', async () => {
    const workdirs = [
      'D:\\sdk-python-main',
      'D:\\sdk-python-main\\src',
      'D:\\sdk-python-main\\tests',
      'D:\\sdk-python-main\\docs',
    ];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        const workdir = workdirs[callCount - 1];
        if (workdir) {
          return {
            content: '',
            rawToolCalls: [{ name: 'exec', args: { command: 'dir /b', workdir } }],
          };
        }
        return {
          content: 'Directory checks complete. TASK_COMPLETE',
          rawToolCalls: [],
        };
      }),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'ok',
    });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'DirectoryReader',
      allowedTools: ['exec'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 6,
        checkpointInterval: 10,
        maxSteps: 6,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(
      spec,
      { files: [], cwd: 'D:\\sdk-python-main' },
      vi.fn(),
      []
    );

    expect(output.observations).toContain('TASK_COMPLETE');
    expect(mockLLMCaller.callWithContext).toHaveBeenCalledTimes(5);
    expect(mockToolExecutor).toHaveBeenCalledTimes(4);
  });

  it('stops immediately when identical exec commands repeat in the same workdir', async () => {
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockResolvedValue({
        content: '',
        rawToolCalls: [
          { name: 'exec', args: { command: 'dir /b', workdir: 'D:\\sdk-python-main' } },
          { name: 'exec', args: { command: 'dir /b', workdir: 'D:\\sdk-python-main' } },
          { name: 'exec', args: { command: 'dir /b', workdir: 'D:\\sdk-python-main' } },
          { name: 'local_search', args: { mode: 'find', pattern: '*.py' } },
        ],
      }),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'ok',
    });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'DirectoryReader',
      allowedTools: ['exec', 'local_search'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 5,
        checkpointInterval: 10,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(
      spec,
      { files: [], cwd: 'D:\\sdk-python-main' },
      vi.fn(),
      []
    );

    expect(mockToolExecutor).toHaveBeenCalledTimes(3);
    expect(mockToolExecutor).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'local_search' }),
      expect.anything()
    );
    expect(output.observedEffects).toBe(
      translate('chat.subAgentObservedEffects', {
        count: 3,
        tools: 'exec, exec, exec',
      })
    );
  });

  it('should include tool call arguments in the final loop summary', async () => {
    // 1. Mock LLMCaller
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            _accumulatedContext: AccumulatedMessage[],
            _additionalInstructions?: string
          ): Promise<LLMResponse> => {
            callCount++;
            // 第一次调用：返回工具调用
            if (callCount === 1) {
              return {
                content: 'I will write the file now.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: {
                      path: '/test.md',
                      content: '# Very Long Content That Should Be Visible',
                    },
                  },
                ],
                requiresInteraction: false,
              };
            }
            // 后续调用：返回终止信号
            return {
              content: 'Task completed. TASK_COMPLETE',
              output: { executionStatus: 'success' },
              rawToolCalls: [],
            };
          }
        ),
    };

    // 2. Setup Runner（必须设置 toolExecutor，否则 runWithDynamicLoop 会抛出错误）
    const mockToolExecutor = vi.fn().mockResolvedValue({ success: true, content: 'Tool executed' });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    // 3. Setup Spec with Loop
    const spec: SubAgentSpec = {
      role: 'Writer',
      allowedTools: ['file_write'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5, // Won't trigger in this short test
        maxSteps: 5,
        terminationPatterns: ['Task completed'],
      },
    };

    const context: TaskContext = { files: [], cwd: '/' };
    const onCheckpoint: CheckpointCallback = vi.fn();

    // 4. Run Loop
    // We override run logic slightly because we can't easily mock the internal behavior of 'executeIteration' adding the tool result msg.
    // Wait, executeIteration adds the 'model' (or 'assistant') message with toolCalls.
    // But the 'tool' result message comes from 'this.run' which we can't fully mock without mocking factory.
    // callWithContext (LLMCaller) handles context accumulation!

    const output = await runner.runWithDynamicLoop(spec, context, onCheckpoint, []);

    // 5. Verify Output
    expect(output.status).toBe('completed');

    // observations 包含 LLM 最后的文本响应
    expect(output.observations).toContain('Task completed');

    // observedEffects 包含工具调用摘要
    expect(output.observedEffects).toContain('file_write');
  });

  it('preserves Gemini thought signatures in the accumulated tool-call history', async () => {
    const capturedContexts: AccumulatedMessage[][] = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            accumulatedContext: AccumulatedMessage[]
          ): Promise<LLMResponse> => {
            capturedContexts.push(accumulatedContext);
            callCount++;

            if (callCount === 1) {
              return {
                content: 'Reading the target file.',
                rawToolCalls: [
                  {
                    name: 'read',
                    args: { path: '/test.md' },
                    id: 'gemini-call-1',
                    thoughtSignature: 'gemini-signature-1',
                  },
                ],
              };
            }

            return {
              content: 'Done. TASK_COMPLETE',
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'Read complete',
    });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'Reader',
      allowedTools: ['read'],
      terminationCondition: 'Task completed',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    const secondCallContext = capturedContexts[1] ?? [];
    const assistantMessage = secondCallContext.find((message) => message.role === 'assistant');
    expect(assistantMessage?.toolCalls?.[0]).toMatchObject({
      id: 'gemini-call-1',
      thoughtSignature: 'gemini-signature-1',
    });
  });

  it('feeds a corrective tool result back when file_write full mode is missing content', async () => {
    const capturedContexts: AccumulatedMessage[][] = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            accumulatedContext: AccumulatedMessage[],
            _additionalInstructions?: string
          ): Promise<LLMResponse> => {
            capturedContexts.push(accumulatedContext);
            callCount++;

            if (callCount === 1) {
              return {
                content: 'I will create the document.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: { path: '/tech-spec.md' },
                  },
                ],
              };
            }

            if (callCount === 2) {
              return {
                content: 'Retrying with complete content.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: { path: '/tech-spec.md', content: '# Tech Spec\n\nComplete skeleton.' },
                  },
                ],
              };
            }

            return {
              content: 'Document created. TASK_COMPLETE',
              output: { executionStatus: 'success' },
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'File written successfully',
    });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'Writer',
      allowedTools: ['file_write'],
      terminationCondition: 'Document created',
      loopConfig: {
        initialBudget: 3,
        checkpointInterval: 10,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(mockToolExecutor).toHaveBeenCalledTimes(1);
    expect(mockToolExecutor).toHaveBeenCalledWith(
      {
        name: 'file_write',
        args: { path: '/tech-spec.md', content: '# Tech Spec\n\nComplete skeleton.' },
      },
      expect.any(Object)
    );

    const secondCallContext = capturedContexts[1];
    expect(JSON.stringify(secondCallContext)).toContain('content/contentRef');
    expect(JSON.stringify(secondCallContext)).toContain('/tech-spec.md');
  });

  it('adds stricter guidance after repeated file_write full-mode missing content', async () => {
    const receivedInstructions: Array<string | undefined> = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            _accumulatedContext: AccumulatedMessage[],
            additionalInstructions?: string
          ): Promise<LLMResponse> => {
            receivedInstructions.push(additionalInstructions);
            callCount++;

            if (callCount <= 2) {
              return {
                content: 'Trying to write the document.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: { path: '/prd.md' },
                  },
                ],
              };
            }

            return {
              content: 'The tool argument stream kept truncating. TASK_COMPLETE',
              output: { executionStatus: 'blocked' },
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'File written successfully',
    });
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'Writer',
      allowedTools: ['file_write'],
      terminationCondition: 'Document created or blocked',
      loopConfig: {
        initialBudget: 3,
        checkpointInterval: 10,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(mockToolExecutor).not.toHaveBeenCalled();
    expect(receivedInstructions[2]).toContain('content/contentRef');
    expect(receivedInstructions[2]).toContain('50');
    expect(receivedInstructions[2]).toContain('TASK_COMPLETE');
  });
});

describe('SubAgentRunner - Diff Data Collection', () => {
  it('should collect file_write diff data in SubAgentOutput.diffDataList', async () => {
    // 1. Mock LLMCaller：第一次返回 file_write 工具调用，第二次终止
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            _accumulatedContext: AccumulatedMessage[],
            _additionalInstructions?: string
          ): Promise<LLMResponse> => {
            callCount++;
            if (callCount === 1) {
              return {
                content: 'Writing file now.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: { path: '/src/test.ts', content: 'const x = 1;' },
                  },
                ],
                requiresInteraction: false,
              };
            }
            return {
              content: 'File written successfully. TASK_COMPLETE',
              output: { executionStatus: 'success' },
              rawToolCalls: [],
            };
          }
        ),
    };

    // 2. Mock ToolExecutor：返回包含 file_write diff data 的结果
    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: '文件已写入: /src/test.ts',
      requiresInteraction: false,
      data: {
        type: 'file_write_overwrite',
        filePath: '/src/test.ts',
        originalContent: 'const x = 0;',
        newContent: 'const x = 1;',
        diff: '- const x = 0;\n+ const x = 1;',
        changeRatio: 0.5,
      },
    });

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    // 3. 配置 Spec
    const spec: SubAgentSpec = {
      role: 'FileEditor',
      allowedTools: ['file_write'],
      terminationCondition: 'File written',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const context: TaskContext = { files: [], cwd: '/' };
    const onCheckpoint: CheckpointCallback = vi.fn();

    // 4. 执行
    const output = await runner.runWithDynamicLoop(spec, context, onCheckpoint, []);

    // 5. 验证 diff 数据正确收集
    expect(output.status).toBe('completed');
    expect(output.diffDataList).toBeDefined();
    expect(output.diffDataList).toHaveLength(1);
    expect(output.diffDataList![0]!.type).toBe('file_write_overwrite');
    expect(output.diffDataList![0]!.filePath).toBe('/src/test.ts');
    expect(output.diffDataList![0]!.originalContent).toBe('const x = 0;');
    expect(output.diffDataList![0]!.newContent).toBe('const x = 1;');
    expect(output.diffDataList![0]!.changeRatio).toBe(0.5);
  });

  it('should NOT include diffDataList when no file_write tools are called', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Reading file.',
            output: {},
            rawToolCalls: [{ name: 'read', args: { path: '/test.txt' } }],
          };
        }
        return {
          content: 'Done. TASK_COMPLETE',
          output: {},
          rawToolCalls: [],
        };
      }),
    };

    // 普通工具结果，不含 data 字段
    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'File content here',
    });

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'Reader',
      allowedTools: ['read'],
      terminationCondition: 'Done',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    // 无 file_write 调用时不应包含 diffDataList
    expect(output.diffDataList).toBeUndefined();
  });
});

describe('SubAgentRunner - Live Tool Observations', () => {
  it('stores failed tool results as task artifacts', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Testing a database client command.',
            output: {},
            rawToolCalls: [
              {
                id: 'exec-call-1',
                name: 'exec',
                args: {
                  command: 'mysql --host mysql.direct-audit.invalid --port 3307 --user agentvis',
                },
              },
            ],
          };
        }
        return {
          content: 'Failure recorded. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: false,
      content: "'mysql' is not recognized as an internal or external command",
    });

    const artifactStore = new TaskArtifactStore();
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);
    runner.setArtifactStore(artifactStore);

    const spec: SubAgentSpec = {
      role: 'NetworkDirectTester',
      allowedTools: ['exec'],
      terminationCondition: 'Failure recorded',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    const artifacts = artifactStore.getAll();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.toolName).toBe('exec');
    expect(artifacts[0]?.dataType).toBe('execution_output');
    expect(artifacts[0]?.sourceHint).toContain('mysql --host');
    expect(artifacts[0]?.content).toContain('[exec] ❌');
    expect(artifacts[0]?.content).toContain("'mysql' is not recognized");
    expect(output.observationEvents?.[0]?.toolAction?.success).toBe(false);
  });

  it('persists a completed tool result before honoring an abort signal', async () => {
    const abortController = new AbortController();
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockResolvedValue({
        content: 'Running one command before cancellation.',
        output: {},
        rawToolCalls: [
          {
            id: 'exec-call-abort',
            name: 'exec',
            args: { command: 'redis-cli -h cache.direct-audit.invalid -p 6380 PING' },
          },
        ],
      } satisfies LLMResponse),
    };

    const mockToolExecutor = vi.fn().mockImplementation(async () => {
      abortController.abort();
      return {
        success: false,
        content: 'The command returned after user cancellation',
      };
    });

    const artifactStore = new TaskArtifactStore();
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);
    runner.setArtifactStore(artifactStore);

    const spec: SubAgentSpec = {
      role: 'NetworkDirectTester',
      allowedTools: ['exec'],
      terminationCondition: 'Command result preserved',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(
      spec,
      { files: [], cwd: '/' },
      vi.fn(),
      [],
      abortController.signal
    );

    expect(mockToolExecutor).toHaveBeenCalledTimes(1);
    expect(artifactStore.getAll()[0]?.content).toContain(
      'The command returned after user cancellation'
    );
    expect(output.observationEvents?.[0]?.toolAction?.success).toBe(false);
    expect(output.toolCalls).toContain('exec');
  });

  it('keeps a stable synthetic tool call id when the provider omits one', async () => {
    const capturedContexts: AccumulatedMessage[][] = [];
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            accumulatedContext: AccumulatedMessage[]
          ): Promise<LLMResponse> => {
            capturedContexts.push(accumulatedContext);
            callCount++;
            if (callCount === 1) {
              return {
                content: 'Generating the requested image now.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'generate_image',
                    args: { prompt: 'A classroom image prompt' },
                  },
                ],
              };
            }
            return {
              content: 'Image generated. TASK_COMPLETE',
              output: { executionStatus: 'success' },
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'Image generated at /tmp/out.png',
    });

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'ImageGenerator',
      allowedTools: ['generate_image'],
      terminationCondition: 'Image generated',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(capturedContexts).toHaveLength(2);

    const secondCallContext = capturedContexts[1];
    const assistantMessage = secondCallContext?.find(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some((toolCall) => toolCall.name === 'generate_image')
    );
    const toolMessage = secondCallContext?.find(
      (message) => message.role === 'tool' && message.toolName === 'generate_image'
    );

    const generatedId = assistantMessage?.toolCalls?.[0]?.id;
    expect(generatedId).toBe('call_run1_generate_image_1_0');
    expect(toolMessage?.toolCallId).toBe(generatedId);
  });

  it('namespaces synthetic tool call ids across repeated runner executions', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount % 2 === 1) {
          return {
            content: 'Running the command.',
            output: {},
            rawToolCalls: [
              {
                name: 'exec',
                args: { command: 'echo ok' },
              },
            ],
          };
        }
        return {
          content: 'Done. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };

    const mockToolExecutor = vi.fn().mockResolvedValue({
      success: true,
      content: 'ok',
    });

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'Executor',
      allowedTools: ['exec'],
      terminationCondition: 'Done',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const first = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);
    const second = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    const firstId = first.observationEvents?.[0]?.toolAction?.toolCallId;
    const secondId = second.observationEvents?.[0]?.toolAction?.toolCallId;

    expect(firstId).toBe('call_run1_exec_1_0');
    expect(secondId).toBe('call_run2_exec_1_0');
    expect(first.observationEvents?.[0]?.runId).toBe('sa-run-1');
    expect(second.observationEvents?.[0]?.runId).toBe('sa-run-2');
    expect(secondId).not.toBe(firstId);
  });

  it('emits pending tool action before the executor resolves and stores one final observation', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Generating the requested image now.',
            output: {},
            rawToolCalls: [
              {
                id: 'tool-call-1',
                name: 'generate_image',
                args: { prompt: 'A classroom image prompt' },
              },
            ],
          };
        }
        return {
          content: 'Image generated. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };

    let resolveTool: ((value: { success: boolean; content: string }) => void) | undefined;
    const mockToolExecutor = vi.fn().mockImplementation(
      () =>
        new Promise<{ success: boolean; content: string }>((resolve) => {
          resolveTool = resolve;
        })
    );

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const liveObservations: SubAgentObservationEvent[] = [];
    runner.setObservationCallback((event) => {
      liveObservations.push(event);
    });

    const spec: SubAgentSpec = {
      role: 'ImageGenerator',
      allowedTools: ['generate_image'],
      terminationCondition: 'Image generated',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const outputPromise = runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    await waitFor(() => liveObservations.length === 1);
    expect(liveObservations[0]?.toolAction).toMatchObject({
      toolCallId: 'tool-call-1',
      tool: 'generate_image',
      target: 'A classroom image prompt',
    });
    expect(liveObservations[0]?.toolAction?.success).toBeUndefined();

    resolveTool?.({ success: true, content: 'Image generated at /tmp/out.png' });
    const output = await outputPromise;

    const liveToolObservations = liveObservations.filter((event) => event.toolAction);
    expect(liveToolObservations).toHaveLength(2);
    expect(liveToolObservations[1]?.toolAction?.toolCallId).toBe('tool-call-1');
    expect(liveToolObservations[1]?.toolAction?.success).toBe(true);

    const storedToolObservations = output.observationEvents?.filter((event) => event.toolAction);
    expect(storedToolObservations).toHaveLength(1);
    expect(storedToolObservations?.[0]?.thinking).toContain('Generating');
    expect(storedToolObservations?.[0]?.toolAction?.success).toBe(true);
  });

  it('emits explicit exec timeout seconds in live tool observations', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Downloading the model with a long timeout.',
            output: {},
            rawToolCalls: [
              {
                id: 'exec-download-call',
                name: 'exec',
                args: {
                  command: 'powershell -NoProfile -Command "download model"',
                  timeout: 1800,
                },
              },
            ],
          };
        }

        return {
          content: 'Download complete. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(
      vi.fn().mockResolvedValue({
        success: true,
        content: 'ok',
      })
    );

    const liveObservations: SubAgentObservationEvent[] = [];
    runner.setObservationCallback((event) => {
      liveObservations.push(event);
    });

    const spec: SubAgentSpec = {
      role: 'Downloader',
      allowedTools: ['exec'],
      terminationCondition: 'Download complete',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    const toolObservations = liveObservations.filter((event) => event.toolAction);
    expect(toolObservations[0]?.toolAction).toMatchObject({
      toolCallId: 'exec-download-call',
      tool: 'exec',
      timeoutSeconds: 1800,
    });
    expect(toolObservations[0]?.toolAction?.success).toBeUndefined();
    expect(toolObservations[1]?.toolAction).toMatchObject({
      toolCallId: 'exec-download-call',
      tool: 'exec',
      timeoutSeconds: 1800,
      success: true,
    });
  });

  it('uses Script Skill name as external_skill_execute observation target', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Searching arXiv.',
            output: {},
            rawToolCalls: [
              {
                id: 'tool-call-arxiv',
                name: 'external_skill_execute',
                args: {
                  skillName: 'arxiv-search',
                  args: { action: 'search', query: 'AI agents' },
                },
              },
            ],
          };
        }
        return {
          content: 'Search complete. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(
      vi.fn().mockResolvedValue({
        success: true,
        content: 'ok',
      })
    );

    const liveObservations: SubAgentObservationEvent[] = [];
    runner.setObservationCallback((event) => {
      liveObservations.push(event);
    });

    const spec: SubAgentSpec = {
      role: 'Researcher',
      allowedTools: ['external_skill_execute'],
      terminationCondition: 'Search complete',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(liveObservations[0]?.toolAction).toMatchObject({
      tool: 'external_skill_execute',
      target: 'arxiv-search',
    });
    expect(output.observationEvents?.[0]?.toolAction).toMatchObject({
      tool: 'external_skill_execute',
      target: 'arxiv-search',
      success: true,
    });
  });

  it('uses full paths and effective exec workdir as observation targets', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Inspecting concrete paths.',
            output: {},
            rawToolCalls: [
              {
                id: 'read-path-call',
                name: 'read',
                args: { path: 'src/services/planning/sub-agents/SubAgentRunner.ts' },
              },
              {
                id: 'write-path-call',
                name: 'file_write',
                args: { path: 'docs/tech_analysis.md', content: '# Tech analysis' },
              },
              {
                id: 'exec-default-workdir-call',
                name: 'exec',
                args: { command: 'dir /b' },
              },
            ],
          };
        }
        return {
          content: 'Path display verified. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };
    const runner = new SubAgentRunner(mockLLMCaller);
    const liveObservations: SubAgentObservationEvent[] = [];
    runner.setObservationCallback((event) => liveObservations.push(event));
    runner.setToolExecutor(
      vi.fn().mockResolvedValue({
        success: true,
        content: 'ok',
      })
    );

    const spec: SubAgentSpec = {
      role: 'PathObserver',
      allowedTools: ['read', 'file_write', 'exec'],
      terminationCondition: 'Path display verified',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(
      spec,
      { files: [], cwd: 'D:\\sdk-python-main' },
      vi.fn(),
      []
    );
    const targets = output.observationEvents
      ?.map((event) => event.toolAction?.target)
      .filter((target): target is string => Boolean(target));

    expect(targets).toEqual([
      'src/services/planning/sub-agents/SubAgentRunner.ts',
      'docs/tech_analysis.md',
      'dir /b',
    ]);

    const execAction = output.observationEvents
      ?.map((event) => event.toolAction)
      .find((action) => action?.tool === 'exec');
    expect(execAction).toMatchObject({
      tool: 'exec',
      target: 'dir /b',
      workdir: 'D:\\sdk-python-main',
      success: true,
    });

    const liveExecAction = liveObservations
      .map((event) => event.toolAction)
      .find((action) => action?.tool === 'exec');
    expect(liveExecAction?.target).toBe('dir /b');
    expect(liveExecAction?.target).not.toContain('D:\\sdk-python-main');
    expect(liveExecAction?.fullTarget ?? '').not.toContain('D:\\sdk-python-main');
    expect(liveExecAction?.workdir).toBe('D:\\sdk-python-main');
  });

  it('uses local_search mode arguments as observation targets', async () => {
    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Searching local files.',
            output: {},
            rawToolCalls: [
              {
                id: 'grep-call',
                name: 'local_search',
                args: {
                  mode: 'grep',
                  query: 'function handleSubmit',
                  searchPath: 'src/components',
                },
              },
              {
                id: 'find-call',
                name: 'local_search',
                args: { mode: 'find', pattern: '*.module.css', searchPath: 'src' },
              },
              {
                id: 'outline-call',
                name: 'local_search',
                args: { mode: 'outline', path: 'src/App.tsx' },
              },
              {
                id: 'symbol-call',
                name: 'local_search',
                args: { mode: 'symbol', symbolName: 'Agent.run', path: 'src/Agent.ts' },
              },
            ],
          };
        }
        return {
          content: 'Search complete. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
        };
      }),
    };
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(
      vi.fn().mockResolvedValue({
        success: true,
        content: 'ok',
      })
    );

    const spec: SubAgentSpec = {
      role: 'CodeSearcher',
      allowedTools: ['local_search'],
      terminationCondition: 'Search complete',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    const output = await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);
    const targets = output.observationEvents
      ?.map((event) => event.toolAction?.target)
      .filter((target): target is string => Boolean(target));

    expect(targets).toEqual([
      'grep "function handleSubmit" @ src/components',
      'find "*.module.css" @ src',
      'outline src/App.tsx',
      'symbol Agent.run @ src/Agent.ts',
    ]);
  });

  it('falls back to estimated input tokens when API usage only reports output tokens', async () => {
    const contextId = 'test-partial-usage-context';
    useStatusStore.getState().resetTokenUsage(contextId);
    useStatusStore.getState().clearContextPressure(contextId);

    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi.fn().mockImplementation(async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Writing file.',
            output: {},
            rawToolCalls: [
              {
                id: 'write-call',
                name: 'file_write',
                args: {
                  path: 'src/App.tsx',
                  content: 'export function App() { return null; }',
                },
              },
            ],
            outputTokens: 17,
          };
        }
        return {
          content: 'Done. TASK_COMPLETE',
          output: { executionStatus: 'success' },
          rawToolCalls: [],
          outputTokens: 5,
        };
      }),
    };
    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setContextId(contextId);
    runner.setTokenContextId(contextId);
    runner.setToolExecutor(
      vi.fn().mockResolvedValue({
        success: true,
        content: 'ok',
      })
    );

    const spec: SubAgentSpec = {
      role: 'Writer',
      allowedTools: ['file_write'],
      terminationCondition: 'Done',
      loopConfig: {
        initialBudget: 2,
        checkpointInterval: 5,
        maxSteps: 5,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };

    await runner.runWithDynamicLoop(spec, { files: [], cwd: '/' }, vi.fn(), []);

    expect(mockLLMCaller.callWithContext).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(mockLLMCaller.callWithContext).mock.calls) {
      expect(call[8]).toEqual({
        contextId,
        contextWindowSize: expect.any(Number),
      });
    }

    const state = useStatusStore.getState();
    const tokenUsage = state.getAgentTokenUsage(contextId);

    expect(tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(tokenUsage.outputTokens).toBe(22);

    state.resetTokenUsage(contextId);
    state.clearContextPressure(contextId);
  });
});

describe('SubAgentRunner - Historical Tool Output Compression', () => {
  it('should compress old tool results and large file_write args before the next LLM call', async () => {
    const fileWriteMarker = 'UNCOMPRESSED_FILE_WRITE_MARKER';
    const readMarker = 'UNCOMPRESSED_READ_RESULT_MARKER';
    const largeFileContent = generateLargeText(fileWriteMarker, 550);
    const largeReadResult = `path: /src/large-result.ts\n${generateLargeText(readMarker, 900)}`;
    const capturedContexts: AccumulatedMessage[][] = [];

    let callCount = 0;
    const mockLLMCaller: LLMCaller = {
      callWithContext: vi
        .fn()
        .mockImplementation(
          async (
            _systemPrompt: string,
            _tools: string[],
            accumulatedContext: AccumulatedMessage[],
            _additionalInstructions?: string
          ): Promise<LLMResponse> => {
            capturedContexts.push(accumulatedContext);
            callCount++;

            if (callCount === 1) {
              return {
                content: 'Write a large file and read a large reference.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'file_write',
                    args: { path: '/src/generated.ts', content: largeFileContent },
                  },
                  {
                    name: 'read',
                    args: { path: '/src/large-result.ts' },
                  },
                ],
              };
            }

            if (callCount === 2) {
              return {
                content:
                  'I analyzed the large read output and captured the relevant conclusion for later steps.',
                output: {},
                rawToolCalls: [
                  {
                    name: 'read',
                    args: { path: '/src/recent.ts' },
                  },
                ],
              };
            }

            return {
              content: 'Compression path verified. TASK_COMPLETE',
              output: { executionStatus: 'success' },
              rawToolCalls: [],
            };
          }
        ),
    };

    const mockToolExecutor = vi
      .fn()
      .mockImplementation(
        async (toolCall: {
          name: string;
          args: Record<string, unknown>;
        }): Promise<{ success: boolean; content: string }> => {
          if (toolCall.name === 'file_write') {
            return { success: true, content: 'File written successfully' };
          }

          if (toolCall.args.path === '/src/large-result.ts') {
            return { success: true, content: largeReadResult };
          }

          return { success: true, content: 'RECENT_READ_RESULT_SHOULD_STAY_VISIBLE' };
        }
      );

    const runner = new SubAgentRunner(mockLLMCaller);
    runner.setToolExecutor(mockToolExecutor);

    const spec: SubAgentSpec = {
      role: 'CompressionTester',
      allowedTools: ['file_write', 'read'],
      terminationCondition: 'Compression path verified',
      loopConfig: {
        initialBudget: 3,
        checkpointInterval: 99,
        maxSteps: 3,
        terminationPatterns: ['TASK_COMPLETE'],
      },
    };
    const context: TaskContext = {
      files: [],
      cwd: '/',
      contextWindowSize: 10000,
    };

    const output = await runner.runWithDynamicLoop(spec, context, vi.fn(), []);

    expect(output.status).toBe('completed');
    expect(capturedContexts).toHaveLength(3);

    const thirdCallContext = capturedContexts[2];
    if (!thirdCallContext) {
      throw new Error('Expected the third LLM call context to be captured');
    }

    const serializedThirdCallContext = JSON.stringify(thirdCallContext);
    expect(serializedThirdCallContext).not.toContain(fileWriteMarker);
    expect(serializedThirdCallContext).not.toContain(readMarker);
    expect(serializedThirdCallContext).toContain('RECENT_READ_RESULT_SHOULD_STAY_VISIBLE');

    const compressedAssistant = thirdCallContext.find(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some((toolCall) => toolCall.name === 'file_write')
    );
    if (!compressedAssistant?.toolCalls) {
      throw new Error('Expected the old assistant tool call to remain in compressed context');
    }

    const fileWriteCall = compressedAssistant.toolCalls.find(
      (toolCall) => toolCall.name === 'file_write'
    );
    const compressedFileWriteContent = fileWriteCall?.args.content;
    expect(compressedFileWriteContent).toBeTypeOf('string');
    expect(compressedFileWriteContent).toContain('content compressed');

    const compressedReadResult = thirdCallContext.find(
      (message) =>
        message.role === 'tool' &&
        message.toolName === 'read' &&
        message.content.includes('see the assistant message above')
    );
    expect(compressedReadResult?.content).toContain('[read]');
    expect(compressedReadResult?.content).not.toContain(readMarker);
  });
});
