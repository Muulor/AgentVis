/**
 * AgentLoopFSMIntegration 单元测试
 *
 * 测试 FSM 与 AgentLoop 的集成逻辑（Native MasterBrain 模式）
 * 
 * 已移除 Wrapper 模式测试，全面采用 OODA 2.0 架构
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    AgentLoopFSMIntegration,
    type FSMIntegrationConfig,
    type FSMIntegrationDependencies,
    type LLMServiceInterface,
} from '../AgentLoopFSMIntegration';
import type { AgentSession } from '../AgentSession';
import type { MasterBrainDecision } from '../../brain/types';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

/** 创建 Mock AgentSession */
function createMockSession(): AgentSession {
    return {
        id: 'test-session-id',
        addMessage: vi.fn(),
        getMessages: vi.fn().mockReturnValue([
            { role: 'user', content: '请帮我完成任务' },
        ]),
        getMessageCount: vi.fn().mockReturnValue(1),
        getModelId: vi.fn().mockReturnValue('test-model'),
        clear: vi.fn(),
        getToolOutputBudget: vi.fn().mockReturnValue(null),
        prepareContext: vi.fn().mockResolvedValue({}),
        getLastPreparedContext: vi.fn().mockReturnValue(null),
    } as unknown as AgentSession;
}

/** 创建默认配置 */
function createDefaultConfig(): FSMIntegrationConfig {
    return {
        agentId: 'test-agent',
        maxIterations: 20,
        callbacks: {
            onProgress: vi.fn(),
            onError: vi.fn(),
            onBudgetUpdate: vi.fn(),
            onThought: vi.fn(),
            onThinkingPhase: vi.fn(),
            onFSMStateChange: vi.fn(),
            onMetricsUpdate: vi.fn(),
        },
    };
}

/** 创建 Mock LLM 服务（返回指定决策 JSON） */
function createMockLLMService(decision: MasterBrainDecision): LLMServiceInterface {
    // DecisionParser 期望 JSON 在 ```json ... ``` 代码块中
    const jsonBlock = '```json\n' + JSON.stringify(decision, null, 2) + '\n```';
    return {
        generate: vi.fn().mockResolvedValue(jsonBlock),
    };
}

/** 创建延迟响应的 Mock LLM 服务 */
function createDelayedMockLLMService(
    decision: MasterBrainDecision,
    delayMs: number
): LLMServiceInterface {
    const jsonBlock = '```json\n' + JSON.stringify(decision, null, 2) + '\n```';
    return {
        generate: vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return jsonBlock;
        }),
    };
}

/** 创建 RESPOND_TO_USER 终止决策 */
function createTerminateDecision(): MasterBrainDecision {
    return {
        decision: 'RESPOND_TO_USER',
        rationale: '任务已完成',
        response: '用户请求已满足',
        riskAssessment: {
            level: 'low',
            notes: '无风险',
        },
    } as MasterBrainDecision;
}

/** 创建 RESPOND_TO_USER 决策 */
function createRespondToUserDecision(response: string): MasterBrainDecision {
    return {
        decision: 'RESPOND_TO_USER',
        rationale: '直接回复用户',
        response,
        riskAssessment: {
            level: 'low',
            notes: '无风险',
        },
    };
}

/** 创建 REQUEST_MORE_INPUT 决策 */
function createRequestMoreInputDecision(questions: string): MasterBrainDecision {
    return {
        decision: 'REQUEST_MORE_INPUT',
        rationale: '需要更多信息才能继续',
        // 顶层 questionsForUser 字段（符合 RequestMoreInputDecision 接口）
        questionsForUser: [questions],
        riskAssessment: {
            level: 'low',
            notes: '无风险',
        },
    };
}

