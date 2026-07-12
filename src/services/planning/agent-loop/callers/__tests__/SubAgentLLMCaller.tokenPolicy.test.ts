/**
 * SubAgentLLMCaller token 策略与参数降级测试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SubAgentLLMCallerFactory } from '../SubAgentLLMCaller';
import type { AccumulatedMessage } from '../../../sub-agents/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../../tools/ToolRegistry', () => ({
  toolRegistry: {
    getSchemas: () => [{ name: 'read', description: 'Read a file', parameters: {} }],
  },
}));

interface InvokeRequest {
  request: {
    messages: Array<{ content: string; images?: Array<{ data: string }> }>;
    tools: unknown;
    maxTokens: number;
  };
  sessionId: string;
}

function getRequest(index: number): InvokeRequest {
  return vi.mocked(invoke).mock.calls[index]?.[1] as unknown as InvokeRequest;
}

function createCaller(tokenPolicy?: 'subAgent' | 'skillAudit') {
  return new SubAgentLLMCallerFactory({
    providerId: 'openai',
    modelId: 'gpt-5.4',
    ...(tokenPolicy && { tokenPolicy }),
  }).create();
}

describe('SubAgentLLMCaller token policy', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('uses 32K for an ordinary sub-agent request', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    const response = await createCaller().callWithContext('system', ['read'], []);

    expect(getRequest(0).request.maxTokens).toBe(32_768);
    expect(response).toMatchObject({ content: 'ok', finishReason: 'stop' });
  });

  it('passes through a max_tokens finish reason without lowering the request budget', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'text',
      content: 'truncated output',
      finishReason: 'max_tokens',
    });

    const response = await createCaller().callWithContext('system', ['read'], []);

    expect(response).toMatchObject({ content: 'truncated output', finishReason: 'max_tokens' });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(getRequest(0).request.maxTokens).toBe(32_768);
  });

  it('retries a thrown max_tokens parameter rejection at 24K and remembers the downgrade', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('400 Bad Request: max_tokens must be <= 24576'))
      .mockResolvedValueOnce({ type: 'text', content: 'fallback ok' })
      .mockResolvedValueOnce({ type: 'text', content: 'next step ok' });

    const caller = createCaller();
    await caller.callWithContext('system', ['read'], []);
    await caller.callWithContext('system', ['read'], []);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((index) => getRequest(index).request.maxTokens)).toEqual([
      32_768, 24_576, 24_576,
    ]);
    expect(getRequest(1).request.messages).toBe(getRequest(0).request.messages);
    expect(getRequest(1).request.tools).toBe(getRequest(0).request.tools);
    expect(getRequest(1).sessionId).toBe(getRequest(0).sessionId);
  });

  it('retries an error response that explicitly rejects max_output_tokens', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        type: 'error',
        error: 'invalid parameter: max_output_tokens exceeds maximum allowed',
      })
      .mockResolvedValueOnce({ type: 'text', content: 'fallback ok' });

    const response = await createCaller().callWithContext('system', ['read'], []);

    expect(response.content).toBe('fallback ok');
    expect([0, 1].map((index) => getRequest(index).request.maxTokens)).toEqual([32_768, 24_576]);
  });

  it.each([
    new Error('400 Bad Request: unrelated invalid payload'),
    new Error('429 Too Many Requests'),
    new Error('500 Internal Server Error'),
    new Error('Sub-agent LLM request cancelled'),
  ])('does not token-fallback for unrelated failures: %s', async (error) => {
    vi.mocked(invoke).mockRejectedValueOnce(error);

    await expect(createCaller().callWithContext('system', ['read'], [])).rejects.toThrow();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(getRequest(0).request.maxTokens).toBe(32_768);
  });

  it('does not attempt a third token budget when the 24K fallback is also rejected', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('400 Bad Request: max_tokens must be <= 24576'))
      .mockRejectedValueOnce(new Error('400 Bad Request: max_tokens must be <= 16384'));

    await expect(createCaller().callWithContext('system', ['read'], [])).rejects.toThrow(
      'max_tokens must be <= 16384'
    );
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect([0, 1].map((index) => getRequest(index).request.maxTokens)).toEqual([32_768, 24_576]);
  });

  it('keeps images intact when a 400 response rejects max_tokens', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be less than or equal to 24576',
      })
      .mockResolvedValueOnce({ type: 'text', content: 'fallback ok' });

    const context: AccumulatedMessage[] = [
      {
        role: 'tool',
        content: 'screenshot',
        toolName: 'read',
        images: [{ mimeType: 'image/png', data: 'base64-image' }],
        timestamp: Date.now(),
      },
    ];
    await createCaller().callWithContext('system', ['read'], context);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(getRequest(0).request.messages[1]?.images?.[0]?.data).toBe('base64-image');
    expect(getRequest(1).request.messages[1]?.images?.[0]?.data).toBe('base64-image');
  });

  it('does not strip images or retry for an unrelated 400 response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'error',
      error: '400 Bad Request: prompt content violates provider policy',
    });

    const context: AccumulatedMessage[] = [
      {
        role: 'tool',
        content: 'screenshot',
        toolName: 'read',
        images: [{ mimeType: 'image/png', data: 'base64-image' }],
        timestamp: Date.now(),
      },
    ];
    const response = await createCaller().callWithContext('system', ['read'], context);

    expect(response.error).toContain('prompt content violates provider policy');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(getRequest(0).request.messages[1]?.images?.[0]?.data).toBe('base64-image');
  });

  it('does not reinterpret a second max-token error as a vision error', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be <= 24576',
      })
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be <= 16384',
      });

    const context: AccumulatedMessage[] = [
      {
        role: 'tool',
        content: 'screenshot',
        toolName: 'read',
        images: [{ mimeType: 'image/png', data: 'base64-image' }],
        timestamp: Date.now(),
      },
    ];
    const response = await createCaller().callWithContext('system', ['read'], context);

    expect(response.error).toContain('max_tokens must be <= 16384');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(getRequest(1).request.messages[1]?.images?.[0]?.data).toBe('base64-image');
  });

  it('keeps skill audit at 24K without a token fallback', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'error',
      error: '400 Bad Request: max_tokens must be <= 16384',
    });

    const response = await createCaller('skillAudit').callWithContext('system', ['read'], []);

    expect(response.error).toContain('max_tokens must be <= 16384');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(getRequest(0).request.maxTokens).toBe(24_576);
  });
});
