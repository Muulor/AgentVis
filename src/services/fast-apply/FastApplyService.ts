/**
 * FastApplyService - Fast-Apply 引擎前端服务封装
 * 
 * 封装 FastApplyEngine，提供简化的修改预览/应用 API 给 UI 层使用。
 */

import type {
    Modification,
    DiffResult,
    DiffHunk,
    BatchApplyResult,
    ModificationApplyResult,
} from './types';
import { FastApplyEngine, fastApplyEngine } from './FastApplyEngine';
import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('FastApplyService');

// ==================== 快照类型 ====================

/** 快照信息 */
export interface SnapshotInfo {
    id: string;
    documentId: string;
    description: string;
    createdAt: number;
}

// ==================== 服务类 ====================

/**
 * Fast-Apply 服务
 * 
 * 为 UI 层提供简化的 Fast-Apply Engine 接口
 */
export class FastApplyService {
    private engine: FastApplyEngine;

    constructor(engine: FastApplyEngine = fastApplyEngine) {
        this.engine = engine;
    }

    /**
     * 预览修改
     * 
     * 解析 XML 并生成修改预览，不实际应用修改
     * 
     * @param documentId - 文档 ID
     * @param content - 当前文档内容
     * @param xml - XML 修改协议
     * @returns 批量预览结果
     */
    async preview(
        documentId: string,
        content: string,
        xml: string
    ): Promise<BatchApplyResult> {
        return this.engine.preview(documentId, content, xml);
    }

    /**
     * 应用单个修改
     * 
     * @param documentId - 文档 ID
     * @param content - 当前文档内容
     * @param modification - 修改对象
     * @returns 新内容和应用结果
     */
    async applySingle(
        documentId: string,
        content: string,
        modification: Modification
    ): Promise<{ newContent: string; result: ModificationApplyResult }> {
        return this.engine.applyModification(documentId, content, modification);
    }

    /**
     * 批量应用修改
     * 
     * @param documentId - 文档 ID
     * @param content - 当前文档内容
     * @param xml - XML 修改协议
     * @returns 新内容和批量结果
     */
    async applyAll(
        documentId: string,
        content: string,
        xml: string
    ): Promise<{ newContent: string; batchResult: BatchApplyResult }> {
        return this.engine.applyFromXml(documentId, content, xml);
    }

    /**
     * 从文本中提取修改
     * 
     * 用于处理 LLM 输出中混合的文本和 XML
     * 
     * @param text - 可能包含 XML 的文本
     * @returns 提取到的 Modification 数组
     */
    extractModifications(text: string): Modification[] {
        return this.engine.extractModifications(text);
    }

    /**
     * 生成 Diff
     * 
     * @param original - 原始内容
     * @param modified - 修改后内容
     * @returns Diff 结果
     */
    generateDiff(original: string, modified: string): DiffResult {
        return this.engine.getDiffGenerator().generateDiff(original, modified);
    }

    /**
     * 从新旧内容生成 XML 编辑指令
     * 
     * 自动分析差异,生成 Fast-Apply XML 格式的修改指令
     * 
     * 策略:
     * - 连续的删除+插入 → REPLACE 操作
     * - 仅插入 → INSERT_AFTER 操作
     * - 仅删除 → DELETE 操作
     * 
     * @param originalContent - 原始文件内容
     * @param newContent - 修改后的内容
     * @returns XML 格式的修改指令
     */
    generateEditInstructions(
        originalContent: string,
        newContent: string
    ): string {
        const diff = this.generateDiff(originalContent, newContent);

        // 无变化时返回空指令
        if (!diff.hasChanges || diff.hunks.length === 0) {
            return '<modifications></modifications>';
        }

        const modifications: string[] = [];
        const originalLines = originalContent.split('\n');

        // 遍历每个 Diff Hunk
        for (const hunk of diff.hunks) {
            // 分析 hunk 中的行变化
            const removedLines: string[] = [];
            const addedLines: string[] = [];
            const contextBefore: string[] = [];

            for (const line of hunk.lines) {
                if (line.type === 'remove') {
                    removedLines.push(line.content);
                } else if (line.type === 'add') {
                    addedLines.push(line.content);
                } else if (removedLines.length === 0 && addedLines.length === 0) {
                    // 记录修改前的上下文(用于定位)
                    contextBefore.push(line.content);
                }
            }

            // 生成修改指令
            if (removedLines.length > 0 && addedLines.length > 0) {
                // REPLACE 模式: 有删除也有添加
                modifications.push(this.buildReplaceModification(
                    removedLines.join('\n'),
                    addedLines.join('\n')
                ));
            } else if (addedLines.length > 0) {
                // INSERT_AFTER 模式: 仅添加
                // 找到插入位置的前一行作为锚点
                const anchorLine = this.findAnchorLineForInsert(
                    hunk,
                    originalLines,
                    contextBefore
                );
                modifications.push(this.buildInsertAfterModification(
                    anchorLine,
                    addedLines.join('\n')
                ));
            } else if (removedLines.length > 0) {
                // DELETE 模式: 仅删除
                modifications.push(this.buildDeleteModification(
                    removedLines.join('\n')
                ));
            }
        }

        // 合并所有修改为 XML
        return `<modifications>\n${modifications.join('\n')}\n</modifications>`;
    }

