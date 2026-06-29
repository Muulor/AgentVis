/**
 * 文档处理常量配置
 * 
 * 定义文档处理的限制、阈值和策略配置
 */

import { translate } from '@/i18n';
import {
    DOCUMENT_PROCESSING_EXTENSIONS,
    OFFICE_DOCUMENT_EXTENSIONS,
    PDF_DOCUMENT_EXTENSIONS,
    PLAIN_TEXT_PROCESSING_EXTENSIONS,
} from '@services/file-types';

// ==================== 附件文件大小限制 (字节) ====================

/** 附件统一限制 */
export const ATTACHMENT_SIZE_LIMITS = {
    /** 图片最大大小 (压缩前) */
    IMAGE_MAX: 5 * 1024 * 1024,        // 5 MB
    /** 文档最大大小 (通用后备) */
    DOCUMENT_MAX: 50 * 1024 * 1024,    // 50 MB
    /** 单次发送最大附件数量 */
    MAX_FILE_COUNT: 5,
    /** 单次发送最大总容量 */
    MAX_TOTAL_SIZE: 50 * 1024 * 1024,  // 50 MB
} as const;

/** RAG Only 建议阈值 */
export const RAG_ONLY_THRESHOLDS = {
    /** 文件大小阈值 */
    FILE_SIZE: 5 * 1024 * 1024,        // 5 MB
    /** Token 数阈值 */
    TOKEN_COUNT: 50000,
} as const;

/** PDF 页数估算参数 */
export const PDF_PAGE_ESTIMATION = {
    /** 每页平均字节数 (用于页数估算) */
    BYTES_PER_PAGE: 50 * 1024,         // 50 KB
    /** 每页平均字符数 (用于文本密度估算) */
    CHARS_PER_PAGE: 3000,
} as const;

// ==================== 文档分层大小限制 (字节) ====================

/** 文档分层阈值 */
export const DOCUMENT_SIZE_THRESHOLDS = {
    /** Level 1: 小型文档 - 直接全量加载 */
    SMALL: 500 * 1024,          // 500 KB
    /** Level 2: 中型文档 - 智能摘要 + 截断 */
    MEDIUM: 5 * 1024 * 1024,    // 5 MB
    /** Level 3: 大型文档 - 仅 RAG 索引 */
    LARGE: 20 * 1024 * 1024,    // 20 MB
} as const;

/** 格式专属最大大小限制 (字节) */
export const DEFAULT_TEXT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export const FORMAT_MAX_SIZE: Partial<Record<string, number>> = {
    // 办公文档类
    txt: DEFAULT_TEXT_MAX_SIZE,
    md: DEFAULT_TEXT_MAX_SIZE,
    docx: 20 * 1024 * 1024,     // 20 MB
    xlsx: 15 * 1024 * 1024,     // 15 MB
    xls:  15 * 1024 * 1024,     // 15 MB
    pdf: 30 * 1024 * 1024,      // 30 MB
    pptx: 25 * 1024 * 1024,     // 25 MB
    // 代码文件（Web 与前端）：单文件通常小，10 MB 绰绰有余
    html: DEFAULT_TEXT_MAX_SIZE,
    css:  5 * 1024 * 1024,      // 5 MB
    scss: 5 * 1024 * 1024,      // 5 MB
    js:   DEFAULT_TEXT_MAX_SIZE,
    jsx:  DEFAULT_TEXT_MAX_SIZE,
    ts:   DEFAULT_TEXT_MAX_SIZE,
    tsx:  DEFAULT_TEXT_MAX_SIZE,
    // 代码文件（通用编程语言）
    py:   DEFAULT_TEXT_MAX_SIZE,
    go:   DEFAULT_TEXT_MAX_SIZE,
    rs:   DEFAULT_TEXT_MAX_SIZE,
    // 配置与数据格式
    json: 5 * 1024 * 1024,      // 5 MB（JSON 冗余高，5 MB 已含大量有效数据）
    yaml: 5 * 1024 * 1024,      // 5 MB
    yml:  5 * 1024 * 1024,      // 5 MB
    toml: 5 * 1024 * 1024,      // 5 MB
    sql:  DEFAULT_TEXT_MAX_SIZE,
} as const;

// ==================== Token 限制 ====================

/** 格式专属 Token 限制 */
export const DEFAULT_TEXT_TOKEN_LIMIT = 64000;

export const FORMAT_TOKEN_LIMITS: Partial<Record<string, number>> = {
    // 办公文档类
    txt:  DEFAULT_TEXT_TOKEN_LIMIT,
    md:   DEFAULT_TEXT_TOKEN_LIMIT,
    docx: 32000,
    xlsx: 16000,
    xls:  16000,
    pdf:  32000,
    pptx: 32000,
    // 代码文件（Web 与前端）：代码密度高，64k 足以覆盖绝大多数单文件
    html: DEFAULT_TEXT_TOKEN_LIMIT,
    css:  32000,
    scss: 32000,
    js:   DEFAULT_TEXT_TOKEN_LIMIT,
    jsx:  DEFAULT_TEXT_TOKEN_LIMIT,
    ts:   DEFAULT_TEXT_TOKEN_LIMIT,
    tsx:  DEFAULT_TEXT_TOKEN_LIMIT,
    // 代码文件（通用编程语言）
    py:   DEFAULT_TEXT_TOKEN_LIMIT,
    go:   DEFAULT_TEXT_TOKEN_LIMIT,
    rs:   DEFAULT_TEXT_TOKEN_LIMIT,
    // 配置与数据格式
    json: 32000,
    yaml: 32000,
    yml:  32000,
    toml: 32000,
    sql:  DEFAULT_TEXT_TOKEN_LIMIT,
} as const;

