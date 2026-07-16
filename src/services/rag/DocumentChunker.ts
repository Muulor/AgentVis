/**
 * DocumentChunker - 文档分块器
 *
 * 将文档按照不同策略分割成适合向量化的小块。
 * 支持 Parent-Child 两级分块架构：
 * - Parent Chunk: 完整章节（用于上下文聚合）
 * - Child Chunk: 小粒度片段（用于向量检索）
 */

import type { Chunk, ChunkMetadata, ChunkingConfig } from '../../types';
import { DEFAULT_CHUNKING_CONFIG } from '../../types';

/** 分块结果 */
export interface ChunkingResult {
  /** 所有块（包括 Parent 和 Child） */
  chunks: Chunk[];
  /** Parent 块列表 */
  parentChunks: Chunk[];
  /** Child 块列表 */
  childChunks: Chunk[];
}

/** 章节信息 */
interface SectionInfo {
  level: number;
  title: string;
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * 生成唯一的块 ID
 *
 * 使用 crypto.randomUUID() 避免 Date.now() + Math.random() 的碰撞风险
 */
function generateChunkId(): string {
  return `chunk_${crypto.randomUUID()}`;
}

/**
 * 文档分块器类
 *
 * 实现 Parent-Child 两级分块策略：
 * 1. Parent: 按标题分割的完整章节，仅用于层级上下文恢复
 * 2. Child: 受 chunkSize 硬上限约束的小粒度片段，用于向量检索
 */
export class DocumentChunker {
  private config: ChunkingConfig;

  // Parent-Child 分块配置
  private readonly PARENT_MIN_SIZE = 200;
  private readonly CHILD_SIZE = 500;
  private readonly CHILD_OVERLAP = 50;

  constructor(config: Partial<ChunkingConfig> = {}) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  }

  /**
   * 分块文档（返回完整结果，包含 Parent-Child 关系）
   *
   * @param content - 文档内容
   * @param agentId - Agent ID
   * @param documentId - 文档 ID
   * @param metadata - 基础元数据
   * @returns 分块结果（包含 parentChunks 和 childChunks）
   */
  chunkWithHierarchy(
    content: string,
    agentId: string,
    documentId: string,
    metadata: Partial<ChunkMetadata> = {}
  ): ChunkingResult {
    const docType = metadata.documentType ?? this.detectDocumentType(content);

    if (docType === 'markdown') {
      return this.chunkMarkdownHierarchy(content, agentId, documentId, metadata);
    }

    // 非 Markdown 使用旧逻辑，无 Parent-Child 层级
    const chunks = this.chunk(content, agentId, documentId, metadata);
    return {
      chunks,
      parentChunks: [],
      childChunks: chunks,
    };
  }

  /**
   * 分块文档（兼容旧接口，只返回 Child 块用于向量化）
   */
  chunk(
    content: string,
    agentId: string,
    documentId: string,
    metadata: Partial<ChunkMetadata> = {}
  ): Chunk[] {
    const docType = metadata.documentType ?? this.detectDocumentType(content);

    switch (docType) {
      case 'markdown':
        return this.chunkMarkdown(content, agentId, documentId, metadata);
      case 'code':
        return this.chunkCode(content, agentId, documentId, metadata);
      default:
        return this.chunkPlainText(content, agentId, documentId, metadata);
    }
  }

