/**
 * SkillRetriever - 两层混合检索 Guide 技能检索器
 *
 * 独立于 RagService 的内存级检索组件。
 * 在启动时对所有 Guide 模式技能的 name+description 进行 embedding，
 * 运行时根据用户意图语义检索 Top-K 最相关的技能注入 Master Brain。
 *
 * 两层检索策略：
 * - L1 关键词触发：query 包含技能的 triggers 关键词 → 确定性直接命中
 * - L2 Multi-Fragment 向量：query 按行分割为 fragment，
 *   每个 fragment 独立与技能 embedding 计算相似度，取 max score
 *
 * 设计理念：
 * - 与 RagService 解耦，避免 agentId 命名空间污染
 * - 技能数量通常 < 50，内存级检索即可
 * - L1 层解决关键词确定性匹配（如 "pptx" → pptx 技能）
 * - L2 层解决长文本 embedding 平均化问题（multi-fragment 取 max）
 * - 复用全局 embeddingService 单例
 */

import type { LoadedExternalSkill } from './types';
import { getLogger } from '@services/logger';
import type { EmbeddingPurpose } from '@/types/rag';

const logger = getLogger('SkillRetriever');

// ==================== 类型定义 ====================

/**
 * 内部索引条目
 *
 * 存储技能元信息、embedding 向量和关键词触发列表
 */
interface SkillEmbeddingEntry {
  /** 技能引用 */
  skill: LoadedExternalSkill;
  /** name + description 拼接文本的 embedding 向量 */
  embedding: number[];
  /** 规范化后的关键词触发列表（全部小写，用于 L1 匹配） */
  normalizedTriggers: string[];
  /** 将标点/连字符统一为空格后的触发词，用于名称等价匹配 */
  canonicalTriggers: string[];
  /** 多词触发词移除分隔符后的紧凑形式，用于 marketingideas 这类输入 */
  compactTriggers: string[];
}

/**
 * 检索结果
 *
 * 包含命中的技能及其与查询的相似度分数
 */
export interface SkillRetrievalResult {
  /** 命中的技能 */
  skill: LoadedExternalSkill;
  /** 综合匹配分数：关键词命中为 1.0，向量匹配为余弦相似度 (0~1) */
  score: number;
}

// ==================== Embedding 服务接口 ====================

/**
 * Embedding 服务依赖接口
 *
 * 通过接口抽象避免直接依赖具体实现，便于测试 mock
 */
