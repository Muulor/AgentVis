import { describe, expect, it } from 'vitest';
import { getPlanningAutoScrollSignal, type PlanningAutoScrollState } from '../planningAutoScroll';

function createState(overrides: Partial<PlanningAutoScrollState> = {}): PlanningAutoScrollState {
  return {
    thinkingSteps: [],
    reasoningTrace: {
      content: '',
      isStreaming: false,
      isCompleted: false,
    },
    subAgentObservations: [],
    currentDecision: null,
    ...overrides,
  };
}

describe('getPlanningAutoScrollSignal', () => {
  it('changes when Master Brain reasoning starts, grows, and completes', () => {
    const idle = getPlanningAutoScrollSignal(createState());
    const started = getPlanningAutoScrollSignal(
      createState({
        reasoningTrace: { content: '', isStreaming: true, isCompleted: false },
      })
    );
    const firstChunk = getPlanningAutoScrollSignal(
      createState({
        reasoningTrace: { content: 'Thinking', isStreaming: true, isCompleted: false },
      })
    );
    const nextChunk = getPlanningAutoScrollSignal(
      createState({
        reasoningTrace: {
          content: 'Thinking about the request',
          isStreaming: true,
          isCompleted: false,
        },
      })
    );
    const completed = getPlanningAutoScrollSignal(
      createState({
        reasoningTrace: {
          content: 'Thinking about the request',
          isStreaming: false,
          isCompleted: true,
        },
      })
    );

    expect(new Set([idle, started, firstChunk, nextChunk, completed])).toHaveLength(5);
  });

  it('retains signals for structured thinking, observations, and the final decision', () => {
    const idle = getPlanningAutoScrollSignal(createState());
    const thinking = getPlanningAutoScrollSignal(
      createState({
        thinkingSteps: [{ analyzing: 'Analyze', planning: '', decided: '' }],
      })
    );
    const observation = getPlanningAutoScrollSignal(
      createState({ subAgentObservations: [{ thinking: 'Inspect', timestamp: 1 }] })
    );
    const decision = getPlanningAutoScrollSignal(createState({ currentDecision: {} }));

    expect(thinking).not.toBe(idle);
    expect(observation).not.toBe(idle);
    expect(decision).not.toBe(idle);
  });

  it('changes while Sub-Agent reasoning grows in the same observation slot', () => {
    const started = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [
          {
            thinking: '',
            reasoningTrace: { content: 'Thinking', isStreaming: true, completed: false },
            timestamp: 1,
          },
        ],
      })
    );
    const nextChunk = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [
          {
            thinking: '',
            reasoningTrace: {
              content: 'Thinking about the next tool call',
              isStreaming: true,
              completed: false,
            },
            timestamp: 2,
          },
        ],
      })
    );
    const completed = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [
          {
            thinking: '',
            reasoningTrace: {
              content: 'Thinking about the next tool call',
              isStreaming: false,
              completed: true,
            },
            timestamp: 3,
          },
        ],
      })
    );

    expect(new Set([started, nextChunk, completed])).toHaveLength(3);
  });

  it('changes when a Sub-Agent observation is replaced without growing the array', () => {
    const transient = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [
          { thinking: 'Waiting for the model', transient: true, timestamp: 1 },
        ],
      })
    );
    const pendingTool = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [{ thinking: 'Inspect the file', toolAction: {}, timestamp: 2 }],
      })
    );
    const completedTool = getPlanningAutoScrollSignal(
      createState({
        subAgentObservations: [
          { thinking: 'Inspect the file', toolAction: { success: true }, timestamp: 3 },
        ],
      })
    );

    expect(new Set([transient, pendingTool, completedTool])).toHaveLength(3);
  });
});
