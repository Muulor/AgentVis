/**
 * CronExecutor - 定时任务执行器
 *
 * 负责将定时任务的 prompt 发送给对应的 Agent 执行。
 * 执行方式：通过 Tauri Commands 调用 LLM 和消息持久化。
 *
 * 设计说明：
 * - 定时任务执行的消息会持久化到对应 Agent 的聊天历史，
 *   用户打开该 Agent 对话时可以看到执行结果。
 * - 执行时会在 user 消息 metadata 中标记 source: 'cron'，区分手动消息。
 */

import { invoke } from '@tauri-apps/api/core';
import type { CronJob, CronJobUpdateParams } from './types';
import { useChatStore } from '@stores/chatStore';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useImChannelStore } from '@stores/imChannelStore';
import { getLogger } from '@services/logger';

const logger = getLogger('CronExecutor');

/** 执行结果 */
interface CronExecutionResult {
  success: boolean;
  /** 如果失败，记录错误信息 */
  error?: string;
}

/**
 * 执行一个定时任务
 *
 * 通过事件机制触发 AgentChatView 的 Planning 流程执行
 *
 * @param job - 待执行的定时任务
 */
export async function executeCronJob(job: CronJob): Promise<CronExecutionResult> {
  logger.info(`开始执行定时任务: ${job.name} (${job.id})`);

  try {
    // 标记为运行中
    await updateJobRunStatus(job.id, 'running');

    // 统一使用 Planning 模式执行
    return await executePlanningMode(job);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`定时任务执行失败: ${job.name}`, { error: errorMessage });

    // 更新执行状态为失败
    try {
      await updateJobRunStatus(job.id, 'failed');
    } catch (updateError) {
      logger.error(`更新任务失败状态时也出错`, { error: updateError });
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Planning 模式执行：通过事件机制触发 AgentChatView 的 Planning 流程
 *
 * Planning 模式依赖完整的 Agent Loop（FSM + Sub-Agent + Tool Calling），
 * 该逻辑与 React UI 深度耦合（usePlanningMode Hook）。
 * 因此通过 Tauri 事件通知前端 AgentChatView 接手执行。
 *
 * 五步跨 Hub 导航（与 ImTaskBridge.triggerPlanningExecution 保持一致）：
 * 1. 从 Rust 后端查询目标 agent 的 hubId（内存找不到时）
 * 2. 切换 Hub → 等待 useDataLoader 将目标 Hub 的 agents 加载到内存
 * 3. 切换到目标 Agent
 * 4. 等待 AgentChatView 重渲染并重注册 `cron:execute_planning` 监听器
 * 5. 发射事件
 */
async function executePlanningMode(job: CronJob): Promise<CronExecutionResult> {
  logger.info(`定时任务使用 Planning 模式: ${job.name}`);

  const { emit } = await import('@tauri-apps/api/event');
  const imBotId = resolveCronImBotId(job.agentId);

  // 设置模式为 planning
  const { setModeFor } = useChatStore.getState();
  setModeFor(job.agentId, 'planning');

  // ─── 跨 Hub Agent 导航 ────────────────────────────────────────────────────
  //
  // agentStore.agents 只包含「当前 Hub」的 agents（useDataLoader 按 hub 覆盖加载）。
  // 若定时任务的 agent 属于另一个 Hub，直接 setCurrentAgentId 找不到目标 agent，
  // AgentChatView 显示「无效的 Agent 配置」，事件无法被接收。
  // 与 ImTaskBridge.triggerPlanningExecution 采用相同的修复策略。

  const { setCurrentAgentId } = useAgentStore.getState();
  const { setCurrentHubId, currentHubId } = useHubStore.getState();

  // 第一步：确定目标 agent 的 hubId（内存优先，缺失则查后端）
  let targetHubId: string | null = null;
  const cachedAgent = useAgentStore.getState().agents.find((a) => a.id === job.agentId);
  if (cachedAgent?.hubId) {
    targetHubId = cachedAgent.hubId;
    logger.debug(`Cron 任务: 内存命中 agent hubId=${targetHubId}`);
  } else {
    logger.debug(`Cron 任务: 内存未命中 agentId=${job.agentId}，从后端查询 hubId`);
    try {
      const agentFromDb = await invoke<{ id: string; hubId: string } | null>('agent_get', {
        id: job.agentId,
      });
      if (agentFromDb?.hubId) {
        targetHubId = agentFromDb.hubId;
        logger.debug(`Cron 任务: 后端返回 agent hubId=${targetHubId}`);
      }
    } catch (err) {
      logger.error(`Cron 任务: 查询 agent_get 失败, agentId=${job.agentId}`, {
        error: String(err),
      });
    }
  }

  // 第二步：若目标 Hub 与当前 Hub 不同，先切换并等待 agents 加载完成
  if (targetHubId && targetHubId !== currentHubId) {
    logger.info(
      `Cron 任务跨 Hub 导航: ${currentHubId ?? 'none'} → ${targetHubId}, agentId=${job.agentId}`
    );
    setCurrentHubId(targetHubId);

    // 轮询等待 useDataLoader 将目标 Hub 的 agents 加载到内存（最多 3 秒）
    const TARGET_HUB_LOAD_TIMEOUT_MS = 3000;
    const POLL_INTERVAL_MS = 50;
    const pollStart = Date.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        const agentLoaded = useAgentStore.getState().agents.some((a) => a.id === job.agentId);
        if (agentLoaded) {
          logger.debug(`Cron 任务: 目标 agent 已加载到内存, agentId=${job.agentId}`);
          resolve();
        } else if (Date.now() - pollStart > TARGET_HUB_LOAD_TIMEOUT_MS) {
          logger.warn(`Cron 任务: 等待 Hub agents 加载超时, agentId=${job.agentId}`);
          resolve();
        } else {
          setTimeout(check, POLL_INTERVAL_MS);
        }
      };
      check();
    });
  } else if (!targetHubId) {
    logger.warn(`Cron 任务: 无法确定 agentId=${job.agentId} 所属 Hub，直接尝试导航`);
  }

  // 第三步：切换到目标 Agent
  setCurrentAgentId(job.agentId);

  // 第四步：等待 AgentChatView 重渲染并完成 cron:execute_planning 监听器重注册
  // useEffect([currentAgentId]) 内 await listen() 为异步注册，
  // 跨 Hub 场景需额外等待双次渲染周期（Hub 切换 + Agent 切换各一次）
  const LISTENER_REREGISTER_DELAY_MS = 800;
  await new Promise((resolve) => setTimeout(resolve, LISTENER_REREGISTER_DELAY_MS));

  // 第五步：发射事件，让 AgentChatView 的 usePlanningMode 接手执行
  await emit('cron:execute_planning', {
    agentId: job.agentId,
    prompt: job.prompt,
    cronJobId: job.id,
    cronJobName: job.name,
    source: 'cron',
    ...(imBotId ? { botId: imBotId } : {}),
  });

  // Planning 模式的执行结果由 AgentChatView 内部的 usePlanningMode 管理
  await updateJobRunStatus(job.id, 'success');

  logger.info(`定时任务 Planning 模式已触发: ${job.name}`);
  return { success: true };
}

