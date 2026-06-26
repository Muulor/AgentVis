/**
 * 内容匹配器
 *
 * 实现三级匹配策略：精确匹配 → 模糊匹配 → 语义匹配
 */

import type {
    MatchResult,
    MatchCandidate,
    ContentMatcherConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('ContentMatcher');

// ==================== 工具函数 ====================

/**
 * 正规化字符串用于匹配比较
 *
 * 将 box-drawing 字符统一为 ASCII 等价物，压缩空白序列。
 * 解决 LLM 生成的 search 内容因 box-drawing 字符变形（截断、替换）导致匹配失败的问题。
 */
function normalizeForMatching(text: string): string {
    return text
        // box-drawing 竖线类 → |
        .replace(/[│┃╎╏┆┇┊┋║]/g, '|')
        // box-drawing 横线类 → -
        .replace(/[─━╌╍┄┅┈┉═]/g, '-')
        // box-drawing 角/交叉类 → +
        .replace(/[┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╒╕╘╛╞╡╤╧╪╓╖╙╜╟╢╥╨╫]/g, '+')
        // 压缩连续空白为单个空格（保留换行）
        .replace(/[^\S\n]+/g, ' ')
        // 行尾空白去除
        .replace(/ +$/gm, '');
}

/**
 * 检测字符串是否包含 box-drawing 字符
 *
 * 用于快速判断是否需要启用正规化匹配，避免对普通文本增加不必要的开销
 */
function containsBoxDrawing(text: string): boolean {
    return /[│┃╎╏┆┇┊┋║─━╌╍┄┅┈┉═┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╒╕╘╛╞╡╤╧╪╓╖╙╜╟╢╥╨╫]/.test(text);
}

/**
 * 计算 Levenshtein 距离
 *
 * 使用动态规划计算两个字符串之间的编辑距离
 */
function levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    // 创建二维数组
    const dp: number[][] = [];
        for (let i = 0; i <= m; i++) {
            dp[i] = [];
            const row = dp[i];
            if (!row) continue;
            for (let j = 0; j <= n; j++) {
                row[j] = 0;
            }
        }

    // 初始化边界
    for (let i = 0; i <= m; i++) {
        const row = dp[i];
        if (row) row[0] = i;
    }
    for (let j = 0; j <= n; j++) {
        const row = dp[0];
        if (row) row[j] = j;
    }

    // 填充矩阵
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const dpRow = dp[i];
            const dpPrevRow = dp[i - 1];
            if (!dpRow || !dpPrevRow) continue;

            if (str1[i - 1] === str2[j - 1]) {
                dpRow[j] = dpPrevRow[j - 1] ?? 0;
            } else {
                const del = dpPrevRow[j] ?? 0;
                const ins = dpRow[j - 1] ?? 0;
                const rep = dpPrevRow[j - 1] ?? 0;
                dpRow[j] = Math.min(del + 1, ins + 1, rep + 1);
            }
        }
    }

    const lastRow = dp[m];
    return lastRow ? (lastRow[n] ?? m + n) : m + n;
}

/**
 * 计算两个字符串的相似度 (0-1)
 *
 * 基于 Levenshtein 距离，归一化到 0-1 范围
 */
function calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1;
    if (str1.length === 0 || str2.length === 0) return 0;

    const distance = levenshteinDistance(str1, str2);
    const maxLen = Math.max(str1.length, str2.length);

    return 1 - distance / maxLen;
}

/**
 * 将内容按行分割，返回行号和内容的映射
 */
function splitLines(content: string): string[] {
    return content.split(/\r?\n/);
}

/**
 * 从原始内容中按行号范围提取子串，保留原始行分隔符。
 *
 * 避免 splitLines + join('\n') 丢失 \r 的问题。
 * 当文件使用 CRLF 时，返回的 text 仍包含 \r\n，确保 indexOf(text) 可正确定位。
 *
 * @param content 原始文件内容
 * @param startLineIndex 起始行索引（0-indexed）
 * @param lineCount 行数
 */
