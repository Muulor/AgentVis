/**
 * IM Channel - 核心类型定义
 *
 * 定义 IM 通道的工厂接口和事件类型，支持多平台扩展。
 * 当前实现：飞书（Feishu/Lark）
 *
 * 设计原则：
 * - 工厂模式：新平台只需实现 ImChannel 接口并注册到 ImChannelFactory
 * - 事件驱动：通过回调处理消息和连接状态变化
 * - 与 Agent 执行解耦：ImChannel 只负责消息收发，任务触发由 ImTaskBridge 处理
 */

// ============================================================================
// 平台标识
// ============================================================================

/** 支持的 IM 平台标识（可扩展） */
export type ImPlatform = 'feishu' | 'slack' | 'dingtalk' | 'telegram';

/** 飞书发送消息接口支持的接收者 ID 类型 */
export type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

// ============================================================================
// 多 Bot 配置
// ============================================================================

/** 单个机器人实例的完整配置（凭据 + Agent 绑定） */
export interface BotConfig {
  /** Bot 唯一标识（前端生成 UUID，稳定标识 Keystore 凭据） */
  botId: string;
  /** 用户自定义显示名称（如"客服机器人"、"研究助手"） */
  displayName: string;
  /** IM 平台 */
  platform: ImPlatform;
  /** 绑定的 Hub ID（用于筛选可用 Agent） */
  hubId: string | null;
  /** 绑定的 Agent ID（消息路由目标） */
  agentId: string | null;
  /** 是否启用此 Bot */
  enabled: boolean;
  /**
   * 默认出站接收者 ID 类型
   *
   * 用于 cron 或非 IM 触发任务主动向飞书发送消息。
   * 未配置时 im_send 工具会回退到当前/最近一次 IM 会话。
   */
  outboundReceiveIdType?: FeishuReceiveIdType | null;
  /** 默认出站接收者 ID（chat_id/open_id/user_id/union_id/email） */
  outboundReceiveId?: string | null;
  /**
   * Slack 默认主动发送 Channel ID
   *
   * 用于 cron 或非 IM 触发任务主动向 Slack 发送消息。
   * 未配置时 im_send 工具会回退到当前/最近一次 IM 会话。
   */
  slackDefaultChannelId?: string | null;
  /**
   * 凭据是否已保存到 Keystore
   *
   * 在 handleSaveBotConfig 成功后置 true，删除 Bot 时随配置一并清理。
   * 用于在卡片折叠状态下显示正确的凭据状态，避免每次都展开才能读到。
   */
  hasCredentials: boolean;
}

/**
 * 单平台最大 Bot 实例数上限
 *
 * 飞书 WebSocket 连接数有限制，10 个足够覆盖绝大多数团队使用场景。
 */
export const MAX_BOT_COUNT = 10;

// ============================================================================
// 消息类型
// ============================================================================

/** IM 收到的消息 */
export interface ImIncomingMessage {
  /** 来源平台 */
  platform: ImPlatform;
  /** 平台原始消息 ID */
  messageId: string;
  /** 会话 ID（群聊/私聊） */
  chatId: string;
  /** 会话类型 */
  chatType: 'private' | 'group';
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称 */
  senderName: string;
  /** 纯文本内容（去除 @mention 后的文本） */
  content: string;
  /** 是否 @了机器人（群聊场景） */
  mentionedBot: boolean;
  /** 消息时间戳（ms） */
  timestamp: number;
  /** 附件列表（图片/文件消息） */
  attachments?: ImIncomingAttachment[];
}

/**
 * IM 收到的附件信息
 *
 * 当用户通过飞书发送图片或文件消息时，
 * 解析结果填充此类型：后续由 ImTaskBridge 下载并将路径注入 Agent Prompt。
 */
export interface ImIncomingAttachment {
  /** 飞书资源 Key（image_key 或 file_key） */
  fileKey: string;
  /** 资源类型 */
  resourceType: 'image' | 'file';
  /** 原始文件名（仅 file 类型可用） */
  fileName?: string;
  /** MIME 类型（如果已知） */
  mimeType?: string;
  /** 原始飞书 message_id（用于下载 API） */
  messageId: string;
  /** Slack 私有下载 URL（Slack 文件事件可用） */
  urlPrivate?: string;
  /** 文件大小（字节，Slack 文件事件可用） */
  size?: number;
}

/** Agent 执行进度事件类型 */
export type ImProgressEventType =
  | 'task_start' // 任务开始
  | 'thinking' // 思维链阶段
  | 'decision' // MB 决策
  | 'sub_agent' // Sub-Agent 生命周期
  | 'tool_call' // 工具调用
  | 'state_change' // FSM 状态变化
  | 'task_complete' // 任务完成
  | 'task_error'; // 任务出错

