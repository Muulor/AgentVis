/**
 * TextProcessor - 纯文本处理器 (TXT/MD)
 *
 * 功能:
 * - 编码检测 (UTF-8, GBK, GB2312)
 * - 智能截断 (支持 MD 标题优先)
 * - MD 目录提取
 * - 代码块识别
 */

import { BaseProcessor } from './BaseProcessor';
import {
  type DocumentExtension,
  MD_CODE_BLOCK_REGEX,
  PLAIN_TEXT_FORMATS,
  TRUNCATION_CONFIG,
} from '../constants';

import type { DocumentMetadata, ProcessorContext, TocEntry, TextProcessorConfig } from '../types';
import { getLogger } from '@services/logger';

const logger = getLogger('TextProcessor');

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: TextProcessorConfig = {
  maxTokens: 64000,
  truncationStrategy: 'head_tail',
  encodingDetection: true,
  preserveToc: true,
  extractCodeBlocks: true,
};

// ==================== TextProcessor 类 ====================

/**
 * 纯文本处理器
 *
 * 支持 .txt 和 .md 文件
 */
export class TextProcessor extends BaseProcessor {
  // 纯文本处理器支持所有文本类格式：原始文本、Markdown、代码文件及配置文件
  // 与 PLAIN_TEXT_FORMATS 保持同步，确保 processorRegistry 能正确路由
  readonly supportedExtensions: readonly DocumentExtension[] = PLAIN_TEXT_FORMATS;

  private textConfig: TextProcessorConfig;

  constructor(config?: Partial<TextProcessorConfig>) {
    super(config);
    this.textConfig = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 处理纯文本/Markdown 文件
   */
  protected processInternal(
    context: ProcessorContext,
    rawContent: string,
    warnings: string[]
  ): { content: string; metadata: DocumentMetadata } {
    const isMd = context.extension === 'md';

    // 1. 规范化空白
    const content = this.normalizeWhitespace(rawContent);

    // 2. 检测编码错误 (乱码检测)
    if (this.textConfig.encodingDetection) {
      const encodingIssue = this.detectEncodingIssues(content);
      if (encodingIssue) {
        warnings.push(`Possible encoding issue: ${encodingIssue}`);
      }
    }

    // 3. 构建元数据
    const metadata: DocumentMetadata = {
      fileType: context.extension,
      originalSize: context.fileSize,
      lineCount: this.countLines(content),
    };

    // 4. MD 专属处理
    if (isMd) {
      // 提取目录
      if (this.textConfig.preserveToc) {
        metadata.toc = this.extractToc(content);

        if (metadata.toc.length > 0) {
          logger.trace(`[TextProcessor] 提取 MD 目录: ${metadata.toc.length} 个标题`);
        }
      }

      // 提取文档标题 (第一个 H1)
      const firstH1 = metadata.toc?.find((entry) => entry.level === 1);
      if (firstH1) {
        metadata.title = firstH1.title;
      }

      // 提取代码块信息
      if (this.textConfig.extractCodeBlocks) {
        const codeBlockCount = this.countCodeBlocks(content);
        if (codeBlockCount > 0) {
          logger.trace(`[TextProcessor] 检测到 ${codeBlockCount} 个代码块`);
        }
      }
    }

    // 5. 检测空内容
    if (!content.trim()) {
      warnings.push('Document content is empty');
    }

    return { content, metadata };
  }

  /**
   * 覆盖基类的智能截断策略
   *
   * 对于 MD 文件，优先保留高层级标题所在的段落
   */
  protected override truncateContent(
    content: string,
    maxTokens: number,
    strategy: string
  ): { content: string; tokens: number; preservedParts?: string[] } {
    // 如果不是 smart 策略，使用基类默认实现
    if (strategy !== 'smart') {
      return super.truncateContent(content, maxTokens, strategy as 'head' | 'tail' | 'head_tail');
    }

    // MD 智能截断: 按标题层级优先保留
    return this.smartTruncateMd(content, maxTokens);
  }

  // ==================== MD 专属方法 ====================

  /**
   * 提取 Markdown 目录
   */
  private extractToc(content: string): TocEntry[] {
    const toc: TocEntry[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      // 简化的标题匹配
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);

      if (headingMatch?.[1] && headingMatch[2]) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        toc.push({
          level,
          title,
          pageOrLine: i + 1,
        });
      }
    }

