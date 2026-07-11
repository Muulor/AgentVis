/**
 * MasterBrainReasoningGuard 单元测试
 *
 * 覆盖推理循环检测、软硬门槛和有界 UI 预览的状态机边界。
 */

import { describe, expect, it } from 'vitest';
import {
  BoundedReasoningPreview,
  MbEstimatedTokenCounter,
  MasterBrainReasoningGuard,
  type MbReasoningGuardConfig,
} from '../MasterBrainReasoningGuard';

const createConfig = (overrides: Partial<MbReasoningGuardConfig> = {}): MbReasoningGuardConfig => ({
  softEstimatedTokens: 100,
  softDurationMs: 1_000,
  hardEstimatedTokens: 100_000,
  hardDurationMs: 600_000,
  detectionWindowChars: 32 * 1024,
  exactCheckStepChars: 1,
  approximateCheckStepChars: 512,
  previewHeadChars: 8 * 1024,
  previewTailChars: 16 * 1024,
  ...overrides,
});

function createNovelText(seed: number, length: number): string {
  let state = seed >>> 0;
  let content = '';
  while (content.length < length) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    content += `${state.toString(36)}:${content.length.toString(36)}|`;
  }
  return content.slice(0, length);
}

describe('MasterBrainReasoningGuard', () => {
  it('shares the incremental CJK and non-CJK token estimate used by stream guards', () => {
    const counter = new MbEstimatedTokenCounter();
    counter.append('中文');
    counter.append('abcd');

    expect(counter.estimatedTokens).toBe(3);
  });

  it('detects an exact cycle whose repetitions span stream chunks', () => {
    const guard = new MasterBrainReasoningGuard(createConfig());
    const cycle = `[cycle-start]${createNovelText(17, 280)}[cycle-end]`;
    const reasoning = cycle.repeat(4);
    const chunks = [
      reasoning.slice(0, 137),
      reasoning.slice(137, 611),
      reasoning.slice(611, 947),
      reasoning.slice(947),
    ];

    const results = chunks.map((chunk, index) => guard.appendReasoning(chunk, index * 100));

    expect(results.slice(0, -1).every((result) => result.action === 'continue')).toBe(true);
    expect(results.at(-1)).toMatchObject({
      action: 'retry',
      reason: 'exact_cycle',
      evidence: {
        kind: 'exact_cycle',
        periodChars: cycle.length,
        repeatedChars: reasoning.length,
      },
    });
  });

  it('enters the soft phase for token or time pressure without terminating novel reasoning', () => {
    const tokenGuard = new MasterBrainReasoningGuard(
      createConfig({
        softEstimatedTokens: 20,
        softDurationMs: 10_000,
      })
    );

    const tokenResult = tokenGuard.appendReasoning(createNovelText(1, 200), 0);
    expect(tokenResult).toMatchObject({
      action: 'continue',
      softEntered: true,
      metrics: { phase: 'soft' },
    });
    expect(tokenGuard.appendReasoning(createNovelText(2, 1_500), 100)).toMatchObject({
      action: 'continue',
      softEntered: false,
      metrics: { phase: 'soft' },
    });

    const timeGuard = new MasterBrainReasoningGuard(
      createConfig({
        softEstimatedTokens: 10_000,
        softDurationMs: 1_000,
      })
    );
    expect(timeGuard.appendReasoning('initial thought', 10)).toMatchObject({
      action: 'continue',
      softEntered: false,
      metrics: { phase: 'normal' },
    });
    expect(timeGuard.evaluateTime(1_010)).toMatchObject({
      action: 'continue',
      softEntered: true,
      metrics: { phase: 'soft', elapsedMs: 1_000 },
    });
  });

  it('aborts at the hard token fuse', () => {
    const guard = new MasterBrainReasoningGuard(createConfig({ hardEstimatedTokens: 5 }));

    expect(guard.appendReasoning('abcdefghijklmnopqrst', 0)).toMatchObject({
      action: 'abort',
      reason: 'hard_token_fuse',
      metrics: { estimatedTokens: 5 },
    });
  });

  it('aborts at the hard time boundary but not one millisecond before it', () => {
    const guard = new MasterBrainReasoningGuard(createConfig({ hardDurationMs: 1_000 }));
    guard.appendReasoning('initial thought', 100);

    expect(guard.evaluateTime(1_099)).toMatchObject({
      action: 'continue',
      metrics: { elapsedMs: 999 },
    });
    expect(guard.evaluateTime(1_100)).toMatchObject({
      action: 'abort',
      reason: 'hard_time_fuse',
      metrics: { elapsedMs: 1_000 },
    });
  });

  it('does not start the wall-clock fuse until non-empty reasoning arrives', () => {
    const guard = new MasterBrainReasoningGuard(createConfig({ hardDurationMs: 1_000 }));

    expect(guard.appendReasoning('', 100)).toMatchObject({
      action: 'continue',
      metrics: { elapsedMs: 0, phase: 'normal' },
    });
    expect(guard.evaluateTime(10_000)).toMatchObject({
      action: 'continue',
      metrics: { elapsedMs: 0, phase: 'normal' },
    });

    guard.appendReasoning('reasoning started', 10_000);
    expect(guard.evaluateTime(10_999).action).toBe('continue');
    expect(guard.evaluateTime(11_000)).toMatchObject({
      action: 'abort',
      reason: 'hard_time_fuse',
    });
  });

  it('gives the hard time fuse priority when a later delta completes an exact cycle', () => {
    const cycle = `[time-priority]${createNovelText(23, 280)}`;
    const guard = new MasterBrainReasoningGuard(createConfig({ hardDurationMs: 1_000 }));

    expect(guard.appendReasoning(cycle, 0).action).toBe('continue');
    expect(guard.appendReasoning(cycle.repeat(3), 1_000)).toMatchObject({
      action: 'abort',
      reason: 'hard_time_fuse',
    });
  });

  it('gives the hard token fuse priority when the same delta also completes an exact cycle', () => {
    const cycle = `[priority-cycle]${createNovelText(29, 280)}`;
    const reasoning = cycle.repeat(4);
    const estimatedTokens = Math.ceil(reasoning.length / 4);
    const guard = new MasterBrainReasoningGuard(
      createConfig({ hardEstimatedTokens: estimatedTokens })
    );

    expect(guard.appendReasoning(reasoning, 0)).toMatchObject({
      action: 'abort',
      reason: 'hard_token_fuse',
      metrics: { estimatedTokens },
    });
  });

  it('resets approximate-loop stagnation when a non-empty final delta arrives', () => {
    const guard = new MasterBrainReasoningGuard(
      createConfig({
        softEstimatedTokens: 1,
        hardEstimatedTokens: 100_000,
        hardDurationMs: 1_000_000,
        exactCheckStepChars: Number.MAX_SAFE_INTEGER,
        approximateCheckStepChars: 2_048,
      })
    );
    const repeatedWindow = 'a'.repeat(2_048);

    expect(guard.appendReasoning(repeatedWindow, 0).action).toBe('continue');
    expect(guard.appendReasoning(repeatedWindow, 10_000).action).toBe('continue');
    expect(guard.appendReasoning(repeatedWindow, 20_000).action).toBe('continue');

    guard.noteFinalDelta('answer started', 25_000);

    expect(guard.appendReasoning(repeatedWindow, 40_000).action).toBe('continue');
    expect(guard.appendReasoning(repeatedWindow, 50_000).action).toBe('continue');
    expect(guard.appendReasoning(repeatedWindow, 54_000).action).toBe('continue');
    expect(guard.appendReasoning(repeatedWindow, 55_000)).toMatchObject({
      action: 'retry',
      reason: 'approximate_stall',
      evidence: {
        kind: 'approximate_stall',
        noveltyRatio: 0,
        similarity: 1,
      },
    });
  });
});

describe('BoundedReasoningPreview', () => {
  it('keeps the full content at the exact boundary and rolls only the tail after overflow', () => {
    const preview = new BoundedReasoningPreview(4, 4);

    preview.append('abcdefgh');
    expect(preview.snapshot()).toEqual({
      truncated: false,
      content: 'abcdefgh',
      totalChars: 8,
      omittedChars: 0,
    });

    preview.append('i');
    expect(preview.snapshot()).toEqual({
      truncated: true,
      head: 'abcd',
      tail: 'fghi',
      totalChars: 9,
      omittedChars: 1,
    });

    preview.append('jkl');
    expect(preview.snapshot()).toEqual({
      truncated: true,
      head: 'abcd',
      tail: 'ijkl',
      totalChars: 12,
      omittedChars: 4,
    });
  });

  it('does not leave unpaired emoji surrogates at truncated head or tail boundaries', () => {
    const preview = new BoundedReasoningPreview(2, 2);

    preview.append('A😀BC😀Z');

    expect(preview.snapshot()).toEqual({
      truncated: true,
      head: 'A',
      tail: 'Z',
      totalChars: 8,
      omittedChars: 6,
    });
  });
});
