/**
 * FeishuChannel - 飞书平台 IM Channel 适配器
 *
 * 通过飞书开放平台 SDK 实现：
 * - WebSocket 长连接接收消息事件（无需公网 Webhook）
 * - REST API 发送消息和更新卡片
 * - Token 自动管理（tenant_access_token）
 *
 * 认证流程：
 * 1. 用户在飞书开放平台创建企业自建应用，获取 App ID + App Secret
 * 2. 应用开启机器人能力，配置事件订阅（WebSocket 模式）
 * 3. 订阅 im.message.receive_v1 事件
 * 4. FeishuChannel 使用 App ID + App Secret 连接 WebSocket
 *
 * 依赖：@larksuiteoapi/node-sdk（飞书官方 Node.js SDK）
 */

import type {
  ImChannel,
  ImChannelConfig,
  FeishuChannelConfig,
  ImIncomingMessage,
  ImCardContent,
  ImCardUpdateContext,
  MessageHandler,
  ConnectionStateHandler,
  CardActionHandler,
} from '../types';
import { buildFeishuCard, buildFeishuCardTextOnly } from './feishuCardBuilder';
import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('FeishuChannel');

interface FeishuWsHeader {
  key: string;
  value: string;
}

interface FeishuWsFrame {
  headers: FeishuWsHeader[];
  payload: Uint8Array;
  [key: string]: unknown;
}

