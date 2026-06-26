/**
 * SlackSendTool - 原生 Slack 消息发送工具
 *
 * 通过已配置的 AgentVis Slack Bot 凭据发送文本、图片或本地文件。
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, readFile, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { translate } from '@/i18n';
import { buildOutboundMessageCard } from '@services/im-channel/cardTemplates';
import { buildSlackMessagePayload } from '@services/im-channel/platforms/slackBlockBuilder';
import type { BotConfig } from '@services/im-channel/types';
import { useImChannelStore } from '@stores/imChannelStore';
import type { Tool, ToolExecutionContext, ToolResult, ToolSchema } from '../../tools/types';
import { getSandboxPathViolation } from '../shared/sandboxPath';
import { getLogger } from '@services/logger';

const logger = getLogger('SlackSendTool');

type SlackSendAction = 'send_text' | 'send_image' | 'send_file';

interface ImCredentials {
    botToken?: string;
    appToken?: string;
}

interface ResolvedTarget {
    channelId: string;
    source: 'argument' | 'botDefault' | 'activeChat' | 'lastChat';
}

interface RememberedChatData {
    chatId?: string;
    platform?: string;
    botId?: string;
    agentId?: string | null;
    ended?: boolean;
}

interface SlackFileControlOptions {
    botToken: string;
    channelId: string;
    fileId: string;
    fileName: string;
    caption: string;
}

const ACTIONS: readonly SlackSendAction[] = ['send_text', 'send_image', 'send_file'];
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const FILE_MAX_BYTES = 1024 * 1024 * 1024;

const SCHEMA: ToolSchema = {
    name: 'slack_send',
    description:
        'Send a text message, image, or local file to Slack through an AgentVis-configured Slack bot. ' +
        'When channelId is omitted, the tool uses the bot default channel, then falls back to the current or last Slack chat for that bot.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'Send action: send_text, send_image, or send_file.',
                enum: ['send_text', 'send_image', 'send_file'],
            },
            text: {
                type: 'string',
                description: 'Text content for send_text, or an optional initial comment for send_image/send_file attachments.',
            },
            caption: {
                type: 'string',
                description: 'Optional caption or status summary to send with an image or file attachment.',
            },
            filePath: {
                type: 'string',
                description: 'Absolute or workdir-relative local file path for send_image or send_file.',
            },
            channelId: {
                type: 'string',
                description: 'Optional Slack channel, private channel, MPIM, or DM ID such as C..., G..., or D....',
            },
            botId: {
                type: 'string',
                description: 'Optional AgentVis Slack bot ID. Usually omit it; IM and cron contexts inject the correct bot automatically.',
            },
        },
        required: ['action'],
    },
};

function getStringParam(params: Record<string, unknown>, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = params[name];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function normalizeAction(params: Record<string, unknown>): SlackSendAction | null {
    const raw = getStringParam(params, 'action', 'type', 'messageType', 'message_type');
    if (raw && ACTIONS.includes(raw as SlackSendAction)) {
        return raw as SlackSendAction;
    }
    if (!raw) {
        if (getStringParam(params, 'text')) return 'send_text';
        const filePath = getStringParam(params, 'filePath', 'file_path', 'path');
        if (filePath) {
            return IMAGE_EXTENSIONS.has(getExtension(filePath)) ? 'send_image' : 'send_file';
        }
    }
    return null;
}

function resolveBotConfig(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
): { bot?: BotConfig; error?: string } {
    const requestedBotId = getStringParam(params, 'botId', 'bot_id');
    const contextBotId = context.imBotId;
    const { botConfigs } = useImChannelStore.getState();

    if (requestedBotId || contextBotId) {
        const botId = requestedBotId ?? contextBotId;
        const bot = botConfigs.find(config => config.botId === botId);
        if (!bot) {
            return { error: translate('tools.slackSend.botNotFound', { botId }) };
        }
        if (bot.platform !== 'slack') {
            return { error: translate('tools.slackSend.botNotSlack', { botId }) };
        }
        if (!bot.hasCredentials) {
            return { error: translate('tools.slackSend.botMissingCredentials', { name: bot.displayName }) };
        }
        return { bot };
    }

    const enabledSlackBots = botConfigs.filter(bot =>
        bot.enabled
        && bot.platform === 'slack'
        && bot.hasCredentials
    );

    const agentMatchedBots = context.agentId
        ? enabledSlackBots.filter(bot => bot.agentId === context.agentId)
        : [];

    if (agentMatchedBots.length === 1) {
        return { bot: agentMatchedBots[0] };
    }
    if (agentMatchedBots.length > 1) {
        return {
            error: translate('tools.slackSend.multipleBotsForAgent', {
                list: formatBotList(agentMatchedBots),
            }),
        };
    }
    if (enabledSlackBots.length === 1) {
        return { bot: enabledSlackBots[0] };
    }
    if (enabledSlackBots.length > 1) {
        return {
            error: translate('tools.slackSend.multipleBots', {
                list: formatBotList(enabledSlackBots),
            }),
        };
    }
    return { error: translate('tools.slackSend.noUsableBot') };
}

function formatBotList(bots: BotConfig[]): string {
    return bots
        .map(bot => `- ${bot.displayName} (${bot.botId})`)
        .join('\n');
}

async function resolveTarget(bot: BotConfig, params: Record<string, unknown>): Promise<{ target?: ResolvedTarget; error?: string }> {
    const directChannelId = getStringParam(params, 'channelId', 'channel_id', 'chatId', 'chat_id');
    if (directChannelId) {
        return {
            target: {
                channelId: directChannelId,
                source: 'argument',
            },
        };
    }

    const configuredChannelId = bot.slackDefaultChannelId?.trim();
    if (configuredChannelId) {
        return {
            target: {
                channelId: configuredChannelId,
                source: 'botDefault',
            },
        };
    }

    const activeChat = await readRememberedChat(`im_active_task_${bot.botId}.json`, false);
    if (activeChat?.chatId && activeChat.platform === 'slack') {
        return {
            target: {
                channelId: activeChat.chatId,
                source: 'activeChat',
            },
        };
    }

    const lastChat = await readRememberedChat(`im_last_chat_${bot.botId}.json`, true);
    if (lastChat?.chatId && lastChat.platform === 'slack') {
        return {
            target: {
                channelId: lastChat.chatId,
                source: 'lastChat',
            },
        };
    }

    return {
        error: translate('tools.slackSend.noTarget', {
            name: bot.displayName,
        }),
    };
}

async function readRememberedChat(fileName: string, allowEnded: boolean): Promise<RememberedChatData | null> {
    try {
        const dataDir = await appDataDir();
        const filePath = await join(dataDir, fileName);
        if (!await exists(filePath)) return null;

        const content = await readTextFile(filePath);
        const parsed = JSON.parse(content) as RememberedChatData;
        if (!allowEnded && parsed.ended) return null;
        return parsed.chatId ? parsed : null;
    } catch (error) {
        logger.warn('读取 Slack 会话记忆文件失败', { fileName, error: String(error) });
        return null;
    }
}

async function getBotToken(bot: BotConfig): Promise<string> {
    const credentials = await invoke<ImCredentials>('im_get_bot_credentials', {
        platform: 'slack',
        botId: bot.botId,
    });
    if (!credentials.botToken) {
        throw new Error(translate('tools.slackSend.botMissingCredentials', { name: bot.displayName }));
    }
    return credentials.botToken;
}

async function readLocalFileBase64(
    rawPath: string,
    context: ToolExecutionContext,
): Promise<{ path: string; fileName: string; bytes: Uint8Array; base64: string; mimeType: string }> {
    const path = resolveLocalPath(rawPath, context.workdir);
    const sandboxViolation = getSandboxPathViolation(path, context);
    if (sandboxViolation) {
        const message = sandboxViolation.reason === 'missingWorkdir'
            ? translate('tools.common.sandboxMissingWorkdir', { path })
            : translate('tools.common.sandboxPathDenied', {
                path,
                root: sandboxViolation.root,
                mode: sandboxViolation.mode,
            });
        throw new Error(message);
    }

    if (!await exists(path)) {
        throw new Error(translate('tools.slackSend.fileNotFound', { path }));
    }

    const fileStat = await stat(path);
    if (fileStat.isDirectory) {
        throw new Error(translate('tools.slackSend.directoryNotSupported', { path }));
    }

    const bytes = await readFile(path);
    return {
        path,
        fileName: getFileName(path),
        bytes,
        base64: uint8ArrayToBase64(bytes),
        mimeType: inferMime(getFileName(path)),
    };
}

function resolveLocalPath(path: string, workdir?: string): string {
    const cleaned = path.trim().replace(/^["']|["']$/g, '');
    if (isAbsolutePath(cleaned) || !workdir) {
        return cleaned;
    }
    const separator = workdir.includes('/') && !workdir.includes('\\') ? '/' : '\\';
    return `${workdir.replace(/[\\/]+$/, '')}${separator}${cleaned}`;
}

function isAbsolutePath(path: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(path)
        || path.startsWith('\\\\')
        || path.startsWith('/');
}

function getFileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? 'file';
}

function getExtension(path: string): string {
    const fileName = getFileName(path);
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function inferMime(fileName: string): string {
    const ext = getExtension(fileName).replace(/^\./, '');
    const map: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ppt: 'application/vnd.ms-powerpoint',
        txt: 'text/plain',
        md: 'text/markdown',
        zip: 'application/zip',
    };
    return map[ext] ?? 'application/octet-stream';
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    const chunkSize = 8192;
    let binaryString = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
        binaryString += String.fromCharCode(...chunk);
    }
    return btoa(binaryString);
}

function formatTarget(target: ResolvedTarget): string {
    return `channel=${target.channelId}`;
}

async function postDeletableTextMessage(
    botToken: string,
    channelId: string,
    text: string,
): Promise<string> {
    const payload = buildSlackMessagePayload(buildOutboundMessageCard(text));
    const result = await invoke<{ ts: string }>('slack_post_message', {
        botToken,
        channel: channelId,
        text: payload.text,
        blocks: payload.blocks,
    });
    return result.ts;
}

function formatSource(source: ResolvedTarget['source']): string {
    const key = {
        argument: 'tools.slackSend.sourceArgument',
        botDefault: 'tools.slackSend.sourceBotDefault',
        activeChat: 'tools.slackSend.sourceActiveChat',
        lastChat: 'tools.slackSend.sourceLastChat',
    }[source] as Parameters<typeof translate>[0];
    return translate(key);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function classifySlackSendFailure(error: string): string {
    const normalized = error.toLowerCase();
    const hasAny = (tokens: string[]) => tokens.some(token => normalized.includes(token));

    if (hasAny(['[timeout', '[connect', '[request', 'error sending request', 'request failed', 'network'])) {
        return translate('tools.slackSend.failureHintTransientNetwork');
    }

    if (hasAny(['rate_limited', 'ratelimited', 'too_many_requests'])) {
        return translate('tools.slackSend.failureHintRateLimited');
    }

    if (hasAny(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'missing_scope', 'no_permission', 'access_denied'])) {
        return translate('tools.slackSend.failureHintAuthConfig');
    }

    if (hasAny(['channel_not_found', 'not_in_channel', 'invalid_channel', 'is_archived', 'invalid_arguments', 'invalid_arg_name'])) {
        return translate('tools.slackSend.failureHintTargetConfig');
    }

    if (hasAny(['file_too_large', 'file_uploads_disabled', 'filetype_not_supported', 'cant_upload_file', 'malware'])) {
        return translate('tools.slackSend.failureHintFileRejected');
    }

    return translate('tools.slackSend.failureHintGeneric');
}

function formatFailureObservation(error: string): string {
    return translate('tools.slackSend.executionFailedWithHint', {
        error,
        hint: classifySlackSendFailure(error),
    });
}

async function postFileControlMessage(options: SlackFileControlOptions): Promise<string> {
    const text = options.caption
        ? translate('tools.slackSend.fileControlTextWithCaption', {
            caption: options.caption,
            fileName: options.fileName,
        })
        : translate('tools.slackSend.fileControlText', {
            fileName: options.fileName,
        });
    const blocks = buildFileControlBlocks(options.fileId, options.fileName, options.caption);
    const result = await invoke<{ ts: string }>('slack_post_message', {
        botToken: options.botToken,
        channel: options.channelId,
        text,
        blocks,
    });
    return result.ts;
}

function buildFileControlBlocks(fileId: string, fileName: string, caption: string): Array<Record<string, unknown>> {
    const sectionText = caption
        ? translate('tools.slackSend.fileControlSectionWithCaption', {
            caption: escapeSlackMrkdwn(caption),
            fileName: escapeSlackMrkdwn(fileName),
        })
        : translate('tools.slackSend.fileControlSection', {
            fileName: escapeSlackMrkdwn(fileName),
        });

    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: truncateSlackText(sectionText, 3000),
            },
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: translate('tools.slackSend.deleteFileControlButton'),
                        emoji: true,
                    },
                    style: 'danger',
                    action_id: 'delete_file',
                    value: JSON.stringify({
                        action_id: 'delete_file',
                        file_id: fileId,
                    }),
                },
            ],
        },
    ];
}

function escapeSlackMrkdwn(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function truncateSlackText(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 15)}\n...(truncated)`;
}

class SlackSendToolImpl implements Tool {
    readonly schema = SCHEMA;

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
    ): Promise<ToolResult> {
        if (context.sandboxMode === 'OfflineIsolated') {
            return {
                success: false,
                content: translate('tools.slackSend.sandboxBlocked'),
            };
        }

        const action = normalizeAction(params);
        if (!action) {
            return {
                success: false,
                content: translate('tools.slackSend.invalidAction'),
            };
        }

        const botResolution = resolveBotConfig(params, context);
        if (!botResolution.bot) {
            return {
                success: false,
                content: botResolution.error ?? translate('tools.slackSend.noUsableBot'),
            };
        }

        const targetResolution = await resolveTarget(botResolution.bot, params);
        if (!targetResolution.target) {
            return {
                success: false,
                content: targetResolution.error ?? translate('tools.slackSend.noTarget', { name: botResolution.bot.displayName }),
            };
        }

        if (context.signal?.aborted) {
            return {
                success: false,
                content: translate('tools.slackSend.cancelled'),
            };
        }

        const bot = botResolution.bot;
        const target = targetResolution.target;

        try {
            const botToken = await getBotToken(bot);

            if (action === 'send_text') {
                const text = getStringParam(params, 'text', 'content', 'message');
                if (!text) {
                    return {
                        success: false,
                        content: translate('tools.slackSend.missingText'),
                    };
                }

                context.onProgress?.(translate('tools.slackSend.sendingText', {
                    target: formatTarget(target),
                }));
                const messageId = await postDeletableTextMessage(botToken, target.channelId, text);
                return {
                    success: true,
                    content: translate('tools.slackSend.textSuccess', {
                        bot: bot.displayName,
                        target: formatTarget(target),
                        source: formatSource(target.source),
                        messageId,
                    }),
                    data: {
                        action,
                        botId: bot.botId,
                        channelId: target.channelId,
                        source: target.source,
                        messageId,
                    },
                };
            }

            const rawFilePath = getStringParam(params, 'filePath', 'file_path', 'path');
            if (!rawFilePath) {
                return {
                    success: false,
                    content: translate('tools.slackSend.missingFilePath'),
                };
            }

            const localFile = await readLocalFileBase64(rawFilePath, context);
            if (localFile.bytes.length > FILE_MAX_BYTES) {
                return {
                    success: false,
                    content: translate('tools.slackSend.fileTooLarge', {
                        size: (localFile.bytes.length / 1024 / 1024).toFixed(1),
                    }),
                };
            }

            if (action === 'send_image' && !localFile.mimeType.startsWith('image/')) {
                return {
                    success: false,
                    content: translate('tools.slackSend.notImageFile', { fileName: localFile.fileName }),
                };
            }

            const caption = getStringParam(params, 'text', 'caption', 'message', 'summary') ?? '';
            context.onProgress?.(translate(action === 'send_image' ? 'tools.slackSend.uploadingImage' : 'tools.slackSend.uploadingFile', {
                fileName: localFile.fileName,
                target: formatTarget(target),
            }));
            const result = await invoke<{ fileId: string }>('slack_upload_file_external', {
                botToken,
                channel: target.channelId,
                fileBase64: localFile.base64,
                fileName: localFile.fileName,
                mimeType: localFile.mimeType,
                title: localFile.fileName,
                initialComment: '',
            });
            let controlMessageId: string | undefined;
            let controlWarning = '';
            try {
                controlMessageId = await postFileControlMessage({
                    botToken,
                    channelId: target.channelId,
                    fileId: result.fileId,
                    fileName: localFile.fileName,
                    caption,
                });
            } catch (controlError) {
                const controlErrorMessage = toErrorMessage(controlError);
                logger.warn('Slack 文件删除控制消息发送失败', {
                    action,
                    channelId: target.channelId,
                    fileId: result.fileId,
                    error: controlErrorMessage,
                });
                controlWarning = translate('tools.slackSend.fileControlPostFailed', {
                    error: controlErrorMessage,
                });
            }
            return {
                success: true,
                content: `${translate(action === 'send_image' ? 'tools.slackSend.imageSuccess' : 'tools.slackSend.fileSuccess', {
                    bot: bot.displayName,
                    fileName: localFile.fileName,
                    target: formatTarget(target),
                    source: formatSource(target.source),
                    messageId: result.fileId,
                })}${controlWarning ? `\n${controlWarning}` : ''}`,
                data: {
                    action,
                    botId: bot.botId,
                    channelId: target.channelId,
                    source: target.source,
                    fileId: result.fileId,
                    filePath: localFile.path,
                    controlMessageId,
                },
            };
        } catch (error) {
            const message = toErrorMessage(error);
            logger.error('slack_send 执行失败', { action, error: message });
            return {
                success: false,
                content: formatFailureObservation(message),
                data: {
                    action,
                    botId: bot.botId,
                    channelId: target.channelId,
                    source: target.source,
                    error: message,
                },
            };
        }
    }
}

export const slackSendTool = new SlackSendToolImpl();
