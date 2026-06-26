/**
 * BM25Index - BM25 关键词检索索引
 * 
 * 实现简化版 BM25 算法，用于 Hybrid Search 的关键词召回。
 * 使用内存存储，轻量级实现。
 * 
 * 性能优化：
 * - IDF 和平均文档长度采用增量更新，addDocument 为 O(T)（T 为文档词数）
 * - 停用词 Set 为模块级常量，避免每次调用重复创建
 */

/** BM25 检索结果 */
export interface BM25Result {
    docId: string;
    score: number;
}

/** 文档统计信息 */
interface DocStats {
    docId: string;
    termFreqs: Map<string, number>;
    docLength: number;
}

/** BM25 配置 */
interface BM25Config {
    k1: number;  // 词频饱和参数 (默认 1.2)
    b: number;   // 文档长度归一化参数 (默认 0.75)
}

const DEFAULT_BM25_CONFIG: BM25Config = {
    k1: 1.2,
    b: 0.75,
};

// ============================================================================
// 停用词常量（模块级，避免每次调用重新创建 Set）
// ============================================================================

/** 英文停用词集合 */
const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'shall',
    'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either',
    'neither', 'not', 'only', 'own', 'same', 'than', 'too',
    'very', 'just', 'also', 'now', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every',
    'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'any', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
    'her', 'it', 'its', 'they', 'them', 'their', 'what',
    'which', 'who', 'whom',
]);

/** 中文停用词集合（bigram 级别） */
const CHINESE_STOP_WORDS: ReadonlySet<string> = new Set([
    '的是', '是在', '在我', '我有', '有和', '和就', '就不', '不人',
    '一个', '这个', '那个', '什么', '怎么', '如何', '可以', '能够',
    '已经', '正在', '将要', '应该', '必须', '可能', '或者', '以及',
    '但是', '因为', '所以', '如果', '虽然', '尽管', '即使', '无论',
]);

// ============================================================================
// BM25 索引类
// ============================================================================

/**
 * BM25Index 类
 * 
 * 提供基于 BM25 算法的关键词检索能力
 */
export class BM25Index {
    private config: BM25Config;

    // 索引存储：agentId -> Map<docId, DocStats>
    private indexByAgent: Map<string, Map<string, DocStats>> = new Map();

    // documentId → docId 反向映射，支持按 documentId 批量删除 BM25 条目
    // 结构: agentId → documentId → Set<docId（即 chunk.id）>
    private documentIndex: Map<string, Map<string, Set<string>>> = new Map();

    // 逆文档频率缓存：agentId -> Map<term, docFreq>
    private idfCache: Map<string, Map<string, number>> = new Map();

    // 平均文档长度：agentId -> avgDocLength
    private avgDocLengthByAgent: Map<string, number> = new Map();

    // 总文档长度累计，用于增量计算平均值（避免每次遍历求和）
    private totalDocLengthByAgent: Map<string, number> = new Map();

    constructor(config: Partial<BM25Config> = {}) {
        this.config = { ...DEFAULT_BM25_CONFIG, ...config };
    }

    /**
     * 添加文档到索引
     * 
     * 采用增量更新策略：仅更新新文档引入的 term 的 df 和总文档长度，
     * 避免每次 addDocument 时全量重算 IDF（O(N²) → O(T)）。
     * 
     * @param agentId - Agent ID
     * @param docId - 文档/块 ID（即 chunk.id）
     * @param content - 文档内容
     * @param documentId - 可选，文档级 ID，用于反向映射以支持按 documentId 批量删除
     */
    addDocument(agentId: string, docId: string, content: string, documentId?: string): void {
        // 获取或创建 Agent 的索引
        let agentIndex = this.indexByAgent.get(agentId);
        if (!agentIndex) {
            agentIndex = new Map();
            this.indexByAgent.set(agentId, agentIndex);
            this.idfCache.set(agentId, new Map());
            this.totalDocLengthByAgent.set(agentId, 0);
        }

        // 分词
        const terms = this.tokenize(content);

        // 计算词频
        const termFreqs = new Map<string, number>();
        for (const term of terms) {
            termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
        }

        // 如果是更新已有文档，先回退旧统计
        const existingDoc = agentIndex.get(docId);
        if (existingDoc) {
            this.decrementIdf(agentId, existingDoc.termFreqs);
            const prevTotal = this.totalDocLengthByAgent.get(agentId) ?? 0;
            this.totalDocLengthByAgent.set(agentId, prevTotal - existingDoc.docLength);
        }

        // 存储文档统计
        agentIndex.set(docId, {
            docId,
            termFreqs,
            docLength: terms.length,
        });

        // 增量更新 IDF：只为新文档包含的 term 增加 df
        this.incrementIdf(agentId, termFreqs);

        // 增量更新平均文档长度
        const currentTotal = this.totalDocLengthByAgent.get(agentId) ?? 0;
        const newTotal = currentTotal + terms.length;
        this.totalDocLengthByAgent.set(agentId, newTotal);
        this.avgDocLengthByAgent.set(agentId, newTotal / agentIndex.size);

        // 维护 documentId → docId 反向映射
        if (documentId) {
            let agentDocIndex = this.documentIndex.get(agentId);
            if (!agentDocIndex) {
                agentDocIndex = new Map();
                this.documentIndex.set(agentId, agentDocIndex);
            }
            let docIds = agentDocIndex.get(documentId);
            if (!docIds) {
                docIds = new Set();
                agentDocIndex.set(documentId, docIds);
            }
            docIds.add(docId);
        }
    }

