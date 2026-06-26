/**
 * PdfProcessor - PDF 文档处理器
 * 
 * 功能:
 * - 文字版/扫描版检测
 * - 分页策略处理
 * - 目录结构提取
 * - 大文档 RAG 索引建议
 */

import { BaseProcessor } from './BaseProcessor';
import { type DocumentExtension, PDF_PAGE_ESTIMATION } from '../constants';
import type {
    DocumentMetadata,
    ProcessorContext,
    TocEntry,
    PdfProcessorConfig,
} from '../types';
import { getLogger } from '@services/logger';

const logger = getLogger('PdfProcessor');

// ==================== 常量配置 ====================

/** PDF 分页策略配置 */
const PAGE_CONFIG = {
    /** 小型 PDF 页数阈值 */
    SMALL_PDF_THRESHOLD: 10,
    /** 中型 PDF 页数阈值 */
    MEDIUM_PDF_THRESHOLD: 50,
    /** 中型 PDF 保留首页数 */
    MEDIUM_PDF_HEAD_PAGES: 5,
    /** 中型 PDF 保留关键页数 */
    MEDIUM_PDF_KEY_PAGES: 3,
    /** 大型 PDF 保留首页数 */
    LARGE_PDF_HEAD_PAGES: 10,
} as const;

/** 扫描版检测配置 */
const SCAN_DETECTION = {
    /** 文本密度阈值 (字符/页) */
    TEXT_DENSITY_THRESHOLD: 100,
    /** 最小有效字符比例 */
    MIN_VALID_CHAR_RATIO: 0.3,
} as const;

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: PdfProcessorConfig = {
    maxTokens: 32000,
    truncationStrategy: 'head_tail',
    pageHandling: 'first_n',
    maxPages: 30,
    ocrDetection: true,
    scannedPdfStrategy: 'warn',
};

// ==================== PdfProcessor 类 ====================

/**
 * PDF 文档处理器
 * 
 * 支持 .pdf 文件
 */
export class PdfProcessor extends BaseProcessor {
    readonly supportedExtensions: readonly DocumentExtension[] = ['pdf'];

    private pdfConfig: PdfProcessorConfig;

    constructor(config?: Partial<PdfProcessorConfig>) {
        super(config);
        this.pdfConfig = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 处理 PDF 文档
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
            // 可能是扫描版 PDF
            return this.handleScannedPdf(context, 'PDF content is empty; it may be scanned', warnings);
        }

        // 1. 检测扫描版 PDF (通过文本密度)
        if (this.pdfConfig.ocrDetection) {
            const scanResult = this.detectScannedPdf(rawContent, context.fileSize);
            if (scanResult.isScanned) {
                warnings.push(scanResult.message);
                if (this.pdfConfig.scannedPdfStrategy === 'reject') {
                    return this.handleScannedPdf(context, scanResult.message, warnings);
                }
            }
        }

        // 2. 规范化空白
        const content = this.normalizeWhitespace(rawContent);

        // 3. 估算页数
        const estimatedPages = this.estimatePageCount(content, context.fileSize);

        // 4. 根据页数决定处理策略
        let processedContent = content;
        let pageInfo = '';

        if (estimatedPages > PAGE_CONFIG.SMALL_PDF_THRESHOLD) {
            const result = this.applyPageStrategy(content, estimatedPages, warnings);
            processedContent = result.content;
            pageInfo = result.info;
        }

        // 5. 构建元数据
        const metadata: DocumentMetadata = {
            fileType: 'pdf',
            originalSize: context.fileSize,
            pageCount: estimatedPages,
        };

        // 6. 提取目录结构
        const toc = this.extractToc(content);
        if (toc.length > 0) {
            metadata.toc = toc;
            logger.trace(`[PdfProcessor] 提取目录: ${toc.length} 个条目`);
        }

        // 7. 检测空内容
        if (!processedContent.trim()) {
            warnings.push('PDF document content is empty');
        }

