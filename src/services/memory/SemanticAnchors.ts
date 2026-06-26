/**
 * SemanticAnchors - 语义锚点模块
 *
 * 【职责】
 * 提供语义稳定性提示（SemanticHints），用于放大或抑制已有的关键词/重复度得分。
 *
 * 【设计原则】
 * - Embedding 永远不能单独推送事实到长期记忆
 * - 只能放大已有的结构性证据
 * - 使用"相对距离"逻辑：与确定性锚点的平均距离 vs 与不确定性锚点的平均距离
 */

import { embeddingService } from '../rag/EmbeddingService';
import { getLogger } from '@services/logger';

const logger = getLogger('SemanticAnchors');

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 语义提示结果
 *
 * certaintyBoost > 0 表示语义倾向确定性
 * uncertaintyPenalty > 0 表示语义倾向不确定性
 */
export interface SemanticHints {
    /** 确定性加成（正值表示语义上更确定） */
    certaintyBoost: number;
    /** 不确定性惩罚（正值表示语义上更不确定） */
    uncertaintyPenalty: number;
    /** 原始相似度分数（用于调试） */
    rawScores: {
        avgCertaintySimilarity: number;
        avgUncertaintySimilarity: number;
    };
}

// ============================================================================
// 锚点定义
// ============================================================================

/**
 * 确定性锚点组
 *
 * 表示"稳定、确定、重要"的标准句式
 */
const CERTAINTY_ANCHORS = [
    // 通用确定性
    '我确定这一点。',
    'I am sure about this.',
    '这是一个确定的要求。',
    'This is a firm requirement.',
    'This is a stable long-term preference.',
    'This should apply in future conversations.',
    // 偏好确定性
    '我明确偏好这种方式。',
    'I definitely prefer this way.',
    'I always want responses handled this way.',
    // 重要性
    '这一点非常重要，请记住。',
    'This is crucial, please remember.',
    'Please remember this for future work.',
];

/**
 * 不确定性锚点组
 *
 * 表示"临时、猜测、不确定"的标准句式
 */
const UNCERTAINTY_ANCHORS = [
    // 猜测
    '我猜是这样吧。',
    'I guess so.',
    '也许是，不太确定。',
    'Maybe, not sure.',
    'I am just thinking aloud.',
    'This is tentative and may change.',
    // 临时
    '暂时先这样，可能会变。',
    'Just for now, might change.',
    'This is only temporary.',
    // 情绪
    '今天有点烦。',
    'Feeling a bit annoyed today.',
    'I am frustrated right now, but this is not a lasting preference.',
];

// ============================================================================
// 缓存
// ============================================================================

/** 锚点 Embedding 缓存（首次调用后缓存） */
let cachedCertaintyEmbeddings: number[][] | null = null;
let cachedUncertaintyEmbeddings: number[][] | null = null;

/**
 * 获取锚点 Embeddings（带缓存）
 */
async function getAnchorEmbeddings(): Promise<{
    certainty: number[][];
    uncertainty: number[][];
}> {
    if (cachedCertaintyEmbeddings && cachedUncertaintyEmbeddings) {
        return {
            certainty: cachedCertaintyEmbeddings,
            uncertainty: cachedUncertaintyEmbeddings,
        };
    }

    // 一次性获取所有锚点的 Embedding
    const allAnchors = [...CERTAINTY_ANCHORS, ...UNCERTAINTY_ANCHORS];
    const allEmbeddings = await embeddingService.encodeBatch(allAnchors);

    // 分割结果
    cachedCertaintyEmbeddings = allEmbeddings.slice(0, CERTAINTY_ANCHORS.length);
    cachedUncertaintyEmbeddings = allEmbeddings.slice(CERTAINTY_ANCHORS.length);

    return {
        certainty: cachedCertaintyEmbeddings,
        uncertainty: cachedUncertaintyEmbeddings,
    };
}

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 计算文本与锚点组的平均相似度
 */
function averageSimilarity(textEmbedding: number[], anchorEmbeddings: number[][]): number {
    if (anchorEmbeddings.length === 0) return 0;

    let sum = 0;
    for (const anchor of anchorEmbeddings) {
        sum += embeddingService.cosineSimilarity(textEmbedding, anchor);
    }
    return sum / anchorEmbeddings.length;
}

/**
 * 获取文本的语义稳定性提示
 *
 * 使用"相对距离"逻辑：
 * - 如果与确定性锚点更近 → certaintyBoost > 0
 * - 如果与不确定性锚点更近 → uncertaintyPenalty > 0
 *
 * @param text - 候选事实文本
 * @returns 语义提示
 */
