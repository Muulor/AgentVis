/**
 * Fast-Apply Engine 模块导出
 *
 * 提供统一的模块入口，导出所有类、类型和单例实例
 */

// 类型导出
export type {
  // 操作类型
  OperationType,
  // 修改协议
  Modification,
  ModificationBatch,
  // 匹配相关
  MatchLevel,
  MatchResult,
  MatchCandidate,
  // 快照相关
  DocumentSnapshot,
  SnapshotResponse,
  // Diff 相关
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffResult,
  // 应用结果
  ApplyStatus,
  ModificationApplyResult,
  BatchApplyResult,
  // 配置
  ContentMatcherConfig,
  SnapshotManagerConfig,
  FastApplyConfig,
} from './types';

// 常量导出
export { DEFAULT_CONFIG } from './types';

// 类导出
export { ProtocolParser, ProtocolParseError, protocolParser } from './ProtocolParser';
export { ContentMatcher, calculateSimilarity, levenshteinDistance } from './ContentMatcher';
export { DiffGenerator, diffGenerator } from './DiffGenerator';
export { SnapshotManager, snapshotManager } from './SnapshotManager';
export {
  ModificationExecutor,
  ModificationExecuteError,
  modificationExecutor,
} from './ModificationExecutor';
export { FastApplyEngine, FastApplyError, fastApplyEngine } from './FastApplyEngine';
export { diffToXml } from './DiffToXmlConverter';

// 前端服务导出
export { FastApplyService, fastApplyService, createFastApplyService } from './FastApplyService';

export type { SnapshotInfo } from './FastApplyService';
