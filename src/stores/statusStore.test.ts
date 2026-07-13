import { beforeEach, describe, expect, it } from 'vitest';

import { useStatusStore } from './statusStore';

describe('statusStore context usage lifecycle', () => {
  beforeEach(() => {
    useStatusStore.setState({
      contextPressureByAgent: {},
      activeTokenContextId: null,
    });
  });

  it('tracks an active call and preserves its final values as Last Context', () => {
    const state = useStatusStore.getState();

    state.beginContextUsage('agent-1', {
      callId: 'call-1',
      contextWindowSize: 128_000,
      currentInputTokens: 1_200,
      purpose: 'chat',
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    state.updateContextUsage('agent-1', 'call-1', {
      currentInputTokens: 1_250,
      currentOutputTokens: 80,
    });

    expect(useStatusStore.getState().getContextPressure('agent-1')).toEqual({
      callId: 'call-1',
      contextWindowSize: 128_000,
      currentInputTokens: 1_250,
      currentOutputTokens: 80,
      phase: 'active',
      purpose: 'chat',
      providerId: 'openai',
      modelId: 'gpt-test',
    });

    state.completeContextUsage('agent-1', 'call-1', { currentOutputTokens: 96 });

    expect(useStatusStore.getState().getContextPressure('agent-1')).toMatchObject({
      callId: 'call-1',
      currentInputTokens: 1_250,
      currentOutputTokens: 96,
      phase: 'last',
    });
  });

  it('ignores stale updates, completions, and clears after a newer call begins', () => {
    const state = useStatusStore.getState();

    state.beginContextUsage('agent-1', {
      callId: 'call-1',
      contextWindowSize: 128_000,
      currentInputTokens: 400,
    });
    state.beginContextUsage('agent-1', {
      callId: 'call-2',
      contextWindowSize: 256_000,
      currentInputTokens: 800,
    });
    state.updateContextUsage('agent-1', 'call-1', { currentInputTokens: 999 });
    state.completeContextUsage('agent-1', 'call-1', { currentOutputTokens: 999 });
    state.clearContextPressure('agent-1', 'call-1');

    expect(useStatusStore.getState().getContextPressure('agent-1')).toEqual({
      callId: 'call-2',
      contextWindowSize: 256_000,
      currentInputTokens: 800,
      currentOutputTokens: 0,
      phase: 'active',
    });
  });

  it('does not update a completed call but allows a matching guarded clear', () => {
    const state = useStatusStore.getState();

    state.beginContextUsage('hub-1', {
      callId: 'call-1',
      contextWindowSize: 64_000,
    });
    state.completeContextUsage('hub-1', 'call-1', { currentOutputTokens: 50 });
    state.updateContextUsage('hub-1', 'call-1', { currentOutputTokens: 100 });

    expect(useStatusStore.getState().getContextPressure('hub-1')).toMatchObject({
      currentOutputTokens: 50,
      phase: 'last',
    });

    state.clearContextPressure('hub-1', 'different-call');
    expect(useStatusStore.getState().getContextPressure('hub-1')).not.toBeNull();

    state.clearContextPressure('hub-1', 'call-1');
    expect(useStatusStore.getState().getContextPressure('hub-1')).toBeNull();
  });
});
