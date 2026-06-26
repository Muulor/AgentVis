/**
 * 数据管理服务
 *
 * 封装 Tauri 后端数据管理命令的前端调用
 */

import { invoke } from '@tauri-apps/api/core';

/** 数据统计信息 */
export interface DataStats {
    hubCount: number;
    agentCount: number;
    messageCount: number;
    memoryCount: number;
    vectorChunkCount: number;
    snapshotCount: number;
    dbSizeBytes: number;
}

/** 导入结果 */
export interface ImportResult {
    success: boolean;
    importedHubs: number;
    importedAgents: number;
    importedMessages: number;
    importedMemories: number;
    importedFiles: number;
    importedVectors: number;
    importedSnapshots: number;
    importedDiffRecords: number;
    warnings: string[];
}

/** 导入模式 */

export type ImportMode = 'merge' | 'replace';

/**
 * 获取数据统计信息
 *
 * @returns 各类数据的数量统计
 */
export async function getDataStats(): Promise<DataStats> {
    return invoke<DataStats>('data_get_stats');
}

/**
 * 导出数据到 ZIP 文件
 *
 * @param exportPath 导出文件路径
 * @returns 导出文件的完整路径
 */
export async function exportData(exportPath: string): Promise<string> {
    return invoke<string>('data_export', { exportPath });
}

/**
 * 从 ZIP 文件导入数据
 *
 * @param importPath 导入文件路径
 * @param mode 导入模式：'merge' 合并现有数据，'replace' 覆盖现有数据
 * @returns 导入结果
 */
export async function importData(importPath: string, mode: ImportMode): Promise<ImportResult> {
    return invoke<ImportResult>('data_import', { importPath, mode });
}

/**
 * 清除向量缓存
 *
 * 删除所有 RAG 向量索引数据
 *
 * @returns 清除的向量数量
 */
export async function clearVectors(): Promise<number> {
    return invoke<number>('data_clear_vectors');
}

/**
 * 重置所有数据
 *
 * 危险操作：删除所有用户数据
 *
 * @param confirmPhrase 确认短语，必须为 "删除所有数据"
 */
export async function resetAllData(confirmPhrase: string): Promise<void> {
    await invoke('data_reset_all', { confirmPhrase });
}

/**
 * 格式化文件大小
 *
 * @param bytes 字节数
 * @returns 格式化后的字符串（如 "1.5 MB"）
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = bytes / Math.pow(k, i);

    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i] ?? 'B'}`;
}

// ==================== 备份文件管理 ====================

/** 备份目录统计信息（与 Rust BackupStats 对称） */
export interface BackupStats {
    /** backups/ 目录绝对路径 */
    dirPath: string;
    /** 备份文件总数 */
    fileCount: number;
    /** 备份总大小（字节） */
    totalBytes: number;
}

/** 批量清理结果（与 Rust CleanResult 对称） */
export interface CleanResult {
    /** 实际删除的文件数 */
    deletedCount: number;
    /** 释放的字节数 */
    freedBytes: number;
}

/**
 * 批量清理策略（与 Rust CleanPolicy 枚举对称）
 *
 * - olderThanDays: 删除 N 天前的备份
 * - keepLatestPerFile: 每个原文件保留最近 N 个版本
 * - deleteAll: 清空全部备份
 */
export type CleanPolicy =
    | { type: 'olderThanDays'; days: number }
    | { type: 'keepLatestPerFile'; count: number }
    | { type: 'deleteAll' };

/**
 * 获取备份目录统计信息
 *
 * @returns 备份文件数量、总大小和目录路径
 */
export async function getBackupStats(): Promise<BackupStats> {
    return invoke<BackupStats>('backup_get_stats');
}

/**
 * 批量清理备份文件
 *
 * @param policy 清理策略
 * @returns 删除文件数和释放字节数
 */
export async function cleanBackups(policy: CleanPolicy): Promise<CleanResult> {
    return invoke<CleanResult>('backup_clean', { policy });
}
