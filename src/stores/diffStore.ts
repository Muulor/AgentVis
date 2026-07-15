/**
 * diffStore - Diff 预览模式状态管理
 *
 * 管理 Diff 模式、待审修改列表、审批状态和快照历史
 
 * - 按 contextId（Agent ID 或 Hub ID）隔离 Diff 状态
 * - 使用 Map<contextId, ContextDiffState> 存储隔离状态
 * - 与 chatStore 的隔离策略一致
 *
 */

import { create } from 'zustand';
import type { ModificationApplyResult, DocumentSnapshot } from '../services/fast-apply/types';
import { fastApplyEngine } from '../services/fast-apply';
import { ContentMatcher } from '../services/fast-apply/ContentMatcher';
import { getLogger } from '@services/logger';
import { countTextLines, measureRendererWorkAsync } from '@services/diagnostics/rendererHealth';

const logger = getLogger('diffStore');

/**
 * loadModifications 防抖/取消计数器
 *
 * 当同一 contextId+documentId 的 loadModifications 被连续调用时（增量合并场景），
 * 只有最新一次调用的 preview() 结果会被使用，之前的调用在 preview() 完成后被丢弃。
 * 避免昂贵的 ContentMatcher.fuzzyMatch() 导致的 5 分钟阻塞叠加。
 */
const loadModificationsGeneration = new Map<string, number>();
const activeModificationLoadGenerations = new Map<string, number>();
const latestModificationLoadTargets = new Map<string, { generation: number; content: string }>();
const snapshotRollbackGenerations = new Map<string, number>();
const persistedDiffLoadsInFlight = new Set<string>();

interface DeletedPathMarker {
  contextId: string;
  deletedPath: string;
  isDirectory: boolean;
}

/** 只保留最近的删除标记，覆盖“删除先于 Diff 回调启动”的短时竞态且限制内存增长。 */
const MAX_DELETED_PATH_MARKERS = 256;
const deletedPathMarkers: DeletedPathMarker[] = [];

/**
 * 规范化用于身份比较的文件路径。
 *
 * Diff 的 documentId 来自文件写入链路，而删除事件来自文件列表，两者在 Windows 上
 * 可能使用不同的分隔符或大小写。这里只做比较用规范化，不改变实际读写路径。
 */
function normalizePathForComparison(filePath: string): string {
  const hasUncPrefix = filePath.startsWith('\\\\') || filePath.startsWith('//');
  let normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (hasUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/);
  const isUncPath = normalized.startsWith('//');
  const isUnixAbsolute = !isUncPath && normalized.startsWith('/');
  const root = driveMatch?.[1] ?? (isUncPath ? '//' : isUnixAbsolute ? '/' : '');
  const remainder = driveMatch
    ? normalized.slice(driveMatch[0].length)
    : isUncPath
      ? normalized.slice(2)
      : isUnixAbsolute
        ? normalized.slice(1)
        : normalized;
  const segments: string[] = [];
  const lockedSegments = isUncPath ? 2 : 0;

  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > lockedSegments && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!root) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  normalized =
    root === '//'
      ? `//${segments.join('/')}`
      : root === '/'
        ? `/${segments.join('/')}`
        : driveMatch
          ? `${root}${segments.length > 0 ? `/${segments.join('/')}` : ''}`
          : segments.join('/');

  return driveMatch || isUncPath ? normalized.toLowerCase() : normalized;
}

/** 判断 documentId 是否就是被删除路径，或位于被删除目录之下。 */
function isPathDeleted(documentId: string, deletedPath: string, isDirectory: boolean): boolean {
  const normalizedDocumentId = normalizePathForComparison(documentId);
  const normalizedDeletedPath = normalizePathForComparison(deletedPath);

  if (!normalizedDeletedPath) return false;
  if (normalizedDocumentId === normalizedDeletedPath) return true;
  if (!isDirectory) return false;
  if (normalizedDeletedPath === '/') return normalizedDocumentId.startsWith('/');
  return normalizedDocumentId.startsWith(`${normalizedDeletedPath}/`);
}

/** 使目标路径尚未完成的 loadModifications 结果失效，防止删除后被迟到结果重新插入。 */
function invalidateModificationLoads(
  contextId: string,
  deletedPath: string,
  isDirectory: boolean
): boolean {
  const contextPrefix = `${contextId}::`;
  let invalidatedActiveLoad = false;
  for (const [generationKey, generation] of loadModificationsGeneration) {
    if (!generationKey.startsWith(contextPrefix)) continue;
    const documentId = generationKey.slice(contextPrefix.length);
    if (isPathDeleted(documentId, deletedPath, isDirectory)) {
      if (activeModificationLoadGenerations.has(generationKey)) {
        invalidatedActiveLoad = true;
      }
      loadModificationsGeneration.set(generationKey, generation + 1);
    }
  }
  return invalidatedActiveLoad;
}

function hasActiveModificationLoadForContext(
  contextId: string,
  excludedGenerationKey?: string,
  excludedGeneration?: number
): boolean {
  const contextPrefix = `${contextId}::`;
  for (const [generationKey, generation] of activeModificationLoadGenerations) {
    if (!generationKey.startsWith(contextPrefix)) continue;
    if (generationKey === excludedGenerationKey && generation === excludedGeneration) continue;
    return true;
  }
  return false;
}

function markDeletedPath(contextId: string, deletedPath: string, isDirectory: boolean): void {
  const normalizedDeletedPath = normalizePathForComparison(deletedPath);
  const duplicateIndex = deletedPathMarkers.findIndex(
    (marker) =>
      marker.contextId === contextId &&
      marker.deletedPath === normalizedDeletedPath &&
      marker.isDirectory === isDirectory
  );
  if (duplicateIndex >= 0) {
    deletedPathMarkers.splice(duplicateIndex, 1);
  }
  deletedPathMarkers.push({
    contextId,
    deletedPath: normalizedDeletedPath,
    isDirectory,
  });
  if (deletedPathMarkers.length > MAX_DELETED_PATH_MARKERS) {
    deletedPathMarkers.shift();
  }
}

function wasPathDeleted(contextId: string, documentId: string): boolean {
  return deletedPathMarkers.some(
    (marker) =>
      marker.contextId === contextId &&
      isPathDeleted(documentId, marker.deletedPath, marker.isDirectory)
  );
}

// ==================== 常量 ====================

/** Undo/Redo 栈最大深度 */
const MAX_HISTORY_DEPTH = 50;

// ==================== 工具函数 ====================

/**
 * 根据当前文件内容推断修改状态
 * 使用 ContentMatcher 进行匹配，确保与首次匹配策略一致
 *
 * @param currentContent 当前文件内容（回滚后的快照内容）
 * @param modifications 修改列表
 * @param originalContent 可选，原始文件内容（任何修改之前的内容），用于区分"已删除"和"匹配失败"
 */
function inferModificationStatus(
  currentContent: string,
  modifications: ModificationApplyResult[],
  originalContent?: string
): ModificationApplyResult[] {
  // 创建 ContentMatcher 实例，复用与首次匹配相同的策略
  const matcher = new ContentMatcher({ trimWhitespace: true });

  /**
   * 使用 ContentMatcher 检查 search 内容是否存在于目标内容中
   * 包含精确匹配和逐行 trim 匹配
   *
   * 关键：规范化换行符，解决 Windows (\r\n) 和 Unix (\n) 换行符不匹配问题
   */
  const contentContainsSearch = (content: string, search: string): boolean => {
    // 规范化换行符：统一转换为 \n
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const normalizedSearch = search.replace(/\r\n/g, '\n');

    // 使用 ContentMatcher 的精确匹配（包含逐行 trim）
    const matchResult = matcher.exactMatch(normalizedContent, normalizedSearch);
    return matchResult?.success === true;
  };

  return modifications.map((mod, index) => {
    const searchContent = mod.modification.search;
    const replaceContent = mod.modification.replace ?? '';

    // 最小长度检查：如果 search 内容太短，保持原状态（避免误判）
    const MIN_MATCH_LENGTH = 10;
    if (searchContent.trim().length < MIN_MATCH_LENGTH) {
      logger.trace(
        `[inferStatus] #${index + 1}: search 内容太短 (${searchContent.trim().length} < ${MIN_MATCH_LENGTH})，保持原状态:`,
        mod.status
      );
      return mod;
    }

    // DELETE 操作：使用原始内容区分"已删除"和"匹配失败"
    if (mod.modification.operation === 'DELETE') {
      const searchExistsInCurrent = contentContainsSearch(currentContent, searchContent);
      // 如果有原始内容，检查 search 是否在原始内容中存在过
      const searchExistsInOriginal = originalContent
        ? contentContainsSearch(originalContent, searchContent)
        : true;
      let newStatus: 'pending' | 'applied' | 'failed';

      if (searchExistsInCurrent) {
        // 要删除的内容还在 → 待处理
        newStatus = 'pending';
      } else if (searchExistsInOriginal) {
        // 原始内容中存在但当前不存在 → 已成功删除
        newStatus = 'applied';
      } else {
        // 原始内容中也不存在 → 匹配失败（从来就不匹配）
        newStatus = 'failed';
      }

      logger.trace(
        `[inferStatus] #${index + 1} DELETE: inCurrent=${searchExistsInCurrent}, inOriginal=${searchExistsInOriginal} → ${newStatus}`
      );
      return { ...mod, status: newStatus };
    }

    // REPLACE/INSERT 操作
    const replaceExists =
      replaceContent.trim().length >= MIN_MATCH_LENGTH &&
      contentContainsSearch(currentContent, replaceContent);
    const searchExists = contentContainsSearch(currentContent, searchContent);

    let inferredStatus: 'pending' | 'applied' | 'failed' = mod.status as
      | 'pending'
      | 'applied'
      | 'failed';
    if (replaceExists && !searchExists) {
      // 替换内容存在，原内容不存在 → 已应用
      inferredStatus = 'applied';
    } else if (searchExists && !replaceExists) {
      // 原内容存在，替换内容不存在 → 待处理
      inferredStatus = 'pending';
    } else if (!searchExists && !replaceExists) {
      // 两者都不存在 → 失败
      inferredStatus = 'failed';
    }
    // 如果 searchExists && replaceExists，保持原状态（无法确定）

    logger.trace(
      `[inferStatus] #${index + 1} ${mod.modification.operation}: searchExists=${searchExists}, replaceExists=${replaceExists} → ${inferredStatus}`
    );
    return { ...mod, status: inferredStatus };
  });
}

/**
 * 基于 matchResult 行范围直接重建内容（主路径）
 * 失败时回退到 Myers diff + 改进关联算法（安全兜底）
 *
 * 主路径（matchResult）：
 *   每个 modification 携带 matchResult.startLine / endLine（1-indexed），
 *   精确标记原始内容中的行范围。file_write 模式下 search 内容来自精确 diff，
 *   ContentMatcher 能可靠匹配。直接遍历原始行，按状态选择输出。
 *
 * 兜底路径（Myers diff）：
 *   当 matchResult 不可靠时（LLM 手写 search/replace 可能不精确），
 *   使用 Myers diff 生成精确编辑序列，再用修改顺序（而非行号重叠启发式）
 *   将变更块关联到对应 modification。
 *
 * @param originalContent 原始文件内容（任何修改之前）
 * @param preAppliedContent LLM 写入的内容（所有修改已应用）
 * @param allMods 所有修改列表（包含各自的 status 和 matchResult）
 * @returns 重建后的内容
 */
async function rebuildContentByDiff(
  originalContent: string,
  preAppliedContent: string,
  allMods: ModificationApplyResult[]
): Promise<string> {
  const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';

  // 检测 matchResult 是否可靠：所有有效 mod 都必须成功匹配且行范围有效
  const allMatchable = allMods.every((m) => m.matchResult.success && m.matchResult.startLine > 0);

  if (allMatchable) {
    // 主路径：基于 matchResult 精确行范围重建
    const result = rebuildByMatchResult(originalContent, allMods, lineEnding);
    if (result !== null) {
      return result;
    }
    // 主路径失败时落入兜底
    logger.warn('[diffStore] matchResult 重建失败，回退到 Myers diff');
  } else {
    logger.trace('[diffStore] 存在无效 matchResult，使用 Myers diff 兜底');
  }

  // 兜底路径：Myers diff + 改进关联
  return await rebuildByMyersDiff(originalContent, preAppliedContent, allMods, lineEnding);
}

/**
 * 主路径：基于 matchResult 行范围直接遍历原始内容重建
 *
 * rejected → 保留原始行；active → 输出 replace 内容
 * @returns 重建结果；如果检测到异常返回 null 触发回退
 */
function rebuildByMatchResult(
  originalContent: string,
  allMods: ModificationApplyResult[],
  lineEnding: string
): string | null {
  const originalLines = originalContent.split(/\r?\n/);

  // 按 startLine 升序排列，筛选有效修改
  const validMods = allMods
    .filter((m) => m.matchResult.success && m.matchResult.startLine > 0)
    .sort((a, b) => a.matchResult.startLine - b.matchResult.startLine);

  const resultLines: string[] = [];
  let currentLine = 0; // 0-indexed

  for (const mod of validMods) {
    const modStartIdx = mod.matchResult.startLine - 1; // 转为 0-indexed
    const modEndIdx = mod.matchResult.endLine - 1;

    // 防御：跳过已处理过的行范围（重叠修改时安全回退）
    if (modStartIdx < currentLine) {
      continue;
    }

    // 输出修改之前的原始行
    while (currentLine < modStartIdx && currentLine < originalLines.length) {
      const line = originalLines[currentLine];
      if (line !== undefined) resultLines.push(line);
      currentLine++;
    }

    if (mod.status === 'rejected') {
      // rejected：保留原始行（恢复原始内容）
      while (currentLine <= modEndIdx && currentLine < originalLines.length) {
        const line = originalLines[currentLine];
        if (line !== undefined) resultLines.push(line);
        currentLine++;
      }
    } else {
      // active：跳过原始行，输出替换内容
      currentLine = modEndIdx + 1;
      if (mod.modification.operation === 'DELETE') {
        // DELETE：不输出任何内容
      } else if (mod.modification.replace !== undefined) {
        const replaceLines = mod.modification.replace.split(/\r?\n/);
        resultLines.push(...replaceLines);
      }
    }
  }

  // 输出剩余的原始行
  while (currentLine < originalLines.length) {
    const line = originalLines[currentLine];
    if (line !== undefined) resultLines.push(line);
    currentLine++;
  }

  logger.trace(
    '[diffStore] rebuildByMatchResult: 原始行数:',
    originalLines.length,
    ', 有效修改数:',
    validMods.length,
    ', 结果行数:',
    resultLines.length
  );

  return resultLines.join(lineEnding);
}

/**
 * 兜底路径：Myers diff + 改进变更块关联算法
 *
 * 改进点（相比旧版）：
 * 使用 mod-centric 1:N 分配策略——按 modification 顺序收集变更块，
 * 已分配的块不再参与后续 mod 的匹配，避免多块关联到同一 mod 导致的错位问题。
 */
async function rebuildByMyersDiff(
  originalContent: string,
  preAppliedContent: string,
  allMods: ModificationApplyResult[],
  lineEnding: string
): Promise<string> {
  // 延迟导入（仅在兜底时使用，使用 ESM 动态 import 兼容 Vite）
  const { myersDiff } = await import('../services/fast-apply/MyersDiff');

  const originalLines = originalContent.split(/\r?\n/);
  const preAppliedLines = preAppliedContent.split(/\r?\n/);

  const editOps = myersDiff(originalLines, preAppliedLines);

  // 将连续的非 context 操作分组为变更块
  interface ChangeBlock {
    ops: Array<{ type: 'context' | 'add' | 'remove'; content: string; oldIdx?: number }>;
    startOpIndex: number;
    origStartLine: number; // 0-indexed，来自 oldIdx
    origEndLine: number; // 0-indexed
    assignedModId?: string;
  }

  const changeBlocks: ChangeBlock[] = [];
  let i = 0;
  while (i < editOps.length) {
    const op = editOps[i];
    if (!op || op.type === 'context') {
      i++;
      continue;
    }

    const block: ChangeBlock = {
      ops: [],
      startOpIndex: i,
      origStartLine: Infinity,
      origEndLine: 0,
    };
    while (i < editOps.length) {
      const cur = editOps[i];
      if (!cur || cur.type === 'context') break;
      block.ops.push(cur);
      if (cur.type === 'remove' && cur.oldIdx !== undefined) {
        block.origStartLine = Math.min(block.origStartLine, cur.oldIdx);
        block.origEndLine = Math.max(block.origEndLine, cur.oldIdx);
      }
      i++;
    }
    if (block.origStartLine === Infinity) block.origStartLine = 0;
    changeBlocks.push(block);
  }

  // 改进关联：mod-centric 1:N 分配
  // 按 mod 的 matchResult.startLine 排序后，依次收集未分配的变更块
  const assignedBlocks = new Set<number>();
  const sortedMods = [...allMods]
    .filter((m) => m.matchResult.startLine > 0)
    .sort((a, b) => a.matchResult.startLine - b.matchResult.startLine);

  for (const mod of sortedMods) {
    // matchResult 是 1-indexed，block.origStartLine 是 0-indexed
    const modStart = mod.matchResult.startLine - 1;
    const modEnd = mod.matchResult.endLine - 1;

    for (let bIdx = 0; bIdx < changeBlocks.length; bIdx++) {
      if (assignedBlocks.has(bIdx)) continue;
      const block = changeBlocks[bIdx];
      if (!block) continue;

      // 计算重叠（统一为 0-indexed）
      const overlapStart = Math.max(block.origStartLine, modStart);
      const overlapEnd = Math.min(block.origEndLine, modEnd);
      if (overlapEnd >= overlapStart) {
        block.assignedModId = mod.modificationId;
        assignedBlocks.add(bIdx);
      }
    }
  }

  // 构建 op→block 映射
  const opToBlock = new Map<number, ChangeBlock>();
  for (const block of changeBlocks) {
    for (let j = 0; j < block.ops.length; j++) {
      opToBlock.set(block.startOpIndex + j, block);
    }
  }

  // 选择性构建结果
  const resultLines: string[] = [];
  let opIdx = 0;
  while (opIdx < editOps.length) {
    const op = editOps[opIdx];
    if (!op) {
      opIdx++;
      continue;
    }

    if (op.type === 'context') {
      resultLines.push(op.content);
      opIdx++;
      continue;
    }

    const block = opToBlock.get(opIdx);
    if (!block) {
      if (op.type === 'add') resultLines.push(op.content);
      opIdx++;
      continue;
    }

    const mod = block.assignedModId
      ? allMods.find((m) => m.modificationId === block.assignedModId)
      : null;

    if (mod?.status === 'rejected') {
      // rejected：恢复原始行
      for (const bOp of block.ops) {
        if (bOp.type === 'remove') resultLines.push(bOp.content);
      }
    } else {
      // active：保持新内容
      for (const bOp of block.ops) {
        if (bOp.type === 'add') resultLines.push(bOp.content);
      }
    }

    opIdx += block.ops.length;
  }

  logger.trace(
    '[diffStore] rebuildByMyersDiff: 原始行数:',
    originalLines.length,
    ', 变更块数:',
    changeBlocks.length,
    ', 结果行数:',
    resultLines.length
  );

  return resultLines.join(lineEnding);
}

