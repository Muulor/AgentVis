/**
 * Fast-Apply 主引擎
 *
 * 协调 ProtocolParser、ContentMatcher、DiffGenerator、SnapshotManager
 * 和 ModificationExecutor 完成修改的解析、匹配、预览和应用
 */

import { getLogger } from '@services/logger';

const logger = getLogger('FastApplyEngine');

import type {
    Modification,
    DiffResult,
    ModificationApplyResult,
    BatchApplyResult,
    FastApplyConfig,
    ApplyStatus,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { ProtocolParser, ProtocolParseError } from './ProtocolParser';
import { ContentMatcher } from './ContentMatcher';
import { DiffGenerator } from './DiffGenerator';
import { SnapshotManager } from './SnapshotManager';
import { ModificationExecutor } from './ModificationExecutor';

// ==================== 错误类型 ====================

/**
 * Fast-Apply 引擎错误
 */
export class FastApplyError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly details?: string
    ) {
        super(message);
        this.name = 'FastApplyError';
    }
}

// ==================== 主引擎类 ====================

/**
 * Fast-Apply 引擎
 *
 * 核心编辑引擎，负责：
 * 1. 解析 LLM 输出的 XML 修改协议
 * 2. 在目标文档中匹配要修改的内容
 * 3. 生成 Diff 预览供用户审阅
 * 4. 创建快照并应用修改
 */
export class FastApplyEngine {
    private parser: ProtocolParser;
    private matcher: ContentMatcher;
    private diffGenerator: DiffGenerator;
    private snapshotManager: SnapshotManager;
    private executor: ModificationExecutor;
    private config: FastApplyConfig;

    constructor(config: Partial<FastApplyConfig> = {}) {
        this.config = {
            matcher: { ...DEFAULT_CONFIG.matcher, ...config.matcher },
            snapshot: { ...DEFAULT_CONFIG.snapshot, ...config.snapshot },
        };

        this.parser = new ProtocolParser();
        this.matcher = new ContentMatcher(this.config.matcher);
        this.diffGenerator = new DiffGenerator();
        this.snapshotManager = new SnapshotManager(this.config.snapshot);
        this.executor = new ModificationExecutor();
    }

