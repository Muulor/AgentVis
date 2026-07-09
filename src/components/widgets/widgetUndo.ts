/**
 * Widget 重选撤回工具。
 *
 * 统一定位最近一次 widget 用户消息，并生成从该消息开始的截断撤回计划。
 */

export interface WidgetUndoMessage {
    id: string;
    agentId: string;
    role: string;
    metadata?: unknown;
}

export interface WidgetUndoAgentGroup {
    firstId: string;
    messageIds: string[];
}

export interface WidgetUndoRetractionPlan<T extends WidgetUndoMessage> {
    startIndex: number;
    retainedMessages: T[];
    messagesToRetract: T[];
    agentGroups: Map<string, WidgetUndoAgentGroup>;
}

export interface WidgetUndoOptions {
    widgetBubbleId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
    if (isRecord(metadata)) return metadata;
    if (typeof metadata !== 'string') return null;

    try {
        const parsed: unknown = JSON.parse(metadata);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isWidgetUserMessage(message: WidgetUndoMessage, options: WidgetUndoOptions): boolean {
    const metadata = parseMetadata(message.metadata);
    if (message.role !== 'user' || metadata?.source !== 'widget') return false;
    if (!options.widgetBubbleId) return true;
    return metadata.widgetBubbleId === options.widgetBubbleId;
}

export function buildWidgetUndoRetractionPlan<T extends WidgetUndoMessage>(
    messages: T[],
    options: WidgetUndoOptions = {}
): WidgetUndoRetractionPlan<T> | null {
    let startIndex = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message && isWidgetUserMessage(message, options)) {
            startIndex = i;
            break;
        }
    }

    if (startIndex === -1) return null;

    const retainedMessages = messages.slice(0, startIndex);
    const messagesToRetract = messages.slice(startIndex);
    const agentGroups = new Map<string, WidgetUndoAgentGroup>();

    for (const message of messagesToRetract) {
        const existing = agentGroups.get(message.agentId);
        if (existing) {
            existing.messageIds.push(message.id);
        } else {
            agentGroups.set(message.agentId, {
                firstId: message.id,
                messageIds: [message.id],
            });
        }
    }

    return {
        startIndex,
        retainedMessages,
        messagesToRetract,
        agentGroups,
    };
}
