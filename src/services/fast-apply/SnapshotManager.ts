/**
 * 快照管理器
 *
 * 封装 Tauri 快照命令，提供版本控制功能
 */

import { invoke } from '@tauri-apps/api/core';
import type {
    DocumentSnapshot,
    SnapshotResponse,
    SnapshotManagerConfig,
    DiffResult,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { DiffGenerator } from './DiffGenerator';

// ==================== 辅助函数 ====================

/**
 * 将后端响应转换为前端类型
 */
function transformSnapshot(response: SnapshotResponse): DocumentSnapshot {
    // 将后端 JSON 字符串解析为 Record<string, string>
    let modificationStatuses: Record<string, string> | undefined;
    if (response.modificationStatusesJson) {
        try {
            modificationStatuses = JSON.parse(response.modificationStatusesJson) as Record<string, string>;
        } catch {
            // 解析失败时忽略，兜底为 undefined（使用旧推断逻辑）
        }
    }

    return {
        id: response.id,
        documentId: response.documentId,
        content: response.content,
        timestamp: new Date(response.createdAt),  // Rust 侧已存储毫秒时间戳（timestamp_millis），无需 * 1000
        triggerModificationId: response.triggerModificationId ?? undefined,
        description: response.description ?? '',
        modificationStatuses,
    };
}

// ==================== 快照管理器类 ====================

/**
 * 快照管理器
 *
 * 提供文档快照的创建、查询、回滚和清理功能
 */
export class SnapshotManager {
    private config: SnapshotManagerConfig;
    private diffGenerator: DiffGenerator;

    constructor(config: Partial<SnapshotManagerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG.snapshot, ...config };
        this.diffGenerator = new DiffGenerator();
    }

    /**
     * 创建快照
     *
     * @param documentId 文档 ID
     * @param content 快照内容
     * @param description 快照描述（可选）
     * @param triggerModificationId 触发修改 ID（可选）
     * @param modificationStatuses 快照时各修改块的审批状态（可选），用于回滚后精确恢复 diff 面板
     * @returns 创建的快照 ID
     */
    async createSnapshot(
        documentId: string,
        content: string,
        description?: string,
        triggerModificationId?: string,
        modificationStatuses?: Record<string, string>
    ): Promise<string> {
        // 将修改状态序列化为 JSON 传给后端
        const modificationStatusesJson = modificationStatuses
            ? JSON.stringify(modificationStatuses)
            : undefined;

        const response = await invoke<SnapshotResponse>('snapshot_create', {
            documentId,
            content,
            triggerModificationId: triggerModificationId ?? null,
            description: description ?? null,
            modificationStatusesJson: modificationStatusesJson ?? null,
        });

        // 检查是否需要自动清理旧快照
        const count = await this.getCount(documentId);
        if (count > this.config.defaultKeepCount) {
            await this.cleanup(documentId, this.config.defaultKeepCount);
        }

        return response.id;
    }

    /**
     * 获取单个快照
     *
     * @param snapshotId 快照 ID
     * @returns 快照对象，不存在时返回 null
     */
    async getSnapshot(snapshotId: string): Promise<DocumentSnapshot | null> {
        const response = await invoke<SnapshotResponse | null>('snapshot_get', {
            id: snapshotId,
        });

        return response ? transformSnapshot(response) : null;
    }

    /**
     * 获取文档的所有快照（按时间倒序）
     *
     * @param documentId 文档 ID
     * @returns 快照数组
     */
    async listSnapshots(documentId: string): Promise<DocumentSnapshot[]> {
        const responses = await invoke<SnapshotResponse[]>('snapshot_list', {
            documentId,
        });

        return responses.map(transformSnapshot);
    }

    /**
     * 获取文档的最新快照
     *
     * @param documentId 文档 ID
     * @returns 最新快照，不存在时返回 null
     */
    async getLatestSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
        const response = await invoke<SnapshotResponse | null>('snapshot_get_latest', {
            documentId,
        });

        return response ? transformSnapshot(response) : null;
    }

    /**
     * 回滚到指定快照
     *
     * @param snapshotId 快照 ID
     * @returns 快照内容（供调用者写入文件）
     */
    async rollbackTo(snapshotId: string): Promise<string> {
        const response = await invoke<SnapshotResponse>('snapshot_rollback', {
            snapshotId,
        });

        return response.content;
    }

    /**
     * 对比两个快照
     *
     * @param snapshotId1 第一个快照 ID
     * @param snapshotId2 第二个快照 ID
     * @returns Diff 结果
     */
    async diff(snapshotId1: string, snapshotId2: string): Promise<DiffResult> {
        const [snapshot1, snapshot2] = await Promise.all([
            this.getSnapshot(snapshotId1),
            this.getSnapshot(snapshotId2),
        ]);

        if (!snapshot1 || !snapshot2) {
            throw new Error('One or more snapshots do not exist');
        }

        return this.diffGenerator.generateDiff(snapshot1.content, snapshot2.content);
    }

    /**
     * 对比当前内容与快照
     *
     * @param snapshotId 快照 ID
     * @param currentContent 当前内容
     * @returns Diff 结果
     */
    async diffWithCurrent(snapshotId: string, currentContent: string): Promise<DiffResult> {
        const snapshot = await this.getSnapshot(snapshotId);

        if (!snapshot) {
            throw new Error(`Snapshot ${snapshotId} does not exist`);
        }

        return this.diffGenerator.generateDiff(snapshot.content, currentContent);
    }

    /**
     * 删除快照
     *
     * @param snapshotId 快照 ID
     */
    async deleteSnapshot(snapshotId: string): Promise<void> {
        await invoke('snapshot_delete', {
            id: snapshotId,
        });
    }

    /**
     * 清理旧快照，保留最近 N 个
     *
     * @param documentId 文档 ID
     * @param keepCount 保留数量
     * @returns 删除的快照数量
     */
    async cleanup(documentId: string, keepCount?: number): Promise<number> {
        const count = keepCount ?? this.config.defaultKeepCount;
        const result = await invoke<number>('snapshot_cleanup', {
            documentId,
            keepCount: count,
        });

        return result;
    }

    /**
     * 获取文档快照数量
     *
     * @param documentId 文档 ID
     * @returns 快照数量
     */
    async getCount(documentId: string): Promise<number> {
        return invoke<number>('snapshot_count', {
            documentId,
        });
    }

    /**
     * 如果启用了自动快照，在修改前创建快照
     *
     * @param documentId 文档 ID
     * @param content 当前内容
     * @param description 快照描述
     * @returns 快照 ID，如果未启用则返回 undefined
     */
    async autoSnapshot(
        documentId: string,
        content: string,
        description?: string
    ): Promise<string | undefined> {
        if (!this.config.autoSnapshotBeforeModify) {
            return undefined;
        }

        return this.createSnapshot(
            documentId,
            content,
            description ?? `Automatic snapshot - ${new Date().toLocaleString()}`
        );
    }
}

// ==================== 导出单例 ====================

/** 默认快照管理器实例 */
export const snapshotManager = new SnapshotManager();