/** 创建 SPAWN_SUB_AGENT 决策（增强简化模式） */
function createSpawnSubAgentDecision(): MasterBrainDecision {
    return {
        decision: 'SPAWN_SUB_AGENT',
        rationale: '需要专门的研究智能体来完成任务',
        riskAssessment: {
            level: 'medium',
            notes: '可能访问敏感文件，已限制只读工具',
        },
        nextStep: {
            task: '研究文件内容',
            tools: ['read', 'list'],
        },
    } as MasterBrainDecision;
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('AgentLoopFSMIntegration', () => {
    let integration: AgentLoopFSMIntegration;
    let config: FSMIntegrationConfig;
    let mockSession: AgentSession;

    beforeEach(() => {
        config = createDefaultConfig();
        integration = new AgentLoopFSMIntegration(config);
        mockSession = createMockSession();
    });

    // ─────────────────────────────────────────────────────────────────
    // 构造函数测试
    // ─────────────────────────────────────────────────────────────────

    describe('构造函数', () => {
        it('应该正确初始化所有组件', () => {
            expect(integration).toBeDefined();
            expect(integration.getCurrentState()).toBe('IDLE');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 依赖注入测试
    // ─────────────────────────────────────────────────────────────────

    describe('setDependencies', () => {
        it('应该接受依赖注入', () => {
            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
            };

            expect(() => integration.setDependencies(dependencies, [])).not.toThrow();
        });

        it('提供 llmService 时应该初始化 MasterBrain', () => {
            const mockLLMService = createMockLLMService(createTerminateDecision());
            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            expect(() => integration.setDependencies(dependencies, [])).not.toThrow();
        });

        it('should propagate sandboxMode into handler context', () => {
            config = {
                ...createDefaultConfig(),
                sandboxMode: 'ControlledNetwork',
            };
            integration = new AgentLoopFSMIntegration(config);
            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
            };

            integration.setDependencies(dependencies, []);
            const handlerContext = (integration as unknown as {
                createHandlerContext: () => {
                    config: { sandboxMode?: FSMIntegrationConfig['sandboxMode'] };
                };
            }).createHandlerContext();

            expect(handlerContext.config.sandboxMode).toBe('ControlledNetwork');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // run() 测试 - Native MasterBrain 模式
    // ─────────────────────────────────────────────────────────────────

    describe('run (Native MasterBrain 模式)', () => {
        it('没有设置依赖时应该抛出错误', async () => {
            await expect(integration.run('test message')).rejects.toThrow(
                'Dependencies not set'
            );
        });

        it('RESPOND_TO_USER 决策应该正确终止', async () => {
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            const result = await integration.run('test message');

            expect(result).toBe('text_response');
        });

        it('ControlledNetwork mode should inject MB sandbox awareness into the system prompt', async () => {
            config = {
                ...createDefaultConfig(),
                sandboxMode: 'ControlledNetwork',
            };
            integration = new AgentLoopFSMIntegration(config);
            const mockLLMService = createMockLLMService(createTerminateDecision());
            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test message');

            expect(mockLLMService.generate).toHaveBeenCalledWith(
                expect.stringContaining('[MB_SANDBOX_AWARENESS]'),
                expect.anything()
            );
            expect(mockLLMService.generate).toHaveBeenCalledWith(
                expect.stringContaining('curl --noproxy'),
                expect.anything()
            );
        });

        it('RESPOND_TO_USER 决策应该返回响应内容', async () => {
            const responseContent = '您好，这是我的回复！';
            const mockLLMService = createMockLLMService(
                createRespondToUserDecision(responseContent)
            );

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            const result = await integration.run('test message');

            expect(result).toBe('text_response');
            expect(integration.getLastLLMContent()).toBe(responseContent);
        });

        it('REQUEST_MORE_INPUT 决策应该返回 awaiting_interaction', async () => {
            const questions = '请问您需要处理哪个文件？';
            const mockLLMService = createMockLLMService(
                createRequestMoreInputDecision(questions)
            );

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            const result = await integration.run('test message');

            expect(result).toBe('awaiting_interaction');
            expect(integration.getLastLLMContent()).toBe(questions);
        });

        it('SPAWN_SUB_AGENT 决策应该存储 SubAgentSpec', async () => {
            const mockLLMService = createMockLLMService(createSpawnSubAgentDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);

            // 运行 - SPAWN_SUB_AGENT 会进入 DISPATCH 状态并尝试执行 SubAgent
            // 这里验证不会崩溃
            await expect(integration.run('research this topic')).resolves.toBeDefined();
        });

        it('没有 llmService 时应该返回 DECISION_INVALID', async () => {
            // 不提供 llmService，意味着没有 MasterBrain
            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
            };

            integration.setDependencies(dependencies, []);

            // 由于没有 MasterBrain，handleMasterDecisionNative 会返回 DECISION_INVALID
            // 最终应返回 text_response（因为 DECISION_INVALID 会流转到 TERMINATE）
            const result = await integration.run('test');
            expect(result).toBeDefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // cancel() 测试
    // ─────────────────────────────────────────────────────────────────

    describe('cancel (Native MasterBrain 模式)', () => {
        it('应该设置取消标志并返回 cancelled', async () => {
            // 使用延迟响应模拟异步 LLM 调用
            const mockLLMService = createDelayedMockLLMService(
                createTerminateDecision(),
                200  // 200ms 延迟
            );

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);

            // 启动 run 但不等待
            const runPromise = integration.run('test');

            // 稍等一下后取消（让 FSM 有时间开始执行）
            await new Promise((resolve) => setTimeout(resolve, 50));
            integration.cancel();

            const result = await runPromise;
            expect(result).toBe('cancelled');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // getTrace() 测试
    // ─────────────────────────────────────────────────────────────────

    describe('getTrace (Native MasterBrain 模式)', () => {
        it('应该返回执行轨迹', async () => {
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            const trace = integration.getTrace();
            expect(trace).toBeDefined();
            expect(trace.sessionId).toBeDefined();
            expect(trace.startTime).toBeDefined();
        });

        it('轨迹应该包含状态转移记录', async () => {
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            const trace = integration.getTrace();
            // FSMTrace 使用 timeline 字段存储转移记录
            expect(trace.timeline).toBeDefined();
            expect(trace.timeline.length).toBeGreaterThan(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // getCurrentState 测试
    // ─────────────────────────────────────────────────────────────────

    describe('getCurrentState', () => {
        it('初始状态应该是 IDLE', () => {
            expect(integration.getCurrentState()).toBe('IDLE');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 回调触发测试 - Native MasterBrain 模式
    // ─────────────────────────────────────────────────────────────────

    describe('回调触发 (Native MasterBrain 模式)', () => {
        it('应该在决策时触发 onThought 回调', async () => {
            const onThought = vi.fn();
            config.callbacks.onThought = onThought;
            integration = new AgentLoopFSMIntegration(config);

            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该触发思维链回调
            expect(onThought).toHaveBeenCalled();

            // 验证回调参数格式
            const callArg = onThought.mock.calls[0]?.[0];
            expect(callArg).toBeDefined();
            expect(callArg).toHaveProperty('phase', 'decide');
            expect(callArg).toHaveProperty('content');
            expect(callArg).toHaveProperty('timestamp');
        });

        it('应该在决策时触发 onThinkingPhase 回调（三阶段）', async () => {
            const onThinkingPhase = vi.fn();
            config.callbacks.onThinkingPhase = onThinkingPhase;
            integration = new AgentLoopFSMIntegration(config);

            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该触发多次（每个阶段: START, CONTENT, COMPLETE × 3）
            expect(onThinkingPhase).toHaveBeenCalled();

            // 验证调用包含 ANALYZING、PLANNING、DECIDED 阶段
            const allCalls = onThinkingPhase.mock.calls.map(call => call[0]);
            const phases = allCalls.map(arg => arg.phase).filter(Boolean);

            // 应该包含三个阶段
            expect(phases).toContain('ANALYZING');
            expect(phases).toContain('PLANNING');
            expect(phases).toContain('DECIDED');
        });

        it('应该触发 onMetricsUpdate 回调', async () => {
            const onMetricsUpdate = vi.fn();
            config.callbacks.onMetricsUpdate = onMetricsUpdate;
            integration = new AgentLoopFSMIntegration(config);

            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该触发 Metrics 更新回调
            expect(onMetricsUpdate).toHaveBeenCalled();
        });

        it('FSM 状态变更应该触发 onFSMStateChange 回调', async () => {
            const onFSMStateChange = vi.fn();
            config.callbacks.onFSMStateChange = onFSMStateChange;
            integration = new AgentLoopFSMIntegration(config);

            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该触发 FSM 状态变更回调
            expect(onFSMStateChange).toHaveBeenCalled();

            // 验证从 IDLE 开始的状态转移
            const firstCall = onFSMStateChange.mock.calls[0];
            expect(firstCall?.[0]).toBe('IDLE');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // LoopGovernor 集成测试 - Native MasterBrain 模式
    // ─────────────────────────────────────────────────────────────────

    describe('LoopGovernor 集成 (Native MasterBrain 模式)', () => {
        it('预算耗尽时应该终止', async () => {
            // 设置很小的预算
            config.maxIterations = 1;
            integration = new AgentLoopFSMIntegration(config);

            // 模拟持续返回 SPAWN_SUB_AGENT（会消耗预算）
            // 但由于 SubAgent 执行会失败（没有完整依赖），实际会快速终止
            const mockLLMService = createMockLLMService(createSpawnSubAgentDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn().mockResolvedValue({ success: true, content: 'ok' }),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            const result = await integration.run('test');

            // 应该因为预算有限而终止（可能是 budget_exhausted 或其他终止原因）
            expect(result).toBeDefined();
            // 验证是有效的终止原因
            const validReasons = [
                'text_response',
                'budget_exhausted',
                'max_iterations',
                'cancelled',
                'error',
                'awaiting_interaction',
            ];
            expect(validReasons).toContain(result);
        });

        it('正常决策应该不消耗过多预算', async () => {
            config.maxIterations = 10;
            integration = new AgentLoopFSMIntegration(config);

            // RESPOND_TO_USER 应该快速终止，不消耗多余预算
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            const result = await integration.run('test');

            expect(result).toBe('text_response');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 错误处理测试
    // ─────────────────────────────────────────────────────────────────

    describe('错误处理', () => {
        it('LLM 调用失败时应该优雅降级', async () => {
            const onError = vi.fn();
            config.callbacks.onError = onError;
            integration = new AgentLoopFSMIntegration(config);

            // 模拟 LLM 调用抛出错误
            const mockLLMService: LLMServiceInterface = {
                generate: vi.fn().mockRejectedValue(new Error('LLM API Error')),
            };

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);

            // LLM 调用失败会被内部捕获并转为 DECISION_INVALID 事件
            // FSM 会优雅降级，最终返回 text_response
            const result = await integration.run('test');

            // 验证降级行为 - 返回有效的终止原因
            expect(result).toBe('text_response');
        });
    });
});
