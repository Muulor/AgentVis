/**
 * DiffToXmlConverter - DiffResult → XML 修改协议转换器
 *
 * 将 DiffGenerator 产出的 DiffResult 转换为 ProtocolParser 可解析的
 * XML 修改协议，使 file_write 覆盖模式能复用 edit 工具的完整 Diff 管道。
 *
 * 核心算法：
 * 遍历每个 hunk 的 lines，将连续的 remove/add 行分组为 "change block"，
 * 每个 block 生成一个 <modification> 标签。context 行是分隔符，不参与修改。
 *
 * @example
 * ```typescript
 * const diff = diffGenerator.generateDiff(original, newContent);
 * const xml = diffToXml(diff);
 * // 结果可直接传给 fastApplyEngine.preview(documentId, original, xml)
 * ```
 */

import type { DiffResult, DiffLine } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('DiffToXmlConverter');

// ==================== XML 转义 ====================

/**
 * 转义 XML 特殊字符
 *
 * 使用 XML 实体替换，避免 CDATA 的 ]]> 问题。
 * DOMParser 的 textContent 会自动反转义，保证内容完整性。
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ==================== Change Block 类型 ====================

/** 纯插入块锚点最多使用的上下文行数（越多匹配越精确，但 search 越长） */
const MAX_ANCHOR_CONTEXT_LINES = 5;

/**
 * 变更块：连续的 remove/add 行，中间无 context 间隔
 */
interface ChangeBlock {
  /** 被删除的行（原始文件中的行） */
  removeLines: DiffLine[];
  /** 被添加的行（新文件中的行） */
  addLines: DiffLine[];
  /** 前方 context 行（最多 MAX_ANCHOR_CONTEXT_LINES 行，用于纯插入块的 INSERT_AFTER 锚点，按顺序排列） */
  precedingContextLines: DiffLine[];
  /** 后一行 context（用于文件头部纯插入的 INSERT_BEFORE 锚点定位） */
  followingContextLine: DiffLine | null;
}

// ==================== 核心转换函数 ====================

/**
 * 检测给定的锚点行（多行字符串）在原始文件中是否唯一
 *
 * @param anchorContent 锚点行内容（已拼接成字符串）
 * @param originalLines 原始文件的所有行
 * @returns true 表示唯一（只出现一次）
 */
function isAnchorUnique(anchorContent: string, originalLines: string[]): boolean {
  if (anchorContent.trim().length === 0) return false;
  const anchorLines = anchorContent.split('\n');
  const anchorLen = anchorLines.length;
  let matchCount = 0;

  for (let i = 0; i <= originalLines.length - anchorLen; i++) {
    // 逐行比较（trim 去除首尾空白，避免缩进差异影响匹配）
    const matches = anchorLines.every((al, idx) => {
      const ol = originalLines[i + idx];
      return ol?.trimEnd() === al.trimEnd();
    });
    if (matches) {
      matchCount++;
      if (matchCount > 1) return false; // 提前退出：多于1次即不唯一
    }
  }
  return matchCount === 1;
}

/**
 * 将 DiffResult 转换为 XML 修改协议字符串
 *
 * @param diff DiffGenerator 生成的 diff 结果
 * @param originalContent 原始文件内容（可选）。提供时对 INSERT 块锚点做唯一性检测，
 *   不唯一时动态扩展上下文行数（3→5→7行），提高重复行多的文件的匹配精度。
 * @returns XML 修改协议字符串，可直接传给 fastApplyEngine.preview()
 */
