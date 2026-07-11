/**
 * CronScheduler - 定时任务调度引擎
 *
 * 核心职责：
 * 1. 应用启动时从后端加载所有启用的定时任务
 * 2. 每分钟轮询检查是否有任务需要执行
 * 3. 任务到期时调用 CronExecutor 执行
 * 4. 更新下次执行时间
 *
 * 设计说明：
 * - 使用 setInterval 实现分钟级轮询，精度足够满足定时任务场景
 * - 调度器是单例模式，整个应用只有一个实例
 * - 使用 executingJobs Set 防止同一任务重复触发（上次未执行完时跳过）
 */

import { invoke } from '@tauri-apps/api/core';
import type { CronJob } from './types';
import { matchesCronExpression, getNextRunTime, parseScheduleConfig } from './cronExpression';
import { executeCronJob } from './CronExecutor';
import { getLogger } from '@services/logger';

const logger = getLogger('CronScheduler');

/** 轮询间隔：60 秒 */
const POLL_INTERVAL_MS = 60_000;

/** 调度器内部状态 */
interface SchedulerState {
  /** 是否正在运行 */
  isRunning: boolean;
  /** 轮询定时器 ID */
  intervalId: ReturnType<typeof setInterval> | null;
  /** 当前跟踪的已启用任务列表 */
  enabledJobs: CronJob[];
  /** 当前正在执行的任务 ID 集合（防重入） */
  executingJobs: Set<string>;
}

const state: SchedulerState = {
  isRunning: false,
  intervalId: null,
  enabledJobs: [],
  executingJobs: new Set(),
};

/**
 * 初始化并启动调度器
 *
 * 应用启动时调用，从后端加载所有启用的定时任务并启动轮询
 */
export async function startScheduler(): Promise<void> {
  if (state.isRunning) {
    logger.warn('调度器已在运行中，跳过重复启动');
    return;
  }

  logger.info('正在启动 Cron 调度器...');

  try {
    await refreshEnabledJobs();
    // 初始化全局 Cron 索引（供 AgentNavItem 角标使用）
    const { useCronStore } = await import('@stores/cronStore');
    void useCronStore.getState().loadGlobalCronIndex();
    logger.info(`已加载 ${state.enabledJobs.length} 个启用的定时任务`);

    // 启动分钟级轮询
    state.intervalId = setInterval(() => {
      checkAndExecute();
    }, POLL_INTERVAL_MS);
    state.isRunning = true;

    logger.info('Cron 调度器已启动');
  } catch (error) {
    logger.error('启动 Cron 调度器失败', { error });
  }
}

/**
 * 停止调度器
 *
 * 应用关闭时调用
 */
export function stopScheduler(): void {
  if (!state.isRunning) return;

  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  state.isRunning = false;
  state.enabledJobs = [];
  state.executingJobs.clear();

  logger.info('Cron 调度器已停止');
}

/**
 * 刷新启用的任务列表
 *
 * 当用户创建/修改/删除/切换任务时调用，同步调度器内存状态
 */
export async function refreshEnabledJobs(): Promise<void> {
  try {
    const jobs = await invoke<CronJob[]>('cron_list_all_enabled');
    state.enabledJobs = jobs;

    // 更新所有任务的 nextRunAt
    for (const job of state.enabledJobs) {
      const nextRun = getNextRunTime(job.cronExpression);
      if (nextRun !== null && nextRun !== job.nextRunAt) {
        try {
          await invoke('cron_update', {
            id: job.id,
            request: { nextRunAt: nextRun },
          });
          job.nextRunAt = nextRun;
        } catch (error) {
          logger.warn(`更新任务 ${job.name} 的 nextRunAt 失败`, { error });
        }
      }
    }
  } catch (error) {
    logger.error('刷新启用任务列表失败', { error });
  }
}

/**
 * 核心轮询函数：检查并执行到期任务
 *
 * 每分钟调用一次，遍历所有启用的任务，
 * 如果当前时间匹配 Cron 表达式则触发执行
 */
function checkAndExecute(): void {
  if (state.enabledJobs.length === 0) return;

  const now = new Date();

  for (const job of state.enabledJobs) {
    // 跳过正在执行的任务（防重入）
    if (state.executingJobs.has(job.id)) {
      logger.debug(`任务 ${job.name} 正在执行中，跳过本次检查`);
      continue;
    }

    // 检查当前时间是否匹配 Cron 表达式
    if (!matchesCronExpression(job.cronExpression, now)) {
      continue;
    }

    // 匹配成功，标记为执行中并异步执行
    state.executingJobs.add(job.id);
    logger.info(`定时任务到期，开始执行: ${job.name}`);

    // 异步执行，不阻塞其他任务的检查
    executeAndCleanup(job).catch((error: unknown) => {
      logger.error(`执行定时任务异常: ${job.name}`, { error });
    });
  }
}

/**
 * 执行任务并更新状态（清理执行标记、更新下次执行时间、自动关闭）
 */
async function executeAndCleanup(job: CronJob): Promise<void> {
  try {
    await executeCronJob(job);

    // 检测是否为「指定时间」一次性任务，执行后自动禁用
    const scheduleConfig = parseScheduleConfig(job.cronExpression);
    if (scheduleConfig?.autoDisable) {
      logger.info(`一次性任务已完成，自动关闭: ${job.name}`);
      try {
        await invoke('cron_update', {
          id: job.id,
          request: { enabled: false },
        });
        // 从调度器内存中移除
        state.enabledJobs = state.enabledJobs.filter((j) => j.id !== job.id);
      } catch (error) {
        logger.warn(`自动关闭任务 ${job.name} 失败`, { error });
      }
      return;
    }

    // 周期性任务：计算并更新下次执行时间
    const nextRun = getNextRunTime(job.cronExpression);
    if (nextRun !== null) {
      try {
        await invoke('cron_update', {
          id: job.id,
          request: { nextRunAt: nextRun },
        });
        job.nextRunAt = nextRun;
      } catch (error) {
        logger.warn(`更新任务 ${job.name} 的下次执行时间失败`, { error });
      }
    }
  } finally {
    // 无论成功失败，都清除执行标记
    state.executingJobs.delete(job.id);
  }
}

/**
 * 获取调度器状态（供 UI 显示）
 */
export function getSchedulerStatus(): { isRunning: boolean; trackedJobCount: number } {
  return {
    isRunning: state.isRunning,
    trackedJobCount: state.enabledJobs.length,
  };
}
