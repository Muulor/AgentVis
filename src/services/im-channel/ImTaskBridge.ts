/**
 * ImTaskBridge - IM→Agent 任务桥接器（多 Bot 版本）
 *
 * 核心变更（相对旧单 Bot 版本）：
 * - 全局单例 activeTask/activeTracker → per-botId Map，允许多 Bot 并行运行
 * - initializeImTaskBridge 接收 botId 参数，为每个 Bot 独立注册监听器
 * - Tauri 事件 payload 携带 botId，任务完成/失败时精确路由到对应的追踪器
 * - 停止指令仅终止发送此消息的机器人的当前任务，不影响其他 Bot
 *
 * 核心流程（每个 Bot 独立执行）：
 * 1. 接收 ImIncomingMessage
 * 2. 路由到目标 Agent（BotConfig.agentId）
 * 3. 发送初始进度卡片
 * 4. 切换 chatStore 模式 + 切换当前 Agent + 发射事件
 * 5. 挂载 AgentLoopCallbacks → ImProgressTracker 节流更新卡片
 * 6. 任务完成/失败时发送终态卡片
 */

import { v4 as uuidv4 } from 'uuid';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type {
  ImChannel,
  ImIncomingMessage,
  ImTask,
  ImIncomingAttachment,
  ImTaskStatus,
} from './types';
import { ImProgressTracker } from './ImProgressTracker';
import { buildBusyCard } from './cardTemplates';
import { useChatStore } from '@stores/chatStore';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useImChannelStore } from '@stores/imChannelStore';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('ImTaskBridge');

// ============================================================================
// 消息去重（幂等保护）
// ============================================================================

/** 已处理的消息 ID 集合（全局，跨 Bot 防止重复触发） */
const processedMessageIds = new Set<string>();
/** 去重集合最大容量，超出时淘汰最早记录防止内存泄漏 */
const MAX_PROCESSED_IDS = 200;

/** 停止指令关键词（用户发送这些文本时视为终止当前任务） */
const STOP_COMMANDS = ['/stop', 'stop', 'terminate', 'cancel', '停止', '终止', '取消'];

const ABORT_FINALIZE_FALLBACK_MS = 15_000;
const FEISHU_ABORT_CARD_UPDATE_DELAY_MS = 4_000;
const abortFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 检测消息内容是否为停止指令
 *
 * 匹配规则：内容 trim 后完全匹配任一关键词（不区分大小写）
 */
function isStopCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return STOP_COMMANDS.some((cmd) => trimmed === cmd);
}

/** 幂等记录消息 ID */
function recordProcessedMessage(messageId: string): void {
  processedMessageIds.add(messageId);
  // FIFO 淘汰，防止内存泄漏
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const firstId = processedMessageIds.values().next().value;
    if (firstId) processedMessageIds.delete(firstId);
  }
}

// ============================================================================
// per-Bot 运行时状态（任务 + 追踪器 Map）
// ============================================================================

/**
 * per-botId 活跃任务记录
 *
 * key = botId，支持多 Bot 同时各自持有一个活跃任务。
 * 每个 Bot 独立忙碌检测，不会互相阻塞。
 */
const activeTasks = new Map<string, ImTask>();

/**
 * per-botId 进度追踪器
 *
 * key = botId，与 activeTasks 一一对应。
 */
const activeTrackers = new Map<string, ImProgressTracker>();

function getAbortFinalizeKey(botId: string, taskId: string): string {
  return `${botId}:${taskId}`;
}

function getFeishuCardUpdateToken(value?: Record<string, string>): string | undefined {
  const token = value?.feishu_card_update_token ?? value?.callback_token ?? value?.token;
  return token?.trim() ? token : undefined;
}

function getCancelledCardUpdateDelay(task: ImTask): number {
  return task.sourceMessage.platform === 'feishu' ? FEISHU_ABORT_CARD_UPDATE_DELAY_MS : 0;
}

function scheduleCancelledTaskFinalization(
  botId: string,
  taskId: string,
  error: string,
  delayMs: number
): void {
  const key = getAbortFinalizeKey(botId, taskId);
  if (abortFinalizeTimers.has(key)) return;

  const timer = setTimeout(
    () => {
      abortFinalizeTimers.delete(key);
      void finalizeCancelledTask(botId, taskId, error);
    },
    Math.max(0, delayMs)
  );
  abortFinalizeTimers.set(key, timer);
}

