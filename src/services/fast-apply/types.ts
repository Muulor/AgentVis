/**
 * Fast-Apply Engine 类型定义
 *
 * 定义 XML 修改协议、匹配策略、快照管理和 Diff 相关的核心类型
 */

// ==================== 操作类型 ====================

/**
 * 修改操作类型
 * - REPLACE: 替换内容
 * - INSERT_AFTER: 在匹配内容后插入
 * - INSERT_BEFORE: 在匹配内容前插入
 * - DELETE: 删除匹配内容
 */
export type OperationType = 'REPLACE' | 'INSERT_AFTER' | 'INSERT_BEFORE' | 'DELETE';

/**
 * 单个修改协议
 * 从 XML <modification> 标签解析而来
 */
export interface Modification {
  /** 目标文件路径 */
  file: string;
  /** 操作类型 */
  operation: OperationType;
  /** 要查找的原文内容 */
  search: string;
  /** 替换后的内容（DELETE 操作时可选） */
  replace?: string;
  /** 修改说明 */
  description?: string;
}

/**
 * 批量修改协议
 * 从 XML <modifications> 标签解析而来
 */
export interface ModificationBatch {
  modifications: Modification[];
}

// ==================== 匹配结果 ====================

/**
 * 匹配级别
 * - exact: 精确字符串匹配
 * - fuzzy: 模糊匹配 (Levenshtein 相似度 > 0.8)
 * - semantic: 语义匹配 (向量相似度 > 0.85)
 * - manual: 需要人工介入
 */
export type MatchLevel = 'exact' | 'normalized' | 'fuzzy' | 'semantic' | 'manual';

/**
 * 内容匹配结果
 */
export interface MatchResult {
  /** 是否匹配成功 */
  success: boolean;
  /** 匹配级别 */
  matchLevel: MatchLevel;
  /** 匹配置信度 (0-1) */
  confidence: number;
  /** 匹配的起始行号 (1-indexed) */
  startLine: number;
  /** 匹配的结束行号 (1-indexed) */
  endLine: number;
  /** 实际匹配到的内容 */
  matchedContent: string;
  /** 匹配位置的字符偏移 */
  startOffset?: number;
  /** 匹配长度 */
  matchLength?: number;
}

/**
 * 匹配候选项（用于语义匹配时返回多个候选）
 */
export interface MatchCandidate {
  /** 候选内容 */
  content: string;
  /** 相似度评分 */
  score: number;
  /** 起始行号 */
  startLine: number;
  /** 结束行号 */
  endLine: number;
}

// ==================== 快照类型 ====================

/**
 * 文档快照
 * 用于版本控制和回滚
 */
export interface DocumentSnapshot {
  /** 快照 ID */
  id: string;
  /** 关联的文档 ID */
  documentId: string;
  /** 快照内容 */
  content: string;
  /** 创建时间戳 */
  timestamp: Date;
  /** 触发此快照的修改 ID */
  triggerModificationId?: string;
  /** 快照描述 */
  description: string;
  /**
   * 快照创建时各修改块的审批状态（索引→状态）
   *
   * 键为修改块索引（字符串形式），值为 ApplyStatus 字符串。
   * 用于回滚到历史版本时精确还原 diff 面板状态，
   * 避免内容推断无法区分 pending 和 rejected 的问题。
   */
  modificationStatuses?: Record<string, string>;
}

/**
 * 后端返回的快照响应格式
 */
export interface SnapshotResponse {
  id: string;
  documentId: string;
  content: string;
  triggerModificationId: string | null;
  description: string | null;
  /** 快照创建时的修改块审批状态（JSON 字符串）—— 来自 Rust 后端 */
  modificationStatusesJson: string | null;
  createdAt: number; // Unix timestamp
}

// ==================== Diff 类型 ====================

/**
 * Diff 行类型
 * - add: 新增行
 * - remove: 删除行
 * - context: 上下文行（无变化）
 */
export type DiffLineType = 'add' | 'remove' | 'context';

/**
 * 单行 Diff
 */
export interface DiffLine {
  /** 行类型 */
  type: DiffLineType;
  /** 行内容 */
  content: string;
  /** 旧文件行号（删除和上下文行有效） */
  oldLineNumber?: number;
  /** 新文件行号（新增和上下文行有效） */
  newLineNumber?: number;
}

/**
 * Diff 块（Hunk）
 */
export interface DiffHunk {
  /** 旧文件起始行号 */
  oldStart: number;
  /** 旧文件行数 */
  oldLines: number;
  /** 新文件起始行号 */
  newStart: number;
  /** 新文件行数 */
  newLines: number;
  /** 块内的所有行 */
  lines: DiffLine[];
}

/**
 * 完整的 Diff 结果
 */
export interface DiffResult {
  /** 旧内容 */
  oldContent: string;
  /** 新内容 */
  newContent: string;
  /** Diff 块列表 */
  hunks: DiffHunk[];
  /** 是否有变化 */
  hasChanges: boolean;
}

// ==================== 应用结果 ====================

/**
 * 修改应用状态
 */
