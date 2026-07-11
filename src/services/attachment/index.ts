/**
 * 附件服务模块导出
 */

// ==================== 核心服务 ====================

export {
  AttachmentService,
  attachmentService,
  getSupportedFormatsDisplay,
  validateAttachmentLimits,
  type AttachmentLimitResult,
} from './AttachmentService';
export {
  ImageCompressionService,
  imageCompressionService,
  ImageCompressionError,
  CompressionErrorCode,
  type CompressedImageResult,
} from './ImageCompressionService';
export { DocumentProcessingService, documentProcessingService } from './DocumentProcessingService';

// ==================== 常量与配置 ====================

export {
  DOCUMENT_SIZE_THRESHOLDS,
  FORMAT_MAX_SIZE,
  FORMAT_TOKEN_LIMITS,
  TOKEN_ESTIMATION,
  TRUNCATION_CONFIG,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  PLAIN_TEXT_FORMATS,
  OFFICE_FORMATS,
  PDF_FORMATS,
  MD_HEADING_REGEX,
  MD_CODE_BLOCK_REGEX,
  DOCUMENT_ERROR_MESSAGES,
  DOCUMENT_PROGRESS_MESSAGES,
  DocumentProcessingLevel,
  getProcessingLevel,
  type DocumentExtension,
  type TruncationStrategy,
  type SupportedEncoding,
} from './constants';

// ==================== 类型定义 ====================

export {
  DocumentProcessingError,
  type DocumentMetadata,
  type DocumentProcessingResult,
  type TocEntry,
  type TruncationInfo,
  type ProcessorContext,
  type IDocumentProcessor,
  type TextProcessorConfig,
  type DocxProcessorConfig,
  type XlsxProcessorConfig,
  type PdfProcessorConfig,
  type DocumentErrorCode,
} from './types';

// ==================== 处理器 ====================

export {
  getProcessor,
  hasProcessor,
  getRegisteredExtensions,
  BaseProcessor,
  TextProcessor,
  textProcessor,
} from './processors';
