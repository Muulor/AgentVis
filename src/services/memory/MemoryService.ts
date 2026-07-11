/**
 * MemoryService - 记忆服务主类
 *
 * 整合所有 Memory System 组件，提供统一的记忆管理接口。
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  Message,
  ShortTermBufferConfig,
  MemoryStats,
  LongTermFactCategory,
  LLMService,
  MemoryCandidate,
} from './types';
import { ShortTermBuffer, createShortTermBuffer } from './ShortTermBuffer';

import { SummaryManager, createSummaryManager } from './SummaryManager';
import { FactExtractor, createFactExtractor } from './FactExtractor';
import { MemoryCandidateScanner, createMemoryCandidateScanner } from './MemoryCandidateScanner';
import {
  StabilityVerifier,
  createStabilityVerifier,
  CANDIDATE_POOL_OVERFLOW_THRESHOLD,
} from './StabilityVerifier';
import { MemoryTriggerManager, createMemoryTriggerManager } from './MemoryTriggerManager';
import {
  CategoryConsolidationTracker,
  createCategoryConsolidationTracker,
} from './CategoryConsolidationTracker';
import { CategoryConsolidator, createCategoryConsolidator, sleep } from './CategoryConsolidator';
import { getMemorySafeMessageContent } from './utils/SafeMessageContent';
import { getLogger } from '@services/logger';

const logger = getLogger('MemoryService');

// ============================================================================
// 配置常量
// ============================================================================

/** 首次加载时的交互对数量 */
const DEFAULT_INITIAL_LOAD_COUNT = 5;

/** 增量加载时的最大交互对数量 */
const DEFAULT_INCREMENTAL_LOAD_LIMIT = 10;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items = value as unknown[];
  return items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function formatOpenQuestionIndexText(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items = value as unknown[];
  return items
    .map((item) => {
      const question = asRecord(item);
      if (!question) {
        return '';
      }

      const questionText = typeof question.question === 'string' ? question.question : '';
      const keywords = asStringList(question.keywords).join(' ');
      return `${questionText} ${keywords}`.trim();
    })
    .filter((text) => text.length > 0);
}

/**
 * MemoryService 配置
 */
export interface MemoryServiceConfig {
  agentId: string;
  bufferConfig?: Partial<ShortTermBufferConfig>;
  /** 事实候选扫描间隔（轮次），默认 5 */
  candidateScanInterval?: number;
}

/**
 * 记忆服务主类
 */
export class MemoryService {
  private agentId: string;
  private buffer: ShortTermBuffer;
  private summaryManager: SummaryManager;
  private factExtractor: FactExtractor;

  // 三层事实提取架构
  private candidateScanner: MemoryCandidateScanner;
  private stabilityVerifier: StabilityVerifier;
  // 混合触发模型（替代内存计数器）
  private triggerManager: MemoryTriggerManager;
  // 类别汇总机制
  private consolidationTracker: CategoryConsolidationTracker;
  private consolidator: CategoryConsolidator;
  // 水位线处理互斥锁：防止 onSessionEnd 和 checkWatermarkOnResume 并发调用导致重复处理
  private _watermarkLock = false;
  private _retryLock = false;

  constructor(llm: LLMService, config: MemoryServiceConfig) {
    this.agentId = config.agentId;

    // 初始化组件
    this.buffer = createShortTermBuffer(config.bufferConfig);
    this.summaryManager = createSummaryManager(llm, this.agentId);
    this.factExtractor = createFactExtractor(llm, this.agentId);

    // 初始化三层架构组件
    this.candidateScanner = createMemoryCandidateScanner(this.agentId);
    this.stabilityVerifier = createStabilityVerifier();
    // 初始化混合触发器（持久化状态机）
    this.triggerManager = createMemoryTriggerManager(this.agentId);
    // 初始化类别汇总组件
    this.consolidationTracker = createCategoryConsolidationTracker(this.agentId);
    this.consolidator = createCategoryConsolidator(this.agentId, llm);
  }

