import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { webSearchTool } from '../tool';

const mockInvoke = vi.mocked(invoke);

describe('webSearchTool sandbox mode', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('blocks web search in OfflineIsolated mode before invoking backend network', async () => {
    const result = await webSearchTool.execute(
      { query: 'hermes agent github' },
      { sandboxMode: 'OfflineIsolated' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('hermes agent github');
    expect(result.content).toContain(
      'WEB_SEARCH_ERROR kind=sandbox_blocked retryable=false status=none'
    );
    expect(result.data?.error).toMatchObject({
      kind: 'sandbox_blocked',
      retryable: false,
      status: null,
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('allows web search in ControlledNetwork mode', async () => {
    mockInvoke.mockResolvedValue({
      query: 'hermes agent github',
      answer: null,
      results: [],
      provider: 'ddgs',
      fallback_used: true,
      diagnostics: [],
    });

    const result = await webSearchTool.execute(
      { query: 'hermes agent github' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('WEB_SEARCH_PROVIDER provider=ddgs fallback=true');
    expect(result.content).not.toContain('WEB_SEARCH_ERROR');
    expect(result.data).toMatchObject({
      provider: 'ddgs',
      fallbackUsed: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'web_search',
      expect.objectContaining({
        query: 'hermes agent github',
        sandboxMode: 'ControlledNetwork',
      })
    );
  });

  it('includes provider metadata for successful fallback results', async () => {
    mockInvoke.mockResolvedValue({
      query: 'agent frameworks',
      answer: null,
      provider: 'ddgs',
      fallback_used: true,
      diagnostics: [
        { level: 'info', message: 'Tavily API key is not configured; using DDGS fallback.' },
      ],
      results: [
        {
          title: 'Agent Frameworks',
          url: 'https://example.com/agents',
          content: 'A concise result summary.',
          score: 0.8,
          provider: 'ddgs',
          source: 'bing',
        },
      ],
    });

    const result = await webSearchTool.execute(
      { query: 'agent frameworks' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('WEB_SEARCH_PROVIDER provider=ddgs fallback=true');
    expect(result.content).toContain('### 1. **Agent Frameworks**');
    expect(result.data).toMatchObject({
      provider: 'ddgs',
      fallbackUsed: true,
      diagnostics: [{ level: 'info', message: expect.stringContaining('DDGS fallback') }],
    });
    expect(result.data?.results).toEqual([
      expect.objectContaining({
        title: 'Agent Frameworks',
        url: 'https://example.com/agents',
        provider: 'ddgs',
        source: 'bing',
      }),
    ]);
  });

  it('returns concise retryable metadata for Tavily rate limit failures', async () => {
    mockInvoke.mockRejectedValue(
      'LLM API call failed: Tavily API returned error 429: too many requests'
    );

    const result = await webSearchTool.execute(
      { query: 'latest ai news' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain(
      'WEB_SEARCH_ERROR kind=rate_limited retryable=true status=429'
    );
    expect(result.data?.error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      status: 429,
    });
  });

  it('returns concise retryable metadata for DNS failures', async () => {
    mockInvoke.mockRejectedValue(
      'LLM API call failed: Network broker DNS lookup failed: no such host'
    );

    const result = await webSearchTool.execute(
      { query: 'agent frameworks' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('WEB_SEARCH_ERROR kind=dns_failed retryable=true status=none');
    expect(result.data?.error).toMatchObject({
      kind: 'dns_failed',
      retryable: true,
      status: null,
    });
  });

  it('returns concise retryable metadata for timeout failures', async () => {
    mockInvoke.mockRejectedValue(
      new Error('LLM API call failed: Network broker request failed: operation timed out')
    );

    const result = await webSearchTool.execute(
      { query: 'agent visualization' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('WEB_SEARCH_ERROR kind=timeout retryable=true status=none');
    expect(result.data?.error).toMatchObject({
      kind: 'timeout',
      retryable: true,
      status: null,
    });
  });

  it('returns concise metadata for DDGS runtime failures', async () => {
    mockInvoke.mockRejectedValue(
      'LLM API call failed: DDGS fallback returned error runtime_unavailable: no module named ddgs'
    );

    const result = await webSearchTool.execute(
      { query: 'agent frameworks' },
      { sandboxMode: 'ControlledNetwork' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain(
      'WEB_SEARCH_ERROR kind=runtime_unavailable retryable=false status=none'
    );
    expect(result.data?.error).toMatchObject({
      kind: 'runtime_unavailable',
      retryable: false,
      status: null,
    });
  });
});
