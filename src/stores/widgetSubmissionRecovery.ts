/**
 * WidgetSubmissionRecovery - 从持久化消息恢复气泡级 Widget 回复状态
 *
 * Widget 提交后的用户消息会隐藏在聊天流中，但 SQLite 仍保存了该消息。
 * 本工具把隐藏消息中的结构化 metadata 或历史文本内容转换回 UI 可用的
 * bubbleSelections / submittedExtraTexts 快照。
 */

import { extractFencedCodeBlocks, parseWidgetLanguage, resolveWidgetType } from '@components/widgets/widgetParsing';
import { parseWithFallback } from '@services/memory/utils/JsonParser';
import type { WidgetSelectionSnapshot } from './widgetStore';

export interface WidgetSubmissionRecoveryMessage {
    id: string;
    role: string;
    content: string;
    metadata?: unknown;
}

export interface WidgetBubbleSubmissionSnapshot {
    bubbleId: string;
    selections?: WidgetSelectionSnapshot[];
    extraText?: string;
}

interface WidgetTitleInfo {
    title: string;
    type: string;
}

interface ParsedSelectionRow {
    title: string;
    labels: string[];
}

const WIDGET_TITLE_SUFFIX_PATTERN = /\s*(?:\((?:multi[- ]?select|single[- ]?select|required|optional|multiple)\)|\uff08(?:\u53ef\u591a\u9009|\u5355\u9009|\u5fc5\u9009)\uff09)\s*/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
    if (isRecord(metadata)) return metadata;
    if (typeof metadata !== 'string' || !metadata.trim()) return undefined;
    try {
        const parsed = JSON.parse(metadata) as unknown;
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeWidgetTitle(title: string): string {
    return title.replace(WIDGET_TITLE_SUFFIX_PATTERN, '').trim();
}

function getWidgetBubbleId(metadata: Record<string, unknown> | undefined): string | undefined {
    const value = metadata?.widgetBubbleId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isWidgetSourceMessage(message: WidgetSubmissionRecoveryMessage): boolean {
    const metadata = normalizeMetadata(message.metadata);
    return message.role === 'user' && metadata?.source === 'widget';
}

function parseStructuredSelections(metadata: Record<string, unknown>): WidgetSelectionSnapshot[] | undefined {
    if (!Object.prototype.hasOwnProperty.call(metadata, 'widgetSelections')) return undefined;
    const rawSelections = metadata.widgetSelections;
    if (!Array.isArray(rawSelections)) return undefined;

    return rawSelections.flatMap((item) => {
        if (!isRecord(item)) return [];
        const widgetKey = typeof item.widgetKey === 'string' ? item.widgetKey : '';
        const rawLabels = Array.isArray(item.labels) ? item.labels : [];
        const labels = rawLabels.filter((label): label is string => typeof label === 'string' && label.length > 0);
        return widgetKey && labels.length > 0 ? [{ widgetKey, labels }] : [];
    });
}

function parseStructuredExtraText(metadata: Record<string, unknown>): string | undefined {
    if (!Object.prototype.hasOwnProperty.call(metadata, 'widgetExtraText')) return undefined;
    return typeof metadata.widgetExtraText === 'string' ? metadata.widgetExtraText : '';
}

function extractWidgetTitleInfo(markdown: string): Map<string, WidgetTitleInfo> {
    const result = new Map<string, WidgetTitleInfo>();

    for (const block of extractFencedCodeBlocks(markdown)) {
        if (!parseWidgetLanguage(block.language).isWidget) continue;

        const parseResult = parseWithFallback<Record<string, unknown>>(block.code, {
            logPrefix: '[WidgetSubmissionRecovery]',
            suppressWarnings: true,
        });
        if (!parseResult.success || !parseResult.data) continue;

        const widgetType = resolveWidgetType(block.language, parseResult.data);
        const rawTitle = parseResult.data.title;
        if (!widgetType || typeof rawTitle !== 'string' || !rawTitle.trim()) continue;

        result.set(normalizeWidgetTitle(rawTitle), {
            title: rawTitle,
            type: widgetType,
        });
    }

    return result;
}

function buildWidgetTitleInfoByBubble(
    messages: WidgetSubmissionRecoveryMessage[]
): Map<string, Map<string, WidgetTitleInfo>> {
    const result = new Map<string, Map<string, WidgetTitleInfo>>();

    for (const message of messages) {
        if (message.role !== 'assistant' || !message.content) continue;
        const titleInfo = extractWidgetTitleInfo(message.content);
        if (titleInfo.size > 0) {
            result.set(message.id, titleInfo);
        }
    }

    return result;
}

function parseExtraPrefix(line: string): string | null {
    const trimmed = line.trimStart();
    const prefixes = ['补充说明:', '补充说明：', 'Note:', 'Note：'];
    for (const prefix of prefixes) {
        if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
            return trimmed.slice(prefix.length).trimStart();
        }
    }
    return null;
}

function parseSelectionLine(line: string): ParsedSelectionRow | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const separatorIndex = trimmed.includes('：')
        ? trimmed.indexOf('：')
        : trimmed.indexOf(': ');
    if (separatorIndex <= 0) return null;

    const title = normalizeWidgetTitle(trimmed.slice(0, separatorIndex));
    const rawLabels = trimmed.slice(separatorIndex + (trimmed[separatorIndex] === '：' ? 1 : 2)).trim();
    if (!title || !rawLabels) return null;
    if (title === '补充说明' || title.toLowerCase() === 'note') return null;

    const labels = rawLabels.includes('、')
        ? rawLabels.split('、')
        : rawLabels.split(/,\s+/);
    const cleanedLabels = labels.map((label) => label.trim()).filter(Boolean);
    return cleanedLabels.length > 0 ? { title, labels: cleanedLabels } : null;
}