  /**
   * Markdown Parent-Child 分块
   *
   * 1. 按 H2/H3 标题分割为 Parent 块
   * 2. 每个 Parent 块再细分为 Child 块
   */
  private chunkMarkdownHierarchy(
    content: string,
    agentId: string,
    documentId: string,
    baseMetadata: Partial<ChunkMetadata>
  ): ChunkingResult {
    const parentChunks: Chunk[] = [];
    const childChunks: Chunk[] = [];

    // 解析章节结构
    const sections = this.parseSections(content);

    for (const section of sections) {
      // 构建面包屑路径
      const sectionPath = this.buildSectionPath(sections, section);

      // 创建 Parent 块
      const parentId = generateChunkId();
      const parentChunk = this.createChunk(
        section.content.trim(),
        agentId,
        documentId,
        parentChunks.length,
        {
          ...baseMetadata,
          documentType: 'markdown',
          heading: section.title,
          headingLevel: section.level,
          startLine: section.startLine,
          endLine: section.endLine,
          sectionPath,
          isParent: true,
          childChunkIds: [],
        }
      );
      parentChunk.id = parentId;

      // 只有在内容足够长时才创建 Parent 块
      if (section.content.trim().length >= this.PARENT_MIN_SIZE) {
        parentChunks.push(parentChunk);
      }

      // 将 Parent 内容细分为 Child 块
      const children = this.splitIntoChildren(
        section.content,
        agentId,
        documentId,
        parentId,
        sectionPath,
        baseMetadata
      );

      // 记录 Child ID 到 Parent
      if (parentChunk.metadata.childChunkIds) {
        parentChunk.metadata.childChunkIds = children.map((c) => c.id);
      }

      childChunks.push(...children);
    }

    return {
      chunks: [...parentChunks, ...childChunks],
      parentChunks,
      childChunks,
    };
  }