/**
 * 持久化每个修改块的审批状态到数据库
 *
 * 部分审批（如拒绝 block1 但保留 block2 pending）后调用，
 * 将各块精确状态序列化为 JSON 写入 diff_records.modification_statuses，
 * 重启时无需启发式推断，直接恢复确切状态。
 */
async function persistModificationStatuses(
  contextId: string,
  documentId: string,
  modifications: ModificationApplyResult[]
): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 使用数组索引作为键（modificationId 含 Date.now() 不稳定，每次 preview() 重新生成）
    // 同一 XML 解析出的 modifications 顺序确定，索引即稳定标识符
    const statusMap: Record<string, string> = {};
    for (let i = 0; i < modifications.length; i++) {
      const mod = modifications[i];
      if (mod) {
        statusMap[String(i)] = mod.status;
      }
    }
    const statusesJson = JSON.stringify(statusMap);
    await invoke('diff_record_update_modification_statuses', {
      contextId,
      documentId,
      statusesJson,
    });
    logger.trace('[diffStore] 📝 已持久化修改块状态:', statusesJson);
  } catch (error) {
    // 持久化失败不阻塞主流程
    logger.warn('[diffStore] ⚠ 持久化修改块状态失败:', error);
  }
}

/**
 * 将修改列表转为 {索引→状态} 映射
 *
 * 用于快照创建时随快照持久化当时的修改块审批状态，
 * 回滚到该快照时可直接恢复，而无需内容推断。
 * 键使用数组索引而非 modificationId（ID 含时间戳，每次 preview 重新生成，不稳定）。
 */
function buildModificationStatusMap(
  modifications: ModificationApplyResult[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < modifications.length; i++) {
    const mod = modifications[i];
    if (mod) {
      map[String(i)] = mod.status;
    }
  }
  return map;
}

// ==================== 类型定义 ====================

export type DiffMode = 'normal' | 'diff';

/** Viewer 与审批逻辑必须同步切换的一组 Diff 投影字段。 */
interface DiffProjectionState {
  baseContent: string;
  targetContent: string;
  preAppliedContent?: string;
  xml: string;
  modifications: ModificationApplyResult[];
  activeSnapshotId: string | null;
  mode: DiffMode;
}

/**
 * 历史操作记录
 * 用于 Undo/Redo 栈
 */
export interface HistoryEntry {
  /** 操作类型 */
  type: 'accept' | 'reject' | 'undo' | 'rollback';
  /** 操作前的内容 */
  contentBefore: string;
  /** 操作后的内容 */
  contentAfter: string;
  /** 相关的修改 ID */
  modificationId?: string;
  /** 描述 */
  description: string;
  /** 操作时间戳 */
  timestamp: number;
  /** 操作前的修改列表状态（用于完整恢复） */
  pendingModificationsBefore?: ModificationApplyResult[];
  /** 操作后的修改列表状态 */
  pendingModificationsAfter?: ModificationApplyResult[];
  /** 回滚类操作前的完整 Diff 投影，用于 Undo 后恢复同一套坐标基准 */
  projectionBefore?: DiffProjectionState;
  /** 回滚类操作后的完整 Diff 投影，用于 Redo 后恢复同一套坐标基准 */
  projectionAfter?: DiffProjectionState;
}

/**
 * 单个文件的 diff 条目
 * 多文件场景下，每个文件独立维护自己的审批/undo/redo 栈
 */
export interface FileDiffEntry {
  documentId: string;
  fileName: string;
  content: string;
  originalContent: string;
  pendingModifications: ModificationApplyResult[];
  originalXml: string;
  preAppliedContent: string;
  snapshots: DocumentSnapshot[];
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /** 当前文件激活的历史快照；必须按文件保存，避免多文件切换串线 */
  activeSnapshotId: string | null;
}

/**
 * 单个上下文的 Diff 状态（按 Agent ID 或 Hub ID 隔离）
 */
export interface ContextDiffState {
  /** 当前模式 */
  mode: DiffMode;
  /** 当前文档 ID（当前活跃文件） */
  documentId: string | null;
  /** 当前文档内容（会随 accept/rollback 变化） */
  content: string;
  /** 原始文档内容（任何修改之前的内容，不会变化，用于状态推断） */
  originalContent: string;
  /** 文件名 */
  fileName: string;
  /** 待审修改列表 */
  pendingModifications: ModificationApplyResult[];
  /** 原始 XML */
  originalXml: string;
  /** 快照列表 */
  snapshots: DocumentSnapshot[];
  /** Undo 栈 */
  undoStack: HistoryEntry[];
  /** Redo 栈 */
  redoStack: HistoryEntry[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /**
   * LLM 写入后的新内容（file_write 覆盖模式）
   *
   * file_write 流程下 LLM 先写入此内容到磁盘，
   * 用于 reject 时通过 diff 重建恢复原始行，
   * 以及 undo reject 时恢复磁盘文件到"被覆写后"的状态
   */
  preAppliedContent: string;
  /** 多文件条目（键=documentId），支持同一 Agent 下多个文件的 diff 管理 */
  fileEntries: Map<string, FileDiffEntry>;
  /** 当前活跃文件的 documentId */
  activeFileId: string | null;
  /** 当前激活的快照 ID（用于历史面板显示当前版本号，回滚后也可告知用户所在版本） */
  activeSnapshotId: string | null;
}

/** 创建空的上下文状态 */
function createEmptyContextState(): ContextDiffState {
  return {
    mode: 'normal',
    documentId: null,
    content: '',
    originalContent: '',
    fileName: '',
    pendingModifications: [],
    originalXml: '',
    snapshots: [],
    undoStack: [],
    redoStack: [],
    isLoading: false,
    error: null,
    preAppliedContent: '',
    fileEntries: new Map(),
    activeFileId: null,
    activeSnapshotId: null,
  };
}

/**
 * 从顶层字段提取 FileDiffEntry
 * 用于保存当前活跃文件的状态到 fileEntries
 */
function extractFileDiffEntry(ctx: ContextDiffState): FileDiffEntry | null {
  if (!ctx.documentId) return null;
  return {
    documentId: ctx.documentId,
    fileName: ctx.fileName,
    content: ctx.content,
    originalContent: ctx.originalContent,
    pendingModifications: ctx.pendingModifications,
    originalXml: ctx.originalXml,
    preAppliedContent: ctx.preAppliedContent,
    snapshots: ctx.snapshots,
    undoStack: ctx.undoStack,
    redoStack: ctx.redoStack,
    activeSnapshotId: ctx.activeSnapshotId,
  };
}

/**
 * 将 FileDiffEntry 同步到顶层字段
 * 用于切换活跃文件时恢复该文件的状态
 */
function applyFileDiffEntry(ctx: ContextDiffState, entry: FileDiffEntry): ContextDiffState {
  return {
    ...ctx,
    documentId: entry.documentId,
    fileName: entry.fileName,
    content: entry.content,
    originalContent: entry.originalContent,
    pendingModifications: entry.pendingModifications,
    originalXml: entry.originalXml,
    preAppliedContent: entry.preAppliedContent,
    snapshots: entry.snapshots,
    undoStack: entry.undoStack,
    redoStack: entry.redoStack,
    activeFileId: entry.documentId,
    activeSnapshotId: entry.activeSnapshotId,
  };
}

const ORIGINAL_FILE_VERSION_DESCRIPTION = 'Original file version';

/**
 * 历史列表按时间倒序，历史面板的语义是“前一版本 → 当前版本”。目标存在时优先取
 * 它后面的同文档快照；目标是原始版本时以自身为空 Diff 基准。旧数据缺项时才回退
 * 到显式原始快照或最旧保留项。
 */
function findSnapshotPreviewBase(
  snapshots: DocumentSnapshot[],
  targetSnapshot?: DocumentSnapshot
): DocumentSnapshot | null {
  if (targetSnapshot) {
    if (targetSnapshot.description === ORIGINAL_FILE_VERSION_DESCRIPTION) return targetSnapshot;
    const targetIndex = snapshots.findIndex((snapshot) => snapshot.id === targetSnapshot.id);
    const previousSnapshot = targetIndex >= 0 ? snapshots[targetIndex + 1] : undefined;
    if (previousSnapshot?.documentId === targetSnapshot.documentId) return previousSnapshot;

    return (
      snapshots.find(
        (snapshot) =>
          snapshot.documentId === targetSnapshot.documentId &&
          snapshot.description === ORIGINAL_FILE_VERSION_DESCRIPTION
      ) ?? null
    );
  }

  return (
    snapshots.find((snapshot) => snapshot.description === ORIGINAL_FILE_VERSION_DESCRIPTION) ??
    snapshots[snapshots.length - 1] ??
    null
  );
}

function isModificationStatus(value: unknown): value is ModificationApplyResult['status'] {
  return typeof value === 'string' && ['pending', 'applied', 'rejected', 'failed'].includes(value);
}

function resetGeneratedProjectionStatuses(
  modifications: ModificationApplyResult[]
): ModificationApplyResult[] {
  return modifications.map((modification) => ({
    ...modification,
    status:
      modification.status === 'failed' || !modification.matchResult.success ? 'failed' : 'pending',
  }));
}

/**
 * 快照状态按旧 XML 的修改块索引保存；动态历史预览会合成为新的整文件修改块。
 * 只有拓扑数量和每个索引都兼容时才能复用，否则保持 pending 让用户看到真实内容差异，
 * 避免把旧 index=0 的 applied/rejected 错套到整个文件。
 */
function applyCompatibleModificationStatuses(
  modifications: ModificationApplyResult[],
  statuses: Record<string, string> | undefined,
  source: string
): ModificationApplyResult[] {
  if (!statuses) return resetGeneratedProjectionStatuses(modifications);

  const statusKeys = Object.keys(statuses);
  const isCompatible =
    statusKeys.length === modifications.length &&
    modifications.every((_, index) => {
      const status = statuses[String(index)];
      return status !== undefined && isModificationStatus(status);
    });

  if (!isCompatible) {
    logger.warn(
      `[diffStore] ${source} 的快照状态拓扑与动态 Diff 不兼容，保持 ${modifications.length} 个修改块为 pending`
    );
    return resetGeneratedProjectionStatuses(modifications);
  }

  return modifications.map((modification, index) => ({
    ...modification,
    status: statuses[String(index)] as ModificationApplyResult['status'],
  }));
}

function parseModificationStatuses(
  statusesJson: string | undefined,
  source: string
): Record<string, string> | undefined {
  if (!statusesJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(statusesJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('modification statuses must be an object');
    }

    const statuses: Record<string, string> = {};
    for (const [index, status] of Object.entries(parsed)) {
      if (!isModificationStatus(status)) {
        throw new TypeError(`invalid modification status at index ${index}`);
      }
      statuses[index] = status;
    }
    return statuses;
  } catch (error) {
    logger.warn(`[diffStore] ${source} 的快照状态 JSON 无法解析，保持 preview 默认状态:`, error);
    return undefined;
  }
}

interface SnapshotSourceRecord {
  documentId: string;
  originalContent: string;
  modifiedContent: string;
  xmlModification: string | null;
  modificationStatuses: string | null;
}

/** 内容相同的往返回写无法仅凭快照内容确定来源；歧义时保守使用相邻快照投影。 */
function findUniqueSnapshotSourceRecord<T extends SnapshotSourceRecord>(
  records: T[],
  documentId: string,
  targetContent: string,
  source: string
): T | undefined {
  const matches = records.filter(
    (record) =>
      record.documentId === documentId &&
      record.modifiedContent === targetContent &&
      Boolean(record.xmlModification)
  );
  if (matches.length > 1) {
    logger.warn(`[diffStore] ${source} 匹配到多个同内容源 Diff，改用相邻快照兜底`);
    return undefined;
  }
  return matches[0];
}

/**
 * 将快照 preview 的基准、目标、XML 与修改块作为不可拆分的状态单元提交，
 * 并同步当前多文件条目，避免 Viewer、审批重建和文件切换使用不同轮次的基准。
 */
function syncActiveFileEntry(ctx: ContextDiffState): ContextDiffState {
  const activeEntry = extractFileDiffEntry(ctx);
  if (!activeEntry) return ctx;

  const fileEntries = new Map(ctx.fileEntries);
  fileEntries.set(activeEntry.documentId, activeEntry);
  return { ...ctx, fileEntries };
}

function applySnapshotDiffProjection(
  ctx: ContextDiffState,
  projection: DiffProjectionState
): ContextDiffState {
  const projectedContext: ContextDiffState = {
    ...ctx,
    content: projection.targetContent,
    originalContent: projection.baseContent,
    preAppliedContent: projection.preAppliedContent ?? projection.targetContent,
    originalXml: projection.xml,
    pendingModifications: projection.modifications,
    activeSnapshotId: projection.activeSnapshotId,
    mode: projection.mode,
  };
  return syncActiveFileEntry(projectedContext);
}

/**
 * 旧写入完成时若已有新操作接管，按最新 generation 重写目标内容；补偿期间 generation
 * 再次变化则重试，避免补偿本身覆盖更晚一轮写入。连续高频变化时有界退出并记录错误。
 */
async function compensateSupersededFileWrite(
  contextId: string,
  documentId: string,
  generationKey: string,
  supersededLoadGeneration: number | undefined,
  getContext: () => ContextDiffState | undefined,
  writeContent: (content: string) => Promise<void>
): Promise<void> {
  const maxAttempts = 3;
  const resolveCurrentTarget = (observedLoadGeneration: number | undefined) => {
    const latestLoadTarget = latestModificationLoadTargets.get(generationKey);
    const currentCtx = getContext();
    return latestLoadTarget !== undefined &&
      activeModificationLoadGenerations.get(generationKey) === observedLoadGeneration &&
      latestLoadTarget.generation === observedLoadGeneration &&
      latestLoadTarget.generation !== supersededLoadGeneration
      ? latestLoadTarget.content
      : currentCtx?.documentId === documentId
        ? currentCtx.content
        : currentCtx?.fileEntries.get(documentId)?.content;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (wasPathDeleted(contextId, documentId)) return;

    const observedLoadGeneration = loadModificationsGeneration.get(generationKey);
    const observedMutationGeneration = snapshotRollbackGenerations.get(generationKey);
    const supersedingContent = resolveCurrentTarget(observedLoadGeneration);
    if (supersedingContent === undefined) return;

    await writeContent(supersedingContent);
    const latestLoadGeneration = loadModificationsGeneration.get(generationKey);
    const generationsUnchanged =
      latestLoadGeneration === observedLoadGeneration &&
      snapshotRollbackGenerations.get(generationKey) === observedMutationGeneration;
    if (generationsUnchanged && resolveCurrentTarget(latestLoadGeneration) === supersedingContent) {
      return;
    }
  }

  logger.error('[diffStore] 迟到文件写入补偿期间状态持续变化，已达到重试上限:', documentId);
}

interface DiffState {
  /** 当前活动的 contextId（Agent ID 或 Hub ID） */
  currentContextId: string | null;
  /** 按 contextId 隔离的 Diff 状态 */
  diffByContext: Map<string, ContextDiffState>;
  /** 是否显示快照面板（全局 UI 状态，不需要隔离） */
  isSnapshotPanelOpen: boolean;
}

interface DiffActions {
  // ==================== 上下文操作 ====================
  /** 设置当前活动上下文 */
  setCurrentContext: (contextId: string) => void;
  /** 获取指定上下文的状态 */
  getDiffState: (contextId: string) => ContextDiffState;
  /** 重置指定上下文 */
  resetContext: (contextId: string) => void;

  // ==================== 模式操作 ====================
  /** 设置模式（需要 contextId） */
  setMode: (contextId: string, mode: DiffMode) => void;

