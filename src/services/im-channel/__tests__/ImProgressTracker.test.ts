import { describe, expect, it, vi, afterEach } from 'vitest';
import { ImProgressTracker } from '../ImProgressTracker';
import type { ImCardContent, ImChannel, ImTask } from '../types';

function createTask(): ImTask {
  return {
    id: 'task_1',
    agentId: 'agent_1',
    status: 'running',
    progressCardMessageId: 'card_1',
    createdAt: 0,
    sourceMessage: {
      platform: 'feishu',
      messageId: 'message_1',
      chatId: 'chat_1',
      chatType: 'private',
      senderId: 'user_1',
      senderName: 'User',
      content: 'run task',
      mentionedBot: false,
      timestamp: 0,
    },
  };
}

function createChannelRecorder(): { channel: ImChannel; cards: ImCardContent[] } {
  const cards: ImCardContent[] = [];
  const channel: ImChannel = {
    platform: 'feishu',
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => true,
    onMessage: (_handler) => undefined,
    onConnectionChange: (_handler) => undefined,
    onCardAction: (_handler) => undefined,
    sendText: async (_chatId, _text) => 'text_1',
    sendCard: async (_chatId, card) => {
      cards.push(card);
      return 'card_1';
    },
    updateCard: async (_messageId, card) => {
      cards.push(card);
    },
    sendImage: async (_chatId, _imageBase64, _imageTypeHint) => 'image_1',
    sendFile: async (_chatId, _fileBase64, _fileName, _fileType) => 'file_1',
    downloadResource: async (_messageId, _fileKey, _resourceType) => ({
      base64: '',
      mimeType: 'text/plain',
    }),
  };

  return { channel, cards };
}

async function flushThrottledUpdate(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.resolve();
}

function findThinkingContent(card: ImCardContent): string {
  return (
    card.sections.find(
      (section) =>
        section.content.includes('analysis') ||
        section.content.includes('plan') ||
        section.content.includes('decision')
    )?.content ?? ''
  );
}

function findSubAgentContent(card: ImCardContent): string {
  return card.sections.find((section) => section.header?.includes('Sub-Agent'))?.content ?? '';
}

describe('ImProgressTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces streaming snapshots for the same thinking phase', async () => {
    vi.useFakeTimers();
    const { channel, cards } = createChannelRecorder();
    const tracker = new ImProgressTracker(channel, createTask(), 'Mimi');

    tracker.handleThinkingPhase({ phase: 'analyzing', content: 'analysis' });
    tracker.handleThinkingPhase({ phase: 'analyzing', content: 'analysis grows' });
    tracker.handleThinkingPhase({ phase: 'analyzing', content: 'final analysis' });

    await flushThrottledUpdate();

    const content = findThinkingContent(cards.at(-1)!);
    expect(content).toContain('final analysis');
    expect(content).not.toContain('analysis grows');
    expect(content.split('\n')).toHaveLength(1);
  });

  it('keeps distinct thinking phases as separate card lines', async () => {
    vi.useFakeTimers();
    const { channel, cards } = createChannelRecorder();
    const tracker = new ImProgressTracker(channel, createTask(), 'Mimi');

    tracker.handleThinkingPhase({ phase: 'analyzing', content: 'analysis' });
    tracker.handleThinkingPhase({ phase: 'planning', content: 'plan' });
    tracker.handleThinkingPhase({ phase: 'decided', content: 'decision' });

    await flushThrottledUpdate();

    const content = findThinkingContent(cards.at(-1)!);
    expect(content).toContain('analysis');
    expect(content).toContain('plan');
    expect(content).toContain('decision');
    expect(content.split('\n')).toHaveLength(3);
  });

  it('updates Sub-Agent tool rows instead of appending final status duplicates', async () => {
    vi.useFakeTimers();
    const { channel, cards } = createChannelRecorder();
    const tracker = new ImProgressTracker(channel, createTask(), 'Mimi');

    tracker.handleSubAgentObservation({
      runId: 'sa-run-1',
      thinking: 'Sending file.',
      toolAction: {
        toolCallId: 'call_feishu_send_1',
        tool: 'feishu_send',
        target: 'feishu_send',
      },
      step: 1,
      timestamp: 100,
    });

    tracker.handleSubAgentObservation({
      runId: 'sa-run-1',
      thinking: '',
      toolAction: {
        toolCallId: 'call_feishu_send_1',
        tool: 'feishu_send',
        target: 'feishu_send',
        success: true,
      },
      step: 1,
      timestamp: 200,
    });

    await flushThrottledUpdate();

    const content = findSubAgentContent(cards.at(-1)!);
    expect(content.match(/feishu_send feishu_send/g)).toHaveLength(1);
    expect(content.split('\n')).toHaveLength(1);
  });
});
