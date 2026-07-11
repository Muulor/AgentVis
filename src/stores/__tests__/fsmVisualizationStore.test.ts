import { describe, expect, it } from 'vitest';
import { useFSMVisualizationStore } from '../fsmVisualizationStore';

describe('fsmVisualizationStore', () => {
  it('updates an existing pending Sub-Agent tool observation by toolCallId', () => {
    const contextId = 'tool-observation-upsert';
    const store = useFSMVisualizationStore.getState();
    store.reset(contextId);

    store.addSubAgentObservation(
      {
        thinking: 'Generating the image now.',
        toolAction: {
          toolCallId: 'tool-call-1',
          tool: 'generate_image',
          target: 'A classroom image prompt',
        },
        step: 1,
        timestamp: 100,
      },
      contextId
    );

    store.addSubAgentObservation(
      {
        thinking: '',
        toolAction: {
          toolCallId: 'tool-call-1',
          tool: 'generate_image',
          target: 'A classroom image prompt',
          success: true,
        },
        step: 1,
        timestamp: 200,
      },
      contextId
    );

    const observations = useFSMVisualizationStore
      .getState()
      .getContextState(contextId).subAgentObservations;

    expect(observations).toHaveLength(1);
    expect(observations[0]?.thinking).toBe('Generating the image now.');
    expect(observations[0]?.toolAction?.success).toBe(true);
    expect(observations[0]?.timestamp).toBe(200);
  });

  it('preserves observations from repeated Sub-Agent runs without cross-run upsert', () => {
    const contextId = 'tool-observation-run-boundary';
    const store = useFSMVisualizationStore.getState();
    store.reset(contextId);

    store.addSubAgentObservation(
      {
        runId: 'sa-run-1',
        thinking: 'First run',
        toolAction: {
          toolCallId: 'call_exec_1_0',
          tool: 'exec',
          target: 'git ls-remote',
          success: true,
        },
        step: 1,
        timestamp: 100,
      },
      contextId
    );

    store.addSubAgentObservation(
      {
        runId: 'sa-run-2',
        thinking: 'Second run',
        toolAction: {
          toolCallId: 'call_exec_1_0',
          tool: 'exec',
          target: 'curl.exe --noproxy',
        },
        step: 1,
        timestamp: 200,
      },
      contextId
    );

    const observations = useFSMVisualizationStore
      .getState()
      .getContextState(contextId).subAgentObservations;

    expect(observations).toHaveLength(2);
    expect(observations[0]?.thinking).toBe('First run');
    expect(observations[0]?.toolAction?.target).toBe('git ls-remote');
    expect(observations[1]?.thinking).toBe('Second run');
    expect(observations[1]?.toolAction?.target).toBe('curl.exe --noproxy');
  });
});
