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
 * 1. Parent: 按 H2/H3 标题分割的完整章节 (800-1500 字符)
 * 2. Child: 小粒度片段 (200-400 字符)，用于向量检索
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
    const children: Chunk[] = [];

    // 如果内容较短，直接作为一个 Child
    if (content.length <= this.CHILD_SIZE * 1.5) {
      if (content.trim().length >= this.config.minChunkSize) {
        children.push(
          this.createChunk(content.trim(), agentId, documentId, 0, {
            ...baseMetadata,
            documentType: 'markdown',
            parentChunkId,
            sectionPath,
            isParent: false,
          })
        );
      }
      return children;
    }

    // 按句子分割，然后组合成 Child 块
    const sentences = this.splitIntoSentences(content);
    let currentChunk = '';
    let chunkIndex = 0;

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > this.CHILD_SIZE) {
        // 保存当前块
        if (currentChunk.trim().length >= this.config.minChunkSize) {
          children.push(
            this.createChunk(currentChunk.trim(), agentId, documentId, chunkIndex++, {
              ...baseMetadata,
              documentType: 'markdown',
              parentChunkId,
              sectionPath,
              isParent: false,
            })
          );
        }

        // 开始新块（带重叠）
        const overlap = this.getOverlapText(currentChunk);
        currentChunk = overlap + sentence;
      } else {
        currentChunk += sentence;
      }
    }

    // 保存最后一个块
    if (currentChunk.trim().length >= this.config.minChunkSize) {
      children.push(
        this.createChunk(currentChunk.trim(), agentId, documentId, chunkIndex, {
          ...baseMetadata,
          documentType: 'markdown',
          parentChunkId,
          sectionPath,
          isParent: false,
        })
      );
    }

    return children;
  }

  /**
   * 按句子分割文本
   */
  private splitIntoSentences(text: string): string[] {
    // 中英文句子分割
    const sentencePattern = /([^。！？.!?\n]+[。！？.!?\n]?)/g;
    const matches = text.match(sentencePattern);
    return matches ?? [text];
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
    const chunks: Chunk[] = [];
    // 先按空行分段；对无空行的文本（如 JSON），整个文件会成为一个段落
    const rawParagraphs = content.split(/\n\s*\n/);

    // 对超长段落按行强制切分，防止无空行的文件变成单个巨大 chunk
    const paragraphs: string[] = [];
    for (const para of rawParagraphs) {
      const trimmed = para.trim();
      if (trimmed.length <= this.config.chunkSize * 2) {
        paragraphs.push(trimmed);
      } else {
        // 按行累积切分
        const lines = trimmed.split('\n');
        let buffer = '';
        for (const line of lines) {
          if (buffer.length + line.length + 1 > this.config.chunkSize) {
            if (buffer.length >= this.config.minChunkSize) {
              paragraphs.push(buffer);
            }
            buffer = line;
          } else {
            buffer += (buffer ? '\n' : '') + line;
          }
        }
        if (buffer) {
          paragraphs.push(buffer);
        }
      }
    }

    let currentChunk = '';
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      if (!paragraph) continue;

      if (currentChunk.length + paragraph.length > this.config.chunkSize) {
        if (currentChunk.length >= this.config.minChunkSize) {
          chunks.push(
            this.createChunk(currentChunk.trim(), agentId, documentId, chunkIndex++, {
              ...baseMetadata,
              documentType: 'text',
            })
          );
        }

        const overlap = this.getOverlapText(currentChunk);
        currentChunk = overlap + paragraph + '\n\n';
      } else {
        currentChunk += paragraph + '\n\n';
      }
    }

    if (currentChunk.trim().length >= this.config.minChunkSize) {
      chunks.push(
        this.createChunk(currentChunk.trim(), agentId, documentId, chunkIndex++, {
          ...baseMetadata,
          documentType: 'text',
        })
      );
    }

    return chunks;
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
        const startIndex = match?.index ?? 0;
        const endIndex = nextMatch?.index ?? content.length;

        const chunkContent = content.slice(startIndex, endIndex).trim();

        if (chunkContent.length >= this.config.minChunkSize) {
          chunks.push(
            this.createChunk(chunkContent, agentId, documentId, chunkIndex++, {
              ...baseMetadata,
              documentType: 'code',
              codeLanguage: language,
            })
          );
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
   * 获取重叠文本
   */
  private getOverlapText(text: string): string {
    if (text.length <= this.CHILD_OVERLAP) {
      return text;
    }

    const overlapStart = text.length - this.CHILD_OVERLAP;
    const overlapText = text.slice(overlapStart);

    const spaceIndex = overlapText.indexOf(' ');
    if (spaceIndex > 0 && spaceIndex < this.CHILD_OVERLAP / 2) {
      return overlapText.slice(spaceIndex + 1);
    }

    return overlapText;
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
