import { getLogger } from '@services/logger';

const logger = getLogger('ChunkProcessor');

/**
 * ChunkProcessor - 通用分块处理器
 *
 * 用于大文件分块处理，支持：
 * - 自适应 Chunk 大小（根据文件类型动态调整）
 * - 带重试的并发批量处理
 * - 智能跳过空/稀疏块
 *
 * 设计原则：
 * - 只处理分块逻辑，具体处理逻辑由调用方提供
 * - 使用泛型回调抽象具体处理逻辑
 */

// ==================== 类型定义 ====================

/** 文件类型分类 */
export type FileCategory = 'document' | 'code' | 'data' | 'default';

/** Chunk 配置 */
export interface ChunkConfig {
  /** Chunk 大小（行数） */
  size: number;
  /** 重叠行数（防止边界遗漏） */
  overlap: number;
}

/** 文件分块 */
export interface FileChunk {
  /** 块内容 */
  content: string;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号 */
  endLine: number;
}

/** 并发处理选项 */
export interface ProcessOptions {
  /** 最大并发数，默认 3 */
  concurrentLimit?: number;
  /** 最大重试次数，默认 2 */
  maxRetries?: number;
  /** 重试延迟基数（毫秒），默认 1000 */
  retryDelayBaseMs?: number;
  /** 进度回调 */
  onProgress?: (completed: number, total: number) => void;
}

/** 处理结果包装 */
export interface ProcessResult<T> {
  /** 处理结果 */
  result: T;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 块索引 */
  chunkIndex: number;
}

// ==================== 常量配置 ====================

/** 每种文件类型的 Chunk 配置 */
const CHUNK_CONFIGS: Record<FileCategory, ChunkConfig> = {
  document: { size: 600, overlap: 80 }, // Markdown：更大 chunk，更少重叠
  code: { size: 350, overlap: 50 }, // 代码：更小 chunk，精细重叠
  data: { size: 800, overlap: 100 }, // JSON/CSV：大 chunk，行级别数据
  default: { size: 500, overlap: 100 }, // 默认
};

/** 文件扩展名分类映射 */
const EXTENSION_CATEGORIES: Record<string, FileCategory> = {
  // 文档类型
  md: 'document',
  txt: 'document',
  rst: 'document',
  adoc: 'document',
  tex: 'document',
  // 代码类型
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  cs: 'code',
  swift: 'code',
  kt: 'code',
  // 数据类型
  json: 'data',
  csv: 'data',
  yaml: 'data',
  yml: 'data',
  xml: 'data',
  toml: 'data',
};

/** 有效内容行数阈值，低于此值跳过 LLM 调用 */
const MIN_MEANINGFUL_LINES = 5;

/** 注释匹配模式 */
const COMMENT_PATTERNS = [
  /^\s*\/\//, // 单行注释 //
  /^\s*\/\*/, // 多行注释开始 /*
  /^\s*\*/, // 多行注释中间 *
  /^\s*#/, // Python/Shell 注释 #
];

// ==================== ChunkProcessor 类 ====================

/**
 * 通用分块处理器
 *
 * 使用示例：
 * ```typescript
 * const processor = new ChunkProcessor();
 * const chunks = processor.splitIntoChunks(lines, filePath);
 *
 * const results = await processor.processChunksInBatches(
 *     chunks,
 *     filePath,
 *     async (chunk, index) => {
 *         // 具体处理逻辑（如 LLM 调用）
 *         return await analyzeChunk(chunk);
 *     },
 *     { concurrentLimit: 3, maxRetries: 2 }
 * );
 * ```
 */
export class ChunkProcessor {
  /**
   * 根据文件扩展名确定文件类型
   *
   * @param filePath 文件路径
   * @returns 文件类型分类
   */
  getFileCategory(filePath: string): FileCategory {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_CATEGORIES[ext] ?? 'default';
  }

  /**
   * 获取文件类型对应的 Chunk 配置
   *
   * @param filePath 文件路径
   * @returns Chunk 配置（大小和重叠）
   */
  getChunkConfig(filePath: string): ChunkConfig {
    const category = this.getFileCategory(filePath);
    return CHUNK_CONFIGS[category];
  }

  /**
   * 将文件内容分割为重叠的 chunks
   *
   * @param lines 文件行数组
   * @param filePath 文件路径（用于获取自适应配置）
   * @param customConfig 可选的自定义配置
   * @returns 分块数组
   */
  splitIntoChunks(lines: string[], filePath: string, customConfig?: ChunkConfig): FileChunk[] {
    const config = customConfig ?? this.getChunkConfig(filePath);
    const { size, overlap } = config;
    const chunks: FileChunk[] = [];
    const step = size - overlap;

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(start + size, lines.length);
      chunks.push({
        content: lines.slice(start, end).join('\n'),
        startLine: start + 1, // 1-indexed
        endLine: end,
      });

      // 如果已经到达文件末尾，退出
      if (end >= lines.length) break;
    }

    logger.trace(
      `[ChunkProcessor] 分割完成: ${chunks.length} 个 chunk, ` +
        `配置: size=${size}, overlap=${overlap}`
    );