  // ==================== 修改审批 ====================
  /** 从数据库加载已持久化的 Diff 记录（应用启动/切换 Agent 时调用） */
  loadPersistedDiffs: (contextId: string) => Promise<void>;
  /** 加载修改预览（需要 contextId）
   * @param isRestoring 是否为恢复加载（从数据库恢复时传 true，跳过快照创建和数据库写入）
   * @param currentContentForInference 可选，用于状态推断的当前内容（恢复时使用）
   * @param preAppliedContent LLM 写入后的新内容（file_write 覆盖模式）
   */
  loadModifications: (
    contextId: string,
    documentId: string,
    content: string,
    xml: string,
    messageId: string,
    fileName?: string,
    isRestoring?: boolean,
    currentContentForInference?: string,
    preAppliedContent?: string,
    persistedModStatuses?: string
  ) => Promise<void>;
  /** 接受单个修改 */
  acceptModification: (contextId: string, id: string) => Promise<void>;
  /** 拒绝单个修改（file_write 覆盖模式下会回写当前内容到磁盘） */
  rejectModification: (contextId: string, id: string) => Promise<void>;
  /** 撤销操作（支持文件回滚） */
  undoModification: (contextId: string, id: string) => Promise<void>;
  /** 全部接受 */
  acceptAll: (contextId: string) => Promise<void>;
  /** 全部拒绝（file_write 覆盖模式下会回写原始内容到磁盘） */
  rejectAll: (contextId: string) => Promise<void>;
  /** 跳过失败的修改 */
  skipModification: (contextId: string, id: string) => void;

  // ==================== 多文件操作 ====================
  /** 切换活跃文件（保存当前文件状态，恢复目标文件状态到顶层） */
  selectFile: (contextId: string, documentId: string) => void;
  /** 获取文件列表（返回每个文件的 documentId、fileName 和待审数量） */
  getFileList: (
    contextId: string
  ) => Array<{ documentId: string; fileName: string; pendingCount: number }>;
  /** 将当前活跃文件的顶层状态同步回 fileEntries */
  syncActiveFileToEntries: (contextId: string) => void;
  /** 文件/目录删除成功后，使对应的内存 Diff 和 pending 持久化记录失效 */
  discardDiffsForDeletedPath: (
    contextId: string,
    deletedPath: string,
    isDirectory: boolean
  ) => Promise<void>;

  // ==================== 快照操作 ====================
  /** 加载快照列表 */
  loadSnapshots: (contextId: string, documentId: string) => Promise<void>;
  /** 回滚到指定快照 */
  rollback: (contextId: string, snapshotId: string) => Promise<string>;
  /** 删除快照 */
  deleteSnapshot: (contextId: string, snapshotId: string) => Promise<void>;
  /** 切换快照面板 */
  toggleSnapshotPanel: () => void;

  // ==================== Undo/Redo 操作 ====================
  /** 全局撤销 */
  undo: (contextId: string) => Promise<void>;
  /** 全局重做 */
  redo: (contextId: string) => Promise<void>;
  /** 是否可撤销 */
  canUndo: (contextId: string) => boolean;
  /** 是否可重做 */
  canRedo: (contextId: string) => boolean;

  // ==================== MessageId 更新 ====================
  /** 更新临时 messageId 为真实 ID（Planning 模式使用） */
  updateMessageId: (contextId: string, oldMessageId: string, newMessageId: string) => Promise<void>;

  // ==================== 历史版本访问 ====================
  /**
   * 获取当前 contextId 下所有「审批已完成且有历史快照可查」的文件列表
   *
   * 返回值：每项含 documentId、fileName，供 Normal 模式渲染每个文件的历史入口。
   * 多文件场景下，每个文件独立显示历史入口，用户可按需定位回滚哪个文件。
   *
   * 数据来源：
   * - 当前活跃文件从顶层字段读取（documentId / pendingModifications / snapshots）
   * - 其他文件从 fileEntries 读取（acceptAll/rejectAll 会将文件状态写入 fileEntries）
   *
   * 快照条件宽松处理：fileEntries 中的文件只需有 pendingModifications（曾被 diff），
   * 选择该文件后 selectFile 会触发 loadSnapshots，快照面板会动态填充。
   */
  getCompletedDiffFiles: (contextId: string) => Array<{ documentId: string; fileName: string }>;

  // ==================== 状态重置 ====================
  /** 重置到初始状态 */
  reset: () => void;
}

// ==================== Store 实现 ====================

export const useDiffStore = create<DiffState & DiffActions>((set, get) => ({
  // 初始状态
  currentContextId: null,
  diffByContext: new Map(),
  isSnapshotPanelOpen: false,

  // ==================== 上下文操作 ====================

  setCurrentContext: (contextId) => {
    set({ currentContextId: contextId });
  },

  getDiffState: (contextId) => {
    const { diffByContext } = get();
    return diffByContext.get(contextId) ?? createEmptyContextState();
  },

  resetContext: (contextId) => {
    set((state) => {
      const newMap = new Map(state.diffByContext);
      newMap.delete(contextId);
      return { diffByContext: newMap };
    });
  },

  // ==================== 模式操作 ====================

  setMode: (contextId, mode) => {
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const ctx = newMap.get(contextId) ?? createEmptyContextState();

      if (mode === 'diff') {
        // 切到 diff 模式前检查：是否还有 pending 修改
        const currentFilePending =
          ctx.pendingModifications.filter((m) => m.status === 'pending').length > 0;
        const otherFilePendingEntry = Array.from(ctx.fileEntries.values()).find(
          (e) =>
            e.documentId !== ctx.activeFileId &&
            e.pendingModifications.some((m) => m.status === 'pending')
        );

        if (!currentFilePending && !otherFilePendingEntry) {
          // 所有文件已审批完成，不允许再切到 diff 模式
          // 保持 normal 状态不变
          return { diffByContext: newMap };
        }

        if (!currentFilePending && otherFilePendingEntry) {
          // 当前文件已完成，自动切换到第一个有 pending 的文件
          newMap.set(
            contextId,
            applyFileDiffEntry({ ...ctx, mode: 'diff' }, otherFilePendingEntry)
          );
          return { diffByContext: newMap, currentContextId: contextId };
        }
      }

      newMap.set(contextId, { ...ctx, mode });
      return { diffByContext: newMap, currentContextId: contextId };
    });
  },

  // ==================== 修改审批 ====================

  loadPersistedDiffs: async (contextId) => {
    // 防重加载：如果当前上下文已有 Diff 数据，跳过恢复
    const existingState = get().diffByContext.get(contextId);
    if (existingState && existingState.pendingModifications.length > 0) {
      logger.trace('[diffStore] 已存在 Diff 数据，跳过恢复, contextId:', contextId);
      return;
    }

    if (persistedDiffLoadsInFlight.has(contextId)) {
      logger.trace('[diffStore] Diff 恢复已在进行，跳过重复加载, contextId:', contextId);
      return;
    }
    persistedDiffLoadsInFlight.add(contextId);

    // 从数据库加载该上下文的 pending 状态 Diff 记录
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      interface PersistedDiffRecord {
        id: string;
        contextId: string;
        messageId: string;
        documentId: string;
        originalContent: string;
        modifiedContent: string;
        xmlModification: string | null;
        status: string;
        activeSnapshotId: string | null; // 当前激活的快照 ID
        modificationStatuses: string | null; // 每个修改块的审批状态（JSON）
        createdAt: number;
        updatedAt: number;
      }

      const records = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', { contextId });

      if (records.length === 0) {
        logger.trace('[diffStore] 无待恢复的 Diff 记录, contextId:', contextId);
        return;
      }

      logger.trace('[diffStore]  从数据库恢复', records.length, '条 Diff 记录');

      // 按 documentId 分组，取最新的一条
      const latestByDoc = new Map<string, PersistedDiffRecord>();
      for (const record of records) {
        const existing = latestByDoc.get(record.documentId);
        if (!existing || record.createdAt > existing.createdAt) {
          latestByDoc.set(record.documentId, record);
        }
      }

      // 恢复所有文档的 Diff（多文件支持）
      for (const [docId, record] of latestByDoc) {
        if (!record.xmlModification) continue;
        if (wasPathDeleted(contextId, record.documentId)) {
          logger.trace('[diffStore] 跳过本次会话中已删除路径的持久化 Diff:', record.documentId);
          continue;
        }

        // 文件存在性前置校验：用户可能在未审批 diff 的情况下手动删除了工作目录中的文件，
        // 此时 diff_record 仍为 pending 状态。若不检查文件存在性，恢复流程会以 DB 数据
        // 兜底继续恢复，导致面板出现指向不存在文件的 stale diff，使用户困惑。
        // 与 deleteSnapshot 中的清理逻辑保持一致，标记为 reverted 后跳过。
        if (record.documentId.includes(':')) {
          try {
            await invoke<string>('file_read_content', { filePath: record.documentId });
          } catch {
            logger.warn(`[diffStore] 文件已不存在，跳过恢复并标记 reverted: ${record.documentId}`);
            try {
              await invoke('diff_record_update_status', {
                id: record.id,
                status: 'reverted',
              });
            } catch (statusError) {
              logger.warn('[diffStore] 标记 diff_record reverted 失败:', statusError);
            }
            continue;
          }
        }

        // 获取当前内容用于状态推断
        let currentContent = record.originalContent;
        // activeSnapshot 的修改块状态（优先于 diff record 级别的状态）
        let activeSnapshotStatusesJson: string | null = null;

        // 尝试从数据库快照获取内容
        const activeSnapshotId = record.activeSnapshotId;
        let validatedActiveSnapshotId: string | null = null;
        if (activeSnapshotId) {
          try {
            interface SnapshotData {
              id: string;
              documentId: string;
              content: string;
              description: string | null;
              modificationStatusesJson: string | null;
              createdAt: number;
            }
            const snapshot = await invoke<SnapshotData | null>('snapshot_get', {
              id: activeSnapshotId,
            });
            if (snapshot?.documentId === record.documentId) {
              currentContent = snapshot.content;
              validatedActiveSnapshotId = activeSnapshotId;
              // 优先使用快照中保存的修改块状态，而非 diff_record 的最终状态
              // 原因：diff_record.modificationStatuses 记录的是截止上次操作的全局状态，
              // 但用户可能在多次回滚后停留在某个历史版本，该版本对应的精确状态
              // 只保存在 activeSnapshot.modificationStatusesJson 中
              activeSnapshotStatusesJson = snapshot.modificationStatusesJson;
              logger.trace('[diffStore]  使用快照内容用于状态推断:', activeSnapshotId);
            } else if (snapshot) {
              // 旧版后端曾按 context 批量写 active_snapshot_id，可能把文件 A 的快照
              // 关联到文件 B。恢复端必须校验 documentId，避免把跨文件内容当作当前基准。
              logger.warn(
                '[diffStore] activeSnapshot 属于其他文档，忽略旧污染关联:',
                activeSnapshotId
              );
            }
          } catch {
            logger.warn('[diffStore]  无法读取快照，尝试读取文件');
          }
        }

        // 尝试读取当前文件内容
        if (currentContent === record.originalContent) {
          try {
            // 参数名应为 filePath 而非 path
            const fileContent = await invoke<string>('file_read_content', {
              filePath: record.documentId,
            });
            currentContent = fileContent;
            logger.trace('[diffStore]  使用当前文件内容用于状态推断');
          } catch {
            logger.warn('[diffStore]  无法读取文件，使用原始内容');
          }
        }

        // preAppliedContent 优先从磁盘读取当前文件内容（磁盘即真相）。
        //
        // 背景：preAppliedContent 用于 rebuildContentByDiff 在 reject/undo 时重建内容。
        // 数据库中的 modifiedContent 是 file_write 时写入的内容，可能因用户在重启前
        // 执行的 reject/undo 操作而与当前磁盘不一致（reject 改变了磁盘文件内容）。
        // 若用陈旧的 modifiedContent 重建，rebuildContentByDiff 的行映射将产生偏差，
        // 导致重启恢复后用户再次 reject/accept 时文件内容发生偏差。
        //
        // 每次恢复时都重新读取磁盘文件，保证 preAppliedContent 与磁盘同步；
        // 文件读取失败时回退到 modifiedContent 作为兜底。
        let restoredPreAppliedContent = record.modifiedContent;
        if (record.documentId.includes(':')) {
          try {
            // 参数名应为 filePath 而非 path
            const diskContent = await invoke<string>('file_read_content', {
              filePath: record.documentId,
            });
            // 只有当磁盘内容与原始内容不同时才使用（原始文件未变化时无需替换）
            if (diskContent !== record.originalContent) {
              restoredPreAppliedContent = diskContent;
              logger.trace('[diffStore]  使用磁盘当前内容作为 preAppliedContent（Bug5 修复）');
            }
          } catch {
            logger.warn(
              '[diffStore]  无法读取文件，使用 DB 存储的 modifiedContent 作为 preAppliedContent'
            );
          }
        }
        // 重启恢复时优先使用 activeSnapshot 的修改块状态（精确还原用户最后所在版本的 diff 面板）
        // 兜底：若快照无状态数据（旧版快照），使用 diff_record 级别的状态
        const effectiveModStatuses =
          activeSnapshotStatusesJson ?? record.modificationStatuses ?? undefined;
        logger.trace(
          `[diffStore]  重启恢复使用状态来源: ${activeSnapshotStatusesJson ? 'activeSnapshot' : record.modificationStatuses ? 'diffRecord' : 'none'}`
        );

        // 上述快照/文件读取会让出事件循环；删除可能发生在最初存在性检查之后。
        if (wasPathDeleted(contextId, record.documentId)) {
          logger.trace('[diffStore] 持久化 Diff 在加载期间被删除，停止恢复:', record.documentId);
          continue;
        }

        // 使用原始内容解析 XML（得到完整 Diff 列表）
        // 但需要传递当前内容用于状态推断
        const restoreGenerationKey = `${contextId}::${record.documentId}`;
        const restorePromise = get().loadModifications(
          contextId,
          record.documentId,
          record.originalContent, // 用原始内容解析 XML，确保得到完整 Diff 列表
          record.xmlModification,
          record.messageId,
          record.documentId.split(/[/\\]/).pop() ?? 'document',
          true, // isRestoring: 恢复加载时跳过快照和数据库写入
          currentContent, // 传递当前内容用于状态推断
          restoredPreAppliedContent, // preAppliedContent: 优先使用磁盘内容，兜底用 DB 记录
          effectiveModStatuses // 优先使用 activeSnapshot 的精确状态
        );
        // loadModifications 会在首次 await 前同步分配 generation；必须立即绑定本次恢复的
        // generation，不能等 promise 完成后再读，否则同路径的新 Diff 可能已接管该 key。
        const restoreGeneration = loadModificationsGeneration.get(restoreGenerationKey);
        await restorePromise;
        const isRestoreCurrent = () => {
          const restoredCtx = get().diffByContext.get(contextId);
          return (
            restoreGeneration !== undefined &&
            loadModificationsGeneration.get(restoreGenerationKey) === restoreGeneration &&
            !wasPathDeleted(contextId, record.documentId) &&
            restoredCtx?.activeFileId === record.documentId &&
            restoredCtx.fileEntries.has(record.documentId)
          );
        };
        if (!isRestoreCurrent()) {
          logger.trace('[diffStore] 持久化 Diff 恢复结果已失效，跳过后处理:', record.documentId);
          continue;
        }

        // === 重启恢复后：使用快照动态 XML 刷新 diff preview ===
        //
        // 背景：loadModifications 固定用 record.xmlModification（最终全量 XML）做 preview，
        // 无论用户上次停留在哪个版本，diff 面板都显示"原始→最终版"的全量 diff。
        //
        // 列出该文档所有快照，优先恢复目标对应的源 Diff；源记录缺失时使用相邻历史版本
        // 动态生成 XML 并重新 preview，与 rollback() 的逻辑保持一致。
        if (activeSnapshotId) {
          try {
            // 直接从引擎获取快照列表，避免依赖 Zustand state 的异步时序
            const snapshots = await fastApplyEngine.listSnapshots(record.documentId);
            if (!isRestoreCurrent()) continue;
            const targetSnap = snapshots.find(
              (snapshot) =>
                snapshot.id === activeSnapshotId && snapshot.documentId === record.documentId
            );
            if (targetSnap) validatedActiveSnapshotId = targetSnap.id;
            const sourceRecord = targetSnap
              ? findUniqueSnapshotSourceRecord(
                  records,
                  record.documentId,
                  targetSnap.content,
                  '重启恢复 activeSnapshot'
                )
              : undefined;
            const fallbackBaseSnap = findSnapshotPreviewBase(snapshots, targetSnap);
            const projectionBaseContent =
              sourceRecord?.originalContent ?? fallbackBaseSnap?.content;

            if (targetSnap && projectionBaseContent !== undefined) {
              let refreshedMods: ModificationApplyResult[];
              let projectionXml = sourceRecord?.xmlModification ?? '';
              if (!projectionXml) {
                const { generateWholeFileReplaceXml } =
                  await import('../services/fast-apply/DiffToXmlConverter');
                if (!isRestoreCurrent()) continue;
                projectionXml = generateWholeFileReplaceXml(
                  projectionBaseContent,
                  targetSnap.content
                );
              }
              // 只有源 Diff 命中时，状态索引才与 XML 属于同一拓扑；动态相邻快照投影一律
              // 使用 preview 自身的 pending/failed 状态，避免把旧 index=0 套到整文件块。
              const projectionStatuses = sourceRecord
                ? parseModificationStatuses(
                    activeSnapshotStatusesJson ??
                      sourceRecord.modificationStatuses ??
                      effectiveModStatuses,
                    '重启恢复 activeSnapshot'
                  )
                : undefined;

              if (targetSnap.content === projectionBaseContent) {
                // 目标是原始文件版本：无任何 diff，清空修改块，切回 normal 模式
                refreshedMods = [];
                logger.trace('[diffStore] 重启恢复：目标版本为原始文件，清空修改块');
              } else {
                try {
                  const batchResult = await measureRendererWorkAsync(
                    'diffStore.loadPersistedDiffs.preview',
                    {
                      contentChars: projectionBaseContent.length,
                      contentLines: countTextLines(projectionBaseContent),
                      targetChars: targetSnap.content.length,
                      targetLines: countTextLines(targetSnap.content),
                      xmlChars: projectionXml.length,
                    },
                    () =>
                      fastApplyEngine.preview(
                        record.documentId,
                        projectionBaseContent,
                        projectionXml
                      )
                  );
                  if (!isRestoreCurrent()) continue;

                  refreshedMods = sourceRecord
                    ? applyCompatibleModificationStatuses(
                        batchResult.results,
                        projectionStatuses,
                        '重启恢复 activeSnapshot'
                      )
                    : resetGeneratedProjectionStatuses(batchResult.results);
                  logger.trace(
                    `[diffStore] 重启恢复：${sourceRecord ? '源 Diff' : '快照兜底'} preview 刷新完成，${refreshedMods.length} 个修改`
                  );
                } catch (previewError) {
                  if (!isRestoreCurrent()) continue;
                  // 失败时关闭不可信的 Diff，但仍提交一致的目标快照投影，允许后续重新恢复。
                  logger.error(
                    '[diffStore] 重启恢复后 snapshot preview 失败，关闭该文件的不可信 Diff:',
                    previewError
                  );
                  refreshedMods = [];
                }
              }

              // preview 的坐标、Viewer 底稿和审批重建基准必须作为同一投影原子更新。
              set((state) => {
                const newMap = new Map(state.diffByContext);
                const rehydratedCtx = newMap.get(contextId);
                if (rehydratedCtx) {
                  newMap.set(
                    contextId,
                    applySnapshotDiffProjection(rehydratedCtx, {
                      baseContent: projectionBaseContent,
                      targetContent: targetSnap.content,
                      xml: projectionXml,
                      modifications: refreshedMods,
                      mode: refreshedMods.length === 0 ? 'normal' : rehydratedCtx.mode,
                      activeSnapshotId: targetSnap.id,
                    })
                  );
                }
                return { diffByContext: newMap };
              });
            } else {
              logger.warn(
                '[diffStore] activeSnapshot 不属于当前文档或已不存在，跳过恢复:',
                activeSnapshotId
              );
            }
          } catch (refreshError) {
            logger.error(
              '[diffStore] 重启恢复后快照投影构建失败，关闭该文件的不可信 Diff:',
              refreshError
            );
            if (!isRestoreCurrent() || !validatedActiveSnapshotId) continue;
            set((state) => {
              const newMap = new Map(state.diffByContext);
              const restoredCtx = newMap.get(contextId);
              if (restoredCtx) {
                newMap.set(
                  contextId,
                  applySnapshotDiffProjection(restoredCtx, {
                    baseContent: currentContent,
                    targetContent: currentContent,
                    preAppliedContent: currentContent,
                    xml: '',
                    modifications: [],
                    activeSnapshotId: validatedActiveSnapshotId,
                    mode: 'normal',
                  })
                );
              }
              return { diffByContext: newMap };
            });
          }
        }

        logger.trace('[diffStore]  Diff 已恢复:', docId);
      }
    } catch (error) {
      logger.error('[diffStore] 加载持久化 Diff 失败:', error);
    } finally {
      persistedDiffLoadsInFlight.delete(contextId);
    }
  },