function extractOriginalContent(
    content: string,
    startLineIndex: number,
    lineCount: number
): { text: string; startOffset: number } {
    // 用 '\n' 分割保留行尾 \r（CRLF 文件时 rawLine 以 \r 结尾）
    const rawLines = content.split('\n');
    let startOffset = 0;

    // 计算 startLineIndex 行的字符偏移量
    for (let i = 0; i < startLineIndex && i < rawLines.length; i++) {
        // +1 是被 split 消耗的 '\n'
        startOffset += (rawLines[i]?.length ?? 0) + 1;
    }

    // 计算结束行的字符偏移量
    let endOffset = startOffset;
    const endLineIndex = Math.min(startLineIndex + lineCount, rawLines.length);
    for (let i = startLineIndex; i < endLineIndex; i++) {
        endOffset += (rawLines[i]?.length ?? 0) + 1;
    }

    // 去掉最后一个换行符（匹配内容不应包含尾部换行）
    // endOffset 目前指向最后一行换行符之后的位置
    let text = content.substring(startOffset, endOffset);
    if (text.endsWith('\r\n')) {
        text = text.slice(0, -2);
    } else if (text.endsWith('\n')) {
        text = text.slice(0, -1);
    }

    return { text, startOffset };
}

/**
 * 查找子串在内容中的行号范围
 *
 * 修复 CRLF 兼容性：使用 split('\n') 保留行尾 \r，
 * 确保 lineLength 与 indexOf 返回的偏移量基于相同的字节计算
 */
function findLineRange(
    content: string,
    startOffset: number,
    length: number
): { startLine: number; endLine: number } {
    // 用 '\n' 分割保留行尾 \r（CRLF 文件时 rawLine 以 \r 结尾）
    // 这样 rawLine.length + 1（加回被 split 消耗的 \n）= 原始字节偏移量
    const rawLines = content.split('\n');
    let currentOffset = 0;
    let startLine = 0; // 0 表示未找到，区分「未找到」和「确实在第 1 行」
    let endLine = 1;

    for (let i = 0; i < rawLines.length; i++) {
        const rawLine = rawLines[i];
        // rawLine 可能含尾部 \r（CRLF），+1 算被 split 消耗的 \n
        const lineLength = (rawLine?.length ?? 0) + 1;

        if (startLine === 0 && currentOffset + lineLength > startOffset) {
            startLine = i + 1;
        }

        if (currentOffset + lineLength > startOffset + length) {
            endLine = i + 1;
            break;
        }

        currentOffset += lineLength;
    }

    return { startLine: startLine || 1, endLine };
}

// ==================== 匹配器类 ====================

/**
 * 内容匹配器
 *
 * 实现三级匹配策略，按优先级依次尝试：
 * 1. 精确匹配 - 字符串完全相同
 * 2. 模糊匹配 - Levenshtein 相似度 > 阈值
 * 3. 语义匹配 - 向量相似度 > 阈值
 */
export class ContentMatcher {
    private config: ContentMatcherConfig;