    return toc;
  }

  /**
   * 统计代码块数量
   */
  private countCodeBlocks(content: string): number {
    const matches = content.match(MD_CODE_BLOCK_REGEX);
    return matches ? matches.length : 0;
  }

  /**
   * MD 智能截断
   *
   * 策略:
   * 1. 首先保留所有 H1/H2 标题及其后的首段
   * 2. 然后按优先级保留 H3 内容
   * 3. 最后保留剩余空间的普通段落
   */
  private smartTruncateMd(
    content: string,
    maxTokens: number
  ): { content: string; tokens: number; preservedParts?: string[] } {
    // 解析 MD 结构为段落块
    const sections = this.parseMdSections(content);

    // 按优先级排序: H1 > H2 > H3 > 普通段落
    const prioritizedSections = sections
      .map((section, index) => ({
        ...section,
        originalIndex: index,
        priority: this.getSectionPriority(section),
      }))
      .sort((a, b) => b.priority - a.priority);

    // 贪婪选择直到达到 Token 限制
    const selectedIndices = new Set<number>();
    let currentTokens = 0;

    for (const section of prioritizedSections) {
      const sectionTokens = this.estimateTokens(section.content);
      if (currentTokens + sectionTokens <= maxTokens) {
        selectedIndices.add(section.originalIndex);
        currentTokens += sectionTokens;
      }
    }

    // 按原始顺序重建内容
    const resultSections = sections
      .filter((_, index) => selectedIndices.has(index))
      .map((s) => s.content);

    // 添加截断标记
    const truncatedContent =
      resultSections.join('\n\n') + '\n\n[... Intelligently truncated by heading hierarchy ...]';

    return {
      content: truncatedContent,
      tokens: this.estimateTokens(truncatedContent),
      preservedParts: ['H1/H2 heading sections', 'partial H3 sections'],
    };
  }

  /**
   * 解析 MD 为段落块
   */
  private parseMdSections(content: string): Array<{ content: string; headingLevel?: number }> {
    const sections: Array<{ content: string; headingLevel?: number }> = [];
    const lines = content.split('\n');

    let currentSection: string[] = [];
    let currentHeadingLevel: number | undefined;

    for (const line of lines) {
      const headingMatch = /^(#{1,6})\s+/.exec(line);

      if (headingMatch?.[1]) {
        // 保存之前的段落
        if (currentSection.length > 0) {
          sections.push({
            content: currentSection.join('\n'),
            headingLevel: currentHeadingLevel,
          });
        }
        // 开始新段落
        currentSection = [line];
        currentHeadingLevel = headingMatch[1].length;
      } else {
        currentSection.push(line);
      }
    }

    // 保存最后一个段落
    if (currentSection.length > 0) {
      sections.push({
        content: currentSection.join('\n'),
        headingLevel: currentHeadingLevel,
      });
    }

    return sections;
  }

  /**
   * 获取段落优先级
   */
  private getSectionPriority(section: { content: string; headingLevel?: number }): number {
    if (!section.headingLevel) {
      return 0; // 普通段落优先级最低
    }

    // H1 = 3, H2 = 2, H3 = 1, H4+ = 0.5
    const config = TRUNCATION_CONFIG.MD_HEADING_PRIORITY;
    switch (section.headingLevel) {
      case 1:
        return config.H1;
      case 2:
        return config.H2;
      case 3:
        return config.H3;
      default:
        return 0.5;
    }
  }

  // ==================== 编码检测 ====================

  /**
   * 检测可能的编码问题
   *
   * 通过检测常见乱码模式来识别编码错误
   */
  private detectEncodingIssues(content: string): string | null {
    // 常见乱码模式
    const garbagePatterns = [
      /[\ufffd]{3,}/, // 连续的替换字符 (�)
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008]/, // 控制字符
      /锟斤拷/, // GBK 误解析 UTF-8 的经典乱码
      /鑱芥枻鍙/, // 另一种常见乱码
      /浣犲ソ/, // 中文被误解析
    ];

    for (const pattern of garbagePatterns) {
      if (pattern.test(content)) {
        return 'Possible mojibake detected; file encoding may not be UTF-8';
      }
    }

    return null;
  }
}

// ==================== 导出单例 ====================

export const textProcessor = new TextProcessor();
