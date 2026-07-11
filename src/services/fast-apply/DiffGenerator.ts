/**
 * Diff 生成器
 *
 * 生成文档修改的差异对比（Unified Diff 格式）
 * 底层使用 Myers diff 算法（保证最小编辑距离）
 */

import type { DiffResult, DiffHunk, DiffLine, DiffLineType } from './types';
import { myersDiff } from './MyersDiff';

// ==================== 工具函数 ====================

/**
 * 将内容按行分割
 */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

// ==================== Diff 生成器类 ====================

/**
 * Diff 生成器
 *
 * 基于 Myers diff 算法生成文档差异
 * 保证最小编辑距离，时间复杂度 O(ND)
 */
export class DiffGenerator {
  /** 上下文行数（每个变更块前后保留的行数） */
  private contextLines: number;

  constructor(contextLines: number = 3) {
    this.contextLines = contextLines;
  }

  /**
   * 生成两个内容的差异
   *
   * @param oldContent 原内容
   * @param newContent 新内容
   * @returns Diff 结果
   */
  generateDiff(oldContent: string, newContent: string): DiffResult {
    // 处理完全相同的情况
    if (oldContent === newContent) {
      return {
        oldContent,
        newContent,
        hunks: [],
        hasChanges: false,
      };
    }

    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);

    // 使用 Myers diff 替代 LCS，保证最小编辑距离
    const changes = myersDiff(oldLines, newLines);

    // 将变更序列分组为 hunks
    const hunks = this.groupIntoHunks(changes);

    return {
      oldContent,
      newContent,
      hunks,
      hasChanges: hunks.length > 0,
    };
  }

  /**
   * 生成 Unified Diff 格式的字符串
   *
   * @param diffResult Diff 结果
   * @param oldFile 旧文件名
   * @param newFile 新文件名
   * @returns Unified Diff 格式字符串
   */
  toUnifiedDiff(
    diffResult: DiffResult,
    oldFile: string = 'a/file',
    newFile: string = 'b/file'
  ): string {
    if (!diffResult.hasChanges) {
      return '';
    }

    const lines: string[] = [`--- ${oldFile}`, `+++ ${newFile}`];

    for (const hunk of diffResult.hunks) {
      // 生成 hunk 头
      const header = ` -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} `;
      lines.push(header);

      // 生成 hunk 内容
      for (const line of hunk.lines) {
        const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        lines.push(prefix + line.content);
      }
    }

    return lines.join('\n');
  }

  /**
   * 计算变更统计
   *
   * @param diffResult Diff 结果
   * @returns 新增行数和删除行数
   */
  getStats(diffResult: DiffResult): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;

    for (const hunk of diffResult.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') additions++;
        if (line.type === 'remove') deletions++;
      }
    }

    return { additions, deletions };
  }

  // ==================== 私有方法 ====================

  /**
   * 将变更序列分组为 hunks
   *
   * 将连续的变更（包括上下文）分组为 DiffHunk
   */
  private groupIntoHunks(
    changes: Array<{
      type: DiffLineType;
      content: string;
      oldIdx?: number;
      newIdx?: number;
    }>
  ): DiffHunk[] {
    const hunks: DiffHunk[] = [];

    // 找出所有变更行的位置
    const changeIndices: number[] = [];
    changes.forEach((change, index) => {
      if (change.type !== 'context') {
        changeIndices.push(index);
      }
    });

    if (changeIndices.length === 0) {
      return [];
    }

    // 将变更索引分组（相邻的变更合并为一个 hunk）
    const groups: number[][] = [];
    let currentGroup: number[] = [];

    for (const idx of changeIndices) {
      const lastGroupIdx = currentGroup[currentGroup.length - 1];
      if (
        currentGroup.length === 0 ||
        (lastGroupIdx !== undefined && idx - lastGroupIdx <= this.contextLines * 2 + 1)
      ) {
        currentGroup.push(idx);
      } else {
        groups.push(currentGroup);
        currentGroup = [idx];
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // 为每个组生成 hunk
    for (const group of groups) {
      const firstChange = group[0];
      const lastChange = group[group.length - 1];

      // 跳过空组
      if (firstChange === undefined || lastChange === undefined) {
        continue;
      }

      // 计算 hunk 的范围（包含上下文）
      const start = Math.max(0, firstChange - this.contextLines);
      const end = Math.min(changes.length, lastChange + this.contextLines + 1);

      // 提取这个范围内的所有行
      const hunkChanges = changes.slice(start, end);

      // 计算行号
      let oldStart = 1;
      let newStart = 1;
      for (let i = 0; i < start; i++) {
        const change = changes[i];
        if (change && change.type !== 'add') oldStart++;
        if (change && change.type !== 'remove') newStart++;
      }

      // 统计行数
      let oldLines = 0;
      let newLines = 0;
      const lines: DiffLine[] = [];

      for (const change of hunkChanges) {
        const line: DiffLine = {
          type: change.type,
          content: change.content,
        };

        if (change.type !== 'add') {
          line.oldLineNumber = oldStart + oldLines;
          oldLines++;
        }
        if (change.type !== 'remove') {
          line.newLineNumber = newStart + newLines;
          newLines++;
        }

        lines.push(line);
      }

      hunks.push({
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines,
      });
    }

    return hunks;
  }
}

// ==================== 导出单例 ====================

/** 默认 Diff 生成器实例 */
export const diffGenerator = new DiffGenerator();
