/**
 * SlackChannel - Slack 平台 IM Channel 适配器
 *
 * 通过 Slack Socket Mode 接收入站消息，通过 Rust 后端代理 Slack Web API 发送文本、文件和 Block Kit 卡片。
 */

import type {
  CardActionHandler,
  ConnectionStateHandler,
  ImCardContent,
  ImCardUpdateContext,
  ImChannel,
  ImChannelConfig,
  ImIncomingAttachment,
  ImIncomingMessage,
  MessageHandler,
  SlackChannelConfig,
} from '../types';
import { buildSlackMessagePayload } from './slackBlockBuilder';
import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('SlackChannel');

interface SlackAuthTestResult {
  userId: string;
  botId: string;
  teamId: string;
}

interface SlackSocketResult {
  url: string;
}

interface SlackMessageResult {
  channel: string;
  ts: string;
}

interface SlackSocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: SlackSocketPayload;
}

type SlackSocketPayload =
  | SlackEventCallbackPayload
  | SlackBlockActionPayload
  | Record<string, unknown>;

interface SlackEventCallbackPayload {
  type?: 'event_callback';
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  client_msg_id?: string;
  blocks?: unknown[];
  files?: SlackFile[];
}

interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

interface SlackBlockActionPayload {
  type?: 'block_actions';
  actions?: Array<{
    action_id?: string;
    value?: string;
  }>;
  channel?: {
    id?: string;
  };
  message?: {
    ts?: string;
  };
}

export class SlackChannel implements ImChannel {
  readonly platform = 'slack' as const;

  private readonly botToken: string;
  private readonly appToken: string;
  private connected = false;
  private shouldReconnect = false;
  private socket: WebSocket | null = null;
  private botUserId = '';
  private botMentionIds: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelayMs = 30_000;
  private connectInitiatedAt = 0;
  private readonly processedEnvelopeIds = new Set<string>();
  private readonly fileUrlById = new Map<string, string>();

  private messageHandlers: MessageHandler[] = [];
  private connectionHandlers: ConnectionStateHandler[] = [];
  private cardActionHandlers: CardActionHandler[] = [];

  constructor(config: ImChannelConfig) {
    const slackConfig = config as SlackChannelConfig;
    if (!slackConfig.botToken || !slackConfig.appToken) {
      throw new Error(translate('im.bridge.slackChannelMissingCredentials'));
    }
    this.botToken = slackConfig.botToken;
    this.appToken = slackConfig.appToken;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      logger.warn('Slack Channel 已连接，忽略重复连接请求');
      return;
    }

    this.shouldReconnect = true;
    this.connectInitiatedAt = Date.now();

