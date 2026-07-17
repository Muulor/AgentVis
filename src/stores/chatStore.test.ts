/**
 * chatStore foreground-run ownership regression tests.
 *
 * Covers the Task cancellation -> Chat start -> stale Task cleanup race for the
 * shared sending, streaming, session, and abort-controller state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
}));

vi.mock('@services/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { useChatStore } from './chatStore';

describe('chatStore foreground run ownership', () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    useChatStore.setState({
      sendingContexts: new Set(),
      sendingRunIdsByContext: new Map(),
      latestRunIdsByContext: new Map(),
      streamingByContext: new Map(),
      streamingRunIdsByContext: new Map(),
      abortControllers: new Map(),
      sessionIdByContext: new Map(),
    });
  });

  it('keeps a new Chat run intact when a cancelled Task run settles late', () => {
    const contextId = 'agent-1';
    const planningRunId = 'planning-run';
    const chatRunId = 'chat-run';
    const planningController = new AbortController();
    const chatController = new AbortController();
    const staleController = new AbortController();
    const store = useChatStore.getState();

    expect(store.startSending(contextId, planningRunId)).toBe(true);
    expect(store.startStreaming(contextId, 'Agent', planningRunId)).toBe(true);
    store.setSessionId(contextId, 'planning-session', planningRunId);
    store.setAbortController(contextId, planningController, planningRunId);
    expect(store.startSending(contextId, chatRunId)).toBe(false);

    // stopPlanningTask releases the old UI state before AgentLoop has settled.
    expect(store.finishSending(contextId, planningRunId)).toBe(true);
    expect(store.stopStreaming(contextId, planningRunId)).toBe(true);
    expect(planningController.signal.aborted).toBe(true);

    expect(store.startSending(contextId, chatRunId)).toBe(true);
    expect(store.startStreaming(contextId, 'Agent', chatRunId)).toBe(true);
    store.setSessionId(contextId, 'chat-session', chatRunId);
    store.setAbortController(contextId, chatController, chatRunId);
    store.appendStreamingContent(contextId, 'new answer', chatRunId);
    store.appendStreamingReasoning(contextId, 'new reasoning', chatRunId);

    // The cancelled Task's delayed callbacks/finally must not touch the Chat run.
    expect(store.startStreaming(contextId, 'stale Task', planningRunId)).toBe(false);
    store.setStreamingContent(contextId, 'stale content', planningRunId);
    store.appendStreamingContent(contextId, 'stale delta', planningRunId);
    store.setSessionId(contextId, 'stale-session', planningRunId);
    store.setAbortController(contextId, staleController, planningRunId);
    expect(store.finishSending(contextId, planningRunId)).toBe(false);
    expect(store.finishStreaming(contextId, planningRunId)).toBe(false);
    expect(store.stopStreaming(contextId, planningRunId)).toBe(false);

    const current = useChatStore.getState();
    expect(current.sendingContexts.has(contextId)).toBe(true);
    expect(current.sendingRunIdsByContext.get(contextId)).toBe(chatRunId);
    expect(current.streamingRunIdsByContext.get(contextId)).toBe(chatRunId);
    expect(current.getStreamingState(contextId)).toMatchObject({
      content: 'new answer',
      reasoningContent: 'new reasoning',
      isStreaming: true,
      agentName: 'Agent',
    });
    expect(current.sessionIdByContext.get(contextId)).toBe('chat-session');
    expect(current.abortControllers.get(contextId)).toBe(chatController);
    expect(chatController.signal.aborted).toBe(false);
    expect(staleController.signal.aborted).toBe(false);

    expect(store.finishStreaming(contextId, chatRunId)).toBe(true);
    expect(store.finishSending(contextId, chatRunId)).toBe(true);
    expect(useChatStore.getState().sendingContexts.has(contextId)).toBe(false);
    expect(useChatStore.getState().isLatestRun(contextId, chatRunId)).toBe(true);
  });

  it('retains the newer generation after Chat finishes before the stale Task finally', () => {
    const contextId = 'agent-generation';
    const planningRunId = 'planning-old';
    const chatRunId = 'chat-new';
    const store = useChatStore.getState();

    expect(store.startSending(contextId, planningRunId)).toBe(true);
    expect(store.startStreaming(contextId, 'Agent', planningRunId)).toBe(true);
    expect(store.finishStreaming(contextId, planningRunId)).toBe(true);
    expect(store.finishSending(contextId, planningRunId)).toBe(true);

    expect(store.startSending(contextId, chatRunId)).toBe(true);
    expect(store.startStreaming(contextId, 'Agent', chatRunId)).toBe(true);
    expect(store.finishStreaming(contextId, chatRunId)).toBe(true);
    expect(store.finishSending(contextId, chatRunId)).toBe(true);

    expect(useChatStore.getState().sendingContexts.has(contextId)).toBe(false);
    expect(useChatStore.getState().isLatestRun(contextId, chatRunId)).toBe(true);
    expect(useChatStore.getState().isLatestRun(contextId, planningRunId)).toBe(false);

    // This models the old Task finally deciding whether it may reset global UI state.
    expect(store.finishStreaming(contextId, planningRunId)).toBe(false);
    expect(store.finishSending(contextId, planningRunId)).toBe(false);
    expect(useChatStore.getState().isLatestRun(contextId, planningRunId)).toBe(false);
  });

  it('preserves legacy unowned lifecycle calls', () => {
    const contextId = 'legacy-agent';
    const controller = new AbortController();
    const store = useChatStore.getState();

    expect(store.startSending(contextId)).toBe(true);
    expect(useChatStore.getState().latestRunIdsByContext.has(contextId)).toBe(false);
    expect(store.startStreaming(contextId, 'Legacy Agent')).toBe(true);
    store.setSessionId(contextId, 'legacy-session');
    store.setAbortController(contextId, controller);
    store.appendStreamingContent(contextId, 'legacy response');

    expect(useChatStore.getState().getStreamingState(contextId)).toMatchObject({
      content: 'legacy response',
      isStreaming: true,
    });
    expect(store.finishStreaming(contextId)).toBe(true);
    expect(store.finishSending(contextId)).toBe(true);

    const current = useChatStore.getState();
    expect(current.sendingContexts.has(contextId)).toBe(false);
    expect(current.getStreamingState(contextId)).toMatchObject({
      content: '',
      isStreaming: false,
    });
    expect(current.sessionIdByContext.has(contextId)).toBe(false);
    expect(current.abortControllers.has(contextId)).toBe(false);
  });
});