    /**
     * 批量添加文档
     */
    addDocuments(agentId: string, documents: Array<{ docId: string; content: string }>): void {
        for (const doc of documents) {
            this.addDocument(agentId, doc.docId, doc.content);
        }
    }

    /**
     * 删除文档索引（增量更新 IDF 和平均文档长度）
     */
    removeDocument(agentId: string, docId: string): void {
        const agentIndex = this.indexByAgent.get(agentId);
        if (!agentIndex) return;

        const docStats = agentIndex.get(docId);
        if (!docStats) return;

        // 增量回退 IDF 和文档长度
        this.decrementIdf(agentId, docStats.termFreqs);
        const prevTotal = this.totalDocLengthByAgent.get(agentId) ?? 0;
        this.totalDocLengthByAgent.set(agentId, prevTotal - docStats.docLength);

        agentIndex.delete(docId);

        // 重算平均文档长度
        if (agentIndex.size > 0) {
            const newTotal = this.totalDocLengthByAgent.get(agentId) ?? 0;
            this.avgDocLengthByAgent.set(agentId, newTotal / agentIndex.size);
        } else {
            this.avgDocLengthByAgent.set(agentId, 0);
        }
    }

    /**
     * 按 documentId 批量删除属于该文档的所有 BM25 条目
     *
     * 通过 documentIndex 反向映射查找属于该 documentId 的所有 chunk.id，
     * 然后逐个从主索引中删除（增量更新 IDF）
     */
    removeByDocumentId(agentId: string, documentId: string): void {
        const agentDocIndex = this.documentIndex.get(agentId);
        const docIds = agentDocIndex?.get(documentId);
        if (!docIds || docIds.size === 0) return;

        for (const docId of docIds) {
            this.removeDocument(agentId, docId);
        }

        // 清理反向映射
        agentDocIndex?.delete(documentId);
    }

    /**
     * 清空 Agent 的所有索引
     */
    clearAgent(agentId: string): void {
        this.indexByAgent.delete(agentId);
        this.documentIndex.delete(agentId);
        this.idfCache.delete(agentId);
        this.avgDocLengthByAgent.delete(agentId);
        this.totalDocLengthByAgent.delete(agentId);
    }

    /**
     * BM25 检索
     * 
     * @param agentId - Agent ID
     * @param query - 查询文本
     * @param topK - 返回结果数量
     * @returns 按 BM25 分数排序的结果
     */
    search(agentId: string, query: string, topK: number = 30): BM25Result[] {
        const agentIndex = this.indexByAgent.get(agentId);
        if (!agentIndex || agentIndex.size === 0) {
            return [];
        }

        // 分词查询
        const queryTerms = this.tokenize(query);
        if (queryTerms.length === 0) {
            return [];
        }

        const idfMap = this.idfCache.get(agentId) ?? new Map<string, number>();
        const avgDocLength = this.avgDocLengthByAgent.get(agentId) ?? 1;
        const N = agentIndex.size;

        // 计算每个文档的 BM25 分数
        const results: BM25Result[] = [];

        for (const [docId, docStats] of agentIndex) {
            let score = 0;

            for (const term of queryTerms) {
                const tf = docStats.termFreqs.get(term) ?? 0;
                if (tf === 0) continue;

                // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
                const df = idfMap.get(term) ?? 0;
                const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

                // BM25 TF 部分
                const tfNorm = (tf * (this.config.k1 + 1)) /
                    (tf + this.config.k1 * (1 - this.config.b + this.config.b * docStats.docLength / avgDocLength));

                score += idf * tfNorm;
            }

            if (score > 0) {
                results.push({ docId, score });
            }
        }

        // 按分数降序排序
        results.sort((a, b) => b.score - a.score);

        return results.slice(0, topK);
    }