export function getFormatMaxSize(extension: string): number {
    return FORMAT_MAX_SIZE[extension] ?? DEFAULT_TEXT_MAX_SIZE;
}

export function getFormatTokenLimit(extension: string): number {
    return FORMAT_TOKEN_LIMITS[extension] ?? DEFAULT_TEXT_TOKEN_LIMIT;
}

/** Token 估算参数 */
export const TOKEN_ESTIMATION = {
    /** 中文字符每 token 数 */
    CHINESE_CHARS_PER_TOKEN: 1.5,
    /** 英文字符每 token 数 */
    ENGLISH_CHARS_PER_TOKEN: 4,
    /** 安全缓冲比例 (预留 10%) */
    SAFETY_BUFFER: 0.9,
} as const;

// ==================== 截断策略 ====================

/** 截断策略类型 */
export type TruncationStrategy = 'head' | 'tail' | 'head_tail' | 'smart';

/** 截断配置 */
export const TRUNCATION_CONFIG = {
    /** head_tail 策略: 首部保留比例 */
    HEAD_RATIO: 0.3,
    /** head_tail 策略: 尾部保留比例 */
    TAIL_RATIO: 0.3,
    /** smart 策略: MD 标题层级优先级 (H1=3, H2=2, H3=1) */
    MD_HEADING_PRIORITY: {
        H1: 3,
        H2: 2,
        H3: 1,
    },
} as const;

// ==================== 文档类型映射 ====================

/** 支持的文档扩展名（办公文档类） */
export const SUPPORTED_DOCUMENT_EXTENSIONS = DOCUMENT_PROCESSING_EXTENSIONS;

/** 文档类型分类 */
export type DocumentExtension = typeof SUPPORTED_DOCUMENT_EXTENSIONS[number];

/** 纯文本格式列表（含所有代码与配置文件） */
export const PLAIN_TEXT_FORMATS = PLAIN_TEXT_PROCESSING_EXTENSIONS;

/** Office 格式列表 */
export const OFFICE_FORMATS = OFFICE_DOCUMENT_EXTENSIONS;

/** PDF 格式 */
export const PDF_FORMATS = PDF_DOCUMENT_EXTENSIONS;

// ==================== 处理级别 ====================

/** 文档处理级别 */
export enum DocumentProcessingLevel {
    /** 全量加载 */
    FULL_LOAD = 'full_load',
    /** 智能摘要 */
    SMART_SUMMARY = 'smart_summary',
    /** 仅 RAG 索引 */
    RAG_ONLY = 'rag_only',
    /** 拒绝处理 */
    REJECTED = 'rejected',
}

/** 根据文件大小获取处理级别 */
export function getProcessingLevel(sizeInBytes: number): DocumentProcessingLevel {
    if (sizeInBytes <= DOCUMENT_SIZE_THRESHOLDS.SMALL) {
        return DocumentProcessingLevel.FULL_LOAD;
    }
    if (sizeInBytes <= DOCUMENT_SIZE_THRESHOLDS.MEDIUM) {
        return DocumentProcessingLevel.SMART_SUMMARY;
    }
    if (sizeInBytes <= DOCUMENT_SIZE_THRESHOLDS.LARGE) {
        return DocumentProcessingLevel.RAG_ONLY;
    }
    return DocumentProcessingLevel.REJECTED;
}

// ==================== 编码检测 ====================

/** 支持的文本编码 */
export const SUPPORTED_ENCODINGS = ['utf-8', 'gbk', 'gb2312', 'gb18030'] as const;

export type SupportedEncoding = typeof SUPPORTED_ENCODINGS[number];

// ==================== MD 文档专属 ====================

/** MD 标题正则表达式 */
export const MD_HEADING_REGEX = /^(#{1,6})\s+(.+)$/gm;

/** MD 代码块正则表达式 */
export const MD_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

/** MD 链接正则表达式 */
export const MD_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/** MD 图片正则表达式 */
export const MD_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

// ==================== 错误消息 ====================

export const DOCUMENT_ERROR_MESSAGES = {
    FILE_TOO_LARGE: (size: number, maxSize: number, format: string) =>
        translate('chat.documentTooLargeError', {
            size: (size / 1024 / 1024).toFixed(1),
            format: format.toUpperCase(),
            max: (maxSize / 1024 / 1024).toFixed(0),
        }),

    UNSUPPORTED_FORMAT: (ext: string) =>
        translate('chat.unsupportedDocumentFormat', { extension: ext }),

    ENCODING_DETECTION_FAILED: () =>
        translate('chat.encodingDetectionFailed'),

    EMPTY_DOCUMENT: () =>
        translate('chat.emptyDocument'),

    PARSE_FAILED: (format: string, reason: string) =>
        translate('chat.documentParseFailed', { format: format.toUpperCase(), reason }),
} as const;

// ==================== 进度消息 ====================

export const DOCUMENT_PROGRESS_MESSAGES = {
    get ANALYZING() { return translate('chat.documentProgressAnalyzing'); },
    get ENCODING_DETECTION() { return translate('chat.documentProgressEncoding'); },
    get EXTRACTING() { return translate('chat.documentProgressExtracting'); },
    get TRUNCATING() { return translate('chat.documentProgressTruncating'); },
    get INDEXING() { return translate('chat.documentProgressIndexing'); },
    get COMPLETED() { return translate('chat.documentProgressCompleted'); },
} as const;
