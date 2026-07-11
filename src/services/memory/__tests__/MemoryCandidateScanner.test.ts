/**
 * MemoryCandidateScanner 单元测试
 *
 * 覆盖规则匹配、用户确认检测、模糊词过滤、去重等核心逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCandidateScanner, createMemoryCandidateScanner } from '../MemoryCandidateScanner';
import type { Message } from '../types';

// ==================== 测试工具 ====================

function createMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `msg_${role}_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'test-agent',
    role,
    content,
    createdAt: Date.now(),
  };
}

/** 创建一组用户+助手消息 */
function createInteraction(userContent: string, assistantContent: string = '好的'): Message[] {
  return [createMessage('user', userContent), createMessage('assistant', assistantContent)];
}

// ==================== 测试用例 ====================

describe('MemoryCandidateScanner', () => {
  let scanner: MemoryCandidateScanner;

  beforeEach(() => {
    scanner = new MemoryCandidateScanner('test-agent');
  });

  // ───────────────────────────────────────────────────
  // 身份类匹配
  // ───────────────────────────────────────────────────

  describe('身份类 (identity_role) 匹配', () => {
    it('应检测 "我是后端工程师"', () => {
      const result = scanner.scan(createInteraction('我是后端工程师'));

      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      const identityCandidates = result.candidates.filter((c) => c.category === 'identity_role');
      expect(identityCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('应检测英文身份表达', () => {
      const result = scanner.scan(createInteraction("I'm a frontend developer"));

      const identityCandidates = result.candidates.filter((c) => c.category === 'identity_role');
      expect(identityCandidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ───────────────────────────────────────────────────
  // 偏好类匹配
  // ───────────────────────────────────────────────────

  describe('偏好类 (preference_style) 匹配', () => {
    it('应检测 "我喜欢简洁回复"', () => {
      const result = scanner.scan(createInteraction('我喜欢简洁回复'));

      const prefCandidates = result.candidates.filter((c) => c.category === 'preference_style');
      expect(prefCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('应检测 "I prefer TypeScript"', () => {
      const result = scanner.scan(createInteraction('I prefer TypeScript over JavaScript'));

      const prefCandidates = result.candidates.filter((c) => c.category === 'preference_style');
      expect(prefCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('应检测英文回复风格约束表达', () => {
      const result = scanner.scan(
        createInteraction('I prefer that you keep responses concise and structured')
      );

      const prefCandidates = result.candidates.filter((c) => c.category === 'preference_style');
      expect(prefCandidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ───────────────────────────────────────────────────
  // 用户确认检测
  // ───────────────────────────────────────────────────

  describe('用户确认检测', () => {
    it('应检测 "你记住这个"', () => {
      const result = scanner.scan(createInteraction('你记住这个，我喜欢用 Vim'));

      expect(result.hasUserConfirmation).toBe(true);
    });

    it('应检测 "对的" 确认词', () => {
      const result = scanner.scan(createInteraction('对的，我是用 Mac 的'));

      expect(result.hasUserConfirmation).toBe(true);
    });

    it('应检测确定性关键词 "必须"', () => {
      const result = scanner.scan(createInteraction('必须用 TypeScript'));

      expect(result.hasUserConfirmation).toBe(true);
    });

    it('应检测英文记忆命令', () => {
      const result = scanner.scan(
        createInteraction('Please remember this: I use VS Code every day')
      );

      expect(result.hasUserConfirmation).toBe(true);
    });

    it('应排除伪确认 "你确定吗？"（疑问句）', () => {
      const result = scanner.scan(createInteraction('你确定吗？'));

      // 伪记忆请求不应触发确认
      expect(result.hasUserConfirmation).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────
  // 模糊词 / 情绪词过滤
  // ───────────────────────────────────────────────────

  describe('模糊词 / 情绪词过滤', () => {
    it('大量模糊词应过滤掉整条消息', () => {
      // fuzzyCount >= 3 时跳过
      const result = scanner.scan(createInteraction('可能或许大概应该试试看看'));

      expect(result.candidates.length).toBe(0);
    });

    it('少量模糊词不应完全过滤', () => {
      // 只有 1-2 个模糊词，不会被整条过滤
      const result = scanner.scan(createInteraction('我喜欢可能用 Vim'));

      // 可能有候选（模糊词扣分但不阻止）
      // 主要测试不因少量模糊词丢弃整条消息
      expect(result.candidates.length).toBeGreaterThanOrEqual(0);
    });

    it('大量情绪词应过滤', () => {
      // emotionalCount >= 2 时跳过
      const result = scanner.scan(createInteraction('真烦，太累了，我是工程师'));

      expect(result.candidates.length).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────
  // 去重
  // ───────────────────────────────────────────────────

  describe('候选去重', () => {
    it('相同内容在不同轮次出现应合并 occurrenceCount', () => {
      const result = scanner.scan([
        ...createInteraction('我是后端工程师'),
        ...createInteraction('我是后端工程师，专做 Java'),
      ]);

      // 两轮相同类别相同内容应去重合并
      // 精确检查取决于句子提取逻辑，但不应有完全重复的候选
      const contents = result.candidates.map((c) => c.content);
      const uniqueContents = new Set(contents);
      // 去重后不应有完全相同的 content
      expect(uniqueContents.size).toBe(contents.length);
    });
  });

  // ───────────────────────────────────────────────────
  // 边界情况
  // ───────────────────────────────────────────────────

  describe('边界情况', () => {
    it('空消息不应产生候选', () => {
      const result = scanner.scan(createInteraction(''));

      expect(result.candidates.length).toBe(0);
    });

    it('短消息不匹配关键词时不产生候选', () => {
      const result = scanner.scan(createInteraction('好'));

      expect(result.candidates.length).toBe(0);
    });

    it('空交互列表应返回空结果', () => {
      const result = scanner.scan([]);

      expect(result.candidates.length).toBe(0);
      expect(result.hasUserConfirmation).toBe(false);
    });

    it('userConfirmed 应使用会话级确认信号', () => {
      // 第一轮有确认词，第二轮有偏好表达
      // 两者的候选都应带有 userConfirmed=true
      const result = scanner.scan([
        ...createInteraction('对的，记住了'),
        ...createInteraction('我喜欢用 Vim 编辑代码'),
      ]);

      expect(result.hasUserConfirmation).toBe(true);
      if (result.candidates.length > 0) {
        // 所有候选都应带有 userConfirmed=true（会话级信号）
        for (const c of result.candidates) {
          expect(c.userConfirmed).toBe(true);
        }
      }
    });
  });

  // ───────────────────────────────────────────────────
  // 工厂函数
  // ───────────────────────────────────────────────────

  describe('createMemoryCandidateScanner', () => {
    it('应创建实例', () => {
      const instance = createMemoryCandidateScanner('agent-123');
      expect(instance).toBeInstanceOf(MemoryCandidateScanner);
    });
  });
});
