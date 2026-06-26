import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImCardContent, ImChannel, ImIncomingMessage, MessageHandler } from '../types';
import {
    clearImBotTaskState,
    initializeImTaskBridge,
    markImTaskStarted,
} from '../ImTaskBridge';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { useHubStore } from '@stores/hubStore';
import { useImChannelStore } from '@stores/imChannelStore';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(async (command: string) => {
        if (command === 'im_write_app_data_file' || command === 'im_delete_app_data_file') {
            return '';
        }
        return null;
    }),
    emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    emit: mocks.emit,
    listen: vi.fn(async () => () => undefined),
}));

vi.mock('zustand/middleware', () => ({
    persist: (initializer: unknown) => initializer,
}));

interface ChannelHarness {
    channel: ImChannel;
    cards: ImCardContent[];
    sendMessage: (message: ImIncomingMessage) => void;
}

function createChannelHarness(): ChannelHarness {
    let messageHandler: MessageHandler | null = null;
    const cards: ImCardContent[] = [];

    const channel: ImChannel = {
        platform: 'feishu',
        connect: async () => undefined,
        disconnect: async () => undefined,
        isConnected: () => true,
        onMessage: (handler) => {
            messageHandler = handler;
        },
        onConnectionChange: () => undefined,
        onCardAction: () => undefined,
        sendText: async () => 'text_1',
        sendCard: async (_chatId, card) => {
            cards.push(card);
            return `card_${cards.length}`;
        },
        updateCard: async (_messageId, card) => {
            cards.push(card);
        },
        sendImage: async () => 'image_1',
        sendFile: async () => 'file_1',
        downloadResource: async () => ({ base64: '', mimeType: 'text/plain' }),
    };

    return {
        channel,
        cards,
        sendMessage: (message) => {
            if (!messageHandler) {
                throw new Error('message handler was not registered');
            }
            messageHandler(message);
        },
    };
}

function createMessage(messageId: string): ImIncomingMessage {
    return {
        platform: 'feishu',
        messageId,
        chatId: 'chat_1',
        chatType: 'private',
        senderId: 'user_1',
        senderName: 'User',
        content: 'run task',
        mentionedBot: true,
        timestamp: Date.now(),
    };
}

function seedStores(): void {
    useHubStore.setState({
        hubs: [{ id: 'hub_1', name: 'Hub', createdAt: '', updatedAt: '' }],
        currentHubId: 'hub_1',
    });
    useAgentStore.setState({
        agents: [{
            id: 'agent_1',
            hubId: 'hub_1',
            name: 'A1',
            avatarColor: null,
            modelProvider: null,
            modelName: null,
            mbRulesFilePath: null,
            saRulesFilePath: null,
            mbRules: null,
            saRules: null,
            chatRules: null,
            knowledgePaths: null,
            createdAt: 0,
            updatedAt: 0,
        }],
        currentAgentId: 'agent_1',
    });
    useImChannelStore.setState({
        botConfigs: [{
            botId: 'bot_1',
            displayName: 'Feishu Bot',
            platform: 'feishu',
            hubId: 'hub_1',
            agentId: 'agent_1',
            enabled: true,
            hasCredentials: true,
        }],
        connectionStates: {},
    });
    useChatStore.getState().finishSending('agent_1');
}

async function advanceDispatchDelay(): Promise<void> {
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
}

async function advancePendingTimeout(): Promise<void> {
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
}

describe('ImTaskBridge dispatch lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.invoke.mockClear();
        mocks.emit.mockClear();
        seedStores();
        clearImBotTaskState('bot_1');
    });

    afterEach(() => {
        clearImBotTaskState('bot_1');
        vi.useRealTimers();
    });

    it('cleans pending IM tasks when no Agent listener starts them', async () => {
        const harness = createChannelHarness();
        initializeImTaskBridge('bot_1', harness.channel);

        harness.sendMessage(createMessage('message_timeout'));
        await advanceDispatchDelay();
        await advancePendingTimeout();

        const botState = useImChannelStore.getState().connectionStates.bot_1;
        expect(botState?.activeTask).toBeNull();
        expect(harness.cards.at(-1)?.title).toContain('任务执行失败');
    });

    it('does not let the pending timeout clear a task after it is marked started', async () => {
        const harness = createChannelHarness();
        initializeImTaskBridge('bot_1', harness.channel);

        harness.sendMessage(createMessage('message_started'));
        await advanceDispatchDelay();

        const activeTask = useImChannelStore.getState().connectionStates.bot_1?.activeTask;
        expect(activeTask?.status).toBe('pending');
        expect(markImTaskStarted('bot_1', activeTask?.id)).toBe(true);

        await advancePendingTimeout();

        const botState = useImChannelStore.getState().connectionStates.bot_1;
        expect(botState?.activeTask?.status).toBe('running');
    });

    it('clears bridge task state when a bot channel is destroyed', async () => {
        const harness = createChannelHarness();
        initializeImTaskBridge('bot_1', harness.channel);

        harness.sendMessage(createMessage('message_clear'));
        await advanceDispatchDelay();

        expect(useImChannelStore.getState().connectionStates.bot_1?.activeTask).not.toBeNull();

        clearImBotTaskState('bot_1');

        expect(useImChannelStore.getState().connectionStates.bot_1?.activeTask).toBeNull();
    });
});