interface FeishuWsClientRuntime {
  dataCache?: {
    mergeData: (data: {
      message_id?: string;
      sum: number;
      seq: number;
      trace_id?: string;
      data: Uint8Array;
    }) => Record<string, unknown> | null;
  };
  eventDispatcher?: {
    invoke: (data: Record<string, unknown>, params: { needCheck: false }) => Promise<unknown>;
  };
  logger?: {
    debug?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  sendMessage?: (data: FeishuWsFrame) => void;
}

interface FeishuWsClientConstructor {
  prototype?: {
    __agentvisCardFramePatched?: boolean;
    handleEventData?: (this: FeishuWsClientRuntime, data: FeishuWsFrame) => Promise<void>;
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 判断错误是否为飞书卡片 JSON 解析失败（code=230099 / ErrCode 200621）
 *
 * 这类错误通常由 table element 字段格式不合规导致，适合触发 text-only fallback。
 * 网络超时、权限不足等其他错误不匹配，不应触发降级，避免掩盖真正的问题。
 */
function isFeishuCardParseError(error: unknown): boolean {
  const msg = String(error);
  return msg.includes('230099') || msg.includes('200621') || msg.includes('parse card json');
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function patchFeishuWsClientCardFrames(WSClient: unknown): void {
  const proto = (WSClient as FeishuWsClientConstructor).prototype;
  if (!proto || proto.__agentvisCardFramePatched || !proto.handleEventData) return;

  const originalHandleEventData = proto.handleEventData;
  proto.handleEventData = async function patchedHandleEventData(
    this: FeishuWsClientRuntime,
    data: FeishuWsFrame
  ): Promise<void> {
    const headers = data.headers.reduce<Record<string, string>>((acc, cur) => {
      acc[cur.key] = cur.value;
      return acc;
    }, {});

    if (headers.type !== 'card') {
      return originalHandleEventData.call(this, data);
    }

    const { message_id: messageId, sum, seq, trace_id: traceId } = headers;
    const mergedData = this.dataCache?.mergeData({
      message_id: messageId,
      sum: Number(sum),
      seq: Number(seq),
      trace_id: traceId,
      data: data.payload,
    });
    if (!mergedData) return;

    const responsePayload: { code: number; data?: string } = { code: 200 };
    const startTime = Date.now();
    try {
      const result = await this.eventDispatcher?.invoke(mergedData, { needCheck: false });
      if (result) {
        responsePayload.data = encodeBase64Utf8(JSON.stringify(result));
      }
    } catch (error) {
      responsePayload.code = 500;
      this.logger?.error?.(
        '[ws]',
        `invoke event callback failed, message_id: ${messageId ?? ''}; trace_id: ${traceId ?? ''}; error: ${String(error)}`
      );
    }

    this.sendMessage?.({
      ...data,
      headers: [...data.headers, { key: 'biz_rt', value: String(Date.now() - startTime) }],
      payload: new TextEncoder().encode(JSON.stringify(responsePayload)),
    });
  };

  proto.__agentvisCardFramePatched = true;
  logger.trace('已修补飞书 SDK WebSocket card 帧响应路径');
}

function buildCardActionAckResponse(): undefined {
  return undefined;
}

function deferCardActionDispatch(dispatch: () => void): void {
  setTimeout(dispatch, 0);
}

// ============================================================================
// 类型定义
// ============================================================================

// 飞书 REST API 调用通过 Rust 后端代理（绕过 Tauri Webview 的 CORS 限制）

/** Token 缓存 */
interface TokenCache {
  token: string;
  expiresAt: number; // Unix ms
}

type FeishuXhrEventHandler = ((this: FeishuProxyXhr, event: Event) => unknown) | null;

interface FeishuProxyXhr {
  readyState: number;
  status: number;
  statusText: string;
  responseText: string;
  response: unknown;
  responseType: XMLHttpRequestResponseType;
  responseURL: string;
  responseXML: Document | null;
  timeout: number;
  withCredentials: boolean;
  upload: EventTarget;

  onreadystatechange: FeishuXhrEventHandler;
  onload: FeishuXhrEventHandler;
  onerror: FeishuXhrEventHandler;
  onloadend: FeishuXhrEventHandler;
  onabort: FeishuXhrEventHandler;
  onprogress: FeishuXhrEventHandler;
  ontimeout: FeishuXhrEventHandler;
  onloadstart: FeishuXhrEventHandler;

  _useProxy: boolean;
  _url: string;
  _method: string;
  _headers: Record<string, string>;
  _realXhr: XMLHttpRequest | null;
  _eventListeners: Record<string, EventListenerOrEventListenerObject[]>;

  open(method: string, url: string | URL, async?: boolean, user?: string, password?: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: Document | XMLHttpRequestBodyInit | null): void;
  abort(): void;
  getResponseHeader(name: string): string | null;
  getAllResponseHeaders(): string;
  overrideMimeType(mime: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  dispatchEvent(event: Event): boolean;
  _fireEvent(type: string): void;

  [handlerName: `on${string}`]: FeishuXhrEventHandler;
}

/**
 * 飞书消息事件体
 *
 * 所有字段标记为 optional 以匹配 SDK 的类型定义，
 * 在 handleMessageEvent 中做空值保护
 */
interface FeishuMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    content?: string;
    message_type?: string;
    mentions?: Array<{
      key?: string;
      id?: { open_id?: string };
      name?: string;
    }>;
    create_time?: string;
  };
}

/**
 * 飞书卡片回调事件体
 *
 * 用户点击卡片上的交互按钮时触发。
 * SDK WebSocket 模式下通过 card.action.trigger 事件接收。
 */
interface FeishuCardActionEvent {
  /** 操作者信息 */
  operator?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  /** 卡片上的按钮动作信息 */
  action?: {
    /** 按钮 value 字段（在 feishuCardBuilder 中设置） */
    value?: Record<string, string>;
    /** 按钮 tag */
    tag?: string;
  };
  /** 触发事件的消息所在会话 */
  open_chat_id?: string;
  /** 触发事件的消息 ID */
  open_message_id?: string;
  /** 触发事件的 token（SDK 自动验证） */
  token?: string;
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
}

// ============================================================================
// FeishuChannel 实现
// ============================================================================

export class FeishuChannel implements ImChannel {
  readonly platform = 'feishu' as const;

  private readonly appId: string;
  private readonly appSecret: string;
  private connected = false;
  private tokenCache: TokenCache | null = null;

  // WebSocket 客户端（飞书 SDK 的 WSClient）
  // 使用 unknown 类型避免编译时硬依赖 SDK
  private wsClient: unknown = null;

  // 回调注册
  private messageHandlers: MessageHandler[] = [];
  private connectionHandlers: ConnectionStateHandler[] = [];
  private cardActionHandlers: CardActionHandler[] = [];

  // 重连控制
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxReconnectDelayMs = 30_000;
  private reconnectAttempts = 0;

  // 本次连接操作开始的时间戳（用于过滤旧消息）
  //
  // 设计原则：如果用“连接完成时间”过滤，则 connect() 本身耗时（通常 2-5s）期间
  // 用户主动发送的消息会因时间戳早于 connectedAt 而被错误过滤。
  // 正确做法：在 connect() 开始时记录时间戳，这样“点击连接后用户发的消息”都会被放行，
  // 而“斩线期间累积的旧消息”（时间戳早于本次点击连接的时刻）会被过滤。
  private connectInitiatedAt = 0;

  constructor(config: ImChannelConfig) {
    const feishuConfig = config as FeishuChannelConfig;
    if (!feishuConfig.appId || !feishuConfig.appSecret) {
      throw new Error(translate('im.bridge.channelMissingCredentials'));
    }
    this.appId = feishuConfig.appId;
    this.appSecret = feishuConfig.appSecret;
  }

  // ═══════════════════════════════════════════════════════════════
  // 连接管理
  // ═══════════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    if (this.connected) {
      logger.warn('飞书 Channel 已连接，忽略重复连接请求');
      return;
    }

    logger.trace('正在连接飞书 WebSocket...');

    // 在 connect() 开始时就记录时间戳，而非等到 WSClient.start() 完成
    // 这是过滤策略的关键：确保“点击连接后用户发送的消息”不会被过滤
    this.connectInitiatedAt = Date.now();

    try {
      // 在导入 SDK 前注入浏览器兼容层
      // querystring polyfill + XHR 代理需要在 SDK 模块初始化之前就位
      this.injectAxiosProxy();

      // 动态导入飞书 SDK，避免未安装时编译报错
      const larkModule = await import('@larksuiteoapi/node-sdk');
      const { Client: LarkClient, EventDispatcher, WSClient } = larkModule;
      patchFeishuWsClientCardFrames(WSClient);

      // 创建飞书客户端（用于后续 API 调用）
      const client = new LarkClient({
        appId: this.appId,
        appSecret: this.appSecret,
        disableTokenCache: false,
      });

      // 创建事件分发器
      // SDK 回调数据为扁平结构：sender/message 在顶层，不包裹在 event 中
      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': (data: FeishuMessageEvent) => {
          this.handleMessageEvent(data);
        },
        // 消息已读回执事件：飞书在用户读取消息时推送，我们无需处理，
        // 注册空处理器仅为静默 SDK 的 "no handle" 警告日志
        'im.message.message_read_v1': (_data: unknown) => {
          // 有意不处理，仅防止 SDK 输出无意义的 warn 日志
        },
        // 卡片按钮回调：用户在飞书卡片上点击交互按钮时触发
        // WebSocket 模式下必须在此注册才能接收（否则报 200340 错误）
        'card.action.trigger': (data: FeishuCardActionEvent) => {
          // 飞书要求先响应卡片回调，再做延迟更新；否则客户端会提示目标回调超时。
          deferCardActionDispatch(() => this.handleCardActionEvent(data));
          return buildCardActionAckResponse();
        },
      });

