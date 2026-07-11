/**
 * StateHandlers 单元测试
 *
 * 测试集中式状态处理器的核心逻辑
 * 采用 TDD 方式先编写测试，再实现功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FSMContext } from '../../../fsm/types';
import type { MasterBrainDecision } from '../../../brain/types';
import type {
  HandlerContext,
  HandlerConfig,
  HandlerDependencies,
  HandlerSharedState,
} from '../types';
import {
  createStateHandlerMap,
  handlePrepareContext,
  handleMasterDecision,
  handleDispatch,
  handleObserve,
  handleEvaluate,
} from '../StateHandlers';
import { translate } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Mock FSM 上下文
 */
function createMockFSMContext(overrides?: Partial<FSMContext>): FSMContext {
  return {
    ...overrides,
  } as FSMContext;
}

/**
 * 创建 Mock 处理器配置
 */
function createMockConfig(): HandlerConfig {
  return {
    agentId: 'test-agent-id',
    maxIterations: 20,
    modelId: 'gemini-3-flash',
    providerId: 'gemini',
  };
}

/**
 * 创建 Mock 共享状态
 */
function createMockSharedState(): HandlerSharedState {
  return {
    terminationReason: null,
    lastLLMContent: '',
    pendingSubAgentSpec: null,
    lastActionMadeProgress: true,
    lastActionSpawnedSubAgent: false,
    currentToolCalls: [],
    cancelled: false,
    spawnCount: 0,
    pendingExperiences: [],
    taskExperiences: [],
    saObservationsSummaries: [],
    mbDecisionLog: [],
  };
}

/**
 * 创建 Mock MasterBrain 决策
 */
function createMockDecision(
  decision: string,
  overrides?: Partial<MasterBrainDecision>
): MasterBrainDecision {
  return {
    decision: decision as MasterBrainDecision['decision'],
    rationale: '测试决策理由',
    riskAssessment: {
      level: 'low',
      notes: '无风险',
    },
    ...overrides,
  } as MasterBrainDecision;
}

/**
 * 创建 Mock 处理器依赖
 */
function createMockDependencies(): HandlerDependencies {
  const mockMasterBrain = {
    decide: vi.fn().mockResolvedValue(createMockDecision('RESPOND_TO_USER')),
  };

  const mockDecisionMapper = {
    map: vi.fn().mockReturnValue({
      event: { type: 'DECISION_RECEIVED' },
      terminationReason: 'text_response',
      lastLLMContent: '测试响应',
    }),
  };

  const mockMasterBrainInputBuilder = {
    build: vi.fn().mockResolvedValue({
      conversationHistory: [],
      memory: {
        taskExperiences: [],
      },
      memorySnapshot: {},
      ragEvidence: [],
      toolCatalog: [],
      userIntent: {},
    }),
  };

  const mockSubAgentDispatcher = {
    dispatch: vi.fn().mockResolvedValue({
      event: { type: 'ACTION_COMPLETED', result: {} },
      madeProgress: true,
      spawnedSubAgent: true,
    }),
    setPairedHistoryMessages: vi.fn(),
    setExternalGuideSkills: vi.fn(),
    setExternalScriptSkills: vi.fn(),
    setAllInstalledSkillNames: vi.fn(),
    setTaskExperiences: vi.fn(),
  };

  const mockLoopGovernor = {
    evaluate: vi.fn().mockReturnValue({ action: 'CONTINUE' }),
    getSnapshot: vi.fn().mockReturnValue({
      budgetRemaining: 15,
      riskScore: 0.1,
      consecutiveNoProgress: 0,
    }),
  };

  const mockTracer = {
    isSessionActive: vi.fn().mockReturnValue(true),
    record: vi.fn(),
  };

  const mockSession = {
    id: 'test-session-id',
    getMessages: vi.fn().mockReturnValue([]),
    addMessage: vi.fn(),
  };

  const mockCallbacks = {
    onThinkingPhase: vi.fn(),
    onThought: vi.fn(),
    onMetricsUpdate: vi.fn(),
    onBudgetUpdate: vi.fn(),
    onProgress: vi.fn(),
  };

  const mockFSMEngine = {
    currentState: 'IDLE',
    getContext: vi.fn().mockReturnValue({}),
    getTrace: vi.fn().mockReturnValue([]),
  };

  return {
    masterBrain: mockMasterBrain,
    decisionMapper: mockDecisionMapper,
    masterBrainInputBuilder: mockMasterBrainInputBuilder,
    subAgentDispatcher: mockSubAgentDispatcher,
    loopGovernor: mockLoopGovernor,
    tracer: mockTracer,
    session: mockSession,
    callbacks: mockCallbacks,
    fsmEngine: mockFSMEngine,
    // 供 handleDispatch 注入全量已安装 Guide 技能名称列表
    getInstalledSkillCatalog: vi.fn().mockReturnValue([]),
    getInstalledScriptSkillCatalog: vi.fn().mockReturnValue([]),
  } as unknown as HandlerDependencies;
}

