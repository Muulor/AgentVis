/**
 * Myers Diff 算法单元测试
 *
 * 验证 myersDiff 核心算法在各种场景下的正确性：
 * - 基础场景（相同、空、完全不同）
 * - DELETE / INSERT / REPLACE 操作
 * - 混合操作
 * - 行号正确性
 * - 内容完整性（重建原始和新内容）
 */

import { describe, it, expect } from 'vitest';
import { myersDiff, type EditOp } from '../MyersDiff';

// ==================== 辅助函数 ====================

/** 从编辑序列重建旧内容（context + remove 的行） */
function rebuildOld(ops: EditOp[]): string[] {
  return ops.filter((op) => op.type === 'context' || op.type === 'remove').map((op) => op.content);
}

/** 从编辑序列重建新内容（context + add 的行） */
function rebuildNew(ops: EditOp[]): string[] {
  return ops.filter((op) => op.type === 'context' || op.type === 'add').map((op) => op.content);
}

/** 统计各类型操作数量 */
function countOps(ops: EditOp[]): { context: number; add: number; remove: number } {
  return {
    context: ops.filter((op) => op.type === 'context').length,
    add: ops.filter((op) => op.type === 'add').length,
    remove: ops.filter((op) => op.type === 'remove').length,
  };
}

// ==================== 基础场景 ====================

