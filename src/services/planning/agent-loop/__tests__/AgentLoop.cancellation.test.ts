/**
 * Regression coverage for AgentLoop frontend LLM cancellation ownership.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentLoop } from '../AgentLoop';
import type { AgentSession } from '../AgentSession';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createLoop(): AgentLoop {
  const session = {
    id: 'cancel-test-session',
    getMessages: vi.fn().mockReturnValue([]),
    addMessage: vi.fn(),
    getModelId: vi.fn().mockReturnValue('test-model'),
    getLastPreparedContext: vi.fn().mockReturnValue(null),
    getToolOutputBudget: vi.fn().mockReturnValue(null),
  } as unknown as AgentSession;
  const loop = new AgentLoop(
    {
      agentId: 'cancel-test-agent',
      providerId: 'openrouter',
      modelId: 'moonshotai/kimi-k3',
    },
    session
  );
  (loop as unknown as { currentSessionId: string }).currentSessionId = 'planning-cancel-test';
  return loop;
}

function collectStream(loop: AgentLoop): Promise<string> {
  return (
    loop as unknown as {
      collectMBStreamResponse: (
        messages: Array<{ role: string; content: string }>,
        onStreamDelta: (content: string) => void,
        transportMaxTokens: number,
        finalDecisionMaxTokens: number
      ) => Promise<string>;
    }
  ).collectMBStreamResponse([{ role: 'user', content: 'hello' }], vi.fn(), 1024, 1024);
}

function createNonStreamLlmService(loop: AgentLoop): {
  generate: (prompt: string) => Promise<string>;
} {
  return (
    loop as unknown as {
      createLLMService: () => { generate: (prompt: string) => Promise<string> };
    }
  ).createLLMService();
}

describe('AgentLoop frontend LLM cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation((async (command: string) => {
      if (command === 'llm_cancel_stream') return undefined;
      if (command === 'llm_chat_stream' || command === 'llm_chat_with_tools') {
        return new Promise<never>(() => undefined);
      }
      return undefined;
    }) as unknown as typeof invoke);
  });

  it('settles locally when cancelled before listener registration begins', async () => {
    const loop = createLoop();
    loop.cancel();

    await expect(collectStream(loop)).rejects.toMatchObject({ name: 'AbortError' });

    expect(listen).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('llm_chat_stream', expect.anything());
  });

  it('cleans a deferred listener and does not start the stream when cancelled during registration', async () => {
    const listener = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockReturnValue(listener.promise);
    const loop = createLoop();

    const result = collectStream(loop);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    loop.cancel();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    listener.resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalledWith('llm_chat_stream', expect.anything());
  });

  it('settles and removes the listener even when the backend invoke never returns an event', async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    const loop = createLoop();

    const result = collectStream(loop);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'llm_chat_stream',
        expect.objectContaining({ sessionId: 'planning-cancel-test' })
      )
    );
    loop.cancel();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('llm_cancel_stream', {
      sessionId: 'planning-cancel-test',
    });
  });

  it('does not start a non-stream LLM invoke after the run was already cancelled', async () => {
    const loop = createLoop();
    const llmService = createNonStreamLlmService(loop);
    loop.cancel();

    await expect(llmService.generate('system prompt')).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(invoke).not.toHaveBeenCalledWith('llm_chat_with_tools', expect.anything());
  });

  it('settles a pending non-stream LLM invoke locally when cancelled', async () => {
    const loop = createLoop();
    const llmService = createNonStreamLlmService(loop);

    const result = llmService.generate('system prompt');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'llm_chat_with_tools',
        expect.objectContaining({ sessionId: 'planning-cancel-test' })
      )
    );
    loop.cancel();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
