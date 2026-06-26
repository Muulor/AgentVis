/**
 * CronTool - 定时任务管理工具
 *
 * 允许 Agent 在对话中自主创建/查看/更新/删除定时任务。
 * 通过 cronStore 与 Rust 后端同步，并触发调度器刷新。
 *
 * 技能定义: SKILL.md
 * 工具实现: 本文件
 */

import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { useCronStore } from '@stores/cronStore';
import { getCurrentLanguage, translate } from '@/i18n';
import {
    describeCronExpression,
    isValidCronExpression,
} from '@services/cron/cronExpression';
import type { CronJob } from '@services/cron/types';

// ==================== 常量 ====================

/** 工具支持的操作类型 */
type CronAction = 'create' | 'list' | 'update' | 'delete';

/** 所有有效 action 值（用于校验） */
const VALID_ACTIONS: readonly CronAction[] = ['create', 'list', 'update', 'delete'];

// ==================== Schema ====================

/**
 * 工具 Schema
 */
const SCHEMA: ToolSchema = {
    name: 'cron',
    description: 'Manage scheduled tasks. Supports creating, listing, updating, and deleting cron jobs so the Agent can set up recurring automation. agentId is provided by the system automatically.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'Action type: create / list / update / delete.',
                enum: ['create', 'list', 'update', 'delete'],
            },
            name: {
                type: 'string',
                description: 'Job name, used by create and update.',
            },
            cronExpression: {
                type: 'string',
                description: 'Five-field cron expression: minute hour day-of-month month day-of-week. Example: "0 9 * * *" means 9:00 every day.',
            },
            prompt: {
                type: 'string',
                description: 'Prompt sent to the Agent when the schedule triggers, used by create and update.',
            },
            jobId: {
                type: 'string',
                description: 'Job ID, required by update and delete. Get it from list.',
            },
            enabled: {
                type: 'boolean',
                description: 'Whether the job is enabled. Defaults to true.',
            },
        },
        required: ['action'],
    },
};

// ==================== 辅助函数 ====================

/**
 * 格式化单个 CronJob 为人类可读的摘要
 *
 * 包含任务名称、调度描述、状态、提示词预览等关键信息，
 * 便于 LLM 理解并向用户呈现。
 */
function formatJobSummary(job: CronJob): string {
    const language = getCurrentLanguage();
    const schedule = describeCronExpression(job.cronExpression, language);
    const status = job.enabled ? translate('tools.cron.enabled') : translate('tools.cron.paused');
    // 截断过长的提示词预览，保留语义完整性
    const promptPreview = job.prompt.length > 80
        ? job.prompt.substring(0, 80) + '...'
        : job.prompt;
    const lastRun = job.lastRunAt
        ? new Date(job.lastRunAt).toLocaleString(language)
        : translate('tools.cron.neverRun');
    const nextRun = job.nextRunAt
        ? new Date(job.nextRunAt).toLocaleString(language)
        : translate('tools.cron.notCalculated');

    return translate('tools.cron.summary', {
        name: job.name,
        id: job.id,
        schedule,
        status,
        prompt: promptPreview,
        lastRun,
        nextRun,
    });
}

// ==================== Action 处理函数 ====================

/**
 * 处理 create action
 *
 * 校验必填字段和 Cron 表达式后，通过 cronStore 创建任务。
 * cronStore 内部会自动计算 nextRunAt 并通知调度器刷新。
 */
