/**
 * ImProgressTracker - IM 任务进度追踪器
 *
 * 将 AgentLoopCallbacks 事件转换为 IM 卡片内容，并以节流方式推送更新。
 *
 * 设计说明：
 * - 维护一个进度缓冲区，收集思维链、FSM 状态、Sub-Agent 等事件
 * - 每 THROTTLE_INTERVAL_MS 批量合并一次，调用 updateCard() 刷新 IM 卡片
 * - IM 平台更新接口通常有频控，2 秒节流保持在安全范围
 * - 任务完成/失败时立即推送最终卡片
 */

import type { ImChannel, ImCardContent, ImTask } from './types';
import type { SubAgentObservationEvent } from '@services/planning/agent-loop/types';
import {
  buildProgressCard,
  buildCompletionCard,
  buildErrorCard,
  buildPendingCard,
} from './cardTemplates';
import { getLogger } from '@services/logger';
import { upsertSubAgentObservationEvent } from '@services/planning/utils/SubAgentObservationEvents';
import { translate } from '@/i18n';

const logger = getLogger('ImProgressTracker');

// ============================================================================
// 常量
// ============================================================================

/** 卡片更新节流间隔（ms）— 飞书限制 5QPS，2 秒足够安全 */
const THROTTLE_INTERVAL_MS = 2000;
/** IM 卡片展示的最大 Sub-Agent 工具步骤数，避免卡片过长 */
const MAX_VISIBLE_SA_STEPS = 10;

// ============================================================================
// 类型定义
// ============================================================================

/** 思维链步骤摘要 */
interface ThinkingStepSummary {
  /** 步骤编号 */
  stepNumber: number;
  /** 当前阶段：分析/规划/决策 */
  phase: string;
  /** 摘要文本 */
  summary: string;
  /** 是否已完成 */
  isCompleted: boolean;
}

/** Sub-Agent 执行步骤记录（用于飞书卡片步骤列表展示） */
interface SubAgentStepRecord {
  /** 步骤序号 */
  step: number;
  /** 工具名称 */
  tool: string;
  /** 操作目标（文件名、命令、搜索词等） */
  target: string;
  /** 执行结果 */
  success?: boolean;
}

/** 追踪器内部状态 */
interface TrackerState {
  /** 当前 FSM 状态 */
  fsmState: string;
  /** 思维链步骤列表 */
  thinkingSteps: ThinkingStepSummary[];
  /** Sub-Agent 当前状态文本 */
  subAgentStatus: string | null;
  /** Sub-Agent 原始观测事件，用于复用 UI 的 upsert 规则去重 */
  subAgentObservations: SubAgentObservationEvent[];
  /** Sub-Agent 执行步骤累积列表 */
  subAgentSteps: SubAgentStepRecord[];
  /** 迭代信息 */
  iterationInfo: string | null;
  /** 是否有未推送的更新 */
  dirty: boolean;
  /** 任务开始时间 */
  startTime: number;
}

// ============================================================================
// ImProgressTracker 实现
// ============================================================================

export class ImProgressTracker {
  private readonly channel: ImChannel;
  private readonly task: ImTask;
  private readonly agentName: string;

  /** 内部追踪状态 */
  private state: TrackerState;

  /** 节流定时器 */
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  /** 是否已终态（complete/error/cancel） */
  private finalized = false;

  /** 卡片更新串行队列，避免终态卡片被较早发出的进度更新反向覆盖 */
  private updateChain: Promise<void> = Promise.resolve();

  /** Last thinking phase rendered to the IM card, used to coalesce streaming snapshots. */
  private lastThinkingPhase: string | null = null;