    constructor(config: Partial<ContentMatcherConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG.matcher, ...config };
    }

    /**
     * 执行匹配（主方法）
     *
     * 按优先级依次尝试三级匹配策略
     *
     * @param content 目标文档内容
     * @param search 要查找的内容
     * @returns 匹配结果
     */
    async match(content: string, search: string): Promise<MatchResult> {
        // CRLF 归一化：XML round-trip（DOMParser）会将 \r\n 归一化为 \n，
        // 但传入的 content 可能仍保留 \r\n，导致 indexOf 精确匹配失败。
        // 策略：用归一化内容做匹配，匹配成功后用行号映射回原始内容提取 matchedContent
        const lfContent = content.replace(/\r/g, '');
        const lfSearch = search.replace(/\r/g, '');

        // Step 1: 精确匹配
        const exactResult = this.exactMatch(lfContent, lfSearch);
        if (exactResult) {
            return this.remapToOriginalContent(exactResult, content);
        }

        // Step 2: 正规化匹配（box-drawing 字符容错）
        // 仅当 search 或 content 包含 box-drawing 字符时才启用，避免普通文本的额外开销
        if (containsBoxDrawing(lfSearch) || containsBoxDrawing(lfContent)) {
            const normalizedResult = this.normalizedMatch(lfContent, lfSearch);
            if (normalizedResult) {
                return this.remapToOriginalContent(normalizedResult, content);
            }
        }

        // Step 3: 模糊匹配
        const fuzzyResult = this.fuzzyMatch(lfContent, lfSearch);
        if (fuzzyResult) {
            return this.remapToOriginalContent(fuzzyResult, content);
        }

        // Step 4: 语义匹配（如果启用）
        if (this.config.enableSemanticMatch) {
            const semanticResult = await this.semanticMatch(lfContent, lfSearch);
            if (semanticResult) {
                return this.remapToOriginalContent(semanticResult, content);
            }
        }

        // 所有匹配都失败，返回需要人工介入的结果
        return {
            success: false,
            matchLevel: 'manual',
            confidence: 0,
            startLine: 0,
            endLine: 0,
            matchedContent: '',
        };
    }

    /**
     * 将 LF 归一化后的匹配结果映射回原始内容
     *
     * 匹配在 LF 归一化后的内容上进行，行号不变。
     * 用行号从原始内容中提取 matchedContent，保留原始行分隔符（CRLF/LF）。
     */
    private remapToOriginalContent(result: MatchResult, originalContent: string): MatchResult {
        if (!result.success) return result;

        // 行号在归一化前后不变，用行号从原始内容提取 matchedContent
        const lineCount = result.endLine - result.startLine + 1;
        const { text, startOffset } = extractOriginalContent(
            originalContent, result.startLine - 1, lineCount
        );

        return {
            ...result,
            matchedContent: text,
            startOffset,
            matchLength: text.length,
        };
    }

    /**
     * 精确匹配
     *
     * 在文档中查找与 search 完全相同的内容
     *
     * 先尝试原始 search（不 trim）精确匹配，失败再退化到 trim 重试。
     * 原因：trimWhitespace 会截掉 search 末尾的 \n，整文件 REPLACE 时会导致
     * 文件末尾空行（第 N 行）无法被覆盖范围，变成孤立行 → 匹配失败图标。
     * 机器生成的整文件 XML search 精确等于原文件，不应被 trim；
     * 而 LLM 输出的 search 需要 trim 容忍前后多余空白，所以两步都保留。
     */
    exactMatch(content: string, search: string): MatchResult | null {
        // Step 1: 先尝试原始 search（不 trim），优先保留完整行范围
        const rawIndex = content.indexOf(search);
        if (rawIndex !== -1) {
            const { startLine, endLine } = findLineRange(content, rawIndex, search.length);
            return {
                success: true,
                matchLevel: 'exact',
                confidence: 1.0,
                startLine,
                endLine,
                matchedContent: content.substring(rawIndex, rawIndex + search.length),
                startOffset: rawIndex,
                matchLength: search.length,
            };
        }

        // Step 2: 原始匹配失败，若启用 trimWhitespace 则用 trim 重试
        // （容忍 LLM 生成的 search 前后多余的空行）
        if (this.config.trimWhitespace) {
            const normalizedSearch = search.trim();
            if (normalizedSearch.length === 0) return null;

            const index = content.indexOf(normalizedSearch);
            if (index === -1) {
                // trim 匹配也失败，用逐行方式再试
                return this.exactMatchWithTrimmedLines(content, search);
            }

            const { startLine, endLine } = findLineRange(content, index, normalizedSearch.length);
            return {
                success: true,
                matchLevel: 'exact',
                confidence: 1.0,
                startLine,
                endLine,
                matchedContent: content.substring(index, index + normalizedSearch.length),
                startOffset: index,
                matchLength: normalizedSearch.length,
            };
        }

        return null;
    }

    /**
     * 逐行修剪空白后的精确匹配
     */
    private exactMatchWithTrimmedLines(content: string, search: string): MatchResult | null {
        const contentLines = splitLines(content);
        const searchLines = splitLines(search).map((line) => line.trim());

        // 滑动窗口匹配
        for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
            let matched = true;
            for (let j = 0; j < searchLines.length; j++) {
                const contentLine = contentLines[i + j];
                const searchLine = searchLines[j];
                if (contentLine?.trim() !== searchLine) {
                    matched = false;
                    break;
                }
            }

            if (matched) {
                // 使用 extractOriginalContent 保留原始行分隔符（CRLF/LF）
                const { text, startOffset } = extractOriginalContent(content, i, searchLines.length);

                return {
                    success: true,
                    matchLevel: 'exact',
                    confidence: 1.0,
                    startLine: i + 1,
                    endLine: i + searchLines.length,
                    matchedContent: text,
                    startOffset,
                    matchLength: text.length,
                };
            }
        }

        return null;
    }

    /**
     * 正规化匹配
     *
     * 将 box-drawing 字符统一为 ASCII 等价物后，使用逐行滑动窗口精确匹配。
     * 匹配成功后返回原始内容中的实际行范围，确保替换操作使用正确的原始文本。
     */
    normalizedMatch(content: string, search: string): MatchResult | null {
        const normalizedSearch = normalizeForMatching(search);
        const normalizedSearchLines = splitLines(normalizedSearch).map(l => l.trim());
        const contentLines = splitLines(content);

        // 逐行正规化 content 用于比较（缓存避免重复计算）
        const normalizedContentLines = contentLines.map(l => normalizeForMatching(l).trim());

        // 滑动窗口匹配
        for (let i = 0; i <= contentLines.length - normalizedSearchLines.length; i++) {
            let matched = true;
            for (let j = 0; j < normalizedSearchLines.length; j++) {
                if (normalizedContentLines[i + j] !== normalizedSearchLines[j]) {
                    matched = false;
                    break;
                }
            }

            if (matched) {
                // 使用 extractOriginalContent 保留原始行分隔符（CRLF/LF）
                const { text, startOffset } = extractOriginalContent(content, i, normalizedSearchLines.length);

                return {
                    success: true,
                    matchLevel: 'normalized',
                    confidence: 0.95,
                    startLine: i + 1,
                    endLine: i + normalizedSearchLines.length,
                    matchedContent: text,
                    startOffset,
                    matchLength: text.length,
                };
            }
        }

        return null;
    }

    /**
     * 模糊匹配
     *
     * 使用 Levenshtein 距离计算相似度，返回最佳匹配。
     * 当内容包含 box-drawing 字符时，同时用正规化后的文本计算相似度，取更高值。
     */
    fuzzyMatch(content: string, search: string): MatchResult | null {
        // 性能守卫：搜索内容过大时跳过 Levenshtein 模糊匹配
        // Levenshtein O(n²) 复杂度在超大字符串上会导致主线程阻塞数分钟
        // diffToXml 生成的 search 来源于原文件，精确匹配即可命中
        const MAX_FUZZY_SEARCH_CHARS = 2000;
        if (search.length > MAX_FUZZY_SEARCH_CHARS) {
            logger.trace(`[ContentMatcher] fuzzyMatch 跳过: search 长度 ${search.length} 超过阈值 ${MAX_FUZZY_SEARCH_CHARS}`);
            return null;
        }
        const contentLines = splitLines(content);
        const searchLines = splitLines(search);
        const searchLength = searchLines.length;
        const hasBoxChars = containsBoxDrawing(search) || containsBoxDrawing(content);

        // 用于存储最佳匹配
        let bestMatch: {
            lineIndex: number;
            similarity: number;
        } | null = null;

        // 滑动窗口，查找最相似的连续行
        for (let i = 0; i <= contentLines.length - searchLength; i++) {
            const windowContent = contentLines.slice(i, i + searchLength).join('\n');

            // 原始文本相似度
            let similarity = calculateSimilarity(
                this.config.trimWhitespace ? windowContent.trim() : windowContent,
                this.config.trimWhitespace ? search.trim() : search
            );

            // 包含 box-drawing 字符时，也用正规化文本计算相似度，取更高值
            // 因为 box-drawing 变形不应降低语义层面的相似度分数
            if (hasBoxChars) {
                const normalizedSimilarity = calculateSimilarity(
                    normalizeForMatching(windowContent).trim(),
                    normalizeForMatching(search).trim()
                );
                similarity = Math.max(similarity, normalizedSimilarity);
            }

            if (similarity >= this.config.fuzzyThreshold) {
                if (!bestMatch || similarity > bestMatch.similarity) {
                    bestMatch = { lineIndex: i, similarity };
                }
            }
        }

        if (bestMatch) {
            // 使用 extractOriginalContent 保留原始行分隔符（CRLF/LF）
            const { text, startOffset } = extractOriginalContent(content, bestMatch.lineIndex, searchLength);

            return {
                success: true,
                matchLevel: 'fuzzy',
                confidence: bestMatch.similarity,
                startLine: bestMatch.lineIndex + 1,
                endLine: bestMatch.lineIndex + searchLength,
                matchedContent: text,
                startOffset,
                matchLength: text.length,
            };
        }

        return null;
    }

    /**
     * 语义匹配
     *
     * 使用 EmbeddingService 进行向量相似度匹配。
     * 滑动窗口将 content 分为与 search 等长的候选块，批量编码后计算余弦相似度。
     * 为减少 API 调用开销，使用步长采样（step = max(1, searchLines/2)）。
     *
     * 注意：此方法需要网络连接，网络异常时优雅降级返回 null
     */
    async semanticMatch(content: string, search: string): Promise<MatchResult | null> {
        const contentLines = splitLines(content);
        const searchLines = splitLines(search);
        const searchLength = searchLines.length;

        // 搜索内容过短时语义匹配不可靠
        if (searchLength < 2) return null;
        if (contentLines.length < searchLength) return null;

        try {
            const { embeddingService } = await import('../rag/EmbeddingService');

            // 1. 编码搜索文本
            const searchEmbedding = await embeddingService.encode(search);

            // 2. 滑动窗口：构建候选块
            //    步长采样减少 API 调用次数（大文件可能有数百个窗口）
            const step = Math.max(1, Math.floor(searchLength / 2));
            const windowTexts: string[] = [];
            const windowIndices: number[] = [];

            for (let i = 0; i <= contentLines.length - searchLength; i += step) {
                windowTexts.push(contentLines.slice(i, i + searchLength).join('\n'));
                windowIndices.push(i);
            }

            if (windowTexts.length === 0) return null;

            // 3. 批量编码所有候选窗口
            const windowEmbeddings = await embeddingService.encodeBatch(windowTexts);

            // 4. 计算余弦相似度，找最佳匹配
            let bestSimilarity = 0;
            let bestIndex = -1;

            for (let j = 0; j < windowEmbeddings.length; j++) {
                const embedding = windowEmbeddings[j];
                if (!embedding) continue;
                const similarity = embeddingService.cosineSimilarity(searchEmbedding, embedding);
                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestIndex = j;
                }
            }

            // 5. 超过阈值则返回匹配结果
            if (bestSimilarity >= this.config.semanticThreshold && bestIndex !== -1) {
                const lineIndex = windowIndices[bestIndex] ?? -1;
                if (lineIndex < 0) return null;
                const { text, startOffset } = extractOriginalContent(content, lineIndex, searchLength);

                return {
                    success: true,
                    matchLevel: 'semantic',
                    confidence: bestSimilarity,
                    startLine: lineIndex + 1,
                    endLine: lineIndex + searchLength,
                    matchedContent: text,
                    startOffset,
                    matchLength: text.length,
                };
            }

            return null;
        } catch (error) {
            // 网络错误等异常时优雅降级，不阻断匹配流程
            logger.warn('[ContentMatcher] 语义匹配失败，跳过:', error);
            return null;
        }
    }

    /**
     * 获取模糊匹配候选项
     *
     * 返回多个可能的匹配候选，供用户选择
     */
    getFuzzyCandidates(
        content: string,
        search: string,
        maxCandidates: number = 5
    ): MatchCandidate[] {
        const contentLines = splitLines(content);
        const searchLines = splitLines(search);
        const searchLength = searchLines.length;

        const candidates: MatchCandidate[] = [];

        for (let i = 0; i <= contentLines.length - searchLength; i++) {
            const windowContent = contentLines.slice(i, i + searchLength).join('\n');
            const similarity = calculateSimilarity(
                this.config.trimWhitespace ? windowContent.trim() : windowContent,
                this.config.trimWhitespace ? search.trim() : search
            );

            // 只保留相似度大于 0.5 的候选
            if (similarity > 0.5) {
                candidates.push({
                    content: windowContent,
                    score: similarity,
                    startLine: i + 1,
                    endLine: i + searchLength,
                });
            }
        }

        // 按相似度排序，返回前 N 个
        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, maxCandidates);
    }
}

// ==================== 导出工具函数 ====================

export { calculateSimilarity, levenshteinDistance, normalizeForMatching, containsBoxDrawing };