export interface EmbeddingServiceDep {
  /** 将单个文本编码为向量 */
  encode(text: string, purpose?: EmbeddingPurpose): Promise<number[]>;
  /** 批量编码文本为向量 */
  encodeBatch(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
  /** 计算余弦相似度 */
  cosineSimilarity(a: number[], b: number[]): number;
  /** 当前向量语义空间标识；旧 mock/适配器可不提供。 */
  getActiveProfileId?(): string;
}

// ==================== 常量 ====================

/** 默认检索返回数量 */
const DEFAULT_TOP_K = 3;

/** 默认相似度阈值（L2 向量检索层） */
const DEFAULT_THRESHOLD = 0.85;

/** L1 关键词命中的固定分数（最高优先级） */
const KEYWORD_HIT_SCORE = 1.0;

/** 多片段检索时的最大 fragment 数量，限制批量 embedding 成本 */
const MAX_FRAGMENTS = 8;

/** fragment 最小有效长度（字符数），过短的 fragment 语义不完整 */
const MIN_FRAGMENT_LENGTH = 4;

/** 空 embedding 向量（embedding 失败降级时使用，L2 向量检索将不命中此条目，L1 关键词仍有效） */
const EMPTY_EMBEDDING: number[] = [];

function normalizeSkillMatchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/([\u3400-\u9FFF])([a-z0-9])/g, '$1 $2')
    .replace(/([a-z0-9])([\u3400-\u9FFF])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactSkillMatchText(text: string): string {
  return normalizeSkillMatchText(text).replace(/\s+/g, '');
}

function containsCanonicalTrigger(query: string, trigger: string): boolean {
  if (!query || !trigger) return false;
  return ` ${query} `.includes(` ${trigger} `);
}

// ==================== SkillRetriever 实现 ====================

/**
 * Guide 技能两层混合检索器
 *
 * 生命周期：
 * 1. 应用启动 → ExternalSkillRegistryLoader.loadAll()
 * 2. 加载完成 → skillRetriever.register(guideSkills)（批量 embedding + 关键词索引）
 * 3. 每次用户消息 → skillRetriever.retrieve(userQuery, topK)（L1 + L2 检索）
 */
export class SkillRetriever {
  /** 内部索引 */
  private entries: SkillEmbeddingEntry[] = [];

  /** 是否已完成注册 */
  private initialized = false;

  /** 构建当前内存索引时使用的 embedding profile。 */
  private indexedProfileId: string | null = null;

  /**
   * @param embeddingService Embedding 服务（依赖注入）
   */
  constructor(private readonly embeddingService: EmbeddingServiceDep) {}

  /**
   * 注册技能列表并构建内存索引
   *
   * 仅过滤 mode === 'guide' 的技能，对其 name+description
   * 进行批量 embedding，同时构建关键词触发索引。
   *
   * 索引文本使用 `name: description` 而非 fullContent，
   * 因为 description 是意图级语义摘要，与用户查询的语义空间更对齐；
   * fullContent 偏向实现细节（工作流步骤），向量检索时反而引入噪声。
   *
   * @param skills - 已加载的外部技能列表（可包含 Script 模式，会自动过滤）
   */
  async register(skills: LoadedExternalSkill[]): Promise<void> {
    // 仅索引 Guide 模式且已启用的技能
    const guideSkills = skills.filter((s) => s.mode === 'guide' && s.enabled);

    if (guideSkills.length === 0) {
      this.entries = [];
      this.initialized = true;
      this.indexedProfileId = this.embeddingService.getActiveProfileId?.() ?? null;
      logger.trace('[SkillRetriever] 无 Guide 技能需要索引');
      return;
    }

    // 构建索引文本：name + description（意图级摘要）
    const indexTexts = guideSkills.map((s) => `${s.name}: ${s.description}`);

    try {
      const profileAtStart = this.embeddingService.getActiveProfileId?.() ?? null;
      // 批量 embedding（一次性网络调用，启动时仅执行一次）
      const embeddings = await this.embeddingService.encodeBatch(indexTexts, 'document');

      // 校验 embedding 返回数量与技能数量是否对齐，防止部分失败导致索引错位
      if (embeddings.length !== guideSkills.length) {
        throw new Error(
          `Embedding result count (${embeddings.length}) does not match skill count (${guideSkills.length})`
        );
      }
      if (
        profileAtStart !== null &&
        this.embeddingService.getActiveProfileId?.() !== profileAtStart
      ) {
        throw new Error('RAG_EMBEDDING_PROFILE_CHANGED_DURING_SKILL_INDEX');
      }

      this.entries = guideSkills.map((skill, i) => ({
        skill,
        embedding: embeddings[i] ?? [],
        // 构建规范化触发词列表：技能名称始终作为触发词 + frontmatter 声明的 triggers
        ...this.buildTriggerIndex(skill),
      }));

      this.initialized = true;
      this.indexedProfileId = profileAtStart;

      logger.trace('[SkillRetriever] 索引构建完成:', {
        skillCount: guideSkills.length,
        indexTexts: indexTexts.map((t) => t.substring(0, 60)),
      });
    } catch {
      // embedding 失败时降级为「仅关键词」索引（L1 可用，L2 向量检索不可用）
      // 原因：让 L1 关键词触发（如技能名精确命中）仍然有效，而不是完全返回空列表；
      // 使用 EMPTY_EMBEDDING 空向量，L2 cosineSimilarity 在零向量时会得到 0，不会超过阈值
      logger.error('[SkillRetriever] Embedding 失败，降级为仅关键词索引（L1 仍可用）');
      this.entries = guideSkills.map((skill) => ({
        skill,
        embedding: EMPTY_EMBEDDING,
        ...this.buildTriggerIndex(skill),
      }));
      this.initialized = true;
      this.indexedProfileId = null;
    }
  }

  /**
   * 检索与用户意图最相关的 Guide 技能
   *
   * 两层检索策略：
   * - L1：关键词精确触发（确定性，零延迟）
   * - L2：Multi-Fragment 向量匹配（语义级，需 embedding 调用）
   * - 合并去重后按分数降序返回 topK 结果
   *
   * @param query - 用户查询文本（通常是 userIntent.explicit）
   * @param topK - 最多返回几个技能
   * @param threshold - L2 向量匹配的最低相似度阈值
   * @returns 按分数降序排列的检索结果
   */
  async retrieve(
    query: string,
    topK: number = DEFAULT_TOP_K,
    threshold: number = DEFAULT_THRESHOLD
  ): Promise<SkillRetrievalResult[]> {
    if (!this.initialized || this.entries.length === 0) {
      // 未初始化或索引为空时静默退出，打印日志便于排查时序问题
      logger.trace('[SkillRetriever] retrieve() 早期退出（未就绪）:', {
        initialized: this.initialized,
        entriesCount: this.entries.length,
        query: query.substring(0, 60),
      });
      return [];
    }

    // L1：关键词精确匹配（纯字符串操作，不会抛异常）
    const keywordHits = this.keywordMatch(query);

    // L2：多片段向量匹配（依赖 embedding，可能失败）
    // 独立 try-catch 隔离 L2 故障，确保 L1 结果不被丢弃
    let vectorHits: SkillRetrievalResult[] = [];
    try {
      vectorHits = await this.multiFragmentVectorMatch(query, threshold);
    } catch {
      // L2 失败时降级为仅 L1 结果，不中断主流程
      logger.warn('[SkillRetriever] L2 向量检索失败，降级为仅 L1 关键词结果');
    }

    // 合并两层结果：同一技能取 max score
    const merged = this.mergeResults(keywordHits, vectorHits);

    // 按分数降序排列并截取 topK
    const results = merged.sort((a, b) => b.score - a.score).slice(0, topK);

    if (results.length > 0) {
      logger.trace('[SkillRetriever] 检索命中:', {
        query: query.substring(0, 80),
        hits: results.map((r) => `${r.skill.name}(${r.score.toFixed(2)})`),
      });
    } else {
      // 无命中时打印日志，帮助区分「L1/L2 都未匹配」和「未调用检索」两种情况
      logger.trace('[SkillRetriever] 检索无命中:', {
        query: query.substring(0, 80),
        threshold,
        indexedSkills: this.entries.map((e) => e.skill.name),
      });
    }

    return results;
  }

  /**
   * 是否已完成索引构建
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * 是否处于 embedding 降级状态
   *
   * embedding 失败降级时，条目存在但所有向量为空（L1 可用，L2 不可用）。
   * 由 AgentLoop.ensureSkillRetriever() 用于判断是否需要在下次请求时重试 embedding。
   *
   * @returns true 表示有条目但所有 embedding 为空向量（降级状态）
   */
  isEmbeddingDegraded(): boolean {
    if (this.entries.length === 0) return false;
    // 所有条目的 embedding 都为空向量时，判定为降级状态
    return this.entries.every((e) => e.embedding.length === 0);
  }

  /** Whether the cached vectors belong to a previous active embedding profile. */
  isProfileStale(): boolean {
    const activeProfileId = this.embeddingService.getActiveProfileId?.();
    return Boolean(
      this.initialized &&
      this.indexedProfileId &&
      activeProfileId &&
      this.indexedProfileId !== activeProfileId
    );
  }

  /**
   * 获取当前索引的技能数量
   */
  getIndexSize(): number {
    return this.entries.length;
  }

  /**
   * 清空索引（技能热更新时调用）
   *
   * 清空后需重新调用 register() 重建索引
   */
  clear(): void {
    this.entries = [];
    this.initialized = false;
    this.indexedProfileId = null;
    logger.trace('[SkillRetriever] 索引已清空');
  }

  /**
   * 重置初始化状态（embedding 失败后允许外部重试）
   *
   * 与 clear() 区别：不清空已有的关键词条目（L1 仍可用），
   * 仅将 initialized 重置为 false，使 register() 可以被再次调用以重建 embedding 索引。
   * 由 AgentLoop.ensureSkillRetriever() 在 embedding 降级时调用。
   */
  resetInitialized(): void {
    this.initialized = false;
    logger.trace('[SkillRetriever] 初始化状态已重置，下次 register() 将重新构建 embedding 索引');
  }

  // ==================== L1：关键词精确匹配 ====================

  /**
   * L1 关键词触发检索
   *
   * 将 query 转小写后检查是否包含任一技能的触发词。
   * 关键词命中是确定性的，不依赖 embedding，score 固定为 1.0。
   *
   * @param query - 用户查询文本
   * @returns 关键词命中的检索结果
   */
  private keywordMatch(query: string): SkillRetrievalResult[] {
    const queryLower = query.toLowerCase();
    const canonicalQuery = normalizeSkillMatchText(query);
    const compactQuery = compactSkillMatchText(query);
    const results: SkillRetrievalResult[] = [];

    for (const entry of this.entries) {
      // 遍历当前技能的所有触发词，只要任一匹配即命中
      const isRawHit = entry.normalizedTriggers.some((trigger) => queryLower.includes(trigger));
      const isCanonicalHit = entry.canonicalTriggers.some((trigger) =>
        containsCanonicalTrigger(canonicalQuery, trigger)
      );
      const isCompactHit = entry.compactTriggers.some((trigger) => compactQuery.includes(trigger));
      const isHit = isRawHit || isCanonicalHit || isCompactHit;

      if (isHit) {
        results.push({
          skill: entry.skill,
          score: KEYWORD_HIT_SCORE,
        });
      }
    }

    return results;
  }

  // ==================== L2：Multi-Fragment 向量匹配 ====================

  /**
   * L2 多片段向量检索
   *
   * 将 query 按换行符分割为 fragments，过滤过短的无效 fragment，
   * 对每个 fragment 独立 embedding 后与各技能向量计算余弦相似度，
   * 每个技能取所有 fragment 中的最高分。
   *
   * 这解决了长文本 embedding 被语义平均化导致与任何单一技能都不相似的问题。
   *
   * @param query - 用户查询文本
   * @param threshold - 最低相似度阈值
   * @returns 向量匹配的检索结果
   */
  private async multiFragmentVectorMatch(
    query: string,
    threshold: number
  ): Promise<SkillRetrievalResult[]> {
    // 降级状态时跳过 L2：所有 entries 的 embedding 都为空向量，
    // 编码 query 无意义且会触发 API 调用失败，直接返回空结果
    if (this.isEmbeddingDegraded()) {
      return [];
    }

    // 将 query 分割为 fragments
    const fragments = this.splitQueryToFragments(query);

    if (fragments.length === 0) {
      return [];
    }

    const profileAtStart = this.embeddingService.getActiveProfileId?.() ?? null;
    if (
      this.indexedProfileId !== null &&
      profileAtStart !== null &&
      this.indexedProfileId !== profileAtStart
    ) {
      throw new Error('RAG_EMBEDDING_PROFILE_CHANGED_DURING_SKILL_RETRIEVAL');
    }

    // 批量 encode 所有 fragments（单次 API 调用）
    const fragmentEmbeddings =
      fragments.length === 1
        ? [await this.embeddingService.encode(fragments[0] ?? '', 'query')]
        : await this.embeddingService.encodeBatch(fragments, 'query');
    if (
      profileAtStart !== null &&
      (this.embeddingService.getActiveProfileId?.() ?? null) !== profileAtStart
    ) {
      throw new Error('RAG_EMBEDDING_PROFILE_CHANGED_DURING_SKILL_RETRIEVAL');
    }

    // 对每个技能，计算所有 fragment 的 max score
    const results: SkillRetrievalResult[] = [];

    for (const entry of this.entries) {
      // embedding 失败降级时 entry.embedding 为空向量，跳过 L2 计算（L1 关键词仍可命中）
      if (entry.embedding.length === 0) continue;

      let maxScore = 0;

      for (const fragEmb of fragmentEmbeddings) {
        const score = this.embeddingService.cosineSimilarity(fragEmb, entry.embedding);
        if (score > maxScore) {
          maxScore = score;
        }
      }

      if (maxScore >= threshold) {
        results.push({
          skill: entry.skill,
          score: maxScore,
        });
      }
    }

    return results;
  }

  /**
   * 将查询文本分割为语义有效的 fragments
   *
   * 分割规则：
   * 1. 按换行符分割
   * 2. 过滤过短的 fragment（< MIN_FRAGMENT_LENGTH 字符）
   * 3. 限制最大 fragment 数量（MAX_FRAGMENTS）
   * 4. 如果分割后无有效 fragment，使用原始 query 作为单个 fragment
   *
   * @param query - 原始查询文本
   * @returns 有效的 fragment 列表
   */
  private splitQueryToFragments(query: string): string[] {
    const rawFragments = query
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= MIN_FRAGMENT_LENGTH);

    // 如果分割后无有效 fragment，回退为单个整体 query
    if (rawFragments.length === 0) {
      return query.trim().length > 0 ? [query.trim()] : [];
    }

    // 限制最大 fragment 数量，避免 embedding 调用开销过大
    return rawFragments.slice(0, MAX_FRAGMENTS);
  }

  // ==================== 结果合并 ====================

  /**
   * 合并 L1 和 L2 的检索结果
   *
   * 同一技能在两层都命中时取 max score（L1 关键词 score=1.0 优先）
   *
   * @param keywordHits - L1 关键词命中
   * @param vectorHits - L2 向量匹配命中
   * @returns 去重合并后的结果
   */
  private mergeResults(
    keywordHits: SkillRetrievalResult[],
    vectorHits: SkillRetrievalResult[]
  ): SkillRetrievalResult[] {
    // 使用 Map 按技能名称去重，取 max score
    const mergedMap = new Map<string, SkillRetrievalResult>();

    for (const hit of keywordHits) {
      mergedMap.set(hit.skill.name, hit);
    }

    for (const hit of vectorHits) {
      const existing = mergedMap.get(hit.skill.name);
      if (!existing || hit.score > existing.score) {
        mergedMap.set(hit.skill.name, hit);
      }
    }

    return Array.from(mergedMap.values());
  }

  // ==================== 工具方法 ====================

  /**
   * 构建规范化的触发词列表
   *
   * 自动将技能名称作为触发词（无需在 frontmatter 中重复声明），
   * 合并 frontmatter 声明的 triggers 后统一转小写。
   *
   * @param skill - 技能定义
   * @returns 规范化后的触发词列表（全部小写，无重复）
   */
  private buildTriggerIndex(
    skill: LoadedExternalSkill
  ): Pick<SkillEmbeddingEntry, 'normalizedTriggers' | 'canonicalTriggers' | 'compactTriggers'> {
    const normalizedSet = new Set<string>();
    const canonicalSet = new Set<string>();
    const compactSet = new Set<string>();

    const addTrigger = (rawTrigger: string): void => {
      const normalized = rawTrigger.toLowerCase().trim();
      if (normalized.length > 0) {
        normalizedSet.add(normalized);
      }

      const canonical = normalizeSkillMatchText(rawTrigger);
      if (canonical.length > 0) {
        canonicalSet.add(canonical);
        if (canonical.includes(' ')) {
          const compact = compactSkillMatchText(canonical);
          if (compact.length > 0) {
            compactSet.add(compact);
          }
        }
      }
    };

    // 技能名称始终作为触发词
    addTrigger(skill.name);

    // 合并 frontmatter 声明的 triggers
    if (skill.triggers && Array.isArray(skill.triggers)) {
      for (const trigger of skill.triggers) {
        addTrigger(trigger);
      }
    }

    return {
      normalizedTriggers: Array.from(normalizedSet),
      canonicalTriggers: Array.from(canonicalSet),
      compactTriggers: Array.from(compactSet),
    };
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建 SkillRetriever 实例
 *
 * 使用全局 embeddingService 单例作为默认依赖。
 * 动态导入避免循环依赖。
 *
 * @returns SkillRetriever 实例
 */
export async function createSkillRetriever(): Promise<SkillRetriever> {
  // 动态导入避免模块循环依赖
  const { embeddingService } = await import('@services/rag/EmbeddingService');
  return new SkillRetriever(embeddingService);
}