/** Agent 执行进度事件（推送到 IM） */
export interface ImProgressEvent {
  /** 事件类型 */
  type: ImProgressEventType;
  /** 展示内容 */
  content: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 附加数据（如 FSM 状态、预算等） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 消息卡片
// ============================================================================

/**
 * IM 卡片内容（平台无关的抽象表示）
 *
 * 各平台适配器负责将此结构转换为平台特定格式
 */
export interface ImCardContent {
  /** 卡片标题 */
  title: string;
  /** 卡片主体内容段落 */
  sections: ImCardSection[];
  /** 底部操作按钮 */
  actions?: ImCardAction[];
  /** 卡片主题色 */
  color?: 'blue' | 'green' | 'red' | 'orange' | 'grey';
  /** 卡片标题前缀图标（飞书 standard_icon，仅飞书平台生效） */
  headerIcon?: { token: string; color?: string };
}

/** 卡片内容段落 */
export interface ImCardSection {
  /** 段落标题 */
  header?: string;
  /** 段落内容（Markdown 格式） */
  content: string;
}

/** 卡片操作按钮 */
export interface ImCardAction {
  /** 按钮文本 */
  text: string;
  /** 按钮样式 */
  style: 'primary' | 'danger' | 'default';
  /** 按钮动作标识（回调时返回） */
  actionId: string;
  /** 附加数据（回调时返回） */
  value?: Record<string, string>;
}

// ============================================================================
// Channel 配置
// ============================================================================

/** IM Channel 基础配置 */
export interface ImChannelConfig {
  /** 平台标识 */
  platform: ImPlatform;
  /** 默认路由到的 Agent ID */
  defaultAgentId?: string;
}

/** 飞书平台专属配置 */
export interface FeishuChannelConfig extends ImChannelConfig {
  platform: 'feishu';
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;
}

/** Slack 平台专属配置 */
export interface SlackChannelConfig extends ImChannelConfig {
  platform: 'slack';
  /** Slack Bot User OAuth Token（xoxb-*） */
  botToken: string;
  /** Slack App-Level Token（xapp-*，需 connections:write） */
  appToken: string;
}

/** 更新 IM 卡片时的平台上下文 */
export interface ImCardUpdateContext {
  /** 会话 ID；Slack chat.update 必需，飞书可忽略 */
  chatId?: string;
  /** 飞书卡片回调 token，用于交互后的 delayed update */
  feishuCardUpdateToken?: string;
}

// ============================================================================
// Channel 接口（工厂模式核心）
// ============================================================================

/** 连接状态变化回调 */
export type ConnectionStateHandler = (connected: boolean, error?: string) => void;

/** 消息接收回调 */
export type MessageHandler = (msg: ImIncomingMessage) => void;

/** 卡片按钮回调 */
export type CardActionHandler = (actionId: string, value: Record<string, string>) => void;

/**
 * IM Channel 接口
 *
 * 所有 IM 平台适配器都必须实现此接口。
 * 职责：连接管理、消息收发、卡片更新。
 */
export interface ImChannel {
  /** 平台标识（只读） */
  readonly platform: ImPlatform;

  // ═══ 连接管理 ═══

  /** 建立连接 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 当前是否已连接 */
  isConnected(): boolean;

  // ═══ 事件监听 ═══

  /** 注册消息接收回调 */
  onMessage(handler: MessageHandler): void;
  /** 注册连接状态变化回调 */
  onConnectionChange(handler: ConnectionStateHandler): void;
  /** 注册卡片按钮点击回调 */
  onCardAction(handler: CardActionHandler): void;

  // ═══ 消息发送 ═══

  /** 发送纯文本消息，返回消息 ID */
  sendText(chatId: string, text: string): Promise<string>;
  /** 发送交互式卡片，返回消息 ID */
  sendCard(chatId: string, card: ImCardContent): Promise<string>;
  /** 更新已发送的卡片内容 */
  updateCard(messageId: string, card: ImCardContent, context?: ImCardUpdateContext): Promise<void>;
  /** 删除由当前 Bot 发送的消息（平台支持时可用） */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  /** 删除由当前 Bot 上传的文件（平台支持时可用） */
  deleteFile?(fileId: string): Promise<void>;
  /**
   * 发送图片消息，返回消息 ID
   *
   * 内部流程：先上传图片获取 image_key，再发送 msg_type=image 的消息。
   * @param imageBase64 - 图片的 base64 编码
   * @param imageTypeHint - 图片扩展名提示（"jpg" / "png" / "webp" 等）
   */
  sendImage(chatId: string, imageBase64: string, imageTypeHint: string): Promise<string>;
  /**
   * 发送文件消息，返回消息 ID
   *
   * 内部流程：先上传文件获取 file_key，再发送 msg_type=file 的消息。
   * @param fileBase64 - 文件的 base64 编码
   * @param fileName - 文件名（含扩展名）
   * @param fileType - 飞书文件类型标识（"stream"/"pdf"/"docx" 等）
   */
  sendFile(chatId: string, fileBase64: string, fileName: string, fileType: string): Promise<string>;
  /**
   * 下载飞书消息中的资源（图片或文件），返回 base64 内容
   *
   * 用于处理用户发送的附件，将其下载到本地以供 Agent 读取。
   */
  downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: 'image' | 'file'
  ): Promise<{ base64: string; mimeType: string }>;
}

// ============================================================================
// Channel 工厂
// ============================================================================

/**
 * Channel 创建函数签名
 *
 * 每个平台注册一个 creator，工厂通过平台标识查找并调用
 */
export type ImChannelCreator = (config: ImChannelConfig) => ImChannel;

// ============================================================================
// IM 任务桥接
// ============================================================================

/** IM 触发的任务状态 */
export type ImTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** IM 触发的任务记录 */
export interface ImTask {
  /** 任务 ID */
  id: string;
  /** 来源消息 */
  sourceMessage: ImIncomingMessage;
  /** 目标 Agent ID */
  agentId: string;
  /** 任务状态 */
  status: ImTaskStatus;
  /** 飞书进度卡片的消息 ID（用于 PATCH 更新） */
  progressCardMessageId?: string;
  /** 飞书卡片交互回调 token，用于终态卡片的 delayed update */
  feishuCardUpdateToken?: string;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 错误信息 */
  error?: string;
}
