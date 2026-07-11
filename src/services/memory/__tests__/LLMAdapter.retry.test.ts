import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMAdapter } from '../LLMAdapter';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const installImmediateRetryTimers = (): ReturnType<typeof vi.spyOn> => {
  const retryDelaysMs = new Set([1000, 3000, 8000]);
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  setTimeoutSpy.mockImplementation(
    (
      handler: Parameters<typeof setTimeout>[0],
      timeout?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      if (
        typeof timeout === 'number' &&
        retryDelaysMs.has(timeout) &&
        typeof handler === 'function'
      ) {
        queueMicrotask(() => handler(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }
  );
  return setTimeoutSpy;
};

const createAdapter = (): LLMAdapter =>
  new LLMAdapter({
    provider: 'test-provider',
    model: 'test-model',
  });

describe('LLMAdapter retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient memory LLM errors before returning generated content', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error('API returned an error (524 <unknown status code>): error code: 524')
      )
      .mockResolvedValueOnce({ content: 'summary ok' });

    await expect(createAdapter().generate('summarize this')).resolves.toBe('summary ok');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('does not retry deterministic request errors', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error('API returned an error (413 Payload Too Large): context_length_exceeded')
    );

    await expect(createAdapter().generate('too large')).rejects.toThrow('413');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 3000);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 8000);
  });

  it('applies the same retry policy to generateWithSystem', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('Request failed: DNS error ENOTFOUND api.example.com'))
      .mockResolvedValueOnce({ content: 'fact ok' });

    await expect(createAdapter().generateWithSystem('system', 'extract fact')).resolves.toBe(
      'fact ok'
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('keeps the existing lightweight empty-response retry separate from API retries', async () => {
    const setTimeoutSpy = installImmediateRetryTimers();
    vi.mocked(invoke)
      .mockResolvedValueOnce({ content: '   ' })
      .mockResolvedValueOnce({ content: 'summary after empty retry' });

    await expect(createAdapter().generate('summarize empty first')).resolves.toBe(
      'summary after empty retry'
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 3000);
  });
});
