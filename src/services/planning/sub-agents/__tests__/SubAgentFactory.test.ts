/**
 * SubAgentFactory 单元测试
 *
 * 测试工厂创建和验证功能
 *
 * 设计说明：
 * 移除固定分类后，不再有 type 属性和类型推断逻辑。
 * 工具权限不再按 Agent 分类控制，由 ToolRiskGuard 基于风险等级警告。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubAgentFactory, subAgentFactory } from '../SubAgentFactory';
import type { SubAgentSpec } from '../../brain/types';
import type { TaskContext } from '../types';

describe('SubAgentFactory', () => {
  let factory: SubAgentFactory;

  beforeEach(() => {
    factory = new SubAgentFactory();
    factory.resetCounter();
  });

  const createValidSpec = (overrides: Partial<SubAgentSpec> = {}): SubAgentSpec => ({
    role: '测试角色',
    allowedTools: ['read'],
    terminationCondition: '完成后返回',
    ...overrides,
  });

  const createContext = (): TaskContext => ({
    files: [{ name: 'test.ts', size: '1.2KB', modified: '2026-03-08 12:00' }],
    cwd: '/project',
  });

  // ───────────────────────────────────────────────────────
  // 成功创建
  // ───────────────────────────────────────────────────────

  describe('create - 成功创建', () => {
    it('应成功创建只读 Agent', () => {
      const spec = createValidSpec({
        allowedTools: ['read', 'web_search'],
      });

      const result = factory.create(spec, createContext(), []);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.instance.allowedTools).toContain('read');
        expect(result.instance.allowedTools).toContain('web_search');
      }
    });

    it('应成功创建写入 Agent', () => {
      const spec = createValidSpec({
        allowedTools: ['file_write', 'read'],
      });

      const result = factory.create(spec, createContext(), []);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.instance.allowedTools).toContain('file_write');
      }
    });

    it('应成功创建带 behaviorHint 的 Agent', () => {
      const spec = createValidSpec({ behaviorHint: 'careful' });
      const result = factory.create(spec, createContext(), []);

      expect(result.success).toBe(true);
      if (result.success) {
        // systemPrompt 应包含 careful 模板内容
        expect(result.instance.systemPrompt).toContain('Careful Mode');
      }
    });
  });

  // ───────────────────────────────────────────────────────
  // spec 验证失败
  // ───────────────────────────────────────────────────────

  describe('create - spec 验证失败', () => {
    it('应拒绝缺少 role 的 spec', () => {
      const spec = createValidSpec({ role: '' });
      const result = factory.create(spec, createContext(), []);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('role');
      }
    });

    it('应拒绝空的 allowedTools', () => {
      const spec = createValidSpec({ allowedTools: [] });
      const result = factory.create(spec, createContext(), []);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('allowedTools');
      }
    });
  });

  // ───────────────────────────────────────────────────────
  // 工具风险提示（不再阻止，仅警告）
  // ───────────────────────────────────────────────────────

  describe('create - 工具风险检查', () => {
    it('高风险工具应触发日志但不阻止创建', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const spec = createValidSpec({
        allowedTools: ['exec', 'read'],
      });

      const result = factory.create(spec, createContext(), []);

      // 高风险工具不阻止创建（与旧行为不同）
      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });

    it('未注册工具应触发警告但不阻止创建', () => {
      const spec = createValidSpec({
        allowedTools: ['read', 'custom_unknown_tool'],
      });

      const result = factory.create(spec, createContext(), []);

      // 未注册工具不阻止创建（警告通过 Logger 输出，不再断言 console.warn）
      expect(result.success).toBe(true);
    });

    it('任意工具组合都应成功创建（MasterBrain 决定授权）', () => {
      const spec = createValidSpec({
        allowedTools: ['read', 'file_write', 'exec', 'web_search'],
      });

      const result = factory.create(spec, createContext(), []);
      expect(result.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────
  // 实例属性
  // ───────────────────────────────────────────────────────

  describe('create - 实例属性', () => {
    it('应包含唯一 ID', () => {
      const spec = createValidSpec();
      const result1 = factory.create(spec, createContext(), []);
      const result2 = factory.create(spec, createContext(), []);

      if (result1.success && result2.success) {
        expect(result1.instance.id).not.toBe(result2.instance.id);
      }
    });

    it('ID 不应包含 agent 类型前缀', () => {
      const spec = createValidSpec();
      const result = factory.create(spec, createContext(), []);

      if (result.success) {
        expect(result.instance.id).toMatch(/^agent-/);
        expect(result.instance.id).not.toMatch(/^research-/);
        expect(result.instance.id).not.toMatch(/^execution-/);
        expect(result.instance.id).not.toMatch(/^verification-/);
      }
    });

    it('应包含 System Prompt', () => {
      const spec = createValidSpec();
      const result = factory.create(spec, createContext(), []);

      if (result.success) {
        expect(result.instance.systemPrompt).toContain('Sub-Agent');
        expect(result.instance.systemPrompt.length).toBeGreaterThan(100);
      }
    });

    it('应包含创建时间', () => {
      const spec = createValidSpec();
      const result = factory.create(spec, createContext(), []);

      if (result.success) {
        expect(result.instance.createdAt).toBeInstanceOf(Date);
      }
    });

    it('应使用 loopConfig.maxSteps 覆盖默认值', () => {
      const spec = createValidSpec({
        loopConfig: {
          initialBudget: 3,
          checkpointInterval: 2,
          maxSteps: 20,
          terminationPatterns: ['TASK_COMPLETE'],
        },
      });
      const result = factory.create(spec, createContext(), []);

      if (result.success) {
        expect(result.instance.maxSteps).toBe(20);
      }
    });

    it('无 loopConfig 时应使用默认 maxSteps', () => {
      const spec = createValidSpec();
      const result = factory.create(spec, createContext(), []);

      if (result.success) {
        // 默认值来自 PLANNING_CONSTANTS.SUB_AGENT_DEFAULT_MAX_STEPS
        expect(result.instance.maxSteps).toBe(50);
      }
    });
  });
});

describe('subAgentFactory 单例', () => {
  it('应导出单例实例', () => {
    expect(subAgentFactory).toBeInstanceOf(SubAgentFactory);
  });
});
