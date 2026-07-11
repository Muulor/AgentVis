/**
 * SubAgentLLMCaller Loop 多轮会话测试
 *
 * 测试 callWithContext 方法及相关功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  SubAgentLLMCallerFactory,
  type SubAgentLLMCallerConfig,
  type ToolExecutionResult,
} from '../SubAgentLLMCaller';
import type { AccumulatedMessage } from '../../../sub-agents/types';
import { translate } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// Mock 数据
// ═══════════════════════════════════════════════════════════════

const mockConfig: SubAgentLLMCallerConfig = {
  providerId: 'test-provider',
  modelId: 'test-model',
};

const mockExecuteTool = vi.fn().mockResolvedValue({
  success: true,
  content: '工具执行成功',
} as ToolExecutionResult);

function extractImageData(messages: Array<{ images?: Array<{ data?: string }> }>): string[] {
  return messages.flatMap((message) => message.images?.map((image) => image.data ?? '') ?? []);
}

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    type: 'text',
    content: 'Mock LLM response',
  }),
}));

// Mock toolRegistry
vi.mock('../../../tools/ToolRegistry', () => ({
  toolRegistry: {
    getSchemas: () => [
      { name: 'read', description: '读取文件', parameters: {} },
      { name: 'file_write', description: '写入文件', parameters: {} },
    ],
  },
}));

// Mock contextWindowManager
vi.mock('../../../ContextWindowManager', () => ({
  contextWindowManager: {
    getBudget: () => ({
      totalTokens: 128000,
    }),
  },
}));

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('SubAgentLLMCaller Loop', () => {
  let factory: SubAgentLLMCallerFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      type: 'text',
      content: 'Mock LLM response',
    });
    factory = new SubAgentLLMCallerFactory(mockConfig, mockExecuteTool);
  });

  describe('callWithContext', () => {
    it('包含累积上下文的消息', async () => {
      const caller = factory.create();

      // 验证 caller 有 callWithContext 方法
      expect(caller.callWithContext).toBeDefined();

      const accumulatedContext: AccumulatedMessage[] = [
        { role: 'assistant', content: '第一轮执行结果', timestamp: Date.now() },
        { role: 'tool', content: '工具输出', toolName: 'read', timestamp: Date.now() },
      ];

      const response = await caller.callWithContext(
        'System prompt here',
        ['read'],
        accumulatedContext
      );

      // 验证响应存在
      expect(response).toBeDefined();
      expect(response.content).toBeDefined();
    });

    it('工具结果正确追加到消息历史', async () => {
      const caller = factory.create();

      const accumulatedContext: AccumulatedMessage[] = [
        { role: 'tool', content: '[read] 文件内容...', toolName: 'read', timestamp: Date.now() },
        { role: 'assistant', content: '已读取文件', timestamp: Date.now() },
        {
          role: 'tool',
          content: '[file_write] 写入成功',
          toolName: 'file_write',
          timestamp: Date.now(),
        },
      ];

      const response = await caller.callWithContext(
        'Continue the task',
        ['read', 'file_write'],
        accumulatedContext
      );

      expect(response).toBeDefined();
    });

    it('additionalInstructions 正确注入到 user prompt', async () => {
      const caller = factory.create();

      const accumulatedContext: AccumulatedMessage[] = [
        { role: 'assistant', content: '执行中...', timestamp: Date.now() },
      ];

      const response = await caller.callWithContext(
        'System prompt',
        ['read'],
        accumulatedContext,
        '请专注于 API 文档分析'
      );

      expect(response).toBeDefined();
    });

    it('模型注册表标记不支持视觉时，应在首次调用前移除 images', async () => {
      const noVisionFactory = new SubAgentLLMCallerFactory(
        {
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
        },
        mockExecuteTool
      );
      const caller = noVisionFactory.create();

      await caller.callWithContext(
        'System prompt',
        ['read'],
        [
          {
            role: 'tool',
            content: '截图结果',
            toolName: 'read',
            images: [{ mimeType: 'image/png', data: 'base64-image' }],
            timestamp: Date.now(),
          },
        ]
      );

      const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
        request: { messages: Array<{ content: string; images?: unknown[] }> };
      };
      expect(
        request.request.messages.some((message) => message.images && message.images.length > 0)
      ).toBe(false);
      expect(request.request.messages.map((message) => message.content).join('\n')).toContain(
        translate('chat.subAgentVisionImagesOmitted', { count: 1 })
      );
    });

    it('API 返回视觉不支持错误时，应移除 images 并重试一次', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          type: 'error',
          error:
            '(404 Not Found): {"error":{"message":"No endpoints found that support image input"}}',
        })
        .mockResolvedValueOnce({
          type: 'text',
          content: 'retry ok',
        });

      const visionFactory = new SubAgentLLMCallerFactory(
        {
          providerId: 'openai',
          modelId: 'gpt-5.4',
        },
        mockExecuteTool
      );
      const caller = visionFactory.create();
      const response = await caller.callWithContext(
        'System prompt',
        ['read'],
        [
          {
            role: 'tool',
            content: '浏览器截图',
            toolName: 'read',
            images: [{ mimeType: 'image/png', data: 'base64-image' }],
            timestamp: Date.now(),
          },
        ]
      );

      expect(response.content).toBe('retry ok');
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);

      const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
        request: { messages: Array<{ images?: unknown[] }> };
      };
      const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
        request: { messages: Array<{ content: string; images?: unknown[] }> };
      };
      expect(
        firstRequest.request.messages.some((message) => message.images && message.images.length > 0)
      ).toBe(true);
      expect(
        secondRequest.request.messages.some(
          (message) => message.images && message.images.length > 0
        )
      ).toBe(false);
      expect(secondRequest.request.messages.map((message) => message.content).join('\n')).toContain(
        translate('chat.subAgentVisionImagesOmitted', { count: 1 })
      );
    });

    it('local 中转返回 failed to read request 时，应移除 images 并重试一次', async () => {
      vi.mocked(invoke)
        .mockRejectedValueOnce(
          new Error(
            '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
          )
        )
        .mockResolvedValueOnce({
          type: 'text',
          content: 'retry ok',
        });

      const localFactory = new SubAgentLLMCallerFactory(
        {
          providerId: 'local',
          modelId: 'gpt-5.4',
        },
        mockExecuteTool
      );
      const caller = localFactory.create();
      const response = await caller.callWithContext(
        'System prompt',
        ['read'],
        [
          {
            role: 'tool',
            content: 'relay image',
            toolName: 'read',
            images: [{ mimeType: 'image/png', data: 'base64-image' }],
            timestamp: Date.now(),
          },
        ]
      );

      const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
        request: { messages: Array<{ images?: unknown[] }> };
      };
      expect(response.content).toBe('retry ok');
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
      expect(
        secondRequest.request.messages.some(
          (message) => message.images && message.images.length > 0
        )
      ).toBe(false);
    });
  });

  it('preserves current task images when retrying after historical image payload failure', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: 'retry ok',
      });

    const localFactory = new SubAgentLLMCallerFactory(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
      },
      mockExecuteTool
    );
    const caller = localFactory.create();
    const accumulatedContext = [
      {
        role: 'user',
        content: 'historical image context',
        images: [{ mimeType: 'image/png', data: 'history-image' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: 'current task image',
        images: [{ mimeType: 'image/jpeg', data: 'current-image' }],
        preserveImagesOnVisionFallback: true,
        timestamp: Date.now(),
      },
    ] as unknown as AccumulatedMessage[];

    const response = await caller.callWithContext('System prompt', ['read'], accumulatedContext);

    const firstRequest = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };
    const secondRequest = vi.mocked(invoke).mock.calls[1]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };

    expect(response.content).toBe('retry ok');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(extractImageData(firstRequest.request.messages)).toEqual(
      expect.arrayContaining(['history-image', 'current-image'])
    );
    expect(extractImageData(secondRequest.request.messages)).toContain('current-image');
    expect(extractImageData(secondRequest.request.messages)).not.toContain('history-image');
  });

  it('reuses the successful partial image fallback on later SA steps', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        new Error(
          '(400 Bad Request): {"error":{"message":"failed to read request","type":"invalid_request_error"}}'
        )
      )
      .mockResolvedValueOnce({
        type: 'text',
        content: 'first retry ok',
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: 'second step ok',
      });

    const localFactory = new SubAgentLLMCallerFactory(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
      },
      mockExecuteTool
    );
    const caller = localFactory.create();
    const accumulatedContext = [
      {
        role: 'user',
        content: 'historical image context',
        images: [{ mimeType: 'image/png', data: 'history-image' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: 'current task image',
        images: [{ mimeType: 'image/jpeg', data: 'current-image' }],
        preserveImagesOnVisionFallback: true,
        timestamp: Date.now(),
      },
    ] as unknown as AccumulatedMessage[];

    await caller.callWithContext('System prompt', ['read'], accumulatedContext);
    const secondStepResponse = await caller.callWithContext(
      'System prompt',
      ['read'],
      accumulatedContext
    );

    const secondStepRequest = vi.mocked(invoke).mock.calls[2]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };

    expect(secondStepResponse.content).toBe('second step ok');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
    expect(extractImageData(secondStepRequest.request.messages)).toContain('current-image');
    expect(extractImageData(secondStepRequest.request.messages)).not.toContain('history-image');
  });

  it('uses a seeded partial image fallback before the first SA step', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: 'text',
      content: 'seeded fallback ok',
    });

    const localFactory = new SubAgentLLMCallerFactory(
      {
        providerId: 'local',
        modelId: 'gpt-5.4',
      },
      mockExecuteTool
    );
    localFactory.setVisionFallbackMode('strip-unmarked');

    const caller = localFactory.create();
    const accumulatedContext = [
      {
        role: 'user',
        content: 'historical image context',
        images: [{ mimeType: 'image/png', data: 'history-image' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: 'current task image',
        images: [{ mimeType: 'image/jpeg', data: 'current-image' }],
        preserveImagesOnVisionFallback: true,
        timestamp: Date.now(),
      },
    ] as unknown as AccumulatedMessage[];

    const response = await caller.callWithContext('System prompt', ['read'], accumulatedContext);
    const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
      request: { messages: Array<{ images?: Array<{ data?: string }> }> };
    };

    expect(response.content).toBe('seeded fallback ok');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(extractImageData(request.request.messages)).toContain('current-image');
    expect(extractImageData(request.request.messages)).not.toContain('history-image');
  });

  describe('buildMessagesWithContext', () => {
    it('空上下文返回基础消息', () => {
      // 通过调用 callWithContext 间接测试
      const caller = factory.create();

      // 验证方法存在
      expect(caller.callWithContext).toBeDefined();
    });

    it('多轮上下文正确拼接', async () => {
      const caller = factory.create();

      const accumulatedContext: AccumulatedMessage[] = [
        { role: 'assistant', content: '第一轮', timestamp: 1000 },
        { role: 'tool', content: '工具1', toolName: 'read', timestamp: 2000 },
        { role: 'assistant', content: '第二轮', timestamp: 3000 },
        { role: 'tool', content: '工具2', toolName: 'file_write', timestamp: 4000 },
      ];

      const response = await caller.callWithContext(
        'System prompt',
        ['read', 'file_write'],
        accumulatedContext
      );

      expect(response).toBeDefined();
    });

    it('有 additionalInstructions 时包含策略调整', async () => {
      const caller = factory.create();

      const response = await caller.callWithContext(
        'System prompt',
        ['read'],
        [],
        '调整策略：只搜索英文资料'
      );

      expect(response).toBeDefined();

      const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
        request: { messages: Array<{ content: string }> };
      };
      const messageContent = request.request.messages.map((message) => message.content).join('\n');
      expect(messageContent).toContain(
        translate('chat.subAgentSystemNote', {
          instructions: '调整策略：只搜索英文资料',
        })
      );
      expect(messageContent).not.toContain('Continue executing the task.');
    });

    it('默认不追加 Sub-Agent Safety Footer', async () => {
      const caller = factory.create();

      await caller.callWithContext('System prompt', ['read'], []);

      const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
        request: { messages: Array<{ role: string; content: string }> };
      };

      expect(
        request.request.messages.some((message) => message.content.includes('Correction Reminder'))
      ).toBe(false);
    });

    it('启用后追加自定义 Sub-Agent Safety Footer', async () => {
      const footerFactory = new SubAgentLLMCallerFactory(
        {
          ...mockConfig,
          subAgentSafetyFooterEnabled: true,
          subAgentSafetyFooterText: 'Custom correction reminder',
        },
        mockExecuteTool
      );
      const caller = footerFactory.create();

      await caller.callWithContext('System prompt', ['read'], []);

      const request = vi.mocked(invoke).mock.calls[0]?.[1] as {
        request: { messages: Array<{ role: string; content: string }> };
      };
      const finalUserMessage = [...request.request.messages]
        .reverse()
        .find((message) => message.role === 'user');

      expect(finalUserMessage?.content).toContain('System Message: Correction Reminder');
      expect(finalUserMessage?.content).toContain('Custom correction reminder');
      expect(finalUserMessage?.content).toContain('feel free to lean into your strengths');
    });
  });
});
