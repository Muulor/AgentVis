/**
 * LoopGovernor 单元测试
 *
 * 测试循环治理器的核心功能：
 * - 预算管理
 * - 进度追踪
 * - 工具震荡检测
 * - 过度授权检测
 * - 风险评估
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    LoopGovernor,
    type GovernorConfig,
    DEFAULT_GOVERNOR_CONFIG,
} from '../LoopGovernor';

describe('LoopGovernor', () => {
    let governor: LoopGovernor;

    beforeEach(() => {
        governor = new LoopGovernor();
    });

    // ═══════════════════════════════════════════════════════════════
    // 初始化测试
    // ═══════════════════════════════════════════════════════════════

    describe('初始化', () => {
        it('应使用默认配置初始化', () => {
            const snapshot = governor.getSnapshot();

            expect(snapshot.budgetRemaining).toBe(DEFAULT_GOVERNOR_CONFIG.initialBudget);
            expect(snapshot.riskScore).toBe(0);
            expect(snapshot.consecutiveNoProgress).toBe(0);
            expect(snapshot.subAgentCount).toBe(0);
        });

        it('应使用自定义配置初始化', () => {
            const customConfig: GovernorConfig = {
                initialBudget: 10,
                riskThreshold: 0.5,
                maxSubAgents: 3,
                toolThrashingThreshold: 2,
            };
            const customGovernor = new LoopGovernor(customConfig);
            const snapshot = customGovernor.getSnapshot();

            expect(snapshot.budgetRemaining).toBe(10);
        });

        it('应在调用 reset 后重置所有状态', () => {
            // 先进行一些操作
            governor.evaluate({ madeProgress: false, riskDelta: 0.1 });
            governor.evaluate({ madeProgress: false, riskDelta: 0.1 });

            // 重置
            governor.reset();
            const snapshot = governor.getSnapshot();

            expect(snapshot.budgetRemaining).toBe(DEFAULT_GOVERNOR_CONFIG.initialBudget);
            expect(snapshot.riskScore).toBe(0);
            expect(snapshot.consecutiveNoProgress).toBe(0);
        });

        it('应在调用 reset 时接受新配置', () => {
            governor.reset({ initialBudget: 5, riskThreshold: 0.3, maxSubAgents: 2, toolThrashingThreshold: 2 });
            const snapshot = governor.getSnapshot();

            expect(snapshot.budgetRemaining).toBe(5);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 预算管理测试
    // ═══════════════════════════════════════════════════════════════

    describe('预算管理', () => {
        it('每次 evaluate 应递减预算', () => {
            const initialBudget = governor.getSnapshot().budgetRemaining;

            governor.evaluate({ madeProgress: true, riskDelta: 0 });

            expect(governor.getSnapshot().budgetRemaining).toBe(initialBudget - 1);
        });

        it('预算耗尽时应返回 TERMINATE', () => {
            // 将预算设置为 1
            governor.reset({ initialBudget: 1, riskThreshold: 1, maxSubAgents: 10, toolThrashingThreshold: 10 });

            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0 });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('budget_exhausted');
        });

        it('预算大于 0 时应返回 CONTINUE', () => {
            governor.reset({ initialBudget: 10, riskThreshold: 1, maxSubAgents: 10, toolThrashingThreshold: 10 });

            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0 });

            expect(decision.action).toBe('CONTINUE');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 进度追踪测试
    // ═══════════════════════════════════════════════════════════════

    describe('进度追踪', () => {
        it('无进展时应增加 consecutiveNoProgress', () => {
            governor.evaluate({ madeProgress: false, riskDelta: 0 });

            expect(governor.getSnapshot().consecutiveNoProgress).toBe(1);
        });

        it('有进展时应重置 consecutiveNoProgress', () => {
            governor.evaluate({ madeProgress: false, riskDelta: 0 });
            governor.evaluate({ madeProgress: false, riskDelta: 0 });
            governor.evaluate({ madeProgress: true, riskDelta: 0 });

            expect(governor.getSnapshot().consecutiveNoProgress).toBe(0);
        });

        it('连续 2 次无进展应返回 TERMINATE', () => {
            governor.evaluate({ madeProgress: false, riskDelta: 0 });
            const decision = governor.evaluate({ madeProgress: false, riskDelta: 0 });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('consecutive_no_progress');
        });

        it('连续 1 次无进展后有进展不应终止', () => {
            governor.evaluate({ madeProgress: false, riskDelta: 0 });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0 });

            expect(decision.action).toBe('CONTINUE');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 工具震荡检测测试
    // ═══════════════════════════════════════════════════════════════

    describe('工具震荡检测', () => {
        it('连续调用相同工具应触发震荡检测', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('tool_thrashing_detected');
        });

        it('调用不同工具不应触发震荡检测', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'file_write' });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'exec' });

            expect(decision.action).toBe('CONTINUE');
        });

        it('相同工具调用被其他工具打断后不应触发震荡', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'file_write' });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });

            expect(decision.action).toBe('CONTINUE');
        });

        it('自定义阈值应正确生效', () => {
            // 设置阈值为 2
            governor.reset({
                initialBudget: 20,
                riskThreshold: 1,
                maxSubAgents: 10,
                toolThrashingThreshold: 2,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('tool_thrashing_detected');
        });

        it('无工具调用时不应影响震荡检测', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0 }); // 无工具调用
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, toolCalled: 'read' });

            expect(decision.action).toBe('CONTINUE');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 过度授权检测测试
    // ═══════════════════════════════════════════════════════════════

    describe('过度授权检测', () => {
        it('创建子 Agent 应增加计数', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });

            expect(governor.getSnapshot().subAgentCount).toBe(1);
        });

        it('超过 maxSubAgents 应返回 TERMINATE', () => {
            governor.reset({
                initialBudget: 20,
                riskThreshold: 1,
                maxSubAgents: 2,
                toolThrashingThreshold: 10,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });
            governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('over_delegation');
        });

        it('未超过 maxSubAgents 不应终止', () => {
            governor.reset({
                initialBudget: 20,
                riskThreshold: 1,
                maxSubAgents: 5,
                toolThrashingThreshold: 10,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });
            governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0, subAgentSpawned: true });

            expect(decision.action).toBe('CONTINUE');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 风险评估测试
    // ═══════════════════════════════════════════════════════════════

    describe('风险评估', () => {
        it('应累积风险分数', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0.2 });
            governor.evaluate({ madeProgress: true, riskDelta: 0.3 });

            expect(governor.getSnapshot().riskScore).toBeCloseTo(0.5);
        });

        it('风险超过阈值应返回 TERMINATE', () => {
            governor.reset({
                initialBudget: 20,
                riskThreshold: 0.5,
                maxSubAgents: 10,
                toolThrashingThreshold: 10,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0.3 });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0.3 });

            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('risk_exceeded');
        });

        it('风险未超过阈值不应终止', () => {
            governor.reset({
                initialBudget: 20,
                riskThreshold: 0.8,
                maxSubAgents: 10,
                toolThrashingThreshold: 10,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0.2 });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0.2 });

            expect(decision.action).toBe('CONTINUE');
        });

        it('负 riskDelta 应降低风险分数', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0.5 });
            governor.evaluate({ madeProgress: true, riskDelta: -0.2 });

            expect(governor.getSnapshot().riskScore).toBeCloseTo(0.3);
        });

        it('风险分数不应低于 0', () => {
            governor.evaluate({ madeProgress: true, riskDelta: -0.5 });

            expect(governor.getSnapshot().riskScore).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 状态快照测试
    // ═══════════════════════════════════════════════════════════════

    describe('状态快照', () => {
        it('应返回完整的状态快照', () => {
            governor.evaluate({ madeProgress: true, riskDelta: 0.1, toolCalled: 'read', subAgentSpawned: true });

            const snapshot = governor.getSnapshot();

            expect(snapshot).toHaveProperty('budgetRemaining');
            expect(snapshot).toHaveProperty('riskScore');
            expect(snapshot).toHaveProperty('consecutiveNoProgress');
            expect(snapshot).toHaveProperty('subAgentCount');
            expect(snapshot).toHaveProperty('toolCallHistory');
        });

        it('快照应反映当前状态', () => {
            governor.evaluate({ madeProgress: false, riskDelta: 0.2, toolCalled: 'file_write' });

            const snapshot = governor.getSnapshot();

            expect(snapshot.consecutiveNoProgress).toBe(1);
            expect(snapshot.riskScore).toBeCloseTo(0.2);
            expect(snapshot.toolCallHistory).toContain('file_write');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 优先级测试（多种终止条件同时满足）
    // ═══════════════════════════════════════════════════════════════

    describe('终止条件优先级', () => {
        it('连续无进展应先于预算耗尽检测', () => {
            governor.reset({
                initialBudget: 2,
                riskThreshold: 1,
                maxSubAgents: 10,
                toolThrashingThreshold: 10,
            });

            governor.evaluate({ madeProgress: false, riskDelta: 0 });
            const decision = governor.evaluate({ madeProgress: false, riskDelta: 0 });

            // 预算也会在第二次耗尽，但连续无进展应优先
            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('consecutive_no_progress');
        });

        it('工具震荡应在风险检测之前', () => {
            governor.reset({
                initialBudget: 20,
                riskThreshold: 0.5,
                maxSubAgents: 10,
                toolThrashingThreshold: 3,
            });

            governor.evaluate({ madeProgress: true, riskDelta: 0.2, toolCalled: 'read' });
            governor.evaluate({ madeProgress: true, riskDelta: 0.2, toolCalled: 'read' });
            const decision = governor.evaluate({ madeProgress: true, riskDelta: 0.2, toolCalled: 'read' });

            // 风险也超过阈值了(0.6 > 0.5)，但工具震荡应优先
            expect(decision.action).toBe('TERMINATE');
            expect(decision.action === 'TERMINATE' && decision.reason).toBe('tool_thrashing_detected');
        });
    });
});
