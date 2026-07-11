/**
 * BaseProcessor - 文档处理器抽象基类
 *
 * 提供所有文档处理器的通用功能：
 * - Token 估算
 * - 内容截断
 * - 元数据构建
 */

import {
  TOKEN_ESTIMATION,
  getFormatTokenLimit,
  TRUNCATION_CONFIG,
  RAG_ONLY_THRESHOLDS,
  type DocumentExtension,
  type TruncationStrategy,
} from '../constants';

import type {
  DocumentProcessingResult,
  DocumentMetadata,
  TruncationInfo,
  ProcessorContext,
  IDocumentProcessor,
  BaseProcessorConfig,
} from '../types';

// ==================== 抽象基类 ====================

/**
 * 文档处理器抽象基类
 *
 * 子类需要实现:
 * - supportedExtensions: 支持的扩展名列表
 * - processInternal(): 格式特定的处理逻辑
 */
export abstract class BaseProcessor implements IDocumentProcessor {
  /** 处理器支持的扩展名 */
  abstract readonly supportedExtensions: readonly DocumentExtension[];

  /** 默认配置 */
  protected config: BaseProcessorConfig;

  constructor(config?: Partial<BaseProcessorConfig>) {
    this.config = {
      maxTokens: 32000,
      truncationStrategy: 'head_tail',
      ...config,
    };
  }

  /**
   * 检查是否支持该扩展名
   */
  supports(extension: string): boolean {
    return (this.supportedExtensions as readonly string[]).includes(extension.toLowerCase());
  }

  /**
   * 处理文档 - 模板方法
   *
   * 流程: 预处理 → 格式处理 → Token 检查 → 截断 → 后处理
   */
  async process(context: ProcessorContext, rawContent: string): Promise<DocumentProcessingResult> {
    const warnings: string[] = [];

    // 1. 获取格式专属 Token 限制
    const maxTokens = getFormatTokenLimit(context.extension);

    // 2. 调用子类实现的格式特定处理
    const { content, metadata } = await this.processInternal(context, rawContent, warnings);

    // 3. 估算 Token 数
    const estimatedTokens = this.estimateTokens(content);

    // 4. 检查是否需要截断
    let finalContent = content;
    let wasTruncated = false;
    let truncationInfo: TruncationInfo | undefined;

    // 应用安全缓冲
    const effectiveLimit = Math.floor(maxTokens * TOKEN_ESTIMATION.SAFETY_BUFFER);

    if (estimatedTokens > effectiveLimit) {
      const truncateResult = this.truncateContent(
        content,
        effectiveLimit,
        this.config.truncationStrategy
      );
      finalContent = truncateResult.content;
      wasTruncated = true;
      truncationInfo = {
        originalTokens: estimatedTokens,
        truncatedTokens: truncateResult.tokens,
        strategy: this.config.truncationStrategy,
        preservedParts: truncateResult.preservedParts,
      };

      warnings.push(
        `Content truncated: ${estimatedTokens} → ${truncateResult.tokens} tokens (strategy: ${this.config.truncationStrategy})`
      );
    }

    // 5. 判断是否仅适合 RAG
    const ragOnly = this.shouldBeRagOnly(context.fileSize, estimatedTokens);

    if (ragOnly) {
      warnings.push(
        'Document is large; using knowledge base retrieval is recommended instead of direct context injection'
      );
    }

    return {
      content: finalContent,
      estimatedTokens: truncationInfo?.truncatedTokens ?? estimatedTokens,
      wasTruncated,
      truncationInfo,
      metadata,
      warnings,
      ragOnly,
    };
  }

  // ==================== 子类必须实现的方法 ====================

  /**
   * 格式特定的内部处理逻辑
   *
   * @param context - 处理器上下文
   * @param rawContent - 原始内容
   * @param warnings - 警告收集器
   * @returns 处理后的内容和元数据
   */
  protected abstract processInternal(
    context: ProcessorContext,
    rawContent: string,
    warnings: string[]
  ):
    | { content: string; metadata: DocumentMetadata }
    | Promise<{ content: string; metadata: DocumentMetadata }>;

  // ==================== 通用工具方法 ====================

  /**
   * 估算文本的 Token 数量
   *
   * 中文约 1.5 字符/token，英文约 4 字符/token
   */
  protected estimateTokens(text: string): number {
    let chineseCount = 0;
    let otherCount = 0;

    for (const char of text) {
      if (/[\u4e00-\u9fff]/.test(char)) {
        chineseCount++;
      } else {
        otherCount++;
      }
    }

    const tokens = Math.ceil(
      chineseCount / TOKEN_ESTIMATION.CHINESE_CHARS_PER_TOKEN +
        otherCount / TOKEN_ESTIMATION.ENGLISH_CHARS_PER_TOKEN
    );

    return tokens;
  }

