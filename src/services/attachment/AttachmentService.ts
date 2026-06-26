/**
 * AttachmentService - 附件管理核心服务
 * 
 * 功能：
 * - 验证文件类型
 * - 复制文件到应用目录
 * - 解析文档内容 (通过 DocumentProcessingService)
 * - 索引到知识库
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { AttachmentInfo, AttachmentType } from '@/types/message';
import {
    imageCompressionService,
    ImageCompressionError,
    CompressionErrorCode,
} from './ImageCompressionService';
import { documentProcessingService } from './DocumentProcessingService';
import { DocumentProcessingError } from './types';
import { ATTACHMENT_SIZE_LIMITS, DOCUMENT_PROGRESS_MESSAGES, PLAIN_TEXT_FORMATS } from './constants';
import type { DocumentProcessingResult } from './types';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('AttachmentService');

// ==================== 常量定义 ====================

/** 支持的图片扩展名 */
const SUPPORTED_IMAGES = ['jpeg', 'jpg', 'png', 'webp', 'heif', 'heic'] as const;

/** 支持的文档扩展名 */
const SUPPORTED_DOCUMENTS = [
    // 办公文档
    'docx', 'xlsx', 'pdf', 'txt', 'md', 'pptx',
    // 代码文件（Web 与前端）
    'html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx',
    // 代码文件（通用编程语言）
    'py', 'go', 'rs',
    // 配置与数据格式
    'json', 'yaml', 'yml', 'toml', 'sql',
] as const;

/** 所有支持的扩展名 */
const ALL_SUPPORTED_EXTENSIONS = [...SUPPORTED_IMAGES, ...SUPPORTED_DOCUMENTS] as const;

/** 用于 Toast 提示的格式显示字符串 */
export const SUPPORTED_FORMATS_DISPLAY = [
    // 图片
    'JPEG, PNG, WebP, HEIF/HEIC',
    // 办公文档
    'DOCX, XLSX, PDF, TXT, MD, PPTX',
    // 代码文件
    'HTML, CSS, SCSS, JS/JSX, TS/TSX, PY, GO, RS',
    // 配置文件
    'JSON, YAML, TOML, SQL',
].join(' | ');

// ==================== 类型定义 ====================

/** 文件验证结果 */
interface ValidationResult {
    valid: boolean;
    type?: AttachmentType;
    error?: string;
}

interface AddAttachmentOptions {
    targetDir?: string;
}

// ==================== 工具函数 ====================

/**
 * 获取文件扩展名（小写，不含点号）
 */
function getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filePath.substring(lastDot + 1).toLowerCase();
}

/**
 * 获取文件名（不含路径）
 */
function getFileName(filePath: string): string {
    // 处理 Windows 和 Unix 路径
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1);
}

/**
 * 生成 UUID
 */
function generateId(): string {
    return crypto.randomUUID();
}

// ==================== AttachmentService 类 ====================

/**
 * AttachmentService 附件管理服务
 */
export class AttachmentService {
    /**
     * 验证文件类型
     * 
     * @param filePath - 文件路径
     * @returns 验证结果
     */
    validateFile(filePath: string): ValidationResult {
        const ext = getFileExtension(filePath);

        if (!ext) {
            return { valid: false, error: 'File has no extension' };
        }

        // 检查是否为图片
        if ((SUPPORTED_IMAGES as readonly string[]).includes(ext)) {
            return { valid: true, type: 'image' };
        }

        // 检查是否为文档
        if ((SUPPORTED_DOCUMENTS as readonly string[]).includes(ext)) {
            return { valid: true, type: 'document' };
        }

        return {
            valid: false,
            error: translate('chat.unsupportedFileFormatDescription', {
                extension: ext,
                formats: ALL_SUPPORTED_EXTENSIONS.join(', '),
            }),
        };
    }

    /**
     * 打开文件选择对话框（单选）
     * 
     * @returns 选择的文件路径，取消返回 null
     * @deprecated 使用 selectFiles() 代替
     */
    async selectFile(): Promise<string | null> {
        const result = await open({
            multiple: false,
            filters: [{
                name: translate('chat.attachmentFilterName'),
                extensions: [...ALL_SUPPORTED_EXTENSIONS],
            }],
        });

        // 取消选择
        if (!result) return null;

        return result;
    }

