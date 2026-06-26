/**
 * Brain 系统类型测试
 *
 * 验证类型守卫、工厂函数的正确性
 */

import { describe, it, expect } from 'vitest';
import {
    isValidDecisionType,
    isSpawnSubAgentDecision,
    createEmptyMemorySnapshot,
    createDefaultRiskAssessment,
    type SpawnSubAgentDecision,
    type RespondToUserDecision,
} from '../types';

// ═══════════════════════════════════════════════════════════════
// 类型守卫测试
// ═══════════════════════════════════════════════════════════════

describe('类型守卫', () => {
    describe('isValidDecisionType', () => {
        it('应该接受有效的决策类型', () => {
            expect(isValidDecisionType('SPAWN_SUB_AGENT')).toBe(true);
            expect(isValidDecisionType('REQUEST_MORE_INPUT')).toBe(true);
            expect(isValidDecisionType('RESPOND_TO_USER')).toBe(true);
        });

        it('应该拒绝无效的决策类型', () => {
            expect(isValidDecisionType('INVALID')).toBe(false);
            expect(isValidDecisionType('')).toBe(false);
            expect(isValidDecisionType(null)).toBe(false);
            expect(isValidDecisionType(undefined)).toBe(false);
            expect(isValidDecisionType(123)).toBe(false);
        });
    });


    describe('isSpawnSubAgentDecision', () => {
        it('应该正确识别 SpawnSubAgentDecision', () => {
            const decision: SpawnSubAgentDecision = {
                decision: 'SPAWN_SUB_AGENT',
                rationale: 'Need research',
                riskAssessment: { level: 'low', notes: '' },
            };
            expect(isSpawnSubAgentDecision(decision)).toBe(true);
        });

        it('应该拒绝其他决策类型', () => {
            const decision: RespondToUserDecision = {
                decision: 'RESPOND_TO_USER',
                response: 'Hello',
                rationale: 'Greeting',
                riskAssessment: { level: 'low', notes: '' },
            };
            expect(isSpawnSubAgentDecision(decision)).toBe(false);
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 工厂函数测试
// ═══════════════════════════════════════════════════════════════

describe('工厂函数', () => {
    describe('createEmptyMemorySnapshot', () => {
        it('应该创建空的记忆快照', () => {
            const snapshot = createEmptyMemorySnapshot();

            expect(snapshot.facts).toEqual([]);
            expect(snapshot.summaries).toEqual([]);
            expect(snapshot.factsByCategory).toHaveProperty('identity_role');
            expect(snapshot.factsByCategory).toHaveProperty('preference_style');
            expect(snapshot.factsByCategory).toHaveProperty('long_term_goal');
            expect(snapshot.factsByCategory).toHaveProperty('knowledge_level');
            expect(snapshot.factsByCategory).toHaveProperty('interaction_signals');
        });

        it('所有类别应该初始化为空数组', () => {
            const snapshot = createEmptyMemorySnapshot();

            for (const category of Object.values(snapshot.factsByCategory)) {
                expect(category).toEqual([]);
            }
        });
    });

    describe('createDefaultRiskAssessment', () => {
        it('应该创建默认风险评估（低风险）', () => {
            const assessment = createDefaultRiskAssessment();

            expect(assessment.level).toBe('low');
            expect(assessment.notes).toBe('');
        });
    });

});
