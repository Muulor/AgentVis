/**
 * LruCache 单元测试
 *
 * 验证 LRU 缓存的核心行为：
 * - 基本 get/set/delete/clear 操作
 * - 容量超限时自动淘汰最旧条目
 * - get 操作将条目提升为最新（避免被淘汰）
 * - deleteWhere 按条件批量删除
 * - 边界情况处理
 */

import { describe, it, expect } from 'vitest';
import { LruCache } from '../LruCache';

describe('LruCache', () => {
  describe('基本操作', () => {
    it('set/get 正常读写', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('get 不存在的 key 返回 undefined', () => {
      const cache = new LruCache<string, number>(10);
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('has 正确判断 key 存在性', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });

    it('delete 成功删除条目', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('clear 清空所有缓存', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('size 返回正确数量', () => {
      const cache = new LruCache<string, number>(10);
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('values returns cached values without changing LRU order', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      expect(cache.values()).toEqual([1, 2, 3]);

      cache.set('d', 4);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.values()).toEqual([2, 3, 4]);
    });
  });

  describe('LRU 淘汰策略', () => {
    it('容量超限时淘汰最旧条目', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // 容量为 3，再插入一个应淘汰 'a'（最旧）
      cache.set('d', 4);
      expect(cache.size).toBe(3);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    it('get 操作将条目提升为最新，避免被淘汰', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // 访问 'a' 将其提升为最新
      cache.get('a');

      // 再插入 'd'，应淘汰 'b'（此时最旧）而非 'a'
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
    });

    it('set 已存在的 key 会更新值并提升为最新', () => {
      const cache = new LruCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // 更新 'a' 的值，提升为最新
      cache.set('a', 100);
      expect(cache.get('a')).toBe(100);

      // 再插入 'd'，应淘汰 'b' 而非 'a'
      cache.set('d', 4);
      expect(cache.get('a')).toBe(100);
      expect(cache.get('b')).toBeUndefined();
    });
  });

  describe('deleteWhere 批量删除', () => {
    it('按条件删除匹配条目', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);

      // 删除所有偶数值
      const count = cache.deleteWhere((_key, value) => value % 2 === 0);
      expect(count).toBe(2);
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBeUndefined();
    });

    it('无匹配时返回 0', () => {
      const cache = new LruCache<string, number>(10);
      cache.set('a', 1);
      const count = cache.deleteWhere(() => false);
      expect(count).toBe(0);
      expect(cache.size).toBe(1);
    });
  });

  describe('边界情况', () => {
    it('maxSize = 1 时只保留最新条目', () => {
      const cache = new LruCache<string, number>(1);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size).toBe(1);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
    });

    it('maxSize < 1 时构造函数抛出错误', () => {
      expect(() => new LruCache<string, number>(0)).toThrow();
      expect(() => new LruCache<string, number>(-1)).toThrow();
    });
  });
});
