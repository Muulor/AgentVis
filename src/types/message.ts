/**
 * 消息扩展类型定义
 * 
 * 扩展 context.ts 中的消息基础类型，添加 UI 层所需的额外字段
 */

import type { Message as BaseMessage, MessageRole } from './context';

// ==================== 扩展类型 ====================

/** 附件类型分类 */
export type AttachmentType = 'image' | 'document';

/** 附件信息 */
export interface AttachmentInfo {
    /** 附件 ID（UUID） */
    id: string;
    /** 文件名 */
    fileName: string;
    /** 文件扩展名（小写，不含点号） */
    fileExtension: string;
    /** 附件类型分类 */
    type: AttachmentType;
    /** 文件大小（字节） */
    size: number;
    /** 本地文件路径（复制到 attachments 目录后） */
    localPath: string;
    /** 原始文件路径 */
    originalPath: string;
    /** 解析后的文本内容（仅文档类型） */
    parsedContent?: string;
    /** Base64 编码的数据（仅图片类型，用于多模态发送） */
    base64Data?: string;
    /** 预估 token 数（仅文档类型） */
    estimatedTokens?: number;
    /** 是否已索引到知识库 */
    indexed?: boolean;
    /** 索引 Promise（用于等待索引完成，不持久化） */
    indexingPromise?: Promise<void>;
    /** 索引状态 */
    indexStatus?: 'pending' | 'indexing' | 'indexed' | 'failed';
    /** 上传时间戳 */
    createdAt: number;
}

/** 消息状态 */
export type MessageStatus =
    | 'pending'     // 正在发送
    | 'streaming'   // 流式接收中
    | 'completed'   // 已完成
    | 'failed';     // 发送失败

/** 消息操作类型 */
export type MessageAction = 'copy' | 'quote' | 'delete' | 'revoke';

// ==================== 接口定义 ====================

/** UI 层使用的扩展消息类型 */
export interface UIMessage extends BaseMessage {
    /** 消息状态 */
    status?: MessageStatus;
    /** 关联的 Hub ID（Hub 讨论区消息） */
    hubId?: string;
    /** 引用的消息 ID 列表 */
    quotedMessageIds?: string[];
    /** 元数据（扩展字段） */
    metadata?: MessageMetadata;
    /** 发送此消息时引用的内容（用于溯源显示） */
    quotedFrom?: Array<{
        content: string;
        agentName?: string;
    }>;
    /** 发送此消息时附带的附件列表 */
    attachments?: AttachmentInfo[];
}

/** 消息元数据 */
export interface MessageMetadata {
    /** 回复的 Agent 名称（用于 Hub 消息显示） */
    agentName?: string;
    /** 使用的模型名称 */
    modelName?: string;
    /** Token 消耗统计 */
    tokenUsage?: TokenUsage;
    /** 是否包含推理过程 */
    hasReasoning?: boolean;
    /** 推理过程内容（可折叠展示） */
    reasoningContent?: string;
    /** Planning 模式下 Master Brain provider reasoning trace */
    reasoningTrace?: {
        content: string;
        isCompleted?: boolean;
    };
    /** Planning 模式相关 */
    planningData?: PlanningMessageData;
    /** 意图类型（Planning 模式） */
    intentType?: string;
    /** 响应类型（Planning 模式） */
    responseType?: string;
    /** 附件列表 */
    attachments?: AttachmentInfo[];
    /** 允许扩展其他元数据字段 */
    [key: string]: unknown;
}

/** 进度项数据（Planning 模式下的执行进度展示） */
export interface ProgressItemData {
    /** 进度项标签 */
    label: string;
    /** 当前状态 */
    status: 'pending' | 'running' | 'completed' | 'failed';
    /** 详细信息 */
    detail?: string;
}

/** Token 使用统计 */
export interface TokenUsage {
    /** 输入 Token 数 */
    promptTokens: number;
    /** 输出 Token 数 */
    completionTokens: number;
    /** 总 Token 数 */
    totalTokens: number;
}

/** Planning 模式消息数据 */
export interface PlanningMessageData {
    /** 大纲内容（大纲确认阶段） */
    outline?: string;
    /** 当前扩写章节索引（扩写阶段） */
    currentSectionIndex?: number;
    /** 总章节数 */
    totalSections?: number;
    /** 是否需要用户确认 */
    requiresConfirmation?: boolean;
    /** 不确定度警告内容 */
    uncertaintyWarning?: string;
}

/** 引用信息（UI层使用） */
export interface QuoteInfo {
    /** 被引用的消息 ID */
    messageId: string;
    /** 引用内容（assistant 消息优先使用 Master Brain 原始输出） */
    content: string;
    /** 所属 Hub ID（用于隔离不同 Hub 的引用） */
    hubId: string;
    /** 来源 Agent 名称（显示用） */
    agentName?: string;
    /** 对话轮次编号 */
    turnNumber?: number;
    /** 
     * 来源 Agent ID（用于控制可见性）
     * - undefined: 从 Hub 窗口引用，所有 Agent 可见
     * - 具体 ID: 从某 Agent 窗口引用，仅该 Agent 和 Hub 可见
     */
    sourceAgentId?: string;
}

/** @提及信息（UI层扩展） */
export interface MentionInfo {
    /** Agent ID */
    agentId: string;
    /** Agent 名称 */
    agentName: string;
    /** 在输入文本中的起始位置 */
    startIndex: number;
    /** 在输入文本中的结束位置 */
    endIndex: number;
}

/** 消息分组（按日期） */
export interface MessageGroup {
    /** 日期标签（如 "今天"、"昨天"、"2026-01-20"） */
    dateLabel: string;
    /** 该日期下的消息列表 */
    messages: UIMessage[];
}

/** 格式化时间戳的选项 */
export interface FormatTimestampOptions {
    /** 是否显示日期 */
    showDate?: boolean;
    /** 是否使用12小时制 */
    use12Hour?: boolean;
}

// ==================== 工具函数 ====================

/**
 * 格式化时间戳为可读字符串
 */
export function formatTimestamp(
    timestamp: string | number,
    options: FormatTimestampOptions = {}
): string {
    const { showDate = false, use12Hour = false } = options;
    const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);

    // 时间部分
    let timeStr: string;
    if (use12Hour) {
        timeStr = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    } else {
        timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    if (!showDate) {
        return timeStr;
    }

    // 日期部分 - 使用完整年月日格式
    const dateStr = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    });

    return `${dateStr} ${timeStr}`;
}

/**
 * 获取日期分组标签
 */
export function getDateLabel(timestamp: string | number): string {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
    const now = new Date();

    const isToday = date.toDateString() === now.toDateString();
    if (isToday) return 'Today';

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

/**
 * 按日期分组消息
 */
export function groupMessagesByDate(messages: UIMessage[]): MessageGroup[] {
    const groups = new Map<string, UIMessage[]>();

    for (const message of messages) {
        const dateLabel = getDateLabel(message.createdAt);
        const group = groups.get(dateLabel) ?? [];
        group.push(message);
        groups.set(dateLabel, group);
    }

    return Array.from(groups.entries()).map(([dateLabel, msgs]) => ({
        dateLabel,
        messages: msgs
    }));
}

// 重新导出基础类型，方便使用
export type { MessageRole };
