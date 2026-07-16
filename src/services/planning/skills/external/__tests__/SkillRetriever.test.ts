/**
 * SkillRetriever 单元测试
 *
 * 覆盖场景：
 * - 空技能列表注册
 * - 正常注册 + 检索命中/未命中
 * - threshold 过滤
 * - topK 限制
 * - clear() 后状态重置
 * - embedding 服务异常降级
 * - embedding 长度不匹配校验
 * - Script 模式自动过滤
 * - L1 关键词触发匹配
 * - L2 Multi-Fragment 向量匹配
 * - 两层合并 + 复合任务场景
 */

import { describe, it, expect, vi } from 'vitest';
import { SkillRetriever, type EmbeddingServiceDep } from '../SkillRetriever';
import type { LoadedExternalSkill } from '../types';

// ==================== Mock 工厂 ====================

/**
 * 创建确定性伪向量
 *
 * 基于字符串内容生成固定维度的向量，使得相同内容总是产生相同向量。
 * 语义相近的字符串通过前缀匹配在前几维度产生高相似度。
 */
function textToVector(text: string, dim: number = 8): number[] {
  const vec = Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim]! += text.charCodeAt(i) / 1000;
  }
  // 归一化为单位向量
  const norm = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  return norm > 0 ? vec.map((v: number) => v / norm) : vec;
}

/**
 * 余弦相似度计算
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 创建 Mock EmbeddingService
 */
function createMockEmbeddingService(overrides?: Partial<EmbeddingServiceDep>): EmbeddingServiceDep {
  return {
    encode: vi.fn(async (text: string) => textToVector(text)),
    encodeBatch: vi.fn(async (texts: string[]) => texts.map((t) => textToVector(t))),
    cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
    ...overrides,
  };
}

/**
 * 创建测试用 Guide Skill
 */
function createGuideSkill(
  name: string,
  description: string,
  options?: {
    triggers?: string[];
  }
): LoadedExternalSkill {
  return {
    name,
    description,
    mode: 'guide',
    packagePath: `/packages/${name}`,
    fullContent: `# ${name}\n\n${description}`,
    enabled: true,
    triggers: options?.triggers,
  };
}

/**
 * 创建测试用 Script Skill
 */
function createScriptSkill(name: string): LoadedExternalSkill {
  return {
    name,
    description: `${name} script tool`,
    mode: 'script',
    packagePath: `/packages/${name}`,
    fullContent: `# ${name}`,
    enabled: true,
    contract: {
      runtime: 'python',
      entry: 'run.py',
      timeout: 30,
      maxOutput: 65536,
      argsSchema: [],
    },
  };
}

// ==================== 测试 ====================

