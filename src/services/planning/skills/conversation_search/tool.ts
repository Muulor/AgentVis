/**
 * ConversationSearchTool - current Agent conversation history search.
 *
 * Searches persisted messages for the current Agent only. The LLM supplies
 * search/get parameters; the Agent identity comes from ToolExecutionContext
 * and is never part of the public schema.
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import type { Tool, ToolExecutionContext, ToolResult, ToolSchema } from '../../tools/types';
import { getMemorySafeMessageContent } from '@services/memory/utils/SafeMessageContent';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_GET_MESSAGES = 5;
const MAX_SNIPPET_CHARS = 240;
const MAX_TIMELINE_PREVIEW_CHARS = 160;

const SCHEMA: ToolSchema = {
    name: 'conversation_search',
    description: 'Search, browse by timeline, or fetch this Agent\'s own saved conversation history. Search mode returns lightweight snippets; timeline mode lists lightweight chronological messages; get mode returns full selected messages. Scope is always the current Agent only.',
    parameters: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                description: 'Operation mode: "search" for keyword snippets, "timeline" for chronological browsing without a keyword, or "get" to fetch full messages by messageId/messageIds. Defaults to "search".',
                enum: ['search', 'timeline', 'get'],
            },
            query: {
                type: 'string',
                description: 'Exact keyword or phrase to search in this Agent\'s saved conversation history. Required for mode="search".',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of search matches to return. Defaults to 10 and is capped at 50.',
            },
            offset: {
                type: 'number',
                description: 'Search result offset for pagination. Defaults to 0. When hasMore=true, call again with nextOffset.',
            },
            startAt: {
                type: 'string',
                description: 'Optional inclusive time lower bound for search/timeline. Use ISO timestamp with timezone when possible, or YYYY-MM-DD for local-day start.',
            },
            endAt: {
                type: 'string',
                description: 'Optional exclusive time upper bound for search/timeline. Use ISO timestamp with timezone when possible, or YYYY-MM-DD for the next local-day boundary.',
            },
            order: {
                type: 'string',
                description: 'Timeline order: "desc" (newest first, default) or "asc" (oldest first). Used for mode="timeline".',
                enum: ['desc', 'asc'],
            },
            role: {
                type: 'string',
                description: 'Optional search role filter: "any" (default), "user", or "assistant".',
                enum: ['any', 'user', 'assistant'],
            },
            messageId: {
                type: 'string',
                description: 'Message id to fetch in full. Used for mode="get".',
            },
            messageIds: {
                type: 'array',
                description: 'Message ids to fetch in full. Used for mode="get" and capped at 5.',
                items: {
                    type: 'string',
                    description: 'Message id.',
                },
            },
        },
    },
};

interface BackendMessageItem {
    id: string;
    agentId: string;
    role: string;
    content: string;
    metadata?: string | null;
    createdAt: number;
}

interface BackendSearchResponse {
    messages: BackendMessageItem[];
    hasMore: boolean;
    nextOffset?: number | null;
}

interface SearchPageInfo {
    mode: ConversationMode;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
}

interface TimeRange {
    startTs: number | null;
    endTs: number | null;
}

type ConversationMode = 'search' | 'timeline' | 'get';
type ConversationRoleFilter = 'any' | 'user' | 'assistant';
type TimelineOrder = 'asc' | 'desc';

function normalizeMode(value: unknown): ConversationMode {
    if (value === 'timeline') return 'timeline';
    return value === 'get' ? 'get' : 'search';
}

function normalizeQuery(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeLimit(value: unknown): number {
    const raw = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number(value)
            : DEFAULT_SEARCH_LIMIT;

    if (!Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
    return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(raw)));
}

function normalizeOffset(value: unknown): number {
    const raw = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number(value)
            : 0;

    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.trunc(raw));
}

function normalizeOrder(value: unknown): TimelineOrder {
    return value === 'asc' ? 'asc' : 'desc';
}

function normalizeTimestamp(value: unknown, boundary: 'start' | 'end'): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = value < 10_000_000_000 ? value * 1000 : value;
        return Math.max(0, Math.trunc(normalized));
    }

    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
        return normalizeTimestamp(Number(trimmed), boundary);
    }

    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
        const [, year, month, day] = dateOnly;
        const localStart = new Date(Number(year), Number(month) - 1, Number(day)).getTime();
        if (Number.isNaN(localStart)) return null;
        return localStart;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
}

function normalizeTimeRange(params: Record<string, unknown>): TimeRange {
    const startValue = params.startAt ?? params.start_at ?? params.startTs ?? params.start_ts;
    const endValue = params.endAt ?? params.end_at ?? params.endTs ?? params.end_ts;

    return {
        startTs: normalizeTimestamp(startValue, 'start'),
        endTs: normalizeTimestamp(endValue, 'end'),
    };
}

function normalizeRole(value: unknown): ConversationRoleFilter {
    return value === 'user' || value === 'assistant' ? value : 'any';
}

function normalizeMessageIds(params: Record<string, unknown>): string[] {
    const ids: string[] = [];
    const singleId = params.messageId ?? params.message_id;
    const manyIds = params.messageIds ?? params.message_ids;

    if (typeof singleId === 'string') ids.push(singleId);

    if (Array.isArray(manyIds)) {
        for (const id of manyIds) {
            if (typeof id === 'string') ids.push(id);
        }
    }

    const normalized: string[] = [];
    for (const id of ids) {
        const trimmed = id.trim();
        if (trimmed && !normalized.includes(trimmed)) {
            normalized.push(trimmed);
        }
    }

    return normalized.slice(0, MAX_GET_MESSAGES);
}

function rolesForFilter(role: ConversationRoleFilter): string[] {
    if (role === 'user') return ['user'];
    if (role === 'assistant') return ['assistant'];
    return ['user', 'assistant'];
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function formatTime(createdAt: number): string {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return String(createdAt);

    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function compactWhitespace(content: string): string {
    return content.replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markMatches(content: string, query: string): string {
    const normalizedQuery = compactWhitespace(query);
    if (!normalizedQuery) return content;

    return content.replace(new RegExp(escapeRegex(normalizedQuery), 'gi'), match => `[[${match}]]`);
}

function buildSnippet(content: string, query: string): string {
    const compacted = compactWhitespace(content);
    const normalizedQuery = compactWhitespace(query);
    const normalizedContent = compacted.toLocaleLowerCase();
    const matchIndex = normalizedContent.indexOf(normalizedQuery.toLocaleLowerCase());

    if (compacted.length <= MAX_SNIPPET_CHARS) {
        return markMatches(compacted, normalizedQuery);
    }

    if (matchIndex < 0) {
        return `${compacted.slice(0, MAX_SNIPPET_CHARS - 3)}...`;
    }

    const contextChars = Math.max(80, Math.floor((MAX_SNIPPET_CHARS - normalizedQuery.length) / 2));
    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(compacted.length, start + MAX_SNIPPET_CHARS);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < compacted.length ? '...' : '';
    const snippet = `${prefix}${compacted.slice(start, end)}${suffix}`;

    return markMatches(snippet, normalizedQuery);
}

function buildPreview(content: string): string {
    const compacted = compactWhitespace(content);
    if (compacted.length <= MAX_TIMELINE_PREVIEW_CHARS) return compacted;
    return `${compacted.slice(0, MAX_TIMELINE_PREVIEW_CHARS - 3)}...`;
}

function safeMessageContent(message: BackendMessageItem): string {
    return getMemorySafeMessageContent({
        role: message.role,
        content: message.content,
        metadata: message.metadata,
    });
}

function formatRole(role: string): string {
    if (role === 'assistant') return translate('tools.conversationSearch.assistantRole');
    return translate('tools.conversationSearch.userRole');
}

function formatTimeRange(range: TimeRange): string {
    const start = range.startTs !== null ? formatTime(range.startTs) : null;
    const end = range.endTs !== null ? formatTime(range.endTs) : null;

    if (start && end) {
        return translate('tools.conversationSearch.timeRangeBetween', { start, end });
    }
    if (start) {
        return translate('tools.conversationSearch.timeRangeFrom', { start });
    }
    if (end) {
        return translate('tools.conversationSearch.timeRangeUntil', { end });
    }
    return translate('tools.conversationSearch.timeRangeAll');
}

function formatPageMeta(pageInfo: SearchPageInfo): string {
    return pageInfo.hasMore && pageInfo.nextOffset !== null
        ? translate('tools.conversationSearch.pageMetaHasMore', {
            mode: pageInfo.mode,
            offset: pageInfo.offset,
            limit: pageInfo.limit,
            nextOffset: pageInfo.nextOffset,
        })
        : translate('tools.conversationSearch.pageMetaEnd', {
            mode: pageInfo.mode,
            offset: pageInfo.offset,
            limit: pageInfo.limit,
        });
}

function formatSearchResults(
    messages: BackendMessageItem[],
    query: string,
    pageInfo: SearchPageInfo,
): string {
    const header = translate('tools.conversationSearch.header', {
        count: messages.length,
        query,
    });

    const items = messages.map((message, index) => translate('tools.conversationSearch.resultItem', {
        index: index + 1,
        time: formatTime(message.createdAt),
        role: formatRole(message.role),
        id: message.id,
        snippet: buildSnippet(safeMessageContent(message), query),
    }));

    return `${header}\n\n${items.join('\n\n')}${formatPageMeta(pageInfo)}`;
}

function formatTimelineResults(
    messages: BackendMessageItem[],
    order: TimelineOrder,
    role: ConversationRoleFilter,
    timeRange: TimeRange,
    pageInfo: SearchPageInfo,
): string {
    const header = translate('tools.conversationSearch.timelineHeader', {
        count: messages.length,
        order: translate(order === 'asc'
            ? 'tools.conversationSearch.orderAsc'
            : 'tools.conversationSearch.orderDesc'),
        role,
        timeRange: formatTimeRange(timeRange),
    });

    const items = messages.map((message, index) => translate('tools.conversationSearch.timelineItem', {
        index: index + 1,
        time: formatTime(message.createdAt),
        role: formatRole(message.role),
        id: message.id,
        preview: buildPreview(safeMessageContent(message)),
    }));

    return `${header}\n\n${items.join('\n\n')}${formatPageMeta(pageInfo)}`;
}

function formatFullMessages(messages: BackendMessageItem[]): string {
    const header = translate('tools.conversationSearch.getHeader', {
        count: messages.length,
    });

    const items = messages.map((message, index) => translate('tools.conversationSearch.getItem', {
        index: index + 1,
        time: formatTime(message.createdAt),
        role: formatRole(message.role),
        id: message.id,
        content: safeMessageContent(message),
    }));

    return `${header}\n\n${items.join('\n\n')}`;
}

class ConversationSearchTool implements Tool {
    readonly schema = SCHEMA;

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const agentId = context.agentId;
        if (!agentId) {
            return {
                success: false,
                content: translate('tools.conversationSearch.missingAgentId'),
            };
        }

        const mode = normalizeMode(params.mode);
        if (mode === 'get') {
            return this.executeGet(params, context, agentId);
        }
        if (mode === 'timeline') {
            return this.executeTimeline(params, context, agentId);
        }
        return this.executeSearch(params, context, agentId);
    }

    private async executeSearch(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
        agentId: string,
    ): Promise<ToolResult> {
        const query = normalizeQuery(params.query);
        if (!query) {
            return {
                success: false,
                content: translate('tools.conversationSearch.missingQuery'),
            };
        }

        const limit = normalizeLimit(params.limit);
        const offset = normalizeOffset(params.offset);
        const role = normalizeRole(params.role);
        const roles = rolesForFilter(role);
        const timeRange = normalizeTimeRange(params);

        try {
            context.onProgress?.(translate('tools.conversationSearch.searching', { query }));

            const response = await invoke<BackendSearchResponse>('message_search_agent_history', {
                agentId,
                query,
                roles,
                limit,
                offset,
                startTs: timeRange.startTs,
                endTs: timeRange.endTs,
            });
            const messages = response.messages;
            const hasMore = response.hasMore;
            const nextOffset = typeof response.nextOffset === 'number' ? response.nextOffset : null;

            if (messages.length === 0) {
                return {
                    success: true,
                    content: `${translate('tools.conversationSearch.noResults', { query })}${formatPageMeta({
                        mode: 'search',
                        offset,
                        limit,
                        hasMore: false,
                        nextOffset: null,
                    })}`,
                    data: {
                        mode: 'search',
                        scope: 'current_agent',
                        query,
                        role,
                        startTs: timeRange.startTs,
                        endTs: timeRange.endTs,
                        offset,
                        limit,
                        hasMore: false,
                        nextOffset: null,
                        resultCount: 0,
                    },
                };
            }

            return {
                success: true,
                content: formatSearchResults(messages, query, {
                    mode: 'search',
                    offset,
                    limit,
                    hasMore,
                    nextOffset,
                }),
                data: {
                    mode: 'search',
                    scope: 'current_agent',
                    query,
                    role,
                    startTs: timeRange.startTs,
                    endTs: timeRange.endTs,
                    offset,
                    limit,
                    hasMore,
                    nextOffset,
                    resultCount: messages.length,
                    messageIds: messages.map(message => message.id),
                },
            };
        } catch (error) {
            return {
                success: false,
                content: translate('tools.conversationSearch.failed', {
                    error: toErrorMessage(error),
                }),
            };
        }
    }

    private async executeTimeline(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
        agentId: string,
    ): Promise<ToolResult> {
        const limit = normalizeLimit(params.limit);
        const offset = normalizeOffset(params.offset);
        const role = normalizeRole(params.role);
        const roles = rolesForFilter(role);
        const order = normalizeOrder(params.order);
        const timeRange = normalizeTimeRange(params);

        try {
            context.onProgress?.(translate('tools.conversationSearch.timelining'));

            const response = await invoke<BackendSearchResponse>('message_timeline_agent_history', {
                agentId,
                roles,
                order,
                limit,
                offset,
                startTs: timeRange.startTs,
                endTs: timeRange.endTs,
            });
            const messages = response.messages;
            const hasMore = response.hasMore;
            const nextOffset = typeof response.nextOffset === 'number' ? response.nextOffset : null;
            const pageInfo: SearchPageInfo = {
                mode: 'timeline',
                offset,
                limit,
                hasMore,
                nextOffset,
            };

            if (messages.length === 0) {
                return {
                    success: true,
                    content: `${translate('tools.conversationSearch.timelineNoResults', {
                        timeRange: formatTimeRange(timeRange),
                    })}${formatPageMeta({
                        ...pageInfo,
                        hasMore: false,
                        nextOffset: null,
                    })}`,
                    data: {
                        mode: 'timeline',
                        scope: 'current_agent',
                        role,
                        order,
                        startTs: timeRange.startTs,
                        endTs: timeRange.endTs,
                        offset,
                        limit,
                        hasMore: false,
                        nextOffset: null,
                        resultCount: 0,
                    },
                };
            }

            return {
                success: true,
                content: formatTimelineResults(messages, order, role, timeRange, pageInfo),
                data: {
                    mode: 'timeline',
                    scope: 'current_agent',
                    role,
                    order,
                    startTs: timeRange.startTs,
                    endTs: timeRange.endTs,
                    offset,
                    limit,
                    hasMore,
                    nextOffset,
                    resultCount: messages.length,
                    messageIds: messages.map(message => message.id),
                },
            };
        } catch (error) {
            return {
                success: false,
                content: translate('tools.conversationSearch.failed', {
                    error: toErrorMessage(error),
                }),
            };
        }
    }

    private async executeGet(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
        agentId: string,
    ): Promise<ToolResult> {
        const ids = normalizeMessageIds(params);
        if (ids.length === 0) {
            return {
                success: false,
                content: translate('tools.conversationSearch.missingMessageIds'),
            };
        }

        try {
            context.onProgress?.(translate('tools.conversationSearch.getting', {
                count: ids.length,
            }));

            const messages = await invoke<BackendMessageItem[]>('message_get_agent_history_messages', {
                agentId,
                ids,
            });

            if (messages.length === 0) {
                return {
                    success: true,
                    content: translate('tools.conversationSearch.getNoResults'),
                    data: {
                        mode: 'get',
                        scope: 'current_agent',
                        requestedIds: ids,
                        resultCount: 0,
                    },
                };
            }

            return {
                success: true,
                content: formatFullMessages(messages),
                data: {
                    mode: 'get',
                    scope: 'current_agent',
                    requestedIds: ids,
                    resultCount: messages.length,
                    messageIds: messages.map(message => message.id),
                },
            };
        } catch (error) {
            return {
                success: false,
                content: translate('tools.conversationSearch.failed', {
                    error: toErrorMessage(error),
                }),
            };
        }
    }
}

export const conversationSearchTool = new ConversationSearchTool();
