/**
 * FeishuSendTool - 原生飞书消息发送工具
 *
 * 通过已配置的 AgentVis 飞书 Bot 凭据发送文本、图片或文件。
 * 支持 cron/IM 上下文自动定位 botId，并支持 Bot 默认出站目标。
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, readFile, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { translate } from '@/i18n';
import { buildOutboundMessageCard } from '@services/im-channel/cardTemplates';
import { buildFeishuCardTextOnly } from '@services/im-channel/platforms/feishuCardBuilder';
import type { BotConfig, FeishuReceiveIdType } from '@services/im-channel/types';
import { useImChannelStore } from '@stores/imChannelStore';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { getSandboxPathViolation } from '../shared/sandboxPath';
import { getLogger } from '@services/logger';

const logger = getLogger('FeishuSendTool');

type FeishuSendAction = 'send_text' | 'send_image' | 'send_file';

interface ImCredentials {
  appId: string;
  appSecret: string;
}

interface TokenResult {
  token: string;
  expire: number;
}

interface ResolvedTarget {
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
  source: 'argument' | 'botDefault' | 'activeChat' | 'lastChat';
}

interface RememberedChatData {
  chatId?: string;
  chatType?: string;
  platform?: string;
  botId?: string;
  agentId?: string | null;
  ended?: boolean;
}

const RECEIVE_ID_TYPES: readonly FeishuReceiveIdType[] = [
  'chat_id',
  'open_id',
  'user_id',
  'union_id',
  'email',
];

const ACTIONS: readonly FeishuSendAction[] = ['send_text', 'send_image', 'send_file'];

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.heic',
]);
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_MAX_BYTES = 30 * 1024 * 1024;

const SCHEMA: ToolSchema = {
  name: 'feishu_send',
  description:
    'Send a text message, image, or local file to Feishu through an AgentVis-configured Feishu bot. ' +
    'When receiveId is omitted, the tool uses the current bot default outbound target, then falls back to the current or last Feishu chat for that bot.',
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
        description:
          'Text content for send_text, or an optional caption/summary sent before send_image/send_file attachments.',
      },
      caption: {
        type: 'string',
        description:
          'Optional caption or status summary to send before an image or file attachment.',
      },
      filePath: {
        type: 'string',
        description: 'Absolute or workdir-relative local file path for send_image or send_file.',
      },
      receiveIdType: {
        type: 'string',
        description:
          'Optional Feishu receiver ID type. Supported: chat_id, open_id, user_id, union_id, email. Defaults to the bot setting or chat_id.',
        enum: ['chat_id', 'open_id', 'user_id', 'union_id', 'email'],
      },
      receiveId: {
        type: 'string',
        description:
          'Optional Feishu receiver ID. Examples: chat_id starting with oc_, open_id, user_id, union_id, or email.',
      },
      botId: {
        type: 'string',
        description:
          'Optional AgentVis Feishu bot ID. Usually omit it; IM and cron contexts inject the correct bot automatically.',
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

function normalizeAction(params: Record<string, unknown>): FeishuSendAction | null {
  const raw = getStringParam(params, 'action', 'type', 'messageType', 'message_type');
  if (raw && ACTIONS.includes(raw as FeishuSendAction)) {
    return raw as FeishuSendAction;
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

function normalizeReceiveIdType(value: string | undefined): FeishuReceiveIdType | null {
  if (!value) return null;
  return RECEIVE_ID_TYPES.includes(value as FeishuReceiveIdType)
    ? (value as FeishuReceiveIdType)
    : null;
}

function resolveBotConfig(
  params: Record<string, unknown>,
  context: ToolExecutionContext
): { bot?: BotConfig; error?: string } {
  const requestedBotId = getStringParam(params, 'botId', 'bot_id');
  const contextBotId = context.imBotId;
  const { botConfigs } = useImChannelStore.getState();

  if (requestedBotId || contextBotId) {
    const botId = requestedBotId ?? contextBotId;
    const bot = botConfigs.find((config) => config.botId === botId);
    if (!bot) {
      return { error: translate('tools.feishuSend.botNotFound', { botId }) };
    }
    if (bot.platform !== 'feishu') {
      return { error: translate('tools.feishuSend.botNotFeishu', { botId }) };
    }
    if (!bot.hasCredentials) {
      return {
        error: translate('tools.feishuSend.botMissingCredentials', { name: bot.displayName }),
      };
    }
    return { bot };
  }

  const enabledFeishuBots = botConfigs.filter(
    (bot) => bot.enabled && bot.platform === 'feishu' && bot.hasCredentials
  );

  const agentMatchedBots = context.agentId
    ? enabledFeishuBots.filter((bot) => bot.agentId === context.agentId)
    : [];

  if (agentMatchedBots.length === 1) {
    return { bot: agentMatchedBots[0] };
  }
  if (agentMatchedBots.length > 1) {
    return {
      error: translate('tools.feishuSend.multipleBotsForAgent', {
        list: formatBotList(agentMatchedBots),
      }),
    };
  }
  if (enabledFeishuBots.length === 1) {
    return { bot: enabledFeishuBots[0] };
  }
  if (enabledFeishuBots.length > 1) {
    return {
      error: translate('tools.feishuSend.multipleBots', {
        list: formatBotList(enabledFeishuBots),
      }),
    };
  }
  return { error: translate('tools.feishuSend.noUsableBot') };
}

function formatBotList(bots: BotConfig[]): string {
  return bots.map((bot) => `- ${bot.displayName} (${bot.botId})`).join('\n');
}

async function resolveTarget(
  params: Record<string, unknown>,
  bot: BotConfig
): Promise<{ target?: ResolvedTarget; error?: string }> {
  const directReceiveId = getStringParam(params, 'receiveId', 'receive_id', 'chatId', 'chat_id');
  if (directReceiveId) {
    const explicitType = normalizeReceiveIdType(
      getStringParam(params, 'receiveIdType', 'receive_id_type')
    );
    const receiveIdType =
      explicitType ?? (getStringParam(params, 'chatId', 'chat_id') ? 'chat_id' : null);
    if (!receiveIdType) {
      return { error: translate('tools.feishuSend.missingReceiveIdType') };
    }
    return {
      target: {
        receiveIdType,
        receiveId: directReceiveId,
        source: 'argument',
      },
    };
  }

  const configuredReceiveId = bot.outboundReceiveId?.trim();
  if (configuredReceiveId) {
    return {
      target: {
        receiveIdType: bot.outboundReceiveIdType ?? 'chat_id',
        receiveId: configuredReceiveId,
        source: 'botDefault',
      },
    };
  }

  const activeChat = await readRememberedChat(`im_active_task_${bot.botId}.json`, false);
  if (activeChat?.chatId) {
    return {
      target: {
        receiveIdType: 'chat_id',
        receiveId: activeChat.chatId,
        source: 'activeChat',
      },
    };
  }

  const lastChat = await readRememberedChat(`im_last_chat_${bot.botId}.json`, true);
  if (lastChat?.chatId) {
    return {
      target: {
        receiveIdType: 'chat_id',
        receiveId: lastChat.chatId,
        source: 'lastChat',
      },
    };
  }

  return {
    error: translate('tools.feishuSend.noTarget', {
      name: bot.displayName,
    }),
  };
}

async function readRememberedChat(
  fileName: string,
  allowEnded: boolean
): Promise<RememberedChatData | null> {
  try {
    const dataDir = await appDataDir();
    const filePath = await join(dataDir, fileName);
    if (!(await exists(filePath))) return null;

    const content = await readTextFile(filePath);
    const parsed = JSON.parse(content) as RememberedChatData;
    if (!allowEnded && parsed.ended) return null;
    return parsed.chatId ? parsed : null;
  } catch (error) {
    logger.warn('读取飞书会话记忆文件失败', { fileName, error: String(error) });
    return null;
  }
}

async function getTenantToken(bot: BotConfig): Promise<string> {
  const credentials = await invoke<ImCredentials>('im_get_bot_credentials', {
    platform: 'feishu',
    botId: bot.botId,
  });
  if (!credentials.appId || !credentials.appSecret) {
    throw new Error(translate('tools.feishuSend.botMissingCredentials', { name: bot.displayName }));
  }

  const tokenResult = await invoke<TokenResult>('feishu_get_token', {
    appId: credentials.appId,
    appSecret: credentials.appSecret,
  });
  return tokenResult.token;
}

async function sendMessage(
  token: string,
  target: ResolvedTarget,
  msgType: string,
  content: string
): Promise<string> {
  const result = await invoke<{ messageId: string }>('feishu_send_message', {
    token,
    chatId: target.receiveId,
    receiveIdType: target.receiveIdType,
    msgType,
    content,
  });
  return result.messageId;
}

async function sendTextCard(token: string, target: ResolvedTarget, text: string): Promise<string> {
  const card = buildFeishuCardTextOnly(buildOutboundMessageCard(text));
  return sendMessage(token, target, 'interactive', JSON.stringify(card));
}

async function readLocalFileBase64(
  rawPath: string,
  context: ToolExecutionContext
): Promise<{ path: string; fileName: string; bytes: Uint8Array; base64: string }> {
  const path = resolveLocalPath(rawPath, context.workdir);
  const sandboxViolation = getSandboxPathViolation(path, context);
  if (sandboxViolation) {
    const message =
      sandboxViolation.reason === 'missingWorkdir'
        ? translate('tools.common.sandboxMissingWorkdir', { path })
        : translate('tools.common.sandboxPathDenied', {
            path,
            root: sandboxViolation.root,
            mode: sandboxViolation.mode,
          });
    throw new Error(message);
  }

  if (!(await exists(path))) {
    throw new Error(translate('tools.feishuSend.fileNotFound', { path }));
  }

  const fileStat = await stat(path);
  if (fileStat.isDirectory) {
    throw new Error(translate('tools.feishuSend.directoryNotSupported', { path }));
  }

  const bytes = await readFile(path);
  return {
    path,
    fileName: getFileName(path),
    bytes,
    base64: uint8ArrayToBase64(bytes),
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
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/');
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'file';
}

function getExtension(path: string): string {
  const fileName = getFileName(path);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function inferFeishuFileType(fileName: string): string {
  const typeMap: Record<string, string> = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.docx': 'doc',
    '.xls': 'xls',
    '.xlsx': 'xls',
    '.ppt': 'ppt',
    '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };

  // Feishu uses "stream" for generic binary files such as archives and text files.
  // Passing archive extensions like "zip" as file_type is rejected as 234001.
  return typeMap[getExtension(fileName)] ?? 'stream';
}

function getMessageTypeForUploadedFile(fileType: string): string {
  if (fileType === 'mp4') return 'media';
  if (fileType === 'opus') return 'audio';
  return 'file';
}

async function sendOptionalAttachmentText(
  params: Record<string, unknown>,
  token: string,
  target: ResolvedTarget,
  context: ToolExecutionContext
): Promise<string | undefined> {
  const text = getStringParam(params, 'text', 'caption', 'message', 'summary');
  if (!text) return undefined;

  context.onProgress?.(
    translate('tools.feishuSend.sendingAttachmentText', {
      target: formatTarget(target),
    })
  );
  return sendTextCard(token, target, text);
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
  return `${target.receiveIdType}=${target.receiveId}`;
}

function formatSource(source: ResolvedTarget['source']): string {
  const key = {
    argument: 'tools.feishuSend.sourceArgument',
    botDefault: 'tools.feishuSend.sourceBotDefault',
    activeChat: 'tools.feishuSend.sourceActiveChat',
    lastChat: 'tools.feishuSend.sourceLastChat',
  }[source] as Parameters<typeof translate>[0];
  return translate(key);
}

function formatFailureHint(source: ResolvedTarget['source']): string {
  if (source === 'botDefault') {
    return translate('tools.feishuSend.failureHintBotDefault');
  }
  if (source === 'argument') {
    return translate('tools.feishuSend.failureHintArgument');
  }
  return translate('tools.feishuSend.failureHintRememberedChat');
}

function formatExecutionFailure(error: string, bot: BotConfig, target: ResolvedTarget): string {
  return translate('tools.feishuSend.executionFailedWithTarget', {
    error,
    bot: bot.displayName,
    target: formatTarget(target),
    source: formatSource(target.source),
    hint: formatFailureHint(target.source),
  });
}

function shouldAttachTargetHint(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes('failed to send feishu message') ||
    normalized.includes('receive_id') ||
    normalized.includes('bot/user')
  );
}

class FeishuSendToolImpl implements Tool {
  readonly schema = SCHEMA;

  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    if (context.sandboxMode === 'OfflineIsolated') {
      return {
        success: false,
        content: translate('tools.feishuSend.sandboxBlocked'),
      };
    }

    const action = normalizeAction(params);
    if (!action) {
      return {
        success: false,
        content: translate('tools.feishuSend.invalidAction'),
      };
    }

    const botResolution = resolveBotConfig(params, context);
    if (!botResolution.bot) {
      return {
        success: false,
        content: botResolution.error ?? translate('tools.feishuSend.noUsableBot'),
      };
    }

    const targetResolution = await resolveTarget(params, botResolution.bot);
    if (!targetResolution.target) {
      return {
        success: false,
        content:
          targetResolution.error ??
          translate('tools.feishuSend.noTarget', { name: botResolution.bot.displayName }),
      };
    }

    if (context.signal?.aborted) {
      return {
        success: false,
        content: translate('tools.feishuSend.cancelled'),
      };
    }

    const bot = botResolution.bot;
    const target = targetResolution.target;

    try {
      const token = await getTenantToken(bot);

      if (action === 'send_text') {
        const text = getStringParam(params, 'text', 'content', 'message');
        if (!text) {
          return {
            success: false,
            content: translate('tools.feishuSend.missingText'),
          };
        }

        context.onProgress?.(
          translate('tools.feishuSend.sendingText', {
            target: formatTarget(target),
          })
        );
        const messageId = await sendTextCard(token, target, text);
        return {
          success: true,
          content: translate('tools.feishuSend.textSuccess', {
            bot: bot.displayName,
            target: formatTarget(target),
            source: formatSource(target.source),
            messageId,
          }),
          data: {
            action,
            botId: bot.botId,
            receiveIdType: target.receiveIdType,
            receiveId: target.receiveId,
            source: target.source,
            messageId,
          },
        };
      }

      const rawFilePath = getStringParam(params, 'filePath', 'file_path', 'path');
      if (!rawFilePath) {
        return {
          success: false,
          content: translate('tools.feishuSend.missingFilePath'),
        };
      }

      const localFile = await readLocalFileBase64(rawFilePath, context);

      if (action === 'send_image') {
        if (localFile.bytes.length > IMAGE_MAX_BYTES) {
          return {
            success: false,
            content: translate('tools.feishuSend.imageTooLarge', {
              size: (localFile.bytes.length / 1024 / 1024).toFixed(1),
            }),
          };
        }

        const imageTypeHint = getExtension(localFile.path).replace(/^\./, '') || 'png';
        const textMessageId = await sendOptionalAttachmentText(params, token, target, context);
        context.onProgress?.(
          translate('tools.feishuSend.uploadingImage', {
            fileName: localFile.fileName,
            target: formatTarget(target),
          })
        );
        const uploadResult = await invoke<{ imageKey: string }>('feishu_upload_image', {
          token,
          imageBase64: localFile.base64,
          imageTypeHint,
        });
        const messageId = await sendMessage(
          token,
          target,
          'image',
          JSON.stringify({ image_key: uploadResult.imageKey })
        );
        const content = translate(
          textMessageId ? 'tools.feishuSend.imageSuccessWithText' : 'tools.feishuSend.imageSuccess',
          {
            bot: bot.displayName,
            fileName: localFile.fileName,
            target: formatTarget(target),
            source: formatSource(target.source),
            messageId,
            textMessageId: textMessageId ?? '',
          }
        );
        return {
          success: true,
          content,
          data: {
            action,
            botId: bot.botId,
            receiveIdType: target.receiveIdType,
            receiveId: target.receiveId,
            source: target.source,
            messageId,
            textMessageId,
            filePath: localFile.path,
          },
        };
      }

      if (localFile.bytes.length > FILE_MAX_BYTES) {
        return {
          success: false,
          content: translate('tools.feishuSend.fileTooLarge', {
            size: (localFile.bytes.length / 1024 / 1024).toFixed(1),
          }),
        };
      }

      const fileType = inferFeishuFileType(localFile.fileName);
      const messageType = getMessageTypeForUploadedFile(fileType);
      const isVideoMessage = messageType === 'media';
      const textMessageId = await sendOptionalAttachmentText(params, token, target, context);

      context.onProgress?.(
        translate(
          isVideoMessage ? 'tools.feishuSend.uploadingVideo' : 'tools.feishuSend.uploadingFile',
          {
            fileName: localFile.fileName,
            target: formatTarget(target),
          }
        )
      );
      const uploadResult = await invoke<{ fileKey: string }>('feishu_upload_file', {
        token,
        fileBase64: localFile.base64,
        fileName: localFile.fileName,
        fileType,
      });
      const messageId = await sendMessage(
        token,
        target,
        messageType,
        JSON.stringify({ file_key: uploadResult.fileKey })
      );
      const successKey = textMessageId
        ? isVideoMessage
          ? 'tools.feishuSend.videoSuccessWithText'
          : 'tools.feishuSend.fileSuccessWithText'
        : isVideoMessage
          ? 'tools.feishuSend.videoSuccess'
          : 'tools.feishuSend.fileSuccess';
      const content = translate(successKey, {
        bot: bot.displayName,
        fileName: localFile.fileName,
        target: formatTarget(target),
        source: formatSource(target.source),
        messageId,
        textMessageId: textMessageId ?? '',
      });
      return {
        success: true,
        content,
        data: {
          action,
          botId: bot.botId,
          receiveIdType: target.receiveIdType,
          receiveId: target.receiveId,
          source: target.source,
          messageId,
          textMessageId,
          filePath: localFile.path,
          fileType,
          messageType,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const targetHintAttached = shouldAttachTargetHint(message);
      logger.error('feishu_send 执行失败', { action, error: message });
      return {
        success: false,
        content: targetHintAttached
          ? formatExecutionFailure(message, bot, target)
          : translate('tools.feishuSend.executionFailed', { error: message }),
        data: {
          action,
          botId: bot.botId,
          receiveIdType: target.receiveIdType,
          receiveId: target.receiveId,
          source: target.source,
          error: message,
          retryable: !targetHintAttached,
          requiresUserAction: targetHintAttached,
        },
      };
    }
  }
}

export const feishuSendTool = new FeishuSendToolImpl();