  /**
   * 解析 Markdown 章节结构
   */
  private parseSections(content: string): SectionInfo[] {
    const normalizedContent = content.replace(/\r\n?/g, '\n');
    const lines = normalizedContent.split('\n');
    const sections: SectionInfo[] = [];

    let currentSection: SectionInfo | null = null;
    let contentBuffer: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // 保存之前的章节
        if (currentSection) {
          currentSection.content = contentBuffer.join('\n');
          currentSection.endLine = i;
          sections.push(currentSection);
        }

        // 开始新章节
        currentSection = {
          level: headingMatch[1]?.length ?? 1,
          title: headingMatch[2] ?? '',
          content: '',
          startLine: i + 1,
          endLine: i + 1,
        };
        contentBuffer = [line];
      } else {
        contentBuffer.push(line);
      }
    }

    // 保存最后一个章节
    if (currentSection) {
      currentSection.content = contentBuffer.join('\n');
      currentSection.endLine = lines.length;
      sections.push(currentSection);
    } else if (contentBuffer.length > 0) {
      // 没有标题的文档，整体作为一个章节
      sections.push({
        level: 0,
        title: '',
        content: contentBuffer.join('\n'),
        startLine: 1,
        endLine: lines.length,
      });
    }

    return sections;
  }

  /**
   * 构建面包屑路径
   */
  private buildSectionPath(sections: SectionInfo[], current: SectionInfo): string {
    const path: string[] = [];
    const currentIndex = sections.indexOf(current);

    // 向前查找父级标题
    for (let i = currentIndex; i >= 0; i--) {
      const section = sections[i];
      if (!section) continue;

      // 找到更高层级的标题
      if (section.level < current.level || i === currentIndex) {
        const prefix = '#'.repeat(section.level || 1);
        path.unshift(`${prefix} ${section.title}`);

        if (section.level <= 1) break;
      }
    }

    return path.join(' > ');
  }

  /**
   * 将内容细分为 Child 块
   */
  private splitIntoChildren(
    content: string,
    agentId: string,
    documentId: string,
    parentChunkId: string,
    sectionPath: string,
    baseMetadata: Partial<ChunkMetadata>
  ): Chunk[] {
    const normalizedContent = content.trim();
    if (normalizedContent.length < this.config.minChunkSize) {
      return [];
    }

    // Markdown Child 仍以较细粒度检索，但绝不能超过全局 chunkSize。
    const childLimit = Math.min(this.CHILD_SIZE, this.getHardChunkLimit());
    return this.splitWithHardLimit(normalizedContent, childLimit).map((childContent, index) =>
      this.createChunk(childContent, agentId, documentId, index, {
        ...baseMetadata,
        documentType: 'markdown',
        parentChunkId,
        sectionPath,
        isParent: false,
      })
    );
  }

  /**
   * 检测文档类型
   */
  private detectDocumentType(content: string): 'markdown' | 'text' | 'code' {
    // 检测 Markdown 特征
    if (content.includes('# ') || content.includes('## ') || content.includes('```')) {
      return 'markdown';
    }

    // 检测代码特征
    const codePatterns = [
      /^(import|from|export|const|let|var|function|class|def|pub fn|impl|struct)\s/m,
      /^\s*(if|for|while|switch|match)\s*\(/m,
    ];

    for (const pattern of codePatterns) {
      if (pattern.test(content)) {
        return 'code';
      }
    }

    return 'text';
  }

  /**
   * Markdown 分块策略（兼容旧接口）
   */
  private chunkMarkdown(
    content: string,
    agentId: string,
    documentId: string,
    baseMetadata: Partial<ChunkMetadata>
  ): Chunk[] {
    // 使用新的层级分块，只返回 Child 块
    const result = this.chunkMarkdownHierarchy(content, agentId, documentId, baseMetadata);
    return result.childChunks;
  }

  /**
   * 纯文本分块策略
   */
  private chunkPlainText(
    content: string,
    agentId: string,
    documentId: string,
    baseMetadata: Partial<ChunkMetadata>
  ): Chunk[] {
    const normalizedContent = content.trim();
    if (normalizedContent.length < this.config.minChunkSize) {
      return [];
    }

    return this.splitWithHardLimit(normalizedContent, this.getHardChunkLimit()).map(
      (chunkContent, index) =>
        this.createChunk(chunkContent, agentId, documentId, index, {
          ...baseMetadata,
          documentType: 'text',
        })
    );
  }

  /**
   * 代码分块策略
   */
  private chunkCode(
    content: string,
    agentId: string,
    documentId: string,
    baseMetadata: Partial<ChunkMetadata>
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const language = this.detectCodeLanguage(content);
    if (content.trim().length < this.config.minChunkSize) {
      return chunks;
    }

    const functionPatterns: Record<string, RegExp> = {
      typescript:
        /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?(const|let)\s+\w+\s*=|^(export\s+)?class\s+\w+|^(export\s+)?interface\s+\w+/gm,
      python: /^(async\s+)?def\s+\w+|^class\s+\w+/gm,
      rust: /^pub\s+(async\s+)?fn\s+\w+|^fn\s+\w+|^(pub\s+)?struct\s+\w+|^impl\s+/gm,
    };

    const pattern = functionPatterns[language] ?? functionPatterns['typescript'];
    if (!pattern) {
      return this.chunkPlainText(content, agentId, documentId, {
        ...baseMetadata,
        documentType: 'code',
        codeLanguage: language,
      });
    }

    const matches = [...content.matchAll(pattern)];

    if (matches.length > 0) {
      let chunkIndex = 0;

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const nextMatch = matches[i + 1];
        // 第一段从文件开头开始，保留 imports、文件注释等函数前导内容。
        const startIndex = i === 0 ? 0 : (match?.index ?? 0);
        const endIndex = nextMatch?.index ?? content.length;

        const chunkContent = content.slice(startIndex, endIndex).trim();

        if (chunkContent) {
          for (const limitedContent of this.splitWithHardLimit(
            chunkContent,
            this.getHardChunkLimit()
          )) {
            chunks.push(
              this.createChunk(limitedContent, agentId, documentId, chunkIndex++, {
                ...baseMetadata,
                documentType: 'code',
                codeLanguage: language,
              })
            );
          }
        }
      }
    } else {
      return this.chunkPlainText(content, agentId, documentId, {
        ...baseMetadata,
        documentType: 'code',
        codeLanguage: language,
      });
    }

    return chunks;
  }

  /**
   * 获取实际的硬上限。
   *
   * UTF-16 中一个补充平面字符需要两个 code unit，因此至少保留 2，避免在 emoji
   * 等字符的代理对中间切开。正常配置远大于这个下限。
   */
  private getHardChunkLimit(): number {
    return Math.max(2, Math.floor(this.config.chunkSize));
  }

  /**
   * 按硬上限切分内容。
   *
   * 优先在换行、标点或空白后切分；不存在自然边界时按长度强制切分。相邻分块保留
   * 少量重叠，且所有边界都会避开 Unicode 代理对，保证超长单行和 emoji 文本也能
   * 稳定前进且不丢失头尾内容。
   */
  private splitWithHardLimit(content: string, maxSize: number): string[] {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return [];
    }

    if (normalizedContent.length <= maxSize) {
      return [normalizedContent];
    }

    const chunks: string[] = [];
    const overlapSize = Math.min(this.CHILD_OVERLAP, Math.floor(maxSize / 5));
    let start = 0;

    while (start < normalizedContent.length) {
      const hardEnd = Math.min(start + maxSize, normalizedContent.length);
      let end = this.moveBoundaryBeforeSurrogatePair(normalizedContent, hardEnd);

      if (end < normalizedContent.length) {
        const minimumNaturalBoundary = start + Math.floor((end - start) * 0.6);
        const naturalBoundary = this.findNaturalBoundary(
          normalizedContent,
          minimumNaturalBoundary,
          end
        );
        if (naturalBoundary > start) {
          end = naturalBoundary;
        }
      }

      // maxSize >= 2；此分支仅防御意外配置或异常 Unicode 输入导致无法前进。
      if (end <= start) {
        end = Math.min(start + maxSize, normalizedContent.length);
      }

      const chunkContent = normalizedContent.slice(start, end).trim();
      if (chunkContent) {
        chunks.push(chunkContent);
      }

      if (end >= normalizedContent.length) {
        break;
      }

      let nextStart = Math.max(start + 1, end - overlapSize);
      nextStart = this.moveBoundaryBeforeSurrogatePair(normalizedContent, nextStart);
      start = nextStart > start ? nextStart : end;
    }

    return chunks;
  }

  /** 在靠近硬上限处寻找自然切分点。 */
  private findNaturalBoundary(content: string, minimum: number, maximum: number): number {
    for (let boundary = maximum; boundary > minimum; boundary--) {
      const previousCharacter = content[boundary - 1];
      if (previousCharacter && /[\n\s。！？.!?；;，,、]/u.test(previousCharacter)) {
        return this.moveBoundaryBeforeSurrogatePair(content, boundary);
      }
    }

    return maximum;
  }

  /** 避免切分点落在 UTF-16 高、低代理项之间。 */
  private moveBoundaryBeforeSurrogatePair(content: string, boundary: number): number {
    if (boundary <= 0 || boundary >= content.length) {
      return boundary;
    }

    const previous = content.charCodeAt(boundary - 1);
    const current = content.charCodeAt(boundary);
    const previousIsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
    const currentIsLowSurrogate = current >= 0xdc00 && current <= 0xdfff;

    return previousIsHighSurrogate && currentIsLowSurrogate ? boundary - 1 : boundary;
  }

  /**
   * 检测代码语言
   */
  private detectCodeLanguage(content: string): string {
    // 优先匹配 Rust 特征（最具辨识度）
    if (content.includes('pub fn ') || content.includes('impl ')) return 'rust';
    // Python 特征：def 后跟函数名和括号，或 from...import（区分 JS/TS 的 import）
    if (/^def\s+\w+\s*\(/m.test(content) || /^from\s+\w+\s+import\s/m.test(content))
      return 'python';
    // TypeScript / JavaScript 特征
    if (/\b(function|const|let|var|interface|type|class)\s+\w+/m.test(content)) return 'typescript';
    return 'text';
  }

  /**
   * 创建 Chunk 对象
   */
  private createChunk(
    content: string,
    agentId: string,
    documentId: string,
    chunkIndex: number,
    metadata: ChunkMetadata
  ): Chunk {
    return {
      id: generateChunkId(),
      agentId,
      documentId,
      chunkIndex,
      content,
      metadata,
      createdAt: Date.now(),
    };
  }
}

/**
 * 创建默认配置的文档分块器
 */
export function createDocumentChunker(config?: Partial<ChunkingConfig>): DocumentChunker {
  return new DocumentChunker(config);
}
