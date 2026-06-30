import { describe, expect, it } from 'vitest';
import {
    buildHistoricalAttachmentContext,
    buildPlanningCheckpointProgressText,
    getPlanningHistoryEffectiveContent,
    isPlanningCheckpointMessage,
    isRecoverablePlanningCheckpointMessage,
    isMessagePresentInList,
    trimPlanningCheckpointTextFromTail,
} from '../usePlanningMode';

const PERSIST_MARKER = '\n\nMB decision progress (system-injected context for the next decision)';

describe('usePlanningMode helpers', () => {
    const translate = (
        key: string,
        params?: Record<string, string | number | boolean | null | undefined>
    ) => {
        const values: Record<string, string> = {
            'chat.historicalAttachmentContextHeader': [
                '## Historical User Attachments',
                'Files are still saved locally.',
                String(params?.items ?? ''),
            ].join('\n'),
            'chat.historicalAttachmentContextItem': `- ${String(params?.fileName ?? '')} (${String(params?.type ?? '')}, .${String(params?.extension ?? '')}, ${String(params?.size ?? '')}KB): ${String(params?.path ?? '')}`,
            'chat.historicalAttachmentContentBlock': `Historical attachment excerpt [${String(params?.fileName ?? '')}]:\n${String(params?.content ?? '')}`,
            'chat.historicalAttachmentContextTruncatedNotice': `[Historical attachment context truncated to about ${String(params?.maxTokens ?? '')} tokens; dispatch SA to read the path.]`,
        };

        return values[key] ?? key;
    };

    it('detects whether the original user message is still present', () => {
        const messages = [
            { id: 'user-1' },
            { id: 'assistant-1' },
        ];

        expect(isMessagePresentInList(messages, 'user-1')).toBe(true);
        expect(isMessagePresentInList(messages, 'deleted-user')).toBe(false);
        expect(isMessagePresentInList(messages, null)).toBe(true);
    });

    it('uses assistant metadata.persistContent when rebuilding Planning history', () => {
        const persistedContent = [
            '可见回复',
            `${PERSIST_MARKER}:`,
            'MB rationale for next turn',
            '',
            'SA observations for continuation',
        ].join('\n');

        const content = getPlanningHistoryEffectiveContent({
            role: 'assistant',
            content: '可见回复',
            metadata: {
                persistContent: persistedContent,
            },
        });

        expect(content).toBe(persistedContent);
    });

    it('does not apply persistContent from user metadata to Planning history content', () => {
        const content = getPlanningHistoryEffectiveContent({
            role: 'user',
            content: '用户原始消息',
            metadata: {
                persistContent: '不应进入 historyMessages 的用户侧内容',
            },
        });

        expect(content).toBe('用户原始消息');
    });

    it('builds bounded historical attachment context with paths and excerpts', () => {
        const context = buildHistoricalAttachmentContext(
            [{
                fileName: 'flight-x.md',
                fileExtension: 'md',
                type: 'document',
                localPath: 'D:\\AgentVis\\attachments\\flight-x.md',
                size: 489472,
                parsedContent: '# 夜航西飞\n\n一本关于飞行与成长的书。',
            }],
            '这本书译者的读后感是什么',
            translate
        );

        expect(context).toContain('Historical User Attachments');
        expect(context).toContain('flight-x.md');
        expect(context).toContain('D:\\AgentVis\\attachments\\flight-x.md');
        expect(context).toContain('# 夜航西飞');
    });

    it('truncates large historical attachment context and keeps the read-path hint', () => {
        const context = buildHistoricalAttachmentContext(
            [{
                fileName: 'flight-x.md',
                fileExtension: 'md',
                type: 'document',
                localPath: 'D:\\AgentVis\\attachments\\flight-x.md',
                size: 489472,
                parsedContent: '正文'.repeat(1000),
            }],
            '继续分析这本书',
            translate,
            { maxTokens: 160 }
        );

        expect(context).toBeDefined();
        expect(context).toContain('D:\\AgentVis\\attachments\\flight-x.md');
        expect(context).toContain('Historical attachment context truncated');
        expect(context!.length).toBeLessThanOrEqual(410);
    });

    it('omits historical attachment context when it would hide the original user message', () => {
        const context = buildHistoricalAttachmentContext(
            [{
                fileName: 'large.md',
                fileExtension: 'md',
                type: 'document',
                localPath: 'D:\\AgentVis\\attachments\\large.md',
                parsedContent: 'content',
            }],
            'x'.repeat(4600),
            translate
        );

        expect(context).toBeUndefined();
    });

    it('trims checkpoint text from the tail so latest progress survives', () => {
        const text = [
            'old step should be dropped',
            'middle step',
            'latest reliable step',
        ].join('\n');

        const trimmed = trimPlanningCheckpointTextFromTail(text, 48, '[older omitted]');

        expect(trimmed).toContain('[older omitted]');
        expect(trimmed).toContain('latest reliable step');
        expect(trimmed).not.toContain('old step should be dropped');
        expect(trimmed.length).toBeLessThanOrEqual(48);
    });

    it('keeps MB progress and SA thinking when checkpoint observations exist', () => {
        const translate = (
            key: string,
            params?: Record<string, string | number | boolean | null | undefined>
        ) => {
            const values: Record<string, string> = {
                'chat.planningCheckpointOmittedOlderObservations': '[older omitted]',
                'chat.planningCheckpointMbProgressHeader': 'MB progress',
                'chat.planningCheckpointSaProgressHeader': 'SA progress',
                'chat.planningCheckpointUnknownStepLabel': '[Step ?]',
                'chat.planningCheckpointSaThinkingLabel': 'SA thinking:',
                'chat.planningCheckpointSaToolLabel': 'Tool:',
                'chat.planningCheckpointSaResultLabel': 'Result:',
                'chat.planningCheckpointToolStatusPending': 'pending',
                'chat.planningCheckpointToolStatusSuccess': 'success',
                'chat.planningCheckpointToolStatusFailed': 'failed',
                'chat.planningCheckpointEmptyObservation': 'empty observation',
                'chat.planningCheckpointNoObservations': 'no observations',
            };

            if (key === 'chat.subAgentStepLabel') {
                return `[Step ${String(params?.step ?? '?')}]`;
            }

            return values[key] ?? key;
        };

        const progressText = buildPlanningCheckpointProgressText(
            {
                analyzing: 'MB chose the paper summary path.',
                planning: 'Risk is low; continue with existing files.',
                decided: 'Write FRAME.md and render the explainer video.',
            },
            [{
                thinking: 'SA read the video workflow references and is checking bootstrap status.',
                toolAction: {
                    tool: 'exec',
                    target: 'node scripts/hf-workflow.mjs moss-bootstrap --in-place ...',
                    success: undefined,
                },
                step: 12,
            }],
            translate,
            { maxChars: 2000 }
        );

        expect(progressText).toContain('MB chose the paper summary path.');
        expect(progressText).toContain('Write FRAME.md and render the explainer video.');
        expect(progressText).toContain('SA read the video workflow references');
        expect(progressText).toContain('exec(node scripts/hf-workflow.mjs moss-bootstrap --in-place ...) pending');
        expect(progressText).not.toContain('MB rationale');
        expect(progressText).not.toContain('MB next step');
    });

    it('recognizes recoverable checkpoint messages only when their source user still exists', () => {
        const checkpoint = {
            role: 'assistant' as const,
            metadata: {
                mode: 'planning',
                responseType: 'agent_loop_checkpoint',
                agentLoopStatus: 'running',
                createdUserMessageId: 'user-1',
            },
        };

        expect(isPlanningCheckpointMessage(checkpoint)).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'user-1' }])).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'other-user' }])).toBe(false);
    });

    it('does not recover abandoned checkpoint messages', () => {
        const checkpoint = {
            role: 'assistant' as const,
            metadata: {
                mode: 'planning',
                responseType: 'agent_loop_checkpoint_abandoned',
                agentLoopStatus: 'abandoned',
                recoverable: false,
                createdUserMessageId: 'user-1',
            },
        };

        expect(isPlanningCheckpointMessage(checkpoint)).toBe(true);
        expect(isRecoverablePlanningCheckpointMessage(checkpoint, [{ id: 'user-1' }])).toBe(false);
    });
});
