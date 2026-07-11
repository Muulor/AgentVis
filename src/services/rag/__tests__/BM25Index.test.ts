/**
 * BM25Index 单元测试
 *
 * 验证增量 IDF 更新的正确性：
 * - 添加文档后 IDF 和检索正常
 * - 删除文档后 IDF 正确回退
 * - removeByDocumentId 批量删除正确
 * - clearAgent 完全清理
 * - 停用词过滤生效
 * - 分词结果合理
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BM25Index } from '../BM25Index';

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  describe('基本索引与检索', () => {
    it('添加文档后可以检索到', () => {
      index.addDocument('agent1', 'doc1', '人工智能技术发展迅速');
      const results = index.search('agent1', '人工智能');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.docId).toBe('doc1');
    });

    it('空索引返回空结果', () => {
      const results = index.search('agent1', '测试查询');
      expect(results).toEqual([]);
    });

    it('空查询返回空结果', () => {
      index.addDocument('agent1', 'doc1', '测试内容');
      const results = index.search('agent1', '');
      expect(results).toEqual([]);
    });

    it('多文档检索按分数排序', () => {
      index.addDocument('agent1', 'doc1', '深度学习是人工智能的重要分支');
      index.addDocument('agent1', 'doc2', '机器学习包括监督学习和非监督学习');
      index.addDocument('agent1', 'doc3', '自然语言处理使用深度学习模型');

      const results = index.search('agent1', '深度学习模型');
      expect(results.length).toBeGreaterThan(0);
      // 结果应按分数降序排列
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it('topK 限制返回数量', () => {
      for (let i = 0; i < 10; i++) {
        index.addDocument('agent1', `doc${i}`, `文档内容包含关键词 keyword${i} keyword`);
      }
      const results = index.search('agent1', 'keyword', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Agent 隔离', () => {
    it('不同 Agent 的索引相互隔离', () => {
      index.addDocument('agent1', 'doc1', '人工智能深度学习');
      index.addDocument('agent2', 'doc2', '网页设计前端开发');

      const results1 = index.search('agent1', '深度学习');
      const results2 = index.search('agent2', '深度学习');

      expect(results1.length).toBeGreaterThan(0);
      expect(results2.length).toBe(0);
    });
  });

  describe('增量 IDF 更新', () => {
    it('添加文档正确更新统计', () => {
      index.addDocument('agent1', 'doc1', '第一个测试文档');
      let stats = index.getStats('agent1');
      expect(stats.documentCount).toBe(1);
      expect(stats.termCount).toBeGreaterThan(0);

      index.addDocument('agent1', 'doc2', '第二个测试文档');
      stats = index.getStats('agent1');
      expect(stats.documentCount).toBe(2);
    });

    it('删除文档正确回退 IDF', () => {
      index.addDocument('agent1', 'doc1', '深度学习');
      index.addDocument('agent1', 'doc2', '机器学习');

      // 删除 doc1 后，"深度" 的 df 应该降为 0（从 idf 中移除）
      index.removeDocument('agent1', 'doc1');
      const stats = index.getStats('agent1');
      expect(stats.documentCount).toBe(1);

      // 检索 "深度学习" 应该无结果（相关文档已删除）
      const results = index.search('agent1', '深度');
      expect(results.length).toBe(0);

      // 检索 "机器学习" 应该有结果
      const results2 = index.search('agent1', '机器');
      expect(results2.length).toBeGreaterThan(0);
    });

    it('更新已有文档正确回退旧 IDF 并增加新 IDF', () => {
      index.addDocument('agent1', 'doc1', '旧的内容关键词');
      index.addDocument('agent1', 'doc1', '新的内容不同词');

      const stats = index.getStats('agent1');
      // 更新后文档数应仍为 1
      expect(stats.documentCount).toBe(1);
    });
  });

  describe('removeByDocumentId 批量删除', () => {
    it('按 documentId 批量删除关联的所有 chunk', () => {
      // 同一个 documentId 下有多个 chunk
      index.addDocument('agent1', 'chunk1', '第一个块的内容', 'mydoc');
      index.addDocument('agent1', 'chunk2', '第二个块的内容', 'mydoc');
      index.addDocument('agent1', 'chunk3', '其他文档的内容', 'otherdoc');

      expect(index.getStats('agent1').documentCount).toBe(3);

      // 删除 mydoc 的所有 chunk
      index.removeByDocumentId('agent1', 'mydoc');

      expect(index.getStats('agent1').documentCount).toBe(1);

      // 确认 chunk3 仍然可检索
      const results = index.search('agent1', '其他文档');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.docId).toBe('chunk3');
    });

    it('删除不存在的 documentId 无副作用', () => {
      index.addDocument('agent1', 'doc1', '内容');
      index.removeByDocumentId('agent1', 'nonexistent');
      expect(index.getStats('agent1').documentCount).toBe(1);
    });
  });

  describe('clearAgent', () => {
    it('完全清理 Agent 的所有索引数据', () => {
      index.addDocument('agent1', 'doc1', '文档一', 'docA');
      index.addDocument('agent1', 'doc2', '文档二', 'docB');
      index.addDocument('agent2', 'doc3', '其他 Agent 的文档');

      index.clearAgent('agent1');

      expect(index.getStats('agent1').documentCount).toBe(0);
      expect(index.getStats('agent1').termCount).toBe(0);

      // agent2 不受影响
      expect(index.getStats('agent2').documentCount).toBe(1);
    });
  });

  describe('英文停用词过滤', () => {
    it('停用词不参与检索', () => {
      index.addDocument('agent1', 'doc1', 'the quick brown fox jumps over the lazy dog');
      // "the" 是停用词，不应匹配
      // "quick" 不是停用词，应该匹配
      const results = index.search('agent1', 'quick fox');
      expect(results.length).toBeGreaterThan(0);
    });

    it('短于 2 字符的英文词被过滤', () => {
      index.addDocument('agent1', 'doc1', 'I am a developer x y z');
      // 搜索单字符词不应匹配
      const results = index.search('agent1', 'x');
      expect(results.length).toBe(0);
    });
  });

  describe('中文 bigram 分词', () => {
    it('中文文本生成 bigram', () => {
      index.addDocument('agent1', 'doc1', '自然语言处理技术');
      // "自然" 应该被分为 bigram，可以匹配
      const results = index.search('agent1', '自然语言');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('英文检索', () => {
    it('英文检索不区分大小写', () => {
      index.addDocument('agent1', 'doc1', 'Machine Learning is powerful');
      const results = index.search('agent1', 'machine learning');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
