/**
 * FileWriteTool - 统一智能文件工具
 *
 * 整合 write + edit 功能，自动推断操作模式：
 * - 文件不存在 → 创建新文件（全绿 Diff）
 * - 文件存在 → 覆盖文件（红绿 Diff）
 *
 * 设计理念：
 * - 让 LLM 只需关注"写什么内容"，不需要决定"用哪个工具"
 * - 直接写入并生成 Diff 预览
 * - 自动索引到知识库
 */

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { translate } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import type { DiffResult, PatchItem, PatchItemResult, MatchResult } from '../../../fast-apply/types';
import { validateSyntax, type SyntaxError as PostWriteSyntaxError } from './PostWriteValidator';
import { getLogger } from '@services/logger';
import { getSandboxPathViolation } from '../shared/sandboxPath';
import { countTextLines, measureRendererWork } from '@services/diagnostics/rendererHealth';
import { getKnowledgeDocumentType, shouldAutoIndexKnowledgeFile } from '@services/rag/KnowledgeFileFilter';

const logger = getLogger('tool');

/**
 * 工具 Schema
 */
const SCHEMA: ToolSchema = {
    name: 'file_write',
    description: 'Write text file content. Never call with empty arguments. Full mode requires path and content. Patch mode requires path, mode="patch", and patches with search/replace pairs.',
    parameters: {
        type: 'object',
        description: 'Non-empty argument object. For full writes, pass {"path": "...", "mode": "full", "content": "..."}. For patches, pass {"path": "...", "mode": "patch", "patches": [{"search": "...", "replace": "..."}]}.',
        properties: {
            path: {
                type: 'string',
                description: 'Required. Target file path, relative or absolute.',
            },
            content: {
                type: 'string',
                description: 'Required when mode is "full". Complete file content to create or overwrite.',
            },
            mode: {
                type: 'string',
                enum: ['full', 'patch'],
                description: 'Write mode. Use "full" for complete content writes. Use "patch" only when patches is provided.',
            },
            patches: {
                type: 'array',
                description: 'Required when mode is "patch". Non-empty list of search/replace patch objects.',
                items: {
                    type: 'object',
                    description: 'Single patch item containing search text and replacement text.',
                    properties: {
                        search: {
                            type: 'string',
                            description: 'Original text fragment to find. It should be specific enough to match uniquely.',
                        },
                        replace: {
                            type: 'string',
                            description: 'New content that replaces the matched search text.',
                        },
                    },
                    required: ['search', 'replace'],
                },
            },
        },
        required: ['path'],
    },
};

/**
 * FileWriteTool 返回的 Diff 数据结构
 */
export interface FileWriteDiffData {
    /** 目标文件路径 */
    filePath: string;
    /** 原始内容（新文件为空字符串） */
    originalContent: string;
    /** 新内容 */
    newContent: string;
    /** Diff 结果 */
    diff: DiffResult;
    /** 是否为新创建的文件 */
    isNewFile: boolean;
}

interface StagedWriteResult {
    success: boolean;
    filePath: string;
    backupPath?: string | null;
    bytesWritten: number;
    existedBefore: boolean;
}

/**
 * 智能模式决策结果
 */
interface ModeDecision {
    /** 操作模式 */
    mode: 'create' | 'overwrite' | 'merge';
    /** 差异比例 (0-1) */
    changeRatio?: number;
    /** 决策原因 */
    reason: string;
    /** XML 编辑指令(仅 merge 模式) */
    xmlInstructions?: string;
}

interface SyntaxCheckAppendResult {
    note: string;
    validation?: Record<string, unknown>;
}

function isCancelled(context: ToolExecutionContext): boolean {
    return context.signal?.aborted === true;
}

function cancelledResult(path: string): ToolResult {
    return {
        success: false,
        content: translate('tools.fileWrite.failed', {
            path,
            error: translate('tools.fileWrite.cancelled'),
        }),
    };
}

function normalizeForMergeComparison(content: string): string {
    return content.replace(/\r\n?/g, '\n');
}

function mergeOutputMatchesIntendedContent(
    mergeOutput: string,
    intendedContent: string
): boolean {
    return normalizeForMergeComparison(mergeOutput) === normalizeForMergeComparison(intendedContent);
}

/**
 * FileWriteTool 实现
 */
class FileWriteToolImpl implements Tool {
    readonly schema = SCHEMA;

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        // 参数别名容错：不同 LLM 对参数命名有不同偏好
        // Claude 倾向用 file_path，Gemini 用 path，GPT 可能用 filePath
        let path = (params.path ?? params.file_path ?? params.filePath) as string;
        const contentRef = (params.contentRef ?? params.content_ref) as string | undefined;
        const content = params.content as string | undefined;
        const mode = ((params.mode ?? params.write_mode) as string) || 'full';
        // patches 容错：某些 LLM 会将 patches 作为 JSON 字符串传入而非解析后的数组
        // 且 LLM 生成的 JSON 可能存在转义不完整的问题（如 replace 中含未转义的换行符）
        // 复用 JsonParser 的多策略解析管道处理这些情况
        let patches: PatchItem[] | undefined;
        const rawPatches = params.patches;
        if (typeof rawPatches === 'string') {
            const { parseWithFallback } = await import('../../../memory/utils/JsonParser');
            const result = parseWithFallback<PatchItem[]>(rawPatches, {
                logPrefix: '[FileWriteTool.patches]',
            });
            if (result.success && Array.isArray(result.data)) {
                patches = result.data;
            logger.trace(`[FileWriteTool] patches 从字符串解析成功: ${patches.length} 个补丁 (策略: ${result.strategy ?? 'unknown'}, 质量: ${result.quality ?? 'unknown'})`);
            } else {
                // 最后防线：基于分隔符的定向提取（不依赖 JSON.parse）
                // 处理 replace 值中含未转义双引号等 JSON 无法修复的极端情况
                logger.warn('[FileWriteTool] patches 字符串解析失败，尝试分隔符提取:', result.error);
                patches = this.extractPatchesByDelimiters(rawPatches);
                if (patches) {
                    logger.trace(`[FileWriteTool] patches 分隔符提取成功: ${patches.length} 个补丁`);
                } else {
                    logger.warn('[FileWriteTool] patches 分隔符提取也失败');
                }
            }
        } else if (Array.isArray(rawPatches)) {
            patches = rawPatches as PatchItem[];
        }

        // 参数验证
        if (!path) {
            return {
                success: false,
                content: translate('tools.fileWrite.missingPath'),
            };
        }