    /**
     * 解析 XML 并生成修改预览
     *
     * 此方法不会实际应用修改，只返回预览结果供用户审阅
     *
     * @param documentId 文档 ID
     * @param content 当前文档内容
     * @param xml XML 修改协议
     * @returns 批量应用结果（状态为 pending）
     */
    async preview(
        documentId: string,
        content: string,
        xml: string
    ): Promise<BatchApplyResult> {
        // 解析 XML
        let modifications: Modification[];
        try {
            modifications = this.parser.parseModifications(xml);
        } catch (error) {
            if (error instanceof ProtocolParseError) {
                throw new FastApplyError(
                    'Protocol parse failed',
                    'PARSE_ERROR',
                    error.message + (error.details ? `\n${error.details}` : '')
                );
            }
            throw error;
        }
        logger.trace(`[preview] 解析到 ${modifications.length} 个修改`);

        // 为每个修改生成预览
        const results: ModificationApplyResult[] = [];
        const successCount = 0;
        let failedCount = 0;
        let pendingCount = 0;

        // preview 使用独立 matcher 禁用语义匹配：
        // preview 的 XML 来自 diffToXml（机器生成），不是 LLM 输出。
        // 当短搜索串匹配失败时，semanticMatch 每次调 embedding API 耗费 ~20s，
        // 53 个修改中 3 个失败就会阻塞 60s+，最终仍返回 failed
        const previewMatcher = new ContentMatcher({
            ...this.config.matcher,
            enableSemanticMatch: false,
        });

        for (let i = 0; i < modifications.length; i++) {
            const modification = modifications[i];
            const modificationId = `mod-${documentId}-${i}-${Date.now()}`;

            // 确保 modification 存在
            if (!modification) {
                continue;
            }

            try {
                // 匹配内容
                const matchResult = await previewMatcher.match(content, modification.search);

                // 生成 Diff
                let diff: DiffResult;
                let status: ApplyStatus;

                if (matchResult.success) {
                    const { oldContent, newContent } = this.executor.previewModification(
                        content,
                        modification,
                        matchResult
                    );
                    diff = this.diffGenerator.generateDiff(oldContent, newContent);
                    // 诊断：记录每个成功匹配的修改详情
                    const addCount = diff.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'add').length, 0);
                    const removeCount = diff.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'remove').length, 0);
                    logger.trace(`[preview] mod[${i}] ${modification.operation}: matched ${matchResult.matchLevel} L${matchResult.startLine}-${matchResult.endLine}, searchLen=${modification.search.length}, diff: +${addCount} -${removeCount}, hunks=${diff.hunks.length}`);
                    status = 'pending';
                    pendingCount++;
                } else {
                    // 匹配失败
                    logger.trace(`[preview] mod[${i}] ${modification.operation}: MATCH FAILED, searchLen=${modification.search.length}`);
                    diff = {
                        oldContent: content,
                        newContent: content,
                        hunks: [],
                        hasChanges: false,
                    };
                    status = matchResult.matchLevel === 'manual' ? 'pending' : 'failed';
                    if (status === 'pending') {
                        pendingCount++;
                    } else {
                        failedCount++;
                    }
                }

                results.push({
                    modificationId,
                    modification,
                    matchResult,
                    diff,
                    status,
                });
            } catch (error) {
                // 处理错误
                const errorMessage = error instanceof Error ? error.message : String(error);
                results.push({
                    modificationId,
                    modification,
                    matchResult: {
                        success: false,
                        matchLevel: 'manual',
                        confidence: 0,
                        startLine: 0,
                        endLine: 0,
                        matchedContent: '',
                    },
                    diff: {
                        oldContent: content,
                        newContent: content,
                        hunks: [],
                        hasChanges: false,
                    },
                    status: 'failed',
                    error: errorMessage,
                });
                failedCount++;
            }
        }

        return {
            documentId,
            results,
            successCount,
            failedCount,
            pendingCount,
        };
    }

    /**
     * 应用单个修改
     *
     * @param documentId 文档 ID
     * @param content 当前文档内容
     * @param modification 修改协议
     * @returns 应用结果
     */
    async applyModification(
        documentId: string,
        content: string,
        modification: Modification
    ): Promise<{ newContent: string; result: ModificationApplyResult }> {
        const modificationId = `mod-${documentId}-${Date.now()}`;

        // 匹配内容
        const matchResult = await this.matcher.match(content, modification.search);

        if (!matchResult.success) {
            const result: ModificationApplyResult = {
                modificationId,
                modification,
                matchResult,
                diff: {
                    oldContent: content,
                    newContent: content,
                    hunks: [],
                    hasChanges: false,
                },
                status: 'failed',
                error: `Match failed (level: ${matchResult.matchLevel})`,
            };
            return { newContent: content, result };
        }

        // 应用修改
        let newContent: string;
        try {
            newContent = this.executor.applyModification(content, modification, matchResult);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const result: ModificationApplyResult = {
                modificationId,
                modification,
                matchResult,
                diff: {
                    oldContent: content,
                    newContent: content,
                    hunks: [],
                    hasChanges: false,
                },
                status: 'failed',
                error: errorMessage,
            };
            return { newContent: content, result };
        }

        // 创建修改后快照（保存修改后的内容，这样版本号代表该修改完成后的状态）
        let snapshotId: string | undefined;
        if (this.config.snapshot.autoSnapshotBeforeModify) {
            snapshotId = await this.snapshotManager.createSnapshot(
                documentId,
                newContent, // 保存修改后的内容
                modification.description ?? 'Automatic snapshot after modification',
                modificationId
            );
        }

        // 生成 Diff
        const diff = this.diffGenerator.generateDiff(content, newContent);

        const result: ModificationApplyResult = {
            modificationId,
            modification,
            matchResult,
            diff,
            status: 'applied',
            snapshotId,
        };

        return { newContent, result };
    }

    /**
     * 批量应用修改
     *
     * @param documentId 文档 ID
     * @param content 当前文档内容
     * @param xml XML 修改协议
     * @returns 批量应用结果
     */
    async applyFromXml(
        documentId: string,
        content: string,
        xml: string
    ): Promise<{ newContent: string; batchResult: BatchApplyResult }> {
        // 先获取预览
        const previewResult = await this.preview(documentId, content, xml);

        // 过滤出可以应用的修改（状态为 pending 且匹配成功的）
        const applicableResults = previewResult.results.filter(
            (r) => r.status === 'pending' && r.matchResult.success
        );

        if (applicableResults.length === 0) {
            return {
                newContent: content,
                batchResult: previewResult,
            };
        }

        // 创建快照
        let snapshotId: string | undefined;
        if (this.config.snapshot.autoSnapshotBeforeModify) {
            snapshotId = await this.snapshotManager.createSnapshot(
                documentId,
                content,
                `Snapshot before batch changes (${applicableResults.length} modifications)`
            );
        }

        // 应用所有修改
        let currentContent = content;
        const updatedResults: ModificationApplyResult[] = [];
        let successCount = 0;
        let failedCount = 0;

        for (const result of previewResult.results) {
            if (result.status === 'pending' && result.matchResult.success) {
                try {
                    // 重新匹配（因为内容可能已变化）
                    const matchResult = await this.matcher.match(
                        currentContent,
                        result.modification.search
                    );

                    if (matchResult.success) {
                        currentContent = this.executor.applyModification(
                            currentContent,
                            result.modification,
                            matchResult
                        );

                        updatedResults.push({
                            ...result,
                            matchResult,
                            status: 'applied',
                            snapshotId,
                        });
                        successCount++;
                    } else {
                        updatedResults.push({
                            ...result,
                            matchResult,
                            status: 'failed',
                            error: 'Rematch failed',
                        });
                        failedCount++;
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    updatedResults.push({
                        ...result,
                        status: 'failed',
                        error: errorMessage,
                    });
                    failedCount++;
                }
            } else {
                updatedResults.push(result);
                if (result.status === 'failed') failedCount++;
            }
        }

        return {
            newContent: currentContent,
            batchResult: {
                documentId,
                results: updatedResults,
                successCount,
                failedCount,
                pendingCount: 0,
            },
        };
    }

    /**
     * 回滚到指定快照
     *
     * @param snapshotId 快照 ID
     * @returns 快照内容
     */
    async rollback(snapshotId: string): Promise<string> {
        return this.snapshotManager.rollbackTo(snapshotId);
    }

    /**
     * 获取快照列表
     *
     * @param documentId 文档 ID
     */
    async listSnapshots(documentId: string) {
        return this.snapshotManager.listSnapshots(documentId);
    }

    /**
     * 从文本中提取并解析修改协议
     *
     * 用于处理 LLM 输出中混合了普通文本和 XML 的情况
     *
     * @param text 可能包含 XML 的文本
     * @returns 提取到的 Modification 数组
     */
    extractModifications(text: string): Modification[] {
        return this.parser.extractFromText(text);
    }

    // ==================== Getter 方法 ====================

    /** 获取解析器实例 */
    getParser(): ProtocolParser {
        return this.parser;
    }

    /** 获取匹配器实例 */
    getMatcher(): ContentMatcher {
        return this.matcher;
    }

    /** 获取 Diff 生成器实例 */
    getDiffGenerator(): DiffGenerator {
        return this.diffGenerator;
    }

    /** 获取快照管理器实例 */
    getSnapshotManager(): SnapshotManager {
        return this.snapshotManager;
    }

    /** 获取修改执行器实例 */
    getExecutor(): ModificationExecutor {
        return this.executor;
    }
}

// ==================== 导出单例 ====================

/** 默认 Fast-Apply 引擎实例 */
export const fastApplyEngine = new FastApplyEngine();