describe('MyersDiff', () => {
  describe('基础场景', () => {
    it('两个空数组应返回空序列', () => {
      const result = myersDiff([], []);
      expect(result).toEqual([]);
    });

    it('完全相同的内容应全部为 context', () => {
      const lines = ['a', 'b', 'c'];
      const result = myersDiff(lines, lines);
      expect(result).toHaveLength(3);
      expect(result.every((op) => op.type === 'context')).toBe(true);
      expect(rebuildOld(result)).toEqual(lines);
      expect(rebuildNew(result)).toEqual(lines);
    });

    it('旧内容为空应全部为 add', () => {
      const newLines = ['x', 'y'];
      const result = myersDiff([], newLines);
      expect(result).toHaveLength(2);
      expect(result.every((op) => op.type === 'add')).toBe(true);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('新内容为空应全部为 remove', () => {
      const oldLines = ['a', 'b'];
      const result = myersDiff(oldLines, []);
      expect(result).toHaveLength(2);
      expect(result.every((op) => op.type === 'remove')).toBe(true);
      expect(rebuildOld(result)).toEqual(oldLines);
    });

    it('完全不同的内容应无 context', () => {
      const oldLines = ['a', 'b'];
      const newLines = ['x', 'y'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.context).toBe(0);
      expect(counts.remove).toBe(2);
      expect(counts.add).toBe(2);
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });
  });

  // ==================== DELETE 场景 ====================

  describe('DELETE 操作', () => {
    it('删除中间一行', () => {
      const oldLines = ['a', 'b', 'c'];
      const newLines = ['a', 'c'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.context).toBe(2);
      expect(counts.remove).toBe(1);
      expect(counts.add).toBe(0);

      const removed = result.filter((op) => op.type === 'remove');
      expect(removed[0]?.content).toBe('b');
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('删除开头多行', () => {
      const oldLines = ['a', 'b', 'c', 'd'];
      const newLines = ['c', 'd'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.remove).toBe(2);
      expect(counts.context).toBe(2);
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('删除末尾行', () => {
      const oldLines = ['a', 'b', 'c'];
      const newLines = ['a', 'b'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.remove).toBe(1);
      expect(counts.context).toBe(2);
      expect(rebuildNew(result)).toEqual(newLines);
    });
  });

  // ==================== INSERT 场景 ====================

  describe('INSERT 操作', () => {
    it('在中间插入一行', () => {
      const oldLines = ['a', 'c'];
      const newLines = ['a', 'b', 'c'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.context).toBe(2);
      expect(counts.add).toBe(1);
      expect(counts.remove).toBe(0);

      const added = result.filter((op) => op.type === 'add');
      expect(added[0]?.content).toBe('b');
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('在开头插入', () => {
      const oldLines = ['b', 'c'];
      const newLines = ['a', 'b', 'c'];
      const result = myersDiff(oldLines, newLines);

      expect(countOps(result).add).toBe(1);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('在末尾追加多行', () => {
      const oldLines = ['a'];
      const newLines = ['a', 'b', 'c'];
      const result = myersDiff(oldLines, newLines);

      expect(countOps(result).add).toBe(2);
      expect(countOps(result).context).toBe(1);
      expect(rebuildNew(result)).toEqual(newLines);
    });
  });

  // ==================== REPLACE 场景 ====================

  describe('REPLACE 操作', () => {
    it('替换中间一行（remove + add 相邻）', () => {
      const oldLines = ['a', 'b', 'c'];
      const newLines = ['a', 'x', 'c'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.context).toBe(2);
      expect(counts.remove).toBe(1);
      expect(counts.add).toBe(1);

      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('替换多行', () => {
      const oldLines = ['a', 'b', 'c', 'd'];
      const newLines = ['a', 'x', 'y', 'd'];
      const result = myersDiff(oldLines, newLines);

      const counts = countOps(result);
      expect(counts.context).toBe(2); // a, d
      expect(counts.remove).toBe(2); // b, c
      expect(counts.add).toBe(2); // x, y

      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('行数不等的替换（删2加3）', () => {
      const oldLines = ['header', 'old1', 'old2', 'footer'];
      const newLines = ['header', 'new1', 'new2', 'new3', 'footer'];
      const result = myersDiff(oldLines, newLines);

      expect(countOps(result).context).toBe(2); // header, footer
      expect(countOps(result).remove).toBe(2); // old1, old2
      expect(countOps(result).add).toBe(3); // new1, new2, new3

      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });
  });

  // ==================== 混合操作 ====================

  describe('混合操作', () => {
    it('DELETE + INSERT 在不同位置', () => {
      const oldLines = ['a', 'b', 'c', 'd', 'e'];
      const newLines = ['a', 'c', 'd', 'x', 'e'];
      // 删除 b，在 d 后插入 x
      const result = myersDiff(oldLines, newLines);

      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('多处 REPLACE', () => {
      const oldLines = ['a', 'b', 'c', 'd', 'e'];
      const newLines = ['a', 'x', 'c', 'y', 'e'];
      // b→x, d→y
      const result = myersDiff(oldLines, newLines);

      expect(countOps(result).context).toBe(3); // a, c, e
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });

    it('DELETE + REPLACE + INSERT 混合', () => {
      const oldLines = [
        'import React from "react";',
        'import { useState } from "react";',
        '',
        'function App() {',
        '  return <div>Hello</div>;',
        '}',
      ];
      const newLines = [
        'import React from "react";',
        '',
        'function App() {',
        '  const [count, setCount] = useState(0);',
        '  return <div>Count: {count}</div>;',
        '}',
        '',
        'export default App;',
      ];
      const result = myersDiff(oldLines, newLines);

      // 核心验证：重建正确
      expect(rebuildOld(result)).toEqual(oldLines);
      expect(rebuildNew(result)).toEqual(newLines);
    });
  });

  // ==================== 行号正确性 ====================

  describe('行号验证', () => {
    it('context 行应同时有 oldIdx 和 newIdx', () => {
      const result = myersDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
      for (const op of result) {
        expect(op.oldIdx).toBeDefined();
        expect(op.newIdx).toBeDefined();
      }
      expect(result[0]?.oldIdx).toBe(1);
      expect(result[0]?.newIdx).toBe(1);
      expect(result[2]?.oldIdx).toBe(3);
      expect(result[2]?.newIdx).toBe(3);
    });

    it('remove 行应有 oldIdx 无 newIdx', () => {
      const result = myersDiff(['a', 'b'], ['a']);
      const removed = result.filter((op) => op.type === 'remove');
      expect(removed).toHaveLength(1);
      expect(removed[0]?.oldIdx).toBeDefined();
      expect(removed[0]?.newIdx).toBeUndefined();
    });

    it('add 行应有 newIdx 无 oldIdx', () => {
      const result = myersDiff(['a'], ['a', 'b']);
      const added = result.filter((op) => op.type === 'add');
      expect(added).toHaveLength(1);
      expect(added[0]?.newIdx).toBeDefined();
      expect(added[0]?.oldIdx).toBeUndefined();
    });

    it('混合操作后行号应连续', () => {
      const result = myersDiff(['a', 'b', 'c'], ['a', 'x', 'c']);

      // 验证 oldIdx 连续
      const oldIdxList = result.filter((op) => op.oldIdx !== undefined).map((op) => op.oldIdx!);
      for (let i = 1; i < oldIdxList.length; i++) {
        expect(oldIdxList[i]).toBe(oldIdxList[i - 1]! + 1);
      }

      // 验证 newIdx 连续
      const newIdxList = result.filter((op) => op.newIdx !== undefined).map((op) => op.newIdx!);
      for (let i = 1; i < newIdxList.length; i++) {
        expect(newIdxList[i]).toBe(newIdxList[i - 1]! + 1);
      }
    });
  });

  // ==================== 最小编辑距离保证 ====================

  describe('最小编辑距离', () => {
    it('应产生最小数量的编辑操作', () => {
      // 只需替换一行，编辑距离应为 2（1 remove + 1 add）
      const result = myersDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
      const editCount = result.filter((op) => op.type !== 'context').length;
      expect(editCount).toBe(2);
    });

    it('相邻的相同行不应被误判为变更', () => {
      const oldLines = ['a', 'a', 'a'];
      const newLines = ['a', 'a'];
      const result = myersDiff(oldLines, newLines);

      // 应该只删除一行，保留两行
      expect(countOps(result).remove).toBe(1);
      expect(countOps(result).context).toBe(2);
    });
  });

  // ==================== 单行文件 ====================

  describe('边界场景', () => {
    it('单行相同', () => {
      const result = myersDiff(['hello'], ['hello']);
      expect(result).toHaveLength(1);
      expect(result[0]?.type).toBe('context');
    });

    it('单行不同', () => {
      const result = myersDiff(['hello'], ['world']);
      expect(countOps(result).remove).toBe(1);
      expect(countOps(result).add).toBe(1);
    });

    it('空行内容应被正确处理', () => {
      const oldLines = ['a', '', 'c'];
      const newLines = ['a', '', 'c'];
      const result = myersDiff(oldLines, newLines);
      expect(result).toHaveLength(3);
      expect(result[1]?.content).toBe('');
      expect(result[1]?.type).toBe('context');
    });
  });
});
