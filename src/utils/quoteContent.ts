import { stripVisualCodeBlocks } from '@services/planning/visual-enhancer/stripVisualCodeBlocks';

export interface QuoteContentLike {
    content: string;
}

export interface QuoteSourceMessage {
    role?: string;
    content: string;
    metadata?: Record<string, unknown> | string | null;
}

export interface SerializedQuote {
    content: string;
    agentName?: string;
}

const PLANNING_PERSIST_CONTEXT_MARKER = '\n\nMB decision progress (system-injected context for the next decision)';

function parseMetadata(metadata: QuoteSourceMessage['metadata']): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    if (typeof metadata === 'object') return metadata;

    try {
        const parsed = JSON.parse(metadata) as unknown;
        return parsed && typeof parsed === 'object'
            ? parsed as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}

function getStringField(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}

export function stripPlanningPersistContext(content: string): string {
    const markerIndex = content.indexOf(PLANNING_PERSIST_CONTEXT_MARKER);
    return (markerIndex === -1 ? content : content.slice(0, markerIndex)).trim();
}

export function getQuoteContextContent(quote: QuoteContentLike): string {
    return stripVisualCodeBlocks(stripPlanningPersistContext(quote.content)).trim() || quote.content;
}

export function getMessageQuoteContent(message: QuoteSourceMessage): string {
    if (message.role !== 'assistant') {
        return message.content;
    }

    const metadata = parseMetadata(message.metadata);
    const persistContent = getStringField(metadata, 'persistContent');
    if (persistContent) {
        return stripPlanningPersistContext(persistContent);
    }

    if (metadata?.visualEnhanced === true) {
        return stripVisualCodeBlocks(message.content).trim() || message.content;
    }

    return message.content;
}

export function serializeQuoteForMessage(quote: SerializedQuote): SerializedQuote {
    return {
        content: quote.content,
        ...(quote.agentName ? { agentName: quote.agentName } : {}),
    };
}

export function serializeQuotesForMessage(quotes: SerializedQuote[]): SerializedQuote[] {
    return quotes.map(serializeQuoteForMessage);
}
