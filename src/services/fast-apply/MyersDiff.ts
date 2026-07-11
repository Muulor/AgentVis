/**
 * Myers Diff 算法
 *
 * 基于 Eugene W. Myers (1986) "An O(ND) Difference Algorithm and Its Variations"
 * 这是 git diff 的底层算法，保证最小编辑距离
 *
 * 核心思路：
 * - 将 diff 问题建模为编辑图上的最短路径搜索
 * - 贪心策略：对每个编辑距离 d (0,1,2,...)，在每条对角线 k 上尽可能远地前进
 * - 回溯：找到终点后沿 trace 回溯，还原编辑操作序列
 *
 * 时间复杂度 O(ND)，N = a.length + b.length，D = 编辑距离
 * 对于典型文件编辑（D << N），性能远优于 LCS 的 O(NM)
 *
 * 设计原则：
 * - 纯函数，无副作用，零外部依赖
 * - 输出格式与现有 DiffLineType 兼容，可直接供 DiffGenerator 和 diffStore 使用
 */

import type { DiffLineType } from './types';

// ==================== 类型定义 ====================

/**
 * 编辑操作
 *
 * 表示一行内容的变更状态：保持(context)、删除(remove)、新增(add)
 * oldIdx/newIdx 均为 1-indexed，与现有 DiffGenerator.backtrackDiff 输出格式一致
 */
export interface EditOp {
  /** 操作类型：context=保持不变, remove=从旧文件删除, add=向新文件新增 */
  type: DiffLineType;
  /** 行内容 */
  content: string;
  /** 在旧文件中的行号 (1-indexed, context/remove 有效) */
  oldIdx?: number;
  /** 在新文件中的行号 (1-indexed, context/add 有效) */
  newIdx?: number;
}

// ==================== 核心算法 ====================

/**
 * Myers diff 核心算法
 *
 * 对比两个字符串数组（按行分割），生成最小编辑操作序列
 *
 * @param a 旧内容按行分割
 * @param b 新内容按行分割
 * @returns 编辑操作序列（按文件顺序排列）
 */
export function myersDiff(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;

  // 边界情况：空数组
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return b.map((line, i) => ({
      type: 'add' as DiffLineType,
      content: line,
      newIdx: i + 1,
    }));
  }
  if (m === 0) {
    return a.map((line, i) => ({
      type: 'remove' as DiffLineType,
      content: line,
      oldIdx: i + 1,
    }));
  }

  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;

  // V[k + offset] = 对角线 k 上到达的最远 x 坐标
  const v = new Array<number>(size).fill(0);
  // trace[d] = 第 d 步结束时的 V 快照（用于回溯）
  const trace: number[][] = [];

  // 前向搜索：逐步增加编辑距离 d，直到从 (0,0) 抵达 (n,m)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      // 选择从上方（插入）还是左方（删除）进入对角线 k
      // k === -d 时只能从上方进入；k === d 时只能从左方进入
      // 否则取 V 值较大者（贪心：尽可能多匹配）
      let x: number;
      if (k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))) {
        x = v[k + 1 + offset] ?? 0; // 从对角线 k+1 下移（插入）
      } else {
        x = (v[k - 1 + offset] ?? 0) + 1; // 从对角线 k-1 右移（删除）
      }

      let y = x - k;

      // 沿对角线尽可能远地前进（匹配的行）
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v[k + offset] = x;

      // 到达终点：保存最终 V 并回溯
      if (x >= n && y >= m) {
        trace.push([...v]);
        return backtrackEditOps(trace, a, b, n, m, d, offset);
      }
    }
    // 保存本步结束时的 V 快照
    trace.push([...v]);
  }

  // 理论上不会到达这里（最坏情况 d = n + m 一定能找到）
  return backtrackEditOps(trace, a, b, n, m, trace.length - 1, offset);
}

// ==================== 回溯 ====================

/**
 * 从 trace 回溯，还原编辑操作序列
 *
 * 从 (n, m) 反向追踪到 (0, 0)，依次还原每一步的编辑操作
 * 每步由"一个编辑（insert/delete）+ 一段 snake（对角线匹配）"组成
 */
function backtrackEditOps(
  trace: number[][],
  a: string[],
  b: string[],
  n: number,
  m: number,
  finalD: number,
  offset: number
): EditOp[] {
  // 从末尾向开头收集操作，最后反转
  const ops: EditOp[] = [];
  let x = n;
  let y = m;

  for (let d = finalD; d >= 0; d--) {
    const k = x - y;

    if (d === 0) {
      // d=0 表示剩余部分全是匹配（初始 snake）
      while (x > 0 && y > 0) {
        x--;
        y--;
        ops.push({
          type: 'context',
          content: a[x] ?? '',
          oldIdx: x + 1,
          newIdx: y + 1,
        });
      }
      break;
    }

    // 查找 d-1 步的 V 快照（trace[d-1]）
    const vPrev = trace[d - 1];
    if (!vPrev) break;

    // 判断当前步是从哪条对角线过来的
    let prevK: number;
    if (k === -d || (k !== d && (vPrev[k - 1 + offset] ?? 0) < (vPrev[k + 1 + offset] ?? 0))) {
      prevK = k + 1; // 来自插入（从对角线 k+1 下移）
    } else {
      prevK = k - 1; // 来自删除（从对角线 k-1 右移）
    }

    const prevX = vPrev[prevK + offset] ?? 0;
    const prevY = prevX - prevK;

    // 确定编辑操作后的坐标（snake 起点）
    let editX: number;
    let editY: number;
    if (prevK === k + 1) {
      // 插入：y 从 prevY 增加 1
      editX = prevX;
      editY = prevY + 1;
    } else {
      // 删除：x 从 prevX 增加 1
      editX = prevX + 1;
      editY = prevY;
    }

    // 输出 snake（对角线匹配，从 (editX, editY) 到 (x, y)）
    while (x > editX && y > editY) {
      x--;
      y--;
      ops.push({
        type: 'context',
        content: a[x] ?? '',
        oldIdx: x + 1,
        newIdx: y + 1,
      });
    }

    // 输出编辑操作
    if (prevK === k + 1) {
      // 插入
      y--;
      ops.push({
        type: 'add',
        content: b[y] ?? '',
        newIdx: y + 1,
      });
    } else {
      // 删除
      x--;
      ops.push({
        type: 'remove',
        content: a[x] ?? '',
        oldIdx: x + 1,
      });
    }
  }

  // 操作从尾到头收集，需要反转
  ops.reverse();
  return ops;
}
