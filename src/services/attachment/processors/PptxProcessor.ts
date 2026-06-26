/**
 * PptxProcessor - PowerPoint 文档处理器
 * 
 * 功能:
 * - 幻灯片结构保留
 * - Markdown 格式优化
 * - 格式清理
 */

import { BaseProcessor } from './BaseProcessor';
import type { DocumentExtension } from '../constants';
import type {
    DocumentMetadata,
    ProcessorContext,
    TocEntry,
} from '../types';
import { getLogger } from '@services/logger';

const logger = getLogger('PptxProcessor');

// ==================== 默认配置 ====================

interface PptxProcessorConfig {
    maxTokens: number;
    truncationStrategy: 'head' | 'tail' | 'head_tail';
    stripFormatting: boolean;
}

const DEFAULT_CONFIG: PptxProcessorConfig = {
    maxTokens: 32000,
    truncationStrategy: 'head_tail',
    stripFormatting: true,
};

// ==================== PptxProcessor 类 ====================

/**
 * PowerPoint 文档处理器
 * 
 * 支持 .pptx 文件
 */
export class PptxProcessor extends BaseProcessor {
    readonly supportedExtensions: readonly DocumentExtension[] = ['pptx'];

    private pptxConfig: PptxProcessorConfig;

    constructor(config?: Partial<PptxProcessorConfig>) {
        super(config);
        this.pptxConfig = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 处理 PowerPoint 文档
     * 
     * @param context - 处理上下文
     * @param rawContent - 由后端 parse_pptx 预先解析的 Markdown 文本
     * @param warnings - 警告收集器
     */
    protected processInternal(
        context: ProcessorContext,
        rawContent: string,
        warnings: string[]
    ): { content: string; metadata: DocumentMetadata } {
        // 检查内容是否为空
        if (!rawContent.trim()) {
            warnings.push('PowerPoint document content is empty');
            return {
                content: '',
                metadata: {
                    fileType: 'pptx',
                    originalSize: context.fileSize,
                },
            };
        }

        // 1. 规范化空白
        let content = this.normalizeWhitespace(rawContent);

        // 2. 格式清理
        if (this.pptxConfig.stripFormatting) {
            content = this.stripInlineFormatting(content);
        }

        // 3. 统计幻灯片数量
        const slideCount = this.countSlides(content);

        // 4. 构建元数据
        const metadata: DocumentMetadata = {
            fileType: 'pptx',
            originalSize: context.fileSize,
            lineCount: this.countLines(content),
        };

        // 5. 提取目录结构 (幻灯片标题)
        const toc = this.extractToc(content);
        if (toc.length > 0) {
            metadata.toc = toc;
            // 文档标题取第一张幻灯片标题
            if (toc[0]) {
                metadata.title = toc[0].title;
            }
            logger.trace(`[PptxProcessor] 提取目录: ${toc.length} 张幻灯片`);
        }

        // 6. 检测空内容
        if (!content.trim()) {
            warnings.push('PowerPoint document content is empty');
        }

        // 7. 添加文档头信息
        const header = this.buildDocumentHeader(context, metadata, slideCount);
        const finalContent = header + content;

        return { content: finalContent, metadata };
    }

    // ==================== 格式处理方法 ====================

    /**
     * 移除内联格式标记
     */
    private stripInlineFormatting(content: string): string {
        return content
            // 移除 Windows 回车符
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // 移除零宽字符
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            // 移除非断行空格
            .replace(/\u00A0/g, ' ');
    }

    /**
     * 统计幻灯片数量
     * 
     * 通过匹配 "## 幻灯片 N" 格式来计数
     */
    private countSlides(content: string): number {
        const matches = content.match(/^## (?:\u5e7b\u706f\u7247|Slide|Page) \d+/gm);
        return matches ? matches.length : 0;
    }

    /**
     * 提取幻灯片标题作为目录
     */
    private extractToc(content: string): TocEntry[] {
        const toc: TocEntry[] = [];
        const lines = content.split('\n');

        // 查找每张幻灯片的第一个内容行作为标题
        let currentSlide = 0;
        let expectNextAsTitle = false;

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            // 匹配幻灯片开始标记
            const slideMatch = /^## (?:\u5e7b\u706f\u7247|Slide|Page) (\d+)/.exec(line);
            if (slideMatch?.[1]) {
                currentSlide = parseInt(slideMatch[1], 10);
                expectNextAsTitle = true;
                continue;
            }

            // 分隔线跳过
            if (line === '---') {
                continue;
            }

            // 取非空内容行作为标题
            if (expectNextAsTitle && line.length > 0) {
                // 移除可能的 Markdown 标题符号
                let title = line.replace(/^#+\s*/, '').trim();
                // 限制标题长度
                if (title.length > 50) {
                    title = title.substring(0, 47) + '...';
                }

                toc.push({
                    level: 1,
                    title: title || `Slide ${currentSlide}`,
                    pageOrLine: currentSlide,
                });
                expectNextAsTitle = false;
            }
        }

        return toc;
    }

    /**
     * 构建文档头信息
     */
    private buildDocumentHeader(
        context: ProcessorContext,
        metadata: DocumentMetadata,
        slideCount: number
    ): string {
        const parts: string[] = [];

        parts.push(`## Presentation: ${context.fileName}`);

        const infoParts: string[] = [];
        if (slideCount > 0) {
            infoParts.push(`${slideCount} slides`);
        }
        if (metadata.lineCount) {
            infoParts.push(`${metadata.lineCount} lines`);
        }
        infoParts.push(`${(context.fileSize / 1024).toFixed(1)} KB`);

        parts.push(`**Info**: ${infoParts.join(' | ')}`);

        // 如果有目录，添加目录预览
        if (metadata.toc && metadata.toc.length > 0) {
            const tocPreview = metadata.toc
                .slice(0, 5)
                .map(entry => `- Slide ${entry.pageOrLine ?? '?'}: ${entry.title}`)
                .join('\n');
            parts.push('**Content** (first 5 slides):');
            parts.push(tocPreview);
        }

        return parts.join('\n') + '\n\n---\n\n';
    }
}

// ==================== 导出单例 ====================

export const pptxProcessor = new PptxProcessor();