        // 解析相对路径为绝对路径
        path = this.resolvePath(path, context.workdir);
        const sandboxViolation = getSandboxPathViolation(path, context);
        if (sandboxViolation) {
            return {
                success: false,
                content: sandboxViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path })
                    : translate('tools.common.sandboxPathDenied', {
                        path,
                        root: sandboxViolation.root,
                        mode: sandboxViolation.mode,
                    }),
            };
        }
        logger.trace(`[FileWriteTool] 解析后的路径: ${path}, 模式: ${mode}`);
        if (isCancelled(context)) return cancelledResult(path);

        // ═══ Patch 模式分支 ═══
        if (mode === 'patch') {
            if (!patches || patches.length === 0) {
                return {
                    success: false,
                    content: translate('tools.fileWrite.missingPatches'),
                };
            }
            return this.executePatch(path, patches, context);
        }

        if (contentRef) {
            return this.executeStagedFullWrite(path, contentRef, context);
        }

        // ═══ Full 模式（默认）═══
        if (content === undefined) {
            return {
                success: false,
                content: translate('tools.fileWrite.missingContent'),
            };
        }

        try {
            // ═══ 阶段 1: 检查文件是否存在 ═══
            let originalContent = '';

            try {
                originalContent = await invoke<string>('file_read_content', { filePath: path });
                logger.trace(`[FileWriteTool] 文件已存在 (${originalContent.length} 字符)`);
            } catch {
                // 文件不存在,执行创建模式
                logger.trace('[FileWriteTool] 文件不存在,创建新文件');
                return await this.executeCreate(path, content, context);
            }
            if (isCancelled(context)) return cancelledResult(path);

            // ═══ 阶段 1.5: 内容相同时短路返回 ═══
            // 当 Sub-Agent 写入的内容与文件完全一致时，跳过写入避免无意义的
            // merge/overwrite 操作（merge 模式下 0% 差异会导致空 XML → 协议解析失败）
            if (content === originalContent) {
                logger.trace('[FileWriteTool] 内容无变化,跳过写入');
                return {
                    success: true,
                    content: translate('tools.fileWrite.unchanged', { path }),
                };
            }

            // ═══ 阶段 2: 智能模式决策 ═══
            const decision = await this.decideMode(path, content, originalContent, context);
            if (isCancelled(context)) return cancelledResult(path);

            logger.trace(`[FileWriteTool] 模式决策: ${decision.mode} - ${decision.reason}`);
            context.onProgress?.(translate('tools.fileWrite.progressExisting', {
                mode: decision.mode,
                reason: decision.reason,
            }));

            // ═══ 阶段 3: 根据决策执行 ═══
            switch (decision.mode) {
                case 'overwrite':
                    return await this.executeOverwrite(path, content, originalContent, decision, context);

                case 'merge':
                    return await this.executeMerge(path, content, originalContent, decision, context);

                default:
                    throw new Error(`Unknown mode: ${decision.mode}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                content: translate('tools.fileWrite.failed', { path, error: errorMessage }),
            };
        }
    }

    /**
     * 后端暂存的大 content 直接由 Rust 写入目标文件，避免经由 WebView IPC 往返。
     */
    private async executeStagedFullWrite(
        path: string,
        contentRef: string,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        if (context.onRequestAuthorization) {
            const authorized = await context.onRequestAuthorization('write', path);
            if (!authorized) {
                return {
                    success: false,
                    content: translate('tools.fileWrite.deniedCreate', { path }),
                };
            }
        }
        if (isCancelled(context)) return cancelledResult(path);

        context.onProgress?.(translate('tools.fileWrite.progressCreate', {
            fileName: this.getFileName(path),
        }));

        try {
            const result = await invoke<StagedWriteResult>('file_write_staged_tool_arg_to_path', {
                path,
                refId: contentRef,
                createBackup: false,
            });
            if (isCancelled(context)) return cancelledResult(path);

            const writtenPath = result.filePath || path;

            if (context.agentId) {
                if (await this.shouldAutoIndex(context.agentId)) {
                    try {
                        const indexedContent = await invoke<string>('file_read_content', { filePath: writtenPath });
                        if (isCancelled(context)) return cancelledResult(writtenPath);
                        await this.addToKnowledgePaths(context.agentId, writtenPath);
                        await this.indexToKnowledgeBase(context.agentId, writtenPath, indexedContent);
                    } catch (indexError) {
                        logger.warn('[FileWriteTool] staged 写入后索引到知识库失败:', indexError);
                    }
                }
                if (isCancelled(context)) return cancelledResult(writtenPath);
                await emit('file:deliverable_created', {
                    agentId: context.agentId,
                    filePath: writtenPath,
                    fileName: this.getFileName(writtenPath),
                });
            }

            const syntaxCheck = await this.appendSyntaxCheck(writtenPath, context);
            if (isCancelled(context)) return cancelledResult(writtenPath);

            const type = result.existedBefore ? 'file_write_overwrite' : 'file_write_create';
            return {
                success: true,
                content: result.existedBefore
                    ? translate('tools.fileWrite.overwritten', {
                        fileName: this.getFileName(writtenPath),
                        bytes: result.bytesWritten,
                        reason: translate('tools.fileWrite.stagedWriteReason'),
                        syntaxNote: syntaxCheck.note,
                    })
                    : translate('tools.fileWrite.created', {
                        fileName: this.getFileName(writtenPath),
                        bytes: result.bytesWritten,
                        syntaxNote: syntaxCheck.note,
                    }),
                requiresInteraction: false,
                data: {
                    type,
                    filePath: writtenPath,
                    bytesWritten: result.bytesWritten,
                    ...(syntaxCheck.validation && { validation: syntaxCheck.validation }),
                },
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                content: translate('tools.fileWrite.failed', { path, error: errorMessage }),
            };
        }
    }

    /**
     * 智能决策操作模式
     * 
     * 基于新旧内容的差异量进行模式判断:
     * - 差异 > 70% → 覆盖模式(完整新文档)
     * - 差异 ≤ 30% → 智能合并模式(保留原有结构)
     * - 30% < 差异 ≤ 70% → 覆盖模式(带警告)
     */
    private async decideMode(
        _path: string,
        newContent: string,
        originalContent: string,
        _context: ToolExecutionContext
    ): Promise<ModeDecision> {
        // 阈值配置
        const OVERWRITE_THRESHOLD = 0.7;  // 70% 以上差异 → 覆盖
        const MERGE_THRESHOLD = 0.3;      // 30% 以下差异 → 合并

        // 导入 FastApplyService
        const { fastApplyService } = await import('../../../fast-apply/FastApplyService');

        // 生成 Diff
        const diff = measureRendererWork(
            'file_write.decideMode.generateDiff',
            {
                originalChars: originalContent.length,
                newChars: newContent.length,
                originalLines: countTextLines(originalContent),
                newLines: countTextLines(newContent),
            },
            () => fastApplyService.generateDiff(originalContent, newContent)
        );

        // 计算差异比例
        const totalLines = diff.hunks.reduce((sum, h) => sum + h.lines.length, 0);
        const changedLines = diff.hunks.reduce((sum, h) =>
            sum + h.lines.filter(l => l.type !== 'context').length, 0
        );
        const changeRatio = totalLines > 0 ? changedLines / totalLines : 0;

        logger.trace(`[FileWriteTool] 差异分析: ${(changeRatio * 100).toFixed(1)}% 变化 (${changedLines}/${totalLines} 行)`);

        // 模式判断
        if (changeRatio > OVERWRITE_THRESHOLD) {
            return {
                mode: 'overwrite',
                changeRatio,
                reason: translate('tools.fileWrite.decisionOverwriteLarge', {
                    ratio: (changeRatio * 100).toFixed(1),
                    threshold: OVERWRITE_THRESHOLD * 100,
                })
            };
        }

        if (changeRatio <= MERGE_THRESHOLD) {
            // 生成 XML 编辑指令。
            // 使用 diffToXml 的多行唯一锚点逻辑，避免纯插入在重复行上命中错误位置。
            const { diffToXml } = await import('../../../fast-apply/DiffToXmlConverter');
            const xmlInstructions = diffToXml(diff, originalContent);

            return {
                mode: 'merge',
                changeRatio,
                reason: translate('tools.fileWrite.decisionMergeSmall', {
                    ratio: (changeRatio * 100).toFixed(1),
                    threshold: MERGE_THRESHOLD * 100,
                }),
                xmlInstructions
            };
        }

        // 中间区域:建议覆盖,但给出警告
        return {
            mode: 'overwrite',
            changeRatio,
            reason: translate('tools.fileWrite.decisionOverwriteMedium', {
                ratio: (changeRatio * 100).toFixed(1),
            })
        };
    }

    /**
     * 创建新文件
     */
    private async executeCreate(
        path: string,
        content: string,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        // 请求授权
        if (context.onRequestAuthorization) {
            const authorized = await context.onRequestAuthorization('write', path);
            if (!authorized) {
                return {
                    success: false,
                    content: translate('tools.fileWrite.deniedCreate', { path }),
                };
            }
        }
        if (isCancelled(context)) return cancelledResult(path);

        // 写入文件
        context.onProgress?.(translate('tools.fileWrite.progressCreate', {
            fileName: this.getFileName(path),
        }));
        await invoke('file_write_to_path', {
            path,
            content,
            createBackup: false,
        });
        if (isCancelled(context)) return cancelledResult(path);

        // 知识库集成（受 autoIndexDeliverables 开关控制）
        if (context.agentId) {
            if (await this.shouldAutoIndex(context.agentId)) {
                await this.addToKnowledgePaths(context.agentId, path);
                await this.indexToKnowledgeBase(context.agentId, path, content);
            }
            await emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: path,
                fileName: this.getFileName(path),
            });
        }

        const bytesWritten = new TextEncoder().encode(content).length;
        // 写入成功后自动语法检查（仅 Sub-Agent 场景），结果追加到 Observation
        const syntaxCheck = await this.appendSyntaxCheck(path, context);
        if (isCancelled(context)) return cancelledResult(path);

        return {
            success: true,
            content: translate('tools.fileWrite.created', {
                fileName: this.getFileName(path),
                bytes: bytesWritten,
                syntaxNote: syntaxCheck.note,
            }),
            requiresInteraction: false,
            data: {
                type: 'file_write_create',
                filePath: path,
                bytesWritten,
                ...(syntaxCheck.validation && { validation: syntaxCheck.validation }),
            },
        };
    }

    /**
     * Patch 模式：对已有文件应用多个 search/replace 补丁
     *
     * 设计要点：
     * - 先匹配定位所有 patch，再按位置逆序应用（避免偏移错乱）
     * - 使用 matchedContent 做替换（兼容精确、模糊、语义匹配）
     * - 部分失败时仍写入成功的部分，并在返回信息中明确标注
     * - 文件不存在时智能降级为 full 模式创建
     *
     * @param path - 目标文件路径
     * @param patches - 补丁列表
     * @param context - 工具执行上下文
     */
    private async executePatch(
        path: string,
        patches: PatchItem[],
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        // 1. 读取文件内容
        let originalContent: string;
        try {
            originalContent = await invoke<string>('file_read_content', { filePath: path });
            logger.trace(`[FileWriteTool] patch 模式: 读取文件成功 (${originalContent.length} 字符)`);
        } catch {
            // 智能适应：文件不存在时，将 patches 的 replace 拼接为初始内容
            // 降级为 full 模式创建
            logger.trace('[FileWriteTool] patch 模式: 文件不存在，智能降级为 full 模式创建');
            const assembledContent = patches.map(p => p.replace).join('\n');
            return this.executeCreate(path, assembledContent, context);
        }

        // 2. 逐个匹配定位
        const { ContentMatcher } = await import('../../../fast-apply/ContentMatcher');
        const matcher = new ContentMatcher();
        const patchTimingStart = Date.now();

        // 定位成功的 patch 信息
        interface LocatedPatch {
            patch: PatchItem;
            matchResult: MatchResult;
        }

        const locatedPatches: LocatedPatch[] = [];
        const patchResults: PatchItemResult[] = [];

        for (const [i, patch] of patches.entries()) {
            // 诊断日志：打印 patch 的 search/replace 预览，便于排查匹配问题
            const searchPreviewLog = patch.search.length > 80
                ? `${patch.search.substring(0, 80)}...`
                : patch.search;
            const replacePreviewLog = patch.replace.length > 80
                ? `${patch.replace.substring(0, 80)}...`
                : patch.replace;
            logger.trace(`[FileWriteTool] patch[${i}] search: "${searchPreviewLog}"`);
            logger.trace(`[FileWriteTool] patch[${i}] replace: "${replacePreviewLog}"`);

            const matchStart = Date.now();
            const matchResult = await matcher.match(originalContent, patch.search);
            if (isCancelled(context)) return cancelledResult(path);
            const matchElapsed = Date.now() - matchStart;
            logger.trace(`[FileWriteTool] patch[${i}] match: ${matchResult.success ? matchResult.matchLevel : 'FAILED'} (${matchElapsed}ms, searchLen=${patch.search.length})`);

            if (matchResult.success) {
                locatedPatches.push({ patch, matchResult });
                patchResults.push({
                    patch,
                    success: true,
                    matchLevel: matchResult.matchLevel,
                    confidence: matchResult.confidence,
                });
            } else {
                // 匹配失败时，获取最相似的候选片段帮助 LLM 修正 search
                const searchPreview = patch.search.length > 50
                    ? `${patch.search.substring(0, 50)}...`
                    : patch.search;

                // 尝试获取最接近的候选内容（top-1）
                const candidates = matcher.getFuzzyCandidates(originalContent, patch.search, 1);
                let errorMsg = translate('tools.fileWrite.patchNoMatch', { preview: searchPreview });

                const best = candidates[0];
                if (best) {
                    const candidatePreview = best.content.length > 80
                        ? `${best.content.substring(0, 80)}...`
                        : best.content;
                    errorMsg += translate('tools.fileWrite.patchSimilar', {
                        line: best.startLine,
                        score: Math.round(best.score * 100),
                        preview: candidatePreview,
                    });
                }

                patchResults.push({
                    patch,
                    success: false,
                    error: errorMsg,
                });
            }
        }
        logger.trace(`[FileWriteTool] 全部 patch 匹配完成: ${locatedPatches.length}/${patches.length} 成功 (总耗时 ${Date.now() - patchTimingStart}ms)`);

        // 3. 全部失败 → 返回错误 + 排查建议
        if (locatedPatches.length === 0) {
            const failedDetails = patchResults
                .filter(r => !r.success)
            .map(r => `  - ❌ ${r.error ?? 'unknown error'}`)
                .join('\n');
            return {
                success: false,
                content: translate('tools.fileWrite.allPatchesFailed', {
                    count: patches.length,
                    details: failedDetails,
                }),
                requiresInteraction: false,
            };
        }

        // 4. 按 startOffset 逆序排序（从后往前应用，避免偏移错乱）
        // 使用 ContentMatcher 返回的 startOffset 作为主排序键
        // 无 startOffset 时回退到 indexOf(matchedContent)
        locatedPatches.sort((a, b) => {
            const offsetA = a.matchResult.startOffset
                ?? originalContent.indexOf(a.matchResult.matchedContent);
            const offsetB = b.matchResult.startOffset
                ?? originalContent.indexOf(b.matchResult.matchedContent);
            return offsetB - offsetA; // 逆序：从后向前
        });

        // 5. 逐个应用替换（逆序：从后往前，避免偏移漂移）
        let newContent = originalContent;
        for (const { patch, matchResult } of locatedPatches) {
            if (isCancelled(context)) return cancelledResult(path);
            // 逆序应用时，startOffset 是基于 originalContent 的偏移量，
            // 但 newContent 在每轮循环都可能因前一个 patch 的替换而改变长度，
            // 直接使用 startOffset 可能定位到错误位置。
            // 正确策略：优先在当前 newContent 中重新 indexOf(matchedContent)，
            // 利用逆序保证更靠后的 patch 替换不影响当前 patch 的位置；
            // 找不到时才 fallback 到 startOffset（极少数 CRLF/LF 特殊情况）。
            const matchLen = matchResult.matchLength ?? matchResult.matchedContent.length;
            const dynamicIdx = newContent.indexOf(matchResult.matchedContent);
            const idx = dynamicIdx !== -1 ? dynamicIdx : (matchResult.startOffset ?? -1);
            if (idx !== -1 && idx + matchLen <= newContent.length) {
                newContent = newContent.substring(0, idx)
                    + patch.replace
                    + newContent.substring(idx + matchLen);
            }
        }

        // 6. 内容无变化时返回引导信息
        // 可能原因：search 匹配到了但 replace 与原文相同，或 search 未匹配但被模糊匹配到相同内容
        if (newContent === originalContent) {
            // 区分"search 未命中"和"replace 与原文相同"两种情况
            const allPatchesMatched = locatedPatches.length === patches.length;
            const hint = allPatchesMatched
                ? translate('tools.fileWrite.noChangeAllMatched')
                : translate('tools.fileWrite.noChangePartial', {
                    count: patches.length - locatedPatches.length,
                });
            return {
                success: true,
                content: translate('tools.fileWrite.noChangeFile', {
                    fileName: this.getFileName(path),
                    hint,
                }),
                requiresInteraction: false,
            };
        }

        // 7. 写入文件
        const writeStart = Date.now();
        await invoke('file_write_to_path', {
            path,
            content: newContent,
            createBackup: true,
        });
        logger.trace(`[FileWriteTool] file_write_to_path 完成 (${Date.now() - writeStart}ms, ${newContent.length} 字符)`);
        if (isCancelled(context)) return cancelledResult(path);

        // 8. 知识库集成（受 autoIndexDeliverables 开关控制）
        // RAG 索引后台异步执行，不阻塞工具返回，确保 Diff 实时发射
        const ragStart = Date.now();
        if (context.agentId) {
            if (await this.shouldAutoIndex(context.agentId)) {
                await this.addToKnowledgePaths(context.agentId, path);
                // fire-and-forget：大文件索引可能耗时数分钟，不应阻塞 Diff 回调
                this.indexToKnowledgeBase(context.agentId, path, newContent).catch((err: unknown) => {
                    logger.warn('[FileWriteTool] 后台 RAG 索引失败:', err);
                });
            }
            await emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: path,
                fileName: this.getFileName(path),
            });
        }
        logger.trace(`[FileWriteTool] RAG + deliverable 事件完成 (${Date.now() - ragStart}ms)`);

        // 9. 生成 Diff 和 XML（复用现有管道供 UI 层 loadModifications 使用）
        const diffStart = Date.now();
        const { fastApplyService } = await import('../../../fast-apply/FastApplyService');
        const diff = measureRendererWork(
            'file_write.executePatch.generateDiff',
            {
                originalChars: originalContent.length,
                newChars: newContent.length,
                originalLines: countTextLines(originalContent),
                newLines: countTextLines(newContent),
                patches: locatedPatches.length,
            },
            () => fastApplyService.generateDiff(originalContent, newContent)
        );
        if (isCancelled(context)) return cancelledResult(path);

        const { diffToXml } = await import('../../../fast-apply/DiffToXmlConverter');
        // 传入 originalContent，启用 INSERT 块锚点唯一性检测（5.1 修复）
        const xml = diffToXml(diff, originalContent);
        logger.trace(`[FileWriteTool] diff + xml 生成完成 (${Date.now() - diffStart}ms, hunks=${diff.hunks.length}, xmlLen=${xml.length})`);

        // 10. 构建返回信息（含每个 patch 的行号、匹配详情和修改后上下文）
        const successCount = locatedPatches.length;
        const failedCount = patches.length - successCount;
        const newContentLines = newContent.split('\n');

        // 逐条构建详细结果，帮助模型了解每个 patch 的实际效果
        // 对成功的 patch 附带修改后的上下文片段（±3 行），避免 LLM 用旧 search 重试
        const detailedResults = patchResults.map((r, i) => {
            if (r.success) {
                const located = locatedPatches.find(lp => lp.patch === r.patch);
                // 优先使用 MatchResult.startLine（1-based），回退到 startOffset 计算
                const lineNo = located?.matchResult.startLine
                    ?? (located?.matchResult.startOffset !== undefined
                        ? this.getLineNumber(originalContent, located.matchResult.startOffset)
                        : '?');
                let result = translate('tools.fileWrite.patchSuccessDetail', {
                    index: i + 1,
                    line: lineNo,
                    level: r.matchLevel ?? 'exact',
                });

                // 附带修改后的上下文片段，让 LLM 知道修改后的实际内容
                // 在 newContent 中定位 replace 内容并提取 ±3 行上下文
                if (located && context.isSubAgentContext) {
                    const snippet = this.getModifiedSnippet(
                        newContentLines, located.patch.replace, 3
                    );
                    if (snippet) {
                        result += translate('tools.fileWrite.modifiedContent', { snippet });
                    }
                }

                return result;
            } else {
                return translate('tools.fileWrite.patchFailedDetail', {
                    index: i + 1,
                    error: r.error ?? '',
                });
            }
        });

        const statusLine = failedCount > 0
            ? translate('tools.fileWrite.patchPartialStatus', {
                success: successCount,
                total: patches.length,
                failed: failedCount,
                details: detailedResults.join('\n'),
            })
            : translate('tools.fileWrite.patchSuccessStatus', {
                count: successCount,
                details: detailedResults.join('\n'),
            });

        // Sub-Agent 模式：直接返回成功
        if (context.isSubAgentContext) {
            // 写入成功后自动语法检查，结果追加到 Observation
            const syntaxCheck = await this.appendSyntaxCheck(path, context);
            if (isCancelled(context)) return cancelledResult(path);
            return {
                success: true,
                content: translate('tools.fileWrite.patchResult', {
                    statusLine,
                    fileName: this.getFileName(path),
                    syntaxNote: syntaxCheck.note,
                }),
                requiresInteraction: false,
                data: {
                    type: 'file_write_patch',
                    filePath: path,
                    originalContent,
                    newContent,
                    xml,
                    changeRatio: diff.hunks.length > 0 ? successCount / patches.length : 0,
                    modificationCount: successCount,
                    ...(syntaxCheck.validation && { validation: syntaxCheck.validation }),
                },
            };
        }

        // 普通模式：返回 Diff 预览
        return {
            success: true,
            content: translate('tools.fileWrite.patchPreview', {
                fileName: this.getFileName(path),
                statusLine,
            }),
            requiresInteraction: true,
            data: {
                type: 'file_write_patch',
                filePath: path,
                originalContent,
                newContent,
                diff,
                xml,
                modificationCount: successCount,
            },
        };
    }

    /**
     * 覆盖模式执行
     */
    private async executeOverwrite(
        path: string,
        newContent: string,
        originalContent: string,
        decision: ModeDecision,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        // 请求授权
        if (context.onRequestAuthorization) {
            const authorized = await context.onRequestAuthorization('write', path);
            if (!authorized) {
                return {
                    success: false,
                    content: translate('tools.fileWrite.deniedOverwrite', { path }),
                };
            }
        }
        if (isCancelled(context)) return cancelledResult(path);

        // 写入文件
        context.onProgress?.(translate('tools.fileWrite.progressOverwrite', {
            fileName: this.getFileName(path),
        }));
        await invoke('file_write_to_path', {
            path,
            content: newContent,
            createBackup: true,
        });
        if (isCancelled(context)) return cancelledResult(path);

        // 生成 Diff
        const { fastApplyService } = await import('../../../fast-apply/FastApplyService');
        const diff = measureRendererWork(
            'file_write.executeOverwrite.generateDiff',
            {
                originalChars: originalContent.length,
                newChars: newContent.length,
                originalLines: countTextLines(originalContent),
                newLines: countTextLines(newContent),
            },
            () => fastApplyService.generateDiff(originalContent, newContent)
        );
        if (isCancelled(context)) return cancelledResult(path);

        // 知识库集成（受 autoIndexDeliverables 开关控制）
        // RAG 索引后台异步执行，不阻塞工具返回，确保 Diff 实时发射
        if (context.agentId) {
            if (await this.shouldAutoIndex(context.agentId)) {
                await this.addToKnowledgePaths(context.agentId, path);
                // fire-and-forget：大文件索引可能耗时数分钟，不应阻塞 Diff 回调
                this.indexToKnowledgeBase(context.agentId, path, newContent).catch((err: unknown) => {
                    logger.warn('[FileWriteTool] 后台 RAG 索引失败:', err);
                });
            }
            await emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: path,
                fileName: this.getFileName(path),
            });
        }

        const diffData: FileWriteDiffData = {
            filePath: path,
            originalContent,
            newContent,
            diff,
            isNewFile: false,
        };

        const bytesWritten = new TextEncoder().encode(newContent).length;

        // Sub-Agent 模式:生成 XML 修改协议，使下游能复用 loadModifications 管道
        if (context.isSubAgentContext) {
            // overwrite 模式直接使用整文件 REPLACE XML，不使用 diffToXml。
            //
            // 为何不用 diffToXml(diff)：
            // overwrite 场景（≥70% 变化）中，diffToXml 产出的多个 DELETE/INSERT block
            // 可能有完全相同的 search 内容（如重复的 CSS 选择器行 `.stat-card { ... }`），
            // 导致 preview() 的 indexOf 把多个 modification 映射到同一原始行，
            // deduplicateOverlappingMods 消除重复后少算实际删除次数，
            // 最终 diff 总行数比实际文件多（如本例：1320 vs 1313，偏差 7 行）。
            //
            // generateWholeFileReplaceXml 产出单一 REPLACE(orig→new)，
            // 无 search 重复问题，FullFileDiffBuilder 内部的局部 myersDiff
            // 保证 diff 内容与实际文件完全一致。
            const { generateWholeFileReplaceXml } = await import('../../../fast-apply/DiffToXmlConverter');
            const xml = generateWholeFileReplaceXml(originalContent, newContent);
            logger.trace(`[FileWriteTool] overwrite: 使用整文件 REPLACE XML (xmlLen=${xml.length})`);
            if (isCancelled(context)) return cancelledResult(path);

            // 写入成功后自动语法检查，结果追加到 Observation
            const syntaxCheck = await this.appendSyntaxCheck(path, context);
            if (isCancelled(context)) return cancelledResult(path);

            return {
                success: true,
                content: translate('tools.fileWrite.overwritten', {
                    fileName: this.getFileName(path),
                    bytes: bytesWritten,
                    reason: decision.reason,
                    syntaxNote: syntaxCheck.note,
                }),
                requiresInteraction: false,
                data: {
                    type: 'file_write_overwrite',
                    ...diffData,
                    xml,
                    changeRatio: decision.changeRatio,
                    ...(syntaxCheck.validation && { validation: syntaxCheck.validation }),
                },
            };
        }

        // 普通模式:返回 Diff 预览
        return {
            success: true,
            content: translate('tools.fileWrite.overwritePreview', {
                fileName: this.getFileName(path),
                reason: decision.reason,
            }),
            requiresInteraction: true,
            data: {
                type: 'file_write_overwrite',
                ...diffData,
            },
        };
    }

    /**
     * 智能合并模式执行(委托给 FastApply 引擎)
     * 
     * 合并失败时自动降级为覆盖模式，确保写入操作始终完成
     */
    private async executeMerge(
        path: string,
        newContent: string,
        originalContent: string,
        decision: ModeDecision,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        logger.trace('[FileWriteTool] 使用智能合并模式,生成 XML 指令');

        const { fastApplyService } = await import('../../../fast-apply/FastApplyService');
        if (isCancelled(context)) return cancelledResult(path);

        // 尝试应用 XML 指令，异常时降级为覆盖模式
        let result;
        try {
            result = await fastApplyService.applyAll(
                path,
                originalContent,
                decision.xmlInstructions ?? ''
            );
            if (isCancelled(context)) return cancelledResult(path);
        } catch (mergeError) {
            // XML 解析失败或匹配异常 → 降级为覆盖
            logger.warn('[FileWriteTool] 智能合并异常,降级为覆盖模式:', mergeError);
            return this.executeOverwrite(path, newContent, originalContent, {
                mode: 'overwrite',
                changeRatio: decision.changeRatio,
                reason: translate('tools.fileWrite.mergeExceptionFallback')
            }, context);
        }

        // 合并匹配全部失败 → 降级为覆盖
        if (result.batchResult.successCount === 0) {
            logger.warn('[FileWriteTool] 智能合并失败(无匹配),降级为覆盖模式');
            return this.executeOverwrite(path, newContent, originalContent, {
                mode: 'overwrite',
                changeRatio: decision.changeRatio,
                reason: translate('tools.fileWrite.mergeNoMatchFallback')
            }, context);
        }

        if (!mergeOutputMatchesIntendedContent(result.newContent, newContent)) {
            logger.warn('[FileWriteTool] 智能合并结果与目标全文不一致,降级为覆盖模式');
            return this.executeOverwrite(path, newContent, originalContent, {
                mode: 'overwrite',
                changeRatio: decision.changeRatio,
                reason: translate('tools.fileWrite.mergeMismatchFallback')
            }, context);
        }

        // 写入合并后的内容（使用正确的 Tauri 命令）
        await invoke('file_write_to_path', {
            path,
            content: result.newContent,
            createBackup: true,
        });
        if (isCancelled(context)) return cancelledResult(path);

        // 知识库集成（受 autoIndexDeliverables 开关控制）
        if (context.agentId) {
            if (isCancelled(context)) return cancelledResult(path);
            if (await this.shouldAutoIndex(context.agentId)) {
                await this.addToKnowledgePaths(context.agentId, path);
                await this.indexToKnowledgeBase(context.agentId, path, result.newContent);
            }
            if (isCancelled(context)) return cancelledResult(path);
            await emit('file:deliverable_created', {
                agentId: context.agentId,
                filePath: path,
                fileName: this.getFileName(path),
            });
        }

        // Sub-Agent 模式:直接返回成功
        // merge 模式必须生成 xml 字段，供 setupRealtimeDiffCallback 发射 Diff 数据到 UI。
        // 缺少 xml 时 record.xml 为 undefined，onDiffData 收到空 xml，loadModifications 无法
        // 解析修改，导致 diff 面板空白但文件已被写入（文件与 UI 不一致）。
        // 与 overwrite 模式保持一致，使用整文件 REPLACE XML。
        if (context.isSubAgentContext) {
            const { generateWholeFileReplaceXml } = await import('../../../fast-apply/DiffToXmlConverter');
            const xml = generateWholeFileReplaceXml(originalContent, result.newContent);
            if (isCancelled(context)) return cancelledResult(path);
            // 写入成功后自动语法检查，结果追加到 Observation
            const syntaxCheck = await this.appendSyntaxCheck(path, context);
            if (isCancelled(context)) return cancelledResult(path);
            return {
                success: true,
                content: translate('tools.fileWrite.merged', {
                    fileName: this.getFileName(path),
                    count: result.batchResult.successCount,
                    syntaxNote: syntaxCheck.note,
                }),
                requiresInteraction: false,
                data: {
                    type: 'file_write_merge',
                    filePath: path,
                    originalContent,
                    newContent: result.newContent,
                    xml,
                    modificationCount: result.batchResult.successCount,
                    changeRatio: decision.changeRatio,
                    ...(syntaxCheck.validation && { validation: syntaxCheck.validation }),
                },
            };
        }

        // 普通模式:返回 Diff 预览
        const diff = measureRendererWork(
            'file_write.executeMerge.generateDiff',
            {
                originalChars: originalContent.length,
                newChars: result.newContent.length,
                originalLines: countTextLines(originalContent),
                newLines: countTextLines(result.newContent),
                modifications: result.batchResult.results.length,
            },
            () => fastApplyService.generateDiff(originalContent, result.newContent)
        );

        return {
            success: true,
            content: translate('tools.fileWrite.mergePreview', {
                fileName: this.getFileName(path),
                reason: decision.reason,
                count: result.batchResult.successCount,
            }),
            requiresInteraction: true,
            data: {
                type: 'file_write_merge',
                filePath: path,
                originalContent,
                newContent: result.newContent,
                diff,
                xmlInstructions: decision.xmlInstructions,
                batchResult: result.batchResult,
            },
        };
    }

    /**
     * 检查 Agent 是否开启了交付物自动索引到知识库
     * 默认开启（兼容旧 Agent，autoIndexDeliverables 为 null 时视为 true）
     */
    private async shouldAutoIndex(agentId: string): Promise<boolean> {
        try {
            const { useAgentStore } = await import('../../../../stores/agentStore');
            const agent = useAgentStore.getState().agents.find(a => a.id === agentId);
            return agent?.autoIndexDeliverables !== false;
        } catch {
            // 检查失败时默认开启，保持向后兼容
            return true;
        }
    }

    private async addToKnowledgePaths(agentId: string, filePath: string): Promise<void> {
        try {
            if (!shouldAutoIndexKnowledgeFile(filePath)) {
                logger.trace(`[FileWriteTool] 文件类型不适合自动同步知识库，跳过: ${filePath}`);
                return;
            }

            const { useAgentStore } = await import('../../../../stores/agentStore');
            const store = useAgentStore.getState();
            const agent = store.agents.find((a) => a.id === agentId);

            if (!agent) {
                logger.warn(`[FileWriteTool] Agent ${agentId} not found, skip addToKnowledgePaths`);
                return;
            }

            let currentPaths: string[] = [];
            if (agent.knowledgePaths) {
                try {
                    currentPaths = JSON.parse(agent.knowledgePaths) as unknown as string[];
                } catch {
                    currentPaths = [];
                }
            }

            if (currentPaths.includes(filePath)) {
                logger.trace(`[FileWriteTool] 路径已存在: ${filePath}`);
                return;
            }

            const newPaths = [...currentPaths, filePath];
            const newKnowledgePaths = JSON.stringify(newPaths);

            // 更新前端 Store
            store.updateAgent(agentId, { knowledgePaths: newKnowledgePaths });

            // 持久化到数据库（确保重启后 knowledgePaths 不丢失）
            try {
                await invoke('agent_update', {
                    id: agentId,
                    request: { knowledge_paths: newKnowledgePaths },
                });
            } catch (persistError) {
                logger.warn('[FileWriteTool] 持久化 knowledgePaths 失败:', persistError);
            }

            logger.trace(`[FileWriteTool] 已添加到知识库路径: ${filePath}`);
        } catch (error) {
            logger.error('[FileWriteTool] addToKnowledgePaths 失败:', error);
        }
    }

    /**
     * 索引文件到知识库（触发 RAG 向量化）
     *
     * 注意：此方法在 patch/overwrite 模式下以 fire-and-forget 方式调用，
     * 执行期间（embedding 耗时可能数十秒）用户可能已从知识库中手动移除该文件。
     * 因此在实际写入索引前需重新检查 knowledgePaths 的当前状态，
     * 避免被用户删除的文件被后台异步操作"复活"。
     */
    private async indexToKnowledgeBase(
        agentId: string,
        filePath: string,
        content: string
    ): Promise<void> {
        try {
            if (!shouldAutoIndexKnowledgeFile(filePath)) {
                logger.trace(`[FileWriteTool] 文件类型不适合自动索引，跳过: ${filePath}`);
                return;
            }

            const { getRagService } = await import('@services/rag');
            const ragService = getRagService();

            const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
            // 使用 filePath 作为 documentId，确保同一文件的旧向量被覆盖而非累积
            const documentId = filePath;

            const documentType = getKnowledgeDocumentType(fileName);

            // 先清除旧向量（幂等，文档不存在时无操作）
            await ragService.deleteDocumentIndex(agentId, documentId);

            // 竞态保护：索引前再次确认该路径仍在 knowledgePaths 中
            // 场景：fire-and-forget 期间用户可能已手动从知识库中移除该文件，
            //       如果不检查，索引操作会将已删除的向量数据"复活"
            const { useAgentStore } = await import('../../../../stores/agentStore');
            const currentAgent = useAgentStore.getState().agents.find(a => a.id === agentId);
            if (currentAgent) {
                let currentPaths: string[] = [];
                try {
                    currentPaths = currentAgent.knowledgePaths
                        ? JSON.parse(currentAgent.knowledgePaths) as unknown as string[]
                        : [];
                } catch { /* knowledgePaths 解析失败时视为空 */ }

                if (!currentPaths.includes(filePath)) {
                    logger.trace(
                        '[FileWriteTool] 索引前发现路径已从知识库移除，跳过索引:',
                        filePath
                    );
                    return;
                }
            }

            const chunkCount = await ragService.indexDocument(
                agentId,
                documentId,
                content,
                {
                    fileName,
                    filePath,
                    documentType,
                }
            );

            logger.trace(`[FileWriteTool] 已索引到知识库: ${filePath} (${chunkCount} 个块)`);
        } catch (error) {
            logger.warn('[FileWriteTool] 索引到知识库失败:', error);
        }
    }

    /**
     * 基于分隔符的 patches 定向提取器（最后防线）
     *
     * 当 JsonParser 的所有策略都无法解析 patches 字符串时（通常因为
     * replace 值中含未转义双引号），使用已知结构的多字符分隔模式提取。
     *
     * 策略：
     * - 用 `"search"\s*:\s*"` 定位每个 search 值的起始
     * - 用 `"\s*,\s*"replace"\s*:\s*"` 定位 search→replace 的分界
     * - 用 `}\s*,\s*{` 或 `}\s*]` 定位 replace 值的结束
     * - 不依赖引号匹配/状态机，容忍值内部的未转义字符
     */
    private extractPatchesByDelimiters(rawStr: string): PatchItem[] | undefined {
        const patches: PatchItem[] = [];

        // 找到所有 "search" 键的起始位置
        const searchKeyPattern = /"search"\s*:\s*"/g;
        let searchKeyMatch: RegExpExecArray | null;

        while ((searchKeyMatch = searchKeyPattern.exec(rawStr)) !== null) {
            const searchValueStart = searchKeyMatch.index + searchKeyMatch[0].length;

            // 从 searchValueStart 开始，找 search→replace 的分界标记
            // 分界模式：" , "replace" : "（含灵活空白）
            const afterSearchStart = rawStr.substring(searchValueStart);
            const separatorPattern = /"\s*,\s*"replace"\s*:\s*"/;
            const sepMatch = separatorPattern.exec(afterSearchStart);
            if (!sepMatch) continue;

            // 提取 search 值（从 searchValueStart 到分界标记的引号）
            const searchValue = afterSearchStart.substring(0, sepMatch.index);

            // replace 值的起始位置
            const replaceValueStart = searchValueStart + sepMatch.index + sepMatch[0].length;
            const afterReplaceStart = rawStr.substring(replaceValueStart);

            // 找 replace 值的结束：下一个对象边界 "}\s*,\s*{" 或数组结束 "}\s*]"
            // 取两者中较早出现的
            const nextObjPattern = /"\s*\}\s*,\s*\{/;
            const arrayEndPattern = /"\s*\}\s*\]/;

            const nextObjMatch = nextObjPattern.exec(afterReplaceStart);
            const arrayEndMatch = arrayEndPattern.exec(afterReplaceStart);

            let replaceEndOffset: number;
            if (nextObjMatch && (!arrayEndMatch || nextObjMatch.index < arrayEndMatch.index)) {
                replaceEndOffset = nextObjMatch.index;
            } else if (arrayEndMatch) {
                replaceEndOffset = arrayEndMatch.index;
            } else {
                // 兜底：找不到结束标记，跳过
                continue;
            }

            const replaceValue = afterReplaceStart.substring(0, replaceEndOffset);

            // 反转义 JSON 转义序列（\n → 换行，\t → 制表，\\" → "）
            patches.push({
                search: this.unescapeJsonValue(searchValue),
                replace: this.unescapeJsonValue(replaceValue),
            });
        }

        return patches.length > 0 ? patches : undefined;
    }

    /**
     * 反转义 JSON 字符串值中的转义序列
     */
    private unescapeJsonValue(escaped: string): string {
        return escaped
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    /**
     * 解析路径为绝对路径
     * 
     * 规范化策略:
     * - Windows 绝对路径(C:\...) → 直接返回
     * - Unix 绝对路径(/home/...) → 提取文件名,作为相对路径
     * - 相对路径(./file.md, file.md) → 移除 ./ 前缀,拼接 workdir
     */
    private resolvePath(inputPath: string, workdir?: string): string {
        logger.trace(`[FileWriteTool] 路径解析: 输入="${inputPath}", workdir="${workdir ?? ''}"`);

        // Windows 绝对路径检测
        const isWindowsAbsolute = /^[a-zA-Z]:[/\\]/.test(inputPath);

        if (isWindowsAbsolute) {
            logger.trace(`[FileWriteTool] 检测到 Windows 绝对路径,直接返回`);
            return inputPath;
        }

        if (!workdir) {
            logger.warn('[FileWriteTool] 无 workdir，无法解析相对路径:', inputPath);
            return inputPath;
        }

        // Unix 绝对路径处理(在 Windows 上,将其视为相对路径)
        // 例如: /home/user/file.md → file.md
        let relativePath = inputPath;
        if (relativePath.startsWith('/')) {
            // 提取最后一个路径部分作为文件名
            const parts = relativePath.split('/').filter(p => p.length > 0);
            relativePath = parts[parts.length - 1] ?? relativePath;
            logger.warn(
                `[FileWriteTool] 检测到 Unix 风格绝对路径 "${inputPath}",` +
                `已提取文件名 "${relativePath}" 作为相对路径。` +
                `建议 Sub-Agent 直接使用简单文件名以避免路径混淆。`
            );
        }

        // 移除 ./ 前缀
        if (relativePath.startsWith('./')) {
            relativePath = relativePath.slice(2);
            logger.trace(`[FileWriteTool] 移除 ./ 前缀,规范化为: "${relativePath}"`);
        }

        // 拼接路径
        const separator = workdir.includes('\\') ? '\\' : '/';
        const normalizedWorkdir = workdir.endsWith(separator)
            ? workdir.slice(0, -1)
            : workdir;
        const resolvedPath = `${normalizedWorkdir}${separator}${relativePath}`;

        logger.trace(`[FileWriteTool] 最终解析路径: "${resolvedPath}"`);
        return resolvedPath;
    }

    /**
     * 获取修改后的内容片段（±contextLines 行上下文）
     *
     * 在 newContent 行数组中定位 replace 内容的首行，
     * 提取周围上下文帮助 LLM 了解修改后的实际内容，避免用旧 search 重试
     */
    private getModifiedSnippet(
        newContentLines: string[],
        replaceText: string,
        contextLines: number
    ): string | null {
        // 取 replace 内容的首行用于在 newContent 中定位
        const replaceFirstLine = replaceText.split('\n')[0]?.trim();
        if (!replaceFirstLine || replaceFirstLine.length < 5) return null;

        // 在 newContent 的行中查找包含首行内容的行
        const matchIndex = newContentLines.findIndex(
            line => line.trim().includes(replaceFirstLine)
        );
        if (matchIndex === -1) return null;

        // 计算 replace 内容的行数
        const replaceLineCount = replaceText.split('\n').length;

        // 提取上下文范围（上 contextLines 行 ~ 修改内容末尾 + 下 contextLines 行）
        const startIndex = Math.max(0, matchIndex - contextLines);
        const endIndex = Math.min(
            newContentLines.length,
            matchIndex + replaceLineCount + contextLines
        );

        // 限制总预览行数，避免返回信息过长
        const MAX_SNIPPET_LINES = 10;
        const snippetLines = newContentLines.slice(
            startIndex,
            Math.min(endIndex, startIndex + MAX_SNIPPET_LINES)
        );

        // 格式化为带行号的片段
        return snippetLines
            .map((line, i) => `     | ${startIndex + i + 1}: ${line}`)
            .join('\n');
    }

    /**
     * 从路径中提取文件名
     */
    private getFileName(filePath: string): string {
        const parts = filePath.split(/[/\\]/);
        return parts[parts.length - 1] ?? filePath;
    }

    /**
     * 根据字符偏移量计算行号（1-based）
     * 
     * 用于在 patch 结果中输出匹配位置的行号，
     * 帮助模型精确定位修改区域以便后续 read 验证
     */
    private getLineNumber(content: string, offset: number): number {
        let lineNumber = 1;
        for (let i = 0; i < offset && i < content.length; i++) {
            if (content[i] === '\n') {
                lineNumber++;
            }
        }
        return lineNumber;
    }

    /**
     * 写入成功后语法检查入口
     *
     * 仅在 Sub-Agent 场景下触发（普通 Chat 无需自动检查）。
     * 检查超时或失败时静默返回空字符串，不阻塞 file_write 的成功状态。
     *
     * @param filePath 已写入的文件绝对路径
     * @param context  工具执行上下文
     * @returns 若有语法错误，返回用于追加到 content 的提示和结构化校验摘要；否则返回空结果
     */
    private async appendSyntaxCheck(
        filePath: string,
        context: ToolExecutionContext
    ): Promise<SyntaxCheckAppendResult> {
        // 仅 Sub-Agent 场景触发，避免普通 Chat 产生冗余输出
        if (!context.isSubAgentContext) return { note: '' };

        try {
            const result = await validateSyntax(filePath, {
                venvPythonPath: context.venvPythonPath,
                workdir: context.workdir,
                signal: context.signal,
            });

            // 无错误或未执行检查时不附加任何内容
            const relatedErrors = result.relatedErrors ?? [];
            const hasDiagnostics = result.errors.length > 0 || relatedErrors.length > 0;
            if (!result.checked || !hasDiagnostics) {
                return {
                    note: '',
                    validation: this.buildSyntaxValidationData(result),
                };
            }

            const currentLines = this.formatSyntaxErrorLines(result.errors, false);
            const relatedLines = this.formatSyntaxErrorLines(relatedErrors, true);
            const relatedNote = relatedErrors.length > 0
                ? translate('tools.fileWrite.syntaxRelatedCheck', {
                    count: relatedErrors.length,
                    lines: relatedLines,
                })
                : '';

            const note = result.errors.length > 0
                ? translate('tools.fileWrite.syntaxCheck', {
                    tool: result.tool,
                    count: result.errors.length,
                    lines: currentLines,
                    related: relatedNote,
                    hint: translate('tools.fileWrite.syntaxFixHint'),
                })
                : translate('tools.fileWrite.syntaxProjectCheck', {
                    tool: result.tool,
                    count: relatedErrors.length,
                    lines: relatedLines,
                    hint: translate('tools.fileWrite.syntaxProjectFixHint'),
                });

            return {
                note,
                validation: this.buildSyntaxValidationData(result),
            };
        } catch {
            // 检查本身异常时静默忽略，不影响写入成功状态
            return { note: '' };
        }
    }

    private formatSyntaxErrorLines(
        errors: PostWriteSyntaxError[],
        includeFile: boolean
    ): string {
        return errors.map(e => {
            const loc = this.formatSyntaxLocation(e, includeFile);
            return `  · [${loc}] ${e.message}`;
        }).join('\n');
    }

    private formatSyntaxLocation(
        error: PostWriteSyntaxError,
        includeFile: boolean
    ): string {
        const compactPath = includeFile && error.filePath
            ? this.compactDiagnosticPath(error.filePath)
            : '';

        if (compactPath) {
            return error.column
                ? translate('tools.fileWrite.syntaxFileLocationColumn', {
                    file: compactPath,
                    line: error.line,
                    column: error.column,
                })
                : translate('tools.fileWrite.syntaxFileLocationLine', {
                    file: compactPath,
                    line: error.line,
                });
        }

        return error.column
            ? translate('tools.fileWrite.syntaxLocationColumn', {
                line: error.line,
                column: error.column,
            })
            : translate('tools.fileWrite.syntaxLocationLine', { line: error.line });
    }

    private compactDiagnosticPath(filePath: string): string {
        return filePath
            .replace(/\\/g, '/')
            .split('/')
            .filter(part => part.length > 0)
            .slice(-4)
            .join('/');
    }

    private buildSyntaxValidationData(
        result: Awaited<ReturnType<typeof validateSyntax>>
    ): Record<string, unknown> {
        const relatedErrors = result.relatedErrors ?? [];
        return {
            checked: result.checked,
            failed: result.errors.length > 0 || relatedErrors.length > 0,
            tool: result.tool,
            errorCount: result.errors.length,
            relatedErrorCount: relatedErrors.length,
            projectErrorCount: result.projectErrorCount ?? result.errors.length,
            errors: result.errors,
            relatedErrors,
        };
    }
}

/**
 * 导出单例实例
 */
export const fileWriteTool = new FileWriteToolImpl();
