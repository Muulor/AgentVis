/**
 * VisualEnhancerPostProcess - 可视化增强结果后处理
 *
 * 聚焦修复 LLM 在可视化代码块周围的常见格式惯性：
 * - Markdown 标题与紧随其后的 widget.title 完全重复
 *
 * @module services/planning/visual-enhancer/VisualEnhancerPostProcess
 */

import { parseWithFallback } from '@services/memory/utils/JsonParser';

const WIDGET_FENCE_PATTERN = /^```\s*(widget(?:-(?:chart|choices|tree))?)\s*$/i;
const FENCE_CLOSE_PATTERN = /^```\s*$/;
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface WidgetTitleData {
    title?: unknown;
}

export function removeDuplicateWidgetHeadings(content: string): string {
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const result: string[] = [];

    for (let index = 0; index < lines.length;) {
        const line = lines[index] ?? '';
        const fenceMatch = WIDGET_FENCE_PATTERN.exec(line.trim());
        if (!fenceMatch) {
            result.push(line);
            index += 1;
            continue;
        }

        const codeLines: string[] = [];
        let cursor = index + 1;
        while (cursor < lines.length && !FENCE_CLOSE_PATTERN.test((lines[cursor] ?? '').trim())) {
            codeLines.push(lines[cursor] ?? '');
            cursor += 1;
        }

        const title = readWidgetTitle(codeLines.join('\n'));
        if (title) {
            removeTrailingDuplicateHeading(result, title);
        }

        result.push(line, ...codeLines);
        if (cursor < lines.length) {
            result.push(lines[cursor] ?? '');
            cursor += 1;
        }
        index = cursor;
    }

    return result.join('\n');
}

function readWidgetTitle(code: string): string {
    const parseResult = parseWithFallback<WidgetTitleData>(code, {
        logPrefix: '[VisualEnhancerPostProcess]',
        suppressWarnings: true,
    });
    const title = parseResult.success ? parseResult.data?.title : undefined;
    return typeof title === 'string' ? title.trim() : '';
}

function removeTrailingDuplicateHeading(lines: string[], widgetTitle: string): void {
    let cursor = lines.length - 1;
    while (cursor >= 0 && (lines[cursor] ?? '').trim().length === 0) {
        cursor -= 1;
    }
    if (cursor < 0) return;

    const headingMatch = MARKDOWN_HEADING_PATTERN.exec((lines[cursor] ?? '').trim());
    const headingText = headingMatch?.[2]?.trim();
    if (!headingText) return;

    if (normalizeTitle(headingText) !== normalizeTitle(widgetTitle)) return;

    lines.splice(cursor);
}

function normalizeTitle(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/[`*_~]/g, '')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}]+$/u, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
