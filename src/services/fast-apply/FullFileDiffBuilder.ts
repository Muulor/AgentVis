/**
 * FullFileDiffBuilder - 全文 Diff 构建器
 *
 * 将分散的修改块合并为全文 Diff，并计算可折叠区域
 *
 * @example
 * const builder = new FullFileDiffBuilder(originalContent, modifications, 'example.txt');
 * const fullDiff = builder.build();
 */

import type {
    ModificationApplyResult,
    FullFileDiffLine,
    CollapsibleRegion,
    FullFileDiffData,
} from './types';
import { myersDiff } from './MyersDiff';

// ==================== 常量 ====================

/** 默认上下文行数（折叠区域首尾各保留的行数） */
const DEFAULT_CONTEXT_LINES = 3;

// ==================== 主类 ====================

export class FullFileDiffBuilder {
    private originalContent: string;
    private modifications: ModificationApplyResult[];
    private fileName: string;
    private contextLines: number;

    constructor(
        originalContent: string,
        modifications: ModificationApplyResult[],
        fileName: string,
        contextLines: number = DEFAULT_CONTEXT_LINES
    ) {
        this.originalContent = originalContent;
        this.modifications = modifications;
        this.fileName = fileName;
        this.contextLines = contextLines;
    }

    /**
     * 构建全文 Diff 数据
     */
    public build(): FullFileDiffData {
        // 1. 按起始行号排序修改（确保顺序正确）
        const sortedMods = this.sortModifications();

        // 2. 构建全文 Diff 行
        const lines = this.buildFullDiffLines(sortedMods);

        // 3. 计算可折叠区域
        const collapsibleRegions = this.computeCollapsibleRegions(lines);

        // 4. 计算统计信息
        const stats = this.computeStats(lines);

        return {
            fileName: this.fileName,
            lines,
            collapsibleRegions,
            modifications: this.modifications,
            stats,
        };
    }

    /**
     * 按起始行号排序修改
     */
    private sortModifications(): ModificationApplyResult[] {
        return [...this.modifications].sort((a, b) => {
            const aStart = a.matchResult.startLine;
            const bStart = b.matchResult.startLine;
            return aStart - bStart;
        });
    }

    /**
     * 构建全文 Diff 行
     * 将原始文件和修改块合并为统一的行列表
     */
    private buildFullDiffLines(sortedMods: ModificationApplyResult[]): FullFileDiffLine[] {
        const originalLines = this.originalContent.split('\n');
        // 文件以换行符结尾时，split 会产生末尾空字符串（如 "a\nb\n" → ["a","b",""]）
        // 这个多余元素会被当作 context 行输出，导致右侧行号多 1
        if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
            originalLines.pop();
        }
        const result: FullFileDiffLine[] = [];

        // 去除重叠修改：DiffToXmlConverter 从同一 hunk 提取多个 change block 时，
        // 相邻 INSERT 块的滑动窗口锚点（MAX_ANCHOR_CONTEXT_LINES=5）可能产生重叠的 search 内容。
        // preview() 独立匹配后，会出现如 L542-544 和 L542-545 的重叠 matchResult。
        // 保留范围最宽的（覆盖最多原始行的），过滤被完全包含的窄修改
        const deduplicatedMods = this.deduplicateOverlappingMods(sortedMods);

        // 构建行号范围到修改的映射
        // key: 原始文件行号, value: 对应的修改
        const lineToModMap = new Map<number, ModificationApplyResult>();
        for (const mod of deduplicatedMods) {
            for (let i = mod.matchResult.startLine; i <= mod.matchResult.endLine; i++) {
                lineToModMap.set(i, mod);
            }
        }

        // 已处理的修改 ID 集合（避免重复添加修改块）
        const processedMods = new Set<string>();
        let absoluteLineNumber = 1;

