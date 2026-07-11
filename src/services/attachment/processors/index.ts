/**
 * 文档处理器注册表
 *
 * 管理所有格式处理器，提供统一的获取接口
 */

import { textProcessor } from './TextProcessor';
import { docxProcessor } from './DocxProcessor';
import { xlsxProcessor } from './XlsxProcessor';
import { pdfProcessor } from './PdfProcessor';
import { pptxProcessor } from './PptxProcessor';
import type { DocumentExtension } from '../constants';
import type { IDocumentProcessor } from '../types';
import { getLogger } from '@services/logger';

const logger = getLogger('index');

// ==================== 处理器注册表 ====================

/** 处理器注册表 */
const processorRegistry: Map<DocumentExtension, IDocumentProcessor> = new Map();

/**
 * 注册处理器
 */
function registerProcessor(processor: IDocumentProcessor): void {
  for (const ext of processor.supportedExtensions) {
    processorRegistry.set(ext, processor);
    logger.trace(`[ProcessorRegistry] 已注册处理器: ${ext}`);
  }
}

/**
 * 获取指定扩展名的处理器
 *
 * @param extension - 文件扩展名
 * @returns 对应的处理器，不存在则返回 undefined
 */
export function getProcessor(extension: string): IDocumentProcessor | undefined {
  return processorRegistry.get(extension.toLowerCase() as DocumentExtension);
}

/**
 * 检查是否有可用的处理器
 */
export function hasProcessor(extension: string): boolean {
  return processorRegistry.has(extension.toLowerCase() as DocumentExtension);
}

/**
 * 获取所有已注册的扩展名
 */
export function getRegisteredExtensions(): DocumentExtension[] {
  return Array.from(processorRegistry.keys());
}

// ==================== 初始化注册 ====================

// 注册纯文本处理器 (TXT/MD)
registerProcessor(textProcessor);

// 注册 DOCX 处理器 (Word 文档)
registerProcessor(docxProcessor);

// 注册 XLSX 处理器 (Excel 表格)
registerProcessor(xlsxProcessor);

// 注册 PDF 处理器
registerProcessor(pdfProcessor);

// 注册 PPTX 处理器 (PowerPoint 演示文稿)
registerProcessor(pptxProcessor);

// ==================== 导出 ====================

export { BaseProcessor } from './BaseProcessor';
export { TextProcessor, textProcessor } from './TextProcessor';
export { DocxProcessor, docxProcessor } from './DocxProcessor';
export { XlsxProcessor, xlsxProcessor } from './XlsxProcessor';
export { PdfProcessor, pdfProcessor } from './PdfProcessor';
export { PptxProcessor, pptxProcessor } from './PptxProcessor';

// 类型重导出
export type { IDocumentProcessor } from '../types';
