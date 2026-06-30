import { describe, expect, it } from 'vitest';
import {
    buildChatHistoricalAttachmentContext,
    getChatHistoricalMessageAttachments,
} from '../chatAttachmentContext';

const translate = (
    key: string,
    params?: Record<string, string | number | boolean | null | undefined>
) => {
    const values: Record<string, string> = {
        'chat.historicalAttachmentContextItem': `- ${String(params?.fileName ?? '')} (${String(params?.type ?? '')}, .${String(params?.extension ?? '')}, ${String(params?.size ?? '')}KB): ${String(params?.path ?? '')}`,
        'chat.chatHistoricalAttachmentContextHeader': [
            '## Historical User Attachments',
            'Chat mode cannot reread local paths.',
            'Planning mode can inspect and read the workspace attachment.',
            String(params?.items ?? ''),
        ].join('\n'),
        'chat.chatHistoricalAttachmentContentBlock': `Historical attachment excerpt [${String(params?.fileName ?? '')}]:\n${String(params?.content ?? '')}`,
        'chat.chatHistoricalAttachmentContextTruncatedNotice': `[Chat historical attachment context truncated to about ${String(params?.maxTokens ?? '')} tokens; switch to Planning mode to inspect the workspace attachment.]`,
    };

    return values[key] ?? key;
};

describe('chatAttachmentContext', () => {
    it('extracts document attachments from message metadata', () => {
        const attachments = getChatHistoricalMessageAttachments({
            attachments: [
                {
                    fileName: '夜航西飞.md',
                    fileExtension: 'md',
                    type: 'document',
                    size: 489472,
                    localPath: 'D:\\AgentVis\\attachments\\夜航西飞.md',
                    parsedContent: '# 夜航西飞',
                },
            ],
        });

        expect(attachments).toHaveLength(1);
        expect(attachments[0]?.fileName).toBe('夜航西飞.md');
        expect(attachments[0]?.parsedContent).toContain('夜航西飞');
    });

    it('builds Chat-specific historical attachment guidance with excerpts', () => {
        const context = buildChatHistoricalAttachmentContext(
            [{
                fileName: '夜航西飞.md',
                fileExtension: 'md',
                type: 'document',
                localPath: 'D:\\AgentVis\\attachments\\夜航西飞.md',
                size: 489472,
                parsedContent: '# 夜航西飞\n\n一本关于飞行与成长的书。',
            }],
            '译者读后感是什么？',
            translate
        );

        expect(context).toContain('Historical User Attachments');
        expect(context).toContain('Chat mode cannot reread local paths');
        expect(context).toContain('workspace attachment');
        expect(context).toContain('夜航西飞.md');
        expect(context).toContain('# 夜航西飞');
        expect(context).not.toContain('Sub-Agent');
    });

    it('truncates large Chat historical attachment context and keeps Planning guidance', () => {
        const context = buildChatHistoricalAttachmentContext(
            [{
                fileName: '夜航西飞.md',
                fileExtension: 'md',
                type: 'document',
                localPath: 'D:\\AgentVis\\attachments\\夜航西飞.md',
                size: 489472,
                parsedContent: '正文'.repeat(1000),
            }],
            '继续分析这本书',
            translate,
            { maxTokens: 160 }
        );

        expect(context).toBeDefined();
        expect(context).toContain('Chat historical attachment context truncated');
        expect(context).toContain('Planning mode');
        expect(context).toContain('workspace attachment');
    });
});