export async function getSemanticHints(text: string): Promise<SemanticHints> {
    try {
        // 获取锚点 Embeddings
        const anchors = await getAnchorEmbeddings();

        // 获取候选文本的 Embedding
        const [textEmbedding] = await embeddingService.encodeBatch([text]);

        if (!textEmbedding || textEmbedding.length === 0) {
            logger.warn('[SemanticAnchors] 获取文本 Embedding 失败，返回中性提示');
            return {
                certaintyBoost: 0,
                uncertaintyPenalty: 0,
                rawScores: { avgCertaintySimilarity: 0, avgUncertaintySimilarity: 0 },
            };
        }

        // 计算与两组锚点的平均相似度
        const avgCertaintySimilarity = averageSimilarity(textEmbedding, anchors.certainty);
        const avgUncertaintySimilarity = averageSimilarity(textEmbedding, anchors.uncertainty);

        // 相对距离：确定性相似度 - 不确定性相似度
        const delta = avgCertaintySimilarity - avgUncertaintySimilarity;

        // 设置阈值，避免微小差异产生影响（阈值 0.05）
        const SIGNIFICANCE_THRESHOLD = 0.05;

        let certaintyBoost = 0;
        let uncertaintyPenalty = 0;

        if (delta > SIGNIFICANCE_THRESHOLD) {
            // 更接近确定性锚点
            certaintyBoost = delta;
        } else if (delta < -SIGNIFICANCE_THRESHOLD) {
            // 更接近不确定性锚点
            uncertaintyPenalty = Math.abs(delta);
        }

        logger.trace(
            `[SemanticAnchors] 语义分析: certainty=${avgCertaintySimilarity.toFixed(3)}, ` +
            `uncertainty=${avgUncertaintySimilarity.toFixed(3)}, delta=${delta.toFixed(3)}`
        );

        return {
            certaintyBoost,
            uncertaintyPenalty,
            rawScores: {
                avgCertaintySimilarity,
                avgUncertaintySimilarity,
            },
        };
    } catch (error) {
        logger.error('[SemanticAnchors] 获取语义提示失败:', error);
        // 失败时返回中性提示，不影响原有打分
        return {
            certaintyBoost: 0,
            uncertaintyPenalty: 0,
            rawScores: { avgCertaintySimilarity: 0, avgUncertaintySimilarity: 0 },
        };
    }
}

/**
 * 批量获取多个文本的语义提示
 *
 * 优化：一次 API 调用获取所有文本的 Embedding
 *
 * @param texts - 候选事实文本列表
 * @returns 语义提示列表
 */
export async function getSemanticHintsBatch(texts: string[]): Promise<SemanticHints[]> {
    if (texts.length === 0) {
        return [];
    }

    try {
        // 获取锚点 Embeddings
        const anchors = await getAnchorEmbeddings();

        // 批量获取所有文本的 Embedding
        const textEmbeddings = await embeddingService.encodeBatch(texts);

        // 计算每个文本的语义提示
        return textEmbeddings.map((textEmbedding, index) => {
            if (textEmbedding.length === 0) {
                return {
                    certaintyBoost: 0,
                    uncertaintyPenalty: 0,
                    rawScores: { avgCertaintySimilarity: 0, avgUncertaintySimilarity: 0 },
                };
            }

            const avgCertaintySimilarity = averageSimilarity(textEmbedding, anchors.certainty);
            const avgUncertaintySimilarity = averageSimilarity(textEmbedding, anchors.uncertainty);
            const delta = avgCertaintySimilarity - avgUncertaintySimilarity;

            const SIGNIFICANCE_THRESHOLD = 0.05;
            let certaintyBoost = 0;
            let uncertaintyPenalty = 0;

            if (delta > SIGNIFICANCE_THRESHOLD) {
                certaintyBoost = delta;
            } else if (delta < -SIGNIFICANCE_THRESHOLD) {
                uncertaintyPenalty = Math.abs(delta);
            }

            logger.trace(
                `[SemanticAnchors] 批量分析 [${index}]: certainty=${avgCertaintySimilarity.toFixed(3)}, ` +
                `uncertainty=${avgUncertaintySimilarity.toFixed(3)}, delta=${delta.toFixed(3)}`
            );

            return {
                certaintyBoost,
                uncertaintyPenalty,
                rawScores: {
                    avgCertaintySimilarity,
                    avgUncertaintySimilarity,
                },
            };
        });
    } catch (error) {
        logger.error('[SemanticAnchors] 批量获取语义提示失败:', error);
        // 失败时返回中性提示
        return texts.map(() => ({
            certaintyBoost: 0,
            uncertaintyPenalty: 0,
            rawScores: { avgCertaintySimilarity: 0, avgUncertaintySimilarity: 0 },
        }));
    }
}

/**
 * 清空锚点缓存（用于测试）
 */
export function clearAnchorCache(): void {
    cachedCertaintyEmbeddings = null;
    cachedUncertaintyEmbeddings = null;
}
