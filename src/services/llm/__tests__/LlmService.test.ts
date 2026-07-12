/**
 * LlmService Tauri DTO contract tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { LlmService } from '../LlmService';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('LlmService', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('uses the Rust llm_chat request wrapper and snake-case token field', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      content: 'hello',
      model: 'gpt-5.4',
      input_tokens: 12,
      output_tokens: 3,
    });
    const service = new LlmService({ provider: 'openai', model: 'gpt-5.4' });

    await expect(service.chat([{ role: 'user', content: 'Hi' }])).resolves.toBe('hello');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('llm_chat', {
      request: {
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 1,
        max_tokens: 32_768,
      },
    });
  });

  it('unwraps the DTO content for the simplified stream callbacks', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ content: 'streamed', model: 'gpt-5.4' });
    const service = new LlmService({ provider: 'openai', model: 'gpt-5.4' });
    const onChunk = vi.fn();
    const onComplete = vi.fn();

    await expect(
      service.chatStream(
        [{ role: 'user', content: 'Hi' }],
        { onChunk, onComplete },
        {
          maxTokens: 1234,
        }
      )
    ).resolves.toBe('streamed');

    expect(onChunk).toHaveBeenCalledWith('streamed');
    expect(onComplete).toHaveBeenCalledWith('streamed');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'llm_chat',
      expect.objectContaining({ request: expect.objectContaining({ max_tokens: 1234 }) })
    );
  });
});