export function diffToXml(diff: DiffResult, originalContent?: string): string {
  if (!diff.hasChanges || diff.hunks.length === 0) {
    return '<modifications></modifications>';
  }

  // 将原始内容按行分割，供锚点唯一性检测使用
  const originalLines = originalContent ? originalContent.split(/\r?\n/) : null;

  const modifications: string[] = [];

  for (let hunkIdx = 0; hunkIdx < diff.hunks.length; hunkIdx++) {
    const hunk = diff.hunks[hunkIdx];
    if (!hunk) continue;
    // 将 hunk 内的连续变更分组为 change block
    const blocks = extractChangeBlocks(hunk.lines);

    // 诊断：记录每个 hunk 提取的 block 数量及类型
    const blockSummary = blocks.map((b) => {
      const hasR = b.removeLines.length > 0;
      const hasA = b.addLines.length > 0;
      if (hasR && hasA) return `REPLACE(r${b.removeLines.length}/a${b.addLines.length})`;
      if (hasR) return `DELETE(r${b.removeLines.length})`;
      if (hasA) return `INSERT(a${b.addLines.length},anchor=${b.precedingContextLines.length})`;
      return 'EMPTY';
    });
    logger.trace(
      `[diffToXml] hunk[${hunkIdx}]: ${hunk.lines.length} lines → ${blocks.length} blocks: [${blockSummary.join(', ')}]`
    );

    for (const block of blocks) {
      const xmlSnippet = changeBlockToXml(block, originalLines);
      if (xmlSnippet) {
        modifications.push(xmlSnippet);
      }
    }
  }

  logger.trace(
    `[diffToXml] 输出: ${diff.hunks.length} hunks → ${modifications.length} modifications`
  );

  if (modifications.length === 0) {
    return '<modifications></modifications>';
  }

  return `<modifications>\n${modifications.join('\n')}\n</modifications>`;
}

/**
 * 整文件覆写时生成单一 REPLACE 修改协议
 *
 * 当 file_write overwrite 模式检测到高变更率（>50%）时使用。
 * 替代 diffToXml() 产生的数百个细粒度修改块，避免 preview() 逐个独立匹配时
 * 出现大量 MATCH FAILED 和重叠偏差。
 *
 * 单一 REPLACE 覆盖整个文件内容：
 * - preview() 仅需匹配一次（整文件）→ 必定成功
 * - FullFileDiffBuilder 对该修改块内部做 myersDiff → 精确显示实际变更行
 *
 * @param originalContent 原始文件内容
 * @param newContent 新文件内容
 * @returns XML 修改协议字符串
 */
export function generateWholeFileReplaceXml(originalContent: string, newContent: string): string {
  // 空文件 → 无修改
  if (originalContent === newContent) {
    return '<modifications></modifications>';
  }

  const xml = [
    '<modifications>',
    '  <modification>',
    '    <operation>REPLACE</operation>',
    `    <search>${escapeXml(originalContent)}</search>`,
    `    <replace>${escapeXml(newContent)}</replace>`,
    '    <description>Whole-file overwrite</description>',
    '  </modification>',
    '</modifications>',
  ].join('\n');

  logger.trace(
    `[generateWholeFileReplaceXml] 生成单一 REPLACE: searchLen=${originalContent.length}, replaceLen=${newContent.length}`
  );
  return xml;
}

// ==================== Change Block 提取 ====================

/**
 * 从 hunk 的 lines 中提取 change block
 *
 * 遍历 lines，将相邻的 remove/add 行分组。
 * 遇到 context 行时结束当前 block 并记录锚点。
 */
function extractChangeBlocks(lines: DiffLine[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let currentBlock: ChangeBlock | null = null;
  // 使用滑动窗口记录最近的 context 行，提升纯插入块锚点的唯一性
  const recentContextLines: DiffLine[] = [];

  for (const line of lines) {
    if (line.type === 'context') {
      // context 行分隔 change block
      if (
        currentBlock &&
        (currentBlock.removeLines.length > 0 || currentBlock.addLines.length > 0)
      ) {
        blocks.push(currentBlock);
      }
      currentBlock = null;
      // 滑动窗口记录最近 N 行 context
      recentContextLines.push(line);
      if (recentContextLines.length > MAX_ANCHOR_CONTEXT_LINES) {
        recentContextLines.shift();
      }
    } else {
      // remove 或 add 行
      currentBlock ??= {
        removeLines: [],
        addLines: [],
        // 复制当前积累的 context 行作为锚点
        precedingContextLines: [...recentContextLines],
        followingContextLine: null,
      };
      if (line.type === 'remove') {
        currentBlock.removeLines.push(line);
      } else {
        currentBlock.addLines.push(line);
      }
    }
  }

  // 最后一个 block
  if (currentBlock && (currentBlock.removeLines.length > 0 || currentBlock.addLines.length > 0)) {
    blocks.push(currentBlock);
  }

  // 回填 followingContextLine：对每个无 precedingContextLines 的 block，
  // 向后查找第一个有锚点的 block 的首行 context 作为后锚点
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.precedingContextLines.length === 0) {
      for (let j = i + 1; j < blocks.length; j++) {
        const nextBlock = blocks[j];
        if (nextBlock && nextBlock.precedingContextLines.length > 0) {
          block.followingContextLine = nextBlock.precedingContextLines[0] ?? null;
          break;
        }
      }
    }
  }

  return blocks;
}

