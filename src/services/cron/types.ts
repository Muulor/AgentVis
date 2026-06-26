import type { ChatMode } from '@/types/chatMode';

/**
 * Cron 定时任务 - 类型定义
 *
 * 与 Rust 后端 CronJobItem 保持一致（camelCase）
 */

/** CronJob 实体（与 Rust 端 CronJobItem 对应） */
export interface CronJob {
    id: string;
    agentId: string;
    name: string;
    cronExpression: string;
    prompt: string;
    mode: ChatMode;
    enabled: boolean;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastRunStatus: 'success' | 'failed' | 'running' | null;
    createdAt: number;
    updatedAt: number;
}

/** 创建定时任务请求（与 Rust 端 CreateCronJobRequest 对应） */
export interface CronJobCreateParams {
    agentId: string;
    name: string;
    cronExpression: string;
    prompt: string;
    enabled?: boolean;
    nextRunAt?: number;
}

/** 更新定时任务请求（与 Rust 端 UpdateCronJobRequest 对应） */
export interface CronJobUpdateParams {
    name?: string;
    cronExpression?: string;
    prompt?: string;
    enabled?: boolean;
    nextRunAt?: number;
    lastRunAt?: number;
    lastRunStatus?: 'success' | 'failed' | 'running' | null;
}

/** Cron 调度器状态 */
export interface CronSchedulerStatus {
    isRunning: boolean;
    /** 当前跟踪的任务数量 */
    trackedJobCount: number;
}
