/**
 * Chat 模式附件上下文辅助函数
 *
 * 负责为普通 Chat 对话构造历史附件提醒。Chat 模式没有 Sub-Agent 读取链路，
 * 因此提示语必须强调只能基于内联摘录回答，并在需要完整附件时建议切换 Planning 模式。
 */

import type { Message } from '@/types';
import type { AttachmentInfo } from '@/types/message';
import type { TranslationKey, TranslationParams } from '@/i18n';

const CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MAX_TOKENS = 800;
const CHAT_HISTORICAL_ATTACHMENT_CONTEXT_CHARS_PER_TOKEN = 2.5;
const CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MIN_CHARS = 320;
const CHAT_HISTORICAL_ATTACHMENT_CONTEXT_SAFETY_MARGIN = 120;
const CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MAX_MESSAGE_CHARS = 5000;

type ChatAttachmentContextTranslate = (
    key: TranslationKey,
    params?: TranslationParams
) => string;

export type ChatHistoricalAttachmentContextItem = Pick<
    AttachmentInfo,
    'fileName' | 'fileExtension' | 'type' | 'localPath'
> & Partial<Pick<AttachmentInfo, 'size' | 'parsedContent'>>;

export function getChatHistoricalMessageAttachments(
    metadata: Message['metadata']
): ChatHistoricalAttachmentContextItem[] {
    if (!metadata) return [];

    const attachments = (metadata as Record<string, unknown>).attachments;
    if (!Array.isArray(attachments)) return [];

    return attachments.flatMap((attachment): ChatHistoricalAttachmentContextItem[] => {
        if (!attachment || typeof attachment !== 'object') return [];

        const record = attachment as Record<string, unknown>;
        const type = record.type;
        if (type !== 'document' && type !== 'image') return [];
        if (
            typeof record.fileName !== 'string'
            || typeof record.fileExtension !== 'string'
            || typeof record.localPath !== 'string'
            || !record.localPath.trim()
        ) {
            return [];
        }

        return [{
            fileName: record.fileName,
            fileExtension: record.fileExtension,
            type,
            localPath: record.localPath,
            size: typeof record.size === 'number' ? record.size : undefined,
            parsedContent: typeof record.parsedContent === 'string' ? record.parsedContent : undefined,
        }];
    });
}

export function buildChatHistoricalAttachmentContext(
    attachments: ChatHistoricalAttachmentContextItem[],
    userMessageContent: string,
    translateText: ChatAttachmentContextTranslate,
    options: {
        maxTokens?: number;
        maxMessageChars?: number;
    } = {}
): string | undefined {
    const validAttachments = attachments.filter(attachment => attachment.localPath.trim());
    if (validAttachments.length === 0) return undefined;

    const maxTokens = options.maxTokens ?? CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MAX_TOKENS;
    const maxContextChars = Math.floor(maxTokens * CHAT_HISTORICAL_ATTACHMENT_CONTEXT_CHARS_PER_TOKEN);
    const maxMessageChars = options.maxMessageChars ?? CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MAX_MESSAGE_CHARS;
    const separatorChars = '\n\n'.length;
    const availableChars = Math.min(
        maxContextChars,
        Math.max(
            0,
            maxMessageChars
            - userMessageContent.length
            - separatorChars
            - CHAT_HISTORICAL_ATTACHMENT_CONTEXT_SAFETY_MARGIN
        )
    );

    if (availableChars < CHAT_HISTORICAL_ATTACHMENT_CONTEXT_MIN_CHARS) return undefined;

    const items = validAttachments
        .map(attachment => translateText('chat.historicalAttachmentContextItem', {
            fileName: attachment.fileName,
            type: attachment.type,
            extension: attachment.fileExtension,
            size: Math.max(1, Math.round((attachment.size ?? 0) / 1024)),
            path: attachment.localPath,
        }))
        .join('\n');

    const header = translateText('chat.chatHistoricalAttachmentContextHeader', { items });
    const contentBlocks = validAttachments
        .filter(attachment => attachment.type === 'document' && attachment.parsedContent?.trim())
        .map(attachment => translateText('chat.chatHistoricalAttachmentContentBlock', {
            fileName: attachment.fileName,
            content: attachment.parsedContent ?? '',
        }));

    const rawContext = [
        header,
        ...contentBlocks,
    ].join('\n\n');

    if (rawContext.length <= availableChars) {
        return rawContext;
    }

    const notice = translateText('chat.chatHistoricalAttachmentContextTruncatedNotice', { maxTokens });
    const contentBudget = Math.max(1, availableChars - notice.length - separatorChars);

    return `${rawContext.slice(0, contentBudget).trimEnd()}\n\n${notice}`;
}