async function handleCreate(
    params: Record<string, unknown>,
): Promise<ToolResult> {
    const agentId = params.agentId as string;
    const name = params.name as string | undefined;
    const cronExpression = params.cronExpression as string | undefined;
    const prompt = params.prompt as string | undefined;
    const enabled = (params.enabled as boolean | undefined) ?? true;

    // 参数校验：创建时必填字段
    if (!name || !cronExpression || !prompt) {
        return {
            success: false,
            content: translate('tools.cron.createMissing'),
        };
    }

    // Cron 表达式有效性校验
    if (!isValidCronExpression(cronExpression)) {
        return {
            success: false,
            content: translate('tools.cron.invalidCronWithExample', { expression: cronExpression }),
        };
    }

    try {
        const { createJob } = useCronStore.getState();
        const job = await createJob({
            agentId,
            name,
            cronExpression,
            prompt,
            enabled,
        });

        const language = getCurrentLanguage();
        const schedule = describeCronExpression(cronExpression, language);
        const nextRun = job.nextRunAt
            ? new Date(job.nextRunAt).toLocaleString(language)
            : translate('tools.cron.unknown');

        return {
            success: true,
            content: translate('tools.cron.createSuccess', {
                name: job.name,
                id: job.id,
                schedule,
                nextRun,
                status: enabled ? translate('tools.cron.enabled') : translate('tools.cron.paused'),
            }),
            data: {
                jobId: job.id,
                name: job.name,
                cronExpression: job.cronExpression,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            content: translate('tools.cron.createFailed', { error: message }),
        };
    }
}

/**
 * 处理 list action
 *
 * 通过 cronStore 加载指定 Agent 的所有定时任务并格式化返回。
 */
async function handleList(
    params: Record<string, unknown>,
): Promise<ToolResult> {
    const agentId = params.agentId as string;

    try {
        const { loadJobsByAgent } = useCronStore.getState();
        await loadJobsByAgent(agentId);

        // 重新获取加载后的 jobs
        const { jobs } = useCronStore.getState();

        if (jobs.length === 0) {
            return {
                success: true,
                content: translate('tools.cron.empty'),
                data: { count: 0 },
            };
        }

        const formattedJobs = jobs.map(formatJobSummary).join('\n\n');
        return {
            success: true,
            content: translate('tools.cron.listSuccess', { count: jobs.length, jobs: formattedJobs }),
            data: {
                count: jobs.length,
                jobs: jobs.map(j => ({ id: j.id, name: j.name, enabled: j.enabled })),
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            content: translate('tools.cron.listFailed', { error: message }),
        };
    }
}

/**
 * 处理 update action
 *
 * 需要 jobId 定位任务,支持部分更新(仅传入要修改的字段)。
 */
async function handleUpdate(
    params: Record<string, unknown>,
): Promise<ToolResult> {
    const jobId = params.jobId as string | undefined;
    const name = params.name as string | undefined;
    const cronExpression = params.cronExpression as string | undefined;
    const prompt = params.prompt as string | undefined;
    const enabled = params.enabled as boolean | undefined;

    if (!jobId) {
        return {
            success: false,
            content: translate('tools.cron.updateMissingJobId'),
        };
    }

    // 如果指定了新的 Cron 表达式，校验有效性
    if (cronExpression && !isValidCronExpression(cronExpression)) {
        return {
            success: false,
            content: translate('tools.cron.invalidCron', { expression: cronExpression }),
        };
    }

    // 构建更新参数（仅包含提供的字段）
    const updateParams: Record<string, unknown> = {};
    if (name !== undefined) updateParams.name = name;
    if (cronExpression !== undefined) updateParams.cronExpression = cronExpression;
    if (prompt !== undefined) updateParams.prompt = prompt;
    if (enabled !== undefined) updateParams.enabled = enabled;

    // 至少需要更新一个字段
    if (Object.keys(updateParams).length === 0) {
        return {
            success: false,
            content: translate('tools.cron.updateMissingFields'),
        };
    }

    try {
        const { updateJob } = useCronStore.getState();
        const job = await updateJob(jobId, updateParams);

        const schedule = describeCronExpression(job.cronExpression, getCurrentLanguage());
        return {
            success: true,
            content: translate('tools.cron.updateSuccess', {
                name: job.name,
                schedule,
                status: job.enabled ? translate('tools.cron.enabled') : translate('tools.cron.paused'),
            }),
            data: {
                jobId: job.id,
                name: job.name,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            content: translate('tools.cron.updateFailed', { error: message }),
        };
    }
}

/**
 * 处理 delete action
 *
 * 通过 jobId 删除指定的定时任务。
 */
async function handleDelete(
    params: Record<string, unknown>,
): Promise<ToolResult> {
    const jobId = params.jobId as string | undefined;

    if (!jobId) {
        return {
            success: false,
            content: translate('tools.cron.deleteMissingJobId'),
        };
    }

    try {
        const { deleteJob } = useCronStore.getState();
        await deleteJob(jobId);

        return {
            success: true,
            content: translate('tools.cron.deleteSuccess', { jobId }),
            data: { jobId },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            content: translate('tools.cron.deleteFailed', { error: message }),
        };
    }
}

// ==================== Action 路由 ====================

/** Action 处理器映射表（策略模式，避免 if-else 链） */
const ACTION_HANDLERS: Record<CronAction, (params: Record<string, unknown>) => Promise<ToolResult>> = {
    create: handleCreate,
    list: handleList,
    update: handleUpdate,
    delete: handleDelete,
};

// ==================== 工具实现 ====================

/**
 * CronTool 实现
 *
 * 统一路由所有 cron 操作，通过 action 参数分派到对应处理函数。
 */
class CronToolImpl implements Tool {
    readonly schema = SCHEMA;

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const action = params.action as string | undefined;

        // 基础参数校验
        if (!action) {
            return {
                success: false,
                content: translate('tools.common.missingAction', { options: VALID_ACTIONS.join(' / ') }),
            };
        }

        if (!VALID_ACTIONS.includes(action as CronAction)) {
            return {
                success: false,
                content: translate('tools.common.invalidAction', {
                    action,
                    options: VALID_ACTIONS.join(' / '),
                }),
            };
        }

        // 从执行上下文获取真实 agentId（UUID）
        // SA 不可靠地传入 agentId（可能传名称而非 UUID），因此必须从上下文获取
        const agentId = context.agentId;
        if (!agentId) {
            return {
                success: false,
                content: translate('tools.cron.missingAgentId'),
            };
        }

        // 将 agentId 注入 params，供各 handler 使用
        const enrichedParams = { ...params, agentId };

        // 分派到对应的 action 处理器
        const handler = ACTION_HANDLERS[action as CronAction];
        return handler(enrichedParams);
    }
}

/**
 * 导出单例实例
 */
export const cronTool = new CronToolImpl();