  /**
   * 添加交互对到记忆系统
   *
   * @param userMessage - 用户消息
   * @param assistantMessage - 助手回复
   */
  async addInteraction(userMessage: Message, assistantMessage: Message): Promise<void> {
    const safeUserMessage: Message = {
      ...userMessage,
      content: getMemorySafeMessageContent(userMessage),
    };
    const safeAssistantMessage: Message = {
      ...assistantMessage,
      content: getMemorySafeMessageContent(assistantMessage),
    };

    // 添加到短期缓冲（内存，用于会话内快速访问）
    this.buffer.addMessages(safeUserMessage, safeAssistantMessage);

    // 持久化短期消息到数据库（补偿策略：第二次失败时回滚第一次写入）
    try {
      // 写入 user 消息
      const userRecord = await invoke<{ id: string }>('memory_create', {
        request: {
          agentId: this.agentId,
          layer: 'short_term',
          content: `User: ${safeUserMessage.content}`,
          sourceMessageIds: safeUserMessage.id,
        },
      });

      // 写入 assistant 消息，失败时回滚 user 消息
      try {
        await invoke('memory_create', {
          request: {
            agentId: this.agentId,
            layer: 'short_term',
            content: `Agent: ${safeAssistantMessage.content}`,
            sourceMessageIds: safeAssistantMessage.id,
          },
        });
      } catch (assistantError) {
        // 补偿策略：回滚已写入的 user 消息，防止产生 orphan 记录
        logger.warn('[MemoryService] 写入 assistant 消息失败，尝试回滚 user 消息:', assistantError);
        try {
          if (userRecord.id) {
            await invoke('memory_delete', { id: userRecord.id });
            logger.trace('[MemoryService] 回滚 user 消息成功');
          }
        } catch (rollbackError) {
          // 回滚失败：最坏情况仅多一条 orphan 记录，配对扫描已能容错
          logger.error('[MemoryService] 回滚 user 消息也失败:', rollbackError);
        }
      }
    } catch (error) {
      logger.error('[MemoryService] 持久化短期消息失败:', error);
      // 持久化失败是非关键错误，记录后继续执行混合触发逻辑
      // 这样即使数据库暂时不可用，记忆系统仍可降级运行
    }

    // 混合触发模型 - 使用持久化状态机
    try {
      // 候选扫描仅用于触发信号累积，不写入候选池
      // 候选池写入统一由 processCandidates 负责（生命周期/混合触发路径）
      // 避免同一消息被 addInteraction 和 onSessionEnd 双重扫描导致 occurrenceCount 虚假膨胀
      const scanResult = this.candidateScanner.scan([safeUserMessage, safeAssistantMessage]);

      // 记录交互并判断是否触发
      const decision = await this.triggerManager.recordInteractionAndDecide(
        scanResult,
        safeUserMessage.content
      );

      logger.trace(
        `[MemoryService] 触发判断: shouldTrigger=${decision.shouldTrigger}, reason=${decision.reason}`
      );

      if (decision.shouldTrigger) {
        logger.trace(`[MemoryService]  混合触发: ${decision.reason}`);

        // 增量优化：只加载上次处理之后的新消息
        let messages: Message[];
        const lastProcessedId = decision.state.lastProcessedMessageId;

        if (lastProcessedId) {
          // 有历史处理记录，增量加载
          messages = await this.loadRecentMessagesAfter(
            lastProcessedId,
            DEFAULT_INCREMENTAL_LOAD_LIMIT
          );
          logger.trace(
            `[MemoryService] Fast 增量加载: 从 ${lastProcessedId} 之后加载了 ${messages.length} 条消息`
          );
        } else {
          // 首次处理，加载最近的消息
          messages = await this.loadRecentMessagesFromDB(DEFAULT_INITIAL_LOAD_COUNT);
          logger.trace(`[MemoryService] Fast 首次加载: 加载了 ${messages.length} 条消息`);
        }

        if (messages.length > 0) {
          await this.processCandidates(messages);
        }

        // 更新 lastProcessedMessageId（使用最新的 assistant 消息 ID）
        await this.triggerManager.updateLastProcessedMessage(safeAssistantMessage.id);

        // 重置触发器状态
        await this.triggerManager.resetAfterExtract();
      }
    } catch (triggerError) {
      logger.warn('[MemoryService] 混合触发器处理失败:', triggerError);
      // 不阻塞主流程
    }

    // 基于数据库实际记录数判断水位线
    // 每次 addInteraction 都检查：持续对话中水位持续增长
    await this.checkAndTriggerFromDatabase();
  }