    /**
     * 构建 REPLACE 修改指令
     */
    private buildReplaceModification(search: string, replace: string): string {
        return `  <modification>
    <operation>REPLACE</operation>
    <search>${this.escapeXml(search)}</search>
    <replace>${this.escapeXml(replace)}</replace>
  </modification>`;
    }

    /**
     * 构建 INSERT_AFTER 修改指令
     */
    private buildInsertAfterModification(anchorLine: string, content: string): string {
        return `  <modification>
    <operation>INSERT_AFTER</operation>
    <search>${this.escapeXml(anchorLine)}</search>
    <replace>${this.escapeXml(content)}</replace>
  </modification>`;
    }

    /**
     * 构建 DELETE 修改指令
     */
    private buildDeleteModification(content: string): string {
        return `  <modification>
    <operation>DELETE</operation>
    <search>${this.escapeXml(content)}</search>
  </modification>`;
    }

    /**
     * XML 特殊字符转义
     */
    private escapeXml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * 为插入操作找到锚点行
     * 
     * 策略:
     * 1. 优先使用 hunk 前的上下文行
     * 2. 否则使用 hunk 起始位置的前一行
     */
    private findAnchorLineForInsert(
        hunk: DiffHunk,
        originalLines: string[],
        contextBefore: string[]
    ): string {
        // 如果有前置上下文,使用最后一行
        if (contextBefore.length > 0) {
            const lastContext = contextBefore[contextBefore.length - 1];
            if (lastContext !== undefined) {
                return lastContext;
            }
        }

        // 否则使用 hunk 起始位置的前一行
        const anchorIndex = hunk.oldStart - 2; // -1 for 0-index, -1 for previous line
        if (anchorIndex >= 0 && anchorIndex < originalLines.length) {
            const anchorLine = originalLines[anchorIndex];
            if (anchorLine !== undefined) {
                return anchorLine;
            }
        }

        // 降级:使用文件第一行
        return originalLines[0] ?? '';
    }

    // ==================== 快照管理 ====================

    /**
     * 回滚到指定快照
     * 
     * @param snapshotId - 快照 ID
     * @returns 快照内容
     */
    async rollback(snapshotId: string): Promise<string> {
        return this.engine.rollback(snapshotId);
    }

    /**
     * 获取文档的快照列表
     * 
     * @param documentId - 文档 ID
     * @returns 快照列表
     */
    async listSnapshots(documentId: string): Promise<SnapshotInfo[]> {
        try {
            const snapshots = await invoke<Array<{
                id: string;
                document_id: string;
                description: string;
                created_at: number;
            }>>('snapshot_list', { documentId });

            return snapshots.map(s => ({
                id: s.id,
                documentId: s.document_id,
                description: s.description,
                createdAt: s.created_at,
            }));
        } catch (error) {
            logger.error('[FastApplyService] 获取快照列表失败:', error);
            return [];
        }
    }

    /**
     * 获取快照详情
     * 
     * @param snapshotId - 快照 ID
     * @returns 快照内容
     */
    async getSnapshot(snapshotId: string): Promise<string | null> {
        try {
            return await invoke<string>('snapshot_get_content', { snapshotId });
        } catch (error) {
            logger.error('[FastApplyService] 获取快照内容失败:', error);
            return null;
        }
    }

    /**
     * 比较两个快照
     * 
     * @param snapshotId1 - 第一个快照 ID
     * @param snapshotId2 - 第二个快照 ID
     * @returns Diff 结果
     */
    async compareSnapshots(
        snapshotId1: string,
        snapshotId2: string
    ): Promise<DiffResult | null> {
        try {
            const content1 = await this.getSnapshot(snapshotId1);
            const content2 = await this.getSnapshot(snapshotId2);

            if (content1 === null || content2 === null) {
                return null;
            }

            return this.generateDiff(content1, content2);
        } catch (error) {
            logger.error('[FastApplyService] 比较快照失败:', error);
            return null;
        }
    }
}

// ==================== 导出 ====================

/** 默认 Fast-Apply 服务实例 */
export const fastApplyService = new FastApplyService();

/**
 * 创建 FastApplyService 实例
 */
export function createFastApplyService(engine?: FastApplyEngine): FastApplyService {
    return new FastApplyService(engine);
}
