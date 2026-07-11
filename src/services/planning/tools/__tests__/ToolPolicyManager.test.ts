/**
 * ToolRiskGuard 单元测试
 *
 * 测试基于工具风险等级的安全守卫功能
 *
 * 覆盖范围：
 * - TOOL_RISK_REGISTRY 风险注册表
 * - ToolRiskGuard 风险查询、自定义、验证、Checkpoint 判定
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolRiskGuard,
  TOOL_RISK_REGISTRY,
  DEFAULT_TOOL_RISK,
  toolRiskGuard,
  type ToolRiskLevel,
} from '../ToolPolicyManager';

// ═══════════════════════════════════════════════════════════════
// TOOL_RISK_REGISTRY 测试
// ═══════════════════════════════════════════════════════════════

describe('TOOL_RISK_REGISTRY', () => {
  it('应为 read 定义 low 风险', () => {
    expect(TOOL_RISK_REGISTRY['read']).toBe('low');
  });

  it('应为 web_search 定义 low 风险', () => {
    expect(TOOL_RISK_REGISTRY['web_search']).toBe('low');
  });

  it('conversation_search should be low risk', () => {
    expect(TOOL_RISK_REGISTRY['conversation_search']).toBe('low');
  });

  it('应为 file_write 定义 medium 风险', () => {
    expect(TOOL_RISK_REGISTRY['file_write']).toBe('medium');
  });

  it('应为 exec 定义 high 风险', () => {
    expect(TOOL_RISK_REGISTRY['exec']).toBe('high');
  });

  it('应为 external_skill_execute 定义 high 风险', () => {
    expect(TOOL_RISK_REGISTRY['external_skill_execute']).toBe('high');
  });
});

// ═══════════════════════════════════════════════════════════════
// ToolRiskGuard 测试
// ═══════════════════════════════════════════════════════════════

describe('ToolRiskGuard', () => {
  let guard: ToolRiskGuard;

  beforeEach(() => {
    guard = new ToolRiskGuard();
  });

  // ───────────────────────────────────────────────────────
  // getToolRisk
  // ───────────────────────────────────────────────────────

  describe('getToolRisk', () => {
    it.each<[string, ToolRiskLevel]>([
      ['read', 'low'],
      ['web_search', 'low'],
      ['conversation_search', 'low'],
      ['file_write', 'medium'],
      ['exec', 'high'],
      ['external_skill_execute', 'high'],
    ])('已注册工具 "%s" 应返回 "%s"', (tool, expected) => {
      expect(guard.getToolRisk(tool)).toBe(expected);
    });

    it('未注册工具应返回默认风险等级 (medium)', () => {
      expect(guard.getToolRisk('unknown_tool')).toBe(DEFAULT_TOOL_RISK);
      expect(guard.getToolRisk('custom_api')).toBe('medium');
    });
  });

  // ───────────────────────────────────────────────────────
  // setCustomRisk / clearCustomRisk
  // ───────────────────────────────────────────────────────

  describe('自定义风险等级', () => {
    it('setCustomRisk 应覆盖默认风险', () => {
      guard.setCustomRisk('read', 'high');
      expect(guard.getToolRisk('read')).toBe('high');
    });

    it('setCustomRisk 可为未注册工具设置风险', () => {
      guard.setCustomRisk('new_tool', 'low');
      expect(guard.getToolRisk('new_tool')).toBe('low');
    });

    it('clearCustomRisk 应恢复默认风险', () => {
      guard.setCustomRisk('read', 'high');
      guard.clearCustomRisk('read');
      expect(guard.getToolRisk('read')).toBe('low');
    });

    it('clearCustomRisk 对未设置自定义的工具应无副作用', () => {
      guard.clearCustomRisk('exec');
      expect(guard.getToolRisk('exec')).toBe('high');
    });
  });

  // ───────────────────────────────────────────────────────
  // validateToolList
  // ───────────────────────────────────────────────────────

  describe('validateToolList', () => {
    it('已注册工具列表应无警告', () => {
      const result = guard.validateToolList(['read', 'file_write', 'exec']);
      expect(result.unknownTools).toHaveLength(0);
    });

    it('应识别未注册工具', () => {
      const result = guard.validateToolList(['read', 'mystery_tool', 'another_unknown']);
      expect(result.unknownTools).toEqual(['mystery_tool', 'another_unknown']);
    });

    it('应识别高风险工具', () => {
      const result = guard.validateToolList([
        'read',
        'exec',
        'external_skill_execute',
        'file_write',
      ]);
      expect(result.highRiskTools).toEqual(['exec', 'external_skill_execute']);
    });

    it('空列表应返回空结果', () => {
      const result = guard.validateToolList([]);
      expect(result.unknownTools).toHaveLength(0);
      expect(result.highRiskTools).toHaveLength(0);
    });

    it('自定义高风险工具也应被识别', () => {
      guard.setCustomRisk('file_write', 'high');
      const result = guard.validateToolList(['file_write', 'exec']);
      expect(result.highRiskTools).toContain('file_write');
      expect(result.highRiskTools).toContain('exec');
    });
  });

  // ───────────────────────────────────────────────────────
  // getHighRiskTools
  // ───────────────────────────────────────────────────────

  describe('getHighRiskTools', () => {
    it('应只返回高风险工具', () => {
      const result = guard.getHighRiskTools([
        'read',
        'exec',
        'external_skill_execute',
        'file_write',
        'web_search',
      ]);
      expect(result).toEqual(['exec', 'external_skill_execute']);
    });

    it('无高风险工具时应返回空数组', () => {
      const result = guard.getHighRiskTools(['read', 'web_search']);
      expect(result).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // requiresCheckpoint
  // ───────────────────────────────────────────────────────

  describe('requiresCheckpoint', () => {
    it('高风险工具应需要 Checkpoint', () => {
      expect(guard.requiresCheckpoint('exec')).toBe(true);
      expect(guard.requiresCheckpoint('external_skill_execute')).toBe(true);
    });

    it('中低风险工具不需要 Checkpoint', () => {
      expect(guard.requiresCheckpoint('read')).toBe(false);
      expect(guard.requiresCheckpoint('file_write')).toBe(false);
      expect(guard.requiresCheckpoint('web_search')).toBe(false);
    });

    it('自定义为高风险后应需要 Checkpoint', () => {
      guard.setCustomRisk('file_write', 'high');
      expect(guard.requiresCheckpoint('file_write')).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────
  // getAllRisks
  // ───────────────────────────────────────────────────────

  describe('getAllRisks', () => {
    it('应包含所有注册表条目', () => {
      const risks = guard.getAllRisks();
      expect(risks).toMatchObject(TOOL_RISK_REGISTRY);
    });

    it('应包含自定义风险等级', () => {
      guard.setCustomRisk('new_tool', 'low');
      const risks = guard.getAllRisks();
      expect(risks['new_tool']).toBe('low');
    });

    it('自定义应覆盖注册表值', () => {
      guard.setCustomRisk('read', 'high');
      const risks = guard.getAllRisks();
      expect(risks['read']).toBe('high');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 单例测试
// ═══════════════════════════════════════════════════════════════

describe('toolRiskGuard 单例', () => {
  it('应导出单例实例', () => {
    expect(toolRiskGuard).toBeInstanceOf(ToolRiskGuard);
  });
});
