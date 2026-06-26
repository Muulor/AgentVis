import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentLoop } from '../AgentLoop';
import type { AgentSession } from '../AgentSession';
import { translate } from '@/i18n';

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
    return messages.flatMap(message => message.images?.map(image => image.data ?? '') ?? []);
}

interface StreamPayload {
    sessionId: string;
    delta: string;
    reasoning?: string;
    done: boolean;
    error: string | null;
    inputTokens?: number;
    outputTokens?: number;
}

type StreamHandler = (event: { payload: StreamPayload }) => void;

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
            session,
        );
        (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();
        await llmService.generate('system prompt');

        const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
            request: { messages: Array<{ images?: unknown }> };
        };
        expect(request.request.messages.some(message => message.images)).toBe(false);
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
            session,
        );
        (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();
        await llmService.generate('system prompt');

        const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
            request: { messages: Array<{ content: string; images?: Array<{ data?: string }> }> };
        };
        const historicalImageMessage = request.request.messages.find(message =>
            message.images?.some(image => image.data === 'history-image')
        );

        expect(historicalImageMessage?.content).toBe(translate('planning.masterBrain.historicalUserImageMessage', {
            timestamp: '2026-01-02 03:04',
            imageCount: 1,
            content: 'old screenshot bug',
        }));
        expect(request.request.messages.some(message => message.content === 'new bug without screenshot')).toBe(true);
    });

    it('retries MB once without images when provider rejects image input', async () => {
        vi.mocked(invoke)
            .mockRejectedValueOnce(new Error('(404 Not Found): {"error":{"message":"No endpoints found that support image input"}}'))
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
            session,
        );

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();
        await llmService.generate('system prompt');

        const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
            request: { messages: Array<{ images?: unknown }> };
        };
        const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
            request: { messages: Array<{ images?: unknown }> };
        };

        expect(firstRequest.request.messages.some(message => message.images)).toBe(true);
        expect(secondRequest.request.messages.some(message => message.images)).toBe(false);
    });

    it('retries MB once without images for local relay failed-to-read image requests', async () => {
        vi.mocked(invoke)
            .mockRejectedValueOnce(new Error('(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'))
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
            session,
        );

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();
        await llmService.generate('system prompt');

        const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
            request: { messages: Array<{ images?: unknown }> };
        };
        expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
        expect(secondRequest.request.messages.some(message => message.images)).toBe(false);
    });

    it('preserves current-turn images when retrying after historical image payload failure', async () => {
        vi.mocked(invoke)
            .mockRejectedValueOnce(new Error('(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'))
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
            session,
        );
        (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();
        await llmService.generate('system prompt');

        const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
            request: { messages: Array<{ images?: Array<{ data?: string }> }> };
        };
        const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
            request: { messages: Array<{ images?: Array<{ data?: string }> }> };
        };

        expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
        expect(extractImageData(firstRequest.request.messages)).toEqual(expect.arrayContaining([
            'history-image',
            'current-image',
        ]));
        expect(extractImageData(secondRequest.request.messages)).toContain('current-image');
        expect(extractImageData(secondRequest.request.messages)).not.toContain('history-image');
    });

    it('reuses the successful partial image fallback on later MB calls', async () => {
        vi.mocked(invoke)
            .mockRejectedValueOnce(new Error('(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'))
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
            session,
        );
        (loop as unknown as { historyMessageCount: number }).historyMessageCount = 1;

        const llmService = (loop as unknown as {
            createLLMService: () => { generate: (prompt: string) => Promise<string> };
        }).createLLMService();

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
        expect(extractImageData(firstRequest.request.messages)).toEqual(expect.arrayContaining([
            'history-image',
            'current-image',
        ]));
        expect(extractImageData(secondRequest.request.messages)).toContain('current-image');
        expect(extractImageData(secondRequest.request.messages)).not.toContain('history-image');
        expect(extractImageData(thirdRequest.request.messages)).toContain('current-image');
        expect(extractImageData(thirdRequest.request.messages)).not.toContain('history-image');
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
            session,
        );

        const llmService = (loop as unknown as {
            createLLMService: () => {
                generate: (
                    prompt: string,
                    options?: { onStreamDelta?: (content: string) => void }
                ) => Promise<string>;
            };
        }).createLLMService();
        const result = await llmService.generate('system prompt', {
            onStreamDelta: vi.fn(),
        });

        const streamCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'llm_chat_stream');
        const secondRequest = streamCalls[1]?.[1] as {
            request: { messages: Array<{ content: string }> };
        };

        expect(streamCalls).toHaveLength(2);
        expect(result).toContain('"decision":"RESPOND_TO_USER"');
        expect(secondRequest.request.messages.at(-1)?.content).toContain(
            'previous Master Brain streaming call finished without final decision content'
        );
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
                session,
            );
            const llmService = (loop as unknown as {
                createLLMService: () => { generate: (prompt: string) => Promise<string> };
            }).createLLMService();

            const resultPromise = llmService.generate('system prompt');
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(3000);
            const result = await resultPromise;

            expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
            expect(result).toContain('"decision":"RESPOND_TO_USER"');
        } finally {
            vi.useRealTimers();
        }
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
                session,
            );

            const llmService = (loop as unknown as {
                createLLMService: () => {
                    generate: (
                        prompt: string,
                        options?: { onStreamDelta?: (content: string) => void }
                    ) => Promise<string>;
                };
            }).createLLMService();

            const resultPromise = llmService.generate('system prompt', {
                onStreamDelta: vi.fn(),
            });
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(3000);
            const result = await resultPromise;

            const streamCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'llm_chat_stream');
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
});
