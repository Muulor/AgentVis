/**
 * ThoughtVisualizer 单元测试
 *
 * 测试思维链可视化的核心功能：
 * - 思维提取（<thinking> 标签解析）
 * - 信心度估算
 * - 替代方案提取
 * - 回调通知
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThoughtVisualizer } from '../ThoughtVisualizer';
import type { AgentLoopCallbacks, ThoughtPhase } from '../types';

describe('ThoughtVisualizer', () => {
  let visualizer: ThoughtVisualizer;
  let mockCallbacks: AgentLoopCallbacks;

  beforeEach(() => {
    mockCallbacks = {
      onThought: vi.fn(),
    };
    visualizer = new ThoughtVisualizer(mockCallbacks);
  });

  // ═══════════════════════════════════════════════════════════════
  // 思维提取测试
  // ═══════════════════════════════════════════════════════════════

  describe('思维提取', () => {
    it('应正确提取 <thinking> 标签内容', () => {
      const content = `
                Some preamble text.
                <thinking>
                This is my internal reasoning process.
                I need to consider multiple factors.
                </thinking>
                And some conclusion.
            `;

      visualizer.visualize('orient', content);

      expect(mockCallbacks.onThought).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('internal reasoning'),
        })
      );
    });

    it('无 <thinking> 标签时应使用摘要', () => {
      const content = 'This is a plain response without thinking tags.';

      visualizer.visualize('decide', content);

      expect(mockCallbacks.onThought).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('This is a plain response'),
        })
      );
    });

    it('摘要应截断过长内容', () => {
      const longContent = 'A'.repeat(500);

      visualizer.visualize('act', longContent);

      const call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.thought.length).toBeLessThanOrEqual(203); // 200 + "..."
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 信心度估算测试
  // ═══════════════════════════════════════════════════════════════

  describe('信心度估算', () => {
    it('含不确定词汇应降低信心度', () => {
      const uncertainContent = 'Maybe this could work, perhaps we should try.';

      visualizer.visualize('orient', uncertainContent);

      const call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.confidence).toBeLessThan(0.5);
    });

    it('含确定词汇应提升信心度', () => {
      const certainContent = 'I am definitely certain this is clearly the right approach.';

      visualizer.visualize('decide', certainContent);

      const call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.confidence).toBeGreaterThan(0.5);
    });

    it('中性内容应返回基础信心度', () => {
      const neutralContent = 'The function returns a value.';

      visualizer.visualize('act', neutralContent);

      const call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.confidence).toBeCloseTo(0.5, 1);
    });

    it('信心度应限制在 0-1 范围内', () => {
      // 极度不确定
      const veryUncertain = 'maybe perhaps might uncertain possibly could be unsure';
      visualizer.visualize('orient', veryUncertain);
      let call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.confidence).toBeGreaterThanOrEqual(0);
      expect(call.confidence).toBeLessThanOrEqual(1);

      // 极度确定
      const veryCertain = 'definitely certainly clearly absolutely surely obviously';
      visualizer.visualize('decide', veryCertain);
      call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[1]![0];
      expect(call.confidence).toBeGreaterThanOrEqual(0);
      expect(call.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 回调通知测试
  // ═══════════════════════════════════════════════════════════════

  describe('回调通知', () => {
    it('应正确触发 onThought 回调', () => {
      visualizer.visualize('observe', 'Test content');

      expect(mockCallbacks.onThought).toHaveBeenCalledTimes(1);
    });

    it('ThoughtStep 应包含正确的 phase', () => {
      const phases: ThoughtPhase[] = ['observe', 'orient', 'decide', 'act'];

      for (const phase of phases) {
        visualizer.visualize(phase, 'Content');
      }

      const calls = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0].phase).toBe('observe');
      expect(calls[1]![0].phase).toBe('orient');
      expect(calls[2]![0].phase).toBe('decide');
      expect(calls[3]![0].phase).toBe('act');
    });

    it('无回调时不应抛错', () => {
      const noCallbackVisualizer = new ThoughtVisualizer({});

      expect(() => {
        noCallbackVisualizer.visualize('decide', 'Test');
      }).not.toThrow();
    });

    it('ThoughtStep 应包含时间戳', () => {
      const before = new Date();
      visualizer.visualize('act', 'Content');
      const after = new Date();

      const call = (mockCallbacks.onThought as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.timestamp).toBeDefined();
      expect(call.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(call.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
