/**
 * ShortTermBuffer - 短期缓冲区
 *
 * 管理最近的对话消息，使用滑动窗口 + FIFO 淘汰策略。
 *
 * 数据模型：扁平 Message[] 存储，按时间顺序排列，支持任意角色序列。
 * 水位线：基于 user 消息数计算，避免孤立问题。
 */

import type { Message, ShortTermBufferConfig } from './types';
import { DEFAULT_SHORT_TERM_CONFIG } from './types';

/**
 * 短期缓冲区类
 *
 * 维护最近 N 条 user 消息及其关联 assistant 回复的滑动窗口
 */
export class ShortTermBuffer {
  private buffer: Message[] = [];
  private config: ShortTermBufferConfig;
  /** 配置变更时产生的待转换批次 */
  private _pendingConversionBatch: Message[] = [];

  constructor(config: Partial<ShortTermBufferConfig> = {}) {
    this.config = { ...DEFAULT_SHORT_TERM_CONFIG, ...config };
  }

  // ==================== 写入操作 ====================

  /**
   * 添加消息到缓冲区
   *
   * 支持一次添加 1~N 条消息，兼容 user→assistant 配对场景和连续多条 user 场景。
   *
   * @param messages - 要添加的消息（按时间顺序）
   * @returns 是否触发了淘汰（user 消息数超出窗口）
   */
  addMessages(...messages: Message[]): boolean {
    this.buffer.push(...messages);

    // 检查 user 消息数是否超出窗口
    if (this.getUserMessageCount() > this.config.windowSize) {
      return true;
    }

    return false;
  }

  /**
   * 按消息 ID 从缓冲区中删除
   *
   * @param messageId - 要删除的消息 ID
   * @returns 是否成功删除
   */
  removeByMessageId(messageId: string): boolean {
    const originalLength = this.buffer.length;
    this.buffer = this.buffer.filter((msg) => msg.id !== messageId);
    return this.buffer.length < originalLength;
  }

  // ==================== 读取操作 ====================

  /**
   * 获取所有消息（按时间顺序）
   */
  getAllMessages(): Message[] {
    return [...this.buffer];
  }

  /**
   * 获取当前 user 消息数
   */
  getUserMessageCount(): number {
    return this.buffer.filter((m) => m.role === 'user').length;
  }

  /**
   * 获取当前缓冲区使用率（基于 user 消息数）
   */
  getUsageRatio(): number {
    return this.getUserMessageCount() / this.config.windowSize;
  }

  /**
   * 是否达到水位线
   */
  isAboveWatermark(): boolean {
    return this.getUsageRatio() >= this.config.watermarkThreshold;
  }

  // ==================== 弹出策略 ====================

  /**
   * 获取并移除需要转换的批次
   *
   * 弹出策略：从头部开始，弹出 N 个 user 消息以及它们之间的所有 assistant 消息。
   * 保证弹出边界在 user 消息上，不从语义完整段中间切开。
   *
   * @returns 被移除的消息列表
   */
  popBatchForConversion(): Message[] {
    // 计算需弹出的 user 消息数
    const userBatchSize = Math.ceil(this.config.windowSize * this.config.batchSizeRatio);

    // 从头部扫描，找到第 N 个 user 消息的位置，以此作为切割边界
    let userCount = 0;
    let splitIndex = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i]?.role === 'user') {
        userCount++;
      }
      if (userCount >= userBatchSize) {
        // 找到第 N 个 user 消息后，继续收集其后紧跟的 assistant 消息
        // 直到遇到下一个 user 消息或到达末尾
        splitIndex = i + 1;
        while (splitIndex < this.buffer.length && this.buffer[splitIndex]?.role !== 'user') {
          splitIndex++;
        }
        break;
      }
    }

    // user 消息数不足一个批次时，弹出全部
    if (userCount < userBatchSize) {
      splitIndex = this.buffer.length;
    }

    const batch = this.buffer.splice(0, splitIndex);
    return batch;
  }

  // ==================== 状态查询 ====================

  /**
   * 获取当前缓冲区消息总数
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * 获取配置的窗口大小
   */
  getWindowSize(): number {
    return this.config.windowSize;
  }

  /**
   * 获取当前完整配置
   */
  getConfig(): ShortTermBufferConfig {
    return { ...this.config };
  }

  // ==================== 生命周期 ====================

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * 更新配置
   *
   * 如果新窗口大小小于当前 user 消息数，超出部分将被提取到待转换批次
   */
  updateConfig(config: Partial<ShortTermBufferConfig>): void {
    const oldWindowSize = this.config.windowSize;
    this.config = { ...this.config, ...config };

    // 如果新窗口大小比旧窗口小，且当前 user 消息数超出新窗口，提取待转换批次
    if (config.windowSize !== undefined && config.windowSize < oldWindowSize) {
      const currentUserCount = this.getUserMessageCount();
      const excess = currentUserCount - config.windowSize;
      if (excess > 0) {
        // 从头部提取多余的 user 消息及其关联 assistant
        this._pendingConversionBatch = this.popNUserMessages(excess);
      }
    }
  }

  /**
   * 获取并清空配置变更产生的待转换批次
   */
  getPendingConversionBatch(): Message[] {
    const batch = this._pendingConversionBatch;
    this._pendingConversionBatch = [];
    return batch;
  }

  /**
   * 从持久化数据恢复
   */
  restore(messages: Message[]): void {
    this.buffer = [...messages];
  }

  // ==================== 内部工具 ====================

  /**
   * 从头部弹出指定数量的 user 消息及其跟随的 assistant 消息
   *
   * 切割策略与 popBatchForConversion 相同：在下一个 user 消息前切断
   */
  private popNUserMessages(n: number): Message[] {
    let userCount = 0;
    let splitIndex = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i]?.role === 'user') {
        userCount++;
      }
      if (userCount >= n) {
        splitIndex = i + 1;
        // 继续收集跟随的 assistant 消息
        while (splitIndex < this.buffer.length && this.buffer[splitIndex]?.role !== 'user') {
          splitIndex++;
        }
        break;
      }
    }

    if (userCount < n) {
      splitIndex = this.buffer.length;
    }

    return this.buffer.splice(0, splitIndex);
  }
}

/**
 * 创建 ShortTermBuffer 实例
 */
export function createShortTermBuffer(config?: Partial<ShortTermBufferConfig>): ShortTermBuffer {
  return new ShortTermBuffer(config);
}
