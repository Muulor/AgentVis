/**
 * 文档处理类型定义
 *
 * 定义文档处理相关的接口、类型和结果结构
 */

import type { DocumentExtension, TruncationStrategy, SupportedEncoding } from './constants';

// ==================== 文档元数据 ====================

/** 目录条目 */
export interface TocEntry {
  /** 标题层级 (1-6) */
  level: number;
  /** 标题文本 */
  title: string;
  /** 页码或行号 */
  pageOrLine?: number;
}

/** 文档元数据 */
export interface DocumentMetadata {
  /** 文件类型 */
  fileType: DocumentExtension;
  /** 原始大小 (字节) */
  originalSize: number;
  /** 处理后大小 (字节) */
  processedSize?: number;
  /** 页数 (PDF/DOCX) */
  pageCount?: number;
  /** 行数 (TXT/MD) */
  lineCount?: number;
  /** 工作表数 (XLSX) */
  sheetCount?: number;
  /** 文档标题 */
  title?: string;
  /** 作者 */
  author?: string;
  /** 创建时间 */
  createdAt?: number;
  /** 修改时间 */
  modifiedAt?: number;
  /** 目录结构 */
  toc?: TocEntry[];
  /** 检测到的编码 (TXT/MD) */
  encoding?: SupportedEncoding;
}

// ==================== 截断信息 ====================

/** 截断信息 */
export interface TruncationInfo {
  /** 原始 Token 数 */
  originalTokens: number;
  /** 截断后 Token 数 */
  truncatedTokens: number;
  /** 使用的截断策略 */
  strategy: TruncationStrategy;
  /** 保留的部分描述 */
  preservedParts?: string[];
}

// ==================== 处理结果 ====================

/** 文档处理结果 */
export interface DocumentProcessingResult {
  /** 处理后的文本内容 */
  content: string;
  /** Token 估算值 */
  estimatedTokens: number;
  /** 是否被截断 */
  wasTruncated: boolean;
  /** 截断信息 (如果被截断) */
  truncationInfo?: TruncationInfo;
  /** 文档元数据 */
  metadata: DocumentMetadata;
  /** 处理警告列表 */
  warnings: string[];
  /** 是否仅适合 RAG 索引 (不适合直接注入上下文) */
  ragOnly: boolean;
}

// ==================== 处理器配置 ====================

/** 基础处理器配置 */
export interface BaseProcessorConfig {
  /** 最大 Token 数 */
  maxTokens: number;
  /** 截断策略 */
  truncationStrategy: TruncationStrategy;
}

/** 纯文本处理器配置 */
export interface TextProcessorConfig extends BaseProcessorConfig {
  /** 是否启用编码检测 */
  encodingDetection: boolean;
  /** 是否保留 MD 目录结构 */
  preserveToc: boolean;
  /** 是否提取 MD 代码块元数据 */
  extractCodeBlocks: boolean;
}

/** DOCX 处理器配置 */
export interface DocxProcessorConfig extends BaseProcessorConfig {
  /** 是否移除格式标记 */
  stripFormatting: boolean;
  /** 是否保留表格结构 */
  preserveTables: boolean;
  /** 是否提取文档属性 */
  extractMetadata: boolean;
  /** 段落分隔符 */
  paragraphSeparator: '\n\n' | '\n---\n';
}

/** XLSX 处理器配置 */
export interface XlsxProcessorConfig extends BaseProcessorConfig {
  /** 最大行数限制 */
  maxRows: number;
  /** 最大列数限制 */
  maxColumns: number;
  /** 采样策略 */
  samplingStrategy: 'head' | 'uniform' | 'stratified';
  /** 空单元格处理 */
  emptyCellHandling: 'skip' | 'placeholder' | 'preserve';
  /** 是否提取 Schema */
  extractSchema: boolean;
}

/** PDF 处理器配置 */
export interface PdfProcessorConfig extends BaseProcessorConfig {
  /** 分页处理方式 */
  pageHandling: 'all' | 'first_n' | 'range';
  /** 最大页数 */
  maxPages: number;
  /** 是否检测 OCR 状态 */
  ocrDetection: boolean;
  /** 扫描版 PDF 处理策略 */
  scannedPdfStrategy: 'reject' | 'warn' | 'attempt_ocr';
}

// ==================== 处理器上下文 ====================

/** 处理器执行上下文 */
export interface ProcessorContext {
  /** 文件路径 */
  filePath: string;
  /** 文件名 */
  fileName: string;
  /** 文件扩展名 */
  extension: DocumentExtension;
  /** 文件大小 (字节) */
  fileSize: number;
  /** Agent ID */
  agentId: string;
}

// ==================== 处理器接口 ====================

/** 文档处理器接口 */
export interface IDocumentProcessor {
  /** 处理器支持的扩展名 */
  readonly supportedExtensions: readonly DocumentExtension[];

  /**
   * 处理文档
   * @param context - 处理器上下文
   * @param rawContent - 原始文本内容
   * @returns 处理结果
   */
  process(context: ProcessorContext, rawContent: string): Promise<DocumentProcessingResult>;

  /**
   * 验证是否支持该文件
   * @param extension - 文件扩展名
   */
  supports(extension: string): boolean;
}

// ==================== 处理错误 ====================

/** 文档处理错误类型 */
export type DocumentErrorCode =
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'ENCODING_DETECTION_FAILED'
  | 'EMPTY_DOCUMENT'
  | 'PARSE_FAILED'
  | 'UNKNOWN_ERROR';

/** 文档处理错误 */
export class DocumentProcessingError extends Error {
  readonly code: DocumentErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DocumentErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DocumentProcessingError';
    this.code = code;
    this.details = details;
  }
}