    return chunks;
  }

  /**
   * 判断是否应该跳过该 chunk
   *
   * 跳过条件：
   * 1. 有效内容行数 < MIN_MEANINGFUL_LINES
   * 2. 代码文件中全部是注释
   *
   * @param chunk 分块
   * @param filePath 文件路径
   * @returns 是否应该跳过
   */
  shouldSkipChunk(chunk: FileChunk, filePath: string): boolean {
    const lines = chunk.content.split('\n');

    // 统计非空行
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

    if (nonEmptyLines.length < MIN_MEANINGFUL_LINES) {
      logger.trace(
        `[ChunkProcessor] 跳过稀疏 chunk (行 ${chunk.startLine}-${chunk.endLine}): ` +
          `仅 ${nonEmptyLines.length} 行有效内容`
      );
      return true;
    }

    // 检测代码文件是否全部是注释
    const category = this.getFileCategory(filePath);
    if (category === 'code') {
      const commentLines = nonEmptyLines.filter((line) =>
        COMMENT_PATTERNS.some((pattern) => pattern.test(line))
      );

      if (commentLines.length === nonEmptyLines.length) {
        logger.trace(`[ChunkProcessor] 跳过纯注释 chunk (行 ${chunk.startLine}-${chunk.endLine})`);
        return true;
      }
    }

    return false;
  }

  /**
   * 判断错误是否可重试
   *
   * @param errorMessage 错误信息
   * @returns 是否可重试
   */
  isRetryableError(errorMessage: string): boolean {
    const retryablePatterns = [
      /timeout/i, // 超时
      /network/i, // 网络错误
      /429/, // API 限流
      /503/, // 服务不可用
      /502/, // 网关错误
      /connection/i, // 连接错误
      /ECONNRESET/, // 连接重置
      /ETIMEDOUT/, // 连接超时
    ];

    return retryablePatterns.some((pattern) => pattern.test(errorMessage));
  }

  /**
   * 带重试的并发批量处理
   *
   * 将 chunks 分批并行处理，支持：
   * - 自定义并发限制
   * - 指数退避重试
   * - 智能跳过空块
   *
   * @param chunks 分块数组
   * @param filePath 文件路径（用于跳过检测）
   * @param processor 处理函数回调
   * @param options 处理选项
   * @returns 处理结果数组
   */
  async processChunksInBatches<T>(
    chunks: FileChunk[],
    filePath: string,
    processor: (chunk: FileChunk, index: number) => Promise<T>,
    options: ProcessOptions = {}
  ): Promise<ProcessResult<T>[]> {
    const { concurrentLimit = 3, maxRetries = 2, retryDelayBaseMs = 1000, onProgress } = options;

    const results: ProcessResult<T>[] = [];
    let completedCount = 0;

    logger.trace(
      `[ChunkProcessor] 开始批量处理 ${chunks.length} 个 chunk, ` +
        `并发限制: ${concurrentLimit}, 最大重试: ${maxRetries}`
    );

    // 分批处理
    for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrentLimit) {
      const batchEnd = Math.min(batchStart + concurrentLimit, chunks.length);
      const batch = chunks.slice(batchStart, batchEnd);

      // 并行执行当前批次
      const batchPromises = batch.map(async (chunk, localIdx) => {
        // 确保 globalIndex 存在（localIdx 一定在 batch 范围内）
        const globalIndex = batchStart + localIdx;

        // 智能跳过空块
        if (this.shouldSkipChunk(chunk, filePath)) {
          return {
            result: null as unknown as T,
            success: true,
            chunkIndex: globalIndex,
            error: 'skipped',
          } as ProcessResult<T>;
        }

        // 带重试的处理
        return this.processWithRetry(chunk, globalIndex, processor, maxRetries, retryDelayBaseMs);
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // 更新进度
      completedCount += batch.length;
      if (onProgress) {
        onProgress(completedCount, chunks.length);
      }
    }

    // 统计结果
    const successCount = results.filter((r) => r.success).length;
    const skipCount = results.filter((r) => r.error === 'skipped').length;
    const failCount = results.filter((r) => !r.success && r.error !== 'skipped').length;

    logger.trace(
      `[ChunkProcessor] 处理完成: 成功 ${successCount}, ` + `跳过 ${skipCount}, 失败 ${failCount}`
    );

    return results;
  }

  /**
   * 带指数退避重试的单个处理
   *
   * @param chunk 分块
   * @param index 块索引
   * @param processor 处理函数
   * @param maxRetries 最大重试次数
   * @param retryDelayBaseMs 重试延迟基数
   * @param retryCount 当前重试次数
   */
  private async processWithRetry<T>(
    chunk: FileChunk,
    index: number,
    processor: (chunk: FileChunk, index: number) => Promise<T>,
    maxRetries: number,
    retryDelayBaseMs: number,
    retryCount: number = 0
  ): Promise<ProcessResult<T>> {
    try {
      const logSuffix = retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : '';
      logger.trace(
        `[ChunkProcessor] 处理 chunk ${index + 1}: ` +
          `行 ${chunk.startLine}-${chunk.endLine}${logSuffix}`
      );

      const result = await processor(chunk, index);
      return {
        result,
        success: true,
        chunkIndex: index,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 判断是否应该重试
      if (retryCount < maxRetries && this.isRetryableError(errorMessage)) {
        const delay = retryDelayBaseMs * Math.pow(2, retryCount); // 指数退避
        logger.warn(
          `[ChunkProcessor] chunk ${index + 1} 处理失败，` + `${delay}ms 后重试: ${errorMessage}`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));

        return this.processWithRetry(
          chunk,
          index,
          processor,
          maxRetries,
          retryDelayBaseMs,
          retryCount + 1
        );
      }

      // 超过重试次数或不可重试的错误
      logger.error(`[ChunkProcessor] chunk ${index + 1} 处理最终失败: ${errorMessage}`);
      return {
        result: null as unknown as T,
        success: false,
        error: errorMessage,
        chunkIndex: index,
      };
    }
  }
}

/**
 * 单例实例
 */
export const chunkProcessor = new ChunkProcessor();