    /**
     * 打开文件选择对话框（多选）
     * 
     * @returns 选择的文件路径数组，取消返回空数组
     */
    async selectFiles(): Promise<string[]> {
        const result = await open({
            multiple: true,
            filters: [{
                name: translate('chat.attachmentFilterName'),
                extensions: [...ALL_SUPPORTED_EXTENSIONS],
            }],
        });

        // 取消选择
        if (!result) return [];

        // 单选时返回字符串，多选时返回数组
        return Array.isArray(result) ? result : [result];
    }

    /**
     * 添加附件
     * 
     * 完整流程：验证 → 复制 → 解析（如果是文档）/ 读取 base64（如果是图片）
     * 
     * @param filePath - 源文件路径
     * @param agentId - Agent ID
     * @returns 附件信息
     */
    async addAttachment(filePath: string, agentId: string, options: AddAttachmentOptions = {}): Promise<AttachmentInfo> {
        // 1. 验证文件类型
        const validation = this.validateFile(filePath);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // 2. 获取文件大小
        const size = await invoke<number>('file_get_size', { path: filePath });

        // 图片类型特殊处理：先检查原始大小，再压缩
        if (validation.type === 'image') {
            // 图片 5MB 限制检查（压缩前）
            if (size > ATTACHMENT_SIZE_LIMITS.IMAGE_MAX) {
                // 抛出带特定 code 的错误，方便 UI 层识别并显示 Toast
                const error = new ImageCompressionError(
                    CompressionErrorCode.FILE_TOO_LARGE,
                    translate('chat.imageTooLargeError', { size: (size / 1024 / 1024).toFixed(1) })
                );
                throw error;
            }

            const localPath = await this.copyToAttachmentStorage(filePath, agentId, options.targetDir);

            // 压缩图片
            try {
                const originalFileName = getFileName(localPath);
                const compressionResult = await imageCompressionService.compressImage(localPath, originalFileName);

                // 将压缩后的 Blob 转为 base64
                const base64Data = await imageCompressionService.toBase64(compressionResult);

                // 构建附件信息（使用压缩后的数据）
                const attachment: AttachmentInfo = {
                    id: generateId(),
                    fileName: compressionResult.fileName,
                    fileExtension: 'webp',  // 统一转为 WebP
                    type: 'image',
                    size: compressionResult.compressedSize,
                    localPath,
                    originalPath: filePath,
                    base64Data,
                    createdAt: Date.now(),
                };

                logger.trace(`[AttachmentService] 图片压缩完成: ${originalFileName} → ${compressionResult.fileName}`,
                    `(${(compressionResult.originalSize / 1024).toFixed(1)}KB → ${(compressionResult.compressedSize / 1024).toFixed(1)}KB)`);

                return attachment;
            } catch (error) {
                // 如果是压缩服务抛出的错误，直接向上抛出
                if (error instanceof ImageCompressionError) {
                    throw error;
                }
                // 其他错误包装后抛出
                logger.error('[AttachmentService] 图片压缩失败:', error);
                throw new Error(translate('chat.imageProcessingFailedDescription', {
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        }

        // 文档类型处理：先进行格式专属验证（更严格的限制优先）
        // 传入已知的 size，避免 validateDocument 重复调用 file_get_size
        const ext = getFileExtension(filePath);
        const validationResult = await documentProcessingService.validateDocument(filePath, ext, size);
        if (!validationResult.valid) {
            throw new DocumentProcessingError(
                'FILE_TOO_LARGE',
                validationResult.error ?? 'File validation failed',
                { size: validationResult.size }
            );
        }

        // 通用最大限制作为后备（针对未配置格式专属限制的格式）
        if (size > ATTACHMENT_SIZE_LIMITS.DOCUMENT_MAX) {
            throw new Error(translate('chat.documentTooLargeError', {
                size: (size / 1024 / 1024).toFixed(1),
                format: ext.toUpperCase(),
                max: ATTACHMENT_SIZE_LIMITS.DOCUMENT_MAX / 1024 / 1024,
            }));
        }

        // 3. 复制到附件目录
        const localPath = await this.copyToAttachmentStorage(filePath, agentId, options.targetDir);

        // 4. 构建附件信息
        const attachment: AttachmentInfo = {
            id: generateId(),
            fileName: getFileName(filePath),
            fileExtension: ext,
            type: validation.type ?? 'document',
            size,
            localPath,
            originalPath: filePath,
            createdAt: Date.now(),
        };

        // 5. 文档类型：使用 DocumentProcessingService 处理
        //    传入已知的 size，避免 processDocument 内部重复调用 file_get_size
        //    同时更新状态栏进度显示
        const { useStatusStore } = await import('@stores/statusStore');
        const setDocumentProgress = useStatusStore.getState().setDocumentProgress;
        const fileName = attachment.fileName;

        try {
            // 显示分析进度
            setDocumentProgress({
                isProcessing: true,
                message: DOCUMENT_PROGRESS_MESSAGES.ANALYZING,
                fileName,
            });

            // 显示提取进度
            setDocumentProgress({
                isProcessing: true,
                message: DOCUMENT_PROGRESS_MESSAGES.EXTRACTING,
                fileName,
            });

            const result = await this.processDocumentWithService(localPath, fileName, ext, agentId, size);
            attachment.parsedContent = result.content;
            attachment.estimatedTokens = result.estimatedTokens;

            // 显示完成状态
            setDocumentProgress({
                isProcessing: true,
                message: DOCUMENT_PROGRESS_MESSAGES.COMPLETED,
                fileName,
            });

            // 1秒后清除进度显示
            setTimeout(() => setDocumentProgress(null), 1000);

            // 记录处理结果
            logger.trace(`[AttachmentService] 文档解析成功: ${fileName}`,
                `(${result.estimatedTokens} tokens, 截断: ${result.wasTruncated}, RAG优先: ${result.ragOnly})`);

            // 如果有警告，记录日志
            if (result.warnings.length > 0) {
                logger.warn(`[AttachmentService] 处理警告: ${result.warnings.join(', ')}`);
            }

            // 如果标记为 RAG 优先，记录日志提示
            if (result.ragOnly) {
                logger.trace(`[AttachmentService]  文档较大，建议通过知识库检索`);
            }
        } catch (error) {
            // 清除进度显示
            setDocumentProgress(null);

            // 区分致命错误（文件过大/不支持）和可恢复错误（解析失败）
            if (error instanceof DocumentProcessingError) {
                // 文件过大、格式不支持等致命错误 → 向上抛出，阻止附件添加
                if (error.code === 'FILE_TOO_LARGE' || error.code === 'UNSUPPORTED_FORMAT' || error.code === 'EMPTY_DOCUMENT') {
                    throw error;
                }
            }
            // 解析失败等可恢复错误 → 只记录警告，允许附件添加（但无 parsedContent）
            logger.warn(`[AttachmentService] 文档解析失败: ${fileName}`, error);
        }

        logger.trace(`[AttachmentService] 附件已添加: ${attachment.fileName} (${validation.type ?? 'unknown'})`);
        return attachment;
    }

    /**
     * 使用 DocumentProcessingService 处理文档
     * 
     * 完整处理管线：解析 → 格式处理 → Token 估算 → 截断
     * 
     * @param filePath - 文件路径（已复制到附件目录）
     * @param fileName - 文件名
     * @param extension - 文件扩展名
     * @param agentId - Agent ID
     * @param knownSize - 可选，已知文件大小（避免重复获取）
     * @returns 处理结果
     */
    private async processDocumentWithService(
        filePath: string,
        fileName: string,
        extension: string,
        agentId: string,
        knownSize?: number
    ): Promise<DocumentProcessingResult> {
        return await documentProcessingService.processDocument(
            filePath,
            fileName,
            extension,
            agentId,
            undefined,  // options
            knownSize
        );
    }

    private async copyToAttachmentStorage(
        filePath: string,
        agentId: string,
        targetDir?: string
    ): Promise<string> {
        return await invoke<string>('file_copy_to_attachments', {
            sourcePath: filePath,
            agentId,
            ...(targetDir ? { targetDir } : {}),
        });
    }

    /**
     * 解析文档内容（兼容性方法）
     * 
     * @deprecated 请使用 processDocumentWithService 获取完整处理结果
     * @param filePath - 文件路径（已复制到附件目录）
     * @param extension - 文件扩展名
     * @returns 解析后的文本内容
     */
    async parseDocument(filePath: string, extension: string): Promise<string> {
        const normalizedExtension = extension.toLowerCase();

        switch (normalizedExtension) {
            case 'docx':
                return await invoke<string>('parse_docx', { filePath });
            case 'xlsx':
                return await invoke<string>('parse_xlsx', { filePath });
            case 'pdf':
                return await invoke<string>('parse_pdf', { filePath });
            case 'pptx':
                return await invoke<string>('parse_pptx', { filePath });
            case 'markdown':
                return await invoke<string>('file_read_content', { filePath });
            default: {
                if ((PLAIN_TEXT_FORMATS as readonly string[]).includes(normalizedExtension)) {
                    return await invoke<string>('file_read_content', { filePath });
                }

                throw new Error(translate('chat.unsupportedDocumentFormat', { extension }));
            }
        }
    }

    /**
     * 索引到知识库
     * 
     * 将文档内容添加到 RAG 索引
     * 
     * @param attachment - 附件信息（必须包含 parsedContent）
     * @param agentId - Agent ID
     */
    async indexToKnowledge(attachment: AttachmentInfo, agentId: string): Promise<void> {
        if (!attachment.parsedContent) {
            logger.warn(`[AttachmentService] 跳过索引（无解析内容）: ${attachment.fileName}`);
            return;
        }

        // 检查 autoIndexDeliverables 开关（默认开启）
        const { useAgentStore } = await import('@stores/agentStore');
        const agentCheck = useAgentStore.getState().agents.find(a => a.id === agentId);
        if (agentCheck?.autoIndexDeliverables === false) {
            logger.trace(`[AttachmentService] autoIndexDeliverables 已关闭，跳过索引: ${attachment.fileName}`);
            return;
        }

        // 使用 RagService 索引（通过动态导入避免循环依赖）
        const { getRagService } = await import('@/services/rag');
        const ragService = getRagService();

        // 使用 localPath 作为 documentId，与知识库 UI 和 file_write 统一
        // 确保用户在知识库中删除文件时能正确清除对应向量
        const documentId = attachment.localPath;

        try {
            const chunkCount = await ragService.indexDocument(
                agentId,
                documentId,
                attachment.parsedContent,
                {
                    fileName: attachment.fileName,
                    filePath: attachment.localPath,
                    documentType: 'text',
                }
            );

            attachment.indexed = true;
            logger.trace(`[AttachmentService] 已索引到知识库: ${attachment.fileName} (${chunkCount} chunks)`);

            // 同步到 Agent 的 knowledgePaths，使其在知识库 UI 中可见
            await this.addToAgentKnowledgePaths(attachment.localPath, agentId);
        } catch (error) {
            logger.error(`[AttachmentService] 索引失败: ${attachment.fileName}`, error);
            throw error;
        }
    }

    /**
     * 将附件路径添加到 Agent 的 knowledgePaths
     * 
     * @param filePath - 附件文件路径
     * @param agentId - Agent ID
     */
    private async addToAgentKnowledgePaths(filePath: string, agentId: string): Promise<void> {
        try {
            // 动态导入避免循环依赖
            const { useAgentStore } = await import('@stores/agentStore');
            const agent = useAgentStore.getState().agents.find(a => a.id === agentId);

            // 解析现有知识库路径
            let paths: string[] = [];
            if (agent?.knowledgePaths) {
                try {
                    paths = JSON.parse(agent.knowledgePaths) as unknown as string[];
                } catch {
                    // 解析失败时使用空数组
                    paths = [];
                }
            }

            // 避免重复添加
            if (paths.includes(filePath)) {
                logger.trace(`[AttachmentService] 文件已在知识库中: ${filePath}`);
                return;
            }

            paths.push(filePath);
            const newKnowledgePaths = JSON.stringify(paths);

            // 更新前端 Store
            useAgentStore.getState().updateAgent(agentId, { knowledgePaths: newKnowledgePaths });

            // 持久化到后端
            await invoke('agent_update', {
                id: agentId,
                request: { knowledge_paths: newKnowledgePaths },
            });

            logger.trace(`[AttachmentService]  已添加到 Agent 知识库路径: ${filePath}`);
        } catch (error) {
            logger.warn(`[AttachmentService] 更新 knowledgePaths 失败:`, error);
            // 不阻塞主流程，索引已成功
        }
    }

    /**
     * 获取附件内容的 base64 编码（用于图片预览）
     * 
     * @param filePath - 文件路径
     * @returns base64 编码字符串
     */
    async getBase64(filePath: string): Promise<string> {
        return await invoke<string>('file_read_as_base64', { path: filePath });
    }

    /**
     * 构建附件上下文字符串（用于注入 LLM）
     * 
     * @param attachments - 附件列表
     * @returns 格式化的上下文字符串
     */
    buildAttachmentContext(attachments: AttachmentInfo[]): string {
        const manifest = this.buildAttachmentManifest(attachments);
        const documentAttachments = attachments.filter(
            a => a.type === 'document' && a.parsedContent
        );

        if (documentAttachments.length === 0 && !manifest) {
            return '';
        }

        const parts = documentAttachments.map(a =>
            translate('chat.attachmentContextBlock', {
                fileName: a.fileName,
                path: a.localPath,
                content: a.parsedContent ?? '',
            })
        );

        const sections = [
            manifest,
            ...parts,
        ].filter((part): part is string => Boolean(part.trim()));

        return '\n\n---\n\n' + sections.join('\n\n---\n\n') + '\n\n---\n\n';
    }

    buildAttachmentManifest(attachments: AttachmentInfo[]): string {
        if (attachments.length === 0) return '';

        const items = attachments
            .filter(attachment => attachment.localPath)
            .map(attachment => translate('chat.attachmentManifestItem', {
                fileName: attachment.fileName,
                type: attachment.type,
                extension: attachment.fileExtension,
                size: Math.max(1, Math.round((attachment.size || 0) / 1024)),
                path: attachment.localPath,
            }))
            .join('\n');

        if (!items.trim()) return '';

        return translate('chat.attachmentManifestHeader', { items });
    }
}

// ==================== 导出单例 ====================

export const attachmentService = new AttachmentService();

// ==================== 附件限制验证 ====================

/**
 * 附件数量和容量限制验证结果
 */
export interface AttachmentLimitResult {
    /** 是否通过验证 */
    valid: boolean;
    /** 错误类型 */
    errorType?: 'count_exceeded' | 'size_exceeded';
    /** 错误信息 */
    errorMessage?: string;
    /** 当前文件数量 */
    currentCount: number;
    /** 当前总容量 (字节) */
    currentSize: number;
    /** 剩余可添加数量 */
    remainingCount: number;
    /** 剩余可添加容量 (字节) */
    remainingSize: number;
}

/**
 * 验证是否可以添加新附件（检查数量和容量限制）
 * 
 * @param existingAttachments - 当前已添加的附件列表
 * @param newFileSize - 新文件大小（字节）
 * @returns 验证结果
 */
export function validateAttachmentLimits(
    existingAttachments: AttachmentInfo[],
    newFileSize: number
): AttachmentLimitResult {
    const currentCount = existingAttachments.length;
    const currentSize = existingAttachments.reduce((sum, a) => sum + a.size, 0);
    const maxCount = ATTACHMENT_SIZE_LIMITS.MAX_FILE_COUNT;
    const maxSize = ATTACHMENT_SIZE_LIMITS.MAX_TOTAL_SIZE;

    // 检查数量限制
    if (currentCount >= maxCount) {
        return {
            valid: false,
            errorType: 'count_exceeded',
            errorMessage: `You can add up to ${maxCount} attachments`,
            currentCount,
            currentSize,
            remainingCount: 0,
            remainingSize: maxSize - currentSize,
        };
    }

    // 检查容量限制
    if (currentSize + newFileSize > maxSize) {
        const remainingMB = ((maxSize - currentSize) / 1024 / 1024).toFixed(1);
        const newFileMB = (newFileSize / 1024 / 1024).toFixed(1);
        return {
            valid: false,
            errorType: 'size_exceeded',
            errorMessage: `Attachment size limit exceeded. Remaining space: ${remainingMB}MB; current file: ${newFileMB}MB`,
            currentCount,
            currentSize,
            remainingCount: maxCount - currentCount,
            remainingSize: maxSize - currentSize,
        };
    }

    return {
        valid: true,
        currentCount,
        currentSize,
        remainingCount: maxCount - currentCount - 1,  // 减去即将添加的
        remainingSize: maxSize - currentSize - newFileSize,
    };
}
