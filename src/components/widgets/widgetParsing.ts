/**
 * WidgetParsing - widget 解析工具件
 *
 * 支持 widget-choices、widget-choice，以及裸 widget 根据 options/items/tree 推断。
 */

import { parseWithFallback } from '@services/memory/utils/JsonParser';

export interface FencedCodeBlock {
    language: string;
    code: string;
}

const WIDGET_TYPE_ALIASES: Record<string, string> = {
    choice: 'choices',
    choices: 'choices',
    chart: 'chart',
    tree: 'tree',
};

export function extractCodeLanguage(className?: string): string {
    if (!className) return '';

    const languageClass = className
        .split(/\s+/)
        .find((part) => part.startsWith('language-'));

    return languageClass
        ? languageClass.slice('language-'.length).toLowerCase()
        : '';
}

export function normalizeWidgetType(rawType: string): string {
    const normalized = rawType.trim().toLowerCase().replace(/_/g, '-');
    return WIDGET_TYPE_ALIASES[normalized] ?? normalized;
}

export function parseWidgetLanguage(language: string): {
    isWidget: boolean;
    explicitType: string;
} {
    const normalized = language.trim().toLowerCase().replace(/_/g, '-');
    if (normalized === 'widget') {
        return { isWidget: true, explicitType: '' };
    }

    const match = /^widget-(.+)$/.exec(normalized);
    if (!match) {
        return { isWidget: false, explicitType: '' };
    }

    return {
        isWidget: true,
        explicitType: normalizeWidgetType(match[1] ?? ''),
    };
}

export function inferWidgetTypeFromData(data: unknown): string {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return '';
    }

    const widgetData = data as Record<string, unknown>;
    if (Array.isArray(widgetData.options)) return 'choices';
    if (Array.isArray(widgetData.items)) return 'chart';
    if (widgetData.tree && typeof widgetData.tree === 'object') return 'tree';
    return '';
}

export function resolveWidgetType(language: string, data: unknown): string {
    const widgetLanguage = parseWidgetLanguage(language);
    if (!widgetLanguage.isWidget) return '';

    return widgetLanguage.explicitType || inferWidgetTypeFromData(data);
}

function resolveWidgetBlockType(block: FencedCodeBlock): string {
    const widgetLanguage = parseWidgetLanguage(block.language);
    if (!widgetLanguage.isWidget) return '';
    if (widgetLanguage.explicitType) return widgetLanguage.explicitType;

    const parseResult = parseWithFallback<Record<string, unknown>>(block.code, {
        logPrefix: '[WidgetDetection]',
    });
    return parseResult.success ? inferWidgetTypeFromData(parseResult.data) : '';
}

export function extractFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
    const blocks: FencedCodeBlock[] = [];
    const regex = /```([^\s`]*)[^\n]*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(markdown)) !== null) {
        blocks.push({
            language: (match[1] ?? '').toLowerCase(),
            code: match[2] ?? '',
        });
    }

    return blocks;
}

export function containsChoicesWidgetBlock(markdown: string): boolean {
    return extractFencedCodeBlocks(markdown).some((block) =>
        resolveWidgetBlockType(block) === 'choices'
    );
}

export function containsTreeWidgetBlock(markdown: string): boolean {
    return extractFencedCodeBlocks(markdown).some((block) =>
        resolveWidgetBlockType(block) === 'tree'
    );
}

export function shouldDeferTreeWidgetSubmit(markdown: string): boolean {
    const widgetTypes = extractFencedCodeBlocks(markdown)
        .map(resolveWidgetBlockType)
        .filter(Boolean);

    return widgetTypes.includes('tree') && widgetTypes.includes('choices');
}
