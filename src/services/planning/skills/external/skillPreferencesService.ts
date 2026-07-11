/**
 * skillPreferencesService - 技能开关偏好持久化服务
 *
 * 将用户的技能启用/禁用偏好存储到 AppData 目录下的 JSON 文件，
 * 而非 localStorage，确保 dev 端和生产端共享同一份配置。
 *
 * 文件路径：<AppData>/skill-preferences.json
 * 内容格式：{ "skillName": true/false, ... }
 *
 * 设计原则：
 * - 读取失败（文件不存在/损坏）时静默返回空对象，新技能默认启用
 * - 写入失败时记录错误日志但不抛出，不阻塞 UI 操作
 * - 使用 file_read_content / file_write_to_path Tauri 命令避免引入新依赖
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('skillPreferencesService');

/** 技能偏好文件名（相对于 AppData 目录） */
const PREFERENCES_FILENAME = 'skill-preferences.json';

/** 技能开关偏好记录：key 为技能名称，value 为是否启用 */
export type SkillEnabledOverrides = Record<string, boolean>;

/**
 * 获取技能偏好文件的绝对路径
 *
 * 使用 Tauri 的 appDataDir() API 获取 AppData 目录，
 * 确保 dev 和 prod 均指向同一路径（com.agentvis.app）
 */
async function getPreferencesFilePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const dataDir = await appDataDir();
  return join(dataDir, PREFERENCES_FILENAME);
}

/**
 * 从 AppData 文件加载技能开关偏好
 *
 * 文件不存在（首次启动）或内容损坏时，返回空对象（所有技能默认启用）。
 */
export async function loadSkillPreferences(): Promise<SkillEnabledOverrides> {
  try {
    const filePath = await getPreferencesFilePath();
    const content = await invoke<string>('file_read_content', { filePath });
    if (!content.trim()) return {};

    const parsed: unknown = JSON.parse(content);
    // 严格校验：必须是扁平的 string→boolean 对象
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('[skillPreferencesService] 偏好文件格式非法，重置为空');
      return {};
    }
    // 过滤掉非 boolean 值，防止文件损坏时导致类型污染
    const overrides: SkillEnabledOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') {
        overrides[key] = value;
      }
    }
    logger.trace('[skillPreferencesService] 已加载技能偏好', {
      count: Object.keys(overrides).length,
    });
    return overrides;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // 文件不存在属于首次启动的正常情况，静默返回空对象而不记录日志
    // Rust AppError::NotFound 序列化为中文："资源不存在: 文件不存在: ..."
    // 兼容英文系统可能出现的 os error 2 / No such file 等格式
    const isFileNotFound =
      errorMsg.includes('文件不存在') ||
      errorMsg.includes('资源不存在') ||
      errorMsg.includes('No such file') ||
      errorMsg.includes('os error 2') ||
      errorMsg.includes('not found') ||
      errorMsg.includes('NotFound');
    if (!isFileNotFound) {
      logger.warn('[skillPreferencesService] 加载技能偏好失败:', error);
    }
    return {};
  }
}

/**
 * 将技能开关偏好保存到 AppData 文件
 *
 * 序列化为格式化的 JSON（便于人工查看/排查问题）。
 * 写入失败时仅记录错误，不抛出，确保 UI 操作不被中断。
 */
export async function saveSkillPreferences(overrides: SkillEnabledOverrides): Promise<void> {
  try {
    const filePath = await getPreferencesFilePath();
    const content = JSON.stringify(overrides, null, 2);
    await invoke('file_write_to_path', { path: filePath, content, createBackup: false });
    logger.trace('[skillPreferencesService] 已保存技能偏好', {
      count: Object.keys(overrides).length,
    });
  } catch (error) {
    // 写入失败不阻塞 UI、不抛出：偏好丢失代价可接受，优先保证操作可继续
    logger.error('[skillPreferencesService] 保存技能偏好失败:', error);
  }
}
