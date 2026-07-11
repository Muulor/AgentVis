import { describe, expect, it } from 'vitest';
import type { SubAgentObservationEvent } from '../../agent-loop/types';
import { upsertSubAgentObservationEvent } from '../SubAgentObservationEvents';

describe('SubAgentObservationEvents', () => {
  it('updates a pending tool observation instead of appending the final status', () => {
    const observations: SubAgentObservationEvent[] = [];

    upsertSubAgentObservationEvent(observations, {
      thinking: 'Generating image.',
      toolAction: {
        toolCallId: 'tool-call-1',
        tool: 'generate_image',
        target: 'A cat prompt',
      },
      step: 1,
      timestamp: 100,
    });

    upsertSubAgentObservationEvent(observations, {
      thinking: '',
      toolAction: {
        toolCallId: 'tool-call-1',
        tool: 'generate_image',
        target: 'A cat prompt',
        success: true,
      },
      step: 1,
      timestamp: 200,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.thinking).toBe('Generating image.');
    expect(observations[0]?.toolAction?.success).toBe(true);
    expect(observations[0]?.timestamp).toBe(200);
  });

  it('keeps separate observations when no stable tool call id exists', () => {
    const observations: SubAgentObservationEvent[] = [];

    upsertSubAgentObservationEvent(observations, {
      thinking: 'First',
      toolAction: {
        tool: 'read',
        target: 'a.txt',
      },
      timestamp: 100,
    });
    upsertSubAgentObservationEvent(observations, {
      thinking: 'Second',
      toolAction: {
        tool: 'read',
        target: 'a.txt',
        success: true,
      },
      timestamp: 200,
    });

    expect(observations).toHaveLength(2);
  });

  it('keeps same tool call ids separate across Sub-Agent runs', () => {
    const observations: SubAgentObservationEvent[] = [];

    upsertSubAgentObservationEvent(observations, {
      runId: 'sa-run-1',
      thinking: 'First run command.',
      toolAction: {
        toolCallId: 'call_exec_1_0',
        tool: 'exec',
        target: 'git ls-remote',
        success: true,
      },
      step: 1,
      timestamp: 100,
    });

    upsertSubAgentObservationEvent(observations, {
      runId: 'sa-run-2',
      thinking: 'Second run command.',
      toolAction: {
        toolCallId: 'call_exec_1_0',
        tool: 'exec',
        target: 'curl.exe --noproxy',
      },
      step: 1,
      timestamp: 200,
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]?.toolAction?.target).toBe('git ls-remote');
    expect(observations[1]?.toolAction?.target).toBe('curl.exe --noproxy');
  });

  it('replaces a transient step status with the real observation', () => {
    const observations: SubAgentObservationEvent[] = [];

    upsertSubAgentObservationEvent(observations, {
      thinking: 'Waiting for model decision (90s elapsed)...',
      transient: true,
      step: 2,
      timestamp: 100,
    });

    upsertSubAgentObservationEvent(observations, {
      thinking: 'Now I have a clear picture. Let me build the complete file.',
      step: 2,
      timestamp: 200,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.thinking).toBe(
      'Now I have a clear picture. Let me build the complete file.'
    );
    expect(observations[0]?.transient).toBeUndefined();
    expect(observations[0]?.timestamp).toBe(200);
  });

  it('replaces a transient step status with a tool observation', () => {
    const observations: SubAgentObservationEvent[] = [];

    upsertSubAgentObservationEvent(observations, {
      thinking: 'Waiting for model decision (90s elapsed)...',
      transient: true,
      step: 3,
      timestamp: 100,
    });

    upsertSubAgentObservationEvent(observations, {
      thinking: 'I will write the file now.',
      toolAction: {
        toolCallId: 'tool-call-2',
        tool: 'file_write',
        target: 'index.html',
      },
      step: 3,
      timestamp: 200,
    });

    upsertSubAgentObservationEvent(observations, {
      thinking: '',
      toolAction: {
        toolCallId: 'tool-call-2',
        tool: 'file_write',
        target: 'index.html',
        success: true,
      },
      step: 3,
      timestamp: 300,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.thinking).toBe('I will write the file now.');
    expect(observations[0]?.toolAction?.success).toBe(true);
    expect(observations[0]?.transient).toBeUndefined();
    expect(observations[0]?.timestamp).toBe(300);
  });
});