/**
 * 根据 cron 目标 Agent 查找唯一可用于主动 IM 发送的 Bot。
 *
 * Bot 的 Hub/Agent 绑定表示入站路由；cron 主动发送还需要 botId，
 * 以便 IM 发送工具读取对应凭据、默认出站目标或最近会话。
 */
function resolveCronImBotId(agentId: string): string | undefined {
  const { botConfigs } = useImChannelStore.getState();
  const matchedBots = botConfigs.filter(
    (bot) => bot.enabled && bot.agentId === agentId && bot.hasCredentials
  );

  if (matchedBots.length === 0) {
    logger.debug(`Cron 任务未找到绑定到 agentId=${agentId} 的 IM Bot，跳过 IM 上下文注入`);
    return undefined;
  }

  if (matchedBots.length > 1) {
    logger.warn(`Cron 任务找到多个绑定到 agentId=${agentId} 的 IM Bot，无法安全选择主动发送目标`, {
      botIds: matchedBots.map((bot) => bot.botId),
    });
    return undefined;
  }

  return matchedBots[0]?.botId;
}

/**
 * 更新定时任务的运行状态
 */
async function updateJobRunStatus(
  jobId: string,
  status: 'running' | 'success' | 'failed'
): Promise<void> {
  const now = Date.now();
  const updateParams: CronJobUpdateParams = {
    lastRunStatus: status,
    ...(status !== 'running' ? { lastRunAt: now } : {}),
  };

  await invoke('cron_update', {
    id: jobId,
    request: updateParams,
  });
}