  /**
   * 从数据库加载最近的消息
   *
   * @param count - 要加载的消息数量（user 消息数）
   * @returns 消息列表
   */
  private async loadRecentMessagesFromDB(count: number): Promise<Message[]> {
    try {
      const messages = await invoke<
        Array<{
          id: string;
          agentId: string;
          role: string;
          content: string;
          metadata: string | null;
          createdAt: number;
        }>
      >('message_get_recent', {
        agentId: this.agentId,
        count: count * 2,
      });

      return messages
        .sort((a, b) => a.createdAt - b.createdAt)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          agentId: m.agentId,
          role: m.role as 'user' | 'assistant',
          content: getMemorySafeMessageContent(m),
          createdAt: m.createdAt,
        }));
    } catch (error) {
      logger.warn('[MemoryService] 从数据库加载消息失败:', error);
      return [];
    }
  }

  /**
   * 从数据库增量加载指定消息 ID 之后的消息
   *
   * @param afterMessageId - 起始消息 ID（不包含）
   * @param limit - 最大加载数量
   * @returns 消息列表
   */
  private async loadRecentMessagesAfter(
    afterMessageId: string,
    limit: number = 20
  ): Promise<Message[]> {
    try {
      const messages = await invoke<
        Array<{
          id: string;
          agentId: string;
          role: string;
          content: string;
          metadata: string | null;
          createdAt: number;
        }>
      >('message_get_after', {
        agentId: this.agentId,
        afterMessageId,
        limit: limit * 2,
      });

      if (messages.length === 0) {
        logger.trace('[MemoryService] 增量加载: 没有新消息');
        return [];
      }

      const result = messages
        .sort((a, b) => a.createdAt - b.createdAt)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          agentId: m.agentId,
          role: m.role as 'user' | 'assistant',
          content: getMemorySafeMessageContent(m),
          createdAt: m.createdAt,
        }));
      logger.trace(`[MemoryService] 增量加载: 加载了 ${result.length} 条消息`);
      return result;
    } catch (error) {
      logger.warn('[MemoryService] 增量加载消息失败:', error);
      return [];
    }
  }

  /**
   * 基于数据库记录数检查并触发水位线转换
   *
   * 循环消费直到水位线降到安全区或 LLM 失败，解决消息堆积场景。
   * 死循环防护：如果一轮 batch 处理后 short_term 记录数无变化（LLM 持续失败），退出循环。
   */
  private async checkAndTriggerFromDatabase(): Promise<void> {
    // 互斥锁：防止 onSessionEnd 和 checkWatermarkOnResume 并发进入
    // 后入者直接跳过，避免重复处理同一批 short_term 记录导致重复摘要
    if (this._watermarkLock) {
      logger.trace('[MemoryService] 水位线处理正在进行中，跳过本次检查');
      return;
    }
    this._watermarkLock = true;

    const config = this.buffer.getConfig();
    let previousRecordCount = -1;

    // 循环消费直到水位线降到安全区或 LLM 持续失败
    try {
      for (;;) {
        try {
          // 1. 查询数据库中的 short_term 记录
          const shortTermRecords = await invoke<
            Array<{
              id: string;
              agentId: string;
              layer: string;
              content: string;
              sourceMessageIds: string | null;
              createdAt: number;
            }>
          >('memory_list_by_layer', {
            agentId: this.agentId,
            layer: 'short_term',
          });

          // 2. 计算当前 user 消息数（短期缓冲水位线基于 user 消息数）
          const userMessageCount = shortTermRecords.filter((r) =>
            r.content.startsWith('User:')
          ).length;
          const usageRatio = userMessageCount / config.windowSize;

          logger.trace(
            `[MemoryService] 水位线检查: ${userMessageCount}/${config.windowSize} = ${(usageRatio * 100).toFixed(0)}%, 阈值 ${(config.watermarkThreshold * 100).toFixed(0)}%`
          );

          // 3. 水位线未达阈值 → 退出循环
          if (usageRatio < config.watermarkThreshold) {
            break;
          }

          // 4. 死循环防护：如果记录数与上一轮相同，说明 LLM 持续失败（记录未被删除），退出循环
          if (shortTermRecords.length === previousRecordCount) {
            logger.warn(
              `[MemoryService] 水位线循环消费中止：LLM 持续失败，short_term 记录数未变化 (${shortTermRecords.length})`
            );
            break;
          }
          previousRecordCount = shortTermRecords.length;

          logger.trace(
            `[MemoryService] 水位线触发！开始转换... (记录数: ${shortTermRecords.length})`
          );

          // 发射水位线触发事件（通知 UI 显示整理状态）
          try {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('memory:watermark_triggered', { agentId: this.agentId });
          } catch {
            // 事件发射失败不影响主流程
          }

          await this.triggerConversionFromDatabase(shortTermRecords, config);

          // 发射水位线完成事件
          try {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('memory:watermark_completed', { agentId: this.agentId });
          } catch {
            // 事件发射失败不影响主流程
          }
        } catch (error) {
          logger.error('[MemoryService] 水位线检查失败:', error);
          // 发射失败事件
          try {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('memory:watermark_failed', { agentId: this.agentId, error: String(error) });
          } catch {
            // 忽略
          }
          // 异常退出循环，避免无限重试
          break;
        }
      }
    } finally {
      this._watermarkLock = false;
    }
  }

  /**
   * 从数据库记录触发转换
   *
   * @param records - 数据库中的 short_term 记录（按创建时间降序）
   * @param config - 缓冲配置
   */
  private async triggerConversionFromDatabase(
    records: Array<{
      id: string;
      agentId: string;
      layer: string;
      content: string;
      sourceMessageIds: string | null;
      createdAt: number;
    }>,
    config: ShortTermBufferConfig
  ): Promise<void> {
    // 1. 按创建时间正序排列（FIFO 原则）
    const sortedRecords = [...records].sort((a, b) => a.createdAt - b.createdAt);

    // 2. 计算要转换的 user 消息数
    const userBatchSize = Math.ceil(config.windowSize * config.batchSizeRatio);

    // 3. 从头部扫描，找到第 N 个 user 消息的切割点（含其跟随的 assistant 消息）
    let userCount = 0;
    let splitIndex = 0;
    for (let i = 0; i < sortedRecords.length; i++) {
      const record = sortedRecords[i];
      if (!record) continue;
      const isUser = record.content.startsWith('User:');
      if (isUser) {
        userCount++;
      }
      if (userCount >= userBatchSize) {
        splitIndex = i + 1;
        // 继续收集跟随的 assistant 消息
        while (
          splitIndex < sortedRecords.length &&
          !sortedRecords[splitIndex]?.content.startsWith('User:')
        ) {
          splitIndex++;
        }
        break;
      }
    }

    // user 消息数不足一个批次时，取全部
    if (userCount < userBatchSize) {
      splitIndex = sortedRecords.length;
    }

    const batchRecords = sortedRecords.slice(0, splitIndex);

    if (batchRecords.length < 1) {
      logger.trace('[MemoryService] 批次记录不足，跳过转换');
      return;
    }

    // 4. 解析为扁平 Message[] 格式
    const messages = this.parseRecordsToMessages(batchRecords);
    logger.trace(`[MemoryService] 准备转换 ${messages.length} 条消息`);

    // 5. 执行转换（生成摘要）— LLM 失败时保留 short_term 记录等待下次重试
    try {
      await this.processConversionBatch(messages);
    } catch (conversionError) {
      // 摘要生成失败（LLM 不可用），保留 short_term 记录
      // 下次 addInteraction 或 onSessionEnd 会重新检查水位线触发重试
      logger.warn('[MemoryService] 摘要生成失败，保留 short_term 记录等待重试:', conversionError);
      return;
    }

    // 6. 仅在转换成功后删除 short_term 记录
    for (const record of batchRecords) {
      try {
        await invoke('memory_delete', { id: record.id });
      } catch (e) {
        logger.warn('[MemoryService] 删除 short_term 记录失败:', e);
      }
    }

    logger.trace(`[MemoryService] 转换完成，已删除 ${batchRecords.length} 条 short_term 记录`);
  }

  /**
   * 将数据库记录解析为扁平 Message[] 格式
   *
   * 不再强制配对，直接按记录顺序构建 Message 列表，
   * 支持任意角色序列（连续 user、orphan assistant 等）。
   *
   * @param records - 数据库记录（应按时间正序排列）
   * @returns 消息列表
   */
  private parseRecordsToMessages(
    records: Array<{
      id: string;
      content: string;
      sourceMessageIds: string | null;
      createdAt: number;
    }>
  ): Message[] {
    return records.map((record) => {
      // 根据内容前缀判断角色
      const isUser = record.content.startsWith('User:');
      const role: 'user' | 'assistant' = isUser ? 'user' : 'assistant';
      // 移除 "User: " 或 "Agent: "/"Assistant: " 前缀
      const content = isUser
        ? record.content.replace(/^User:\s*/, '')
        : record.content.replace(/^(Agent|Assistant):\s*/, '');

      const message = {
        id: record.sourceMessageIds ?? record.id,
        agentId: this.agentId,
        role,
        content,
        createdAt: record.createdAt,
      };

      return {
        ...message,
        content: getMemorySafeMessageContent(message),
      };
    });
  }

  /**
   * 处理事实候选（事件驱动触发）
   *
   * 三层事实提取架构
   * Layer 1: 候选扫描
   * Layer 2: 稳定性验证
   * Layer 3: 写入记忆
   *
   * @param interactions - 最近的交互对
   */
  async processCandidates(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    logger.trace(`[MemoryService]  扫描事实候选: ${messages.length} 条消息`);

    // 【Layer 1】候选扫描 - 规则检测，不调用 LLM
    const scanResult = this.candidateScanner.scan(messages);
    if (scanResult.candidates.length === 0) {
      logger.trace(`[MemoryService] 未检测到事实候选`);
      return;
    }

    logger.trace(`[MemoryService] 检测到 ${scanResult.candidates.length} 个候选`);

    // 获取现有候选池
    const existingCandidates = await this.getCandidatePool();

    // 合并新旧候选（使用语义匹配）
    const mergedCandidates = await this.stabilityVerifier.mergeCandidatesAsync(
      scanResult.candidates,
      existingCandidates
    );

    // 【Layer 2】稳定性验证（Cascading Verification + 语义增强）
    const { passed, retained } = await this.stabilityVerifier.verifyBatchAsync(mergedCandidates);

    logger.trace(`[MemoryService] 验证结果: ${passed.length} 通过, ${retained.length} 保留`);

    // 【批量晋升】检查保留池是否有类别溢出
    const categoryCounts = new Map<LongTermFactCategory, MemoryCandidate[]>();
    for (const c of retained) {
      const list = categoryCounts.get(c.category) ?? [];
      list.push(c);
      categoryCounts.set(c.category, list);
    }

    // 筛选出溢出的类别，将其候选移动到 passed 列表
    const retainedAfterPromotion: MemoryCandidate[] = [];
    for (const [category, candidates] of categoryCounts) {
      if (candidates.length >= CANDIDATE_POOL_OVERFLOW_THRESHOLD) {
        logger.trace(
          `[MemoryService]  类别 ${category} 保留池溢出 (${candidates.length} 条)，触发批量晋升`
        );
        passed.push(...candidates);
      } else {
        retainedAfterPromotion.push(...candidates);
      }
    }

    // 显示保留的候选详情（调试用）
    if (retainedAfterPromotion.length > 0) {
      logger.trace('[MemoryService]  保留的候选:');
      retainedAfterPromotion.forEach((c, i) => {
        logger.trace(
          `  ${i + 1}. [${c.category}] ${c.content.substring(0, 60)}... (score: ${c.score})`
        );
      });
    }

    // 保存保留的候选到候选池（排除已晋升的）
    await this.saveCandidatePool(retainedAfterPromotion);

    // 【Layer 3】处理通过验证的候选 - 调用 LLM 提取并写入长期记忆
    if (passed.length > 0) {
      const { savedCount, failedCandidateIds } =
        await this.factExtractor.extractAndSaveFromVerified(passed);
      logger.trace(`[MemoryService]  写入 ${savedCount} 个事实`);

      // 仅删除已成功处理（含 LLM 正常拒绝）的候选
      // API 失败的候选保留在池中，下次触发时自然重新参与处理
      const failedIdSet = new Set(failedCandidateIds);
      const processedIds = passed.map((c) => c.id).filter((id) => !failedIdSet.has(id));
      await this.deleteCandidatesFromPool(processedIds);

      if (failedCandidateIds.length > 0) {
        // 将 API 失败的候选显式保存回候选池
        // 因为 passed 中的候选在 saveCandidatePool(retainedAfterPromotion) 时未被持久化，
        // 如果不显式写回，这些候选在下次扫描时将丢失
        const failedCandidates = passed.filter((c) => failedIdSet.has(c.id));
        await this.saveCandidatePool(failedCandidates);
        logger.warn(
          `[MemoryService] ${failedCandidateIds.length} 个候选因 API 失败已写回候选池等待重试`
        );
      }

      // 发射事实更新事件（通知 UI 刷新）
      if (savedCount > 0) {
        try {
          const { emit } = await import('@tauri-apps/api/event');
          await emit('memory:facts_updated', { agentId: this.agentId, count: savedCount });
        } catch {
          // 事件发射失败不影响主流程
        }
      }

      // 触发汇总检查（异步执行，不阻塞主流程）
      this.checkAndTriggerConsolidation().catch((err: unknown) => {
        logger.warn('[MemoryService] 汇总检查失败:', err);
      });
    }
  }

  /**
   * 重试候选池中的待处理候选
   *
   * 当生命周期判定"无新内容"时，检查候选池是否有之前 API 失败写回的候选。
   * 跳过 Layer 1 扫描，直接走 Layer 2 验证 + Layer 3 提取。
   *
   * @param candidates - 候选池中的待重试候选
   */
  private async retryPendingCandidates(candidates: MemoryCandidate[]): Promise<void> {
    if (candidates.length === 0) return;

    // 互斥锁：防止 onSessionEnd 两次并发触发导致同一批候选被重复处理
    if (this._retryLock) {
      logger.trace('[MemoryService] 候选池重试正在进行中，跳过本次');
      return;
    }
    this._retryLock = true;

    try {
      // 【Layer 2】稳定性验证
      const { passed, retained } = await this.stabilityVerifier.verifyBatchAsync(candidates);
      logger.trace(`[MemoryService] 重试验证结果: ${passed.length} 通过, ${retained.length} 保留`);

      // 保存保留的候选
      await this.saveCandidatePool(retained);

      // 【Layer 3】提取并写入长期记忆
      if (passed.length > 0) {
        const { savedCount, failedCandidateIds } =
          await this.factExtractor.extractAndSaveFromVerified(passed);
        logger.trace(`[MemoryService]  重试写入 ${savedCount} 个事实`);

        const failedIdSet = new Set(failedCandidateIds);
        const processedIds = passed.map((c) => c.id).filter((id) => !failedIdSet.has(id));
        await this.deleteCandidatesFromPool(processedIds);

        if (failedCandidateIds.length > 0) {
          const failedCandidates = passed.filter((c) => failedIdSet.has(c.id));
          await this.saveCandidatePool(failedCandidates);
          logger.warn(
            `[MemoryService] 重试仍有 ${failedCandidateIds.length} 个候选失败，已写回候选池`
          );
        }

        // 发射事实更新事件
        if (savedCount > 0) {
          try {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('memory:facts_updated', { agentId: this.agentId, count: savedCount });
          } catch {
            // 事件发射失败不影响主流程
          }
          this.checkAndTriggerConsolidation().catch((err: unknown) => {
            logger.warn('[MemoryService] 汇总检查失败:', err);
          });
        }
      }
    } catch (error) {
      logger.warn('[MemoryService] 候选池重试失败:', error);
    } finally {
      this._retryLock = false;
    }
  }

  /**
   * 检查并触发类别汇总
   *
   * 当某类别的事实数量达到阈值时，触发 LLM 汇总
   */
  private async checkAndTriggerConsolidation(): Promise<void> {
    const pending = await this.consolidationTracker.checkPendingConsolidations();

    if (pending.length === 0) {
      return;
    }

    logger.trace(`[MemoryService]  检测到 ${pending.length} 个类别需要汇总:`, pending);

    // 串行处理，按阈值从小到大顺序
    for (const category of pending) {
      try {
        const facts = await this.consolidationTracker.getCategoryFacts(category);

        if (facts.length > 0) {
          const result = await this.consolidator.consolidate(category, facts);

          if (result.wrote) {
            logger.trace(
              `[MemoryService]  类别 ${category} 汇总完成: ${result.consolidatedFact ?? ''}`
            );
          } else {
            logger.trace(
              `[MemoryService]  类别 ${category} 汇总跳过: ${result.reason ?? 'unknown'}`
            );
          }

          // 短暂延迟避免 LLM 限流
          await sleep(500);
        }
      } catch (error) {
        logger.error(`[MemoryService] 类别 ${category} 汇总失败:`, error);
      }
    }
  }

  /**
   * 获取候选池
   */
  private async getCandidatePool(): Promise<MemoryCandidate[]> {
    try {
      const result = await invoke<
        Array<{
          id: string;
          agentId: string;
          content: string;
          category: string;
          occurrenceCount: number;
          firstSeenAt: number;
          lastSeenAt: number;
          userConfirmed: boolean;
          score: number;
        }>
      >('memory_candidate_list', { agentId: this.agentId });

      return result.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        content: r.content,
        category: r.category as MemoryCandidate['category'],
        occurrenceCount: r.occurrenceCount,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        userConfirmed: r.userConfirmed,
        score: r.score,
      }));
    } catch (error) {
      logger.warn('[MemoryService] 获取候选池失败:', error);
      return [];
    }
  }

  /**
   * 保存候选到候选池
   *
   * 性能优化：一次性查询候选池，使用 Set 进行 O(1) 查找
   * 复杂度从 O(n²) 降为 O(n)
   */
  private async saveCandidatePool(candidates: MemoryCandidate[]): Promise<void> {
    if (candidates.length === 0) return;

    // 一次性获取候选池（而非循环内每次查询）
    const existing = await this.getCandidatePool();
    const existingIds = new Set(existing.map((c) => c.id));

    for (const candidate of candidates) {
      try {
        if (existingIds.has(candidate.id)) {
          // 更新现有候选
          await invoke('memory_candidate_update', {
            id: candidate.id,
            occurrenceCount: candidate.occurrenceCount,
            lastSeenAt: candidate.lastSeenAt,
            userConfirmed: candidate.userConfirmed,
            score: candidate.score,
          });
        } else {
          // 创建新候选
          await invoke('memory_candidate_create', {
            request: {
              agentId: candidate.agentId,
              content: candidate.content,
              category: candidate.category,
              occurrenceCount: candidate.occurrenceCount,
              firstSeenAt: candidate.firstSeenAt,
              lastSeenAt: candidate.lastSeenAt,
              userConfirmed: candidate.userConfirmed,
              score: candidate.score,
            },
          });
          // 新增到 existingIds 避免同批次重复创建
          existingIds.add(candidate.id);
        }
      } catch (error) {
        logger.warn('[MemoryService] 保存候选失败:', error);
      }
    }
  }

  /**
   * 从候选池删除候选
   */
  private async deleteCandidatesFromPool(ids: string[]): Promise<void> {
    try {
      await invoke('memory_candidate_delete_batch', { ids });
    } catch (error) {
      logger.warn('[MemoryService] 删除候选失败:', error);
    }
  }

  /**
   * 处理转换批次（仅生成摘要，用于上下文压缩）
   *
   * Chain-of-State：先加载最近一条摘要的前置状态，
   * 再将其注入 generateSummary，使 LLM 能检测新批次是否推翻或解答了历史状态。
   * 重构：水位线触发只负责摘要生成，事实提取由三层架构（事件驱动）负责
   */
  private async processConversionBatch(batch: Message[]): Promise<void> {
    if (batch.length === 0) return;

    const safeBatch = batch.map((message) => ({
      ...message,
      content: getMemorySafeMessageContent(message),
    }));

    logger.trace(`[MemoryService] 处理 ${safeBatch.length} 条消息（仅摘要）`);

    // 加载前置状态（Chain-of-State 接力）
    // 任何失败均降级返回 null，不阻断压缩流程
    const priorState = await this.loadLatestSummaryState();

    // 生成并保存摘要（含前置状态感知）
    const summaryResult = await this.summaryManager.generateSummary(safeBatch, priorState);
    if (summaryResult.summary) {
      const sourceIds = safeBatch.map((m) => m.id);
      await this.summaryManager.saveSummary(summaryResult, sourceIds);
      logger.trace(
        `[MemoryService] 摘要已保存（Chain-of-State）: ${summaryResult.summary.substring(0, 50)}...`
      );
    }

    // 事实提取由三层架构负责（事件驱动触发 processCandidates）
    // 不再调用 extractAndSaveFacts
  }

  /**
   * 加载最近一条摘要的前置状态（用于 Chain-of-State 接力）
   *
   * 只读取最近一条摘要（非全量），提取 confirmedDecisions 和 openQuestions。
   * - confirmedDecisions：作为只读冲突检测参考，防止被原样继承导致无限积累
   * - openQuestions：判断新对话是否已解答遗留问题
   * - invalidatedPoints：不参与接力（已失效信息无需延续）
   *
   * 两者均为空时返回 null（避免注入无意义的前置状态块影响 LLM 理解）。
   * 任何失败均降级返回 null，不阻断压缩主流程。
   */
  private async loadLatestSummaryState(): Promise<
    import('./SummaryManager').PriorSummaryState | null
  > {
    try {
      const summaries = await this.summaryManager.getSummaries();
      if (summaries.length === 0) {
        logger.trace('[MemoryService] 无历史摘要，跳过前置状态加载（首条摘要）');
        return null;
      }

      // 按创建时间降序，取最近一条
      const latest = [...summaries].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!latest) {
        return null;
      }

      if (!latest.metadataJson) {
        logger.trace('[MemoryService] 最近摘要无 metadataJson，降级为无前置状态');
        return null;
      }

      const metadata = JSON.parse(latest.metadataJson) as {
        confirmedDecisions?: unknown;
        openQuestions?: unknown;
      };

      const confirmedDecisions = Array.isArray(metadata.confirmedDecisions)
        ? (metadata.confirmedDecisions as unknown[]).filter(
            (d): d is string => typeof d === 'string' && d.trim().length > 0
          )
        : [];

      const openQuestions = Array.isArray(metadata.openQuestions)
        ? (metadata.openQuestions as unknown[])
            .filter(
              (q): q is { question: string; scope?: string } =>
                q !== null &&
                typeof q === 'object' &&
                typeof (q as Record<string, unknown>).question === 'string'
            )
            .map((q) => ({
              question: q.question.trim(),
              scope: typeof q.scope === 'string' ? q.scope : 'general',
            }))
        : [];

      // 两者均为空时返回 null（避免注入意义不大的占位区块）
      if (confirmedDecisions.length === 0 && openQuestions.length === 0) {
        logger.trace('[MemoryService] 前置状态字段均为空，降级为无前置状态');
        return null;
      }

      logger.trace(
        `[MemoryService] 加载前置状态: confirmedDecisions=${confirmedDecisions.length}, openQuestions=${openQuestions.length}`
      );
      return { confirmedDecisions, openQuestions };
    } catch (error) {
      // 降级：任何解析/网络失败不阻断压缩流程
      logger.warn('[MemoryService] 加载前置摘要状态失败，降级为无前置状态:', error);
      return null;
    }
  }

  /**
   * 会话结束时调用（生命周期事件 - 强触发）
   *
   * 混合触发模型 - 生命周期事件作为强一致点
   * 增加内容变化检测，避免频繁切换窗口时重复处理相同内容
   * 增量优化: 只加载上次处理之后的新消息，避免重复扫描
   */
  async onSessionEnd(): Promise<void> {
    logger.trace('[MemoryService]  onSessionEnd 开始, agentId:', this.agentId);

    try {
      // 1. 获取最新消息 ID 用于内容变化检测
      const recentMessages = await invoke<
        Array<{
          id: string;
          agentId: string;
          role: string;
          content: string;
          createdAt: number;
        }>
      >('message_get_recent', {
        agentId: this.agentId,
        count: 1,
      });
      const latestMessageId = recentMessages[0]?.id;
      logger.trace('[MemoryService] latestMessageId:', latestMessageId);

      // 2. 判断是否应该触发（传入最新消息 ID 进行变化检测）
      const decision = await this.triggerManager.triggerOnLifecycleEvent(latestMessageId);
      logger.trace('[MemoryService] 生命周期决策:', {
        shouldTrigger: decision.shouldTrigger,
        reason: decision.reason,
        turnsSinceLastExtract: decision.state.turnsSinceLastExtract,
        candidateSignalScore: decision.state.candidateSignalScore,
        lastProcessedMessageId: decision.state.lastProcessedMessageId,
      });

      if (decision.shouldTrigger) {
        logger.trace(`[MemoryService]  生命周期触发: 会话结束`);

        // 3. 增量加载：只加载上次处理之后的新消息
        let messages: Message[];
        const lastProcessedId = decision.state.lastProcessedMessageId;

        if (lastProcessedId) {
          // 有历史处理记录，增量加载
          messages = await this.loadRecentMessagesAfter(
            lastProcessedId,
            DEFAULT_INCREMENTAL_LOAD_LIMIT
          );
          logger.trace(
            `[MemoryService] 增量加载: 从 ${lastProcessedId} 之后加载了 ${messages.length} 条消息`
          );
        } else {
          // 首次处理，加载最近的消息
          messages = await this.loadRecentMessagesFromDB(DEFAULT_INITIAL_LOAD_COUNT);
          logger.trace(`[MemoryService] 首次加载: 加载了 ${messages.length} 条消息`);
        }

        if (messages.length > 0) {
          await this.processCandidates(messages);
        }

        // 4. 处理完成后更新 lastProcessedMessageId（避免下次重复处理）
        if (latestMessageId) {
          await this.triggerManager.updateLastProcessedMessage(latestMessageId);
        }

        // 重置触发器状态
        await this.triggerManager.resetAfterExtract();
      } else {
        logger.trace('[MemoryService] 生命周期不触发, reason:', decision.reason);

        // 候选池重试：即使没有新消息，如果候选池中有之前 API 失败写回的候选，
        // 利用生命周期事件重试提取（切换窗口/切回时触发）
        const pendingCandidates = await this.getCandidatePool();
        if (pendingCandidates.length > 0) {
          logger.trace(
            `[MemoryService] 候选池有 ${pendingCandidates.length} 个待重试候选，触发重试`
          );
          // 构造空交互对列表触发 processCandidates，
          // processCandidates 内部会通过 getCandidatePool 读取并合并
          await this.retryPendingCandidates(pendingCandidates);
        }
      }
    } catch (error) {
      logger.warn('[MemoryService] 生命周期触发失败:', error);
    }

    // 无论候选触发是否执行，都检查水位线
    // 修复：生命周期事件不检查水位线导致堆积的 short_term 记录无法被消费
    await this.checkAndTriggerFromDatabase();
  }

  /**
   * 获取用于上下文组装的记忆数据
   */
  async getContextMemories(): Promise<{
    recentMessages: Message[];
    summaries: string[];
    facts: Array<{ content: string; category: LongTermFactCategory }>;
  }> {
    // 获取最近消息
    const recentMessages = this.buffer.getAllMessages();

    // 获取摘要
    const summaryRecords = await this.summaryManager.getSummaries();
    const summaries = summaryRecords.map((s) => s.content);

    // 获取事实
    const factRecords = await this.factExtractor.getAllFacts();
    const facts = factRecords.map((f) => ({
      content: f.content,
      category: f.category,
    }));

    return { recentMessages, summaries, facts };
  }

  /**
   * 直写任务经验到长期记忆
   *
   * 绕过三层验证流水线（候选→稳定性→LLM 提取），因为：
   * - 经验是系统自总结的确定性内容，不需要用户确认
   * - 经验来源于 SA 的实际执行结果，不需要稳定性验证
   *
   * 内部复用 FactExtractor.saveFactV2 确保：
   * - 重复内容自动合并更新（语义相似度 >= 75% 视为同一条）
   * - 事实通过全量加载注入上下文，不主动创建事实向量索引
   *
   * @param content - 经验内容（精炼的一句话描述，如"Windows 下应用 findstr 而非 grep"）
   */
  async saveTaskExperience(content: string): Promise<void> {
    if (!content.trim()) {
      logger.warn('[MemoryService] saveTaskExperience: 内容为空，跳过');
      return;
    }

    try {
      await this.factExtractor.saveFactV2({
        agentId: this.agentId,
        content: content.trim(),
        category: 'task_experience',
        confidence: 0.9, // 系统试错总结的置信度较高
        evidenceCount: 1,
        lastVerified: Date.now(),
        scope: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      logger.trace(`[MemoryService] ✅ 任务经验已保存: ${content.trim().substring(0, 60)}`);
    } catch (error) {
      // 经验写入失败不应阻塞主流程
      logger.warn('[MemoryService] saveTaskExperience 失败:', error);
    }
  }

  /**
   * 获取指定类别的事实
   */
  async getFactsByCategory(category: LongTermFactCategory): Promise<string[]> {
    const facts = await this.factExtractor.getFactsByCategory(category);
    return facts.map((f) => f.content);
  }

  /**
   * 删除记忆
   */
  async deleteMemory(memoryId: string): Promise<void> {
    await invoke('memory_delete', { id: memoryId });
  }

  /**
   * 更新记忆内容
   */
  async updateMemory(memoryId: string, content: string): Promise<void> {
    await invoke('memory_update', { id: memoryId, content });
  }

  /**
   * 获取记忆统计
   */
  async getStats(): Promise<MemoryStats> {
    const result = await invoke<{
      short_term_count: number;
      summary_count: number;
      fact_count: number;
    }>('memory_get_stats', { agentId: this.agentId });

    return {
      shortTermCount: result.short_term_count,
      summaryCount: result.summary_count,
      factCount: result.fact_count,
      totalCount: result.short_term_count + result.summary_count + result.fact_count,
    };
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    bufferSize: number;
    windowSize: number;
    usageRatio: number;
    isAboveWatermark: boolean;
  } {
    return {
      bufferSize: this.buffer.size(),
      windowSize: this.buffer.getWindowSize(),
      usageRatio: this.buffer.getUsageRatio(),
      isAboveWatermark: this.buffer.isAboveWatermark(),
    };
  }

  /**
   * 清空短期缓冲
   */
  clearBuffer(): void {
    this.buffer.clear();
  }

  /**
   * 从内存缓冲区中移除指定消息
   *
   * 供聊天窗口删除消息时联动调用，防止已删除消息残留在内存 buffer 中。
   * 数据库 short_term 记录由调用方通过 memory_delete_by_source_ids 删除。
   *
   * @param messageId - 要移除的消息 ID
   */
  removeMessageFromBuffer(messageId: string): void {
    this.buffer.removeByMessageId(messageId);
  }

  /**
   * 获取内部组件（用于高级用法）
   */
  getComponents() {
    return {
      buffer: this.buffer,
      summaryManager: this.summaryManager,
      factExtractor: this.factExtractor,
    };
  }

  /**
   * 获取当前短期缓冲配置
   */
  getBufferConfig(): ShortTermBufferConfig {
    return this.buffer.getConfig();
  }

  /**
   * 更新短期缓冲配置
   *
   * 如果新配置缩小了窗口大小，超出部分将自动触发摘要转换。
   * 如果 LLM 调用失败，会回滚配置变更并抛出错误。
   *
   * @param config - 新配置
   * @throws 如果转换过程中 LLM 调用失败
   */
  async updateBufferConfig(config: Partial<ShortTermBufferConfig>): Promise<void> {
    // 保存旧配置用于回滚
    const oldConfig = this.buffer.getConfig();

    // 应用新配置（可能产生待转换批次）
    this.buffer.updateConfig(config);

    // 检查是否有待转换的批次
    const pendingBatch = this.buffer.getPendingConversionBatch();
    if (pendingBatch.length > 0) {
      logger.trace(`[MemoryService] 配置变更触发转换: ${pendingBatch.length} 个交互对`);

      try {
        await this.processConversionBatch(pendingBatch);
        logger.trace(`[MemoryService]  配置变更转换完成`);
      } catch (error) {
        // LLM 调用失败，回滚配置变更
        logger.error('[MemoryService]  配置变更转换失败，回滚配置:', error);

        // 回滚到旧配置
        this.buffer.updateConfig(oldConfig);

        // 将批次放回缓冲区（恢复数据）
        this.buffer.addMessages(...pendingBatch);

        // 抛出错误供调用方处理（显示 Toast）
        throw new Error(
          `Configuration update failed: LLM call error - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Agent 切换回来或应用启动时调用
   *
   * 检查是否有堆积的 short_term 记录需要处理（之前 LLM 失败导致的遗留）。
   * 由 AgentChatView 在 Agent 切换时调用。
   */
  async checkWatermarkOnResume(): Promise<void> {
    logger.trace('[MemoryService] 恢复检查: 开始水位线检查, agentId:', this.agentId);

    // 1. 补索引：重试内存队列中 Embedding API 失败的摘要（同一会话内的失败）
    if (this.summaryManager.hasPendingIndexes) {
      try {
        const count = await this.summaryManager.retryPendingIndexes();
        if (count > 0) {
          logger.trace(`[MemoryService] 恢复检查: 内存队列补索引 ${count} 条摘要`);
        }
      } catch (retryError) {
        logger.warn('[MemoryService] 内存队列补索引失败:', retryError);
      }
    }

    // 2. DB-向量库对账：覆盖应用重启后内存队列丢失的场景
    await this.reconcileUnindexedSummaries();

    // 3. 原有水位线检查
    await this.checkAndTriggerFromDatabase();
  }

  /**
   * 对账：对比 DB 中的摘要记录与向量库已索引的 documentId，补索引缺失的摘要
   *
   * 覆盖场景：Embedding API 故障期间生成的摘要已存 DB，但向量索引失败，
   * 应用重启后内存队列丢失，需要从 DB 出发重新发现并补索引。
   */
  private async reconcileUnindexedSummaries(): Promise<void> {
    try {
      // 查询 DB 中所有 summary 记录
      const summaries = await invoke<
        Array<{
          id: string;
          content: string;
          metadataJson: string | null;
        }>
      >('memory_list_by_layer', {
        agentId: this.agentId,
        layer: 'summary',
      });

      if (summaries.length === 0) return;

      // 查询向量库中已索引的 documentId 集合
      const indexedDocIds = await invoke<string[]>('rag_list_document_ids', {
        agentId: this.agentId,
      });
      const indexedSet = new Set(indexedDocIds);

      // 找出未索引的摘要（documentId 格式为 memory_summary_{id}）
      const SUMMARY_DOC_PREFIX = 'memory_summary_';
      const unindexed = summaries.filter((s) => !indexedSet.has(`${SUMMARY_DOC_PREFIX}${s.id}`));

      if (unindexed.length === 0) return;

      logger.trace(`[MemoryService] 对账发现 ${unindexed.length} 条未索引摘要，开始补索引`);

      const { getMemoryVectorIndex } = await import('./MemoryVectorIndex');
      const vectorIndex = getMemoryVectorIndex();
      let successCount = 0;

      for (const summary of unindexed) {
        try {
          // 从 content + metadataJson 还原索引文本
          const indexText = this.buildIndexTextFromRecord(summary.content, summary.metadataJson);
          await vectorIndex.indexSummary(this.agentId, summary.id, indexText);
          successCount++;
        } catch (indexError) {
          // 单条失败不中断，继续处理其余摘要
          logger.warn(`[MemoryService] 对账补索引失败: ${summary.id}`, indexError);
          break; // Embedding API 仍不可用时，不再继续浪费请求
        }
      }

      if (successCount > 0) {
        logger.trace(`[MemoryService] 对账补索引完成: ${successCount}/${unindexed.length}`);
      }
    } catch (error) {
      // 对账是非关键操作，失败不影响主流程
      logger.warn('[MemoryService] 对账检查失败:', error);
    }
  }

  /**
   * 从 DB 记录还原索引文本
   *
   * 复用 SummaryManager.buildIndexText 的逻辑，
   * 但数据来源是 DB 存储的 content + metadataJson 而非 LLM 返回的 SummaryResult
   */
  private buildIndexTextFromRecord(content: string, metadataJson: string | null): string {
    const parts: string[] = [content];

    if (!metadataJson) return content;

    try {
      const metadata = asRecord(JSON.parse(metadataJson) as unknown);
      if (!metadata) {
        return content;
      }

      const topics = asStringList(metadata.topics);
      if (topics.length > 0) {
        parts.push(`Topics: ${topics.join(', ')}`);
      }

      const keyPoints = asStringList(metadata.keyPoints);
      if (keyPoints.length > 0) {
        parts.push(keyPoints.join(' '));
      }

      const confirmedDecisions = asStringList(metadata.confirmedDecisions);
      if (confirmedDecisions.length > 0) {
        parts.push(confirmedDecisions.join(' '));
      }

      const questions = formatOpenQuestionIndexText(metadata.openQuestions);
      if (questions.length > 0) {
        parts.push(questions.join(' '));
      }

      const invalidatedPoints = asStringList(metadata.invalidatedPoints);
      if (invalidatedPoints.length > 0) {
        parts.push(invalidatedPoints.join(' '));
      }
    } catch {
      // metadataJson 解析失败，仅用 content 作为索引文本
    }

    return parts.join(' ');
  }
}

/**
 * 创建 MemoryService 实例
 */
export function createMemoryService(llm: LLMService, config: MemoryServiceConfig): MemoryService {
  return new MemoryService(llm, config);
}

// ============================================================================
// 全局工厂缓存（单例模式）
// ============================================================================

/**
 * MemoryService 实例缓存
 * 按 agentId 隔离，避免重复实例化导致的状态不一致
 */
const memoryServiceCache = new Map<string, MemoryService>();

/**
 * 获取或创建 MemoryService 实例
 *
 * 如果缓存中存在相同 agentId 的实例，直接返回；否则创建新实例并缓存。
 * 注意：LLMService 参数仅在首次创建时使用，后续调用会复用已有实例。
 *
 * @param agentId - Agent ID
 * @param llmService - LLM 服务（仅首次创建时使用）
 * @param options - 可选配置
 * @returns MemoryService 实例
 */
export function getOrCreateMemoryService(agentId: string, llmService: LLMService): MemoryService {
  if (!memoryServiceCache.has(agentId)) {
    const service = createMemoryService(llmService, {
      agentId,
    });
    memoryServiceCache.set(agentId, service);
    logger.trace('[MemoryService] 创建新实例:', agentId);
  }
  const cached = memoryServiceCache.get(agentId);
  if (!cached) {
    throw new Error(`MemoryService cache was not initialized for agent: ${agentId}`);
  }
  return cached;
}

/**
 * 销毁 MemoryService 实例
 *
 * 在 Agent 切换或组件卸载时调用，触发 onSessionEnd 并清理缓存。
 *
 * @param agentId - Agent ID
 */
export async function disposeMemoryService(agentId: string): Promise<void> {
  const service = memoryServiceCache.get(agentId);
  if (service) {
    try {
      await service.onSessionEnd();
      logger.trace('[MemoryService] 实例已销毁:', agentId);
    } finally {
      memoryServiceCache.delete(agentId);
    }
  }
}

/**
 * 检查是否存在缓存的 MemoryService 实例
 *
 * @param agentId - Agent ID
 * @returns 是否存在缓存实例
 */
export function hasMemoryService(agentId: string): boolean {
  return memoryServiceCache.has(agentId);
}

/**
 * 从缓存获取已初始化的 MemoryService 实例
 *
 * 与 getOrCreateMemoryService 不同，不会创建新实例，仅返回缓存中已有的实例。
 * 适用于不持有 LLMService 依赖的调用方（如 Agent Loop 的经验写入路径）。
 *
 * @param agentId - Agent ID
 * @returns 已缓存的 MemoryService 实例，若未初始化返回 null
 */
export function getCachedMemoryService(agentId: string): MemoryService | null {
  return memoryServiceCache.get(agentId) ?? null;
}
