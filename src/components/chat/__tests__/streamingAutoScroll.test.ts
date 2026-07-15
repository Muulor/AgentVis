import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelThrottledScroll,
  scheduleThrottledScroll,
  type ScrollThrottleState,
} from '../streamingAutoScroll';

function createState(): ScrollThrottleState {
  return { timer: null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('streamingAutoScroll', () => {
  it('does not postpone the pending scroll when more chunks arrive', () => {
    vi.useFakeTimers();
    const state = createState();
    const scroll = vi.fn();

    scheduleThrottledScroll(state, scroll, 100);
    vi.advanceTimersByTime(50);
    scheduleThrottledScroll(state, scroll, 100);
    vi.advanceTimersByTime(50);

    expect(scroll).toHaveBeenCalledTimes(1);

    scheduleThrottledScroll(state, scroll, 100);
    vi.advanceTimersByTime(100);

    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending scroll during cleanup', () => {
    vi.useFakeTimers();
    const state = createState();
    const scroll = vi.fn();

    scheduleThrottledScroll(state, scroll, 100);
    cancelThrottledScroll(state);
    vi.runAllTimers();

    expect(scroll).not.toHaveBeenCalled();
    expect(state.timer).toBeNull();
  });
});