      // 创建 WebSocket 客户端
      this.wsClient = new WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: larkModule.LoggerLevel.error,
      });

      // 启动 WebSocket 连接（eventDispatcher 作为 start 参数传入）
      await (this.wsClient as InstanceType<typeof WSClient>).start({
        eventDispatcher: dispatcher,
      });

      this.connected = true;
      this.reconnectAttempts = 0;
      this.notifyConnectionChange(true);
      logger.trace('飞书 WebSocket 已连接');

      // 预热 token（确保后续 API 调用不会因 token 获取失败而延迟）
      await this.ensureToken();

      // 保存 client 引用用于后续 API 调用
      (this as unknown as { larkClient: unknown }).larkClient = client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('飞书 WebSocket 连接失败', { error: message });
      this.notifyConnectionChange(false, message);
      this.scheduleReconnect();
      throw error;
    }
  }

  disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.wsClient) {
      try {
        // 飞书 SDK WSClient 没有标准 stop 方法，做安全尝试
        const client = this.wsClient as { stop?: () => void; close?: () => void };
        if (typeof client.stop === 'function') {
          client.stop();
        } else if (typeof client.close === 'function') {
          client.close();
        }
      } catch (error) {
        logger.warn('断开飞书 WebSocket 时出错', { error });
      }
      this.wsClient = null;
    }

    this.connected = false;
    this.connectInitiatedAt = 0;
    this.tokenCache = null;
    this.notifyConnectionChange(false);
    logger.trace('飞书 Channel 已断开');
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ═══════════════════════════════════════════════════════════════
  // 事件监听
  // ═══════════════════════════════════════════════════════════════

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onConnectionChange(handler: ConnectionStateHandler): void {
    this.connectionHandlers.push(handler);
  }

  onCardAction(handler: CardActionHandler): void {
    this.cardActionHandlers.push(handler);
  }

  // ═══════════════════════════════════════════════════════════════
  // 消息发送
  // ═══════════════════════════════════════════════════════════════

  async sendText(chatId: string, text: string): Promise<string> {
    const token = await this.ensureToken();

    const result = await invoke<{ messageId: string }>('feishu_send_message', {
      token,
      chatId,
      msgType: 'text',
      content: JSON.stringify({ text }),
    });

    return result.messageId;
  }

  async sendCard(chatId: string, card: ImCardContent): Promise<string> {
    const token = await this.ensureToken();

    // 第一次尝试：完整卡片（含 table 转换）
    try {
      const cardJson = buildFeishuCard(card);
      const result = await invoke<{ messageId: string }>('feishu_send_message', {
        token,
        chatId,
        msgType: 'interactive',
        content: JSON.stringify(cardJson),
      });
      return result.messageId;
    } catch (primaryError) {
      // 若是飞书卡片解析错误（如 table 格式边界问题），降级为纯文本卡片重试
      if (isFeishuCardParseError(primaryError)) {
        logger.warn('发送完整卡片失败（解析错误），降级为纯文本卡片重试', {
          error: String(primaryError),
        });
        const fallbackJson = buildFeishuCardTextOnly(card);
        const result = await invoke<{ messageId: string }>('feishu_send_message', {
          token,
          chatId,
          msgType: 'interactive',
          content: JSON.stringify(fallbackJson),
        });
        return result.messageId;
      }
      // 其他错误（网络/权限等）直接抛出
      throw primaryError;
    }
  }

  async updateCard(
    messageId: string,
    card: ImCardContent,
    context?: ImCardUpdateContext
  ): Promise<void> {
    const updateToken = context?.feishuCardUpdateToken;
    if (updateToken) {
      try {
        const cardJson = buildFeishuCard(card);
        await this.updateCardByInteractionToken(updateToken, cardJson);
        return;
      } catch (primaryError) {
        if (isFeishuCardParseError(primaryError)) {
          logger.warn('飞书 delayed update 完整卡片解析失败，降级为纯文本卡片重试', {
            error: String(primaryError),
          });
          const fallbackJson = buildFeishuCardTextOnly(card);
          await this.updateCardByInteractionToken(updateToken, fallbackJson);
          return;
        }

        logger.warn('飞书 delayed update 失败，回退到普通消息更新', {
          error: String(primaryError),
        });
      }
    }

    const token = await this.ensureToken();

    // 第一次尝试：完整卡片（含 table 转换）
    try {
      const cardJson = buildFeishuCard(card);
      await invoke('feishu_update_message', {
        token,
        messageId,
        content: JSON.stringify(cardJson),
      });
      return;
    } catch (primaryError) {
      // 若是飞书卡片解析错误，降级为纯文本卡片重试，确保完成卡片一定能送达
      // —— 避免手机端永久卡在"正在执行任务..."状态
      if (isFeishuCardParseError(primaryError)) {
        logger.warn('更新完整卡片失败（解析错误），降级为纯文本卡片重试', {
          error: String(primaryError),
        });
        const fallbackJson = buildFeishuCardTextOnly(card);
        await invoke('feishu_update_message', {
          token,
          messageId,
          content: JSON.stringify(fallbackJson),
        });
        return;
      }
      throw primaryError;
    }
  }

  private async updateCardByInteractionToken(
    updateToken: string,
    cardJson: Record<string, unknown>
  ): Promise<void> {
    const token = await this.ensureToken();
    const result = await invoke<{ status: number; headers: Record<string, string>; body: string }>(
      'feishu_http_proxy',
      {
        request: {
          url: 'https://open.feishu.cn/open-apis/interactive/v1/card/update',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            token: updateToken,
            card: cardJson,
          }),
        },
      }
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Feishu delayed update failed, HTTP status: ${result.status}`);
    }

    let response: { code?: number; msg?: string };
    try {
      response = JSON.parse(result.body) as { code?: number; msg?: string };
    } catch {
      throw new Error(
        `Feishu delayed update returned non-JSON response: ${result.body.slice(0, 200)}`
      );
    }

    if (response.code !== 0) {
      throw new FeishuApiError(
        'Feishu delayed update failed',
        response.code ?? -1,
        response.msg ?? 'unknown error'
      );
    }
  }

  async sendImage(chatId: string, imageBase64: string, imageTypeHint: string): Promise<string> {
    const token = await this.ensureToken();

    // 第一步：上传图片到飞书，获取 image_key
    const uploadResult = await invoke<{ imageKey: string }>('feishu_upload_image', {
      token,
      imageBase64,
      imageTypeHint,
    });

    // 第二步：用 image_key 发送 msg_type=image 的消息
    const result = await invoke<{ messageId: string }>('feishu_send_message', {
      token,
      chatId,
      msgType: 'image',
      content: JSON.stringify({ image_key: uploadResult.imageKey }),
    });

    return result.messageId;
  }

  async sendFile(
    chatId: string,
    fileBase64: string,
    fileName: string,
    fileType: string
  ): Promise<string> {
    const token = await this.ensureToken();

    // 第一步：上传文件到飞书，获取 file_key
    const uploadResult = await invoke<{ fileKey: string }>('feishu_upload_file', {
      token,
      fileBase64,
      fileName,
      fileType,
    });

    // 第二步：用 file_key 发送 msg_type=file 的消息
    const result = await invoke<{ messageId: string }>('feishu_send_message', {
      token,
      chatId,
      msgType: 'file',
      content: JSON.stringify({ file_key: uploadResult.fileKey }),
    });

    return result.messageId;
  }

  async deleteMessage(_chatId: string, messageId: string): Promise<void> {
    const token = await this.ensureToken();

    await invoke('feishu_delete_message', {
      token,
      messageId,
    });
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: 'image' | 'file'
  ): Promise<{ base64: string; mimeType: string }> {
    const token = await this.ensureToken();

    const result = await invoke<{ base64: string; mimeType: string }>('feishu_download_resource', {
      token,
      messageId,
      fileKey,
      resourceType,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部：消息事件处理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 处理飞书消息事件
   *
   * 从飞书事件体中提取文本内容，转换为平台无关的 ImIncomingMessage。
   * SDK 事件数据所有字段为 optional，需逐一做空值保护。
   */
  private handleMessageEvent(event: FeishuMessageEvent): void {
    try {
      const { sender, message } = event;

      // 基本字段校验
      if (!message?.message_id || !message.chat_id) {
        logger.trace('消息事件缺少必要字段，忽略');
        return;
      }

      const messageType = message.message_type ?? 'unknown';

      // 目前支持的消息类型：text（文本）、image（图片）、file（文件）
      if (!['text', 'image', 'file'].includes(messageType)) {
        logger.trace(`忽略不支持的消息类型: ${messageType}`);
        return;
      }

      // 解析消息内容
      let contentObj: Record<string, string> = {};
      try {
        contentObj = JSON.parse(message.content ?? '{}') as Record<string, string>;
      } catch {
        logger.warn('消息 content 解析失败，使用空对象');
      }

      // 检测是否 @了机器人
      const mentions = message.mentions ?? [];
      const mentionedBot = mentions.length > 0;

      // ── 文本消息处理 ─────────────────────────────────────────
      let text = '';
      let attachments: import('../types').ImIncomingAttachment[] | undefined;

      if (messageType === 'text') {
        text = contentObj.text ?? '';
        // 移除 @mention 标记（飞书格式为 @_user_x）
        for (const mention of mentions) {
          if (mention.key) {
            text = text.replace(mention.key, '').trim();
          }
        }

        // 群聊中未 @ 机器人的文本消息忽略
        if (message.chat_type === 'group' && !mentionedBot) {
          return;
        }
      } else if (messageType === 'image') {
        // ── 图片消息处理 ─────────────────────────────────────
        const imageKey = contentObj.image_key ?? '';
        if (!imageKey) {
          logger.warn('图片消息缺少 image_key，忽略');
          return;
        }
        text = translate('im.bridge.imagePlaceholder');
        attachments = [
          {
            fileKey: imageKey,
            resourceType: 'image',
            messageId: message.message_id,
          },
        ];

        // 群聊图片消息也需要 @ 机器人
        if (message.chat_type === 'group' && !mentionedBot) {
          return;
        }
      } else if (messageType === 'file') {
        // ── 文件消息处理 ─────────────────────────────────────
        const fileKey = contentObj.file_key ?? '';
        const fileName = contentObj.file_name ?? translate('im.bridge.unknownFile');
        if (!fileKey) {
          logger.warn('文件消息缺少 file_key，忽略');
          return;
        }
        text = translate('im.bridge.filePlaceholder', { fileName });
        attachments = [
          {
            fileKey,
            resourceType: 'file',
            fileName,
            messageId: message.message_id,
          },
        ];

        // 群聊文件消息也需要 @ 机器人
        if (message.chat_type === 'group' && !mentionedBot) {
          return;
        }
      }

      // 过滤重连时 SDK 重播的历史旧消息
      // 使用 connectInitiatedAt（点击连接的时刻）而非 connectedAt（连接完成时刻）：
      // - WSClient.start() 本身耗时 2-5s，期间用户发的消息时间戳必然早于 connectedAt
      //   → 若用 connectedAt 会把"连接中"期间的新消息错误过滤掉（原始 bug）
      // - 用 connectInitiatedAt 则精确区分：点击连接前的消息=旧消息，之后的=新消息
      // - 断线期间累积的大量旧消息（时间戳早于本次点击连接的时刻）全部被过滤 ✅
      // - 点击连接后发的消息（含建立连接过程中排队的）全部放行 ✅
      const messageTimestamp = parseInt(message.create_time ?? '0', 10);
      if (
        this.connectInitiatedAt > 0 &&
        messageTimestamp > 0 &&
        messageTimestamp < this.connectInitiatedAt
      ) {
        logger.trace('过滤断线期间累积的历史消息（早于本次连接操作发起时刻）', {
          messageId: message.message_id,
          messageTime: new Date(messageTimestamp).toLocaleTimeString(),
          connectInitiatedAt: new Date(this.connectInitiatedAt).toLocaleTimeString(),
        });
        return;
      }

      const incomingMessage: ImIncomingMessage = {
        platform: 'feishu',
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type === 'p2p' ? 'private' : 'group',
        senderId: sender?.sender_id?.open_id ?? '',
        senderName: '', // 飞书事件不直接包含用户名，需要额外 API 调用
        content: text,
        mentionedBot,
        timestamp: parseInt(message.create_time ?? '0', 10),
        attachments,
      };

      // 通知所有注册的消息处理器
      for (const handler of this.messageHandlers) {
        try {
          handler(incomingMessage);
        } catch (handlerError) {
          logger.error('消息处理器执行出错', { error: handlerError });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('解析飞书消息事件出错', { error: errorMsg });
    }
  }

  /**
   * 处理飞书卡片按钮回调事件
   *
   * 从卡片回调数据中提取 action_id 和 value，转发给注册的 cardActionHandlers。
   * 用于实现"终止任务"等卡片上的交互按钮。
   */
  private handleCardActionEvent(event: FeishuCardActionEvent): void {
    try {
      const actionValue = event.action?.value;
      if (!actionValue) {
        logger.trace('卡片回调缺少 action.value，忽略');
        return;
      }

      // action_id 存储在 value 对象中（feishuCardBuilder 将 actionId 放在 value.action_id）
      const actionId = actionValue.action_id;
      const openChatId = event.open_chat_id ?? event.context?.open_chat_id;
      const openMessageId = event.open_message_id ?? event.context?.open_message_id;
      const callbackToken = event.token;
      const actionContext: Record<string, string> = {
        ...actionValue,
        ...(openChatId
          ? {
              open_chat_id: openChatId,
              channel: openChatId,
            }
          : {}),
        ...(openMessageId
          ? {
              open_message_id: openMessageId,
              message_ts: openMessageId,
              ...(actionValue.message_id ? {} : { message_id: openMessageId }),
            }
          : {}),
        ...(callbackToken
          ? {
              callback_token: callbackToken,
              feishu_card_update_token: callbackToken,
            }
          : {}),
      };
      if (!actionId) {
        logger.trace('卡片回调缺少 action_id，忽略');
        return;
      }

      logger.trace('收到飞书卡片回调', {
        actionId,
        value: actionContext,
        operator: event.operator?.open_id,
      });

      // 转发给所有注册的卡片动作处理器
      for (const handler of this.cardActionHandlers) {
        try {
          handler(actionId, actionContext);
        } catch (handlerError) {
          logger.error('卡片动作处理器执行出错', { error: handlerError });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('处理飞书卡片回调事件出错', { error: errorMsg });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部：Token 管理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 确保有有效的 tenant_access_token
   *
   * 飞书 token 有效期为 2 小时，提前 5 分钟刷新。
   * 通过 Rust 后端代理请求，绕过 CORS 限制。
   */
  private async ensureToken(): Promise<string> {
    const now = Date.now();
    // Token 仍在有效期内（提前 5 分钟刷新）
    const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.tokenCache.token;
    }

    logger.trace('正在刷新飞书 tenant_access_token...');

    const result = await invoke<{ token: string; expire: number }>('feishu_get_token', {
      appId: this.appId,
      appSecret: this.appSecret,
    });

    this.tokenCache = {
      token: result.token,
      expiresAt: now + result.expire * 1000,
    };

    logger.trace('飞书 token 刷新成功');
    return this.tokenCache.token;
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部：连接状态通知与重连
  // ═══════════════════════════════════════════════════════════════

  private notifyConnectionChange(connected: boolean, error?: string): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected, error);
      } catch (handlerError) {
        logger.error('连接状态回调执行出错', { error: handlerError });
      }
    }
  }

  /** 指数退避重连 */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs
    );

    logger.trace(`将在 ${delay}ms 后尝试重连（第 ${this.reconnectAttempts} 次）`);

    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.connect();
        } catch {
          // connect() 内部会再次调用 scheduleReconnect
        }
      })();
    }, delay);
  }

  /**
   * 注入全局 XMLHttpRequest 代理
   *
   * 飞书 SDK 的 WSClient 内部使用 axios（底层走 XMLHttpRequest）
   * 向 open.feishu.cn 发送 HTTP 请求协商 WebSocket 端点。
   * 在 Tauri Webview 中这些请求被 CORS 策略阻拦。
   *
   * 解决方案：拦截 XMLHttpRequest.open/send，将匹配 open.feishu.cn 的
   * 请求转发到 Rust 后端的 feishu_http_proxy 命令执行。
   */
  private injectAxiosProxy(): void {
    // 避免重复注入
    if ((window as unknown as Record<string, boolean>).__feishuXhrProxyInjected) {
      return;
    }

    // ─── Buffer polyfill ───────────────────────────────────────────────────
    // 飞书 SDK 是为 Node.js 设计的，内部使用全局 Buffer 进行消息编解码。
    // Tauri Webview（浏览器环境）没有 Buffer，会导致 "ReferenceError: Buffer is not defined"。
    // 用 TextEncoder/TextDecoder（utf-8）+ atob/btoa（base64）实现最小兼容集。
    if (typeof (window as unknown as Record<string, unknown>).Buffer === 'undefined') {
      const BufferPolyfill = {
        from(
          data: string | Uint8Array | number[],
          encoding?: string
        ): Uint8Array & { toString(enc?: string): string } {
          let bytes: Uint8Array;
          if (typeof data === 'string') {
            if (encoding === 'base64') {
              const binary = atob(data);
              bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
            } else {
              // 默认 utf-8
              bytes = new TextEncoder().encode(data);
            }
          } else if (Array.isArray(data)) {
            bytes = new Uint8Array(data);
          } else {
            bytes = data;
          }
          // 附加 toString 方法，供 SDK 调用
          const result = bytes as Uint8Array & { toString(enc?: string): string };
          result.toString = (enc?: string): string => {
            if (enc === 'base64') {
              let binary = '';
              bytes.forEach((b) => {
                binary += String.fromCharCode(b);
              });
              return btoa(binary);
            }
            return new TextDecoder().decode(bytes);
          };
          return result;
        },
        concat(list: Uint8Array[]): Uint8Array & { toString(enc?: string): string } {
          const total = list.reduce((acc, b) => acc + b.length, 0);
          const result = new Uint8Array(total) as Uint8Array & { toString(enc?: string): string };
          let offset = 0;
          for (const b of list) {
            result.set(b, offset);
            offset += b.length;
          }
          result.toString = (enc?: string): string => BufferPolyfill.from(result).toString(enc);
          return result;
        },
        isBuffer(obj: unknown): boolean {
          return obj instanceof Uint8Array;
        },
        alloc(size: number, fill = 0): Uint8Array {
          return new Uint8Array(size).fill(fill);
        },
      };
      (window as unknown as Record<string, unknown>).Buffer = BufferPolyfill;
      logger.trace('[FeishuChannel] Buffer polyfill 已注入（用于飞书 SDK 消息编解码）');
    }

    const OriginalXHR = window.XMLHttpRequest;

    // 创建统一的代理 XHR 构造函数
    // 关键：axios 持有的 `request` 闭包变量指向这个包装器对象
    // 所有属性读写（readyState/status/response/回调）都发生在这个包装器上
    const ProxiedXHR = function () {
      const wrapper: FeishuProxyXhr = {
        // === 可变状态 ===
        readyState: 0,
        status: 0,
        statusText: '',
        responseText: '',
        response: '',
        responseType: '',
        responseURL: '',
        responseXML: null,
        timeout: 0,
        withCredentials: false,
        upload: new EventTarget(),

        // === 回调属性（axios 直接设置这些） ===
        onreadystatechange: null,
        onload: null,
        onerror: null,
        onloadend: null,
        onabort: null,
        onprogress: null,
        ontimeout: null,
        onloadstart: null,

        // === 内部状态 ===
        _useProxy: false,
        _url: '',
        _method: '',
        _headers: {} as Record<string, string>,
        _realXhr: null as XMLHttpRequest | null,
        _eventListeners: {} as Record<string, Array<EventListenerOrEventListenerObject>>,

        // === 方法 ===
        open(method: string, url: string | URL, async = true, user?: string, password?: string) {
          const urlStr = typeof url === 'string' ? url : url.toString();
          if (urlStr.includes('open.feishu.cn')) {
            // 飞书请求：走 Rust 代理
            wrapper._useProxy = true;
            wrapper._url = urlStr;
            wrapper._method = method;
            wrapper._headers = {};
            wrapper.readyState = 1; // OPENED
          } else {
            // 非飞书请求：委托给真实 XHR
            wrapper._useProxy = false;
            const realXhr = new OriginalXHR();
            wrapper._realXhr = realXhr;

            // 将真实 XHR 的事件转发到 wrapper（触发 axios 的闭包回调）
            realXhr.onreadystatechange = () => {
              wrapper.readyState = realXhr.readyState;
              if (realXhr.readyState >= 2) {
                wrapper.status = realXhr.status;
                wrapper.statusText = realXhr.statusText;
              }
              if (realXhr.readyState === 4) {
                wrapper.responseText = realXhr.responseText;
                wrapper.response = realXhr.response as unknown;
                wrapper.responseURL = realXhr.responseURL;
              }
              wrapper._fireEvent('readystatechange');
            };
            realXhr.onload = () => wrapper._fireEvent('load');
            realXhr.onerror = () => wrapper._fireEvent('error');
            realXhr.onloadend = () => wrapper._fireEvent('loadend');
            realXhr.onabort = () => wrapper._fireEvent('abort');
            realXhr.ontimeout = () => wrapper._fireEvent('timeout');
            realXhr.onprogress = () => wrapper._fireEvent('progress');

            realXhr.open(method, url, async, user, password);
          }
        },

        setRequestHeader(name: string, value: string) {
          if (wrapper._useProxy) {
            wrapper._headers[name] = value;
          } else if (wrapper._realXhr) {
            try {
              wrapper._realXhr.setRequestHeader(name, value);
            } catch {
              // 忽略 "Refused to set unsafe header"
            }
          }
        },

        send(body?: Document | XMLHttpRequestBodyInit | null) {
          if (wrapper._useProxy) {
            // 飞书请求：通过 Rust 后端代理
            invoke<{ status: number; headers: Record<string, string>; body: string }>(
              'feishu_http_proxy',
              {
                request: {
                  url: wrapper._url,
                  headers: wrapper._headers,
                  body: typeof body === 'string' ? body : '',
                },
              }
            )
              .then((result) => {
                wrapper.status = result.status;
                wrapper.statusText = result.status === 200 ? 'OK' : 'Error';
                wrapper.responseText = result.body;
                wrapper.response = result.body;
                wrapper.responseURL = wrapper._url;
                wrapper.readyState = 4; // DONE

                wrapper._fireEvent('readystatechange');
                wrapper._fireEvent('load');
                wrapper._fireEvent('loadend');
              })
              .catch(() => {
                wrapper.readyState = 4;
                wrapper.status = 0;
                wrapper._fireEvent('readystatechange');
                wrapper._fireEvent('error');
                wrapper._fireEvent('loadend');
              });
          } else if (wrapper._realXhr) {
            if (wrapper.responseType) {
              wrapper._realXhr.responseType = wrapper.responseType;
            }
            wrapper._realXhr.timeout = wrapper.timeout;
            wrapper._realXhr.withCredentials = wrapper.withCredentials;
            wrapper._realXhr.send(body);
          }
        },

        abort() {
          if (wrapper._realXhr) {
            wrapper._realXhr.abort();
          }
          wrapper.readyState = 0;
          wrapper._fireEvent('abort');
        },

        getResponseHeader(name: string): string | null {
          if (wrapper._realXhr) return wrapper._realXhr.getResponseHeader(name);
          if (name.toLowerCase() === 'content-type') return 'application/json';
          return null;
        },

        getAllResponseHeaders(): string {
          if (wrapper._realXhr) return wrapper._realXhr.getAllResponseHeaders();
          return 'content-type: application/json\r\n';
        },

        overrideMimeType(mime: string) {
          if (wrapper._realXhr) wrapper._realXhr.overrideMimeType(mime);
        },

        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          wrapper._eventListeners[type] ??= [];
          wrapper._eventListeners[type].push(listener);
        },

        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          const listeners = wrapper._eventListeners[type];
          if (listeners) {
            wrapper._eventListeners[type] = listeners.filter(
              (l: EventListenerOrEventListenerObject) => l !== listener
            );
          }
        },

        dispatchEvent(event: Event): boolean {
          wrapper._fireEvent(event.type);
          return true;
        },

        // 内部：触发事件
        _fireEvent(type: string) {
          const handler = wrapper[`on${type}`];
          if (typeof handler === 'function') {
            handler.call(wrapper, new Event(type));
          }
          const listeners = wrapper._eventListeners[type] ?? [];
          for (const listener of listeners) {
            if (typeof listener === 'function') {
              listener.call(wrapper, new Event(type));
            } else if (typeof listener.handleEvent === 'function') {
              listener.handleEvent(new Event(type));
            }
          }
        },
      };

      return wrapper as unknown as XMLHttpRequest;
    } as unknown as typeof XMLHttpRequest;

    // 保留静态常量
    Object.defineProperty(ProxiedXHR, 'DONE', { value: 4 });
    Object.defineProperty(ProxiedXHR, 'HEADERS_RECEIVED', { value: 2 });
    Object.defineProperty(ProxiedXHR, 'LOADING', { value: 3 });
    Object.defineProperty(ProxiedXHR, 'OPENED', { value: 1 });
    Object.defineProperty(ProxiedXHR, 'UNSENT', { value: 0 });
    ProxiedXHR.prototype = OriginalXHR.prototype;

    // 全局替换 XMLHttpRequest
    (window as unknown as Record<string, unknown>).XMLHttpRequest = ProxiedXHR;
    (window as unknown as Record<string, boolean>).__feishuXhrProxyInjected = true;

    logger.trace('飞书 XHR 代理已注入（open.feishu.cn 请求将通过 Rust 后端转发）');
  }
}

// ============================================================================
// 飞书 API 错误
// ============================================================================

export class FeishuApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly apiMessage: string
  ) {
    super(`${message} [code=${code}]: ${apiMessage}`);
    this.name = 'FeishuApiError';
  }
}
