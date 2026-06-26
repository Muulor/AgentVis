/**
 * DecisionLogger 单元测试
 *
 * 测试决策日志的核心功能：
 * - 决策记录
 * - 执行结果更新
 * - 按会话查询
 * - 统计信息
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionLogger } from '../DecisionLogger';

describe('DecisionLogger', () => {
    let logger: DecisionLogger;

    beforeEach(() => {
        logger = new DecisionLogger();
    });

    // ═══════════════════════════════════════════════════════════════
    // 决策记录测试
    // ═══════════════════════════════════════════════════════════════

    describe('决策记录', () => {
        it('log 应生成唯一 ID', () => {
            const id1 = logger.log({
                sessionId: 'session-1',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'Test rationale',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'Test summary',
            });

            const id2 = logger.log({
                sessionId: 'session-1',
                decisionType: 'RESPOND_TO_USER',
                rationale: 'Another rationale',
                riskAssessment: { level: 'medium', notes: 'some risk' },
                inputSummary: 'Another summary',
            });

            expect(id1).toBeTruthy();
            expect(id2).toBeTruthy();
            expect(id1).not.toBe(id2);
        });

        it('log 应自动添加时间戳', () => {
            const before = new Date();

            const id = logger.log({
                sessionId: 'session-1',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'Need research',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'Spawning sub-agent',
            });

            const after = new Date();
            const entry = logger.getEntry(id);

            expect(entry?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(entry?.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
        });

        it('log 应保留所有字段', () => {
            const id = logger.log({
                sessionId: 'session-test',
                decisionType: 'REQUEST_MORE_INPUT',
                rationale: 'Too risky',
                riskAssessment: { level: 'high', notes: 'May break system' },
                inputSummary: 'User wants to delete database',
            });

            const entry = logger.getEntry(id);

            expect(entry?.sessionId).toBe('session-test');
            expect(entry?.decisionType).toBe('REQUEST_MORE_INPUT');
            expect(entry?.rationale).toBe('Too risky');
            expect(entry?.riskAssessment.level).toBe('high');
            expect(entry?.inputSummary).toBe('User wants to delete database');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 执行结果更新测试
    // ═══════════════════════════════════════════════════════════════

    describe('执行结果更新', () => {
        it('updateExecutionResult 应正确关联结果', () => {
            const id = logger.log({
                sessionId: 'session-1',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'Approved',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'Action input',
            });

            logger.updateExecutionResult(id, {
                success: true,
                output: { result: 'done' },
                duration: 150,
            });

            const entry = logger.getEntry(id);

            expect(entry?.executionResult?.success).toBe(true);
            expect(entry?.executionResult?.output).toEqual({ result: 'done' });
            expect(entry?.executionResult?.duration).toBe(150);
        });

        it('updateExecutionResult 对不存在的 ID 应返回 false', () => {
            const result = logger.updateExecutionResult('non-existent-id', {
                success: false,
                error: 'Failed',
            });

            expect(result).toBe(false);
        });

        it('updateExecutionResult 应记录错误信息', () => {
            const id = logger.log({
                sessionId: 'session-1',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'Approved',
                riskAssessment: { level: 'medium', notes: '' },
                inputSummary: 'Risky action',
            });

            logger.updateExecutionResult(id, {
                success: false,
                error: 'Network timeout',
                duration: 5000,
            });

            const entry = logger.getEntry(id);

            expect(entry?.executionResult?.success).toBe(false);
            expect(entry?.executionResult?.error).toBe('Network timeout');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 查询测试
    // ═══════════════════════════════════════════════════════════════

    describe('按会话查询', () => {
        beforeEach(() => {
            // 添加多个会话的记录
            logger.log({
                sessionId: 'session-A',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'A1',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'A1',
            });
            logger.log({
                sessionId: 'session-A',
                decisionType: 'RESPOND_TO_USER',
                rationale: 'A2',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'A2',
            });
            logger.log({
                sessionId: 'session-B',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'B1',
                riskAssessment: { level: 'medium', notes: '' },
                inputSummary: 'B1',
            });
        });

        it('getSessionLog 应过滤正确的会话', () => {
            const logsA = logger.getSessionLog('session-A');
            const logsB = logger.getSessionLog('session-B');

            expect(logsA).toHaveLength(2);
            expect(logsB).toHaveLength(1);
        });

        it('getSessionLog 对不存在的会话应返回空数组', () => {
            const logs = logger.getSessionLog('non-existent');

            expect(logs).toHaveLength(0);
        });

        it('getAllLogs 应返回所有记录', () => {
            const allLogs = logger.getAllLogs();

            expect(allLogs).toHaveLength(3);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 统计测试
    // ═══════════════════════════════════════════════════════════════

    describe('统计信息', () => {
        beforeEach(() => {
            // Session A: 2 APPROVE, 1 TERMINATE (1 success, 1 fail)
            const id1 = logger.log({
                sessionId: 'session-A',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'ok',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'test',
            });
            logger.updateExecutionResult(id1, { success: true });

            const id2 = logger.log({
                sessionId: 'session-A',
                decisionType: 'SPAWN_SUB_AGENT',
                rationale: 'ok',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'test',
            });
            logger.updateExecutionResult(id2, { success: false, error: 'failed' });

            logger.log({
                sessionId: 'session-A',
                decisionType: 'RESPOND_TO_USER',
                rationale: 'done',
                riskAssessment: { level: 'low', notes: '' },
                inputSummary: 'end',
            });
        });

        it('getStatistics 应返回决策类型分布', () => {
            const stats = logger.getStatistics('session-A');

            expect(stats.decisionTypeCount['SPAWN_SUB_AGENT']).toBe(2);
            expect(stats.decisionTypeCount['RESPOND_TO_USER']).toBe(1);
        });

        it('getStatistics 应计算成功率', () => {
            const stats = logger.getStatistics('session-A');

            // 2 个有执行结果的记录，1 成功 1 失败
            expect(stats.successRate).toBe(0.5);
        });

        it('getStatistics 应返回总数', () => {
            const stats = logger.getStatistics('session-A');

            expect(stats.totalDecisions).toBe(3);
        });

        it('getStatistics 对空会话应返回零值', () => {
            const stats = logger.getStatistics('empty-session');

            expect(stats.totalDecisions).toBe(0);
            expect(stats.successRate).toBe(0);
        });
    });
});
