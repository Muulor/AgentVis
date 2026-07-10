/**
 * VisualEnhancementJobManager - 消息级可视化增强后台任务管理器
 *
 * 按 contextId 串行执行 Visual Enhancer，按 messageId 提供独立取消能力。
 * 前台 AgentLoop 与后台增强使用不同的生命周期和 AbortController。
 */

import { getLogger } from '@services/logger';
import { useChatStore } from '@stores/chatStore';

const logger = getLogger('VisualEnhancementJobManager');

export type VisualEnhancementJobStatus = 'queued' | 'running';

export interface VisualEnhancementJobState {
    contextId: string;
    status: VisualEnhancementJobStatus;
}

export interface VisualEnhancementJob {
    messageId: string;
    contextId: string;
    execute: (signal: AbortSignal) => Promise<void>;
}

interface QueuedVisualEnhancementJob extends VisualEnhancementJob {
    controller: AbortController;
}

type JobStateListener = (
    messageId: string,
    state: VisualEnhancementJobState | null
) => void;

function syncJobStateToChatStore(
    messageId: string,
    state: VisualEnhancementJobState | null
): void {
    useChatStore.getState().setVisualEnhancementJobState(messageId, state);
}

/**
 * 同一 context 只运行一个 VE，避免连续消息同时占用多个增强 LLM 调用。
 */
export class VisualEnhancementJobManager {
    private readonly queuesByContext = new Map<string, QueuedVisualEnhancementJob[]>();
    private readonly activeByContext = new Map<string, QueuedVisualEnhancementJob>();

    constructor(private readonly onStateChange: JobStateListener = syncJobStateToChatStore) {}

    enqueue(job: VisualEnhancementJob): void {
        this.cancel(job.messageId);

        const queuedJob: QueuedVisualEnhancementJob = {
            ...job,
            controller: new AbortController(),
        };
        const queue = this.queuesByContext.get(job.contextId) ?? [];
        queue.push(queuedJob);
        this.queuesByContext.set(job.contextId, queue);
        this.onStateChange(job.messageId, {
            contextId: job.contextId,
            status: 'queued',
        });
        this.startNext(job.contextId);
    }

    cancel(messageId: string): boolean {
        for (const activeJob of this.activeByContext.values()) {
            if (activeJob.messageId !== messageId) continue;

            activeJob.controller.abort();
            this.onStateChange(messageId, null);
            logger.debug('[VisualEnhancementJobManager] 已取消运行中的增强任务:', messageId);
            return true;
        }

        for (const [contextId, queue] of this.queuesByContext) {
            const jobIndex = queue.findIndex(job => job.messageId === messageId);
            if (jobIndex === -1) continue;

            queue.splice(jobIndex, 1);
            if (queue.length === 0) {
                this.queuesByContext.delete(contextId);
            }
            this.onStateChange(messageId, null);
            logger.debug('[VisualEnhancementJobManager] 已取消排队中的增强任务:', messageId);
            return true;
        }

        return false;
    }

    cancelContext(contextId: string): void {
        const activeJob = this.activeByContext.get(contextId);
        if (activeJob) {
            activeJob.controller.abort();
            this.onStateChange(activeJob.messageId, null);
        }

        const queuedJobs = this.queuesByContext.get(contextId) ?? [];
        for (const job of queuedJobs) {
            this.onStateChange(job.messageId, null);
        }
        this.queuesByContext.delete(contextId);
    }

    private startNext(contextId: string): void {
        if (this.activeByContext.has(contextId)) return;

        const queue = this.queuesByContext.get(contextId);
        const job = queue?.shift();
        if (!job) {
            this.queuesByContext.delete(contextId);
            return;
        }
        if (!queue || queue.length === 0) {
            this.queuesByContext.delete(contextId);
        }

        this.activeByContext.set(contextId, job);
        this.onStateChange(job.messageId, {
            contextId,
            status: 'running',
        });

        void job.execute(job.controller.signal)
            .catch((error: unknown) => {
                if (!job.controller.signal.aborted) {
                    logger.warn('[VisualEnhancementJobManager] 后台增强任务失败:', error);
                }
            })
            .finally(() => {
                if (this.activeByContext.get(contextId) === job) {
                    this.activeByContext.delete(contextId);
                }
                this.onStateChange(job.messageId, null);
                this.startNext(contextId);
            });
    }
}

export const visualEnhancementJobManager = new VisualEnhancementJobManager();