    try {
      const auth = await invoke<SlackAuthTestResult>('slack_auth_test', {
        botToken: this.botToken,
      });
      this.botUserId = auth.userId;
      this.botMentionIds = uniqueNonEmpty([auth.userId, auth.botId]);

      const socketResult = await invoke<SlackSocketResult>('slack_open_socket_connection', {
        appToken: this.appToken,
      });

      await this.openSocket(socketResult.url);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.notifyConnectionChange(true);
      logger.trace('Slack Socket Mode 已连接');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Slack Socket Mode 连接失败', { error: message });
      this.notifyConnectionChange(false, message);
      this.scheduleReconnect();
      throw error;
    }
  }

  disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    this.connectInitiatedAt = 0;
    this.notifyConnectionChange(false);
    logger.trace('Slack Channel 已断开');
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onConnectionChange(handler: ConnectionStateHandler): void {
    this.connectionHandlers.push(handler);
  }

  onCardAction(handler: CardActionHandler): void {
    this.cardActionHandlers.push(handler);
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const result = await invoke<SlackMessageResult>('slack_post_message', {
      botToken: this.botToken,
      channel: chatId,
      text,
    });
    return result.ts;
  }

  async sendCard(chatId: string, card: ImCardContent): Promise<string> {
    const payload = buildSlackMessagePayload(card);
    const result = await invoke<SlackMessageResult>('slack_post_message', {
      botToken: this.botToken,
      channel: chatId,
      text: payload.text,
      blocks: payload.blocks,
    });
    return result.ts;
  }

  async updateCard(
    messageId: string,
    card: ImCardContent,
    context?: ImCardUpdateContext
  ): Promise<void> {
    const chatId = context?.chatId;
    if (!chatId) {
      throw new Error(translate('im.bridge.slackUpdateMissingChannel'));
    }

    const payload = buildSlackMessagePayload(card);
    await invoke<SlackMessageResult>('slack_update_message', {
      botToken: this.botToken,
      channel: chatId,
      ts: messageId,
      text: payload.text,
      blocks: payload.blocks,
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await invoke<SlackMessageResult>('slack_delete_message', {
      botToken: this.botToken,
      channel: chatId,
      ts: messageId,
    });
  }

  async deleteFile(fileId: string): Promise<void> {
    await invoke('slack_delete_file', {
      botToken: this.botToken,
      fileId,
    });
  }

  async sendImage(chatId: string, imageBase64: string, imageTypeHint: string): Promise<string> {
    const fileName = `image.${imageTypeHint || 'png'}`;
    const result = await invoke<{ fileId: string }>('slack_upload_file_external', {
      botToken: this.botToken,
      channel: chatId,
      fileBase64: imageBase64,
      fileName,
      mimeType: inferImageMime(imageTypeHint),
      title: fileName,
    });
    return result.fileId;
  }

  async sendFile(chatId: string, fileBase64: string, fileName: string): Promise<string> {
    const result = await invoke<{ fileId: string }>('slack_upload_file_external', {
      botToken: this.botToken,
      channel: chatId,
      fileBase64,
      fileName,
      mimeType: inferFileMime(fileName),
      title: fileName,
    });
    return result.fileId;
  }

  async downloadResource(
    _messageId: string,
    fileKey: string,
    _resourceType: 'image' | 'file'
  ): Promise<{ base64: string; mimeType: string }> {
    const url = this.fileUrlById.get(fileKey);
    if (!url) {
      throw new Error(translate('im.bridge.slackFileUrlMissing'));
    }
    const result = await invoke<{ base64: string; mimeType: string }>('slack_download_file', {
      botToken: this.botToken,
      url,
    });
    return result;
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(translate('im.bridge.slackSocketError')));
      socket.onmessage = (event) => this.handleSocketMessage(event.data);
      socket.onclose = () => {
        this.socket = null;
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this.notifyConnectionChange(false);
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private handleSocketMessage(data: unknown): void {
    let envelope: SlackSocketEnvelope;
    try {
      envelope = JSON.parse(String(data)) as SlackSocketEnvelope;
    } catch (error) {
      logger.warn('解析 Slack Socket payload 失败', { error: String(error) });
      return;
    }

    if (envelope.envelope_id) {
      this.ackEnvelope(envelope.envelope_id);
      if (this.processedEnvelopeIds.has(envelope.envelope_id)) {
        return;
      }
      this.recordEnvelope(envelope.envelope_id);
    }

    if (envelope.type === 'hello') {
      logger.info('Slack Socket Mode hello 已收到');
      return;
    }

    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object') return;

    if ((payload as SlackEventCallbackPayload).type === 'event_callback') {
      const eventPayload = payload as SlackEventCallbackPayload;
      logger.info('Slack 收到 Events API 事件', {
        eventId: eventPayload.event_id,
        eventType: eventPayload.event?.type,
        subtype: eventPayload.event?.subtype,
        channel: eventPayload.event?.channel,
        channelType: eventPayload.event?.channel_type,
      });
      this.handleEventCallback(payload as SlackEventCallbackPayload);
      return;
    }

    if ((payload as SlackBlockActionPayload).type === 'block_actions') {
      this.handleBlockAction(payload as SlackBlockActionPayload);
    }
  }

  private ackEnvelope(envelopeId: string): void {
    try {
      this.socket?.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (error) {
      logger.warn('Slack Socket ack 发送失败', { envelopeId, error: String(error) });
    }
  }

  private recordEnvelope(envelopeId: string): void {
    this.processedEnvelopeIds.add(envelopeId);
    const MAX_ENVELOPES = 500;
    if (this.processedEnvelopeIds.size > MAX_ENVELOPES) {
      const first = this.processedEnvelopeIds.values().next().value;
      if (first) this.processedEnvelopeIds.delete(first);
    }
  }

  private handleEventCallback(payload: SlackEventCallbackPayload): void {
    const event = payload.event;
    if (!event?.channel || !event.ts) {
      logger.warn('Slack 事件缺少 channel 或 ts，已忽略', {
        eventId: payload.event_id,
        eventType: event?.type,
        channel: event?.channel,
        ts: event?.ts,
      });
      return;
    }
    if (event.bot_id || event.subtype === 'bot_message') {
      logger.info('Slack 机器人消息已忽略', {
        eventId: payload.event_id,
        subtype: event.subtype,
        botId: event.bot_id,
      });
      return;
    }
    if (!shouldHandleSlackMessageEvent(event.type, event.subtype)) {
      logger.info('Slack 非新消息事件已忽略', {
        eventId: payload.event_id,
        eventType: event.type,
        subtype: event.subtype,
      });
      return;
    }
    if (event.user && event.user === this.botUserId) {
      logger.info('Slack 自己发送的消息已忽略', {
        eventId: payload.event_id,
        user: event.user,
      });
      return;
    }

    const isAppMention = event.type === 'app_mention';
    const isDirectMessage =
      event.type === 'message' && (event.channel_type === 'im' || event.channel.startsWith('D'));
    const rawText = getSlackEventText(event, this.botMentionIds);
    const hasTextMention = slackTextMentionsUser(event.text ?? '', this.botMentionIds);
    const hasBlockMention = slackBlocksMentionUser(event.blocks, this.botMentionIds);
    const mentionedBot = isAppMention || isDirectMessage || hasTextMention || hasBlockMention;
    if (!mentionedBot && event.channel_type !== 'im') {
      logger.info('Slack 非 DM 且未 @bot 的消息已忽略', {
        eventId: payload.event_id,
        eventType: event.type,
        channel: event.channel,
        channelType: event.channel_type,
        botUserId: this.botUserId,
        botMentionIds: this.botMentionIds,
        textPreview: (event.text ?? '').slice(0, 120),
        hasTextMention,
        hasBlockMention,
      });
      return;
    }

    const timestamp = Math.round(parseFloat(event.event_ts ?? event.ts) * 1000);
    if (this.connectInitiatedAt && timestamp > 0 && timestamp < this.connectInitiatedAt) {
      logger.info('忽略 Slack 连接前的旧消息，请在连接成功后重新发送一条新消息', {
        eventId: payload.event_id,
        ts: event.ts,
        messageTime: new Date(timestamp).toLocaleString(),
        connectInitiatedAt: new Date(this.connectInitiatedAt).toLocaleString(),
      });
      return;
    }

    const attachments = this.extractAttachments(event);
    const message: ImIncomingMessage = {
      platform: 'slack',
      messageId: event.client_msg_id ?? `slack:${event.channel}:${event.ts}`,
      chatId: event.channel,
      chatType: isDirectMessage ? 'private' : 'group',
      senderId: event.user ?? '',
      senderName: '',
      content: stripSlackMention(rawText, this.botMentionIds),
      mentionedBot,
      timestamp,
      attachments,
    };

    logger.info('Slack 消息已分发到 IM Bridge', {
      eventId: payload.event_id,
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
      contentPreview: message.content.slice(0, 80),
      attachmentCount: attachments?.length ?? 0,
    });

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Slack 消息处理器执行出错', { error });
      }
    }
  }

  private handleBlockAction(payload: SlackBlockActionPayload): void {
    for (const action of payload.actions ?? []) {
      const actionId = action.action_id;
      if (!actionId) continue;
      const value = parseActionValue(action.value);
      for (const handler of this.cardActionHandlers) {
        try {
          handler(actionId, {
            ...value,
            channel: payload.channel?.id ?? '',
            message_ts: payload.message?.ts ?? '',
          });
        } catch (error) {
          logger.error('Slack 卡片动作处理器执行出错', { error });
        }
      }
    }
  }

  private extractAttachments(event: SlackEvent): ImIncomingAttachment[] | undefined {
    const attachments: ImIncomingAttachment[] = [];
    for (const file of event.files ?? []) {
      if (!file.id) continue;
      const url = file.url_private_download ?? file.url_private;
      if (url) {
        this.fileUrlById.set(file.id, url);
      }
      const mimeType = file.mimetype ?? inferFileMime(file.name ?? file.title ?? '');
      attachments.push({
        fileKey: file.id,
        resourceType: mimeType.startsWith('image/') ? 'image' : 'file',
        fileName: file.name ?? file.title ?? file.id,
        mimeType,
        messageId: event.ts ?? file.id,
        urlPrivate: url,
        size: file.size,
      });
    }
    return attachments.length > 0 ? attachments : undefined;
  }

  private notifyConnectionChange(connected: boolean, error?: string): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected, error);
      } catch (handlerError) {
        logger.error('Slack 连接状态回调执行出错', { error: handlerError });
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs
    );
    logger.trace(`将在 ${delay}ms 后尝试重连 Slack（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // connect() 内部会继续调度重连
      });
    }, delay);
  }
}

type SlackMentionIdInput = string | readonly string[] | undefined;

function getSlackEventText(event: SlackEvent, botMentionIds?: SlackMentionIdInput): string {
  const text = event.text ?? '';
  if (text.trim().length > 0) return text;
  return extractSlackBlockText(event.blocks, botMentionIds);
}

export function slackTextMentionsUser(text: string, userId?: SlackMentionIdInput): boolean {
  const ids = normalizeSlackMentionIds(userId);
  if (ids.length === 0) return false;
  return buildSlackMentionPattern(ids).test(text);
}

export function slackBlocksMentionUser(blocks: unknown, userId?: SlackMentionIdInput): boolean {
  const ids = normalizeSlackMentionIds(userId);
  if (ids.length === 0 || !Array.isArray(blocks)) return false;
  return slackValueMentionsUser(blocks, new Set(ids));
}

export function extractSlackBlockText(blocks: unknown, botUserId?: SlackMentionIdInput): string {
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];
  collectSlackBlockText(blocks, new Set(normalizeSlackMentionIds(botUserId)), parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function stripSlackMention(text: string, botUserId?: SlackMentionIdInput): string {
  const botMentionPattern = buildSlackMentionPattern(normalizeSlackMentionIds(botUserId));
  return text
    .replace(botMentionPattern, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export function shouldHandleSlackMessageEvent(eventType?: string, subtype?: string): boolean {
  if (eventType !== 'message') return true;
  return !subtype || subtype === 'file_share';
}

function normalizeSlackMentionIds(input: SlackMentionIdInput): string[] {
  if (!input) return [];
  if (typeof input === 'string') return uniqueNonEmpty([input]);
  return uniqueNonEmpty(input);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildSlackMentionPattern(ids: readonly string[]): RegExp {
  if (ids.length === 0) {
    return /<@[A-Z0-9]+(?:\|[^>]+)?>/g;
  }

  const alternatives = ids.map(escapeRegExp).join('|');
  return new RegExp(`<@(?:${alternatives})(?:\\|[^>]+)?>`, 'g');
}

function slackValueMentionsUser(value: unknown, userIds: Set<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => slackValueMentionsUser(item, userIds));
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if (record.type === 'user' && typeof record.user_id === 'string' && userIds.has(record.user_id)) {
    return true;
  }

  return Object.values(record).some((item) => {
    if (!item || typeof item !== 'object') return false;
    return slackValueMentionsUser(item, userIds);
  });
}

function collectSlackBlockText(value: unknown, botMentionIds: Set<string>, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSlackBlockText(item, botMentionIds, parts);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') {
    parts.push(record.text);
    return;
  }
  if (record.type === 'user' && typeof record.user_id === 'string') {
    if (!botMentionIds.has(record.user_id)) {
      parts.push(`<@${record.user_id}>`);
    }
    return;
  }

  for (const item of Object.values(record)) {
    if (item && typeof item === 'object') {
      collectSlackBlockText(item, botMentionIds, parts);
    }
  }
}

function parseActionValue(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, item]) => typeof item === 'string')
        .map(([key, item]) => [key, item as string])
    );
  } catch {
    return {};
  }
}

function inferImageMime(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return map[normalized] ?? 'image/png';
}

function inferFileMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
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
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