/**
 * 创建完整的 Mock HandlerContext
 */
function createMockHandlerContext(overrides?: {
  config?: Partial<HandlerConfig>;
  sharedState?: Partial<HandlerSharedState>;
  dependencies?: Partial<HandlerDependencies>;
}): HandlerContext {
  const baseDeps = createMockDependencies();
  return {
    config: { ...createMockConfig(), ...overrides?.config },
    sharedState: { ...createMockSharedState(), ...overrides?.sharedState },
    dependencies: { ...baseDeps, ...overrides?.dependencies } as HandlerDependencies,
  };
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('StateHandlers', () => {
  let fsmContext: FSMContext;
  let handlerContext: HandlerContext;

  beforeEach(() => {
    fsmContext = createMockFSMContext();
    handlerContext = createMockHandlerContext();
  });

  // ─────────────────────────────────────────────────────────────────
  // createStateHandlerMap 测试
  // ─────────────────────────────────────────────────────────────────

  describe('createStateHandlerMap', () => {
    it('应该返回包含所有 5 个状态处理器的映射', () => {
      const handlers = createStateHandlerMap();

      expect(handlers.PREPARE_CONTEXT).toBeDefined();
      expect(handlers.MASTER_DECISION).toBeDefined();
      expect(handlers.DISPATCH).toBeDefined();
      expect(handlers.OBSERVE).toBeDefined();
      expect(handlers.EVALUATE).toBeDefined();
    });

    it('不应该包含 IDLE 和 TERMINATE 状态的处理器', () => {
      const handlers = createStateHandlerMap();

      expect(handlers.IDLE).toBeUndefined();
      expect(handlers.TERMINATE).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // handlePrepareContext 测试
  // ─────────────────────────────────────────────────────────────────

  describe('handlePrepareContext', () => {
    it('应该返回 CONTEXT_READY 事件', async () => {
      const result = await handlePrepareContext(fsmContext, handlerContext);

      expect(result.type).toBe('CONTEXT_READY');
    });

    it('返回的 payload 应该包含空的上下文数据', async () => {
      const result = await handlePrepareContext(fsmContext, handlerContext);

      expect((result as unknown as Record<string, unknown>).payload).toBeDefined();
      const payload = (result as unknown as Record<string, unknown>).payload as Record<
        string,
        unknown
      >;
      expect(payload.memorySnapshot).toEqual({});
      expect(payload.ragEvidence).toEqual([]);
      expect(payload.toolCatalog).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // handleMasterDecision 测试
  // ─────────────────────────────────────────────────────────────────

  describe('handleMasterDecision', () => {
    it('没有 MasterBrain 时应该返回 DECISION_INVALID', async () => {
      handlerContext.dependencies.masterBrain = null;

      const result = await handleMasterDecision(fsmContext, handlerContext);

      expect(result.type).toBe('DECISION_INVALID');
      expect((result as unknown as Record<string, unknown>).reason).toContain('not initialized');
    });

    it('应该调用 MasterBrain.decide()', async () => {
      await handleMasterDecision(fsmContext, handlerContext);

      expect(handlerContext.dependencies.masterBrain!.decide).toHaveBeenCalled();
    });

    it('should pass sandboxMode into MasterBrainInputBuilder', async () => {
      handlerContext = createMockHandlerContext({
        config: { sandboxMode: 'ControlledNetwork' },
      });

      await handleMasterDecision(fsmContext, handlerContext);

      expect(handlerContext.dependencies.masterBrainInputBuilder.build).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        'ControlledNetwork'
      );
    });

    it('应该调用 DecisionMapper.map()', async () => {
      await handleMasterDecision(fsmContext, handlerContext);

      expect(handlerContext.dependencies.decisionMapper.map).toHaveBeenCalled();
    });

    it('should pass the pre-resolved output language hint to DecisionMapper', async () => {
      const outputLanguageHint = {
        tag: 'fr',
        label: 'French',
        source: 'explicit_target' as const,
        guidance: 'Use French.',
      };
      const inputBuilder = handlerContext.dependencies.masterBrainInputBuilder;
      (inputBuilder.build as ReturnType<typeof vi.fn>).mockResolvedValue({
        conversationHistory: [],
        memory: { taskExperiences: [] },
        ragEvidence: [],
        toolCatalog: [],
        userIntent: { explicit: 'Please answer in French.' },
        outputLanguageHint,
      });

      await handleMasterDecision(fsmContext, handlerContext);

      expect(handlerContext.dependencies.decisionMapper.map).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        outputLanguageHint
      );
    });

    it('应该触发 3 阶段思维 UI 回调', async () => {
      await handleMasterDecision(fsmContext, handlerContext);

      const onThinkingPhase = handlerContext.dependencies.callbacks.onThinkingPhase;
      // 每个阶段: START, CONTENT, COMPLETE = 3 次
      // 3 个阶段: ANALYZING, PLANNING, DECIDED = 9 次
      expect(onThinkingPhase).toHaveBeenCalled();
    });

    it('应该同步 DecisionMapper 返回的副作用到 sharedState', async () => {
      const mockMapper = handlerContext.dependencies.decisionMapper;
      (mockMapper.map as ReturnType<typeof vi.fn>).mockReturnValue({
        event: { type: 'DECISION_RECEIVED' },
        terminationReason: 'text_response',
        lastLLMContent: '同步测试内容',
        madeProgress: true,
      });

      await handleMasterDecision(fsmContext, handlerContext);

      expect(handlerContext.sharedState.terminationReason).toBe('text_response');
      expect(handlerContext.sharedState.lastLLMContent).toBe('同步测试内容');
    });

    it('MasterBrain 决策失败时应该返回 DECISION_INVALID', async () => {
      const mockBrain = handlerContext.dependencies.masterBrain;
      (mockBrain!.decide as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM 调用失败'));

      const result = await handleMasterDecision(fsmContext, handlerContext);

      expect(result.type).toBe('DECISION_INVALID');
      expect((result as unknown as Record<string, unknown>).reason).toContain('LLM 调用失败');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // handleDispatch 测试
  // ─────────────────────────────────────────────────────────────────

  describe('handleDispatch', () => {
    it('有 pendingSubAgentSpec 时应该调用 SubAgentDispatcher', async () => {
      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'executor',
        allowedTools: ['read_file'],
        terminationCondition: 'maxTurns: 5',
      };

      await handleDispatch(fsmContext, handlerContext);

      expect(handlerContext.dependencies.subAgentDispatcher.dispatch).toHaveBeenCalled();
    });

    it('should pass enabled guide and script skill names to the Sub-Agent catalog', async () => {
      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'executor',
        allowedTools: ['read_file'],
        terminationCondition: 'done',
      };
      handlerContext.dependencies.getInstalledSkillCatalog = vi.fn().mockReturnValue([
        { name: 'guide-skill', description: 'Guide skill' },
        { name: 'shared-name', description: 'Guide duplicate' },
      ]);
      handlerContext.dependencies.getInstalledScriptSkillCatalog = vi.fn().mockReturnValue([
        { name: 'script-skill', description: 'Script skill' },
        { name: 'shared-name', description: 'Script duplicate' },
      ]);

      await handleDispatch(fsmContext, handlerContext);

      expect(
        handlerContext.dependencies.subAgentDispatcher.setAllInstalledSkillNames
      ).toHaveBeenCalledWith(['guide-skill', 'shared-name', 'script-skill']);
    });

    it('SubAgent 派遣后应该清空 pendingSubAgentSpec', async () => {
      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'executor',
        allowedTools: ['read_file'],
        terminationCondition: 'maxTurns: 5',
      };

      await handleDispatch(fsmContext, handlerContext);

      expect(handlerContext.sharedState.pendingSubAgentSpec).toBeNull();
    });

    it('should not pass paired image history when includeHistory is false', async () => {
      const pairedHistory = [
        {
          role: 'user' as const,
          content: 'old image task',
          images: [{ mimeType: 'image/webp', data: 'base64-old' }],
        },
      ];
      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'executor',
        allowedTools: ['generate_image'],
        terminationCondition: 'done',
        includeHistory: false,
      };
      handlerContext.sharedState.pendingPairedHistoryMessages = pairedHistory;

      await handleDispatch(fsmContext, handlerContext);

      expect(
        handlerContext.dependencies.subAgentDispatcher.setPairedHistoryMessages
      ).toHaveBeenCalledWith(undefined);
    });

    it('should pass paired image history when includeHistory is true', async () => {
      const pairedHistory = [
        {
          role: 'user' as const,
          content: 'old image task',
          images: [{ mimeType: 'image/webp', data: 'base64-old' }],
        },
      ];
      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'executor',
        allowedTools: ['generate_image'],
        terminationCondition: 'done',
        includeHistory: true,
      };
      handlerContext.sharedState.pendingPairedHistoryMessages = pairedHistory;

      await handleDispatch(fsmContext, handlerContext);

      expect(
        handlerContext.dependencies.subAgentDispatcher.setPairedHistoryMessages
      ).toHaveBeenCalledWith(pairedHistory);
    });

    it('RESPOND_TO_USER 决策应该设置 terminationReason 为 text_response', async () => {
      fsmContext.currentDecision = {
        decision: 'RESPOND_TO_USER',
        details: { response: '用户响应' },
      };

      await handleDispatch(fsmContext, handlerContext);

      expect(handlerContext.sharedState.terminationReason).toBe('text_response');
    });

    it('REQUEST_MORE_INPUT 决策应该设置 terminationReason 为 awaiting_interaction', async () => {
      fsmContext.currentDecision = {
        decision: 'REQUEST_MORE_INPUT',
        details: { questionsForUser: '请确认操作' },
      };

      await handleDispatch(fsmContext, handlerContext);

      expect(handlerContext.sharedState.terminationReason).toBe('awaiting_interaction');
    });

    it('没有任务时应该返回 ACTION_COMPLETED', async () => {
      const result = await handleDispatch(fsmContext, handlerContext);

      expect(result.type).toBe('ACTION_COMPLETED');
      expect((result as unknown as Record<string, unknown>).result).toBeDefined();
      expect(
        ((result as unknown as Record<string, unknown>).result as Record<string, unknown>).noAction
      ).toBe(true);
    });

    it('SA API error 中断且有 observationEvents 时，lastSAObservations 应使用步骤摘要', async () => {
      // 模拟 SA 已执行 2 步后因 API error 中断的 dispatchResult
      handlerContext.dependencies.subAgentDispatcher.dispatch = vi.fn().mockResolvedValue({
        event: { type: 'ACTION_FAILED', error: 'API error: 429' },
        madeProgress: true, // 已有部分进展
        spawnedSubAgent: true,
        output: {
          status: 'failed',
          outputValid: false,
          executionStatus: 'failure',
          error: 'API error: 429',
          observations: '⚠️ API 错误: 服务不可用',
          toolCalls: ['web_search', 'read'],
          observationEvents: [
            {
              thinking: '需要搜索相关资料',
              toolAction: { tool: 'web_search', target: 'AI 架构', success: true },
              step: 1,
              timestamp: Date.now(),
            },
            {
              thinking: '读取文件内容',
              toolAction: { tool: 'read', target: '/tmp/file.txt', success: true },
              step: 2,
              timestamp: Date.now(),
            },
          ],
        },
      });

      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'researcher',
        allowedTools: ['web_search', 'read'],
        terminationCondition: '完成调研',
      };

      await handleDispatch(fsmContext, handlerContext);

      // lastSAObservations 应包含步骤摘要，而非错误文本
      expect(handlerContext.sharedState.lastSAObservations).toBeDefined();
      expect(handlerContext.sharedState.lastSAObservations).toContain(
        translate('chat.subAgentInterruptedByApiErrorHeader', { count: 2 })
      );
      expect(handlerContext.sharedState.lastSAObservations).toContain(
        translate('chat.subAgentStepLabel', { step: 1 })
      );
      expect(handlerContext.sharedState.lastSAObservations).toContain('web_search');
      // 不应包含原始错误文本
      expect(handlerContext.sharedState.lastSAObservations).not.toBe('⚠️ API 错误: 服务不可用');
    });

    it('SA API error 中断但无 observationEvents（首步即失败）时，lastSAObservations 应降级使用 observations', async () => {
      // 模拟 SA 首步 LLM 调用就失败（无任何工具执行记录）
      handlerContext.dependencies.subAgentDispatcher.dispatch = vi.fn().mockResolvedValue({
        event: { type: 'ACTION_FAILED', error: 'API error: 500' },
        madeProgress: false,
        spawnedSubAgent: true,
        output: {
          status: 'failed',
          outputValid: false,
          executionStatus: 'failure',
          error: 'API error: 500',
          observations: '⚠️ 子智能体在首步 LLM 调用时遭遇 API 错误',
          toolCalls: [],
          // observationEvents 为空（无步骤记录）
          observationEvents: [],
        },
      });

      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'researcher',
        allowedTools: ['web_search'],
        terminationCondition: '完成调研',
      };

      await handleDispatch(fsmContext, handlerContext);

      // 无 observationEvents，应降级使用原始 observations
      expect(handlerContext.sharedState.lastSAObservations).toBe(
        '⚠️ 子智能体在首步 LLM 调用时遭遇 API 错误'
      );
    });

    it('SA 被用户手动终止（cancelled）且有 observationEvents 时，lastSAObservations 应使用步骤摘要（标题为"被中止"）', async () => {
      // 模拟用户手动点击终止按钮：SA 执行了 2 步后被 cancelled
      // cancelled 时 status = 'completed'（非 failed），observations = LLM 最后的标题文字
      handlerContext.dependencies.subAgentDispatcher.dispatch = vi.fn().mockResolvedValue({
        event: { type: 'ACTION_COMPLETED', result: { terminated: true } },
        madeProgress: true,
        spawnedSubAgent: true,
        output: {
          status: 'completed', // cancelled 走 completed 路径
          outputValid: true,
          executionStatus: 'success', // 无 error 字段
          observations: '**步骤2：获取竞争对手数据（优衣库 UNIQLO）**', // LLM 最后一句话（行动描述，非报告）
          toolCalls: ['exec', 'web_search'],
          observationEvents: [
            {
              thinking: '获取 Muji 基本面数据',
              toolAction: {
                tool: 'exec',
                target: 'yf.py fundamentals 7453.T',
                workdir: 'D:\\finance-research',
                success: true,
              },
              step: 1,
            },
            {
              thinking: '获取竞争对手数据',
              toolAction: {
                tool: 'web_search',
                target: 'IKEA financial performance 2024',
                success: true,
              },
              step: 2,
            },
          ],
        },
      });

      handlerContext.sharedState.pendingSubAgentSpec = {
        role: 'researcher',
        allowedTools: ['exec', 'web_search'],
        terminationCondition: '完成调研',
      };

      await handleDispatch(fsmContext, handlerContext);

      // cancelled 场景：有 observationEvents，应使用步骤摘要
      expect(handlerContext.sharedState.lastSAObservations).toBeDefined();
      expect(handlerContext.sharedState.lastSAObservations).toContain(
        translate('chat.subAgentAbortedHeader', { count: 2 })
      );
      expect(handlerContext.sharedState.lastSAObservations).toContain(
        translate('chat.subAgentStepLabel', { step: 1 })
      );
      expect(handlerContext.sharedState.lastSAObservations).toContain('exec');
      expect(handlerContext.sharedState.lastSAObservations).toContain(
        translate('chat.subAgentToolWorkdirSuffix', { workdir: 'D:\\finance-research' })
      );
      // 不应包含原始的单行标题文字
      expect(handlerContext.sharedState.lastSAObservations).not.toBe(
        '**步骤2：获取竞争对手数据（优衣库 UNIQLO）**'
      );
      // 标题应为"被中止"而非"API 错误中断"
      expect(handlerContext.sharedState.lastSAObservations).not.toContain('API 错误中断');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // handleObserve 测试
  // ─────────────────────────────────────────────────────────────────

  describe('handleObserve', () => {
    it('terminationReason 为 text_response 时应该返回 TIMEOUT', async () => {
      handlerContext.sharedState.terminationReason = 'text_response';

      const result = await handleObserve(fsmContext, handlerContext);

      expect(result.type).toBe('TIMEOUT');
    });

    it('terminationReason 为 awaiting_interaction 时应该返回 TIMEOUT', async () => {
      handlerContext.sharedState.terminationReason = 'awaiting_interaction';

      const result = await handleObserve(fsmContext, handlerContext);

      expect(result.type).toBe('TIMEOUT');
    });

    it('没有终止原因时应该返回 CONTINUE', async () => {
      const result = await handleObserve(fsmContext, handlerContext);

      expect(result.type).toBe('CONTINUE');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // handleEvaluate 测试
  // ─────────────────────────────────────────────────────────────────

  describe('handleEvaluate', () => {
    it('terminationReason 已设置时应该返回 TIMEOUT', async () => {
      handlerContext.sharedState.terminationReason = 'text_response';

      const result = await handleEvaluate(fsmContext, handlerContext);

      expect(result.type).toBe('TIMEOUT');
    });

    it('应该调用 LoopGovernor.evaluate()', async () => {
      await handleEvaluate(fsmContext, handlerContext);

      expect(handlerContext.dependencies.loopGovernor.evaluate).toHaveBeenCalled();
    });

    it('LoopGovernor 返回 CONTINUE 时应该返回 CONTINUE 事件', async () => {
      const mockGovernor = handlerContext.dependencies.loopGovernor;
      (mockGovernor.evaluate as ReturnType<typeof vi.fn>).mockReturnValue({
        action: 'CONTINUE',
      });

      const result = await handleEvaluate(fsmContext, handlerContext);

      expect(result.type).toBe('CONTINUE');
    });

    it('LoopGovernor 返回 TERMINATE 时应该返回 TIMEOUT 事件', async () => {
      const mockGovernor = handlerContext.dependencies.loopGovernor;
      (mockGovernor.evaluate as ReturnType<typeof vi.fn>).mockReturnValue({
        action: 'TERMINATE',
        reason: 'budget_exhausted',
      });

      const result = await handleEvaluate(fsmContext, handlerContext);

      expect(result.type).toBe('TIMEOUT');
    });

    it('LoopGovernor 返回 TERMINATE 时应该设置正确的 terminationReason', async () => {
      const mockGovernor = handlerContext.dependencies.loopGovernor;
      (mockGovernor.evaluate as ReturnType<typeof vi.fn>).mockReturnValue({
        action: 'TERMINATE',
        reason: 'budget_exhausted',
      });

      await handleEvaluate(fsmContext, handlerContext);

      expect(handlerContext.sharedState.terminationReason).toBe('budget_exhausted');
    });

    it('评估后应该重置进度标志', async () => {
      handlerContext.sharedState.lastActionMadeProgress = true;
      handlerContext.sharedState.lastActionSpawnedSubAgent = true;

      await handleEvaluate(fsmContext, handlerContext);

      expect(handlerContext.sharedState.lastActionMadeProgress).toBe(false);
      expect(handlerContext.sharedState.lastActionSpawnedSubAgent).toBe(false);
    });

    it('应该触发 onBudgetUpdate 回调', async () => {
      await handleEvaluate(fsmContext, handlerContext);

      expect(handlerContext.dependencies.callbacks.onBudgetUpdate).toHaveBeenCalled();
    });
  });
});