    /**
     * 获取索引状态
     */
    getStats(agentId: string): { documentCount: number; termCount: number } {
        const agentIndex = this.indexByAgent.get(agentId);
        const idfMap = this.idfCache.get(agentId);

        return {
            documentCount: agentIndex?.size ?? 0,
            termCount: idfMap?.size ?? 0,
        };
    }

    // ========================================================================
    // 增量 IDF 更新（私有方法）
    // ========================================================================

    /** 增量更新 IDF：增加文档频率（添加文档时调用） */
    private incrementIdf(agentId: string, termFreqs: Map<string, number>): void {
        let idfMap = this.idfCache.get(agentId);
        if (!idfMap) {
            idfMap = new Map();
            this.idfCache.set(agentId, idfMap);
        }
        for (const term of termFreqs.keys()) {
            idfMap.set(term, (idfMap.get(term) ?? 0) + 1);
        }
    }

    /** 增量更新 IDF：减少文档频率（删除文档时调用） */
    private decrementIdf(agentId: string, termFreqs: Map<string, number>): void {
        const idfMap = this.idfCache.get(agentId);
        if (!idfMap) return;
        for (const term of termFreqs.keys()) {
            const current = idfMap.get(term) ?? 0;
            if (current <= 1) {
                idfMap.delete(term);
            } else {
                idfMap.set(term, current - 1);
            }
        }
    }

    // ========================================================================
    // 分词（私有方法）
    // ========================================================================

    /**
     * 分词
     * 
     * 策略：
     * 1. 英文按空格/标点分割，保留完整单词
     * 2. 中文使用 bigram（二元组）分词，提高召回率
     */
    private tokenize(text: string): string[] {
        const lowerText = text.toLowerCase();
        const tokens: string[] = [];

        // 1. 提取英文单词和数字
        const englishPattern = /[a-z][a-z0-9]*/g;
        const englishMatches = lowerText.match(englishPattern);
        if (englishMatches) {
            for (const match of englishMatches) {
                if (!this.isEnglishStopWord(match)) {
                    tokens.push(match);
                }
            }
        }

        // 2. 提取中文并生成 bigram
        const chinesePattern = /[\u4e00-\u9fff]+/g;
        const chineseMatches = lowerText.match(chinesePattern);
        if (chineseMatches) {
            for (const segment of chineseMatches) {
                // 生成 bigram（二元组）
                for (let i = 0; i < segment.length - 1; i++) {
                    const bigram = segment.substring(i, i + 2);
                    if (!this.isChineseStopWord(bigram)) {
                        tokens.push(bigram);
                    }
                }
                // 短完整片段（2-4字）也加入，提高高频短语的精确匹配能力
                // 过长片段（>4字）几乎不可能精确命中，只靠 bigram 召回即可
                if (segment.length >= 2 && segment.length <= 4 && !this.isChineseStopWord(segment)) {
                    tokens.push(segment);
                }
            }
        }

        return tokens;
    }

    /**
     * 英文停用词判断（引用模块级常量）
     */
    private isEnglishStopWord(word: string): boolean {
        return ENGLISH_STOP_WORDS.has(word) || word.length < 2;
    }

    /**
     * 中文停用词判断（引用模块级常量）
     */
    private isChineseStopWord(word: string): boolean {
        return CHINESE_STOP_WORDS.has(word);
    }
}

// 单例实例
let bm25IndexInstance: BM25Index | null = null;

/**
 * 获取 BM25 索引单例
 */
export function getBM25Index(): BM25Index {
    bm25IndexInstance ??= new BM25Index();
    return bm25IndexInstance;
}

/**
 * 创建新的 BM25 索引实例
 */
export function createBM25Index(config?: Partial<BM25Config>): BM25Index {
    return new BM25Index(config);
}