        for (let originalLineNum = 1; originalLineNum <= originalLines.length; originalLineNum++) {
            const mod = lineToModMap.get(originalLineNum);

            if (mod && !processedMods.has(mod.modificationId)) {
                // 遇到新的修改块
                processedMods.add(mod.modificationId);

                // 已接受的修改：合并为正常文本，不再显示 diff 对照
                // 用户可通过回滚功能回看历史对比状态
                if (mod.status === 'applied') {
                    for (const hunk of mod.diff.hunks) {
                        for (const line of hunk.lines) {
                            // 只保留 add 行作为正常文本，remove 行已不存在于当前文档
                            if (line.type === 'add') {
                                result.push({
                                    type: 'context',
                                    content: line.content,
                                    absoluteLineNumber,
                                    newLineNumber: absoluteLineNumber,
                                });
                                absoluteLineNumber++;
                            }
                        }
                    }
                    // 跳过原始文件中被修改覆盖的行
                    originalLineNum = mod.matchResult.endLine;
                    continue;
                }

                // 已拒绝的修改：恢复为原始文本，不再显示 diff 对照
                // rejected = 原始内容被保留，直接输出被覆盖范围内的原始行
                if (mod.status === 'rejected') {
                    for (let lineNum = mod.matchResult.startLine; lineNum <= mod.matchResult.endLine; lineNum++) {
                        result.push({
                            type: 'context',
                            content: originalLines[lineNum - 1] ?? '',
                            absoluteLineNumber,
                            oldLineNumber: lineNum,
                            newLineNumber: absoluteLineNumber,
                        });
                        absoluteLineNumber++;
                    }
                    originalLineNum = mod.matchResult.endLine;
                    continue;
                }

                // pending/failed 修改：基于 search/replace 重新生成精确的局部 diff
                // 直接对 search/replace 做局部 Myers diff
                // 完全避免全文 diff 上下文行的干扰
                const searchLines = mod.modification.search.split('\n');
                const replaceLines = (mod.modification.replace ?? '').split('\n');
                const localOps = myersDiff(searchLines, replaceLines);

                for (const op of localOps) {
                    if (op.type === 'context') {
                        // search 与 replace 中未变化的行
                        result.push({
                            type: 'context',
                            content: op.content,
                            absoluteLineNumber,
                            oldLineNumber: mod.matchResult.startLine + (op.oldIdx ?? 1) - 1,
                            newLineNumber: absoluteLineNumber,
                            modificationId: mod.modificationId,
                        });
                        absoluteLineNumber++;
                    } else if (op.type === 'remove') {
                        result.push({
                            type: 'remove',
                            content: op.content,
                            absoluteLineNumber,
                            oldLineNumber: mod.matchResult.startLine + (op.oldIdx ?? 1) - 1,
                            modificationId: mod.modificationId,
                        });
                        // remove 行不占用新文件行号，不递增 absoluteLineNumber
                    } else {
                        result.push({
                            type: 'add',
                            content: op.content,
                            absoluteLineNumber,
                            newLineNumber: absoluteLineNumber,
                            modificationId: mod.modificationId,
                        });
                        absoluteLineNumber++;
                    }
                }

                // 跳过原始文件中被修改覆盖的行
                originalLineNum = mod.matchResult.endLine;
            } else if (!mod) {
                // 未被任何修改覆盖的上下文行
                result.push({
                    type: 'context',
                    content: originalLines[originalLineNum - 1] ?? '',
                    absoluteLineNumber,
                    oldLineNumber: originalLineNum,
                    newLineNumber: absoluteLineNumber,
                });
                absoluteLineNumber++;
            }
            // 如果 mod 存在但已处理，跳过（在 for 循环中继续）
        }

