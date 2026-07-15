/**
 * 流式消息自动滚动的轻量节流器。
 *
 * 首个 chunk 安排滚动后，后续高频 chunk 不会取消或推迟该任务；
 * 定时器执行后才允许安排下一次滚动。
 */

export interface ScrollThrottleState {
  timer: ReturnType<typeof setTimeout> | null;
}

export function scheduleThrottledScroll(
  state: ScrollThrottleState,
  scroll: () => void,
  delayMs: number
): void {
  if (state.timer !== null) return;

  state.timer = setTimeout(() => {
    state.timer = null;
    scroll();
  }, delayMs);
}

export function cancelThrottledScroll(state: ScrollThrottleState): void {
  if (state.timer === null) return;
  clearTimeout(state.timer);
  state.timer = null;
}
