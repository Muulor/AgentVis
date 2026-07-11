/**
 * FileWriter - 文件写入工具类
 *
 * 提供统一的文件保存接口：
 * - 外部路径：带备份写入
 * - 内部路径：保存到 deliverables 目录
 *
 */

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getLogger } from '@services/logger';

const logger = getLogger('FileWriter');

// ==================== 类型定义 ====================

/**
 * 保存选项
 */
export interface SaveOptions {
  /** 要保存的内容 */
  content: string;
  /** 目标文件路径（可选，如果是外部路径会直接写入） */
  targetPath?: string;
  /** Agent ID（用于内部保存时确定目录） */
  agentId: string;
  /** 文件名（内部保存时使用，如果未指定则自动生成） */
  fileName?: string;
  /** 是否创建备份（外部路径默认 true） */
  createBackup?: boolean;
}

/**
 * 保存结果
 */
export interface SaveResult {
  /** 是否成功保存 */
  success: boolean;
  /** 保存的文件路径 */
  filePath: string;
  /** 备份文件路径（如果创建了备份） */
  backupPath?: string;
  /** 写入的字节数 */
  bytesWritten: number;
  /** 错误信息（如果失败） */
  error?: string;
}

// ==================== FileWriter 类 ====================

/**
 * 文件写入工具类
 *
 * 封装文件保存逻辑，支持外部路径和内部路径两种模式
 */
export class FileWriter {
  /**
   * 保存文件
   *
   * @param options 保存选项
   * @returns 保存结果
   */
  async save(options: SaveOptions): Promise<SaveResult> {
    const { content, targetPath, agentId, fileName, createBackup = true } = options;

    try {
      // 判断是否有指定的目标文件路径，且为外部路径
      if (targetPath && this.isExternalPath(targetPath)) {
        return await this.saveToExternalPath({
          content,
          targetPath,
          createBackup,
        });
      }

      // 内部路径：使用 file_write_deliverable
      return await this.saveToDeliverables({
        content,
        agentId,
        fileName: fileName ?? this.generateFileName(),
      });
    } catch (error) {
      logger.error('[FileWriter] 保存文件失败:', error);
      return {
        success: false,
        filePath: '',
        bytesWritten: 0,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 判断是否为外部路径
   *
   * 外部路径特征：
   * - 包含盘符（Windows: C:, D: 等）
   * - 以 / 开头（Unix 绝对路径）
   */
  isExternalPath(path: string): boolean {
    // Windows 盘符判断
    if (/^[a-zA-Z]:/.test(path)) {
      return true;
    }
    // Unix 绝对路径判断
    if (path.startsWith('/')) {
      return true;
    }
    return false;
  }

  // ==================== 私有方法 ====================

  /**
   * 保存到外部路径（带备份）
   */
  private async saveToExternalPath(options: {
    content: string;
    targetPath: string;
    createBackup: boolean;
  }): Promise<SaveResult> {
    const { content, targetPath, createBackup } = options;

    logger.trace('[FileWriter] 写入外部文件:', targetPath);

    const result = await invoke<{
      success: boolean;
      filePath: string;
      backupPath: string | null;
      bytesWritten: number;
    }>('file_write_to_path', {
      path: targetPath,
      content,
      createBackup,
    });

    if (result.backupPath) {
      logger.trace(`[FileWriter] 已创建备份: ${result.backupPath}`);
    }
    logger.trace(`[FileWriter] 外部文件已保存: ${result.filePath}`);

    return {
      success: result.success,
      filePath: result.filePath,
      backupPath: result.backupPath ?? undefined,
      bytesWritten: result.bytesWritten,
    };
  }

  /**
   * 保存到 deliverables 目录（内部路径）
   */
  private async saveToDeliverables(options: {
    content: string;
    agentId: string;
    fileName: string;
  }): Promise<SaveResult> {
    const { content, agentId, fileName } = options;

    const filePath = await invoke<string>('file_write_deliverable', {
      agentId,
      fileName,
      content,
    });

    logger.trace(`[FileWriter] 交付物已保存: ${filePath}`);

    // 发射事件通知 UI 刷新文件列表
    await emit('file:deliverable_created', { agentId, filePath, fileName });
    logger.trace('[FileWriter] 已发射 file:deliverable_created 事件');

    return {
      success: true,
      filePath,
      bytesWritten: new Blob([content]).size,
    };
  }

  /**
   * 生成默认文件名
   */
  private generateFileName(): string {
    const timestamp = new Date().toISOString().slice(0, 10);
    return `deliverable_${timestamp}.md`;
  }
}

// ==================== 单例导出 ====================

/**
 * FileWriter 单例实例
 */
export const fileWriter = new FileWriter();
