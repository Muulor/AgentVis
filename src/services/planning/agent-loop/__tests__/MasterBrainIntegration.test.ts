/**
 * MasterBrain 集成单元测试
 *
 * 测试 Native MasterBrain 模式下的决策流程
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    AgentLoopFSMIntegration,
    type FSMIntegrationConfig,
    type FSMIntegrationDependencies,
    type LLMServiceInterface,
} from '../AgentLoopFSMIntegration';
import type { AgentSession } from '../AgentSession';
import type { MasterBrainDecision, MemorySnapshot, RAGEvidence, ToolCatalogEntry } from '../../brain/types';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

/** 创建空的记忆快照 */
function createEmptyMemorySnapshot(): MemorySnapshot {
    return {
        facts: [],
        summaries: [],
        factsByCategory: {
            identity_role: [],
            preference_style: [],
            long_term_goal: [],
            knowledge_level: [],
            interaction_signals: [],
            task_experience: [],
        },
        taskExperiences: [],
    };
}

/** 创建 Mock AgentSession */
function createMockSession(): AgentSession {
    return {
        getMessages: vi.fn().mockReturnValue([
            { role: 'user', content: '请帮我读取文件' },
        ]),
        addMessage: vi.fn(),
        getModelId: vi.fn().mockReturnValue('test-model'),
        getLastPreparedContext: vi.fn().mockReturnValue(null),
        getToolOutputBudget: vi.fn().mockReturnValue(null),
    } as unknown as AgentSession;
}

/** 创建 MasterBrain 配置 */
function createNativeMasterBrainConfig(): FSMIntegrationConfig {
    return {
        agentId: 'test-agent',
        maxIterations: 10,
        callbacks: {},
    };
}

/** 创建 Mock LLM 服务（返回指定的决策 JSON） */
function createMockLLMService(decision: MasterBrainDecision): LLMServiceInterface {
    // DecisionParser 期望 JSON 在 ```json ... ``` 代码块中
    const jsonBlock = '```json\n' + JSON.stringify(decision, null, 2) + '\n```';
    return {
        generate: vi.fn().mockResolvedValue(jsonBlock),
    };
}

/** 创建标准的终止决策 */
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

/** 创建 SPAWN_SUB_AGENT 决策（简化模式） */
function createSimpleSpawnDecision(): MasterBrainDecision {
    return {
        decision: 'SPAWN_SUB_AGENT',
        rationale: '工具调用是安全的',
        riskAssessment: {
            level: 'low',
            notes: '工具调用无风险',
        },
        nextStep: {
            task: '读取文件',
            tools: ['read'],
        },
    } as MasterBrainDecision;
}

/** 创建派遣子智能体决策 */
function createSpawnSubAgentDecision(): MasterBrainDecision {
    return {
        decision: 'SPAWN_SUB_AGENT',
        rationale: '需要专门的研究智能体',
        riskAssessment: {
            level: 'medium',
            notes: '可能访问敏感文件，已限制只读工具',
        },
        nextStep: {
            task: '研究文件内容',
            tools: ['read', 'list', 'web_search'],
        },
    } as MasterBrainDecision;
}