        // 8. 构建最终输出
        const header = this.buildDocumentHeader(context, metadata, pageInfo);
        const finalContent = header + processedContent;

        return { content: finalContent, metadata };
    }

    // ==================== 扫描版检测 ====================

    /**
     * 检测是否为扫描版 PDF
     */
    private detectScannedPdf(
        content: string,
        fileSize: number
    ): { isScanned: boolean; message: string } {
        // 方法1: 文本密度检测
        const estimatedPages = Math.max(1, Math.ceil(fileSize / PDF_PAGE_ESTIMATION.BYTES_PER_PAGE));
        const charsPerPage = content.length / estimatedPages;

        if (charsPerPage < SCAN_DETECTION.TEXT_DENSITY_THRESHOLD) {
            return {
                isScanned: true,
                message: `Text density is too low (${charsPerPage.toFixed(0)} chars/page); this may be a scanned PDF`,
            };
        }

        // 方法2: 有效字符比例检测
        let validChars = 0;
        for (const char of content) {
            const code = char.charCodeAt(0);
            if (!/\s/.test(char) && code > 0x1F && (code < 0x7F || code > 0x9F)) {
                validChars++;
            }
        }
        const validRatio = validChars / content.length;

        if (validRatio < SCAN_DETECTION.MIN_VALID_CHAR_RATIO) {
            return {
                isScanned: true,
                message: `Valid character ratio is too low (${(validRatio * 100).toFixed(1)}%); this may be a scanned PDF`,
            };
        }

        return { isScanned: false, message: '' };
    }

    /**
     * 处理扫描版 PDF
     */
    private handleScannedPdf(
        context: ProcessorContext,
        errorMessage: string,
        warnings: string[]
    ): { content: string; metadata: DocumentMetadata } {
        warnings.push('Scanned PDF detected; text cannot be extracted');
        warnings.push('Use Adobe Acrobat or an online OCR tool to convert it to searchable text');

        const content = [
            `## PDF Document: ${context.fileName}`,
            '',
            '### Scanned PDF Warning',
            '',
            'This document appears to be a scanned PDF (image-based), so text cannot be extracted directly.',
            '',
            '**Possible Causes**:',
            '- The document was scanned from paper',
            '- The document uses embedded images instead of a text layer',
            '',
            '**Suggested Fixes**:',
            '1. Use Adobe Acrobat Pro OCR',
            '2. Use an online OCR service such as SmallPDF or iLovePDF',
            '3. Use a local OCR tool such as Tesseract',
            '',
            `**Error Details**: ${errorMessage}`,
        ].join('\n');

        return {
            content,
            metadata: {
                fileType: 'pdf',
                originalSize: context.fileSize,
            },
        };
    }

    // ==================== 分页处理 ====================

    /**
     * 估算 PDF 页数
     */
    private estimatePageCount(content: string, fileSize: number): number {
        // 方法1: 通过分页符估算
        const pageBreaks = (content.match(/\f/g) ?? []).length;
        if (pageBreaks > 0) {
            return pageBreaks + 1;
        }

        // 方法2: 通过文本字符数估算
        const textBasedEstimate = Math.ceil(content.length / PDF_PAGE_ESTIMATION.CHARS_PER_PAGE);

        // 方法3: 通过文件大小估算
        const sizeBasedEstimate = Math.ceil(fileSize / PDF_PAGE_ESTIMATION.BYTES_PER_PAGE);

        // 取较大值
        return Math.max(textBasedEstimate, sizeBasedEstimate, 1);
    }

    /**
     * 应用分页策略
     */
    private applyPageStrategy(
        content: string,
        estimatedPages: number,
        warnings: string[]
    ): { content: string; info: string } {
        // 尝试按分页符分割
        let pages = content.split('\f');

        // 如果没有分页符，按字符数模拟分页
        if (pages.length === 1) {
            pages = this.simulatePages(content, estimatedPages);
        }

        const totalPages = pages.length;

        if (totalPages <= PAGE_CONFIG.SMALL_PDF_THRESHOLD) {
            // 小型 PDF: 全量处理
            return { content, info: '' };
        }

        if (totalPages <= PAGE_CONFIG.MEDIUM_PDF_THRESHOLD) {
            // 中型 PDF: 首页 + 关键页
            const headPages = pages.slice(0, PAGE_CONFIG.MEDIUM_PDF_HEAD_PAGES);
            const keyPages = this.selectKeyPages(pages.slice(PAGE_CONFIG.MEDIUM_PDF_HEAD_PAGES));

            const processed = [
                ...headPages,
                '\n\n[... Some pages omitted; use knowledge base retrieval ...]\n\n',
                ...keyPages,
            ].join('\n\n--- Page Break ---\n\n');

            warnings.push(`PDF has ${totalPages} pages; key content has been extracted`);

            return {
                content: processed,
                info: ` (${headPages.length + keyPages.length}/${totalPages} pages)`,
            };
        }

        // 大型 PDF: 仅首页 + 建议 RAG
        const headPages = pages.slice(0, PAGE_CONFIG.LARGE_PDF_HEAD_PAGES);

        const processed = [
            ...headPages,
            `\n\n[... Remaining ${totalPages - PAGE_CONFIG.LARGE_PDF_HEAD_PAGES} pages have been indexed into the knowledge base and can be retrieved through Q&A ...]\n`,
        ].join('\n\n--- Page Break ---\n\n');

        warnings.push(`PDF is large (${totalPages} pages); using knowledge base retrieval is recommended instead of direct reading`);

        return {
            content: processed,
            info: ` (${PAGE_CONFIG.LARGE_PDF_HEAD_PAGES}/${totalPages} pages, remaining pages to RAG)`,
        };
    }

    /**
     * 模拟分页 (当没有分页符时)
     */
    private simulatePages(content: string, estimatedPages: number): string[] {
        const charsPerPage = Math.ceil(content.length / estimatedPages);
        const pages: string[] = [];

        for (let i = 0; i < content.length; i += charsPerPage) {
            pages.push(content.slice(i, i + charsPerPage));
        }

        return pages;
    }

    /**
     * 选择关键页面 (通过标题或关键词)
     */
    private selectKeyPages(pages: string[]): string[] {
        const keyPages: string[] = [];
        const maxKeyPages = PAGE_CONFIG.MEDIUM_PDF_KEY_PAGES;

        // 优先选择包含目录、结论、摘要的页面
        const keywordPatterns = [
            /\u76ee\s*\u5f55|contents|table of contents/i,
            /\u6458\u8981|abstract|summary/i,
            /\u7ed3\u8bba|conclusion/i,
            /\u53c2\u8003\u6587\u732e|references/i,
        ];

        for (const page of pages) {
            if (keyPages.length >= maxKeyPages) break;

            for (const pattern of keywordPatterns) {
                if (pattern.test(page)) {
                    keyPages.push(page);
                    break;
                }
            }
        }

        return keyPages;
    }

    // ==================== 目录提取 ====================

    /**
     * 提取 PDF 目录结构
     */
    private extractToc(content: string): TocEntry[] {
        const toc: TocEntry[] = [];
        const lines = content.split('\n');

        // 目录区域检测
        let inToc = false;

        for (let i = 0; i < Math.min(lines.length, 200); i++) {
            const line = lines[i]?.trim() ?? '';

            // 检测目录开始
            if (/^(\u76ee\s*\u5f55|CONTENTS|TABLE OF CONTENTS)$/i.test(line)) {
                inToc = true;
                continue;
            }

            // 在目录区域内，提取条目
            if (inToc) {
                // 目录条目模式: "第一章 xxx.......5" 或 "1. xxx 5"
                const tocMatch = /^(.+?)[.\s…·]+(\d+)\s*$/.exec(line);
                if (tocMatch?.[1] && tocMatch[2]) {
                    const title = tocMatch[1].trim();
                    const pageNum = parseInt(tocMatch[2], 10);

                    // 判断层级
                    const level = this.inferTocLevel(title);

                    toc.push({
                        level,
                        title,
                        pageOrLine: pageNum,
                    });
                }

                // 检测目录结束 (遇到正文开始)
                if (line.length > 100 || /^(\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u7ae0|Chapter|Section|Part|Appendix)/i.test(line)) {
                    break;
                }
            }
        }

        // 如果没找到目录，尝试从正文提取标题
        if (toc.length === 0) {
            return this.extractHeadingsFromContent(content);
        }

        return toc;
    }

    /**
     * 推断目录条目层级
     */
    private inferTocLevel(title: string): number {
        // 第一章、Chapter 1 等为一级
        if (/^(\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u7ae0|Chapter\s+\d+|Part\s+\d+|Appendix\s+[A-Z\d]+)/i.test(title)) {
            return 1;
        }
        // 1.1、Section 1.1 等为二级
        if (/^(\d+\.\d+|Section\s+\d+\.\d+)/i.test(title)) {
            return 2;
        }
        // 1.1.1 等为三级
        if (/^\d+\.\d+\.\d+/.test(title)) {
            return 3;
        }
        // 默认为一级
        return 1;
    }

    /**
     * 从正文内容提取标题
     */
    private extractHeadingsFromContent(content: string): TocEntry[] {
        const toc: TocEntry[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim() ?? '';
            if (!line) continue;

            // 中文章节标题
            const chapterMatch = /^\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+[\u7ae0\u8282\u7bc7]\s*(.+)$/.exec(line);
            if (chapterMatch?.[1]) {
                toc.push({
                    level: 1,
                    title: chapterMatch[1],
                    pageOrLine: i + 1,
                });
                continue;
            }

            // 数字编号标题
            const numberedMatch = /^(\d+(?:\.\d+)*)[.\s\u3001]+(.+)$/.exec(line);
            if (numberedMatch?.[1] && numberedMatch[2] && line.length < 80) {
                const dots = (numberedMatch[1].match(/\./g) ?? []).length;
                toc.push({
                    level: Math.min(dots + 1, 3),
                    title: numberedMatch[2].trim(),
                    pageOrLine: i + 1,
                });
            }
        }

        return toc.slice(0, 20); // 限制提取数量
    }

    // ==================== 格式化输出 ====================

    /**
     * 构建文档头信息
     */
    private buildDocumentHeader(
        context: ProcessorContext,
        metadata: DocumentMetadata,
        pageInfo: string
    ): string {
        const parts: string[] = [];

        parts.push(`## PDF: ${context.fileName}`);

        const infoParts: string[] = [];
        if (metadata.pageCount) {
            infoParts.push(`${metadata.pageCount} pages${pageInfo}`);
        }
        infoParts.push(`${(context.fileSize / 1024 / 1024).toFixed(1)} MB`);

        parts.push(`**Basic Info**: ${infoParts.join(', ')}`);

        // 如果有目录，添加目录预览
        if (metadata.toc && metadata.toc.length > 0) {
            parts.push('');
            parts.push('**Table of Contents** (auto-extracted):');
            const tocPreview = metadata.toc
                .slice(0, 10)
                .map(entry => {
                    const indent = '  '.repeat(entry.level - 1);
                    const pageNum = entry.pageOrLine ? ` (P.${entry.pageOrLine})` : '';
                    return `${indent}- ${entry.title}${pageNum}`;
                })
                .join('\n');
            parts.push(tocPreview);
            if (metadata.toc.length > 10) {
                parts.push(`  ... (${metadata.toc.length} items total)`);
            }
        }

        return parts.join('\n') + '\n\n---\n\n**Content Preview**:\n\n';
    }
}

// ==================== 导出单例 ====================

export const pdfProcessor = new PdfProcessor();
