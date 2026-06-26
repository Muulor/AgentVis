/**
 * IM 通用卡片模板
 *
 * 生成平台无关的任务进度、完成、错误和等待卡片，由各 IM 平台适配器转换为自己的消息格式。
 */

import type { ImCardAction, ImCardContent, ImCardSection } from './types';
import { translate } from '@/i18n';

/**
 * 构建任务进度卡片
 */
export function buildProgressCard(params: {
    taskId: string;
    agentName: string;
    fsmState: string;
    thinkingSteps: string[];
    subAgentStatus?: string;
    subAgentSteps?: Array<{ step: number; tool: string; target: string; success?: boolean }>;
    iterationInfo?: string;
    showStopHint?: boolean;
}): ImCardContent {
    const sections: ImCardSection[] = [];

    const stateEmoji = getStateEmoji(params.fsmState);
    sections.push({
        header: translate('im.cards.statusHeader'),
        content: `${stateEmoji} **${params.fsmState}**${params.iterationInfo ? `  (${params.iterationInfo})` : ''}`,
    });

    if (params.thinkingSteps.length > 0) {
        const stepsText = params.thinkingSteps
            .map((step, index) => {
                const icon = index < params.thinkingSteps.length - 1 ? '✅' : '🔄';
                return `${icon} ${step}`;
            })
            .join('\n');
        sections.push({
            header: translate('im.cards.thinkingHeader'),
            content: stepsText,
        });
    }

    const subAgentSteps = params.subAgentSteps ?? [];
    const subAgentStatus = params.subAgentStatus;
    const hasSteps = subAgentSteps.length > 0;
    const hasStatus = Boolean(subAgentStatus);
    if (hasSteps || hasStatus) {
        const stepCount = subAgentSteps.length;
        const headerText = stepCount > 0
            ? translate('im.cards.subAgentStepsHeader', { count: stepCount })
            : translate('im.cards.subAgentHeader');

        const lines: string[] = [];
        if (hasSteps) {
            for (const s of subAgentSteps) {
                const toolEmoji = getToolEmoji(s.tool);
                lines.push(`${toolEmoji} ${s.tool} ${s.target}`);
            }
        }
        if (subAgentStatus && !hasSteps) {
            lines.push(subAgentStatus);
        }

        sections.push({
            header: headerText,
            content: lines.join('\n'),
        });
    }

    if (params.showStopHint !== false) {
        sections.push({
            content: translate('im.cards.stopHint'),
        });
    }

    return {
        title: translate('im.cards.runningTitle', { agentName: params.agentName }),
        sections,
        actions: [
            {
                text: translate('im.cards.stopAction'),
                style: 'danger',
                actionId: 'abort_task',
                value: {
                    task_id: params.taskId,
                },
            },
        ],
        color: 'blue',
    };
}

/**
 * 构建任务完成卡片
 */
export function buildCompletionCard(params: {
    agentName: string;
    result: string;
    duration: number;
    iterationCount: number;
}): ImCardContent {
    return {
        title: translate('im.cards.completeTitle', { agentName: params.agentName }),
        sections: [
            {
                header: translate('im.cards.resultHeader'),
                content: params.result,
            },
            {
                content: translate('im.cards.durationMeta', {
                    duration: formatDuration(params.duration),
                    count: params.iterationCount,
                }),
            },
        ],
        actions: [createDeleteMessageAction()],
        color: 'green',
    };
}

/**
 * 构建任务错误卡片
 */
export function buildErrorCard(params: {
    agentName: string;
    error: string;
    taskId: string;
}): ImCardContent {
    return {
        title: translate('im.cards.errorTitle', { agentName: params.agentName }),
        sections: [
            {
                header: translate('im.cards.errorHeader'),
                content: `\`${params.error}\``,
            },
            {
                content: translate('im.cards.retryHint'),
            },
        ],
        actions: [createDeleteMessageAction()],
        color: 'red',
    };
}

/**
 * 构建初始等待卡片
 */
export function buildPendingCard(agentName: string): ImCardContent {
    return {
        title: translate('im.cards.pendingTitle', { agentName }),
        sections: [
            {
                content: translate('im.cards.pendingContent'),
            },
        ],
        color: 'grey',
    };
}

/** 构建忙碌提示卡片 */
export function buildBusyCard(content: string): ImCardContent {
    return {
        title: translate('im.cards.busyTitle'),
        sections: [
            {
                content,
            },
        ],
        actions: [createDeleteMessageAction()],
        color: 'orange',
    };
}

/** 构建 Agent 主动发送的可删除文本卡片 */
export function buildOutboundMessageCard(content: string): ImCardContent {
    return {
        title: translate('im.cards.outboundMessageTitle'),
        sections: [
            {
                content,
            },
        ],
        actions: [createDeleteMessageAction()],
        color: 'grey',
    };
}

/** 根据 FSM 状态返回对应 emoji */
function getStateEmoji(state: string): string {
    const emojiMap: Record<string, string> = {
        IDLE: '⏸️',
        PREPARE_CONTEXT: '📋',
        MASTER_DECISION: '🤔',
        DISPATCH: '📤',
        OBSERVE: '👁️',
        EVALUATE: '⚖️',
        TERMINATE: '🏁',
    };
    return emojiMap[state] ?? '🔹';
}

/** 根据工具名返回直观的 emoji 前缀 */
function getToolEmoji(tool: string): string {
    const toolEmojiMap: Record<string, string> = {
        web_search: '🔍',
        read: '📖',
        exec: '⚡',
        file_write: '✏️',
        local_search: '🔎',
        cron: '⏰',
        generate_image: '🎨',
        im_send: '📨',
        feishu_send: '📨',
        slack_send: '💬',
    };
    return toolEmojiMap[tool] ?? '🔹';
}

function createDeleteMessageAction(value?: Record<string, string>): ImCardAction {
    return {
        text: translate('im.cards.deleteAction'),
        style: 'default',
        actionId: 'delete_message',
        ...(value ? { value } : {}),
    };
}

/** 格式化耗时（ms → 可读文本） */
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}