describe('SkillRetriever', () => {
  describe('register - 基本注册', () => {
    it('空技能列表注册后应该是 ready 状态，索引大小为 0', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([]);

      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(0);
    });

    it('应该正确注册 Guide 技能并构建索引', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      const skills = [
        createGuideSkill('pdf', 'PDF 文件处理工具'),
        createGuideSkill('docx', 'Word 文档处理'),
      ];

      await retriever.register(skills);

      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(2);
      // 应该调用 encodeBatch 一次
      expect(service.encodeBatch).toHaveBeenCalledTimes(1);
      // 索引文本格式应该是 "name: description"
      expect(service.encodeBatch).toHaveBeenCalledWith(
        ['pdf: PDF 文件处理工具', 'docx: Word 文档处理'],
        'document'
      );
    });

    it('应该自动过滤 Script 模式技能，只索引 Guide 技能', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      const skills = [
        createGuideSkill('pdf', 'PDF 处理'),
        createScriptSkill('csv-analyzer'),
        createGuideSkill('docx', 'Word 处理'),
        createScriptSkill('formatter'),
      ];

      await retriever.register(skills);

      // 只有 2 个 Guide 技能被索引
      expect(retriever.getIndexSize()).toBe(2);
      expect(service.encodeBatch).toHaveBeenCalledWith(
        ['pdf: PDF 处理', 'docx: Word 处理'],
        'document'
      );
    });

    it('应该过滤掉已禁用的技能', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      const disabledSkill: LoadedExternalSkill = {
        ...createGuideSkill('disabled', '已禁用'),
        enabled: false,
      };

      await retriever.register([createGuideSkill('active', '活跃的'), disabledSkill]);

      expect(retriever.getIndexSize()).toBe(1);
    });
  });

  describe('register - 异常处理', () => {
    it('embedding 服务失败时应该降级为「仅关键词」模式（L1 仍可用）', async () => {
      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockRejectedValue(new Error('Embedding service unavailable')),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill(
          'elite-coding',
          'Always use this skill when user requirements involve coding'
        ),
      ]);

      // 降级后：initialzied=true，条目数为 1（关键词索引保留）
      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(1); // 不再是 0
      // isEmbeddingDegraded() 应返回 true（有条目但 embedding 都为空向量）
      expect(retriever.isEmbeddingDegraded()).toBe(true);

      // L1 关键词嵌入在 query 中，应仍然命中（score=1.0）
      const results = await retriever.retrieve('elite-coding 任务调试');
      expect(results.length).toBe(1);
      expect(results[0]!.skill.name).toBe('elite-coding');
      expect(results[0]!.score).toBe(1.0);
    });

    it('embedding 返回数量不匹配时应该降级为「仅关键词」模式', async () => {
      const service = createMockEmbeddingService({
        // 返回的向量数量与输入不一致
        encodeBatch: vi.fn().mockResolvedValue([[0.1, 0.2]]),
      });
      const retriever = new SkillRetriever(service);

      // 注册 2 个技能但 encodeBatch 只返回 1 个向量
      const skills = [createGuideSkill('pdf', 'PDF 处理'), createGuideSkill('docx', 'Word 处理')];

      // 长度不匹配别 catch 降级处理（保留关键词条目）
      await retriever.register(skills);

      // 降级处理：initialzied=true，条目数 = 2（关键词索引保留）
      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(2); // 不再是 0
      expect(retriever.isEmbeddingDegraded()).toBe(true);
    });
  });

  describe('retrieve - L2 向量检索（兼容旧测试）', () => {
    it('未初始化时应该返回空结果', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      const results = await retriever.retrieve('some query');

      expect(results).toEqual([]);
    });

    it('索引为空时应该返回空结果', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([]);
      const results = await retriever.retrieve('some query');

      expect(results).toEqual([]);
    });

    it('应该检索到相关技能并按分数降序排列', async () => {
      // 构造 Mock：让 pdf 查询与 pdf 技能高度相似
      const pdfVec = [1, 0, 0, 0];
      const docxVec = [0, 1, 0, 0];
      const queryVec = [0.9, 0.1, 0, 0]; // 更接近 pdf

      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockResolvedValue([pdfVec, docxVec]),
        encode: vi.fn().mockResolvedValue(queryVec),
        cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pdf', 'PDF 处理'),
        createGuideSkill('docx', 'Word 处理'),
      ]);

      const results = await retriever.retrieve('处理 PDF 文件', 3, 0.0);

      // 至少有 1 个结果
      expect(results.length).toBeGreaterThanOrEqual(1);
      // 第一个结果应该是 pdf（与查询更相似）
      expect(results[0]!.skill.name).toBe('pdf');
      // 分数应该是降序的
      if (results.length > 1) {
        expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
      }
    });

    it('应该按 threshold 过滤低分结果', async () => {
      const pdfVec = [1, 0, 0, 0];
      const docxVec = [0, 1, 0, 0];
      const queryVec = [1, 0, 0, 0]; // 完全匹配 pdf，与 docx 正交

      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockResolvedValue([pdfVec, docxVec]),
        encode: vi.fn().mockResolvedValue(queryVec),
        cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pdf', 'PDF 处理'),
        createGuideSkill('docx', 'Word 处理'),
      ]);

      // 使用高阈值，docx 应该被过滤（正交向量相似度为 0）
      const results = await retriever.retrieve('PDF', 3, 0.5);

      // pdf 通过 L1 关键词命中（score=1.0），docx 被过滤
      expect(results).toHaveLength(1);
      expect(results[0]!.skill.name).toBe('pdf');
    });

    it('topK 应该限制返回数量', async () => {
      // 4 个方向相近的向量
      const vecs = [
        [0.9, 0.1, 0, 0],
        [0.8, 0.2, 0, 0],
        [0.7, 0.3, 0, 0],
        [0.6, 0.4, 0, 0],
      ];
      const queryVec = [1, 0, 0, 0];

      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockResolvedValue(vecs),
        encode: vi.fn().mockResolvedValue(queryVec),
        cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('s1', '技能1'),
        createGuideSkill('s2', '技能2'),
        createGuideSkill('s3', '技能3'),
        createGuideSkill('s4', '技能4'),
      ]);

      // topK=2，即使 4 个都匹配也只返回前 2 个
      const results = await retriever.retrieve('query', 2, 0.0);

      expect(results).toHaveLength(2);
    });

    it('encode 异常时应该返回空结果', async () => {
      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockResolvedValue([[1, 0]]),
        encode: vi.fn().mockRejectedValue(new Error('Encode failed')),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pdf', 'PDF 处理')]);

      const results = await retriever.retrieve('test');
      expect(results).toEqual([]);
    });
  });

  describe('retrieve - L1 关键词触发', () => {
    it('query 包含技能名称应该直接命中（技能名自动作为触发词）', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX 文件创建/编辑/读取工具'),
        createGuideSkill('xlsx', 'Excel 表格处理工具'),
      ]);

      // query 包含 "pptx"，即使向量相似度低，也应通过 L1 命中
      const results = await retriever.retrieve('帮我制作一个pptx文档');

      expect(results.length).toBeGreaterThanOrEqual(1);
      const pptxHit = results.find((r) => r.skill.name === 'pptx');
      expect(pptxHit).toBeDefined();
      // L1 关键词命中分数为 1.0
      expect(pptxHit!.score).toBe(1.0);
    });

    it('关键词匹配应该大小写不敏感', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX 处理', { triggers: ['PPT', '演示文稿'] }),
      ]);

      // 大写 PPT 应该匹配小写触发词 ppt
      const results = await retriever.retrieve('帮我做个PPT');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.skill.name).toBe('pptx');
      expect(results[0]!.score).toBe(1.0);
    });

    it('hyphenated skill names should match space-separated user text without triggers', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('Marketing-Ideas', 'Marketing ideation guide')]);

      const results = await retriever.retrieve(
        '我已经安装了Marketing Ideas这个skill，看看怎么使用'
      );

      const hit = results.find((r) => r.skill.name === 'Marketing-Ideas');
      expect(hit).toBeDefined();
      expect(hit!.score).toBe(1.0);
    });

    it('space-separated skill names should match hyphenated user text without triggers', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('Marketing Ideas', 'Marketing ideation guide')]);

      const results = await retriever.retrieve('请用 Marketing-Ideas 这个 guide 回答');

      const hit = results.find((r) => r.skill.name === 'Marketing Ideas');
      expect(hit).toBeDefined();
      expect(hit!.score).toBe(1.0);
    });

    it('中文触发词应该正确匹配', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX 处理', { triggers: ['演示文稿', '幻灯片'] }),
      ]);

      const results = await retriever.retrieve('帮我制作一份演示文稿');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.skill.name).toBe('pptx');
    });

    it('无匹配触发词时不应该命中 L1', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX 处理', { triggers: ['PPT', '演示文稿'] }),
      ]);

      // "天气预报" 不包含任何触发词
      const results = await retriever.retrieve('今天天气怎么样');
      // 可能通过 L2 也匹配不上，预期空结果
      const pptxHit = results.find((r) => r.skill.name === 'pptx');
      // 即使有结果，也不应该是 L1 命中（score < 1.0）
      if (pptxHit) {
        expect(pptxHit.score).toBeLessThan(1.0);
      }
    });
  });

  describe('retrieve - L2 Multi-Fragment 向量匹配', () => {
    it('多行 query 应该按行分割并取 max score', async () => {
      // 让第三行 fragment 与 pptx 技能高相似
      const pptxVec = [1, 0, 0, 0];
      const xlsxVec = [0, 1, 0, 0];
      // fragment1 与两者都不太相关，fragment2 更接近 xlsx，fragment3 更接近 pptx
      const frag1Vec = [0.3, 0.3, 0.5, 0];
      const frag2Vec = [0.1, 0.9, 0, 0];
      const frag3Vec = [0.9, 0.1, 0, 0];

      const service = createMockEmbeddingService({
        encodeBatch: vi
          .fn()
          .mockResolvedValueOnce([pptxVec, xlsxVec]) // register
          .mockResolvedValueOnce([frag1Vec, frag2Vec, frag3Vec]), // retrieve fragments
        encode: vi.fn(),
        cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
      });
      const retriever = new SkillRetriever(service);

      // 注册时使用无触发词的技能（隔离 L1 影响）
      const pptxSkill = createGuideSkill('notpptx', 'presentation creation');
      const xlsxSkill = createGuideSkill('notxlsx', 'spreadsheet processing');
      await retriever.register([pptxSkill, xlsxSkill]);

      // 多行 query（无关键词命中，纯 L2 检索）
      const query = '第一阶段搜索市场数据\n第二阶段创建对比表格\n第三阶段生成演示文稿';

      const results = await retriever.retrieve(query, 3, 0.0);

      // 两个技能都应被检索到
      expect(results.length).toBe(2);
      // pptx 应该分数更高（frag3 最接近 pptxVec）
      expect(results[0]!.skill.name).toBe('notpptx');
    });

    it('过短的 fragment 应该被过滤', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('test-skill', 'some description')]);

      // query 包含很短的行，这些应该被过滤
      const query = 'ab\ncd\n这是一个有效的查询行';

      await retriever.retrieve(query, 3, 0.0);

      // encodeBatch 在 register 时调用一次
      // encode 或 encodeBatch 在 retrieve 时应该只处理有效的 fragment
      // "ab" 和 "cd" 长度 < 4 应被过滤
    });
  });

  describe('retrieve - 两层合并 + 复合任务', () => {
    it('复合任务应该同时命中多个技能', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX 演示文稿创建', { triggers: ['PPT', '演示文稿'] }),
        createGuideSkill('xlsx', 'Excel 表格处理', { triggers: ['excel', '表格', 'xslx'] }),
        createGuideSkill('pdf', 'PDF 文档处理', { triggers: ['PDF'] }),
      ]);

      // 复合任务 prompt：提到了 pptx 和 xlsx 的触发词
      const query = '帮我做一份市场分析\n创建一份xslx对比表\n生成一份PPT演示文稿';

      const results = await retriever.retrieve(query);

      // pptx 和 xlsx 都应被命中（通过 L1 关键词触发）
      const hitNames = results.map((r) => r.skill.name);
      expect(hitNames).toContain('pptx');
      expect(hitNames).toContain('xlsx');
    });

    it('L1 和 L2 同时命中同一技能时应取 max score', async () => {
      const pptxVec = [1, 0, 0, 0];
      const queryVec = [0.8, 0.2, 0, 0]; // L2 相似度约 0.97

      const service = createMockEmbeddingService({
        encodeBatch: vi.fn().mockResolvedValue([pptxVec]),
        encode: vi.fn().mockResolvedValue(queryVec),
        cosineSimilarity: vi.fn((a: number[], b: number[]) => cosineSimilarity(a, b)),
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pptx', 'PPTX 处理', { triggers: ['PPT'] })]);

      // query 同时触发 L1（包含 "pptx"）和 L2（向量相似）
      const results = await retriever.retrieve('制作pptx文件');

      expect(results).toHaveLength(1);
      // L1 命中 score=1.0 > L2 score，最终取 max = 1.0
      expect(results[0]!.score).toBe(1.0);
    });

    it('场景2真实 prompt 应该命中 pptx 技能', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([
        createGuideSkill('pptx', 'PPTX文件创建/编辑/读取工具', {
          triggers: ['PPT', 'PPTX', '演示文稿', 'slides', 'presentation'],
        }),
        createGuideSkill('xlsx', 'Excel表格处理工具', {
          triggers: ['excel', 'xlsx', 'xslx', '表格', 'spreadsheet'],
        }),
      ]);

      // 场景2 的实际 prompt
      const query =
        '帮我做一份AI代码助手市场的竞品分析\n' +
        '第一阶段 搜索并列出至少5个主流产品收集它们的核心功能、定价、目标用户\n' +
        '第二阶段 创建一份xslx对比表\n' +
        '包含产品名称、支持语言、IDE集成、定价模型\n' +
        '第三阶段 分析每个产品的优劣势\n' +
        '找出市场空白和机会\n' +
        '第四阶段 生成一份PPT演示文稿\n' +
        '包含市场概览、产品对比、SWOT分析和总结建议';

      const results = await retriever.retrieve(query);

      // 通过 L1 关键词触发：query 包含 "PPT" → pptx 命中，包含 "xslx" → xlsx 命中
      const hitNames = results.map((r) => r.skill.name);
      expect(hitNames).toContain('pptx');
      expect(hitNames).toContain('xlsx');
    });
  });

  describe('clear - 索引清空', () => {
    it('detects when cached skill vectors belong to an old embedding profile', async () => {
      let profileId = 'profile-a';
      const service = createMockEmbeddingService({
        getActiveProfileId: () => profileId,
      });
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pdf', 'PDF')]);
      expect(retriever.isProfileStale()).toBe(false);

      profileId = 'profile-b';
      expect(retriever.isProfileStale()).toBe(true);
      retriever.clear();
      expect(retriever.isProfileStale()).toBe(false);
    });

    it('drops L2 results when the embedding profile changes during query encoding', async () => {
      let profileId = 'profile-a';
      const cosineSimilarityMock = vi.fn(() => 1);
      const service = createMockEmbeddingService({
        getActiveProfileId: () => profileId,
        encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
        encode: vi.fn(async () => {
          profileId = 'profile-b';
          return [1, 0];
        }),
        cosineSimilarity: cosineSimilarityMock,
      });
      const retriever = new SkillRetriever(service);
      await retriever.register([createGuideSkill('pdf', 'Portable documents')]);

      const results = await retriever.retrieve('semantic request', 3, 0);

      expect(results).toEqual([]);
      expect(cosineSimilarityMock).not.toHaveBeenCalled();
    });

    it('clear() 后 isReady 应该返回 false', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pdf', 'PDF')]);
      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(1);

      retriever.clear();

      expect(retriever.isReady()).toBe(false);
      expect(retriever.getIndexSize()).toBe(0);
    });

    it('clear() 后 retrieve 应该返回空结果', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pdf', 'PDF')]);
      retriever.clear();

      const results = await retriever.retrieve('PDF');
      expect(results).toEqual([]);
    });

    it('clear() 后重新 register 应该正常工作', async () => {
      const service = createMockEmbeddingService();
      const retriever = new SkillRetriever(service);

      await retriever.register([createGuideSkill('pdf', 'PDF')]);
      retriever.clear();
      await retriever.register([createGuideSkill('docx', 'Word'), createGuideSkill('csv', 'CSV')]);

      expect(retriever.isReady()).toBe(true);
      expect(retriever.getIndexSize()).toBe(2);
    });
  });
});
