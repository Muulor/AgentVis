/**
 * SubAgentRunner 动态 Loop 测试（新架构）
 *
 * 专注测试新架构的动态决策 Checkpoint 功能
 */

import { describe, it, expect, vi } from 'vitest';
import { SubAgentRunner, type LLMCaller, type LLMResponse } from '../SubAgentRunner';
import type { SubAgentSpec, CheckpointDecision } from '../../brain/types';
import type { TaskContext, SubAgentLoopConfig } from '../types';
import { DEFAULT_LOOP_CONFIG } from '../types';
import { translate } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// Mock 数据
// ═══════════════════════════════════════════════════════════════

const createMockSpec = (overrides: Partial<SubAgentSpec> = {}): SubAgentSpec => ({
  role: '测试智能体',
  allowedTools: ['read', 'web_search'],
  terminationCondition: '收集到足够信息',
  ...overrides,
});

const createMockContext = (): TaskContext => ({
  cwd: '/test',
  files: [],
});

const createMockLoopConfig = (overrides: Partial<SubAgentLoopConfig> = {}): SubAgentLoopConfig => ({
  ...DEFAULT_LOOP_CONFIG,
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════
// 新架构 Checkpoint 功能测试
// ═══════════════════════════════════════════════════════════════

describe('SubAgentRunner 新架构 Checkpoint', () => {
  /**
   * 创建支持 callWithContext 的 Mock LLMCaller
   */
  const createExtendedMockCaller = (responses: LLMResponse[]) => {
    let callIndex = 0;
    return {
      async callWithContext(
        _systemPrompt: string,
        _tools: string[],
        _context: any[],
        additionalInstructions?: string
      ): Promise<LLMResponse> {
        if (responses.length === 0) {
          throw new Error('Mock responses array is empty');
        }
        const response = responses[Math.min(callIndex, responses.length - 1)]!;
        // 记录是否传递了额外指令（用于验证）
        if (additionalInstructions) {
          (response as any)._receivedInstructions = additionalInstructions;
        }
        callIndex++;
        return response;
      },
    };
  };

  it('[新架构] Master Brain ADJUST_STRATEGY 决策注入动态指令', async () => {
    const responses: LLMResponse[] = [
      { content: 'Step 1', rawToolCalls: [{ name: 'read', args: {} }] },
      { content: 'Step 2', rawToolCalls: [{ name: 'read', args: {} }] },
      { content: 'Step 3 TASK_COMPLETE', rawToolCalls: [] },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, content: 'Tool executed' });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({ initialBudget: 3, checkpointInterval: 1 }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'ADJUST_STRATEGY',
      refinedInstructions: '请专注于 API 文档',
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('[新架构] 初始 user 消息使用当前界面语言', async () => {
    let firstContext: unknown[] | undefined;
    const mockCaller: LLMCaller = {
      async callWithContext(_systemPrompt, _tools, accumulatedContext): Promise<LLMResponse> {
        firstContext ??= accumulatedContext;
        return { content: 'TASK_COMPLETE', rawToolCalls: [] };
      },
    };
    const runner = new SubAgentRunner(mockCaller);
    runner.setToolExecutor(vi.fn());

    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({ initialBudget: 1 }),
    });
    const checkpointFn = vi.fn();

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(result.status).toBe('completed');
    expect(firstContext?.[0]).toMatchObject({
      role: 'user',
      content: translate('planning.subAgent.initialUserMessage'),
    });
  });

  it('[新架构] OpenRouter reasoningDetails 保留到工具续轮上下文', async () => {
    const reasoningDetails = [
      {
        type: 'reasoning.text',
        text: 'Inspect the file first.',
        signature: 'signed-value',
        index: 0,
      },
    ];
    const contexts: unknown[][] = [];
    let callIndex = 0;
    const mockCaller: LLMCaller = {
      async callWithContext(_systemPrompt, _tools, accumulatedContext): Promise<LLMResponse> {
        contexts.push(accumulatedContext);
        callIndex++;
        return callIndex === 1
          ? {
              content: '',
              rawToolCalls: [{ id: 'call-1', name: 'read', args: { path: 'README.md' } }],
              reasoningContent: 'Inspect the file first.',
              reasoningDetails,
            }
          : { content: 'TASK_COMPLETE', rawToolCalls: [] };
      },
    };
    const runner = new SubAgentRunner(mockCaller);
    runner.setToolExecutor(vi.fn().mockResolvedValue({ success: true, content: 'README' }));
    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({ initialBudget: 2 }),
    });

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), vi.fn(), []);

    expect(result.status).toBe('completed');
    expect(contexts[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoningContent: 'Inspect the file first.',
          reasoningDetails,
        }),
      ])
    );
  });

  it('[新架构] Master Brain EXTEND_BUDGET 决策延长工具调用上限', async () => {
    const responses: LLMResponse[] = [
      { content: 'Step 1', rawToolCalls: [{ name: 'read', args: {} }] },
      { content: 'Step 2', rawToolCalls: [{ name: 'read', args: {} }] },
      { content: 'Step 3 TASK_COMPLETE', rawToolCalls: [] },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, content: 'Tool executed' });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({ initialBudget: 3, checkpointInterval: 1 }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'EXTEND_BUDGET',
      additionalIterations: 2,
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('[新架构] 剩余 5 步且仍在推进时触发预算兜底 Checkpoint', async () => {
    const responses: LLMResponse[] = [
      ...Array.from({ length: 46 }, (_, index) => ({
        content: `Step ${index + 1}`,
        rawToolCalls: [{ name: 'read', args: { path: `/file-${index + 1}.ts` } }],
      })),
      { content: 'Step 47 TASK_COMPLETE', rawToolCalls: [] },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, content: 'Tool executed' });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({
        initialBudget: 3,
        checkpointInterval: 999,
        maxSteps: 50,
      }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'EXTEND_BUDGET',
      additionalIterations: 20,
      reason: 'Still making progress',
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalledTimes(1);
    expect(checkpointFn.mock.calls[0]?.[0].checkpointTrigger).toBe('budget_near_exhaustion');
    expect(checkpointFn.mock.calls[0]?.[0].remainingBudget).toBe(5);
    expect(checkpointFn.mock.calls[0]?.[0].requestedAdditionalBudget).toBe(20);
    expect(result.status).toBe('completed');
  });

  it('[新架构] 单次 SA 派遣最多只追加两次预算', async () => {
    const responses: LLMResponse[] = [
      { content: 'Keep working', rawToolCalls: [{ name: 'read', args: { path: '/loop.ts' } }] },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({ success: true, content: 'Tool executed' });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      loopConfig: createMockLoopConfig({
        initialBudget: 3,
        checkpointInterval: 999,
        maxSteps: 10,
      }),
    });

    const checkpointFn = vi.fn().mockResolvedValue({
      type: 'EXTEND_BUDGET',
      additionalIterations: 2,
      reason: 'Still making progress',
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalledTimes(2);
    expect(mockExecutor).toHaveBeenCalledTimes(14);
    expect(result.status).toBe('completed');
  });

  it('[新架构] 高风险操作前触发 Checkpoint 可被 Master Brain 拒绝', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({ success: true, content: 'OK' });

    const responses: LLMResponse[] = [
      { content: 'Attempting high-risk operation', rawToolCalls: [{ name: 'read', args: {} }] },
      { content: 'Preparing write', rawToolCalls: [{ name: 'file_write', args: {} }] },
    ];

    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      allowedTools: ['read'], // file_write 不在白名单中，会触发高风险 checkpoint
      loopConfig: createMockLoopConfig({ initialBudget: 5, checkpointInterval: 10 }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'TERMINATE_SUB_AGENT',
      reason: 'High-risk operation rejected',
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalled();
    // read 工具正常执行（非高风险），file_write 被 Checkpoint 拦截
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('[新架构] 高风险操作获批准后可继续执行', async () => {
    const mockExecutor = vi
      .fn()
      .mockResolvedValue({ success: true, content: 'File written successfully' });

    const responses: LLMResponse[] = [
      { content: 'Attempting file write', rawToolCalls: [{ name: 'read', args: {} }] },
      {
        content: 'Writing file',
        rawToolCalls: [{ name: 'file_write', args: { path: 'test.txt' } }],
      },
      { content: 'Operation complete TASK_COMPLETE', rawToolCalls: [] },
    ];

    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      allowedTools: ['read'], // file_write 不在白名单中，会触发高风险 checkpoint
      loopConfig: createMockLoopConfig({ initialBudget: 5, checkpointInterval: 10 }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'EXTEND_BUDGET',
      additionalIterations: 2,
      reason: 'Approved high-risk operation',
    } as CheckpointDecision);

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(checkpointFn).toHaveBeenCalled();
    expect(mockExecutor).toHaveBeenCalled(); // 高风险操作被批准并执行
    expect(result.status).toBe('completed');
  });

  it('[新架构] 同一步多个并发工具失败只累计 1 次连续失败', async () => {
    const responses: LLMResponse[] = [
      {
        content: 'Resolving docs in parallel',
        rawToolCalls: [
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
        ],
      },
      { content: 'Task complete TASK_COMPLETE', rawToolCalls: [] },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({
      success: false,
      content: '[External Script Skill: context7-docs]\nExit code: 2',
    });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      allowedTools: ['external_skill_execute'],
      loopConfig: createMockLoopConfig({
        initialBudget: 3,
        checkpointInterval: 999,
        maxSteps: 5,
      }),
    });

    const checkpointFn = vi.fn();

    const result = await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(mockExecutor).toHaveBeenCalledTimes(3);
    expect(checkpointFn).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('[新架构] 连续 3 个工具调用步失败才触发连续失败 Checkpoint', async () => {
    const responses: LLMResponse[] = [
      {
        content: 'Attempt 1',
        rawToolCalls: [
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
        ],
      },
      {
        content: 'Attempt 2',
        rawToolCalls: [
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
        ],
      },
      {
        content: 'Attempt 3',
        rawToolCalls: [
          {
            name: 'external_skill_execute',
            args: { skillName: 'context7-docs', args: { action: 'resolve-docs' } },
          },
        ],
      },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({
      success: false,
      content: '[External Script Skill: context7-docs]\nExit code: 2',
    });
    const mockCaller = createExtendedMockCaller(responses);
    const runner = new SubAgentRunner(mockCaller as LLMCaller);
    runner.setToolExecutor(mockExecutor);

    const spec = createMockSpec({
      allowedTools: ['external_skill_execute'],
      loopConfig: createMockLoopConfig({
        initialBudget: 3,
        checkpointInterval: 999,
        maxSteps: 5,
      }),
    });

    const checkpointFn = vi.fn().mockResolvedValueOnce({
      type: 'TERMINATE_SUB_AGENT',
      reason: 'Repeated failed steps',
    } as CheckpointDecision);

    await runner.runWithDynamicLoop(spec, createMockContext(), checkpointFn, []);

    expect(mockExecutor).toHaveBeenCalledTimes(3);
    expect(checkpointFn).toHaveBeenCalledTimes(1);
    expect(checkpointFn.mock.calls[0]?.[0].checkpointTrigger).toBe('consecutive_failures');
    expect(checkpointFn.mock.calls[0]?.[0].completedIterations).toBe(3);
  });
});
