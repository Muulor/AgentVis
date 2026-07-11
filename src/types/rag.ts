/**
 * RAG (Retrieval-Augmented Generation) 相关类型定义
 */

/** 文档块 */
export interface Chunk {
  /** 块 ID */
  id: string;
  /** 所属 Agent ID */
  agentId: string;
  /** 来源文档 ID */
  documentId: string;
  /** 块在文档中的索引 */
  chunkIndex: number;
  /** 块内容 */
  content: string;
  /** 元数据 */
  metadata: ChunkMetadata;
  /** 创建时间 */
  createdAt: number;
}

/** 块元数据 */
export interface ChunkMetadata {
  /** 来源文件名 */
  fileName?: string;
  /** 来源文件路径 */
  filePath?: string;
  /** 文档类型 */
  documentType?: 'markdown' | 'text' | 'code' | 'json';
  /** 在 Markdown 中的标题层级 */
  headingLevel?: number;
  /** 所属标题 */
  heading?: string;
  /** 代码语言（如果是代码块） */
  codeLanguage?: string;
  /** 块起始行号 */
  startLine?: number;
  /** 块结束行号 */
  endLine?: number;

  // ============ Parent-Child 分块扩展字段 ============
  /** 父块 ID (用于 Parent 聚合) */
  parentChunkId?: string;
  /** 子块 ID 列表 */
  childChunkIds?: string[];
  /** 面包屑路径 (如 "# PRD > ## 5. 功能需求 > ### 5.1") */
  sectionPath?: string;
  /** 是否为 Parent 块 */
  isParent?: boolean;
  /** Whether this chunk is a synthetic document-level overview / table-of-contents chunk. */
  isDocumentOverview?: boolean;
  /** Whether retrieval expanded this chunk with sibling chunks from the same parent. */
  isParentContextRestored?: boolean;

  // ============ 记忆向量索引扩展字段 ============
  /** 记忆类型 (fact | summary) */
  memoryType?: 'fact' | 'summary';
  /** 原始记忆 ID */
  memoryId?: string;
  /** 事实类别（仅事实类型有值） */
  category?: string;
  /** 索引时间 */
  indexedAt?: number;
}

/** 检索结果 */
export interface SearchResult {
  /** 块信息 */
  chunk: Chunk;
  /** 相似度分数 (0-1) */
  score: number;
  /** 匹配的向量距离 */
  distance?: number;
}

/** 分块配置 */
export interface ChunkingConfig {
  /** 块大小（字符数）*/
  chunkSize: number;
  /** 重叠窗口大小（字符数） */
  overlap: number;
  /** 是否按标题分割（Markdown） */
  splitByHeading: boolean;
  /** 最小块大小 */
  minChunkSize: number;
}

/** 默认分块配置 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 500,
  overlap: 50,
  splitByHeading: true,
  minChunkSize: 100,
};

/** 检索配置 */
export interface RetrievalConfig {
  /** 返回的最大结果数 */
  topK: number;
  /** 相似度阈值 (0-1) */
  threshold: number;
  /** 是否包含元数据过滤 */
  includeMetadataFilter: boolean;
}

/** 默认检索配置 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 5,
  threshold: 0.7,
  includeMetadataFilter: false,
};

/** 索引状态 */
export interface IndexStatus {
  /** Agent ID */
  agentId: string;
  /** 已索引文档数 */
  documentCount: number;
  /** 已索引块数 */
  chunkCount: number;
  /** 最后更新时间 */
  lastUpdatedAt?: number;
}