function toSelectionSnapshot(
    bubbleId: string,
    row: ParsedSelectionRow,
    titleInfoByNormalizedTitle?: Map<string, WidgetTitleInfo>
): WidgetSelectionSnapshot {
    const titleInfo = titleInfoByNormalizedTitle?.get(row.title);
    const widgetType = titleInfo?.type === 'tree' ? 'tree' : 'choices';
    const widgetTitle = titleInfo?.title ?? row.title;
    return {
        widgetKey: `${widgetType}:${bubbleId}:${widgetTitle}`,
        labels: row.labels,
    };
}

export function parseWidgetSubmissionText(
    content: string,
    bubbleId: string,
    titleInfoByNormalizedTitle?: Map<string, WidgetTitleInfo>
): Omit<WidgetBubbleSubmissionSnapshot, 'bubbleId'> {
    const selections: WidgetSelectionSnapshot[] = [];
    const extraLines: string[] = [];
    let isReadingExtra = false;
    let sawExplicitExtra = false;

    for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
        if (isReadingExtra) {
            extraLines.push(line);
            continue;
        }

        const extraStart = parseExtraPrefix(line);
        if (extraStart !== null) {
            sawExplicitExtra = true;
            isReadingExtra = true;
            extraLines.push(extraStart);
            continue;
        }

        const selectionRow = parseSelectionLine(line);
        if (selectionRow) {
            selections.push(toSelectionSnapshot(bubbleId, selectionRow, titleInfoByNormalizedTitle));
        }
    }

    if (sawExplicitExtra) {
        return {
            selections,
            extraText: extraLines.join('\n').trim(),
        };
    }

    if (selections.length === 0) {
        return { extraText: content.trim() };
    }

    return { selections };
}

export function collectWidgetBubbleSubmissions(
    messages: WidgetSubmissionRecoveryMessage[]
): WidgetBubbleSubmissionSnapshot[] {
    const titleInfoByBubble = buildWidgetTitleInfoByBubble(messages);
    const snapshotsByBubble = new Map<string, WidgetBubbleSubmissionSnapshot>();

    for (const message of messages) {
        if (!isWidgetSourceMessage(message)) continue;

        const metadata = normalizeMetadata(message.metadata);
        const bubbleId = getWidgetBubbleId(metadata);
        if (!metadata || !bubbleId) continue;

        const structuredSelections = parseStructuredSelections(metadata);
        const structuredExtraText = parseStructuredExtraText(metadata);
        const textFallback = structuredSelections === undefined && structuredExtraText === undefined
            ? parseWidgetSubmissionText(message.content, bubbleId, titleInfoByBubble.get(bubbleId))
            : undefined;

        snapshotsByBubble.set(bubbleId, {
            bubbleId,
            selections: structuredSelections ?? textFallback?.selections,
            extraText: structuredExtraText ?? textFallback?.extraText,
        });
    }

    return Array.from(snapshotsByBubble.values());
}