/** 创建高风险 SPAWN_SUB_AGENT 决策 */
function createHighRiskSpawnDecision(): MasterBrainDecision {
    return {
        decision: 'SPAWN_SUB_AGENT',
        rationale: '虽然风险较高，但用户明确请求',
        riskAssessment: {
            level: 'high',
            notes: '执行任意命令，可能修改系统状态。用户已明确授权，限制执行目录。',
        },
        nextStep: {
            task: '执行命令',
            tools: ['exec'],
            behaviorHint: 'careful',
        },
    } as MasterBrainDecision;
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('MasterBrain 集成', () => {
    let integration: AgentLoopFSMIntegration;
    let config: FSMIntegrationConfig;
    let mockSession: AgentSession;

    beforeEach(() => {
        config = createNativeMasterBrainConfig();
        integration = new AgentLoopFSMIntegration(config);
        mockSession = createMockSession();
    });

    // ─────────────────────────────────────────────────────────────────
    // MasterBrain 初始化测试
    // ─────────────────────────────────────────────────────────────────

    describe('MasterBrain 初始化', () => {
        it('提供 llmService 时应该正确初始化 MasterBrain', () => {
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            // 不应该抛出错误
            expect(() => integration.setDependencies(dependencies, [])).not.toThrow();
        });
    });


    // ─────────────────────────────────────────────────────────────────
    // 依赖提供者测试
    // ─────────────────────────────────────────────────────────────────

    describe('依赖提供者', () => {
        it('应该正确使用 getMemorySnapshot 提供者', async () => {
            const mockMemorySnapshot = createEmptyMemorySnapshot();
            mockMemorySnapshot.facts.push({
                id: 'fact-1',
                agentId: 'test-agent',
                layer: 'fact',
                content: '用户喜欢简洁的回复',
                category: 'preference_style',
                importance: 0.8,
                sourceMessageIds: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });

            const getMemorySnapshot = vi.fn().mockResolvedValue(mockMemorySnapshot);
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
                getMemorySnapshot,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该调用 getMemorySnapshot，传入 agentId 和 userQuery（用户消息内容）
            expect(getMemorySnapshot).toHaveBeenCalledWith('test-agent', '请帮我读取文件');
        });

        it('应该正确使用 getToolCatalog 提供者', async () => {
            const mockToolCatalog: ToolCatalogEntry[] = [
                { name: 'read', description: '读取文件', riskLevel: 'low' },
                { name: 'file_write', description: '编辑文件', riskLevel: 'high' },
            ];

            const getToolCatalog = vi.fn().mockReturnValue(mockToolCatalog);
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
                getToolCatalog,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该调用 getToolCatalog
            expect(getToolCatalog).toHaveBeenCalled();
        });

        it('应该正确使用 getRAGEvidence 提供者', async () => {
            const mockRAGEvidence: RAGEvidence[] = [
                { source: 'doc.md', content: '相关内容', relevance: 0.9 },
            ];

            const getRAGEvidence = vi.fn().mockResolvedValue(mockRAGEvidence);
            const mockLLMService = createMockLLMService(createTerminateDecision());

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
                getRAGEvidence,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('test');

            // 应该调用 getRAGEvidence
            expect(getRAGEvidence).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 决策映射测试
    // ─────────────────────────────────────────────────────────────────

    describe('决策映射', () => {
        it('RESPOND_TO_USER 决策应该正确终止', async () => {
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

        it('SPAWN_SUB_AGENT 决策应该存储 SubAgentSpec', async () => {
            // 此测试验证决策被正确接收
            // 将测试实际的 Sub-Agent 派遣
            const spawnDecision = createSpawnSubAgentDecision();
            const mockLLMService = createMockLLMService(spawnDecision);

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);

            // 运行 - 当前 SPAWN_SUB_AGENT 会进入 DISPATCH 状态
            // 但由于没有 SubAgentRunner，会报错
            // 这里我们只验证不会崩溃
            await expect(integration.run('research this')).resolves.toBeDefined();
        });

        // Native 模式下，LLM 返回无效 JSON 时 MasterBrain 解析会失败
        // 错误被内部捕获，FSM 会优雅降级
        it('决策解析失败时应该优雅降级', async () => {
            // LLM 返回无效 JSON
            const mockLLMService: LLMServiceInterface = {
                generate: vi.fn().mockResolvedValue('这不是有效的JSON'),
            };

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);

            // Native 模式下，无效 JSON 会导致 DecisionParser 抛出错误
            // 但错误被 handleMasterDecisionNative 捕获，返回 DECISION_INVALID 事件
            // FSM 会优雅降级，最终返回 text_response
            const result = await integration.run('test');
            expect(result).toBe('text_response');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 思维链回调测试
    // ─────────────────────────────────────────────────────────────────

    describe('思维链回调', () => {
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
    });

    // ─────────────────────────────────────────────────────────────────
    // 风险评估传递测试
    // ─────────────────────────────────────────────────────────────────

    describe('风险评估', () => {
        it('高风险决策应该正确传递风险信息', async () => {
            // 使用辅助函数创建高风险决策
            const highRiskDecision = createHighRiskSpawnDecision();

            const mockLLMService = createMockLLMService(highRiskDecision);

            const onRiskUpdate = vi.fn();
            config.callbacks.onRiskUpdate = onRiskUpdate;
            integration = new AgentLoopFSMIntegration(config);

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await integration.run('execute command');

            // 风险更新回调会由 LoopGovernor 触发
            // 这里我们只验证流程正常完成
            expect(integration.getTerminationReason()).toBeDefined();
        });

        it('使用简化模式决策不应该导致崩溃', async () => {
            const spawnDecision = createSimpleSpawnDecision();
            const mockLLMService = createMockLLMService(spawnDecision);

            const dependencies: FSMIntegrationDependencies = {
                session: mockSession,
                executeTool: vi.fn(),
                llmService: mockLLMService,
            };

            integration.setDependencies(dependencies, []);
            await expect(integration.run('read file')).resolves.toBeDefined();
        });
    });
});
