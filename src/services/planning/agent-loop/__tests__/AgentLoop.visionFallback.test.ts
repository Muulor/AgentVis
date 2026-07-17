import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentLoop } from '../AgentLoop';
import type { AgentSession } from '../AgentSession';
import { translate } from '@/i18n';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import { useStatusStore } from '@stores/statusStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

function createSession(messages: unknown[]): AgentSession {
  return {
    id: 'test-session',
    getMessages: vi.fn().mockReturnValue(messages),
    addMessage: vi.fn(),
    getModelId: vi.fn().mockReturnValue('test-model'),
    getLastPreparedContext: vi.fn().mockReturnValue(null),
    getToolOutputBudget: vi.fn().mockReturnValue(null),
  } as unknown as AgentSession;
}

function extractImageData(messages: Array<{ images?: Array<{ data?: string }> }>): string[] {
  return messages.flatMap((message) => message.images?.map((image) => image.data ?? '') ?? []);
}

interface StreamPayload {
  sessionId: string;
  delta: string;
  reasoning?: string;
  done: boolean;
  finishReason?: string;
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

type StreamHandler = (event: { payload: StreamPayload }) => void;

function installSequentialStreamResponses(
  streamResponses: Array<Array<Omit<StreamPayload, 'sessionId'>>>
): void {
  let activeHandler: StreamHandler | undefined;

  vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
    activeHandler = handler;
    return Promise.resolve(vi.fn());
  }) as unknown as typeof listen);

  vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
    if (command === 'llm_cancel_stream') {
      return undefined;
    }
    if (command !== 'llm_chat_stream') {
      return {
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      };
    }

    const { sessionId } = args as { sessionId: string };
    const payloads = streamResponses.shift();
    queueMicrotask(() => {
      const handler = activeHandler;
      if (!handler || !payloads) return;
      for (const payload of payloads) {
        handler({
          payload: {
            sessionId,
            ...payload,
          },
        });
      }
    });
    return undefined;
  }) as unknown as typeof invoke);
}

function installRejectedStreamThenResponse(
  rejection: Error,
  response: Array<Omit<StreamPayload, 'sessionId'>>
): void {
  let activeHandler: StreamHandler | undefined;
  let streamInvocationCount = 0;

  vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
    activeHandler = handler;
    return Promise.resolve(vi.fn());
  }) as unknown as typeof listen);

  vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
    if (command === 'llm_cancel_stream') return undefined;
    if (command !== 'llm_chat_stream') {
      return {
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      };
    }

    streamInvocationCount++;
    if (streamInvocationCount === 1) {
      throw rejection;
    }

    const { sessionId } = args as { sessionId: string };
    queueMicrotask(() => {
      const handler = activeHandler;
      if (!handler) return;
      for (const payload of response) {
        handler({ payload: { sessionId, ...payload } });
      }
    });
    return undefined;
  }) as unknown as typeof invoke);
}

function createHighNoveltyAscii(length: number, seed = 0x5f3759df): string {
  let state = seed >>> 0;
  const characters = new Array<string>(length);
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    characters[index] = String.fromCharCode(33 + (state % 90));
  }
  return characters.join('');
}

function createNearDuplicate(content: string, index: number): string {
  const replacementIndex = 97 + index * 37;
  const replacement = content.charAt(replacementIndex) === '!' ? '"' : '!';
  return content.slice(0, replacementIndex) + replacement + content.slice(replacementIndex + 1);
}