  loadModifications: async (
    contextId,
    documentId,
    content,
    xml,
    messageId,
    fileName = 'document',
    isRestoring = false,
    currentContentForInference,
    preAppliedContent,
    persistedModStatuses
  ) => {
    logger.trace(
      `[diffStore] loadModifications: contextId=${contextId}, doc=${documentId}, contentLen=${content.length}, xmlLen=${xml.length}, preAppliedLen=${preAppliedContent?.length ?? 0}, messageId=${messageId}`
    );

    // 递增 generation，让之前尚未完成的 preview() 调用在返回时自动放弃
    const generationKey = `${contextId}::${documentId}`;
    const currentGen = (loadModificationsGeneration.get(generationKey) ?? 0) + 1;
    loadModificationsGeneration.set(generationKey, currentGen);
    activeModificationLoadGenerations.set(generationKey, currentGen);
    const publishLatestLoadTarget = (targetContent: string) => {
      if (
        loadModificationsGeneration.get(generationKey) === currentGen &&
        activeModificationLoadGenerations.get(generationKey) === currentGen
      ) {
        latestModificationLoadTargets.set(generationKey, {
          generation: currentGen,
          content: targetContent,
        });
      }
    };
    publishLatestLoadTarget(
      isRestoring
        ? (currentContentForInference ?? preAppliedContent ?? content)
        : (preAppliedContent ?? content)
    );

    const settleCancelledLoad = () => {
      if (activeModificationLoadGenerations.get(generationKey) === currentGen) {
        activeModificationLoadGenerations.delete(generationKey);
      }
      const anotherLoadIsActive = hasActiveModificationLoadForContext(contextId);
      set((state) => {
        const ctx = state.diffByContext.get(contextId);
        if (!ctx) return { diffByContext: state.diffByContext };
        const newMap = new Map(state.diffByContext);
        newMap.set(contextId, {
          ...ctx,
          isLoading: anotherLoadIsActive,
          error: null,
        });
        return { diffByContext: newMap };
      });
    };

    // 设置加载状态
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const ctx = newMap.get(contextId) ?? createEmptyContextState();
      newMap.set(contextId, { ...ctx, isLoading: true, error: null });
      return { diffByContext: newMap, currentContextId: contextId };
    });

    try {
      // 让出事件循环：确保同一 tick 内的后续 loadModifications 调用
      // 已递增 generation，使当前调用能检测到自己已过期
      await new Promise<void>((r) => setTimeout(r, 0));

      // 预检查：如果已有更新的调用排队，跳过昂贵的 preview() 计算
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace(
          `[diffStore] loadModifications 跳过过期的 preview()（gen=${currentGen}，当前=${loadModificationsGeneration.get(generationKey) ?? 'unknown'}）`
        );
        return;
      }

      // 删除事件可能早于 Diff 回调启动，此时 generation 尚不存在、无法由删除动作递增。
      // 对命中过删除标记的路径验证磁盘现状：缺失说明是迟到回调；内容不同说明路径已被
      // 另一轮写入重新创建，旧回调也不再代表当前文件。内容一致则视为有效的新建版本。
      if (wasPathDeleted(contextId, documentId)) {
        if (isRestoring) {
          logger.trace('[diffStore] 已删除路径的持久化 Diff 不再恢复');
          settleCancelledLoad();
          return;
        }
        try {
          const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
          const diskContent = await tauriInvoke<string>('file_read_content', {
            filePath: documentId,
          });
          if (preAppliedContent !== undefined && diskContent !== preAppliedContent) {
            logger.trace('[diffStore] 删除后的迟到 Diff 与当前磁盘内容不一致，停止加载');
            settleCancelledLoad();
            return;
          }
        } catch {
          logger.trace('[diffStore] 删除后的迟到 Diff 指向不存在的文件，停止加载');
          settleCancelledLoad();
          return;
        }
      }

      // === 5.3 磁盘同步校验（仅首次加载，非恢复路径）===
      // 场景：用户手动编辑文件后 SA 再次写入，传入的 content（原始基准）
      // 可能与磁盘文件不同步，导致 diff 基准错误、search 匹配偏移。
      // 校验逻辑：读取磁盘文件，若内容长度不同则更新基准，确保 search 基于真实内容。
      // 注意：仅比较长度（高效），不做全文 MD5（避免大文件性能问题）
      //
      // preAppliedContent 是 SA 写入后的版本，若 content !== preAppliedContent
      // 说明有写入操作发生，此时磁盘读取的是 preAppliedContent（已由调用方传入），
      // 故这里只在 content 与 preAppliedContent 相同时才做磁盘同步校验，
      // 即"SA 写入后内容 === 原始内容"（或没有写入）的场景。
      if (
        !isRestoring &&
        documentId.includes(':') &&
        (!preAppliedContent || preAppliedContent === content)
      ) {
        try {
          const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
          const diskContent = await tauriInvoke<string>('file_read_content', {
            filePath: documentId,
          });
          if (diskContent.length !== content.length && diskContent !== content) {
            // 磁盘内容与传入基准不一致，说明用户手动编辑过
            // 使用磁盘内容作为新的基准，确保 search 能正确匹配
            logger.warn(
              `[diffStore] 5.3: 基准内容与磁盘不同步 (传入=${content.length} 字符, 磁盘=${diskContent.length} 字符)，使用磁盘内容更新基准`
            );
            const previousContent = content;
            content = diskContent;
            if (preAppliedContent === previousContent) {
              preAppliedContent = diskContent;
            }
            publishLatestLoadTarget(diskContent);
          }
        } catch (diskError) {
          // 读取失败时静默降级，不影响主流程
          logger.warn('[diffStore] 5.3: 磁盘同步校验失败，使用传入的原始内容:', diskError);
        }
      }

      // 使用 FastApplyEngine 解析并预览修改
      const previewStart = Date.now();
      let batchResult = await measureRendererWorkAsync(
        'diffStore.loadModifications.preview',
        {
          contentChars: content.length,
          contentLines: countTextLines(content),
          xmlChars: xml.length,
          isRestoring,
          hasPreAppliedContent: Boolean(preAppliedContent),
        },
        () => fastApplyEngine.preview(documentId, content, xml)
      );
      const previewElapsed = Date.now() - previewStart;

      // 检查 generation：如果已有更新的调用，丢弃当前结果
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace(
          `[diffStore] loadModifications 结果已过期（gen=${currentGen}，当前=${loadModificationsGeneration.get(generationKey) ?? 'unknown'}），丢弃`
        );
        return;
      }

      logger.trace(
        `[diffStore] preview 结果: ${batchResult.results.length} 个修改, pending=${batchResult.pendingCount}, failed=${batchResult.failedCount} (${previewElapsed}ms)`
      );

      // === MATCH FAILED 自动降级策略 ===
      //
      // 背景：patch 模式 XML 中的 INSERT 块锚点在重复代码结构（如大量 `/**` `});` 注释）中
      // 可能不唯一，导致 ContentMatcher 匹配失败（matchResult.success=false）。
      // 失败的 mod 仍进入 pending 列表但行号、diff hunks 为空，造成面板视觉歧义。
      //
      // 降级策略：
      // - 检测到任何 MATCH FAILED（matchResult.success===false）时，
      //   切换为整文件单一 REPLACE XML（wholeFileReplace 模式）重新 preview。
      // - wholeFileReplace 使用完整文件内容作为 search，匹配永远成功，
      //   diff 显示所有 hunk，用户能清楚看到全部改动，无视觉歧义。
      // - 触发条件：preAppliedContent 存在且与 content 不同（有实际写入）。
      //   若无 preAppliedContent，无法生成 wholeFileReplace，维持原结果。
      //
      // 注意：降级后是 1 个块（整文件），用户无法逐块 accept/reject，
      //   但这比"部分失败、面板展示错误"更安全可预期。
      const hasMatchFailure = batchResult.results.some((r) => !r.matchResult.success);
      if (hasMatchFailure && !isRestoring && preAppliedContent && preAppliedContent !== content) {
        const failedCount = batchResult.results.filter((r) => !r.matchResult.success).length;
        logger.warn(
          `[diffStore] 检测到 ${failedCount}/${batchResult.results.length} 个 MATCH FAILED，` +
            `降级为整文件替换模式（wholeFileReplace）`
        );
        try {
          const { generateWholeFileReplaceXml } =
            await import('../services/fast-apply/DiffToXmlConverter');
          const fallbackXml = generateWholeFileReplaceXml(content, preAppliedContent);
          // 用降级 XML 重新 preview
          batchResult = await measureRendererWorkAsync(
            'diffStore.loadModifications.fallbackPreview',
            {
              contentChars: content.length,
              contentLines: countTextLines(content),
              xmlChars: fallbackXml.length,
              preAppliedChars: preAppliedContent.length,
              preAppliedLines: countTextLines(preAppliedContent),
            },
            () => fastApplyEngine.preview(documentId, content, fallbackXml)
          );
          // 同步更新 xml 变量，使后续 snapshot 创建、DB 持久化、state.originalXml
          // 均使用降级后的 XML，保证 rollback 回滚路径的 ctx.originalXml 也正确
          xml = fallbackXml;
          logger.trace(
            `[diffStore] 降级成功：wholeFileReplace preview 完成，` +
              `${batchResult.results.length} 个修改, failed=${batchResult.failedCount}`
          );
        } catch (fallbackError) {
          // 降级失败静默维持原结果，不阻塞主流程
          logger.warn('[diffStore] wholeFileReplace 降级失败，保持原分块预览结果:', fallbackError);
        }
      }

      // fallback preview 也可能耗时；删除事件或更新的加载请求发生后，不再继续创建快照/记录。
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace('[diffStore] loadModifications 在 fallback preview 后已失效，停止提交');
        return;
      }

      // 首次加载时创建初始快照，恢复加载时跳过（避免重复创建快照）
      if (!isRestoring) {
        // 原始文件版本：所有 mod 均为 pending（SA 尚未有任何用户审批）
        const allPendingStatuses = buildModificationStatusMap(
          batchResult.results.map((m) => ({ ...m, status: 'pending' as const }))
        );

        // 去重检查：若此文档已存在任何"原始文件版本"快照，跳过创建
        // 原因：增量合并（SubAgentDispatcher）在每次全量覆盖写入后会重置 firstOriginalContent，
        // 导致第二次 loadModifications 传入的 content 已不是最初的原始文件内容。
        // 若用内容对比去重，内容已变化导致判断失效，仍会重复创建"原始文件版本"快照。
        // 正确策略：同一 contextId + documentId 下，"原始文件版本"语义上只有一个，
        // 即"SA 开始处理此文档前的最初状态"，只需创建一次。
        const existingSnapshots = await fastApplyEngine.listSnapshots(documentId);
        const isDuplicateOriginal = existingSnapshots.some(
          (s) => s.description === 'Original file version'
        );

        if (!isDuplicateOriginal) {
          await fastApplyEngine
            .getSnapshotManager()
            .createSnapshot(
              documentId,
              content,
              'Original file version',
              undefined,
              allPendingStatuses
            );
        } else {
          logger.trace('[diffStore] 跳过重复的原始文件版本快照（内容已存在）');
        }

        // 若 preAppliedContent 不为空且与原始内容不同，说明 SA 进行了实际写入，
        // 将写入后内容也存为一个快照，方便局部审批后可回退到 SA 完成的状态
        if (preAppliedContent && preAppliedContent !== content) {
          await fastApplyEngine.getSnapshotManager().createSnapshot(
            documentId,
            preAppliedContent,
            'Post-write version',
            undefined,
            allPendingStatuses // SA写入后版本也是全部 pending（用户尚未审批）
          );
        }
      }

      // 快照 I/O 期间文件可能已被删除。快照可作为历史证据保留，但不能再创建 pending Diff。
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace('[diffStore] loadModifications 在快照创建后已失效，停止提交');
        return;
      }

      // 首次加载时持久化 Diff 记录，恢复加载时跳过（避免重复记录）
      if (messageId && !isRestoring) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const createdRecord = await invoke<{ id: string }>('diff_record_create', {
            request: {
              contextId,
              messageId,
              documentId,
              originalContent: content,
              // file_write 模式：存储 LLM 修改后的内容，用于重启恢复时重建 diff
              modifiedContent: preAppliedContent ?? content,
              xmlModification: xml,
            },
          });

          // 删除可能恰好发生在 DB create 执行期间；立即关闭刚创建的记录，避免重启恢复。
          if (loadModificationsGeneration.get(generationKey) !== currentGen) {
            try {
              await invoke('diff_record_update_status', {
                id: createdRecord.id,
                status: 'reverted',
              });
            } catch (statusError) {
              logger.warn('[diffStore] 失效 Diff 记录标记 reverted 失败:', statusError);
            }
            return;
          }
          logger.trace('[diffStore]  Diff 记录已持久化, messageId:', messageId);
        } catch (persistError) {
          logger.error('[diffStore] 持久化 Diff 记录失败:', persistError);
          // 不阻塞主流程
        }
      }

      // 恢复加载时：根据当前内容推断修改状态
      // 使用 currentContentForInference（如果提供）进行推断，否则使用 content
      let finalModifications = batchResult.results;
      if (isRestoring) {
        if (persistedModStatuses) {
          // 优先使用持久化的每块状态（精确恢复，无启发式推断）
          try {
            const statusMap = JSON.parse(persistedModStatuses) as Record<string, string>;
            // 使用数组索引匹配（而非 modificationId，因为 ID 含 Date.now() 不稳定）
            finalModifications = batchResult.results.map((mod, index) => {
              const persistedStatus = statusMap[String(index)];
              if (persistedStatus) {
                return { ...mod, status: persistedStatus as ModificationApplyResult['status'] };
              }
              return mod;
            });
            logger.trace('[diffStore]  使用持久化状态恢复，跳过启发式推断');
          } catch (parseError) {
            // JSON 解析失败时回退到启发式推断
            logger.warn('[diffStore]  持久化状态 JSON 解析失败，回退到推断模式:', parseError);
            const contentForInference = currentContentForInference ?? content;
            finalModifications = inferModificationStatus(
              contentForInference,
              batchResult.results,
              content
            );
          }
        } else {
          // 无持久化状态（用户从未审批，或为搭载 modificationStatuses 之前的老记录）
          const contentForInference = currentContentForInference ?? content;

          // === 关键防护：区分"SA 完成但用户未审批"与"老记录需推断"两种场景 ===
          //
          // 场景 A：SA 刚完成任务，文件已写入，用户尚未审批。
          //   - 磁盘内容 === preAppliedContent（SA 写入后版本）
          //   - 此时不应运行推断：infer 会看到 search 不在磁盘 → replaceExists=true → applied
          //     导致所有 pending 变 applied，diff 面板全部消失。
          //   - 正确行为：保持全部 pending，等待用户审批。
          //
          // 场景 B：老记录（无 modificationStatuses 字段），用户曾做过局部接受/拒绝。
          //   - 磁盘内容 ≠ preAppliedContent（用户做了 reject 等操作，内容已偏离）
          //   - 此时需要推断来尽量还原用户的审批状态。
          const isFreshUnapproved =
            preAppliedContent !== undefined && contentForInference === preAppliedContent;

          if (isFreshUnapproved) {
            // SA 写入后用户未做任何操作：保持全部 pending
            finalModifications = batchResult.results;
            logger.trace('[diffStore]  未审批的新鲜 Diff（磁盘=SA写入版本），保持全部 pending');
          } else {
            // 老记录或用户已做过局部操作：使用启发式推断恢复状态
            finalModifications = inferModificationStatus(
              contentForInference,
              batchResult.results,
              content
            );
            logger.trace('[diffStore]  状态推断完成，使用内容长度:', contentForInference.length);
          }
        }
      }

      // 恢复时如果存在已拒绝的修改块，提前用 rebuildContentByDiff 重建内容
      // 必须在 set() 外完成，因为 Zustand set() 回调是同步的
      let rebuiltContent: string | null = null;
      if (isRestoring && persistedModStatuses && preAppliedContent) {
        const hasRejected = finalModifications.some((m) => m.status === 'rejected');
        if (hasRejected) {
          rebuiltContent = await rebuildContentByDiff(
            content,
            preAppliedContent,
            finalModifications
          );
          publishLatestLoadTarget(rebuiltContent);
          logger.trace('[diffStore]  恢复时检测到 rejected 块，已重建 content');
        }
      }

      // 状态推断/内容重建包含异步工作，最终写入 Zustand 前必须再次确认本次加载仍有效。
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace('[diffStore] loadModifications 在状态重建后已失效，停止提交');
        return;
      }

      // === Stale fileEntry 清理（非恢复模式）===
      //
      // 背景：用户手动删除工作目录文件后直接执行新任务，旧文件的 diff 条目
      // 仍保存在内存 fileEntries Map 中。loadModifications 的 set() 会原样
      // 复制 fileEntries 并追加新条目，导致 Diff 面板同时显示新旧两个文件的 tab。
      //
      // 在同步 set() 之前（异步安全区域），遍历当前 fileEntries，
      // 对非本次加载的文件做磁盘存在性探测，收集已不存在的 documentId。
      // set() 内部从 fileEntries 中移除这些 stale 条目。
      // 同时异步标记对应的 DB diff_record 为 reverted，防止重启后复现。
      const staleDocIds = new Set<string>();
      if (!isRestoring) {
        const currentCtx = get().diffByContext.get(contextId);
        if (currentCtx) {
          const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
          for (const [entryDocId] of currentCtx.fileEntries) {
            // 跳过本次正在加载的文件（即将被覆盖/更新）
            if (entryDocId === documentId) continue;
            // 跳过非磁盘路径
            if (!entryDocId.includes(':')) continue;
            try {
              await tauriInvoke<string>('file_read_content', { filePath: entryDocId });
            } catch {
              staleDocIds.add(entryDocId);
              logger.warn(`[diffStore] fileEntry 指向的文件已不存在，将移除: ${entryDocId}`);
            }
          }
          // 对 stale 文件的 DB 记录做精确清理（通过 contextId 查找 pending 记录）
          if (staleDocIds.size > 0) {
            try {
              const { invoke: tauriInvoke2 } = await import('@tauri-apps/api/core');
              interface StaleRecord {
                id: string;
                documentId: string;
              }
              const pendingRecords = await tauriInvoke2<StaleRecord[]>('diff_record_get_pending', {
                contextId,
              });
              for (const rec of pendingRecords) {
                if (staleDocIds.has(rec.documentId)) {
                  await tauriInvoke2('diff_record_update_status', {
                    id: rec.id,
                    status: 'reverted',
                  }).catch((e: unknown) =>
                    logger.warn('[diffStore] 标记 stale diff_record reverted 失败:', e)
                  );
                }
              }
            } catch (cleanupError) {
              logger.warn('[diffStore] stale diff_record DB 清理失败:', cleanupError);
            }
          }
        }
      }

      // stale 探测和 DB 清理同样会让出事件循环；这是最终状态提交前的竞态护栏。
      if (loadModificationsGeneration.get(generationKey) !== currentGen) {
        logger.trace('[diffStore] loadModifications 在最终提交前已失效，丢弃迟到结果');
        return;
      }

      const anotherLoadIsActive = hasActiveModificationLoadForContext(
        contextId,
        generationKey,
        currentGen
      );
      let initialContent = isRestoring
        ? (currentContentForInference ?? preAppliedContent ?? content)
        : (preAppliedContent ?? content);
      if (rebuiltContent !== null) {
        initialContent = rebuiltContent;
      }
      publishLatestLoadTarget(initialContent);
      set((state) => {
        const newMap = new Map(state.diffByContext);
        const ctx = newMap.get(contextId) ?? createEmptyContextState();
        // file_write 覆盖模式：ctx.content 初始化为 preAppliedContent（磁盘当前状态）
        // 无 preAppliedContent 时回退为原始内容
        // originalContent 始终保存原始内容用于回滚和状态推断
        // 多文件支持：保存当前活跃文件的状态到 fileEntries
        const newFileEntries = new Map(ctx.fileEntries);
        const currentEntry = extractFileDiffEntry(ctx);
        if (currentEntry) {
          newFileEntries.set(currentEntry.documentId, currentEntry);
        }

        // 移除 stale 条目（文件已从磁盘删除的旧 diff 条目）
        for (const staleId of staleDocIds) {
          newFileEntries.delete(staleId);
        }

        // 创建新文件的 FileDiffEntry
        const newEntry: FileDiffEntry = {
          documentId,
          fileName,
          content: initialContent,
          originalContent: content,
          pendingModifications: finalModifications,
          originalXml: xml,
          preAppliedContent: preAppliedContent ?? '',
          snapshots: [],
          undoStack: [],
          redoStack: [],
          activeSnapshotId: null,
        };
        newFileEntries.set(documentId, newEntry);

        newMap.set(contextId, {
          ...ctx,
          mode: 'diff',
          documentId,
          content: initialContent,
          originalContent: content,
          fileName,
          pendingModifications: finalModifications,
          originalXml: xml,
          isLoading: anotherLoadIsActive,
          undoStack: [],
          redoStack: [],
          preAppliedContent: preAppliedContent ?? '',
          fileEntries: newFileEntries,
          activeFileId: documentId,
          activeSnapshotId: null,
        });
        return { diffByContext: newMap, currentContextId: contextId };
      });

      // 加载历史快照
      void get().loadSnapshots(contextId, documentId);
    } catch (error) {
      // 记录 preview() 失败的详细信息，方便诊断（之前静默吞掉了错误）
      logger.error(
        `[diffStore] loadModifications 失败: contextId=${contextId}, doc=${documentId}, xmlLen=${xml.length}`,
        error
      );
      // 过期加载的异常不能覆盖更新加载或删除动作刚提交的状态。
      if (loadModificationsGeneration.get(generationKey) === currentGen) {
        const anotherLoadIsActive = hasActiveModificationLoadForContext(
          contextId,
          generationKey,
          currentGen
        );
        set((state) => {
          const newMap = new Map(state.diffByContext);
          const ctx = newMap.get(contextId) ?? createEmptyContextState();
          newMap.set(contextId, {
            ...ctx,
            isLoading: anotherLoadIsActive,
            error: error instanceof Error ? error.message : 'Failed to load modifications',
          });
          return { diffByContext: newMap };
        });
      }
    } finally {
      if (activeModificationLoadGenerations.get(generationKey) === currentGen) {
        activeModificationLoadGenerations.delete(generationKey);
      }
      if (latestModificationLoadTargets.get(generationKey)?.generation === currentGen) {
        latestModificationLoadTargets.delete(generationKey);
      }
    }
  },

  acceptModification: async (contextId, id) => {
    const ctx = get().getDiffState(contextId);
    const modIndex = ctx.pendingModifications.findIndex((m) => m.modificationId === id);
    if (modIndex === -1) return;

    const modResult = ctx.pendingModifications[modIndex];
    if (!modResult) return;

    try {
      const newContent = ctx.content;
      const contentBeforeApply = ctx.content;

      // file_write 覆盖模式：修改已经在 ctx.content 中（从 preAppliedContent 初始化）
      // accept = 保留当前内容，仅标记状态
      // 更新状态
      const updatedModifications = [...ctx.pendingModifications];
      updatedModifications[modIndex] = {
        ...modResult,
        status: 'applied',
        originalContent: contentBeforeApply,
      };

      // 推入 Undo 栈
      const description =
        modResult.modification.description ??
        `Accept changes: ${modResult.modification.operation} ${modResult.modification.file}`;
      const newUndoStack = [
        ...ctx.undoStack,
        {
          type: 'accept' as const,
          contentBefore: contentBeforeApply,
          contentAfter: newContent,
          modificationId: id,
          description,
          timestamp: Date.now(),
          pendingModificationsBefore: ctx.pendingModifications,
          pendingModificationsAfter: updatedModifications,
        },
      ];
      if (newUndoStack.length > MAX_HISTORY_DEPTH) {
        newUndoStack.shift();
      }

      set((state) => {
        const newMap = new Map(state.diffByContext);
        newMap.set(contextId, {
          ...ctx,
          pendingModifications: updatedModifications,
          content: newContent,
          undoStack: newUndoStack,
          redoStack: [],
        });
        return { diffByContext: newMap };
      });

      // 自动写入文件（与 acceptAll 相同，先读磁盘内容比对，避免 SA 已预写的情况丌适山覆写）
      if (ctx.documentId?.includes(':') === true) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');

          // Bug 修复：单条接受时同样需要检查磁盘内容，避免 SA 已预写的文件被 ctx.content 覆写
          let diskContent: string = newContent; // fallback：读取失败时 needsWrite=false
          try {
            diskContent = await invoke<string>('file_read_content', { filePath: ctx.documentId });
          } catch {
            logger.warn('[diffStore] acceptModification: 无法读取磁盘内容，将直接写入 ctx.content');
          }

          const needsWrite = diskContent !== newContent;
          if (needsWrite) {
            await invoke<{ success: boolean }>('file_write_to_path', {
              path: ctx.documentId,
              content: newContent,
              createBackup: false,
            });
            logger.trace('[diffStore]  文件已写入 (单条接受):', ctx.documentId);
          } else {
            logger.trace(
              '[diffStore]  acceptModification: 磁盘内容已是最新，跳过写入（SA 模式已预写）:',
              ctx.documentId
            );
          }

          // 创建 SQLite 快照（供历史版本面板显示）
          // 附带当时的修改块状态，用于回滚后精确恢复 diff 面板
          await fastApplyEngine
            .getSnapshotManager()
            .createSnapshot(
              ctx.documentId,
              needsWrite ? newContent : diskContent,
              `Accept changes: ${description}`,
              undefined,
              buildModificationStatusMap(updatedModifications)
            );

          // 获取最新快照并更新 active_snapshot_id 标记
          try {
            interface SnapshotData {
              id: string;
              documentId: string;
              content: string;
              description: string | null;
              createdAt: number;
            }
            const latestSnapshot = await invoke<SnapshotData | null>('snapshot_get_latest', {
              documentId: ctx.documentId,
            });
            if (latestSnapshot) {
              await invoke('diff_record_update_active_snapshot', {
                contextId,
                documentId: ctx.documentId,
                snapshotId: latestSnapshot.id,
              });
              logger.trace('[diffStore]  已更新 active_snapshot_id:', latestSnapshot.id);
            }
          } catch (snapshotError) {
            logger.warn('[diffStore]  更新快照标记失败:', snapshotError);
          }

          void get().loadSnapshots(contextId, ctx.documentId);
        } catch (writeError) {
          logger.error('[diffStore] 写入文件失败:', writeError);
        }
      }

      // 检查是否所有修改已审批完成
      const allReviewed = updatedModifications.every((m) => m.status !== 'pending');
      if (allReviewed) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          interface PersistedDiffRecord {
            id: string;
            contextId: string;
            documentId: string;
            status: string;
          }
          // Bug 修复：使用 filter 而非 find
          // 同一文件多次 file_write 会创建多条记录， find 只更新第一条，剩余记录重启后重新加载
          const diffRecords = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', {
            contextId,
          });
          const matchingRecords = diffRecords.filter(
            (r: PersistedDiffRecord) => r.documentId === ctx.documentId
          );
          await Promise.all(
            matchingRecords.map((record: PersistedDiffRecord) =>
              invoke('diff_record_update_status', { id: record.id, status: 'applied' })
            )
          );
          if (matchingRecords.length > 0) {
            logger.trace(
              `[diffStore] ✅ 所有修改已审批完成, ${matchingRecords.length} 条 diff_record 已更新为 applied, documentId:`,
              ctx.documentId
            );
          }
        } catch (statusError) {
          logger.warn('[diffStore] ⚠ 更新 diff_record 状态失败:', statusError);
        }

        // 全部审批完成：多文件感知切回 normal 模式
        // 与 acceptAll 相同的逻辑：检查其他文件是否还有 pending
        set((state) => {
          const newMap = new Map(state.diffByContext);
          const current = newMap.get(contextId) ?? createEmptyContextState();
          const newFileEntries = new Map(current.fileEntries);

          // 将当前文件已完成状态存回 fileEntries
          if (current.documentId) {
            const existingEntry = newFileEntries.get(current.documentId);
            if (existingEntry) {
              newFileEntries.set(current.documentId, {
                ...existingEntry,
                pendingModifications: updatedModifications,
              });
            }
          }

          // 查找其他文件中是否还有 pending 修改
          const nextPendingEntry = Array.from(newFileEntries.values()).find(
            (e) =>
              e.documentId !== current.documentId &&
              e.pendingModifications.some((m) => m.status === 'pending')
          );

          if (nextPendingEntry) {
            // 还有其他文件待审批，切换到它
            newMap.set(
              contextId,
              applyFileDiffEntry({ ...current, fileEntries: newFileEntries }, nextPendingEntry)
            );
          } else {
            // 所有文件已完成，切回 normal 模式
            newMap.set(contextId, {
              ...current,
              mode: 'normal',
              fileEntries: newFileEntries,
              pendingModifications: updatedModifications,
            });
          }

          return { diffByContext: newMap };
        });
      } else if (ctx.documentId) {
        // 部分审批：持久化每块的当前状态，确保重启后精确恢复
        await persistModificationStatuses(contextId, ctx.documentId, updatedModifications);
      }
    } catch (error) {
      logger.error('接受修改失败:', error);
    }
  },

  rejectModification: async (contextId, id) => {
    const ctx = get().getDiffState(contextId);
    const modIndex = ctx.pendingModifications.findIndex((m) => m.modificationId === id);
    if (modIndex === -1) return;

    const modResult = ctx.pendingModifications[modIndex];
    if (!modResult) return;

    // 构建更新后的修改列表
    const updatedModifications = [...ctx.pendingModifications];
    updatedModifications[modIndex] = {
      ...modResult,
      status: 'rejected' as const,
    };

    let newContent = ctx.content;
    const contentBeforeReject = ctx.content;

    // file_write 覆盖模式：通过行级 diff 重建——对比 originalContent 和 preAppliedContent
    // 找到实际变更范围，根据修改状态决定恢复或保持
    newContent = await rebuildContentByDiff(
      ctx.originalContent,
      ctx.preAppliedContent,
      updatedModifications
    );
    logger.trace('[diffStore] ✅ reject: diff 重建完成');

    // 推入 Undo 栈
    const description =
      modResult.modification.description ??
      `Reject changes: ${modResult.modification.operation} ${modResult.modification.file}`;
    const newUndoStack = [
      ...ctx.undoStack,
      {
        type: 'reject' as const,
        contentBefore: contentBeforeReject,
        contentAfter: newContent,
        modificationId: id,
        description,
        timestamp: Date.now(),
        pendingModificationsBefore: ctx.pendingModifications,
        pendingModificationsAfter: updatedModifications,
      },
    ];
    if (newUndoStack.length > MAX_HISTORY_DEPTH) {
      newUndoStack.shift();
    }

    set((state) => {
      const newMap = new Map(state.diffByContext);
      newMap.set(contextId, {
        ...ctx,
        pendingModifications: updatedModifications,
        content: newContent,
        undoStack: newUndoStack,
        redoStack: [],
      });
      return { diffByContext: newMap };
    });

    // reject 后内容已变更，立即写磁盘
    if (ctx.documentId?.includes(':') === true) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<{ success: boolean }>('file_write_to_path', {
          path: ctx.documentId,
          content: newContent,
          createBackup: false,
        });
        logger.trace('[diffStore] ✅ rejectModification: 反向应用已写入磁盘');

        // 创建 SQLite 快照（附带当时的修改块状态，用于回滚后精确恢复 diff 面板）
        await fastApplyEngine
          .getSnapshotManager()
          .createSnapshot(
            ctx.documentId,
            newContent,
            description,
            undefined,
            buildModificationStatusMap(updatedModifications)
          );

        // 更新 active_snapshot_id
        try {
          interface SnapshotData {
            id: string;
            documentId: string;
            content: string;
            description: string | null;
            createdAt: number;
          }
          const latestSnapshot = await invoke<SnapshotData | null>('snapshot_get_latest', {
            documentId: ctx.documentId,
          });
          if (latestSnapshot) {
            await invoke('diff_record_update_active_snapshot', {
              contextId,
              documentId: ctx.documentId,
              snapshotId: latestSnapshot.id,
            });
          }
        } catch (snapshotError) {
          logger.warn('[diffStore] ⚠ 更新快照标记失败:', snapshotError);
        }

        void get().loadSnapshots(contextId, ctx.documentId);
      } catch (writeError) {
        logger.error('[diffStore] rejectModification 写入文件失败:', writeError);
      }
    }

    // 检查是否所有修改都已审批完成
    const allReviewed = updatedModifications.every((m) => m.status !== 'pending');
    if (allReviewed) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        interface PersistedDiffRecord {
          id: string;
          contextId: string;
          documentId: string;
          status: string;
        }
        const diffRecords = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', {
          contextId,
        });
        // 按 documentId 精确匹配当前文件的记录，避免影响其他文件
        const currentFileRecord = diffRecords.find((r) => r.documentId === ctx.documentId);
        if (currentFileRecord) {
          await invoke('diff_record_update_status', {
            id: currentFileRecord.id,
            status: 'applied',
          });
          logger.trace(
            '[diffStore] ✅ diff_record 状态已更新为 applied, documentId:',
            ctx.documentId
          );
        }
      } catch (statusError) {
        logger.warn('[diffStore] ⚠ 更新 diff_record 状态失败:', statusError);
      }
    } else if (ctx.documentId) {
      // 部分审批：持久化每块的当前状态，确保重启后精确恢复
      await persistModificationStatuses(contextId, ctx.documentId, updatedModifications);
    }
  },

  undoModification: async (contextId, id) => {
    const ctx = get().getDiffState(contextId);
    const modIndex = ctx.pendingModifications.findIndex((m) => m.modificationId === id);
    if (modIndex === -1) return;

    const modResult = ctx.pendingModifications[modIndex];
    if (!modResult) return;

    // 只有已应用的修改才需要文件回滚
    if (modResult.status === 'applied' && modResult.originalContent) {
      try {
        // 回滚文件内容
        if (ctx.documentId?.includes(':') === true) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke<{ success: boolean }>('file_write_to_path', {
            path: ctx.documentId,
            content: modResult.originalContent,
            createBackup: false,
          });
          logger.trace('[diffStore] 文件已回滚:', ctx.documentId);
        }

        // 更新状态
        const updatedModifications = [...ctx.pendingModifications];
        updatedModifications[modIndex] = {
          ...modResult,
          status: 'pending',
        };

        set((state) => {
          const newMap = new Map(state.diffByContext);
          newMap.set(contextId, {
            ...ctx,
            pendingModifications: updatedModifications,
            content: modResult.originalContent ?? ctx.content,
          });
          return { diffByContext: newMap };
        });
      } catch (error) {
        logger.error('[diffStore] 撤销失败:', error);
      }
    } else {
      // 未应用的修改只需重置状态
      set((state) => {
        const newMap = new Map(state.diffByContext);
        const ctx = newMap.get(contextId) ?? createEmptyContextState();
        newMap.set(contextId, {
          ...ctx,
          pendingModifications: ctx.pendingModifications.map((m) =>
            m.modificationId === id ? { ...m, status: 'pending' as const } : m
          ),
        });
        return { diffByContext: newMap };
      });
    }
  },

  acceptAll: async (contextId) => {
    const ctx = get().getDiffState(contextId);
    const pendingMods = ctx.pendingModifications.filter((m) => m.status === 'pending');

    set((state) => {
      const newMap = new Map(state.diffByContext);
      const current = newMap.get(contextId) ?? createEmptyContextState();
      newMap.set(contextId, { ...current, isLoading: true });
      return { diffByContext: newMap };
    });

    // 应用所有 pending 修改
    const currentContent = ctx.content;
    const updatedModifications = [...ctx.pendingModifications];

    // file_write 覆盖模式：修改已在 ctx.content 中（从 preAppliedContent 初始化）
    // accept = 保留，仅标记状态
    for (const mod of pendingMods) {
      const modIndex = updatedModifications.findIndex(
        (m) => m.modificationId === mod.modificationId
      );
      updatedModifications[modIndex] = {
        ...mod,
        status: 'applied',
      };
    }
    // currentContent 保持不变（preAppliedContent 中已包含所有修改）

    // 将当前文件的已应用状态存回 fileEntries，并决出模式切换策略
    //
    // 多文件场景下：
    //   - mode 是 context 层级状态，忠断切回 normal 会让其它文件的 diff 也消失
    //   - 应该检查其他文件是否还有 pending 修改：
    //     有 pending 的文件 → 切换到该文件，继续审批
    //     全部完成   → 切回 normal 模式，diff 面板消失
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const current = newMap.get(contextId) ?? createEmptyContextState();

      // 将当前文件山熟应用状态存回 fileEntries
      const newFileEntries = new Map(current.fileEntries);
      if (current.documentId) {
        newFileEntries.set(current.documentId, {
          documentId: current.documentId,
          fileName: current.fileName,
          content: currentContent,
          originalContent: current.originalContent,
          pendingModifications: updatedModifications,
          originalXml: current.originalXml,
          preAppliedContent: current.preAppliedContent,
          snapshots: current.snapshots,
          undoStack: current.undoStack,
          redoStack: current.redoStack,
          activeSnapshotId: current.activeSnapshotId,
        });
      }

      // 查找其他文件中是否还有 pending 修改
      const nextPendingEntry = Array.from(newFileEntries.values()).find(
        (entry) =>
          entry.documentId !== current.documentId &&
          entry.pendingModifications.some((m) => m.status === 'pending')
      );

      if (nextPendingEntry) {
        // 还有其他文件待审批，切换到它，保持 diff 模式
        newMap.set(
          contextId,
          applyFileDiffEntry(
            {
              ...current,
              fileEntries: newFileEntries,
              pendingModifications: updatedModifications,
              content: currentContent,
              isLoading: false,
            },
            nextPendingEntry
          )
        );
      } else {
        // 全部完成——切回 normal 模式，diff 面板消失
        newMap.set(contextId, {
          ...current,
          mode: 'normal',
          fileEntries: newFileEntries,
          pendingModifications: updatedModifications,
          content: currentContent,
          isLoading: false,
        });
      }

      return { diffByContext: newMap };
    });

    // 自动写入文件 + 同步更新 diff_record 状态
    //
    // acceptAll 不应无条件写入 ctx.content（preAppliedContent）到磁盘。
    //
    // SA 模式（file_write_overwrite / file_write_merge）：
    //   工具执行时已将 LLM 内容写入磁盘。若同一 SA 还写过更新的内容（两次 file_write），
    //   ctx.content 将是第一次的旧内容，直接写入会将磁盘上青新内容回退（正是用户所见 6 行覆掉 21 行的根因）。
    //
    // 非 SA 模式（file_edit requiresInteraction=true）：
    //   工具返回后文件尚未写入，acceptAll 必须写入。
    //
    // 先读磁盘内容，若与 ctx.content 相同则跳过写入（SA no-op）；
    // 不同则执行写入（非 SA edit-tool 路径）。
    if (ctx.documentId?.includes(':') === true) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // 读取磁盘当前内容，与 ctx.content 比对
        let diskContent: string = currentContent; // fallback：读取失败时 needsWrite=false，安全跳过
        try {
          // 注意：Rust 命令参数名为 filePath，不是 path
          diskContent = await invoke<string>('file_read_content', { filePath: ctx.documentId });
        } catch {
          logger.warn(
            '[diffStore] acceptAll: 无法读取磁盘内容（file_read_content 失败），将直接写入 ctx.content'
          );
        }

        // 判断是否需要写入：
        // - SA 模式下磁盘内容已是 LLM 写入的结果，ctx.content === diskContent → 跳过
        // - 非 SA 模式（edit tool）磁盘内容仍是原始文件，ctx.content ≠ diskContent → 需要写入
        const needsWrite = diskContent !== currentContent;
        if (needsWrite) {
          await invoke<{ success: boolean }>('file_write_to_path', {
            path: ctx.documentId,
            content: currentContent,
            createBackup: false,
          });
          logger.trace('[diffStore]  文件已写入（非 SA edit-tool 路径）:', ctx.documentId);
        } else {
          logger.trace(
            '[diffStore]  acceptAll: 磁盘内容已是最新，跳过写入（SA 模式已预写）:',
            ctx.documentId
          );
        }

        // 快照内容取磁盘最终状态（SA 已预写则取磁盘，非 SA 则取刚写入的 currentContent）
        const snapshotContent = needsWrite ? currentContent : diskContent;

        // 创建 SQLite 快照（附带当时的修改块状态）
        // 使用提前保存的 pendingMods.length，而非旧快照 ctx 中的过期 filter 结果
        await fastApplyEngine
          .getSnapshotManager()
          .createSnapshot(
            ctx.documentId,
            snapshotContent,
            `Accept all (applied ${pendingMods.length} changes)`,
            undefined,
            buildModificationStatusMap(updatedModifications)
          );

        // 写入成功后立即更新 diff_record 状态，在同一 try 块内保证原子性
        // 避免“写入成功 + 状态更新失败”导致重启后重显 diff 面板
        interface PersistedDiffRecord {
          id: string;
          contextId: string;
          documentId: string;
          status: string;
        }
        // 更新该文件所有 pending 的 diff_record 为 applied
        // 使用 filter 而非 find：同一文件多次 file_write 会创建多条记录，
        // 只更新第一条会导致其他记录重启后重新加载（截图显示两条不同 diff 的根因）
        const diffRecords = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', {
          contextId,
        });
        const matchingRecords = diffRecords.filter(
          (r: PersistedDiffRecord) => r.documentId === ctx.documentId
        );
        await Promise.all(
          matchingRecords.map((record: PersistedDiffRecord) =>
            invoke('diff_record_update_status', {
              id: record.id,
              status: 'applied',
            })
          )
        );
        if (matchingRecords.length > 0) {
          logger.trace(
            `[diffStore] ✅ acceptAll: ${matchingRecords.length} 条 diff_record 已更新为 applied, documentId:`,
            ctx.documentId
          );
        }

        void get().loadSnapshots(contextId, ctx.documentId);
      } catch (error) {
        logger.error('[diffStore] 写入文件失败:', error);
      }
    }
  },

  rejectAll: async (contextId) => {
    const ctx = get().getDiffState(contextId);

    // 构建更新后的修改列表
    const updatedModifications = ctx.pendingModifications.map((m) =>
      m.status === 'pending' ? { ...m, status: 'rejected' as const } : m
    );

    // rejectAll = 恢复到 originalContent（撤除所有修改）
    const contentAfterRejectAll = ctx.originalContent;

    // 推入 Undo 栈
    const newUndoStack = [
      ...ctx.undoStack,
      {
        type: 'reject' as const,
        contentBefore: ctx.content,
        contentAfter: contentAfterRejectAll,
        description: 'Reject all',
        timestamp: Date.now(),
        pendingModificationsBefore: ctx.pendingModifications,
        pendingModificationsAfter: updatedModifications,
      },
    ];
    if (newUndoStack.length > MAX_HISTORY_DEPTH) {
      newUndoStack.shift();
    }

    set((state) => {
      const newMap = new Map(state.diffByContext);
      newMap.set(contextId, {
        ...ctx,
        pendingModifications: updatedModifications,
        content: contentAfterRejectAll,
        undoStack: newUndoStack,
        redoStack: [],
      });
      return { diffByContext: newMap };
    });

    // 写入 originalContent 到磁盘（恢复到 LLM 修改前）
    if (ctx.documentId?.includes(':') === true) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<{ success: boolean }>('file_write_to_path', {
          path: ctx.documentId,
          content: contentAfterRejectAll,
          createBackup: false,
        });
        logger.trace('[diffStore] ✅ rejectAll: 文件已恢复为原始内容:', ctx.documentId);

        // 创建 SQLite 快照（附带当时的修改块状态，用于回滚后精确恢复 diff 面板）
        await fastApplyEngine
          .getSnapshotManager()
          .createSnapshot(
            ctx.documentId,
            contentAfterRejectAll,
            `Reject all (restore original content)`,
            undefined,
            buildModificationStatusMap(updatedModifications)
          );

        // 更新 active_snapshot_id
        try {
          interface SnapshotData {
            id: string;
            documentId: string;
            content: string;
            description: string | null;
            createdAt: number;
          }
          const latestSnapshot = await invoke<SnapshotData | null>('snapshot_get_latest', {
            documentId: ctx.documentId,
          });
          if (latestSnapshot) {
            await invoke('diff_record_update_active_snapshot', {
              contextId,
              documentId: ctx.documentId,
              snapshotId: latestSnapshot.id,
            });
          }
        } catch (snapshotError) {
          logger.warn('[diffStore] ⚠ 更新快照标记失败:', snapshotError);
        }

        void get().loadSnapshots(contextId, ctx.documentId);
      } catch (writeError) {
        logger.error('[diffStore] rejectAll 回写文件失败:', writeError);
      }
    }

    // 全部拒绝后，更新 diff_record 状态为 applied（审批已完成）
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      interface PersistedDiffRecord {
        id: string;
        contextId: string;
        documentId: string;
        status: string;
      }
      const diffRecords = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', {
        contextId,
      });
      // 按 documentId 精确匹配当前文件的记录，避免影响其他文件
      const currentFileRecord = diffRecords.find((r) => r.documentId === ctx.documentId);
      if (currentFileRecord) {
        await invoke('diff_record_update_status', {
          id: currentFileRecord.id,
          status: 'applied',
        });
        logger.trace(
          '[diffStore] ✅ rejectAll: diff_record 状态已更新为 applied, documentId:',
          ctx.documentId
        );
      }
    } catch (statusError) {
      logger.warn('[diffStore] ⚠ 更新 diff_record 状态失败:', statusError);
    }
  },

  skipModification: (contextId, id) => {
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const ctx = newMap.get(contextId) ?? createEmptyContextState();
      newMap.set(contextId, {
        ...ctx,
        pendingModifications: ctx.pendingModifications.map((m) =>
          m.modificationId === id ? { ...m, status: 'rejected' as const } : m
        ),
      });
      return { diffByContext: newMap };
    });
  },

  // ==================== 多文件操作 ====================

  selectFile: (contextId, documentId) => {
    const ctx = get().getDiffState(contextId);
    const targetEntry = ctx.fileEntries.get(documentId);
    if (!targetEntry) {
      logger.warn('[diffStore] selectFile: 目标文件不存在:', documentId);
      return;
    }

    set((state) => {
      const newMap = new Map(state.diffByContext);
      const currentCtx = newMap.get(contextId) ?? createEmptyContextState();

      // 保存当前活跃文件的状态到 fileEntries
      const newFileEntries = new Map(currentCtx.fileEntries);
      const currentEntry = extractFileDiffEntry(currentCtx);
      if (currentEntry) {
        newFileEntries.set(currentEntry.documentId, currentEntry);
      }

      // 将目标文件的状态恢复到顶层字段
      const updatedCtx = applyFileDiffEntry(
        { ...currentCtx, fileEntries: newFileEntries },
        targetEntry
      );
      newMap.set(contextId, updatedCtx);
      return { diffByContext: newMap };
    });

    logger.trace('[diffStore] selectFile: 已切换到文件:', documentId);

    // 切换后重新加载目标文件的快照列表，确保数据最新
    void get().loadSnapshots(contextId, documentId);
  },

  getFileList: (contextId) => {
    const ctx = get().getDiffState(contextId);
    const result: Array<{ documentId: string; fileName: string; pendingCount: number }> = [];

    for (const [docId, entry] of ctx.fileEntries) {
      // 若是当前活跃文件，使用顶层字段的最新数据
      const mods =
        docId === ctx.activeFileId ? ctx.pendingModifications : entry.pendingModifications;
      const pendingCount = mods.filter((m) => m.status === 'pending').length;

      // 只返回有 pending 修改的文件；
      // 已全部审批完成的文件不再展示在 Tab 栏中，
      // 避免手动切回 diff 模式时残留已完成文件的错误还示
      if (pendingCount > 0) {
        result.push({ documentId: docId, fileName: entry.fileName, pendingCount });
      }
    }

    return result;
  },

  syncActiveFileToEntries: (contextId) => {
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const ctx = newMap.get(contextId) ?? createEmptyContextState();
      const currentEntry = extractFileDiffEntry(ctx);
      if (currentEntry) {
        const newFileEntries = new Map(ctx.fileEntries);
        newFileEntries.set(currentEntry.documentId, currentEntry);
        newMap.set(contextId, { ...ctx, fileEntries: newFileEntries });
      }
      return { diffByContext: newMap };
    });
  },

  discardDiffsForDeletedPath: async (contextId, deletedPath, isDirectory) => {
    // 必须先取消迟到的 preview，再同步移除内存状态；二者都发生在首次 await 之前。
    const deletedAt = Date.now();
    markDeletedPath(contextId, deletedPath, isDirectory);
    const invalidatedActiveLoad = invalidateModificationLoads(contextId, deletedPath, isDirectory);
    const anotherLoadIsActive = Array.from(activeModificationLoadGenerations.keys()).some(
      (generationKey) => {
        const contextPrefix = `${contextId}::`;
        if (!generationKey.startsWith(contextPrefix)) return false;
        const documentId = generationKey.slice(contextPrefix.length);
        return !isPathDeleted(documentId, deletedPath, isDirectory);
      }
    );

    set((state) => {
      const ctx = state.diffByContext.get(contextId);
      if (!ctx) return { diffByContext: state.diffByContext };

      // fileEntries 中的活跃条目可能落后于顶层镜像，先用最新顶层状态覆盖再筛除。
      const newFileEntries = new Map(ctx.fileEntries);
      const currentEntry = extractFileDiffEntry(ctx);
      if (currentEntry) {
        newFileEntries.set(currentEntry.documentId, currentEntry);
      }

      let removedEntry = false;
      for (const documentId of newFileEntries.keys()) {
        if (isPathDeleted(documentId, deletedPath, isDirectory)) {
          newFileEntries.delete(documentId);
          removedEntry = true;
        }
      }

      const activeWasDeleted = [ctx.documentId, ctx.activeFileId].some(
        (documentId) => documentId !== null && isPathDeleted(documentId, deletedPath, isDirectory)
      );
      if (!removedEntry && !activeWasDeleted) {
        if (!invalidatedActiveLoad) return { diffByContext: state.diffByContext };
        const newMap = new Map(state.diffByContext);
        newMap.set(contextId, { ...ctx, isLoading: anotherLoadIsActive });
        return { diffByContext: newMap };
      }

      const newMap = new Map(state.diffByContext);
      if (!activeWasDeleted) {
        // 删除的是非活跃文件：只更新条目集合，不扰动当前审批/Undo/Redo 状态。
        newMap.set(contextId, {
          ...ctx,
          fileEntries: newFileEntries,
          isLoading: invalidatedActiveLoad ? anotherLoadIsActive : ctx.isLoading,
        });
        return { diffByContext: newMap };
      }

      const nextPendingEntry = Array.from(newFileEntries.values()).find((entry) =>
        entry.pendingModifications.some((modification) => modification.status === 'pending')
      );

      if (nextPendingEntry) {
        const nextContext = applyFileDiffEntry(
          { ...ctx, fileEntries: newFileEntries },
          nextPendingEntry
        );
        newMap.set(contextId, {
          ...nextContext,
          // activeSnapshotId 属于刚删除的文件；目标文件的快照会由 select/load 流程刷新。
          activeSnapshotId: null,
          isLoading: anotherLoadIsActive,
          error: null,
        });
      } else {
        // 没有剩余待审批文件时清空顶层镜像；已完成文件仍保留在 fileEntries 供历史访问。
        newMap.set(contextId, {
          ...createEmptyContextState(),
          fileEntries: newFileEntries,
          isLoading: anotherLoadIsActive,
        });
      }

      return {
        diffByContext: newMap,
        // 快照面板若仍指向已删除的活跃文件，也应一并关闭。
        isSnapshotPanelOpen: false,
      };
    });

    // 内存状态已同步完成；持久化清理为 best-effort，失败不应让已删除文件重新出现在 UI。
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      interface PendingDiffRecord {
        id: string;
        documentId: string;
        createdAt?: number;
      }
      const pendingRecords = await invoke<PendingDiffRecord[]>('diff_record_get_pending', {
        contextId,
      });
      const matchingRecords = pendingRecords.filter(
        (record) =>
          isPathDeleted(record.documentId, deletedPath, isDirectory) &&
          (record.createdAt === undefined || record.createdAt < deletedAt)
      );

      await Promise.all(
        matchingRecords.map(async (record) => {
          try {
            await invoke('diff_record_update_status', {
              id: record.id,
              status: 'reverted',
            });
          } catch (statusError) {
            logger.warn('[diffStore] 删除路径的 Diff 记录标记 reverted 失败:', statusError);
          }
        })
      );
    } catch (cleanupError) {
      logger.warn('[diffStore] 删除路径的 pending Diff 持久化清理失败:', cleanupError);
    }
  },

  // ==================== 快照操作 ====================

  loadSnapshots: async (contextId, documentId) => {
    try {
      const snapshots = await fastApplyEngine.listSnapshots(documentId);
      set((state) => {
        const newMap = new Map(state.diffByContext);
        const ctx = newMap.get(contextId) ?? createEmptyContextState();

        // 多文件场景：异步回调时需判断当前活跃文件是否仍是请求的 documentId
        // 如果不匹配，将快照写入对应 fileEntries 而非顶层（避免快照错位）
        if (ctx.activeFileId === documentId || !ctx.activeFileId) {
          // 目标文件是当前活跃文件，直接更新顶层 snapshots
          newMap.set(contextId, { ...ctx, snapshots });
        } else {
          // 目标文件已不是活跃文件，更新 fileEntries 中对应文件的 snapshots
          const newFileEntries = new Map(ctx.fileEntries);
          const entry = newFileEntries.get(documentId);
          if (entry) {
            newFileEntries.set(documentId, { ...entry, snapshots });
            newMap.set(contextId, { ...ctx, fileEntries: newFileEntries });
          }
          // 如果 entry 不存在则忽略（可能已被清除）
        }

        return { diffByContext: newMap };
      });
    } catch (error) {
      logger.error('加载快照失败:', error);
    }
  },

  rollback: async (contextId, snapshotId) => {
    const ctx = get().getDiffState(contextId);
    const contentBefore = ctx.content;
    const rollbackDocumentId = ctx.documentId;
    const rollbackKey = `${contextId}::${rollbackDocumentId ?? ''}`;
    const modificationGenerationAtStart = loadModificationsGeneration.get(rollbackKey);
    if (activeModificationLoadGenerations.has(rollbackKey)) {
      logger.trace('[diffStore] 同路径 Diff 正在加载，跳过历史回滚:', rollbackDocumentId);
      return contentBefore;
    }
    const rollbackGeneration = (snapshotRollbackGenerations.get(rollbackKey) ?? 0) + 1;
    snapshotRollbackGenerations.set(rollbackKey, rollbackGeneration);
    const remainsAtRollbackSource = (currentCtx: ContextDiffState | undefined) =>
      currentCtx?.documentId === rollbackDocumentId &&
      currentCtx.activeFileId === ctx.activeFileId &&
      currentCtx.content === contentBefore &&
      currentCtx.originalContent === ctx.originalContent &&
      currentCtx.originalXml === ctx.originalXml &&
      currentCtx.pendingModifications === ctx.pendingModifications;
    const isRollbackCurrent = () =>
      snapshotRollbackGenerations.get(rollbackKey) === rollbackGeneration &&
      loadModificationsGeneration.get(rollbackKey) === modificationGenerationAtStart &&
      !activeModificationLoadGenerations.has(rollbackKey) &&
      remainsAtRollbackSource(get().diffByContext.get(contextId));

    const content = await fastApplyEngine.rollback(snapshotId);
    if (!isRollbackCurrent()) {
      logger.trace('[diffStore] 回滚内容返回时操作已失效，跳过迟到结果:', snapshotId);
      return content;
    }

    // 回滚后重新 preview，刷新 matchResult / diff hunks（行号、内容定位）
    //
    // === 基于快照内容动态生成 preview XML ===
    //
    // 1. 优先匹配目标快照当时的源 Diff 记录，复用其 originalContent + XML
    // 2. 源记录不可用时，使用历史列表中的相邻前一版本作为基准
    // 3. 动态生成 wholeFileReplace XML（baseContent → targetContent）
    // 4. 用同一组基准、XML 和 matchResult 原子刷新 Diff 面板
    //
    // 边界处理：
    // - 目标版本是原始文件版本（content === baseContent）→ 产出空 diff，面板无块（语义正确）
    // - ctx.snapshots 为空或找不到快照 → 以当前 Diff 基准动态生成整文件投影
    // - 重启后：快照内容持久化于 DB，ctx.snapshots 由 loadSnapshots 加载，方案仍有效
    let refreshedModifications = ctx.pendingModifications;
    // 确定 preview 使用的基准内容和 XML
    // 默认基准用于快照列表不完整时的整文件投影。
    let previewBaseContent = ctx.originalContent;
    let previewXml = '';
    let usesSnapshotProjection = false;
    // 目标快照（用于恢复 modificationStatuses）
    const targetSnapshot = ctx.snapshots.find((s) => s.id === snapshotId);
    const baseSnapshot = findSnapshotPreviewBase(ctx.snapshots, targetSnapshot);
    let sourceRecordStatuses: Record<string, string> | undefined;
    let sourceRecordMatched = false;

    // Post-write 快照可由当时的 diff_record.modifiedContent 精确反查源记录。
    // 命中时沿用该轮 originalContent + XML，回滚后的行号与实时 Diff 完全同基准；
    // 旧记录缺失或已清理时再退回快照内容重建。
    if (ctx.documentId) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const records = await invoke<SnapshotSourceRecord[]>('diff_record_get_pending', {
          contextId,
        });
        if (!isRollbackCurrent()) return content;
        const sourceRecord = findUniqueSnapshotSourceRecord(
          records,
          ctx.documentId,
          content,
          '手工回滚'
        );
        if (sourceRecord?.xmlModification) {
          previewBaseContent = sourceRecord.originalContent;
          previewXml = sourceRecord.xmlModification;
          sourceRecordStatuses = parseModificationStatuses(
            sourceRecord.modificationStatuses ?? undefined,
            '手工回滚源 Diff'
          );
          sourceRecordMatched = true;
          logger.trace('[diffStore] 回滚 preview：已匹配目标快照的源 Diff 记录');
        }
      } catch (sourceLookupError) {
        logger.warn(
          '[diffStore] 回滚 preview：源 Diff 查询失败，使用快照内容兜底:',
          sourceLookupError
        );
      }
    }

    if (!sourceRecordMatched) {
      try {
        const fallbackBaseContent = baseSnapshot?.content ?? ctx.originalContent;
        // 动态生成"baseContent → targetContent"的整文件替换 XML
        // 避免 diffToXml 在重复内容中拆出不稳定的重叠修改块。
        const { generateWholeFileReplaceXml } =
          await import('../services/fast-apply/DiffToXmlConverter');
        if (!isRollbackCurrent()) return content;
        previewXml = generateWholeFileReplaceXml(fallbackBaseContent, content);
        previewBaseContent = fallbackBaseContent;
        usesSnapshotProjection = true;
        logger.trace(
          `[diffStore] 回滚 preview：使用动态 XML（base=${fallbackBaseContent.length}字符, target=${content.length}字符）`
        );
      } catch (xmlGenError) {
        // 尚未写盘，直接终止比提交旧 XML + 新内容的错位投影更安全。
        logger.error('[diffStore] 回滚 XML 生成失败，终止回滚:', xmlGenError);
        throw xmlGenError;
      }
    }

    // 特殊情况：目标版本内容与基准内容相同（即原始文件版本）
    // 此时无任何 diff，直接清空修改块列表，避免后续 preview 生成空 diff 占位修改块
    // 用户回滚到原始文件版本，期望看到"无任何待审批改动"，而非空 diff 的伪修改块
    if (content === previewBaseContent) {
      refreshedModifications = [];
      logger.trace('[diffStore] 回滚：目标版本内容与基准相同（原始文件版本），清空修改块');
    } else if (previewXml) {
      try {
        const batchResult = await measureRendererWorkAsync(
          'diffStore.rollback.preview',
          {
            contentChars: previewBaseContent.length,
            contentLines: countTextLines(previewBaseContent),
            xmlChars: previewXml.length,
            hasTargetSnapshot: Boolean(targetSnapshot),
          },
          () => fastApplyEngine.preview(rollbackDocumentId ?? '', previewBaseContent, previewXml)
        );
        if (!isRollbackCurrent()) {
          logger.trace('[diffStore] 回滚 preview 返回时操作已失效，跳过迟到结果:', snapshotId);
          return content;
        }

        const compatibleStatuses = sourceRecordMatched
          ? (targetSnapshot?.modificationStatuses ?? sourceRecordStatuses)
          : undefined;
        if (compatibleStatuses) {
          refreshedModifications = applyCompatibleModificationStatuses(
            batchResult.results,
            compatibleStatuses,
            '手工回滚'
          );
          logger.trace(
            `[diffStore] 回滚后恢复兼容的快照状态：${JSON.stringify(compatibleStatuses)}`
          );
        } else if (sourceRecordMatched || usesSnapshotProjection) {
          // 动态整文件块与回滚前的旧分块没有稳定索引关系，保持 preview 默认 pending。
          refreshedModifications = resetGeneratedProjectionStatuses(batchResult.results);
          logger.trace('[diffStore] 回滚动态投影无兼容状态，保持修改块 pending');
        } else {
          // 兜底路径：快照无状态数据（旧版本快照）→ 使用内容推断 + 状态继承
          // 继承原有的用户已审批状态（已接受/已拒绝的块保持不变）
          refreshedModifications = batchResult.results.map((newMod, idx) => {
            const oldMod = ctx.pendingModifications[idx];
            const inheritedStatus =
              oldMod?.status === 'applied' || oldMod?.status === 'rejected'
                ? oldMod.status
                : newMod.status;
            return { ...newMod, status: inheritedStatus };
          });
          logger.trace('[diffStore] 回滚兜底：快照无状态数据，使用状态继承');
        }

        logger.trace(
          `[diffStore] 回滚后重新 preview 完成：${refreshedModifications.length} 个修改`
        );
      } catch (previewError) {
        // preview 失败时尚未写盘；终止操作可同时保住磁盘内容和旧投影的一致性。
        logger.error('[diffStore] 回滚后重新 preview 失败，终止回滚:', previewError);
        throw previewError;
      }
    }

    // preview 成功后才写盘，缩短有副作用的竞态窗口。若写盘期间有更新操作接管，
    // 立即把该文档的最新内存内容补写回去，避免旧回滚覆盖新 Diff 的磁盘状态。
    if (!isRollbackCurrent()) return content;
    if (rollbackDocumentId?.includes(':') === true) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke<{ success: boolean }>('file_write_to_path', {
          path: rollbackDocumentId,
          content,
          createBackup: false,
        });
        logger.trace('[diffStore] 文件已回滚到快照:', snapshotId);
      } catch (writeError) {
        logger.error('[diffStore] 回滚写入文件失败:', writeError);
        throw writeError;
      }

      if (!isRollbackCurrent()) {
        try {
          await compensateSupersededFileWrite(
            contextId,
            rollbackDocumentId,
            rollbackKey,
            modificationGenerationAtStart,
            () => get().diffByContext.get(contextId),
            async (supersedingContent) => {
              await invoke('file_write_to_path', {
                path: rollbackDocumentId,
                content: supersedingContent,
                createBackup: false,
              });
            }
          );
        } catch (compensationError) {
          logger.error('[diffStore] 迟到回滚的磁盘补偿写入失败:', compensationError);
        }
        logger.trace('[diffStore] 回滚写盘期间操作已失效，跳过状态提交:', snapshotId);
        return content;
      }
    }

    const projectionBefore: DiffProjectionState = {
      baseContent: ctx.originalContent,
      targetContent: ctx.content,
      preAppliedContent: ctx.preAppliedContent,
      xml: ctx.originalXml,
      modifications: ctx.pendingModifications,
      activeSnapshotId: ctx.activeSnapshotId,
      mode: ctx.mode,
    };
    if (!isRollbackCurrent()) return content;
    set((state) => {
      const newMap = new Map(state.diffByContext);
      const currentCtx = newMap.get(contextId);
      const operationIsCurrent =
        snapshotRollbackGenerations.get(rollbackKey) === rollbackGeneration &&
        loadModificationsGeneration.get(rollbackKey) === modificationGenerationAtStart &&
        !activeModificationLoadGenerations.has(rollbackKey) &&
        remainsAtRollbackSource(currentCtx);
      if (!currentCtx || !operationIsCurrent) return { diffByContext: state.diffByContext };

      const projectionAfter: DiffProjectionState = {
        baseContent: previewBaseContent,
        targetContent: content,
        preAppliedContent: content,
        xml: previewXml,
        modifications: refreshedModifications,
        activeSnapshotId: snapshotId,
        mode: refreshedModifications.length === 0 ? 'normal' : currentCtx.mode,
      };
      const newUndoStack = [
        ...currentCtx.undoStack,
        {
          type: 'rollback' as const,
          contentBefore,
          contentAfter: content,
          description: `Rollback to version ${snapshotId.substring(0, 8)}`,
          timestamp: Date.now(),
          pendingModificationsBefore: ctx.pendingModifications,
          pendingModificationsAfter: refreshedModifications,
          projectionBefore,
          projectionAfter,
        },
      ];
      if (newUndoStack.length > MAX_HISTORY_DEPTH) newUndoStack.shift();

      newMap.set(
        contextId,
        applySnapshotDiffProjection(
          {
            ...currentCtx,
            undoStack: newUndoStack,
            redoStack: [],
          },
          projectionAfter
        )
      );
      return { diffByContext: newMap };
    });

    // 刷新快照列表
    if (rollbackDocumentId) {
      void get().loadSnapshots(contextId, rollbackDocumentId);
    }

    // 更新 active_snapshot_id 标记（用于重启后恢复正确版本）
    if (rollbackDocumentId) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const committedCtx = get().diffByContext.get(contextId);
        if (
          snapshotRollbackGenerations.get(rollbackKey) !== rollbackGeneration ||
          loadModificationsGeneration.get(rollbackKey) !== modificationGenerationAtStart ||
          activeModificationLoadGenerations.has(rollbackKey) ||
          committedCtx?.documentId !== rollbackDocumentId ||
          committedCtx.activeSnapshotId !== snapshotId
        ) {
          return content;
        }
        await invoke('diff_record_update_active_snapshot', {
          contextId,
          documentId: rollbackDocumentId,
          snapshotId, // 直接使用回滚目标的快照 ID
        });
        logger.trace('[diffStore]  已更新 active_snapshot_id (rollback):', snapshotId);
      } catch (snapshotError) {
        logger.warn('[diffStore]  更新快照标记失败:', snapshotError);
      }
    }

    return content;
  },

  deleteSnapshot: async (contextId, snapshotId) => {
    const ctx = get().getDiffState(contextId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // 1. 获取 Diff 记录以判断是否删除的是活跃版本
      interface PersistedDiffRecord {
        id: string;
        contextId: string;
        messageId: string;
        documentId: string;
        originalContent: string;
        modifiedContent: string;
        xmlModification: string | null;
        status: string;
        activeSnapshotId: string | null;
        createdAt: number;
        updatedAt: number;
      }
      const diffRecords = await invoke<PersistedDiffRecord[]>('diff_record_get_pending', {
        contextId,
      });
      const currentDocumentRecords = diffRecords.filter(
        (record) => record.documentId === ctx.documentId
      );
      const currentDiffRecord =
        currentDocumentRecords.find((record) => record.activeSnapshotId === snapshotId) ??
        currentDocumentRecords[0];
      const isActiveVersion = currentDocumentRecords.some(
        (record) => record.activeSnapshotId === snapshotId
      );

      // 2. 执行删除
      await invoke('snapshot_delete', { id: snapshotId });
      logger.trace('[diffStore]  快照已删除:', snapshotId);

      // 3. 刷新快照列表
      if (ctx.documentId) {
        await get().loadSnapshots(contextId, ctx.documentId);
      }

      // 4. 获取剩余快照（删除后的最新列表）
      const updatedCtx = get().getDiffState(contextId);
      const remainingSnapshots = updatedCtx.snapshots;

      // 5. 根据场景处理 Diff 同步
      if (remainingSnapshots.length === 0) {
        // 当前文件的所有快照已删除
        logger.trace('[diffStore]  当前文件无剩余快照:', ctx.documentId);

        // 多文件场景：仅移除当前文件的 FileDiffEntry，保留其他文件
        const newFileEntries = new Map(updatedCtx.fileEntries);
        if (ctx.documentId) {
          newFileEntries.delete(ctx.documentId);
        }

        if (newFileEntries.size > 0) {
          // 还有其他文件，切换到第一个剩余文件
          const nextFileEntry = newFileEntries.entries().next().value;
          if (!nextFileEntry) return;
          const [nextDocId, nextEntry] = nextFileEntry;
          logger.trace('[diffStore]  切换到其他文件:', nextDocId);

          set((state) => {
            const newMap = new Map(state.diffByContext);
            const currentCtx = newMap.get(contextId) ?? createEmptyContextState();
            // 将目标文件状态恢复到顶层
            const restored = applyFileDiffEntry(
              { ...currentCtx, fileEntries: newFileEntries },
              nextEntry
            );
            newMap.set(contextId, restored);
            return { diffByContext: newMap };
          });
        } else {
          // 所有文件的快照都已清除，完全重置上下文
          logger.trace('[diffStore]  所有文件已清除，切回普通模式');
          set((state) => {
            const newMap = new Map(state.diffByContext);
            newMap.set(contextId, createEmptyContextState());
            return { diffByContext: newMap };
          });
        }

        // 标记 diff_record 为 reverted（防止 loadPersistedDiffs 重新恢复）
        if (currentDiffRecord) {
          try {
            await invoke('diff_record_update_status', {
              id: currentDiffRecord.id,
              status: 'reverted',
            });
            logger.trace('[diffStore]  Diff 记录已标记为 reverted:', currentDiffRecord.id);
          } catch (statusError) {
            logger.warn('[diffStore]  更新 Diff 记录状态失败:', statusError);
          }
        }

        // 仅清理当前文档的 pending 记录；同一 context 下其他文件必须继续保留。
        for (const record of currentDocumentRecords) {
          if (record.id !== currentDiffRecord?.id) {
            try {
              await invoke('diff_record_update_status', {
                id: record.id,
                status: 'reverted',
              });
            } catch (statusError) {
              logger.warn('[diffStore]  更新额外 Diff 记录状态失败:', statusError);
            }
          }
        }
      } else if (isActiveVersion) {
        // 场景：删除活跃版本 → 回滚到最近的更早版本
        const fallbackSnapshot = remainingSnapshots[0];
        if (fallbackSnapshot) {
          logger.trace('[diffStore] 活跃版本被删除，回滚到:', fallbackSnapshot.id);
          await get().rollback(contextId, fallbackSnapshot.id);
        }
      }
      // 场景：删除非活跃版本 → 无需额外处理，快照列表已刷新
    } catch (error) {
      logger.error('[diffStore] 删除快照失败:', error);
    }
  },

  toggleSnapshotPanel: () => {
    set((state) => ({ isSnapshotPanelOpen: !state.isSnapshotPanelOpen }));
  },

  // ==================== Undo/Redo 操作 ====================

  undo: async (contextId) => {
    const ctx = get().getDiffState(contextId);
    if (ctx.undoStack.length === 0) return;

    const undoDocumentId = ctx.documentId;
    const undoKey = `${contextId}::${undoDocumentId ?? ''}`;
    const undoLoadGeneration = loadModificationsGeneration.get(undoKey);
    if (activeModificationLoadGenerations.has(undoKey)) {
      logger.trace('[diffStore] 同路径 Diff 正在加载，跳过 Undo:', undoDocumentId);
      return;
    }

    // 弹出最后一个操作
    const newUndoStack = [...ctx.undoStack];
    const lastEntry = newUndoStack.pop();
    if (!lastEntry) return;

    const undoGeneration = (snapshotRollbackGenerations.get(undoKey) ?? 0) + 1;
    snapshotRollbackGenerations.set(undoKey, undoGeneration);
    const remainsAtUndoSource = (currentCtx: ContextDiffState | undefined) =>
      snapshotRollbackGenerations.get(undoKey) === undoGeneration &&
      loadModificationsGeneration.get(undoKey) === undoLoadGeneration &&
      !activeModificationLoadGenerations.has(undoKey) &&
      currentCtx?.documentId === undoDocumentId &&
      currentCtx.content === ctx.content &&
      currentCtx.undoStack === ctx.undoStack &&
      currentCtx.redoStack === ctx.redoStack;
    const isUndoCurrent = () => remainsAtUndoSource(get().diffByContext.get(contextId));

    // 将文件内容恢复到操作前
    if (!isUndoCurrent()) return;
    if (undoDocumentId?.includes(':') === true) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<{ success: boolean }>('file_write_to_path', {
          path: undoDocumentId,
          content: lastEntry.contentBefore,
          createBackup: false,
        });
        logger.trace('[diffStore] Undo 操作:', lastEntry.description);
        if (!isUndoCurrent()) {
          await compensateSupersededFileWrite(
            contextId,
            undoDocumentId,
            undoKey,
            undoLoadGeneration,
            () => get().diffByContext.get(contextId),
            async (supersedingContent) => {
              await invoke('file_write_to_path', {
                path: undoDocumentId,
                content: supersedingContent,
                createBackup: false,
              });
            }
          );
          return;
        }
      } catch (error) {
        logger.error('[diffStore] Undo 写入文件失败:', error);
        return;
      }
    }

    // 推入 Redo 栈
    const newRedoStack = [...ctx.redoStack, lastEntry];
    if (newRedoStack.length > MAX_HISTORY_DEPTH) {
      newRedoStack.shift();
    }

    if (!isUndoCurrent()) return;
    set((state) => {
      const currentCtx = state.diffByContext.get(contextId);
      if (
        !currentCtx ||
        snapshotRollbackGenerations.get(undoKey) !== undoGeneration ||
        loadModificationsGeneration.get(undoKey) !== undoLoadGeneration ||
        activeModificationLoadGenerations.has(undoKey) ||
        !remainsAtUndoSource(currentCtx)
      ) {
        return { diffByContext: state.diffByContext };
      }

      const stackUpdatedCtx = {
        ...currentCtx,
        undoStack: newUndoStack,
        redoStack: newRedoStack,
      };
      const restoredCtx = lastEntry.projectionBefore
        ? applySnapshotDiffProjection(stackUpdatedCtx, lastEntry.projectionBefore)
        : syncActiveFileEntry({
            ...stackUpdatedCtx,
            content: lastEntry.contentBefore,
            pendingModifications:
              lastEntry.pendingModificationsBefore ?? currentCtx.pendingModifications,
          });
      const newMap = new Map(state.diffByContext);
      newMap.set(contextId, restoredCtx);
      return { diffByContext: newMap };
    });

    if (ctx.documentId && lastEntry.projectionBefore) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const committedCtx = get().diffByContext.get(contextId);
        if (
          snapshotRollbackGenerations.get(undoKey) !== undoGeneration ||
          loadModificationsGeneration.get(undoKey) !== undoLoadGeneration ||
          activeModificationLoadGenerations.has(undoKey) ||
          committedCtx?.documentId !== undoDocumentId ||
          committedCtx.activeSnapshotId !== lastEntry.projectionBefore.activeSnapshotId ||
          committedCtx.undoStack !== newUndoStack ||
          committedCtx.redoStack !== newRedoStack
        ) {
          return;
        }
        await invoke('diff_record_update_active_snapshot', {
          contextId,
          documentId: ctx.documentId,
          snapshotId: lastEntry.projectionBefore.activeSnapshotId,
        });
      } catch (snapshotError) {
        logger.warn('[diffStore] Undo 更新快照标记失败:', snapshotError);
      }
    }

    // 刷新快照列表
    if (ctx.documentId) {
      void get().loadSnapshots(contextId, ctx.documentId);
    }
  },

  redo: async (contextId) => {
    const ctx = get().getDiffState(contextId);
    if (ctx.redoStack.length === 0) return;

    const redoDocumentId = ctx.documentId;
    const redoKey = `${contextId}::${redoDocumentId ?? ''}`;
    const redoLoadGeneration = loadModificationsGeneration.get(redoKey);
    if (activeModificationLoadGenerations.has(redoKey)) {
      logger.trace('[diffStore] 同路径 Diff 正在加载，跳过 Redo:', redoDocumentId);
      return;
    }

    // 弹出最后一个操作
    const newRedoStack = [...ctx.redoStack];
    const lastEntry = newRedoStack.pop();
    if (!lastEntry) return;

    const redoGeneration = (snapshotRollbackGenerations.get(redoKey) ?? 0) + 1;
    snapshotRollbackGenerations.set(redoKey, redoGeneration);
    const remainsAtRedoSource = (currentCtx: ContextDiffState | undefined) =>
      snapshotRollbackGenerations.get(redoKey) === redoGeneration &&
      loadModificationsGeneration.get(redoKey) === redoLoadGeneration &&
      !activeModificationLoadGenerations.has(redoKey) &&
      currentCtx?.documentId === redoDocumentId &&
      currentCtx.content === ctx.content &&
      currentCtx.undoStack === ctx.undoStack &&
      currentCtx.redoStack === ctx.redoStack;
    const isRedoCurrent = () => remainsAtRedoSource(get().diffByContext.get(contextId));

    // 将文件内容恢复到操作后
    if (!isRedoCurrent()) return;
    if (redoDocumentId?.includes(':') === true) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<{ success: boolean }>('file_write_to_path', {
          path: redoDocumentId,
          content: lastEntry.contentAfter,
          createBackup: false,
        });
        logger.trace('[diffStore]  Redo 操作:', lastEntry.description);
        if (!isRedoCurrent()) {
          await compensateSupersededFileWrite(
            contextId,
            redoDocumentId,
            redoKey,
            redoLoadGeneration,
            () => get().diffByContext.get(contextId),
            async (supersedingContent) => {
              await invoke('file_write_to_path', {
                path: redoDocumentId,
                content: supersedingContent,
                createBackup: false,
              });
            }
          );
          return;
        }
      } catch (error) {
        logger.error('[diffStore] Redo 写入文件失败:', error);
        return;
      }
    }

    // 推入 Undo 栈
    const newUndoStack = [...ctx.undoStack, lastEntry];
    if (newUndoStack.length > MAX_HISTORY_DEPTH) {
      newUndoStack.shift();
    }

    if (!isRedoCurrent()) return;
    set((state) => {
      const currentCtx = state.diffByContext.get(contextId);
      if (
        !currentCtx ||
        snapshotRollbackGenerations.get(redoKey) !== redoGeneration ||
        loadModificationsGeneration.get(redoKey) !== redoLoadGeneration ||
        activeModificationLoadGenerations.has(redoKey) ||
        !remainsAtRedoSource(currentCtx)
      ) {
        return { diffByContext: state.diffByContext };
      }

      const stackUpdatedCtx = {
        ...currentCtx,
        undoStack: newUndoStack,
        redoStack: newRedoStack,
      };
      const restoredCtx = lastEntry.projectionAfter
        ? applySnapshotDiffProjection(stackUpdatedCtx, lastEntry.projectionAfter)
        : syncActiveFileEntry({
            ...stackUpdatedCtx,
            content: lastEntry.contentAfter,
            pendingModifications:
              lastEntry.pendingModificationsAfter ?? currentCtx.pendingModifications,
          });
      const newMap = new Map(state.diffByContext);
      newMap.set(contextId, restoredCtx);
      return { diffByContext: newMap };
    });

    if (ctx.documentId && lastEntry.projectionAfter) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const committedCtx = get().diffByContext.get(contextId);
        if (
          snapshotRollbackGenerations.get(redoKey) !== redoGeneration ||
          loadModificationsGeneration.get(redoKey) !== redoLoadGeneration ||
          activeModificationLoadGenerations.has(redoKey) ||
          committedCtx?.documentId !== redoDocumentId ||
          committedCtx.activeSnapshotId !== lastEntry.projectionAfter.activeSnapshotId ||
          committedCtx.undoStack !== newUndoStack ||
          committedCtx.redoStack !== newRedoStack
        ) {
          return;
        }
        await invoke('diff_record_update_active_snapshot', {
          contextId,
          documentId: ctx.documentId,
          snapshotId: lastEntry.projectionAfter.activeSnapshotId,
        });
      } catch (snapshotError) {
        logger.warn('[diffStore] Redo 更新快照标记失败:', snapshotError);
      }
    }

    // 刷新快照列表
    if (ctx.documentId) {
      void get().loadSnapshots(contextId, ctx.documentId);
    }
  },

  canUndo: (contextId) => {
    const ctx = get().getDiffState(contextId);
    return ctx.undoStack.length > 0;
  },

  canRedo: (contextId) => {
    const ctx = get().getDiffState(contextId);
    return ctx.redoStack.length > 0;
  },

  // ==================== MessageId 更新 ====================

  updateMessageId: async (contextId, oldMessageId, newMessageId) => {
    /**
     * 更新临时 messageId 为真实 ID
     *
     * Planning 模式中，onDiffData 回调在消息创建前触发，使用临时 ID 持久化 Diff 记录。
     * 消息创建后调用此方法更新为真实 ID，确保后续查询（如撤回时的关联查询）正常工作。
     */
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // 调用后端更新 messageId
      await invoke('diff_record_update_message_id', {
        contextId,
        oldMessageId,
        newMessageId,
      });

      logger.trace('[diffStore]  messageId 已更新:', oldMessageId, '->', newMessageId);
    } catch (error) {
      logger.error('[diffStore] 更新 messageId 失败:', error);
      // 不阻塞主流程，仅记录错误
    }
  },

  // ==================== 历史版本访问 ====================

  getCompletedDiffFiles: (contextId) => {
    const ctx = get().getDiffState(contextId);
    // 仅在 normal 模式下展示入口（审批流已退出 diff 模式）
    if (ctx.mode !== 'normal') return [];

    // 「已完成审批」的判定条件：
    // - 有修改记录（本次 SA 产生了 diff）
    // - 全部修改都已处理（status 均为 applied 或 rejected，不存在 pending）
    // 若用户手动切回 Normal 但仍有 pending 未处理，不应出现在「已完成」列表中
    const isFullyReviewed = (mods: ModificationApplyResult[]) =>
      mods.length > 0 && mods.every((m) => m.status !== 'pending');

    const result: Array<{ documentId: string; fileName: string }> = [];
    const seen = new Set<string>();

    // 1. 当前活跃文件（顶层字段）：需完全审批 + 快照已加载
    //    快照条件严格：确保面板打开时有实际内容可展示
    if (ctx.documentId && isFullyReviewed(ctx.pendingModifications) && ctx.snapshots.length > 0) {
      result.push({ documentId: ctx.documentId, fileName: ctx.fileName });
      seen.add(ctx.documentId);
    }

    // 2. 其他文件（fileEntries）：需完全审批，快照条件宽松
    //    选中文件时 selectFile 会触发 loadSnapshots，快照面板动态填充
    for (const [docId, entry] of ctx.fileEntries) {
      if (seen.has(docId)) continue;
      if (isFullyReviewed(entry.pendingModifications)) {
        result.push({ documentId: docId, fileName: entry.fileName });
        seen.add(docId);
      }
    }

    return result;
  },

  // ==================== 状态重置 ====================

  reset: () => {
    set({
      currentContextId: null,
      diffByContext: new Map(),
      isSnapshotPanelOpen: false,
    });
  },
}));