// ==================== XML 生成 ====================

/**
 * 将单个 change block 转换为 <modification> XML
 *
 * 根据变更类型选择操作：
 * - 有 remove + 有 add → REPLACE
 * - 有 remove + 无 add → DELETE
 * - 无 remove + 有 add → INSERT_AFTER（使用前一行 context 作为锚点）
 *
 * @param block 变更块
 * @param originalLines 原始文件的所有行（可选）。提供时对 INSERT 块锚点做唯一性检测，
 *   不唯一时动态扩展 context 行数以提高匹配精度。
 */
function changeBlockToXml(block: ChangeBlock, originalLines: string[] | null): string | null {
  const hasRemove = block.removeLines.length > 0;
  const hasAdd = block.addLines.length > 0;

  if (!hasRemove && !hasAdd) {
    return null;
  }

  const searchContent = block.removeLines.map((l) => l.content).join('\n');
  const replaceContent = block.addLines.map((l) => l.content).join('\n');

  if (hasRemove && hasAdd) {
    // REPLACE：最常见的情况，search 本身就是唯一标识，不需要锚点扩展
    return [
      '  <modification>',
      '    <operation>REPLACE</operation>',
      `    <search>${escapeXml(searchContent)}</search>`,
      `    <replace>${escapeXml(replaceContent)}</replace>`,
      '  </modification>',
    ].join('\n');
  }

  if (hasRemove && !hasAdd) {
    // DELETE：只有删除行
    return [
      '  <modification>',
      '    <operation>DELETE</operation>',
      `    <search>${escapeXml(searchContent)}</search>`,
      '  </modification>',
    ].join('\n');
  }

  // INSERT_AFTER：只有新增行（无删除行）
  // 使用多行 context 作为锚点，转换为 REPLACE 格式（锚点行 → 锚点行+新增行）
  // 多行锚点确保在 CSS/HTML 等重复行多的文件中精确匹配位置
  if (block.precedingContextLines.length > 0) {
    // 最终使用的 context 行（子集，从末尾取 N 行）
    const allContextLines = block.precedingContextLines;
    let anchorContent = allContextLines.map((l) => l.content).join('\n');

    // 动态扩展锚点：若提供了原始文件行且当前锚点不唯一，逐步增加使用的行数
    // 扩展步长：3 → 5 → 7 → ... → 全量 context，以减少 search 长度的同时保证唯一性
    if (originalLines && !isAnchorUnique(anchorContent, originalLines)) {
      const BASE_STEP = 3;
      let expanded = false;
      for (let win = BASE_STEP + 2; win <= allContextLines.length; win += 2) {
        const extendedLines = allContextLines.slice(-win);
        const extendedContent = extendedLines.map((l) => l.content).join('\n');
        if (isAnchorUnique(extendedContent, originalLines)) {
          anchorContent = extendedContent;
          expanded = true;
          logger.trace(`[diffToXml] INSERT 锚点扩展至 ${win} 行（已唯一）`);
          break;
        }
      }
      if (!expanded) {
        // 全量 context 仍不唯一（极罕见：如空文件或全相同行）→ 使用全量，兜底
        logger.warn('[diffToXml] INSERT 锚点扩展到全量仍不唯一，使用全量 context 作为锚点');
      }
    }

    // 将锚点行包含在 replace 中：原锚点行 + 新增内容
    const fullReplaceContent = anchorContent + '\n' + replaceContent;
    return [
      '  <modification>',
      '    <operation>REPLACE</operation>',
      `    <search>${escapeXml(anchorContent)}</search>`,
      `    <replace>${escapeXml(fullReplaceContent)}</replace>`,
      '  </modification>',
    ].join('\n');
  }

  // 无前锚点的纯插入（文件头部插入）：使用后锚点做 INSERT_BEFORE
  if (block.followingContextLine) {
    const anchorContent = block.followingContextLine.content;
    return [
      '  <modification>',
      '    <operation>INSERT_BEFORE</operation>',
      `    <search>${escapeXml(anchorContent)}</search>`,
      `    <replace>${escapeXml(replaceContent)}</replace>`,
      '  </modification>',
    ].join('\n');
  }

  // 完全无锚点（极罕见：空文件的纯插入）→ 返回 null
  // file_write 已写入内容，accept all 仍然正确
  return null;
}