async function finalizeCancelledTask(botId: string, taskId: string, error: string): Promise<void> {
  const task = activeTasks.get(botId);
  if (task?.id !== taskId || task.status !== 'cancelled') return;

  task.error = task.error ?? error;
  task.completedAt = Date.now();

  const tracker = activeTrackers.get(botId);
  if (tracker) {
    try {
      await tracker.sendErrorCard(task.error);
    } catch (sendError) {
      logger.warn('发送 IM 终止卡片失败', { botId, taskId, error: sendError });
    }
  }

  const store = useImChannelStore.getState();
  store.setBotActiveTask(botId, task);
  store.incrementBotTaskCount(botId);
  cleanupBotTask(botId);
}

function isTerminalTaskStatus(status: ImTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTaskAcceptingProgress(task: ImTask | null | undefined): task is ImTask {
  return !!task && !isTerminalTaskStatus(task.status);
}

function isCurrentNonTerminalTask(botId: string, taskId: string): boolean {
  const task = activeTasks.get(botId);
  return task?.id === taskId && !isTerminalTaskStatus(task.status);
}

/**
 * 判断一个 IM 任务是否仍允许被 AgentChatView 接手启动。
 *
 * 卡片按钮可能在 Planning 事件真正被 AgentChatView 接手前触发取消；
 * 这里作为第二道栅栏，避免已取消的排队事件继续启动 AgentLoop。
 */
export function shouldStartImTask(botId?: string, taskId?: string): boolean {
  if (!botId || !taskId) return true;
  return isCurrentNonTerminalTask(botId, taskId);
}

/**
 * 标记 IM 任务已被 AgentChatView/usePlanningMode 真正接手。
 *
 * IM Bridge 发射 `cron:execute_planning` 后，事件可能因为监听器尚未注册、
 * 目标 Agent 仍在渲染或发送态防护而没有进入 AgentLoop。只有接手端调用此函数后，
 * 任务才从 pending 进入 running；否则 pending 兜底超时会清理任务，避免卡死忙碌态。
 */
export function markImTaskStarted(botId?: string, taskId?: string): boolean {
  if (!botId || !taskId) return false;

  const task = activeTasks.get(botId);
  if (task?.id !== taskId || isTerminalTaskStatus(task.status)) {
    return false;
  }

  if (task.status !== 'running') {
    task.status = 'running';
    useImChannelStore.getState().setBotActiveTask(botId, task);
    logger.trace(`IM 任务已被 Agent 接手: botId=${botId}, taskId=${taskId}`);
  }

  return true;
}

/**
 * 清理指定 Bot 的桥接运行态。
 *
 * 手动断开/销毁机器人连接时调用，避免 module-scope activeTasks 在重连后继续把
 * 新消息误判为“任务执行中”。真正的 AgentLoop 若仍在运行，会由 chatStore 的
 * sendingContexts 继续负责桌面端忙碌判断。
 */
export function clearImBotTaskState(botId: string): void {
  cleanupBotTask(botId);
}

/**
 * 获取指定 Bot 的当前活跃 IM 进度追踪器
 *
 * 供 usePlanningMode 在构造 ProcessMessageOptions 时调用，
 * 将 AgentLoopCallbacks 事件转发到对应 Bot 的飞书卡片。
 *
 * @param botId - Bot 唯一标识
 */
export function getActiveImTracker(botId?: string): ImProgressTracker | null {
  if (botId) {
    const task = activeTasks.get(botId);
    if (!isTaskAcceptingProgress(task)) return null;
    return activeTrackers.get(botId) ?? null;
  }
  // 向后兼容：不传 botId 时返回第一个仍允许接收进度的追踪器（单 Bot 场景）
  for (const [candidateBotId, task] of activeTasks.entries()) {
    if (isTaskAcceptingProgress(task)) {
      return activeTrackers.get(candidateBotId) ?? null;
    }
  }
  return null;
}

/**
 * 获取指定 Bot 的当前活跃任务
 *
 * @param botId - Bot 唯一标识
 */
export function getActiveImTask(botId?: string): ImTask | null {
  if (botId) {
    return activeTasks.get(botId) ?? null;
  }
  // 向后兼容：不传 botId 时，仅在只有一个活跃任务时才返回（单 Bot 场景）
  // 若有多个 Bot 并发运行，拒绝返回以避免错误路由 IM 完成事件到错误 Bot
  if (activeTasks.size !== 1) return null;
  const first = activeTasks.values().next();
  return first.done ? null : first.value;
}

// ============================================================================
// 全局完成事件监听（只注册一次）
// ============================================================================

let completionListenerInitialized = false;

/**
 * 注册全局 Planning 任务完成/失败事件监听
 *
 * 利用 payload 中的 botId 精确路由到对应追踪器，
 * 避免跨 Bot 的任务状态污染。
 * 只注册一次，避免多 Bot 连续初始化时重复绑定。
 */
function ensureCompletionListenerInitialized(): void {
  if (completionListenerInitialized) return;
  completionListenerInitialized = true;

  // 监听任务完成事件
  listen<{ taskId: string; result: string; iterationCount: number; botId?: string }>(
    'im:task_completed',
    (event) => {
      const { taskId, result, iterationCount, botId } = event.payload;
      void handleTaskCompleted(taskId, result, iterationCount, botId).catch((error: unknown) => {
        logger.error('处理 im:task_completed 事件失败', { error });
      });
    }
  ).catch((error: unknown) => {
    logger.error('监听 im:task_completed 事件失败', { error });
  });

  // 监听任务失败事件
  listen<{ taskId: string; error: string; botId?: string }>('im:task_failed', (event) => {
    const { taskId, error, botId } = event.payload;
    void handleTaskFailed(taskId, error, botId).catch((handlerError: unknown) => {
      logger.error('处理 im:task_failed 事件失败', { error: handlerError });
    });
  }).catch((error: unknown) => {
    logger.error('监听 im:task_failed 事件失败', { error });
  });
}

/** 处理任务完成（按 botId 路由） */
async function handleTaskCompleted(
  taskId: string,
  result: string,
  iterationCount: number,
  botId?: string
): Promise<void> {
  // 精确匹配：botId 已知时直接查找
  const task = botId ? activeTasks.get(botId) : findTaskById(taskId);
  const tracker = botId ? activeTrackers.get(botId) : findTrackerByTaskId(taskId);
  const resolvedBotId = botId ?? findBotIdByTaskId(taskId);

  if (task?.id !== taskId) return;

  if (isTerminalTaskStatus(task.status)) {
    logger.trace(
      `忽略已终态 IM 任务的完成事件: taskId=${taskId}, botId=${resolvedBotId ?? 'legacy'}, status=${task.status}`
    );
    return;
  }

  logger.trace(`IM 任务完成: taskId=${taskId}, botId=${resolvedBotId ?? 'legacy'}`);
  task.status = 'completed';
  task.completedAt = Date.now();

  if (tracker) {
    await tracker.sendCompletionCard(result, iterationCount);
  }

  const store = useImChannelStore.getState();
  if (resolvedBotId) {
    store.setBotActiveTask(resolvedBotId, task);
    store.incrementBotTaskCount(resolvedBotId);
  }

  if (resolvedBotId) cleanupBotTask(resolvedBotId);
}

/** 处理任务失败（按 botId 路由） */
async function handleTaskFailed(taskId: string, error: string, botId?: string): Promise<void> {
  const task = botId ? activeTasks.get(botId) : findTaskById(taskId);
  const tracker = botId ? activeTrackers.get(botId) : findTrackerByTaskId(taskId);
  const resolvedBotId = botId ?? findBotIdByTaskId(taskId);

  if (task?.id !== taskId) return;

  if (task.status === 'completed' || task.status === 'failed') {
    logger.trace(
      `忽略已终态 IM 任务的失败事件: taskId=${taskId}, botId=${resolvedBotId ?? 'legacy'}, status=${task.status}`
    );
    return;
  }

  if (task.status === 'cancelled') {
    logger.trace(
      `IM 任务取消已被 AgentLoop 确认: taskId=${taskId}, botId=${resolvedBotId ?? 'legacy'}`
    );
    task.error = task.error ?? error;
    if (resolvedBotId) {
      scheduleCancelledTaskFinalization(
        resolvedBotId,
        taskId,
        task.error,
        getCancelledCardUpdateDelay(task)
      );
    }
    return;
  }

  logger.trace(`IM 任务失败: taskId=${taskId}, botId=${resolvedBotId ?? 'legacy'}`);
  task.status = 'failed';
  task.error = error;
  task.completedAt = Date.now();

  if (tracker) {
    await tracker.sendErrorCard(error);
  }

  const store = useImChannelStore.getState();
  if (resolvedBotId) {
    store.setBotActiveTask(resolvedBotId, task);
    store.incrementBotTaskCount(resolvedBotId);
    cleanupBotTask(resolvedBotId);
  }
}

// ============================================================================
// 公开初始化接口
// ============================================================================

/**
 * 为指定 Bot 初始化 IM 任务桥接
 *
 * 在对应 Bot 的 Channel 连接成功后调用，注册消息和卡片按钮回调。
 * 多次调用同一 botId 是安全的（监听器不会重复注册，因为 Channel 实例独立）。
 *
 * @param botId - Bot 唯一标识
 * @param channel - 已连接的 IM Channel 实例
 */
export function initializeImTaskBridge(botId: string, channel: ImChannel): void {
  // 保证完成事件监听只注册一次
  ensureCompletionListenerInitialized();

  // 注册消息接收处理器
  channel.onMessage((msg) => {
    handleIncomingMessage(botId, channel, msg).catch((error: unknown) => {
      logger.error('处理 IM 消息时出错', { botId, error });
    });
  });

  // 注册卡片按钮回调（终止任务 / 删除消息）
  channel.onCardAction((actionId, value) => {
    if (actionId === 'abort_task') {
      const taskId = value.task_id;
      if (taskId) {
        handleAbortTask(botId, taskId, value).catch((error: unknown) => {
          logger.error('处理终止任务时出错', { botId, error });
        });
      }
      return;
    }

    if (actionId === 'delete_message') {
      const chatId = value.channel ?? value.open_chat_id ?? '';
      const controlMessageId = value.message_ts ?? value.open_message_id;
      const targetMessageId = value.message_id ?? controlMessageId;
      if (targetMessageId && channel.deleteMessage) {
        void (async () => {
          try {
            await channel.deleteMessage?.(chatId, targetMessageId);
            if (controlMessageId && controlMessageId !== targetMessageId) {
              await channel.deleteMessage?.(chatId, controlMessageId);
            }
          } catch (error) {
            logger.error('删除 IM 消息失败', {
              botId,
              chatId,
              messageId: targetMessageId,
              controlMessageId,
              error,
            });
          }
        })();
      }
      return;
    }

    if (actionId === 'delete_file') {
      const chatId = value.channel;
      const messageId = value.message_ts;
      const fileId = value.file_id;
      if (fileId && channel.deleteFile) {
        channel
          .deleteFile(fileId)
          .then(() => {
            if (chatId && messageId && channel.deleteMessage) {
              return channel.deleteMessage(chatId, messageId);
            }
            return undefined;
          })
          .catch((error: unknown) => {
            logger.error('删除 Slack 文件失败', { botId, chatId, messageId, fileId, error });
          });
      }
    }
  });

  logger.trace(`Bot ${botId} 的 IM 任务桥接已初始化`);
}

// ============================================================================
// 核心消息处理
// ============================================================================

/**
 * 处理 IM 收到的消息
 *
 * 每个 Bot 独立处理自己的消息，互不干扰。
 * 忙碌检测、停止指令、路由均在 per-botId 维度执行。
 *
 * @param botId - 收到消息的 Bot 标识
 * @param channel - 该 Bot 的 IM Channel
 * @param msg - 收到的消息
 */
async function handleIncomingMessage(
  botId: string,
  channel: ImChannel,
  msg: ImIncomingMessage
): Promise<void> {
  logger.info(
    `收到 IM 消息: botId=${botId} [${msg.platform}] ${msg.senderName || msg.senderId}: ${msg.content.slice(0, 100)}`
  );

  // 幂等去重：同一条消息不重复处理（跨 Bot 全局去重）
  if (msg.messageId && processedMessageIds.has(msg.messageId)) {
    logger.warn('消息已处理过，跳过重复执行', { messageId: msg.messageId });
    return;
  }

  // 立即记录，确保所有后续路径（停止指令、忙碌拒绝等）都不重入
  if (msg.messageId) {
    recordProcessedMessage(msg.messageId);
  }

  // 消息内容为空且没有附件则忽略；Slack 删除/同步类事件偶尔会表现为空消息。
  if (!msg.content.trim() && !msg.attachments?.length) {
    return;
  }

  const activeTask = activeTasks.get(botId) ?? null;

  // 停止指令检测：只终止当前 Bot 的任务，其他 Bot 不受影响
  if (activeTask && isStopCommand(msg.content)) {
    logger.trace(`收到 IM 停止指令: botId=${botId}, taskId=${activeTask.id}`);
    await handleAbortTask(botId, activeTask.id);
    await channel.sendText(msg.chatId, translate('im.bridge.taskStopped'));
    return;
  }

  if (!activeTask && isStopCommand(msg.content)) {
    await channel.sendText(msg.chatId, translate('im.bridge.noActiveTaskToStop'));
    return;
  }

  // 如果该 Bot 已有活跃任务，提示忙碌（其他 Bot 不受影响，可正常服务）
  if (activeTask) {
    await channel.sendCard(
      msg.chatId,
      buildBusyCard(
        translate(
          channel.platform === 'slack' || channel.platform === 'feishu'
            ? 'im.bridge.busySlack'
            : 'im.bridge.busy'
        )
      )
    );
    return;
  }

  // 路由到目标 Agent（使用该 Bot 专属的 agentId）
  const agentId = resolveTargetAgent(botId);
  await persistLastChatInfo(msg, botId, agentId).catch((err: unknown) => {
    logger.warn('写入最近 IM 会话文件失败', { error: String(err) });
  });

  if (!agentId) {
    await channel.sendText(msg.chatId, translate('im.bridge.noAgent'));
    return;
  }

  // 如果桌面端目标 Agent 已在运行，但 IM 侧没有活跃任务（例如用户手动断开重连后），
  // 直接返回忙碌卡片，不创建新的 IM activeTask，避免再次进入“未接手但占用队列”状态。
  if (useChatStore.getState().isSendingFor(agentId)) {
    await channel.sendCard(
      msg.chatId,
      buildBusyCard(
        translate(
          channel.platform === 'slack' || channel.platform === 'feishu'
            ? 'im.bridge.busySlack'
            : 'im.bridge.busy'
        )
      )
    );
    return;
  }

  // 创建任务记录
  const task: ImTask = {
    id: uuidv4(),
    sourceMessage: msg,
    agentId,
    status: 'pending',
    createdAt: Date.now(),
  };

  // 获取 Agent 名称
  const agentName = getAgentName(agentId);

  // 创建该 Bot 的进度追踪器
  const tracker = new ImProgressTracker(channel, task, agentName);
  activeTasks.set(botId, task);
  activeTrackers.set(botId, tracker);

  // 更新 Store 状态
  const store = useImChannelStore.getState();
  store.setBotActiveTask(botId, task);

  try {
    // 发送初始等待卡片
    await tracker.sendPendingCard();

    // 若消息携带附件，下载到本地并生成增强 prompt
    const enhancedPrompt = await buildEnhancedPrompt(channel, msg);

    // 将活跃任务信息写入临时文件（IM 发送工具回退到当前会话时会读取此文件）
    await persistActiveTaskInfo(task, botId).catch((err: unknown) => {
      logger.warn('写入活跃任务文件失败', { error: String(err) });
    });

    // 触发 Planning 模式执行（携带 botId 用于完成事件路由）
    await triggerPlanningExecution(botId, task, enhancedPrompt);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('触发 IM 任务失败', { botId, error: errorMessage });

    task.status = 'failed';
    task.error = errorMessage;
    store.setBotActiveTask(botId, task);

    await tracker.sendErrorCard(errorMessage);
    cleanupBotTask(botId);
  }
}

// ============================================================================
// Planning 模式触发
// ============================================================================

/**
 * 触发 Planning 模式执行
 *
 * 复用 CronExecutor 的事件触发链，事件 payload 携带 botId 供完成事件路由。
 *
 * @param botId - Bot 唯一标识（携带在事件 payload 中）
 * @param task - 当前任务
 * @param enhancedPrompt - 经过附件增强的 prompt
 */
async function triggerPlanningExecution(
  botId: string,
  task: ImTask,
  enhancedPrompt: string
): Promise<void> {
  logger.trace(`通过事件机制触发 Planning 执行: botId=${botId}, agentId=${task.agentId}`);

  // 设置模式为 planning
  const { setModeFor } = useChatStore.getState();
  setModeFor(task.agentId, 'planning');

  // ─── 跨 Hub Agent 导航 ───────────────────────────────────────────
  //
  // 1. 先从内存中找 hubId（快速路径）
  // 2. 内存找不到时，直接从 Rust 后端 agent_get 查询（权威路径）
  // 3. 切换 hub → 等待 useDataLoader 将目标 hub 的 agents 加载到内存
  // 4. 等待确认目标 agent 已在 agents 数组中 → 再切换 agent
  // 5. 再等待 AgentChatView listener 重注册 → 最后发射事件

  const { setCurrentAgentId } = useAgentStore.getState();
  const { setCurrentHubId, currentHubId } = useHubStore.getState();

  // 第一步：确定目标 agent 的 hubId
  let targetHubId: string | null = null;
  const cachedAgent = useAgentStore.getState().agents.find((a) => a.id === task.agentId);
  if (cachedAgent?.hubId) {
    // 命中内存缓存（同 Hub 场景）
    targetHubId = cachedAgent.hubId;
    logger.trace(`IM 任务: 内存命中 agent hubId=${targetHubId}`);
  } else {
    // 跨 Hub 场景：内存中没有目标 agent，从后端权威查询
    logger.trace(`IM 任务: 内存未命中 agentId=${task.agentId}，从后端查询 hubId`);
    try {
      const agentFromDb = await invoke<{ id: string; hubId: string } | null>('agent_get', {
        id: task.agentId,
      });
      if (agentFromDb?.hubId) {
        targetHubId = agentFromDb.hubId;
        logger.trace(`IM 任务: 后端返回 agent hubId=${targetHubId}`);
      }
    } catch (err) {
      logger.error(`IM 任务: 查询 agent_get 失败, agentId=${task.agentId}`, { error: String(err) });
    }
  }

  // 第二步：若目标 hub 与当前 hub 不同，先切换 hub 并等待 agents 加载完成
  if (targetHubId && targetHubId !== currentHubId) {
    logger.trace(
      `IM 任务跨 Hub 导航: ${currentHubId ?? 'none'} → ${targetHubId}, agentId=${task.agentId}`
    );
    setCurrentHubId(targetHubId);

    // 等待 useDataLoader 将目标 Hub 的 agents 加载到 agentStore
    // useDataLoader 监听 currentHubId 变化后，发起 agent_list_by_hub 请求并 setAgents
    // 这里轮询等待目标 agent 出现在内存中，最多等 3 秒防止死等
    const TARGET_HUB_LOAD_TIMEOUT_MS = 3000;
    const POLL_INTERVAL_MS = 50;
    const pollStart = Date.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        const agentLoaded = useAgentStore.getState().agents.some((a) => a.id === task.agentId);
        if (agentLoaded) {
          logger.trace(`IM 任务: 目标 agent 已加载到内存, agentId=${task.agentId}`);
          resolve();
        } else if (Date.now() - pollStart > TARGET_HUB_LOAD_TIMEOUT_MS) {
          // 超时仍未找到：继续执行（下游会显示"请选择一个 Agent"，任务也会超时清理）
          logger.warn(`IM 任务: 等待 Hub agents 加载超时, agentId=${task.agentId}`);
          resolve();
        } else {
          setTimeout(check, POLL_INTERVAL_MS);
        }
      };
      check();
    });
  } else if (!targetHubId) {
    logger.warn(`IM 任务: 无法确定 agentId=${task.agentId} 所属 Hub，直接尝试导航`);
  }

  // 第三步：切换到目标 Agent
  setCurrentAgentId(task.agentId);

  // 第四步：等待 AgentChatView 重渲染并完成 cron:execute_planning 监听器重注册
  const LISTENER_REREGISTER_DELAY_MS = 800;
  await new Promise((resolve) => setTimeout(resolve, LISTENER_REREGISTER_DELAY_MS));

  if (!shouldStartImTask(botId, task.id)) {
    logger.trace(`IM 任务已取消或结束，跳过 Planning 事件发射: botId=${botId}, taskId=${task.id}`);
    return;
  }

  // 第五步：发射事件，payload 携带 botId 用于完成事件精确路由
  await emit('cron:execute_planning', {
    agentId: task.agentId,
    prompt: enhancedPrompt,
    cronJobId: task.id,
    cronJobName: `IM: ${task.sourceMessage.content.slice(0, 30)}`,
    source: 'im',
    imTaskId: task.id,
    imPlatform: task.sourceMessage.platform,
    botId, // 供 usePlanningMode 在发射完成事件时回传
  });

  logger.trace('Planning 执行事件已发射');

  // 超时保护：10 秒内未被 AgentChatView 接手则强制清理
  const PENDING_TIMEOUT_MS = 10_000;
  const taskId = task.id;

  setTimeout(() => {
    const currentTask = activeTasks.get(botId);
    if (currentTask?.id === taskId && currentTask.status === 'pending') {
      logger.warn(`IM 任务超时未被接手，强制清理: botId=${botId}, taskId=${taskId}`);
      currentTask.status = 'failed';
      currentTask.error = translate('im.bridge.timeoutTaskError');
      currentTask.completedAt = Date.now();

      const tracker = activeTrackers.get(botId);
      if (tracker) {
        tracker
          .sendErrorCard(translate('im.bridge.timeoutCardError'))
          .catch((err: unknown) => logger.error('发送超时错误卡片失败', { error: err }));
      }

      const store = useImChannelStore.getState();
      store.setBotActiveTask(botId, currentTask);
      store.incrementBotTaskCount(botId);
      cleanupBotTask(botId);
    }
  }, PENDING_TIMEOUT_MS);
}