  /**
   * 截断内容到指定 Token 数
   */
  protected truncateContent(
    content: string,
    maxTokens: number,
    strategy: TruncationStrategy
  ): { content: string; tokens: number; preservedParts?: string[] } {
    switch (strategy) {
      case 'head':
        return this.truncateHead(content, maxTokens);
      case 'tail':
        return this.truncateTail(content, maxTokens);
      case 'head_tail':
        return this.truncateHeadTail(content, maxTokens);
      case 'smart':
        // 默认使用 head_tail，子类可覆盖实现智能截断
        return this.truncateHeadTail(content, maxTokens);
      default:
        return this.truncateHead(content, maxTokens);
    }
  }

  /**
   * 保留头部截断
   */
  private truncateHead(
    content: string,
    maxTokens: number
  ): { content: string; tokens: number; preservedParts?: string[] } {
    const lines = content.split('\n');
    const result: string[] = [];
    let currentTokens = 0;

    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) {
        break;
      }
      result.push(line);
      currentTokens += lineTokens;
    }

    const truncatedContent = result.join('\n') + '\n\n[... Content truncated ...]';

    return {
      content: truncatedContent,
      tokens: this.estimateTokens(truncatedContent),
      preservedParts: ['Head'],
    };
  }

  /**
   * 保留尾部截断
   */
  private truncateTail(
    content: string,
    maxTokens: number
  ): { content: string; tokens: number; preservedParts?: string[] } {
    const lines = content.split('\n');
    const result: string[] = [];
    let currentTokens = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      const lineTokens = this.estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) {
        break;
      }
      result.unshift(line);
      currentTokens += lineTokens;
    }

    const truncatedContent = '[... Content truncated ...]\n\n' + result.join('\n');

    return {
      content: truncatedContent,
      tokens: this.estimateTokens(truncatedContent),
      preservedParts: ['Tail'],
    };
  }

  /**
   * 保留首尾截断 (默认策略)
   *
   * 保留首部 30% + 尾部 30%，中间添加摘要标记
   */
  private truncateHeadTail(
    content: string,
    maxTokens: number
  ): { content: string; tokens: number; preservedParts?: string[] } {
    const headRatio = TRUNCATION_CONFIG.HEAD_RATIO;
    const tailRatio = TRUNCATION_CONFIG.TAIL_RATIO;

    const headTokens = Math.floor(maxTokens * headRatio);
    const tailTokens = Math.floor(maxTokens * tailRatio);

    const lines = content.split('\n');

    // 提取头部
    const headLines: string[] = [];
    let headCount = 0;
    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      if (headCount + lineTokens > headTokens) {
        break;
      }
      headLines.push(line);
      headCount += lineTokens;
    }

    // 提取尾部
    const tailLines: string[] = [];
    let tailCount = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      const lineTokens = this.estimateTokens(line);
      if (tailCount + lineTokens > tailTokens) {
        break;
      }
      tailLines.unshift(line);
      tailCount += lineTokens;
    }

    // 计算被截断的行数
    const headEndIndex = headLines.length;
    const tailStartIndex = lines.length - tailLines.length;
    const skippedLines = tailStartIndex - headEndIndex;

    const separator = `\n\n[... Omitted about ${skippedLines} lines ...]\n\n`;
    const truncatedContent = headLines.join('\n') + separator + tailLines.join('\n');

    return {
      content: truncatedContent,
      tokens: this.estimateTokens(truncatedContent),
      preservedParts: ['Head 30%', 'Tail 30%'],
    };
  }

  /**
   * 判断文档是否仅适合 RAG 索引
   *
   * 大文件或高 Token 数的文档不适合直接注入上下文
   */
  protected shouldBeRagOnly(fileSize: number, estimatedTokens: number): boolean {
    // 文件大小或 Token 数超过阈值时建议仅用于 RAG
    return (
      fileSize > RAG_ONLY_THRESHOLDS.FILE_SIZE || estimatedTokens > RAG_ONLY_THRESHOLDS.TOKEN_COUNT
    );
  }

  /**
   * 统计行数
   */
  protected countLines(content: string): number {
    return content.split('\n').length;
  }

  /**
   * 清理多余空白
   */
  protected normalizeWhitespace(content: string): string {
    return (
      content
        // 移除行尾空白
        .replace(/[ \t]+$/gm, '')
        // 将连续多个空行合并为两个
        .replace(/\n{3,}/g, '\n\n')
        // 移除文档首尾空白
        .trim()
    );
  }
}
