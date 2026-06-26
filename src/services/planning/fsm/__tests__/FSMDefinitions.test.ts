/**
 * FSM 定义解析测试
 */

import { describe, it, expect } from 'vitest';
import {
  parseFSMDefinition,
  createAgentServiceFSMDefinition,
  createSubAgentFSMDefinition,
} from '../FSMDefinitions';

// ═══════════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════════

const sampleYamlDefinition = `
version: "1.0"
name: TestFSM
initialState: IDLE
states:
  IDLE:
    on:
      START:
        guard: loopBudgetRemaining
        actions:
          - initLoopBudget
          - recordProgress
        next: RUNNING
  RUNNING:
    on:
      COMPLETE:
        next: DONE
      FAIL:
        next: ERROR
  DONE:
    on:
      RESET:
        next: IDLE
  ERROR:
    on:
      RESET:
        actions:
          - resetProgress
        next: IDLE
`;

// ═══════════════════════════════════════════════════════════════
// FSM 定义解析测试
// ═══════════════════════════════════════════════════════════════

describe('FSM 定义解析', () => {
  describe('parseFSMDefinition', () => {
    it('应该正确解析 YAML 定义', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);

      expect(definition).toBeDefined();
      expect(definition.initialState).toBe('IDLE');
      expect(Object.keys(definition.states)).toHaveLength(4);
    });

    it('应该正确解析状态配置', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);

      expect(definition.states['IDLE']).toBeDefined();
      expect(definition.states['RUNNING']).toBeDefined();
      expect(definition.states['DONE']).toBeDefined();
      expect(definition.states['ERROR']).toBeDefined();
    });

    it('应该正确解析转移定义', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);

      const idleState = definition.states['IDLE'];
      expect(idleState!.on).toBeDefined();
      expect(idleState!.on['START']).toBeDefined();
    });

    it('应该正确解析 Guard 函数', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);

      const startTransition = definition.states['IDLE']!.on['START'];
      expect(startTransition).toBeDefined();

      // Guard 应该被正确解析（如果注册表中存在）
      if (!Array.isArray(startTransition)) {
        expect(startTransition!.guard).toBeDefined();
      }
    });

    it('应该正确解析 Action 列表', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);

      const startTransition = definition.states['IDLE']!.on['START'];
      if (!Array.isArray(startTransition)) {
        expect(startTransition!.actions).toBeDefined();
        expect(startTransition!.actions?.length).toBe(2);
      }
    });

    it('应该能创建初始上下文', () => {
      const definition = parseFSMDefinition(sampleYamlDefinition);
      const context = definition.createInitialContext();

      expect(context.loopBudget).toBeDefined();
      expect(context.riskScore).toBeDefined();
      expect(context.decisionLog).toEqual([]);
    });
  });

  describe('createAgentServiceFSMDefinition', () => {
    it('应该创建 Agent Service FSM 定义', () => {
      const definition = createAgentServiceFSMDefinition();

      expect(definition).toBeDefined();
      expect(definition.initialState).toBe('IDLE');
      expect(definition.states['IDLE']).toBeDefined();
      expect(definition.states['PREPARE_CONTEXT']).toBeDefined();
      expect(definition.states['MASTER_DECISION']).toBeDefined();
      expect(definition.states['DISPATCH']).toBeDefined();
      expect(definition.states['OBSERVE']).toBeDefined();
      expect(definition.states['EVALUATE']).toBeDefined();
      expect(definition.states['TERMINATE']).toBeDefined();
    });

    it('应该包含正确的状态数量', () => {
      const definition = createAgentServiceFSMDefinition();
      expect(Object.keys(definition.states)).toHaveLength(7);
    });

    it('IDLE 状态应该响应 USER_REQUEST 事件', () => {
      const definition = createAgentServiceFSMDefinition();
      expect(definition.states['IDLE'].on['USER_REQUEST']).toBeDefined();
    });
  });

  describe('createSubAgentFSMDefinition', () => {
    it('应该创建 Sub-Agent FSM 定义', () => {
      const definition = createSubAgentFSMDefinition();

      expect(definition).toBeDefined();
      expect(definition.initialState).toBe('SPAWNED');
    });

    it('应该包含正确的状态', () => {
      const definition = createSubAgentFSMDefinition();
      expect(definition.states['SPAWNED']).toBeDefined();
      expect(definition.states['INPUT_VALIDATED']).toBeDefined();
      expect(definition.states['RUNNING']).toBeDefined();
      expect(definition.states['OUTPUT_CHECKED']).toBeDefined();
      expect(definition.states['COMPLETED']).toBeDefined();
      expect(definition.states['FAILED']).toBeDefined();
    });
  });
});