// ============================================================================
// 任务终止
// ============================================================================

/**
 * 处理终止任务请求（来自卡片按钮或停止指令）
 *
 * 只终止指定 botId 的任务，不影响其他 Bot。
 *
 * @param botId - 发出终止请求的 Bot
 * @param taskId - 要终止的任务 ID
 */
async function handleAbortTask(
  botId: string,
  taskId: string,
  value?: Record<string, string>
): Promise<void> {
  const activeTask = activeTasks.get(botId);
  if (activeTask?.id !== taskId) {
    logger.trace(`忽略过期的 IM 终止请求: botId=${botId}, taskId=${taskId}`);
    return;
  }

  if (activeTask.status === 'cancelled') {
    logger.trace(`忽略重复的 IM 终止请求: botId=${botId}, taskId=${taskId}`);
    return;
  }

  logger.trace(`收到 IM 终止请求: botId=${botId}, taskId=${taskId}`);

  // 先落取消态，再通知 UI/AgentLoop。这样即使取消发生在 Planning 事件排队期间，
  // 后续启动和进度回调也会被取消态栅栏挡住。
  activeTask.status = 'cancelled';
  activeTask.error = translate('im.bridge.abortedByUser');
  activeTask.feishuCardUpdateToken =
    getFeishuCardUpdateToken(value) ?? activeTask.feishuCardUpdateToken;

  const store = useImChannelStore.getState();
  store.setBotActiveTask(botId, activeTask);

  scheduleCancelledTaskFinalization(
    botId,
    taskId,
    activeTask.error,
    getCancelledCardUpdateDelay(activeTask)
  );
  // 发射取消事件（usePlanningMode 监听）
  await emit('im:abort_task', { taskId, botId });

  setTimeout(() => {
    const pendingAbortTask = activeTasks.get(botId);
    if (pendingAbortTask?.id !== taskId || pendingAbortTask.status !== 'cancelled') {
      return;
    }

    pendingAbortTask.completedAt = Date.now();
    const tracker = activeTrackers.get(botId);
    const finalizeCard = tracker
      ? tracker.sendErrorCard(translate('im.bridge.abortedByUser')).catch((error: unknown) => {
          logger.warn('发送 IM 终止兜底卡片失败', { botId, taskId, error });
        })
      : Promise.resolve();

    void finalizeCard.finally(() => {
      store.setBotActiveTask(botId, pendingAbortTask);
      store.incrementBotTaskCount(botId);
      cleanupBotTask(botId);
    });
  }, ABORT_FINALIZE_FALLBACK_MS);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构建增强的 Agent Prompt
 *
 * 若消息携带附件（图片/文件），此函数负责：
 * 1. 通过当前 IM Channel 下载附件
 * 2. 通过 im_save_attachment 将内容写入 Agent 工作目录
 * 3. 在原始 prompt 后追加附件路径描述
 *
 * 这使 Agent 能通过 `read` 工具读取用户上传的文件内容。
 */
async function buildEnhancedPrompt(channel: ImChannel, msg: ImIncomingMessage): Promise<string> {
  const attachments: ImIncomingAttachment[] = msg.attachments ?? [];
  if (attachments.length === 0) {
    return msg.content;
  }

  const savedPaths: string[] = [];

  for (const attachment of attachments) {
    try {
      const { base64, mimeType } = await channel.downloadResource(
        attachment.messageId,
        attachment.fileKey,
        attachment.resourceType
      );

      const timestamp = Date.now();
      const ext = inferExtFromMime(mimeType, attachment.fileName);
      const localFileName = attachment.fileName
        ? `${timestamp}_${sanitizeFileName(attachment.fileName)}`
        : `${timestamp}_attachment.${ext}`;

      const savedPath = await invoke<string>('im_save_attachment', {
        base64Content: base64,
        fileName: localFileName,
      });

      savedPaths.push(savedPath);
      logger.trace(`附件已保存到本地: ${savedPath}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      void logger.error('下载附件失败', { fileKey: attachment.fileKey, error: errMsg });
    }
  }

  if (savedPaths.length === 0) {
    return msg.content + `\n\n${translate('im.bridge.attachmentDownloadFailedPrompt')}`;
  }

  const attachmentSection = [
    '',
    '',
    translate('im.bridge.attachmentSectionHeader', {
      platform: getPlatformDisplayName(msg.platform),
    }),
    ...savedPaths.map((p, i) =>
      translate('im.bridge.attachmentItem', {
        index: i + 1,
        path: p,
      })
    ),
  ].join('\n');

  const baseContent =
    msg.content ||
    translate('im.bridge.attachmentFileFallback', {
      platform: getPlatformDisplayName(msg.platform),
    });
  return baseContent + attachmentSection;
}

/**
 * 根据 MIME 类型推断文件扩展名
 */
function inferExtFromMime(mimeType: string, fallbackFileName?: string): string {
  if (fallbackFileName) {
    const parts = fallbackFileName.split('.');
    if (parts.length > 1) {
      const ext = parts[parts.length - 1];
      if (ext) return ext;
    }
  }
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/zip': 'zip',
    'video/mp4': 'mp4',
  };
  return mimeMap[mimeType] ?? 'bin';
}

/**
 * 净化文件名，去除不合法的路径字符
 */
function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/**
 * 将活跃 IM 任务信息持久化到 AppData/im_active_task_{botId}.json
 *
 * 每个 Bot 使用独立文件，避免多 Bot 同时完成任务时互相覆盖（写竞态）。
 * IM 原生发送工具可读取对应 botId 的文件获取当前会话。
 */
async function persistActiveTaskInfo(task: ImTask, botId: string): Promise<void> {
  const payload = JSON.stringify({
    taskId: task.id,
    chatId: task.sourceMessage.chatId,
    platform: task.sourceMessage.platform,
    startedAt: task.createdAt,
    agentId: task.agentId,
    botId,
  });

  // 每个 Bot 独立文件，防止多 Bot 并发完成时互覆盖
  await invoke<string>('im_write_app_data_file', {
    fileName: `im_active_task_${botId}.json`,
    content: payload,
  });
}

/**
 * 将最近一次可用 IM 会话持久化到 AppData/im_last_chat_{botId}.json。
 *
 * cron 等非 IM 触发任务没有活跃 incoming message，无法读取 im_active_task_{botId}.json。
 * 保存最近会话后，IM 原生发送工具可以在已知 botId 的情况下回退到此会话。
 */
async function persistLastChatInfo(
  msg: ImIncomingMessage,
  botId: string,
  agentId: string | null
): Promise<void> {
  const payload = JSON.stringify({
    chatId: msg.chatId,
    chatType: msg.chatType,
    platform: msg.platform,
    senderId: msg.senderId,
    botId,
    agentId,
    updatedAt: Date.now(),
  });

  await invoke<string>('im_write_app_data_file', {
    fileName: `im_last_chat_${botId}.json`,
    content: payload,
  });
}

/**
 * 解析目标 Agent ID
 *
 * 优先级：BotConfig 中配置的专属 agentId（每个 Bot 独立绑定）
 *
 * @param botId - Bot 唯一标识
 */
function resolveTargetAgent(botId: string): string | null {
  const { botConfigs } = useImChannelStore.getState();
  const botConfig = botConfigs.find((c) => c.botId === botId);
  return botConfig?.agentId ?? null;
}

/**
 * 获取 Agent 名称
 */
function getAgentName(agentId: string): string {
  const agents = useAgentStore.getState().agents;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? 'Agent';
}

/**
 * 清理指定 Bot 的活跃任务状态
 */
function cleanupBotTask(botId: string): void {
  const task = activeTasks.get(botId);
  if (task) {
    const finalizeKey = getAbortFinalizeKey(botId, task.id);
    const finalizeTimer = abortFinalizeTimers.get(finalizeKey);
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      abortFinalizeTimers.delete(finalizeKey);
    }
  }

  const tracker = activeTrackers.get(botId);
  if (tracker) {
    tracker.destroy();
    activeTrackers.delete(botId);
  }
  activeTasks.delete(botId);
  useImChannelStore.getState().setBotActiveTask(botId, null);

  // 删除活跃任务文件（任务已结束，文件不再有读取价值）
  // 改为删除而非覆写 ended 标记，避免每次飞书任务结束后在 AppData 根目录累积历史文件
  invoke('im_delete_app_data_file', {
    fileName: `im_active_task_${botId}.json`,
  }).catch((err: unknown) => {
    logger.trace('删除活跃任务文件失败', { error: String(err) });
  });
}

// ============================================================================
// 辅助：根据 taskId 反向查找（兼容无 botId 的旧事件 payload）
// ============================================================================

function findBotIdByTaskId(taskId: string): string | null {
  for (const [botId, task] of activeTasks.entries()) {
    if (task.id === taskId) return botId;
  }
  return null;
}

function findTaskById(taskId: string): ImTask | null {
  for (const task of activeTasks.values()) {
    if (task.id === taskId) return task;
  }
  return null;
}

function findTrackerByTaskId(taskId: string): ImProgressTracker | null {
  for (const [botId, task] of activeTasks.entries()) {
    if (task.id === taskId) return activeTrackers.get(botId) ?? null;
  }
  return null;
}

function getPlatformDisplayName(platform: ImIncomingMessage['platform']): string {
  const names: Record<ImIncomingMessage['platform'], string> = {
    feishu: 'Feishu',
    slack: 'Slack',
    dingtalk: 'DingTalk',
    telegram: 'Telegram',
  };
  return names[platform];
}
