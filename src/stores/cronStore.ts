/**
 * CronStore - 定时任务 Zustand 状态管理
 *
 * 管理前端的定时任务列表状态，与 Rust 后端通过 Tauri Commands 同步。
 * 遵循项目的 Store-Service 分离原则：Store 仅管理状态，
 * 业务逻辑（调度、执行）在 services/cron/ 中实现。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { CronJob, CronJobCreateParams, CronJobUpdateParams } from '@services/cron/types';
import { getNextRunTime } from '@services/cron/cronExpression';
import { refreshEnabledJobs } from '@services/cron/CronScheduler';
import { getLogger } from '@services/logger';

const logger = getLogger('cronStore');

/**
 * CronStore 状态类型
 */
interface CronState {
  /** 当前 Agent 的定时任务列表 */
  jobs: CronJob[];
  /** 加载状态 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 有启用定时任务的 Agent ID 集合（全局索引，用于 NavItem 角标） */
  enabledAgentIds: Set<string>;

  // Actions
  /** 加载指定 Agent 的定时任务列表 */
  loadJobsByAgent: (agentId: string) => Promise<void>;
  /** 创建定时任务 */
  createJob: (params: CronJobCreateParams) => Promise<CronJob>;
  /** 更新定时任务 */
  updateJob: (id: string, params: CronJobUpdateParams) => Promise<CronJob>;
  /** 删除定时任务 */
  deleteJob: (id: string) => Promise<void>;
  /** 切换定时任务启用状态 */
  toggleJob: (id: string, enabled: boolean) => Promise<void>;
  /** 清空本地状态 */
  clearJobs: () => void;
  /** 加载全局 Cron 索引（哪些 Agent 有启用的定时任务） */
  loadGlobalCronIndex: () => Promise<void>;
}

/**
 * CronStore - 定时任务全局状态
 */
export const useCronStore = create<CronState>((set) => ({
  // 初始状态
  jobs: [],
  isLoading: false,
  error: null,
  enabledAgentIds: new Set<string>(),

  // 加载指定 Agent 的定时任务
  loadJobsByAgent: async (agentId: string) => {
    set({ isLoading: true, error: null });
    try {
      const jobs = await invoke<CronJob[]>('cron_list_by_agent', { agentId });
      set({ jobs, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`加载定时任务列表失败`, { agentId, error: message });
      set({ error: message, isLoading: false });
    }
  },

  // 创建定时任务
  createJob: async (params: CronJobCreateParams) => {
    try {
      // 自动计算下次执行时间
      const nextRunAt = getNextRunTime(params.cronExpression) ?? undefined;

      const job = await invoke<CronJob>('cron_create', {
        request: { ...params, nextRunAt },
      });

      // 添加到本地列表
      set((state) => ({ jobs: [job, ...state.jobs] }));

      await refreshEnabledJobs();
      // 同步刷新全局索引，让 NavItem 角标实时更新
      void useCronStore.getState().loadGlobalCronIndex();

      logger.info(`定时任务已创建: ${job.name}`);
      return job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`创建定时任务失败`, { error: message });
      throw error;
    }
  },

  // 更新定时任务
  updateJob: async (id: string, params: CronJobUpdateParams) => {
    try {
      // 如果 cron 表达式变更，重新计算 nextRunAt
      if (params.cronExpression) {
        params.nextRunAt = getNextRunTime(params.cronExpression) ?? undefined;
      }

      const job = await invoke<CronJob>('cron_update', {
        id,
        request: params,
      });

      // 更新本地列表
      set((state) => ({
        jobs: state.jobs.map((j) => (j.id === id ? job : j)),
      }));

      // 通知调度器刷新
      await refreshEnabledJobs();

      logger.info(`定时任务已更新: ${job.name}`);
      return job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`更新定时任务失败`, { id, error: message });
      throw error;
    }
  },

  // 删除定时任务
  deleteJob: async (id: string) => {
    try {
      await invoke('cron_delete', { id });

      // 从本地列表移除
      set((state) => ({
        jobs: state.jobs.filter((j) => j.id !== id),
      }));

      await refreshEnabledJobs();
      void useCronStore.getState().loadGlobalCronIndex();

      logger.info(`定时任务已删除: ${id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`删除定时任务失败`, { id, error: message });
      throw error;
    }
  },

  // 切换启用状态
  toggleJob: async (id: string, enabled: boolean) => {
    try {
      const job = await invoke<CronJob>('cron_update', {
        id,
        request: { enabled },
      });

      // 更新本地列表
      set((state) => ({
        jobs: state.jobs.map((j) => (j.id === id ? job : j)),
      }));

      await refreshEnabledJobs();
      void useCronStore.getState().loadGlobalCronIndex();

      logger.info(`定时任务${enabled ? '已启用' : '已禁用'}: ${job.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`切换定时任务状态失败`, { id, enabled, error: message });
      throw error;
    }
  },

  // 清空本地状态
  clearJobs: () => set({ jobs: [], error: null }),

  // 加载全局 Cron 索引：哪些 Agent 有启用的定时任务
  // 用于 AgentNavItem 角标显示，应用初始化和任务增删后调用
  loadGlobalCronIndex: async () => {
    try {
      const enabledJobs = await invoke<CronJob[]>('cron_list_all_enabled', {});
      const agentIds = new Set(enabledJobs.map((j) => j.agentId));
      set({ enabledAgentIds: agentIds });
    } catch (error) {
      logger.error('加载全局 Cron 索引失败', { error });
    }
  },
}));
