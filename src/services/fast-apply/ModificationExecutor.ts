/**
 * 修改执行器
 *
 * 负责将修改协议应用到文档内容
 */

import type { Modification, MatchResult } from './types';

// ==================== 错误类型 ====================

/**
 * 修改执行错误
 */
export class ModificationExecuteError extends Error {
    constructor(
        message: string,
        public readonly modification: Modification,
        public readonly details?: string
    ) {
        super(message);
        this.name = 'ModificationExecuteError';
    }
}

// ==================== 执行器类 ====================

/**
 * 修改执行器
 *
 * 负责根据匹配结果将修改应用到文档内容
 */
export class ModificationExecutor {
    /**
     * 应用单个修改
     *
     * @param content 原始文档内容
     * @param modification 修改协议
     * @param matchResult 匹配结果
     * @returns 修改后的内容
     */
    applyModification(
        content: string,
        modification: Modification,
        matchResult: MatchResult
    ): string {
        if (!matchResult.success) {
            throw new ModificationExecuteError(
                'Cannot apply modification: match failed',
                modification,
                `Match level: ${matchResult.matchLevel}`
            );
        }

        // 根据操作类型执行不同的修改
        switch (modification.operation) {
            case 'REPLACE':
                return this.executeReplace(content, matchResult, modification.replace ?? '');

            case 'INSERT_AFTER':
                return this.executeInsertAfter(content, matchResult, modification.replace ?? '');

            case 'INSERT_BEFORE':
                return this.executeInsertBefore(content, matchResult, modification.replace ?? '');

            case 'DELETE':
                return this.executeDelete(content, matchResult);

            default:
                throw new ModificationExecuteError(
                    `Unsupported operation type: ${String(modification.operation)}`,
                    modification
                );
        }
    }

    /**
     * 批量应用修改
     *
     * 按顺序应用所有修改，如果任一修改失败则抛出错误
     * 注意：批量修改时，后续修改的行号可能因前面的修改而偏移
     *
     * @param content 原始文档内容
     * @param modifications 修改协议数组
     * @param matchResults 对应的匹配结果数组
     * @returns 修改后的内容
     */
    applyModifications(
        content: string,
        modifications: Array<{
            modification: Modification;
            matchResult: MatchResult;
        }>
    ): string {
        let currentContent = content;

        // 按行号倒序排序，从后往前应用，避免行号偏移问题
        const sorted = [...modifications].sort(
            (a, b) => b.matchResult.startLine - a.matchResult.startLine
        );

        for (const { modification, matchResult } of sorted) {
            currentContent = this.applyModification(currentContent, modification, matchResult);
        }

        return currentContent;
    }

    /**
     * 预览修改（不实际应用）
     *
     * @param content 原始内容
     * @param modification 修改协议
     * @param matchResult 匹配结果
     * @returns 预览结果，包含原内容和新内容
     */
    previewModification(
        content: string,
        modification: Modification,
        matchResult: MatchResult
    ): { oldContent: string; newContent: string } {
        if (!matchResult.success) {
            return { oldContent: content, newContent: content };
        }

        const newContent = this.applyModification(content, modification, matchResult);
        return { oldContent: content, newContent };
    }

    // ==================== 私有方法 ====================

    /**
     * 执行替换操作
     */
    private executeReplace(
        content: string,
        matchResult: MatchResult,
        replacement: string
    ): string {
        // 如果有精确的字符偏移，使用它
        if (
            matchResult.startOffset !== undefined &&
            matchResult.matchLength !== undefined
        ) {
            return (
                content.substring(0, matchResult.startOffset) +
                replacement +
                content.substring(matchResult.startOffset + matchResult.matchLength)
            );
        }

        // 否则使用行号
        return this.replaceByLines(
            content,
            matchResult.startLine,
            matchResult.endLine,
            replacement
        );
    }

    /**
     * 执行在匹配内容后插入
     */
    private executeInsertAfter(
        content: string,
        matchResult: MatchResult,
        insertion: string
    ): string {
        const lines = content.split(/\r?\n/);
        const endLine = matchResult.endLine;

        // 在 endLine 行后插入新内容
        const before = lines.slice(0, endLine).join('\n');
        const after = lines.slice(endLine).join('\n');

        return before + '\n' + insertion + (after ? '\n' + after : '');
    }

    /**
     * 执行在匹配内容前插入
     */
    private executeInsertBefore(
        content: string,
        matchResult: MatchResult,
        insertion: string
    ): string {
        const lines = content.split(/\r?\n/);
        const startLine = matchResult.startLine;

        // 在 startLine 行前插入新内容
        const before = lines.slice(0, startLine - 1).join('\n');
        const after = lines.slice(startLine - 1).join('\n');

        return (before ? before + '\n' : '') + insertion + '\n' + after;
    }

    /**
     * 执行删除操作
     */
    private executeDelete(content: string, matchResult: MatchResult): string {
        // 如果有精确的字符偏移，使用它
        if (
            matchResult.startOffset !== undefined &&
            matchResult.matchLength !== undefined
        ) {
            return (
                content.substring(0, matchResult.startOffset) +
                content.substring(matchResult.startOffset + matchResult.matchLength)
            );
        }

        // 否则删除指定行
        return this.replaceByLines(
            content,
            matchResult.startLine,
            matchResult.endLine,
            ''
        );
    }

    /**
     * 按行号替换内容
     */
    private replaceByLines(
        content: string,
        startLine: number,
        endLine: number,
        replacement: string
    ): string {
        const lines = content.split(/\r?\n/);

        // 构建新内容
        const before = lines.slice(0, startLine - 1);
        const after = lines.slice(endLine);

        // 如果替换内容为空，直接连接前后部分
        if (!replacement) {
            return [...before, ...after].join('\n');
        }

        // 替换内容可能包含多行
        const replacementLines = replacement.split(/\r?\n/);

        return [...before, ...replacementLines, ...after].join('\n');
    }
}

// ==================== 导出单例 ====================

/** 默认修改执行器实例 */
export const modificationExecutor = new ModificationExecutor();