        return result;
    }

    /**
     * 去除重叠的修改
     *
     * DiffToXmlConverter 从同一 hunk 提取多个 INSERT→REPLACE 块时，
     * 相邻块的滑动窗口锚点（MAX_ANCHOR_CONTEXT_LINES=5）可能与前一个块的锚点重叠。
     * preview() 独立匹配后产生重叠的 matchResult（如 L542-544 和 L542-545）。
     *
     * 策略：当两个 mod 的 matchResult 有交集时，合并为一个更大的 mod：
     * - matchResult 取并集（最小 startLine，最大 endLine）
     * - search/replace 内容使用 search 做并集后重新生成局部 diff
     */
    private deduplicateOverlappingMods(
        sortedMods: ModificationApplyResult[]
    ): ModificationApplyResult[] {
        if (sortedMods.length <= 1) return sortedMods;

        const result: ModificationApplyResult[] = [];
        const firstMod = sortedMods[0];
        if (!firstMod) return [];
        let current = firstMod;

        for (let i = 1; i < sortedMods.length; i++) {
            const next = sortedMods[i];
            if (!next) continue;

            // 检查是否重叠（next.startLine <= current.endLine 说明有交集）
            if (next.matchResult.startLine <= current.matchResult.endLine) {
                // 合并两个重叠的修改
                current = this.mergeOverlappingMods(current, next);
            } else {
                result.push(current);
                current = next;
            }
        }
        result.push(current);

        return result;
    }

    /**
     * 合并两个重叠的修改
     *
     * 策略：使用 myersDiff 分析每个 mod 在哪些原始行后插入了新行，
     * 然后按原始行顺序拼接，确保两个 mod 的新增内容都被保留。
     *
     * 例如：
     * - mod1 search="A\nB\nC" replace="A\nB\nC\nX1\nX2" → 在 C 后插入 X1,X2
     * - mod2 search="A\nB\nC\nD\nE" replace="A\nB\nC\nD\nE\nY1\nY2" → 在 E 后插入 Y1,Y2
     * - 合并后 search="A\nB\nC\nD\nE", replace="A\nB\nC\nX1\nX2\nD\nE\nY1\nY2"
     */
    private mergeOverlappingMods(
        a: ModificationApplyResult,
        b: ModificationApplyResult
    ): ModificationApplyResult {
        const mergedStartLine = Math.min(a.matchResult.startLine, b.matchResult.startLine);
        const mergedEndLine = Math.max(a.matchResult.endLine, b.matchResult.endLine);
        const originalLines = this.originalContent.split('\n');

        // 合并范围的原始行作为 search
        const mergedSearchLines: string[] = [];
        for (let i = mergedStartLine; i <= mergedEndLine; i++) {
            mergedSearchLines.push(originalLines[i - 1] ?? '');
        }
        const mergedSearch = mergedSearchLines.join('\n');

        // 用 myersDiff 分析每个 mod 的变更：提取"在第 N 行原始行后插入了哪些行"
        // 和"哪些行被替换了"
        const insertionsAfterLine = new Map<number, string[]>(); // key=原始行号, value=插入的行
        const replacements = new Map<number, string>();           // key=原始行号, value=替换后的行（如有）

        for (const mod of [a, b]) {
            const searchLines = mod.modification.search.split('\n');
            const replaceLines = (mod.modification.replace ?? '').split('\n');
            const ops = myersDiff(searchLines, replaceLines);

            // 追踪当前位于哪一行原始行之后（mod 范围内的行号）
            let lastOrigLineNum = mod.matchResult.startLine - 1;

            for (const op of ops) {
                if (op.type === 'context') {
                    // 不变的行：更新位置指针
                    lastOrigLineNum = mod.matchResult.startLine + (op.oldIdx ?? 1) - 1;
                } else if (op.type === 'remove') {
                    // 被删除的行
                    const origLineNum = mod.matchResult.startLine + (op.oldIdx ?? 1) - 1;
                    // 标记该行被删除（设为 null 会复杂化，先用 replace 为空标记）
                    replacements.set(origLineNum, '');
                    lastOrigLineNum = origLineNum;
                } else {
                    // 插入的行：记录在 lastOrigLineNum 之后
                    const existing = insertionsAfterLine.get(lastOrigLineNum) ?? [];
                    existing.push(op.content);
                    insertionsAfterLine.set(lastOrigLineNum, existing);
                }
            }
        }

        // 构建合并后的 replace：遍历每一行原始行，输出原始行+插入行
        const mergedReplaceLines: string[] = [];

        // 先检查在合并范围起始行之前是否有插入（lastOrigLineNum = startLine - 1）
        const beforeStart = insertionsAfterLine.get(mergedStartLine - 1);
        if (beforeStart) {
            mergedReplaceLines.push(...beforeStart);
        }

        for (let i = mergedStartLine; i <= mergedEndLine; i++) {
            // 输出原始行（除非被标记为删除）
            if (!replacements.has(i)) {
                mergedReplaceLines.push(originalLines[i - 1] ?? '');
            }
            // 输出在该行之后插入的新行
            const insertions = insertionsAfterLine.get(i);
            if (insertions) {
                mergedReplaceLines.push(...insertions);
            }
        }

        const mergedReplace = mergedReplaceLines.join('\n');

        // 使用较宽 mod 的 ID 和元数据
        const wider = (a.matchResult.endLine - a.matchResult.startLine) >=
            (b.matchResult.endLine - b.matchResult.startLine) ? a : b;

        return {
            ...wider,
            modification: {
                ...wider.modification,
                search: mergedSearch,
                replace: mergedReplace,
            },
            matchResult: {
                ...wider.matchResult,
                startLine: mergedStartLine,
                endLine: mergedEndLine,
                matchedContent: mergedSearch,
            },
        };
    }

    /**
     * 计算可折叠区域
     * 连续的上下文行超过阈值时，中间部分可折叠
     */
    private computeCollapsibleRegions(lines: FullFileDiffLine[]): CollapsibleRegion[] {
        const regions: CollapsibleRegion[] = [];
        let contextStartIndex = -1;
        let contextCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const isContextLine = line.type === 'context' && !line.modificationId;

            if (isContextLine) {
                if (contextStartIndex === -1) {
                    contextStartIndex = i;
                }
                contextCount++;
            } else {
                // 遇到非上下文行，检查之前的上下文区域是否需要折叠
                // 只有当 contextCount > 2*contextLines 时才折叠
                // 确保折叠后首尾各保留 contextLines 行，中间有内容可折叠
                // 这避免了折叠边界行号重复问题
                if (contextCount > 2 * this.contextLines) {
                    const foldStart = contextStartIndex + this.contextLines;
                    const foldEnd = contextStartIndex + contextCount - this.contextLines - 1;

                    if (foldEnd > foldStart) {
                        regions.push({
                            startIndex: foldStart,
                            endIndex: foldEnd,
                            lineCount: foldEnd - foldStart + 1,
                            isExpanded: false,
                        });
                    }
                }
                contextStartIndex = -1;
                contextCount = 0;
            }
        }

        // 处理文件末尾的上下文区域（同样应用改进逻辑）
        if (contextCount > 2 * this.contextLines) {
            const foldStart = contextStartIndex + this.contextLines;
            const foldEnd = contextStartIndex + contextCount - this.contextLines - 1;

            if (foldEnd > foldStart) {
                regions.push({
                    startIndex: foldStart,
                    endIndex: foldEnd,
                    lineCount: foldEnd - foldStart + 1,
                    isExpanded: false,
                });
            }
        }

        return regions;
    }

    /**
     * 计算统计信息
     */
    private computeStats(lines: FullFileDiffLine[]): FullFileDiffData['stats'] {
        const stats = {
            added: 0,
            removed: 0,
            pending: 0,
            accepted: 0,
            rejected: 0,
            failed: 0,
        };

        // 统计行数
        for (const line of lines) {
            if (line.type === 'add') stats.added++;
            if (line.type === 'remove') stats.removed++;
        }

        // 统计修改状态
        for (const mod of this.modifications) {
            switch (mod.status) {
                case 'pending':
                    stats.pending++;
                    break;
                case 'applied':
                    stats.accepted++;
                    break;
                case 'rejected':
                    stats.rejected++;
                    break;
                case 'failed':
                    stats.failed++;
                    break;
            }
        }

        return stats;
    }
}

// ==================== 工具函数 ====================

/**
 * 便捷函数：构建全文 Diff
 */
export function buildFullFileDiff(
    originalContent: string,
    modifications: ModificationApplyResult[],
    fileName: string,
    contextLines?: number
): FullFileDiffData {
    const builder = new FullFileDiffBuilder(originalContent, modifications, fileName, contextLines);
    return builder.build();
}

/**
 * 判断行索引是否在某个折叠区域内
 */
export function isLineInCollapsedRegion(
    lineIndex: number,
    regions: CollapsibleRegion[]
): CollapsibleRegion | null {
    for (const region of regions) {
        if (!region.isExpanded && lineIndex >= region.startIndex && lineIndex <= region.endIndex) {
            return region;
        }
    }
    return null;
}

/**
 * 切换折叠区域的展开状态
 */
export function toggleRegionExpanded(
    regions: CollapsibleRegion[],
    regionIndex: number
): CollapsibleRegion[] {
    return regions.map((region, index) => {
        if (index === regionIndex) {
            return { ...region, isExpanded: !region.isExpanded };
        }
        return region;
    });
}
