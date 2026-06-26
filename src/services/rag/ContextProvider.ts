/**
 * ContextProvider - 上下文提供器
 * 
 * 将检索结果格式化为适合注入上下文的格式。
 */

import type { SearchResult } from '../../types';

/** 格式化选项 */
export interface FormatOptions {
    /** 是否显示相似度分数 */
    showScore: boolean;
    /** 是否显示来源文件 */
    showSource: boolean;
    /** 最大返回字符数 */
    maxChars?: number;
    /** 片段之间的分隔符 */
    separator: string;
}

const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
    showScore: true,
    showSource: true,
    separator: '\n\n---\n\n',
};

/**
 * ContextProvider 类
 * 
 * 将检索结果转换为可读的上下文格式
 */
export class ContextProvider {
    private options: FormatOptions;

    constructor(options: Partial<FormatOptions> = {}) {
        this.options = { ...DEFAULT_FORMAT_OPTIONS, ...options };
    }

    /**
     * 将检索结果格式化为上下文字符串
     * 
     * @param results - 检索结果列表
     * @returns 格式化后的上下文字符串
     */
    format(results: SearchResult[]): string {
        if (results.length === 0) {
            return '';
        }

        const parts: string[] = [];
        let totalChars = 0;

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (!result) continue;
            const { chunk, score } = result;

            // 构建片段标题
            const titleParts: string[] = [`[Chunk ${i + 1}]`];

            if (this.options.showSource && chunk.metadata.fileName) {
                titleParts.push(`Source: ${chunk.metadata.fileName}`);
            }

            if (this.options.showScore) {
                titleParts.push(`Relevance: ${(score * 100).toFixed(0)}%`);
            }

            const header = titleParts.join(' | ');
            const formattedChunk = `${header}\n${chunk.content}`;

            // 检查字符限制
            if (this.options.maxChars) {
                if (totalChars + formattedChunk.length > this.options.maxChars) {
                    // 超出限制，停止添加
                    break;
                }
                totalChars += formattedChunk.length;
            }

            parts.push(formattedChunk);
        }

        return parts.join(this.options.separator);
    }

    /**
     * 将检索结果格式化为结构化对象
     * 
     * @param results - 检索结果列表
     * @returns 结构化的上下文数据
     */
    formatStructured(results: SearchResult[]): Array<{
        index: number;
        source: string | null;
        score: number;
        content: string;
    }> {
        return results.map((result, index) => ({
            index: index + 1,
            source: result.chunk.metadata.fileName ?? null,
            score: result.score,
            content: result.chunk.content,
        }));
    }

    /**
     * 将检索结果格式化为 Markdown
     * 
     * @param results - 检索结果列表
     * @returns Markdown 格式的上下文
     */
    formatMarkdown(results: SearchResult[]): string {
        if (results.length === 0) {
            return '';
        }

        const lines: string[] = ['## Relevant Knowledge Base Content\n'];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (!result) continue;
            const { chunk, score } = result;

            // 标题行
            const source = chunk.metadata.fileName
                ? ` (Source: \`${chunk.metadata.fileName}\`)`
                : '';

            lines.push(`### Chunk ${i + 1}${source}`);

            if (this.options.showScore) {
                lines.push(`> Relevance: ${(score * 100).toFixed(0)}%`);
                lines.push('');
            }

            // 内容（如果是代码，使用代码块）
            if (chunk.metadata.documentType === 'code' && chunk.metadata.codeLanguage) {
                lines.push(`\`\`\`${chunk.metadata.codeLanguage}`);
                lines.push(chunk.content);
                lines.push('```');
            } else {
                lines.push(chunk.content);
            }

            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * 更新格式化选项
     */
    updateOptions(options: Partial<FormatOptions>): void {
        this.options = { ...this.options, ...options };
    }
}

/**
 * 创建 ContextProvider 实例
 */
export function createContextProvider(
    options?: Partial<FormatOptions>
): ContextProvider {
    return new ContextProvider(options);
}