  constructor(channel: ImChannel, task: ImTask, agentName: string) {
    this.channel = channel;
    this.task = task;
    this.agentName = agentName;

    this.state = {
      fsmState: 'IDLE',
      thinkingSteps: [],
      subAgentStatus: null,
      subAgentObservations: [],
      subAgentSteps: [],
      iterationInfo: null,
      dirty: false,
      startTime: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 公开方法：发送初始/终态卡片
  // ═══════════════════════════════════════════════════════════════

  /**
   * 发送初始等待卡片
   *
   * 在任务创建后立即调用，显示"正在准备..."状态
   */
  async sendPendingCard(): Promise<void> {
    try {
      const card = buildPendingCard(this.agentName);
      const messageId = await this.channel.sendCard(this.task.sourceMessage.chatId, card);
      this.task.progressCardMessageId = messageId;
      logger.info(`已发送初始等待卡片, messageId=${messageId}`);
    } catch (error) {
      logger.error('发送初始卡片失败', { error });
    }
  }

  private findLastThinkingStepIndexByPhase(phase: string): number {
    for (let index = this.state.thinkingSteps.length - 1; index >= 0; index--) {
      if (this.state.thinkingSteps[index]?.phase === phase) {
        return index;
      }
    }
    return -1;
  }

  /**
   * 任务完成时发送结果卡片
   *
   * @param result - 执行结果文本
   * @param iterationCount - 总迭代次数
   */
  async sendCompletionCard(result: string, iterationCount: number): Promise<void> {
    this.finalized = true;
    this.state.dirty = false;
    this.stopThrottle();

    const card = buildCompletionCard({
      agentName: this.agentName,
      result: this.truncateForCard(result),
      duration: Date.now() - this.state.startTime,
      iterationCount,
    });

    await this.updateOrSendCard(card, { terminal: true });
  }

  /**
   * 任务失败时发送错误卡片
   *
   * @param error - 错误信息
   */
  async sendErrorCard(error: string): Promise<void> {
    this.finalized = true;
    this.state.dirty = false;
    this.stopThrottle();

    const card = buildErrorCard({
      agentName: this.agentName,
      error,
      taskId: this.task.id,
    });

    await this.updateOrSendCard(card, { terminal: true });
  }

  // ═══════════════════════════════════════════════════════════════
  // 公开方法：接收 AgentLoop 回调事件
  // ═══════════════════════════════════════════════════════════════

  /**
   * FSM 状态变化
   */
  handleStateChange(from: string, to: string): void {
    if (this.finalized) return;

    this.state.fsmState = to;
    this.state.dirty = true;
    this.scheduleThrottledUpdate();

    logger.debug(`FSM 状态变化: ${from} → ${to}`);
  }

  /**
   * 思维链阶段事件
   *
   * 对应 onThinkingPhase 回调，包含三阶段：analyzing → planning → decided
   */
  handleThinkingPhase(event: { phase: string; content: string; stepNumber?: number }): void {
    if (this.finalized) return;

    const explicitStepNumber = event.stepNumber;
    const isSameStreamingPhase = !explicitStepNumber && this.lastThinkingPhase === event.phase;

    // 查找是否已有同编号步骤
    const existingIndex = explicitStepNumber
      ? this.state.thinkingSteps.findIndex((s) => s.stepNumber === explicitStepNumber)
      : isSameStreamingPhase
        ? this.findLastThinkingStepIndexByPhase(event.phase)
        : -1;
    const existingStep = existingIndex >= 0 ? this.state.thinkingSteps[existingIndex] : undefined;
    const stepNumber = existingStep ? existingStep.stepNumber : this.state.thinkingSteps.length + 1;

    const stepSummary: ThinkingStepSummary = {
      stepNumber,
      phase: event.phase,
      summary: this.truncateLine(event.content, 60),
      isCompleted: event.phase === 'decided',
    };

    if (existingIndex >= 0) {
      this.state.thinkingSteps[existingIndex] = stepSummary;
    } else {
      this.state.thinkingSteps.push(stepSummary);
    }

    this.lastThinkingPhase = event.phase;

    // 只保留最近 8 步，避免卡片过长
    const MAX_VISIBLE_STEPS = 8;
    if (this.state.thinkingSteps.length > MAX_VISIBLE_STEPS) {
      this.state.thinkingSteps = this.state.thinkingSteps.slice(-MAX_VISIBLE_STEPS);
    }

    this.state.dirty = true;
    this.scheduleThrottledUpdate();
  }

  /**
   * Sub-Agent 创建
   *
   * 每次 SA 创建时重置步骤列表，避免跨 SA 步骤混淆
   */
  handleSubAgentSpawn(role: string): void {
    if (this.finalized) return;

    this.state.subAgentStatus = translate('im.tracker.subAgentRunning', {
      role: this.truncateLine(role, 50),
    });
    // 重置步骤列表：每个 SA 生命周期独立追踪
    this.state.subAgentObservations = [];
    this.state.subAgentSteps = [];
    this.state.dirty = true;
    this.scheduleThrottledUpdate();
  }

  /**
   * Sub-Agent 完成
   */
  handleSubAgentComplete(): void {
    if (this.finalized) return;

    this.state.subAgentStatus = translate('im.tracker.subAgentCompleted');
    this.state.dirty = true;
    this.scheduleThrottledUpdate();
  }

  /**
   * Sub-Agent 失败
   */
  handleSubAgentFail(error: string): void {
    if (this.finalized) return;

    this.state.subAgentStatus = translate('im.tracker.subAgentFailed', {
      error: this.truncateLine(error, 40),
    });
    this.state.dirty = true;
    this.scheduleThrottledUpdate();
  }

  /**
   * Sub-Agent 实时观测
   *
   * 接收完整的 SubAgentObservationEvent，累积工具调用步骤用于卡片展示。
   * 同时更新 subAgentStatus 为当前步骤的简要描述。
   */
  handleSubAgentObservation(event: SubAgentObservationEvent): void {
    if (this.finalized) return;

    upsertSubAgentObservationEvent(this.state.subAgentObservations, event);
    this.state.subAgentSteps = this.buildSubAgentStepRecords();

    // 更新状态文本为当前步骤简要描述
    if (event.toolAction) {
      this.state.subAgentStatus = `🔧 ${event.toolAction.tool}: ${this.truncateLine(event.toolAction.target, 40)}`;
    } else if (event.thinking) {
      this.state.subAgentStatus = `👁️ ${this.truncateLine(event.thinking, 50)}`;
    }

    this.state.dirty = true;
    this.scheduleThrottledUpdate();
  }

  /**
   * 预算更新
   */
  handleBudgetUpdate(remaining: number, total: number): void {
    if (this.finalized) return;

    this.state.iterationInfo = `${total - remaining}/${total}`;
    this.state.dirty = true;
    // 预算更新不单独触发节流，和其他事件合并
  }

  /**
   * 销毁追踪器，清理定时器
   */
  destroy(): void {
    this.finalized = true;
    this.stopThrottle();
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部：节流更新机制
  // ═══════════════════════════════════════════════════════════════

  /** 调度节流更新 */
  private scheduleThrottledUpdate(): void {
    // 已有定时器在运行，等待合并
    if (this.throttleTimer) return;

    this.throttleTimer = setTimeout(() => {
      void (async () => {
        this.throttleTimer = null;
        if (this.state.dirty && !this.finalized) {
          await this.pushProgressUpdate();
        }
      })();
    }, THROTTLE_INTERVAL_MS);
  }

  /** 停止节流定时器 */
  private stopThrottle(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  /** 从已去重的 Sub-Agent observation 派生 IM 卡片展示步骤 */
  private buildSubAgentStepRecords(): SubAgentStepRecord[] {
    const toolSteps: SubAgentStepRecord[] = [];

    for (const observation of this.state.subAgentObservations) {
      if (!observation.toolAction) continue;

      toolSteps.push({
        step: observation.step ?? toolSteps.length + 1,
        tool: observation.toolAction.tool,
        target: this.truncateLine(observation.toolAction.target, 40),
        success: observation.toolAction.success,
      });
    }

    return toolSteps.slice(-MAX_VISIBLE_SA_STEPS);
  }

  /** 推送进度更新到 IM */
  private async pushProgressUpdate(): Promise<void> {
    this.state.dirty = false;

    const card = buildProgressCard({
      taskId: this.task.id,
      agentName: this.agentName,
      fsmState: this.state.fsmState,
      thinkingSteps: this.state.thinkingSteps.map((s) => {
        const phaseLabel = this.getPhaseLabel(s.phase);
        return `${phaseLabel} ${s.summary}`;
      }),
      subAgentStatus: this.state.subAgentStatus ?? undefined,
      subAgentSteps: this.state.subAgentSteps.length > 0 ? this.state.subAgentSteps : undefined,
      iterationInfo: this.state.iterationInfo ?? undefined,
      showStopHint: false,
    });

    await this.updateOrSendCard(card);
  }

  /**
   * 更新已有卡片或发送新卡片
   *
   * 如果之前发送过进度卡片（有 progressCardMessageId），则更新；
   * 否则发送新卡片并保存 messageId。
   */
  private async updateOrSendCard(
    card: ImCardContent,
    options: { terminal?: boolean } = {}
  ): Promise<void> {
    const nextUpdate = this.updateChain.then(
      () => {
        if (this.finalized && !options.terminal) return Promise.resolve();
        return this.performUpdateOrSendCard(card);
      },
      () => {
        if (this.finalized && !options.terminal) return Promise.resolve();
        return this.performUpdateOrSendCard(card);
      }
    );
    this.updateChain = nextUpdate.catch(() => undefined);
    await nextUpdate;
  }

  private async performUpdateOrSendCard(card: ImCardContent): Promise<void> {
    try {
      if (this.task.progressCardMessageId) {
        const previousMessageId = this.task.progressCardMessageId;
        try {
          await this.channel.updateCard(previousMessageId, card, {
            chatId: this.task.sourceMessage.chatId,
            feishuCardUpdateToken: this.task.feishuCardUpdateToken,
          });
        } catch (updateError) {
          if (!this.finalized) {
            throw updateError;
          }
          logger.warn('终态 IM 卡片更新失败，尝试补发新卡片', { error: updateError });
          const fallbackMessageId = await this.channel.sendCard(
            this.task.sourceMessage.chatId,
            card
          );
          this.task.progressCardMessageId = fallbackMessageId;
          if (this.channel.deleteMessage) {
            await this.channel
              .deleteMessage(this.task.sourceMessage.chatId, previousMessageId)
              .catch((deleteError: unknown) => {
                logger.warn('删除旧 IM 进度卡片失败', { error: deleteError });
              });
          }
        }
      } else {
        const messageId = await this.channel.sendCard(this.task.sourceMessage.chatId, card);
        this.task.progressCardMessageId = messageId;
      }
    } catch (error) {
      // 卡片更新失败不应中断任务执行
      logger.error('更新 IM 进度卡片失败', { error });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部：文本工具
  // ═══════════════════════════════════════════════════════════════

  /** 阶段标签映射 */
  private getPhaseLabel(phase: string): string {
    const labels: Record<string, string> = {
      analyzing: translate('im.tracker.phaseAnalyzing'),
      planning: translate('im.tracker.phasePlanning'),
      decided: translate('im.tracker.phaseDecided'),
    };
    return labels[phase] ?? `🔹 ${phase}`;
  }

  /** 截断单行文本 */
  private truncateLine(text: string, maxLength: number): string {
    const firstLine = text.split('\n')[0] ?? text;
    if (firstLine.length <= maxLength) return firstLine;
    return firstLine.slice(0, maxLength - 3) + '...';
  }

  /** 截断卡片内容（飞书限制 30KB） */
  private truncateForCard(text: string, maxLength = 2000): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 20) + `\n\n${translate('im.tracker.truncatedContent')}`;
  }
}
