/**
 * DocumentProcessingService - 文档处理核心服务
 * 
 * 功能:
 * - 文档验证 (大小、格式)
 * - 处理器调度
 * - 处理结果封装
 */

import { invoke } from '@tauri-apps/api/core';

import {
    FORMAT_MAX_SIZE,
    DOCUMENT_SIZE_THRESHOLDS,
    SUPPORTED_DOCUMENT_EXTENSIONS,
    getProcessingLevel,
    DocumentProcessingLevel,
    DOCUMENT_ERROR_MESSAGES,
    type DocumentExtension,
} from './constants';

import type {
    DocumentProcessingResult,
    ProcessorContext,
} from './types';

import { DocumentProcessingError } from './types';
import { getProcessor, hasProcessor } from './processors';
import { getLogger } from '@services/logger';

const logger = getLogger('DocumentProcessingService');

// ==================== 类型定义 ====================

/** 文档验证结果 */
interface DocumentValidationResult {
    /** 是否有效 */
    valid: boolean;
    /** 处理级别 */
    level?: DocumentProcessingLevel;
    /** 错误信息 */
    error?: string;
    /** 文件大小 (字节) */
    size?: number;
}

/** 处理选项 */
interface ProcessingOptions {
    /** 强制处理级别 */
    forceLevel?: DocumentProcessingLevel;
    /** 跳过大小验证 */
    skipSizeValidation?: boolean;
}

// ==================== DocumentProcessingService 类 ====================

/**
 * 文档处理服务
 * 
 * 对外统一入口，协调验证、解析和处理器调度
 */
export class DocumentProcessingService {