// ==================== 选择器 ====================

/** 获取指定上下文的审批进度 */
export const selectApprovalProgressByContext = (contextId: string) => (state: DiffState) => {
  const ctx = state.diffByContext.get(contextId);
  if (!ctx) return { approved: 0, total: 0 };
  const total = ctx.pendingModifications.length;
  const approved = ctx.pendingModifications.filter(
    (m) => m.status === 'applied' || m.status === 'rejected'
  ).length;
  return { approved, total };
};

/** 获取指定上下文的待审批数量 */
export const selectPendingCountByContext = (contextId: string) => (state: DiffState) => {
  const ctx = state.diffByContext.get(contextId);
  return ctx?.pendingModifications.filter((m) => m.status === 'pending').length ?? 0;
};

/** 获取指定上下文的失败数量 */
export const selectFailedCountByContext = (contextId: string) => (state: DiffState) => {
  const ctx = state.diffByContext.get(contextId);
  return ctx?.pendingModifications.filter((m) => m.status === 'failed').length ?? 0;
};

// ==================== 向后兼容选择器（使用 currentContextId）====================

/** 获取当前上下文的审批进度（向后兼容） */
export const selectApprovalProgress = (state: DiffState & DiffActions) => {
  const contextId = state.currentContextId;
  if (!contextId) return { approved: 0, total: 0 };
  const ctx = state.diffByContext.get(contextId);
  if (!ctx) return { approved: 0, total: 0 };
  const total = ctx.pendingModifications.length;
  const approved = ctx.pendingModifications.filter(
    (m) => m.status === 'applied' || m.status === 'rejected'
  ).length;
  return { approved, total };
};

/** 获取当前上下文的待审批数量（向后兼容） */
export const selectPendingCount = (state: DiffState & DiffActions) => {
  const contextId = state.currentContextId;
  if (!contextId) return 0;
  const ctx = state.diffByContext.get(contextId);
  return ctx?.pendingModifications.filter((m) => m.status === 'pending').length ?? 0;
};

/** 获取当前上下文的失败数量（向后兼容） */
export const selectFailedCount = (state: DiffState & DiffActions) => {
  const contextId = state.currentContextId;
  if (!contextId) return 0;
  const ctx = state.diffByContext.get(contextId);
  return ctx?.pendingModifications.filter((m) => m.status === 'failed').length ?? 0;
};
