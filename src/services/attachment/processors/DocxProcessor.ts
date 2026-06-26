/**
 * DocxProcessor - Word 文档处理器
 * 
 * 功能:
 * - 元数据提取 (标题/作者/时间)
 * - 表格转 Markdown
 * - 标题层级识别
 * - 格式清理 (移除空段落、合并空白)
 */

import { BaseProcessor } from './BaseProcessor';
import type { DocumentExtension } from '../constants';
import type {
    DocumentMetadata,
    ProcessorContext,
    TocEntry,
    DocxProcessorConfig,
} from '../types';
import { getLogger } from '@services/logger';

const logger = getLogger('DocxProcessor');

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: DocxProcessorConfig = {
    maxTokens: 32000,
    truncationStrategy: 'head_tail',
    stripFormatting: true,
    preserveTables: true,
    extractMetadata: true,
    paragraphSeparator: '\n\n',
};

// ==================== DocxProcessor 类 ====================

/**
 * Word 文档处理器
 * 
 * 支持 .docx 文件
 */
export class DocxProcessor extends BaseProcessor {
    readonly supportedExtensions: readonly DocumentExtension[] = ['docx'];

    private docxConfig: DocxProcessorConfig;

    constructor(config?: Partial<DocxProcessorConfig>) {
        super(config);
        this.docxConfig = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 处理 Word 文档
     * 
     * @param context - 处理上下文
     * @param rawContent - 由 DocumentProcessingService.readRawContent() 预先解析的文本
     * @param warnings - 警告收集器
     */
    protected processInternal(
        context: ProcessorContext,
        rawContent: string,
        warnings: string[]
    ): { content: string; metadata: DocumentMetadata } {
        // 检查内容是否为空（由上层已调用后端解析，此处直接使用）
        if (!rawContent.trim()) {
            warnings.push('DOCX document content is empty');
            return {
                content: '',
                metadata: {
                    fileType: 'docx',
                    originalSize: context.fileSize,
                },
            };
        }

        // 1. 规范化空白
        let content = this.normalizeWhitespace(rawContent);

        // 2. 格式清理
        if (this.docxConfig.stripFormatting) {
            content = this.stripInlineFormatting(content);
        }

        // 3. 段落分隔符标准化
        content = this.normalizeParagraphs(content);

        // 4. 构建元数据
        const metadata: DocumentMetadata = {
            fileType: 'docx',
            originalSize: context.fileSize,
            lineCount: this.countLines(content),
        };

        // 5. 提取目录结构 (通过分析标题行)
        const toc = this.extractToc(content);
        if (toc.length > 0) {
            metadata.toc = toc;
            // 文档标题取第一个 H1
            const firstH1 = toc.find(entry => entry.level === 1);
            if (firstH1) {
                metadata.title = firstH1.title;
            }
            logger.trace(`[DocxProcessor] 提取目录: ${toc.length} 个标题`);
        }

        // 7. 检测空内容
        if (!content.trim()) {
            warnings.push('Word document content is empty');
        }

        // 8. 添加文档头信息
        const header = this.buildDocumentHeader(context, metadata);
        const finalContent = header + content;

        return { content: finalContent, metadata };
    }

    // ==================== 格式处理方法 ====================

    /**
     * 移除内联格式标记
     * 
     * Word 导出的文本可能包含一些格式残留
     */
    private stripInlineFormatting(content: string): string {
        return content
            // 移除 Windows 回车符
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // 移除零宽字符
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            // 移除非断行空格陷阱
            .replace(/\u00A0/g, ' ');
    }

    /**
     * 标准化段落分隔
     */
    private normalizeParagraphs(content: string): string {
        const separator = this.docxConfig.paragraphSeparator;

        return content
            // 连续空行合并
            .replace(/\n{3,}/g, separator)
            // 单行变双行（保持段落间距）
            .replace(/([^\n])\n([^\n])/g, `$1${separator}$2`)
            .trim();
    }

    /**
     * 提取类似标题的行作为目录
     * 
     * Word 文档解析后没有明确的标题层级，
     * 通过启发式规则识别：全大写、短行、数字编号等
     */
    private extractToc(content: string): TocEntry[] {
        const toc: TocEntry[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim() ?? '';
            if (!line) continue;

            // 模式1: 数字编号标题 (如 "1. 引言"、"1.1 背景")
            const numberedMatch = /^(\d+(?:\.\d+)*)[\s.、]+(.+)$/.exec(line);
            if (numberedMatch?.[1] && numberedMatch[2]) {
                const dots = (numberedMatch[1].match(/\./g) ?? []).length;
                const level = Math.min(dots + 1, 3); // 最多3级
                toc.push({
                    level,
                    title: numberedMatch[2].trim(),
                    pageOrLine: i + 1,
                });
                continue;
            }

            // 模式2: 罗马数字/中文数字标题 (如 "一、概述")
            const sectionMatch = /^(?:[IVXLCDM]+|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)[\u3001.\uff0e]\s*(.+)$/i.exec(line);
            if (sectionMatch?.[1]) {
                toc.push({
                    level: 1,
                    title: sectionMatch[1].trim(),
                    pageOrLine: i + 1,
                });
                continue;
            }

            // 模式3: 短行全大写 (可能是英文标题)
            if (line.length <= 50 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
                toc.push({
                    level: 1,
                    title: line,
                    pageOrLine: i + 1,
                });
            }
        }

        return toc;
    }

    /**
     * 构建文档头信息
     */
    private buildDocumentHeader(context: ProcessorContext, metadata: DocumentMetadata): string {
        const parts: string[] = [];

        parts.push(`## Document: ${context.fileName}`);

        const infoParts: string[] = [];
        if (metadata.lineCount) {
            infoParts.push(`${metadata.lineCount} lines`);
        }
        infoParts.push(`${(context.fileSize / 1024).toFixed(1)} KB`);

        parts.push(`**Info**: ${infoParts.join(' | ')}`);

        // 如果有目录，添加目录预览
        if (metadata.toc && metadata.toc.length > 0) {
            const tocPreview = metadata.toc
                .slice(0, 5)
                .map(entry => `${'  '.repeat(entry.level - 1)}- ${entry.title}`)
                .join('\n');
            parts.push('**Table of Contents** (first 5 items):');
            parts.push(tocPreview);
        }

        return parts.join('\n') + '\n\n---\n\n';
    }
}

// ==================== 导出单例 ====================

export const docxProcessor = new DocxProcessor();