describe('AgentLoop MB vision fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue({
      type: 'text',
      content: '{"decision":"RESPOND_TO_USER"}',
    });
  });

  it('strips images before MB call for models marked as non-vision', async () => {
    const session = createSession([
      {
        role: 'user',
        content: 'history image task',
        images: [{ mime_type: 'image/jpeg', data: 'history-image' }],
      },
      { role: 'user', content: 'current task' },
    ]);
    const loop = new AgentLoop(
      {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        imageAttachments: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
      session
    );
    (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();
    await llmService.generate('system prompt');

    const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: unknown }> };
    };
    expect(request.request.messages.some((message) => message.images)).toBe(false);
  });

  it('wraps historical user image messages with a strong history guard for MB calls', async () => {
    const session = createSession([
      {
        role: 'user',
        content: 'old screenshot bug',
        createdAt: new Date(2026, 0, 2, 3, 4).getTime(),
        images: [{ mime_type: 'image/jpeg', data: 'history-image' }],
      },
      { role: 'user', content: 'new bug without screenshot' },
    ]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
      },
      session
    );
    (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();
    await llmService.generate('system prompt');

    const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ content: string; images?: Array<{ data?: string }> }> };
    };
    const historicalImageMessage = request.request.messages.find((message) =>
      message.images?.some((image) => image.data === 'history-image')
    );

    expect(historicalImageMessage?.content).toBe(
      translate('planning.masterBrain.historicalUserImageMessage', {
        timestamp: '2026-01-02 03:04',
        imageCount: 1,
        content: 'old screenshot bug',
      })
    );
    expect(
      request.request.messages.some((message) => message.content === 'new bug without screenshot')
    ).toBe(true);
  });

  it('retries MB once without images when provider rejects image input', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(404 Not Found): {"error":{"message":"No endpoints found that support image input"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      });

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
        imageAttachments: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
      session
    );

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();
    await llmService.generate('system prompt');

    const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: unknown }> };
    };
    const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
      request: { messages: Array<{ images?: unknown }> };
    };

    expect(firstRequest.request.messages.some((message) => message.images)).toBe(true);
    expect(secondRequest.request.messages.some((message) => message.images)).toBe(false);
  });

  it('retries MB once without images for local relay failed-to-read image requests', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      });

    const session = createSession([{ role: 'user', content: 'current image task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
        imageAttachments: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
      session
    );

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();
    await llmService.generate('system prompt');

    const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
      request: { messages: Array<{ images?: unknown }> };
    };
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(secondRequest.request.messages.some((message) => message.images)).toBe(false);
  });

  it('preserves current-turn images when retrying after historical image payload failure', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      });

    const session = createSession([
      {
        role: 'user',
        content: 'historical generated image',
        images: [{ mime_type: 'image/png', data: 'history-image' }],
      },
      { role: 'user', content: 'what does this current screenshot mean?' },
    ]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
        imageAttachments: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
      session
    );
    (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();
    await llmService.generate('system prompt');

    const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };
    const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(extractImageData(firstRequest.request.messages)).toEqual(
      expect.arrayContaining(['history-image', 'current-image'])
    );
    expect(extractImageData(secondRequest.request.messages)).toContain('current-image');
    expect(extractImageData(secondRequest.request.messages)).not.toContain('history-image');
  });

  it('reuses the successful partial image fallback on later MB calls', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"SPAWN_SUB_AGENT"}',
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
      });

    const session = createSession([
      {
        role: 'user',
        content: 'historical generated image',
        images: [{ mime_type: 'image/png', data: 'history-image' }],
      },
      {
        role: 'user',
        content: 'what does this current screenshot mean?',
        images: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
    ]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
      },
      session
    );
    (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    await llmService.generate('system prompt');
    await llmService.generate('system prompt');

    const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };
    const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };
    const thirdRequest = vi.mocked(invoke).mock.calls[2]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
    expect(extractImageData(firstRequest.request.messages)).toEqual(
      expect.arrayContaining(['history-image', 'current-image'])
    );
    expect(extractImageData(secondRequest.request.messages)).toContain('current-image');
    expect(extractImageData(secondRequest.request.messages)).not.toContain('history-image');
    expect(extractImageData(thirdRequest.request.messages)).toContain('current-image');
    expect(extractImageData(thirdRequest.request.messages)).not.toContain('history-image');
  });

  it('reuses current-turn images for parser correction retries without leaking them to the next decision', async () => {
    const session = createSession([{ role: 'user', content: 'inspect this screenshot' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
        imageAttachments: [{ mime_type: 'image/jpeg', data: 'current-image' }],
      },
      session
    );
    const saveAndPassImagesToSA = vi
      .spyOn(
        loop as unknown as {
          saveAndPassImagesToSA: (
            images: Array<{ mimeType: string; data: string }>
          ) => Promise<void>;
        },
        'saveAndPassImagesToSA'
      )
      .mockResolvedValue(undefined);
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              mbDecisionCorrection?: {
                reason: 'schema_invalid';
                detail?: string;
              };
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await llmService.generate('system prompt');
    await llmService.generate('system prompt', {
      mbDecisionCorrection: {
        reason: 'schema_invalid',
        detail: 'nextStep.task is required',
      },
    });
    await llmService.generate('system prompt');

    const llmCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_with_tools');
    const requests = llmCalls.map(
      ([, args]) =>
        args as {
          request: {
            messages: Array<{ content: string; images?: Array<{ data?: string }> }>;
          };
        }
    );
    const schemaRetryInstructionPrefix = translate('chat.mbSchemaInvalidDecisionRetryInstruction', {
      reason: '__reason__',
    }).split('__reason__')[0];

    expect(llmCalls).toHaveLength(3);
    expect(extractImageData(requests[0]!.request.messages)).toContain('current-image');
    expect(extractImageData(requests[1]!.request.messages)).toContain('current-image');
    expect(extractImageData(requests[2]!.request.messages)).not.toContain('current-image');
    expect(requests[1]!.request.messages.at(-1)?.content).toContain(schemaRetryInstructionPrefix);
    expect(requests[1]!.request.messages.at(-1)?.content).toContain('nextStep.response');
    expect(saveAndPassImagesToSA).toHaveBeenCalledTimes(1);
  });

  it('retries MB stream once when the final decision delta is empty', async () => {
    const streamResponses: Array<Array<Omit<StreamPayload, 'sessionId'>>> = [
      [
        {
          delta: '',
          reasoning: 'thinking without final JSON',
          done: true,
          error: null,
        },
      ],
      [
        {
          delta:
            '```json\n' +
            '{"decision":"RESPOND_TO_USER","rationale":"done","riskAssessment":{"level":"low","notes":"ok"},"response":"done"}' +
            '\n```',
          done: true,
          error: null,
        },
      ],
    ];
    let activeHandler: StreamHandler | undefined;

    vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
      activeHandler = handler;
      return Promise.resolve(vi.fn());
    }) as unknown as typeof listen);

    vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
      if (command !== 'llm_chat_stream') {
        return {
          type: 'text',
          content: '{"decision":"RESPOND_TO_USER"}',
        };
      }

      const { sessionId } = args as { sessionId: string };
      const payloads = streamResponses.shift();
      queueMicrotask(() => {
        const handler = activeHandler;
        if (!handler || !payloads) return;
        for (const payload of payloads) {
          handler({
            payload: {
              sessionId,
              ...payload,
            },
          });
        }
      });
      return undefined;
    }) as unknown as typeof invoke);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'gemini',
        modelId: 'gemini-thinking',
      },
      session
    );

    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              onStreamDelta?: (content: string) => void;
              onStreamAttemptStart?: () => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();
    const onStreamAttemptStart = vi.fn();
    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
      onStreamAttemptStart,
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const secondRequest = streamCalls[1]?.[1] as {
      request: { messages: Array<{ content: string }> };
    };

    expect(streamCalls).toHaveLength(2);
    expect(onStreamAttemptStart).toHaveBeenCalledTimes(2);
    expect(result).toContain('"decision":"RESPOND_TO_USER"');
    expect(secondRequest.request.messages.at(-1)?.content).toBe(
      translate('chat.mbEmptyDecisionRetryInstruction')
    );
  });

  it('cancels and retries when one MB chunk contains an XML tool-call envelope before valid JSON', async () => {
    installSequentialStreamResponses([
      [
        {
          delta:
            '<function=web_search>\n<parameter=query>strands-agents</parameter>\n</function>\n' +
            '{"decision":"RESPOND_TO_USER","rationale":"premature","riskAssessment":{"level":"low","notes":"ok"},"response":"premature"}',
          done: false,
          error: null,
        },
        {
          delta: '',
          done: true,
          error: null,
        },
      ],
      [
        {
          delta:
            '{"decision":"SPAWN_SUB_AGENT","rationale":"delegate","riskAssessment":{"level":"low","notes":"ok"},"nextStep":{"task":"Research strands-agents"}}',
          done: true,
          error: null,
        },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'generic-compatible-model',
      },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const secondRequest = streamCalls[1]?.[1] as {
      request: { messages: Array<{ content: string }> };
    };

    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(1);
    expect(result).toContain('"decision":"SPAWN_SUB_AGENT"');
    expect(secondRequest.request.messages.at(-1)?.content).toContain('SPAWN_SUB_AGENT');
    expect(secondRequest.request.messages.at(-1)?.content).not.toContain('<function=web_search>');
  });

  it('keeps exact-loop detection active after a whitespace final delta', async () => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installSequentialStreamResponses([
      [
        { delta: ' \n', done: false, error: null },
        {
          delta: '',
          reasoning: createHighNoveltyAscii(300).repeat(4),
          done: false,
          error: null,
        },
        { delta: '', done: true, error: null },
      ],
      [{ delta: validResponse, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              maxTokens?: number;
              onStreamDelta?: (content: string) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const requests = streamCalls.map(
      ([, args]) =>
        args as {
          request: { max_tokens: number; messages: Array<{ content: string }> };
        }
    );
    const firstStreamInvocation = streamCalls[0]?.[1] as { attemptId: string };
    const guardCancelInvocation = cancelCalls[0]?.[1] as { attemptId: string };

    expect(result).toBe(validResponse);
    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(1);
    expect(guardCancelInvocation.attemptId).toBe(firstStreamInvocation.attemptId);
    expect(requests.map(({ request }) => request.max_tokens)).toEqual([
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
    ]);
    expect(requests[1]?.request.messages.at(-1)?.content).toBe(
      translate('chat.mbReasoningDecisionRetryInstruction')
    );
  });

  it('cancels an exact reasoning loop and consumes one shared semantic retry', async () => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installSequentialStreamResponses([
      [
        {
          delta: '',
          reasoning: 'This reasoning block repeats without making any progress at all.\n'.repeat(
            20
          ),
          done: false,
          error: null,
        },
        { delta: '', done: true, error: null },
      ],
      [{ delta: validResponse, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const secondRequest = streamCalls[1]?.[1] as {
      request: { messages: Array<{ content: string }> };
    };

    expect(result).toBe(validResponse);
    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(1);
    expect(secondRequest.request.messages.at(-1)?.content).toBe(
      translate('chat.mbReasoningDecisionRetryInstruction')
    );
  });

  it('cancels an approximate reasoning loop and consumes one shared semantic retry', async () => {
    vi.useFakeTimers();
    try {
      const validResponse =
        '{"decision":"RESPOND_TO_USER","rationale":"done",' +
        '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
      const baseReasoning = createHighNoveltyAscii(2048);
      const reasoningVariants = [
        baseReasoning,
        createNearDuplicate(baseReasoning, 0),
        createNearDuplicate(baseReasoning, 1),
        createNearDuplicate(baseReasoning, 2),
      ];
      let activeHandler: StreamHandler | undefined;
      let streamIndex = 0;

      vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
        activeHandler = handler;
        return Promise.resolve(vi.fn());
      }) as unknown as typeof listen);

      vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
        if (command === 'llm_cancel_stream') return undefined;
        if (command !== 'llm_chat_stream') {
          return {
            type: 'text',
            content: '{"decision":"RESPOND_TO_USER"}',
          };
        }

        const { sessionId } = args as { sessionId: string };
        const currentStreamIndex = streamIndex++;
        if (currentStreamIndex === 0) {
          reasoningVariants.forEach((reasoning, index) => {
            const delayMs =
              index === 0
                ? 0
                : PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_SOFT_DURATION_MS + index * 1024;
            setTimeout(() => {
              activeHandler?.({
                payload: {
                  sessionId,
                  delta: '',
                  reasoning,
                  done: false,
                  error: null,
                },
              });
              if (index === reasoningVariants.length - 1) {
                activeHandler?.({
                  payload: {
                    sessionId,
                    delta: '',
                    done: true,
                    error: null,
                  },
                });
              }
            }, delayMs);
          });
        } else {
          queueMicrotask(() =>
            activeHandler?.({
              payload: {
                sessionId,
                delta: validResponse,
                done: true,
                finishReason: 'stop',
                error: null,
              },
            })
          );
        }
        return undefined;
      }) as unknown as typeof invoke);

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop(
        { providerId: 'local', modelId: 'generic-reasoning-model' },
        session
      );
      const llmService = (
        loop as unknown as {
          createLLMService: () => {
            generate: (
              prompt: string,
              options?: { onStreamDelta?: (content: string) => void }
            ) => Promise<string>;
          };
        }
      ).createLLMService();

      const resultPromise = llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(
        PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_SOFT_DURATION_MS + 5000
      );
      const result = await resultPromise;

      const streamCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_chat_stream');
      const cancelCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
      const secondRequest = streamCalls[1]?.[1] as {
        request: { messages: Array<{ content: string }> };
      };

      expect(result).toBe(validResponse);
      expect(streamCalls).toHaveLength(2);
      expect(cancelCalls).toHaveLength(1);
      expect(secondRequest.request.messages.at(-1)?.content).toBe(
        translate('chat.mbReasoningDecisionRetryInstruction')
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after the shared semantic retry when the exact loop repeats', async () => {
    const exactLoop = createHighNoveltyAscii(300).repeat(4);
    installSequentialStreamResponses([
      [
        { delta: '', reasoning: exactLoop, done: false, error: null },
        { delta: '', done: true, error: null },
      ],
      [
        { delta: '', reasoning: exactLoop, done: false, error: null },
        { delta: '', done: true, error: null },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow(translate('chat.mbAnomalousDecisionRetryFailed'));

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');

    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(2);
  });

  it('allows high-novelty reasoning past the soft threshold and keeps a bounded live preview', async () => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    const previewLimit =
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_HEAD_CHARS +
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_TAIL_CHARS;
    const reasoning = createHighNoveltyAscii(previewLimit + 512);
    installSequentialStreamResponses([
      [
        { delta: '', reasoning, done: false, error: null },
        { delta: validResponse, done: true, finishReason: 'stop', error: null },
      ],
    ]);

    const reasoningTraceContents: string[] = [];
    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              onStreamDelta?: (content: string) => void;
              onReasoningTrace?: (event: { type: string; content?: string }) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
      onReasoningTrace: (event) => {
        if (event.content) reasoningTraceContents.push(event.content);
      },
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const finalPreview = reasoningTraceContents.at(-1) ?? '';
    const omittedChars = reasoning.length - previewLimit;

    expect(result).toBe(validResponse);
    expect(streamCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(0);
    expect(finalPreview).toContain(
      reasoning.slice(0, PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_HEAD_CHARS)
    );
    expect(finalPreview).toContain(
      reasoning.slice(-PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_PREVIEW_TAIL_CHARS)
    );
    expect(finalPreview).toContain(
      translate('chat.mbReasoningTraceOmitted', {
        count: omittedChars.toLocaleString(),
      })
    );
  });

  it('cancels at the reasoning token hard fuse without an automatic retry', async () => {
    const hardFuseReasoning = createHighNoveltyAscii(
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_TOKENS * 4
    );
    installSequentialStreamResponses([
      [
        { delta: '', reasoning: hardFuseReasoning, done: false, error: null },
        { delta: '', done: true, error: null },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow(translate('chat.mbReasoningHardLimitFailed'));

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const streamInvocation = streamCalls[0]?.[1] as { attemptId: string };
    const cancelInvocation = cancelCalls[0]?.[1] as { attemptId: string };

    expect(streamCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelInvocation.attemptId).toBe(streamInvocation.attemptId);
  });

  it('cancels at the reasoning time hard fuse without an automatic retry', async () => {
    vi.useFakeTimers();
    try {
      installSequentialStreamResponses([
        [
          {
            delta: '',
            reasoning: 'Still considering the decision without finishing.',
            done: false,
            error: null,
          },
        ],
      ]);

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop(
        { providerId: 'local', modelId: 'generic-reasoning-model' },
        session
      );
      const llmService = (
        loop as unknown as {
          createLLMService: () => {
            generate: (
              prompt: string,
              options?: { onStreamDelta?: (content: string) => void }
            ) => Promise<string>;
          };
        }
      ).createLLMService();

      const resultPromise = llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      });
      const rejection = expect(resultPromise).rejects.toThrow(
        translate('chat.mbReasoningHardLimitFailed')
      );
      await vi.advanceTimersByTimeAsync(
        PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_DURATION_MS + 1000
      );
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;

      const streamCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_chat_stream');
      const cancelCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
      const streamInvocation = streamCalls[0]?.[1] as { attemptId: string };
      const cancelInvocation = cancelCalls[0]?.[1] as { attemptId: string };

      expect(streamCalls).toHaveLength(1);
      expect(cancelCalls).toHaveLength(1);
      expect(cancelInvocation.attemptId).toBe(streamInvocation.attemptId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel bounded reasoning followed by a valid final decision', async () => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installSequentialStreamResponses([
      [
        {
          delta: '',
          reasoning: 'Check the evidence, then return one concise decision object.',
          done: false,
          error: null,
        },
        { delta: validResponse, done: true, finishReason: 'stop', error: null },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-reasoning-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');

    expect(result).toBe(validResponse);
    expect(streamCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(0);
  });

  it('does not cancel valid JSON when rationale mentions function syntax before decision', async () => {
    const validResponse =
      '{"rationale":"Explain the literal <function=web_search> syntax",' +
      '"decision":"RESPOND_TO_USER","riskAssessment":{"level":"low","notes":"ok"},' +
      '"response":"done"}';
    installSequentialStreamResponses([
      [
        {
          delta: validResponse,
          done: true,
          finishReason: 'stop',
          error: null,
        },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'generic-compatible-model',
      },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');

    expect(streamCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(0);
    expect(result).toBe(validResponse);
  });

  it.each([
    { label: 'official DeepSeek V4', providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    { label: 'Volcengine DeepSeek V4', providerId: 'volcengine', modelId: 'deepseek-v4-flash' },
    { label: 'Xiaomi MiMo V2.5', providerId: 'xiaomi-mimo', modelId: 'mimo-v2.5' },
    { label: 'Volcengine GLM-5.2', providerId: 'volcengine', modelId: 'glm-5.2' },
    { label: 'OpenAI GPT-5', providerId: 'openai', modelId: 'gpt-5.4' },
    { label: 'Anthropic Claude', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    { label: 'Gemini 3', providerId: 'gemini', modelId: 'gemini-3.5-flash' },
  ])(
    'uses the expanded reasoning transport budget for $label MB streams',
    async ({ providerId, modelId }) => {
      const validResponse =
        '{"decision":"RESPOND_TO_USER","rationale":"done",' +
        '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
      installSequentialStreamResponses([
        [{ delta: validResponse, done: true, finishReason: 'stop', error: null }],
      ]);

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop({ providerId, modelId }, session);
      const llmService = (
        loop as unknown as {
          createLLMService: () => {
            generate: (
              prompt: string,
              options?: {
                maxTokens?: number;
                onStreamDelta?: (content: string) => void;
              }
            ) => Promise<string>;
          };
        }
      ).createLLMService();

      const result = await llmService.generate('system prompt', {
        maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
        onStreamDelta: vi.fn(),
      });

      const streamCall = vi
        .mocked(invoke)
        .mock.calls.find(([command]) => command === 'llm_chat_stream');
      const invocation = streamCall?.[1] as { request: { max_tokens: number } };

      expect(result).toBe(validResponse);
      expect(invocation.request.max_tokens).toBe(
        PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS
      );
    }
  );

  it.each([
    {
      label: 'a non-reasoning Volcengine model',
      providerId: 'volcengine',
      modelId: 'doubao-seed-2.0-pro',
    },
    { label: 'an unknown local route', providerId: 'local', modelId: 'gemini-3.5-flash' },
  ])('uses the default 16K transport budget for $label', async ({ providerId, modelId }) => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installSequentialStreamResponses([
      [{ delta: validResponse, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop({ providerId, modelId }, session);
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              maxTokens?: number;
              onStreamDelta?: (content: string) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
      onStreamDelta: vi.fn(),
    });

    const streamCall = vi
      .mocked(invoke)
      .mock.calls.find(([command]) => command === 'llm_chat_stream');
    const invocation = streamCall?.[1] as { request: { max_tokens: number } };

    expect(result).toBe(validResponse);
    expect(invocation.request.max_tokens).toBe(
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS
    );
  });

  it.each([
    {
      label: 'a known reasoning model from 32K to 16K',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      rejectedMaxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS,
      fallbackMaxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
    },
    {
      label: 'an unknown model from 16K to 8K',
      providerId: 'local',
      modelId: 'generic-compatible-model',
      rejectedMaxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
      fallbackMaxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
    },
  ])(
    'downgrades $label after a max-token parameter rejection',
    async ({ providerId, modelId, rejectedMaxTokens, fallbackMaxTokens }) => {
      const validResponse =
        '{"decision":"RESPOND_TO_USER","rationale":"done",' +
        '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
      installRejectedStreamThenResponse(
        new Error(`400 Bad Request: max_tokens must be less than or equal to ${fallbackMaxTokens}`),
        [{ delta: validResponse, done: true, finishReason: 'stop', error: null }]
      );

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop({ providerId, modelId }, session);
      const llmService = (
        loop as unknown as {
          createLLMService: () => {
            generate: (
              prompt: string,
              options?: {
                maxTokens?: number;
                onStreamDelta?: (content: string) => void;
              }
            ) => Promise<string>;
          };
        }
      ).createLLMService();

      const result = await llmService.generate('system prompt', {
        maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
        onStreamDelta: vi.fn(),
      });

      const streamCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_chat_stream');
      const requests = streamCalls.map(
        ([, args]) =>
          (
            args as {
              request: { max_tokens: number; messages: Array<{ content: string }> };
            }
          ).request
      );

      expect(result).toBe(validResponse);
      expect(requests.map((request) => request.max_tokens)).toEqual([
        rejectedMaxTokens,
        fallbackMaxTokens,
      ]);
      expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    }
  );

  it('does not downgrade transport for unrelated 400 responses', async () => {
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installRejectedStreamThenResponse(
      new Error('400 Bad Request: prompt content violates provider policy'),
      [{ delta: validResponse, done: true, finishReason: 'stop', error: null }]
    );

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow('prompt content violates provider policy');

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    expect(streamCalls).toHaveLength(1);
  });

  it('classifies reasoning-only transport truncation and reports its dedicated retry failure', async () => {
    installSequentialStreamResponses([
      [
        {
          delta: '',
          reasoning: 'The first attempt spends its output budget on internal reasoning.',
          done: true,
          finishReason: 'length',
          error: null,
        },
      ],
      [
        {
          delta: '',
          reasoning: 'The retry also spends its output budget before emitting a decision.',
          done: true,
          finishReason: 'length',
          error: null,
        },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop({ providerId: 'xiaomi-mimo', modelId: 'mimo-v2.5' }, session);
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              maxTokens?: number;
              onStreamDelta?: (content: string) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow(translate('chat.mbReasoningTransportRetryFailed'));

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const secondRequest = streamCalls[1]?.[1] as {
      request: { max_tokens: number; messages: Array<{ content: string }> };
    };

    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(0);
    expect(
      streamCalls.map(
        ([, args]) => (args as { request: { max_tokens: number } }).request.max_tokens
      )
    ).toEqual([
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS,
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS,
    ]);
    expect(secondRequest.request.max_tokens).toBe(
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS
    );
    expect(secondRequest.request.messages.at(-1)?.content).toBe(
      translate('chat.mbReasoningTransportRetryInstruction')
    );
  });

  it('attempt-scoped cancels and shares one semantic retry when final output exceeds 8K', async () => {
    const oversizedDelta = createHighNoveltyAscii(
      PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS * 4 + 4
    );
    const validResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"done",' +
      '"riskAssessment":{"level":"low","notes":"ok"},"response":"done"}';
    installSequentialStreamResponses([
      [
        { delta: oversizedDelta, done: false, error: null },
        { delta: '', done: true, finishReason: 'stop', error: null },
      ],
      [{ delta: validResponse, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              maxTokens?: number;
              onStreamDelta?: (content: string) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    const firstStreamInvocation = streamCalls[0]?.[1] as { attemptId: string };
    const secondStreamInvocation = streamCalls[1]?.[1] as {
      attemptId: string;
      request: { messages: Array<{ content: string }> };
    };
    const cancelInvocation = cancelCalls[0]?.[1] as { attemptId: string };
    const retryInstructionPrefix = translate('chat.mbTruncatedDecisionRetryInstruction', {
      reason: '__reason__',
    }).split('__reason__')[0];

    expect(result).toBe(validResponse);
    expect(streamCalls).toHaveLength(2);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelInvocation.attemptId).toBe(firstStreamInvocation.attemptId);
    expect(cancelInvocation.attemptId).not.toBe(secondStreamInvocation.attemptId);
    expect(secondStreamInvocation.request.messages.at(-1)?.content).toContain(
      retryInstructionPrefix
    );
  });

  it('allows a final decision exactly at the local 8K estimated-token boundary', async () => {
    const boundaryDelta = 'x'.repeat(PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS * 4);
    installSequentialStreamResponses([
      [{ delta: boundaryDelta, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: {
              maxTokens?: number;
              onStreamDelta?: (content: string) => void;
            }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
      onStreamDelta: vi.fn(),
    });

    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');
    expect(result).toBe(boundaryDelta);
    expect(cancelCalls).toHaveLength(0);
  });

  it('prioritizes the reasoning hard fuse over same-chunk partial output truncation', async () => {
    const hardFuseReasoning = createHighNoveltyAscii(
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_HARD_TOKENS * 4 + 4
    );
    const fallbackResponse =
      '{"decision":"RESPOND_TO_USER","rationale":"should not retry",' +
      '"riskAssessment":{"level":"low","notes":"unexpected"},"response":"unexpected"}';
    installSequentialStreamResponses([
      [
        {
          delta: '{"decision":"RESPOND_TO_USER",',
          reasoning: hardFuseReasoning,
          done: true,
          finishReason: 'length',
          error: null,
        },
      ],
      [{ delta: fallbackResponse, done: true, finishReason: 'stop', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' }, session);
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow(translate('chat.mbReasoningHardLimitFailed'));

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const cancelCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_cancel_stream');

    expect(streamCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(0);
  });

  it('retries MB stream when finishReason reports token truncation', async () => {
    installSequentialStreamResponses([
      [
        {
          delta: '{"decision":"RESPOND_TO_USER","rationale":"partial',
          done: true,
          finishReason: 'length',
          error: null,
        },
      ],
      [
        {
          delta:
            '{"decision":"RESPOND_TO_USER","rationale":"done","riskAssessment":{"level":"low","notes":"ok"},"response":"done"}',
          done: true,
          finishReason: 'stop',
          error: null,
        },
      ],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      {
        providerId: 'local',
        modelId: 'generic-compatible-model',
      },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt', {
      onStreamDelta: vi.fn(),
    });

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    const secondRequest = streamCalls[1]?.[1] as {
      request: { messages: Array<{ content: string }> };
    };

    expect(streamCalls).toHaveLength(2);
    expect(result).toContain('"response":"done"');
    expect(secondRequest.request.messages.at(-1)?.content).toContain('JSON');
  });

  it('reports the dedicated truncation error when the final decision is truncated again', async () => {
    const partial = '{"decision":"RESPOND_TO_USER","rationale":"partial';
    installSequentialStreamResponses([
      [{ delta: partial, done: true, finishReason: 'length', error: null }],
      [{ delta: partial, done: true, finishReason: 'length', error: null }],
    ]);

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await expect(
      llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      })
    ).rejects.toThrow(translate('chat.mbTruncatedDecisionRetryFailed'));

    const streamCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_stream');
    expect(streamCalls).toHaveLength(2);
  });

  it('retries non-stream MB calls after transient 524 API errors', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          type: 'error',
          error: 'API returned an error (524 <unknown status code>): error code: 524',
        })
        .mockResolvedValueOnce({
          type: 'text',
          content: '{"decision":"RESPOND_TO_USER"}',
        });

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop(
        {
          providerId: 'local',
          modelId: 'gpt-5.4',
        },
        session
      );
      const llmService = (
        loop as unknown as {
          createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }
      ).createLLMService();

      const resultPromise = llmService.generate('system prompt');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      const result = await resultPromise;

      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
      expect(result).toContain('"decision":"RESPOND_TO_USER"');
      const nonStreamRequests = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_chat_with_tools')
        .map(([, args]) => (args as { request: { maxTokens: number } }).request);
      expect(nonStreamRequests.map(({ maxTokens }) => maxTokens)).toEqual([
        PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
        PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses reasoning transport and falls back once for non-stream MB calls', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be less than or equal to 16384',
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: '{"decision":"RESPOND_TO_USER"}',
        finishReason: 'stop',
      });

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'openai', modelId: 'gpt-5.4', reasoningPreset: 'high' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    const result = await llmService.generate('system prompt');
    const requests = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_with_tools')
      .map(
        ([, args]) => (args as { request: { maxTokens: number; reasoningPreset?: string } }).request
      );

    expect(result).toContain('"decision":"RESPOND_TO_USER"');
    expect(requests.map(({ maxTokens }) => maxTokens)).toEqual([
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS,
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
    ]);
    expect(requests.map(({ reasoningPreset }) => reasoningPreset)).toEqual(['high', 'high']);
  });

  it('rejects a non-stream MB decision marked as token-truncated', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'text',
      content: '{"decision":"RESPOND_TO_USER"',
      finishReason: 'length',
    });

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    await expect(llmService.generate('system prompt')).rejects.toThrow(
      'provider finish reason: length'
    );
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-stream MB decision above the local 8K body limit', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'text',
      content: 'a'.repeat(PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS * 4 + 1),
      finishReason: 'stop',
    });

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop(
      { providerId: 'local', modelId: 'generic-compatible-model' },
      session
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    await expect(llmService.generate('system prompt')).rejects.toThrow(
      `local ${PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS}-token limit`
    );
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it('does not try a third budget after the non-stream transport fallback is rejected', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be less than or equal to 16384',
      })
      .mockResolvedValueOnce({
        type: 'error',
        error: '400 Bad Request: max_tokens must be less than or equal to 8192',
      });

    const session = createSession([{ role: 'user', content: 'current task' }]);
    const loop = new AgentLoop({ providerId: 'openai', modelId: 'gpt-5.4' }, session);
    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    await expect(llmService.generate('system prompt')).rejects.toThrow(
      'max_tokens must be less than or equal to 8192'
    );
    const requests = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'llm_chat_with_tools')
      .map(([, args]) => (args as { request: { maxTokens: number } }).request);
    expect(requests.map(({ maxTokens }) => maxTokens)).toEqual([
      PLANNING_CONSTANTS.MASTER_BRAIN_REASONING_TRANSPORT_MAX_TOKENS,
      PLANNING_CONSTANTS.MASTER_BRAIN_DEFAULT_TRANSPORT_MAX_TOKENS,
    ]);
  });

  it('retries MB stream after transient 524 API errors without empty-decision guidance', async () => {
    vi.useFakeTimers();
    try {
      const streamResponses: Array<Array<Omit<StreamPayload, 'sessionId'>>> = [
        [
          {
            delta: '',
            done: false,
            error: 'API returned an error (524 <unknown status code>): error code: 524',
          },
        ],
        [
          {
            delta:
              '```json\n' +
              '{"decision":"RESPOND_TO_USER","rationale":"done","riskAssessment":{"level":"low","notes":"ok"},"response":"done"}' +
              '\n```',
            done: true,
            error: null,
          },
        ],
      ];
      let activeHandler: StreamHandler | undefined;

      vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
        activeHandler = handler;
        return Promise.resolve(vi.fn());
      }) as unknown as typeof listen);

      vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
        if (command !== 'llm_chat_stream') {
          return {
            type: 'text',
            content: '{"decision":"RESPOND_TO_USER"}',
          };
        }

        const { sessionId } = args as { sessionId: string };
        const payloads = streamResponses.shift();
        queueMicrotask(() => {
          const handler = activeHandler;
          if (!handler || !payloads) return;
          for (const payload of payloads) {
            handler({
              payload: {
                sessionId,
                ...payload,
              },
            });
          }
        });
        return undefined;
      }) as unknown as typeof invoke);

      const session = createSession([{ role: 'user', content: 'current task' }]);
      const loop = new AgentLoop(
        {
          providerId: 'gemini',
          modelId: 'gemini-thinking',
        },
        session
      );

      const llmService = (
        loop as unknown as {
          createLLMService: () => {
            generate: (
              prompt: string,
              options?: { onStreamDelta?: (content: string) => void }
            ) => Promise<string>;
          };
        }
      ).createLLMService();

      const resultPromise = llmService.generate('system prompt', {
        onStreamDelta: vi.fn(),
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      const result = await resultPromise;

      const streamCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'llm_chat_stream');
      const secondRequest = streamCalls[1]?.[1] as {
        request: { messages: Array<{ content: string }> };
      };

      expect(streamCalls).toHaveLength(2);
      expect(result).toContain('"decision":"RESPOND_TO_USER"');
      expect(secondRequest.request.messages.at(-1)?.content).not.toContain(
        'previous Master Brain streaming call finished without final decision content'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks streaming Master Brain Current Context from invoke start through provider usage', async () => {
    const contextId = 'task-context-mb-stream';
    useStatusStore.getState().clearContextPressure(contextId);
    let activeAtInvoke:
      | ReturnType<typeof useStatusStore.getState>['contextPressureByAgent'][string]
      | undefined;
    let streamHandler: StreamHandler | undefined;
    let streamRequest: { reasoning_preset?: string } | undefined;

    vi.mocked(listen).mockImplementation(((_eventName: string, handler: StreamHandler) => {
      streamHandler = handler;
      return Promise.resolve(vi.fn());
    }) as unknown as typeof listen);
    vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
      if (command !== 'llm_chat_stream') return undefined;
      activeAtInvoke = useStatusStore.getState().getContextPressure(contextId) ?? undefined;
      const { sessionId, request } = args as {
        sessionId: string;
        request: { reasoning_preset?: string };
      };
      streamRequest = request;
      queueMicrotask(() => {
        streamHandler?.({
          payload: {
            sessionId,
            delta: '{"decision":"RESPOND_TO_USER"}',
            reasoning: 'reasoning trace',
            done: true,
            error: null,
            inputTokens: 41,
            outputTokens: 9,
          },
        });
      });
      return undefined;
    }) as unknown as typeof invoke);

    const loop = new AgentLoop(
      {
        agentId: 'agent-mb-stream',
        tokenContextId: contextId,
        providerId: 'gemini',
        modelId: 'gemini-2.5-pro',
        reasoningPreset: 'high',
      },
      createSession([{ role: 'user', content: 'current task' }])
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { onStreamDelta?: (content: string) => void }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await llmService.generate('system prompt', { onStreamDelta: vi.fn() });

    expect(streamRequest?.reasoning_preset).toBe('high');
    expect(activeAtInvoke).toMatchObject({
      phase: 'active',
      purpose: 'master-brain',
      providerId: 'gemini',
      modelId: 'gemini-2.5-pro',
      currentOutputTokens: 0,
    });
    expect(activeAtInvoke?.currentInputTokens).toBeGreaterThan(0);
    expect(activeAtInvoke?.contextWindowSize).toBeGreaterThan(0);
    expect(useStatusStore.getState().getContextPressure(contextId)).toMatchObject({
      phase: 'last',
      purpose: 'master-brain',
      currentInputTokens: 41,
      currentOutputTokens: 9,
    });
    useStatusStore.getState().clearContextPressure(contextId);
  });

  it('tracks Checkpoint Current Context and leaves a completed Last Context', async () => {
    const contextId = 'task-context-checkpoint';
    useStatusStore.getState().clearContextPressure(contextId);
    let activeAtInvoke:
      | ReturnType<typeof useStatusStore.getState>['contextPressureByAgent'][string]
      | undefined;
    let checkpointRequest: { reasoningPreset?: string } | undefined;

    vi.mocked(invoke).mockImplementation((async (command: string, args: unknown) => {
      if (command !== 'llm_chat_with_tools') return undefined;
      activeAtInvoke = useStatusStore.getState().getContextPressure(contextId) ?? undefined;
      checkpointRequest = (args as { request: { reasoningPreset?: string } }).request;
      return {
        type: 'text',
        content: '{"type":"EXTEND_BUDGET","additionalIterations":1,"reason":"continue"}',
        inputTokens: 17,
        outputTokens: 5,
      };
    }) as unknown as typeof invoke);

    const loop = new AgentLoop(
      {
        agentId: 'agent-checkpoint',
        tokenContextId: contextId,
        providerId: 'openai',
        modelId: 'gpt-5.4',
        reasoningPreset: 'high',
      },
      createSession([])
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => {
          generate: (
            prompt: string,
            options?: { skipSessionMessages?: boolean; taskContext?: string }
          ) => Promise<string>;
        };
      }
    ).createLLMService();

    await llmService.generate('checkpoint system prompt', {
      skipSessionMessages: true,
      taskContext: 'checkpoint task context',
    });

    expect(checkpointRequest?.reasoningPreset).toBe('high');
    expect(activeAtInvoke).toMatchObject({
      phase: 'active',
      purpose: 'checkpoint',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      currentOutputTokens: 0,
    });
    expect(activeAtInvoke?.currentInputTokens).toBeGreaterThan(0);
    expect(useStatusStore.getState().getContextPressure(contextId)).toMatchObject({
      phase: 'last',
      purpose: 'checkpoint',
      currentInputTokens: 17,
      currentOutputTokens: 5,
    });
    useStatusStore.getState().clearContextPressure(contextId);
  });

  it('completes failed Master Brain calls instead of leaving Current Context active', async () => {
    const contextId = 'task-context-mb-error';
    useStatusStore.getState().clearContextPressure(contextId);
    vi.mocked(invoke).mockResolvedValue({
      type: 'error',
      error: 'invalid request',
    });

    const loop = new AgentLoop(
      {
        agentId: 'agent-mb-error',
        tokenContextId: contextId,
        providerId: 'openai',
        modelId: 'gpt-5.4',
      },
      createSession([{ role: 'user', content: 'current task' }])
    );
    const llmService = (
      loop as unknown as {
        createLLMService: () => { generate: (prompt: string) => Promise<string> };
      }
    ).createLLMService();

    await expect(llmService.generate('system prompt')).rejects.toThrow('invalid request');
    expect(useStatusStore.getState().getContextPressure(contextId)).toMatchObject({
      phase: 'last',
      purpose: 'master-brain',
    });
    useStatusStore.getState().clearContextPressure(contextId);
  });
});