    /**
     * 验证文档是否可处理
     * 
     * @param filePath - 文件路径
     * @param extension - 文件扩展名
     * @param knownSize - 可选，已知文件大小（避免重复获取）
     * @returns 验证结果
     */
    async validateDocument(
        filePath: string,
        extension: string,
        knownSize?: number
    ): Promise<DocumentValidationResult> {
        const ext = extension.toLowerCase() as DocumentExtension;

        // 1. 检查格式是否支持
        if (!SUPPORTED_DOCUMENT_EXTENSIONS.includes(ext)) {
            return {
                valid: false,
                error: DOCUMENT_ERROR_MESSAGES.UNSUPPORTED_FORMAT(ext),
            };
        }

        // 2. 检查是否有对应处理器
        if (!hasProcessor(ext)) {
            return {
                valid: false,
                error: `${ext.toUpperCase()} processor is not implemented yet`,
            };
        }

        // 3. 获取文件大小（如已知则复用，避免重复 IPC）
        let size: number;
        if (knownSize !== undefined) {
            size = knownSize;
        } else {
            try {
                size = await invoke<number>('file_get_size', { path: filePath });
            } catch (error) {
                return {
                    valid: false,
                    error: `Failed to get file size: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        }

        // 4. 检查格式专属大小限制
        const maxSize = FORMAT_MAX_SIZE[ext];
        if (size > maxSize) {
            return {
                valid: false,
                error: DOCUMENT_ERROR_MESSAGES.FILE_TOO_LARGE(size, maxSize, ext),
                size,
            };
        }

        // 5. 确定处理级别
        const level = getProcessingLevel(size);

        // 6. 超大文件拒绝处理
        if (level === DocumentProcessingLevel.REJECTED) {
            return {
                valid: false,
                error: DOCUMENT_ERROR_MESSAGES.FILE_TOO_LARGE(size, DOCUMENT_SIZE_THRESHOLDS.LARGE, ext),
                size,
            };
        }

        return {
            valid: true,
            level,
            size,
        };
    }

    /**
     * 处理文档
     * 
     * @param filePath - 文件路径
     * @param fileName - 文件名
     * @param extension - 文件扩展名
     * @param agentId - Agent ID
     * @param options - 处理选项
     * @returns 处理结果
     */
    async processDocument(
        filePath: string,
        fileName: string,
        extension: string,
        agentId: string,
        options?: ProcessingOptions,
        knownSize?: number
    ): Promise<DocumentProcessingResult> {
        const ext = extension.toLowerCase() as DocumentExtension;

        // 1. 获取文件大小（复用传入的 knownSize 避免重复 IPC）
        let fileSize: number;
        if (knownSize !== undefined) {
            fileSize = knownSize;
        } else {
            fileSize = await invoke<number>('file_get_size', { path: filePath });
        }

        // 2. 验证文档 (除非跳过)，传入已知大小避免重复获取
        if (!options?.skipSizeValidation) {
            const validation = await this.validateDocument(filePath, ext, fileSize);
            if (!validation.valid) {
                throw new DocumentProcessingError(
                    'FILE_TOO_LARGE',
                    validation.error ?? 'Document validation failed',
                    { size: validation.size }
                );
            }
        }

        // 3. 读取原始内容
        const rawContent = await this.readRawContent(filePath, ext);

        if (!rawContent.trim()) {
            throw new DocumentProcessingError(
                'EMPTY_DOCUMENT',
                DOCUMENT_ERROR_MESSAGES.EMPTY_DOCUMENT()
            );
        }

        // 4. 获取处理器
        const processor = getProcessor(ext);
        if (!processor) {
            throw new DocumentProcessingError(
                'UNSUPPORTED_FORMAT',
                DOCUMENT_ERROR_MESSAGES.UNSUPPORTED_FORMAT(ext)
            );
        }

        // 5. 构建上下文
        const context: ProcessorContext = {
            filePath,
            fileName,
            extension: ext,
            fileSize,
            agentId,
        };

        // 6. 执行处理
        logger.trace(`[DocumentProcessingService] 开始处理: ${fileName} (${ext}, ${(fileSize / 1024).toFixed(1)} KB)`);

        const result = await processor.process(context, rawContent);

        logger.trace(`[DocumentProcessingService] 处理完成: ${fileName}`,
            `- Token: ${result.estimatedTokens}`,
            `- 截断: ${result.wasTruncated}`,
            `- RAG Only: ${result.ragOnly}`,
            `- 警告: ${result.warnings.length}`
        );

        return result;
    }

    /**
     * 快速估算文档 Token 数 (不做完整处理)
     * 
     * @param filePath - 文件路径
     * @param extension - 文件扩展名
     * @returns 估算的 Token 数
     */
    async estimateTokens(filePath: string, extension: string): Promise<number> {
        const ext = extension.toLowerCase() as DocumentExtension;
        const rawContent = await this.readRawContent(filePath, ext);

        // 使用简化的估算公式
        let chineseCount = 0;
        let otherCount = 0;

        for (const char of rawContent) {
            if (/[\u4e00-\u9fff]/.test(char)) {
                chineseCount++;
            } else {
                otherCount++;
            }
        }

        return Math.ceil(chineseCount / 1.5 + otherCount / 4);
    }

    /**
     * 获取处理级别描述
     */
    getLevelDescription(level: DocumentProcessingLevel): string {
        switch (level) {
            case DocumentProcessingLevel.FULL_LOAD:
                return 'Full load';
            case DocumentProcessingLevel.SMART_SUMMARY:
                return 'Smart summary';
            case DocumentProcessingLevel.RAG_ONLY:
                return 'Knowledge base indexing only';
            case DocumentProcessingLevel.REJECTED:
                return 'Rejected';
            default:
                return 'Unknown';
        }
    }

    // ==================== 私有方法 ====================

    /**
     * 读取原始文档内容
     *
     * Office 格式（docx/xlsx/pdf/pptx）需要专用的 Rust 解析器提取文本；
     * Markdown/纯文本/代码/配置文件走通用文本读取命令，避免扩展名专用命令误拒。
     */
    private async readRawContent(filePath: string, extension: DocumentExtension): Promise<string> {
        switch (extension) {
            // Office 格式：需要专属 Rust 解析器
            case 'docx':
                return await invoke<string>('parse_docx', { filePath });
            case 'xlsx':
                return await invoke<string>('parse_xlsx', { filePath });
            case 'pdf':
                return await invoke<string>('parse_pdf', { filePath });
            case 'pptx':
                return await invoke<string>('parse_pptx', { filePath });

            default: {
                const { PLAIN_TEXT_FORMATS } = await import('./constants');
                if ((PLAIN_TEXT_FORMATS as readonly string[]).includes(extension)) {
                    // 纯文本/代码/配置格式使用通用读取，避免 parse_txt 的 .txt 扩展名限制。
                    return await invoke<string>('file_read_content', { filePath });
                }
                throw new DocumentProcessingError(
                    'UNSUPPORTED_FORMAT',
                    `Unsupported format: ${extension}`
                );
            }
        }
    }
}

// ==================== 导出单例 ====================

export const documentProcessingService = new DocumentProcessingService();