export type ApplyStatus = 'pending' | 'applied' | 'rejected' | 'failed';

/**
 * 单个修改的应用结果
 */
export interface ModificationApplyResult {
  /** 修改 ID */
  modificationId: string;
  /** 原始修改协议 */
  modification: Modification;
  /** 匹配结果 */
  matchResult: MatchResult;
  /** Diff 预览 */
  diff: DiffResult;
  /** 应用状态 */
  status: ApplyStatus;
  /** 错误信息（失败时） */
  error?: string;
  /** 创建的快照 ID */
  snapshotId?: string;
  /** 应用修改前的原始内容（用于撤销） */
  originalContent?: string;
}

/**
 * 批量修改应用结果
 */
export interface BatchApplyResult {
  /** 文档 ID */
  documentId: string;
  /** 各个修改的结果 */
  results: ModificationApplyResult[];
  /** 成功数量 */
  successCount: number;
  /** 失败数量 */
  failedCount: number;
  /** 待确认数量 */
  pendingCount: number;
}

// ==================== Patch 模式类型 ====================

/**
 * Patch 模式的单个补丁项
 *
 * LLM 提供 search/replace 对，由 ContentMatcher 定位后替换。
 * search 字段需包含足够上下文以确保在文件中唯一匹配。
 */
export interface PatchItem {
  /** 要查找的原文片段（需足够独特以保证唯一匹配） */
  search: string;
  /** 替换为的新内容 */
  replace: string;
}

/**
 * 单个补丁的应用结果
 */
export interface PatchItemResult {
  /** 原始补丁 */
  patch: PatchItem;
  /** 是否应用成功 */
  success: boolean;
  /** 匹配级别（成功时有值） */
  matchLevel?: MatchLevel;
  /** 匹配置信度（成功时有值） */
  confidence?: number;
  /** 失败原因（失败时有值） */
  error?: string;
}

/**
 * executePatch 的整体结果
 */
export interface PatchResult {
  /** 最终文件内容（应用成功的 patches 后） */
  newContent: string;
  /** 各个 patch 的结果 */
  patchResults: PatchItemResult[];
  /** 成功数量 */
  successCount: number;
  /** 失败数量 */
  failedCount: number;
  /** 是否全部成功 */
  allSucceeded: boolean;
}

// ==================== 配置类型 ====================

/**
 * 内容匹配器配置
 */
export interface ContentMatcherConfig {
  /** 精确匹配是否忽略首尾空白 */
  trimWhitespace: boolean;
  /** 模糊匹配阈值 (0-1) */
  fuzzyThreshold: number;
  /** 语义匹配阈值 (0-1) */
  semanticThreshold: number;
  /** 是否启用语义匹配（需要网络） */
  enableSemanticMatch: boolean;
}

/**
 * 快照管理器配置
 */
export interface SnapshotManagerConfig {
  /** 默认保留的快照数量 */
  defaultKeepCount: number;
  /** 是否在修改前自动创建快照 */
  autoSnapshotBeforeModify: boolean;
}

/**
 * Fast-Apply 引擎配置
 */
export interface FastApplyConfig {
  /** 内容匹配器配置 */
  matcher: ContentMatcherConfig;
  /** 快照管理器配置 */
  snapshot: SnapshotManagerConfig;
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: FastApplyConfig = {
  matcher: {
    trimWhitespace: true,
    fuzzyThreshold: 0.8,
    semanticThreshold: 0.85,
    enableSemanticMatch: true,
  },
  snapshot: {
    defaultKeepCount: 10,
    autoSnapshotBeforeModify: true,
  },
};

// ==================== 全文 Diff 类型 ====================

/**
 * 全文 Diff 行
 * 扩展 DiffLine，添加绝对行号和修改归属信息
 */
export interface FullFileDiffLine extends DiffLine {
  /** 绝对行号（在合并后全文中的位置） */
  absoluteLineNumber: number;
  /** 所属修改 ID（若该行属于某个修改块） */
  modificationId?: string;
}

/**
 * 可折叠区域
 * 表示连续的上下文行，可以折叠显示
 */
export interface CollapsibleRegion {
  /** 起始索引（在 lines 数组中的位置） */
  startIndex: number;
  /** 结束索引（在 lines 数组中的位置） */
  endIndex: number;
  /** 折叠的行数 */
  lineCount: number;
  /** 是否展开 */
  isExpanded: boolean;
}

/**
 * 全文 Diff 渲染数据
 * 用于 FullFileDiffViewer 组件
 */
export interface FullFileDiffData {
  /** 文件名 */
  fileName: string;
  /** 所有行（含变更行和上下文行） */
  lines: FullFileDiffLine[];
  /** 可折叠区域列表 */
  collapsibleRegions: CollapsibleRegion[];
  /** 修改块信息（用于逐个接受/拒绝） */
  modifications: ModificationApplyResult[];
  /** 统计信息 */
  stats: {
    added: number;
    removed: number;
    pending: number;
    accepted: number;
    rejected: number;
    failed: number;
  };
}
