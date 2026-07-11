/**
 * SkillPackageWatcher - 技能包目录文件监听
 *
 * 使用 Tauri plugin-fs 的 watchImmediate API 监听 packages/ 目录变化，
 * 当用户手动添加/删除技能包文件夹时自动触发 rescan。
 *
 * 设计原则：
 * - 仅监听一级子目录变化（不递归），减少事件噪声
 * - 防抖 1000ms，避免连续操作触发多次 rescan
 * - 提供 start/stop 生命周期管理
 * - 事件类型过滤：仅关注 create/remove
 */

// ==================== 类型引入 ====================

import type { WatchEvent } from '@tauri-apps/plugin-fs';
import { getLogger } from '@services/logger';

const logger = getLogger('SkillPackageWatcher');

// ==================== 常量 ====================

/** 防抖延迟毫秒数 */
const DEBOUNCE_DELAY_MS = 1000;

// ==================== 类型定义 ====================

/** Watcher 状态 */
export type WatcherStatus = 'stopped' | 'running' | 'error';

/** rescan 回调函数类型 */
export type RescanCallback = () => Promise<unknown>;

// ==================== SkillPackageWatcher ====================

export class SkillPackageWatcher {
  private readonly packagesDir: string;
  private readonly onRescan: RescanCallback;
  private status: WatcherStatus = 'stopped';
  private unwatchFn: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param packagesDir packages/ 目录绝对路径
   * @param onRescan 触发 rescan 的回调函数
   */
  constructor(packagesDir: string, onRescan: RescanCallback) {
    this.packagesDir = packagesDir;
    this.onRescan = onRescan;
  }

  /** 获取当前状态 */
  get currentStatus(): WatcherStatus {
    return this.status;
  }

  /**
   * 启动文件监听
   *
   * 使用 Tauri plugin-fs 的 watchImmediate：
   * - 仅监听 packages/ 一级目录变化
   * - create/remove 事件触发防抖 rescan
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      logger.trace('[SkillPackageWatcher] 已在运行中，跳过');
      return;
    }

    try {
      const { watchImmediate } = await import('@tauri-apps/plugin-fs');

      // watchImmediate 在设置监听后立即开始监听（不等待 ready 事件）
      const unwatch = await watchImmediate(
        this.packagesDir,
        (event) => {
          this.handleWatchEvent(event);
        },
        {
          recursive: false, // 仅监听一级子目录
        }
      );

      this.unwatchFn = unwatch;
      this.status = 'running';
      logger.trace('[SkillPackageWatcher] 文件监听已启动:', this.packagesDir);
    } catch (error) {
      this.status = 'error';
      // watch 权限不可用时降级为日志提示（不影响核心功能，重启应用时仍会自动扫描）
      logger.trace(
        '[SkillPackageWatcher] 文件监听不可用（技能包变更需重启生效）:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * 停止文件监听
   */
  stop(): void {
    // 清除防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 取消文件监听
    if (this.unwatchFn) {
      this.unwatchFn();
      this.unwatchFn = null;
    }

    this.status = 'stopped';
    logger.trace('[SkillPackageWatcher] 文件监听已停止');
  }

  /**
   * 处理文件系统事件
   *
   * 过滤事件类型，仅对 create/remove 触发防抖 rescan。
   * Tauri fs watch 事件格式可能因平台而异：
   * - Windows: type 可能是 { create: {...} } 或 { remove: {...} }
   * - 具体格式参考 Tauri plugin-fs 文档
   */
  private handleWatchEvent(event: WatchEvent): void {
    // Tauri watchImmediate 事件结构：{ type: string | object, paths: string[] }
    const eventType =
      typeof event.type === 'string' ? event.type : (Object.keys(event.type)[0] ?? '');

    // 仅关注创建和删除事件
    // 修改类事件（rename/modify）会产生过多噪声
    const relevantTypes = ['create', 'remove'];
    if (!relevantTypes.includes(eventType)) {
      return;
    }

    logger.trace(`[SkillPackageWatcher] 检测到 ${eventType} 事件:`, event.paths);

    // 防抖：延迟触发 rescan
    this.debouncedRescan();
  }

  /**
   * 防抖 rescan
   *
   * 1000ms 内多次事件只触发一次 rescan，
   * 用于处理用户一次性复制多个文件产生的连续事件
   */
  private debouncedRescan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void (async () => {
        this.debounceTimer = null;
        try {
          logger.trace('[SkillPackageWatcher] 触发 rescan...');
          await this.onRescan();
          logger.trace('[SkillPackageWatcher] rescan 完成');
        } catch (error) {
          logger.error(
            '[SkillPackageWatcher] rescan 失败:',
            error instanceof Error ? error.message : String(error)
          );
        }
      })();
    }, DEBOUNCE_DELAY_MS);
  }
}
