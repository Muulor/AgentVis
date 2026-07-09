/**
 * usePlanningMode - Planning 模式消息发送 Hook
 *
 * 封装 Planning 模式下的 AgentLoop 编排逻辑，包括：
 * - AgentService 管理与配置
 * - 进度回调同步到 UI
 * - Diff 数据预览加载
 * - 消息持久化与记忆系统集成
 * - Temp MessageId → Real MessageId 映射
 *
 * @module hooks/usePlanningMode
 */

import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useChatStore } from '@stores/chatStore';
import { useHubStore } from '@stores/hubStore';
import { useSettingsStore } from '@stores/settingsStore';
import { useStatusStore } from '@stores/statusStore';
import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import { useToast } from '@components/ui/Toast';
import { getActiveImTracker, getActiveImTask, markImTaskStarted } from '@services/im-channel/ImTaskBridge';
import { stripVisualCodeBlocks } from '@services/planning/visual-enhancer/stripVisualCodeBlocks';
import {
    notifyTaskCompleted,
    resolveTaskCompletionNotificationSource,
} from '@services/desktop-notification';
import { cancelCachedAgentService } from '@services/planning/AgentService';
import { PLANNING_CONSTANTS } from '@services/planning/PlanningConstants';
import { upsertSubAgentObservationEvent } from '@services/planning/utils/SubAgentObservationEvents';
import type { Message } from '@/types';
import type { AttachmentInfo } from '@/types/message';
import type { TaskAttachmentReference } from '@services/planning/sub-agents/types';
import { getLogger } from '@services/logger';
import { useI18n, type TranslationKey, type TranslationParams } from '@/i18n';
import { getQuoteContextContent, serializeQuotesForMessage } from '@utils/quoteContent';
import { modelSupportsVision } from '@/config/modelRegistry';

const logger = getLogger('usePlanningMode');
const PLANNING_CHECKPOINT_FLUSH_INTERVAL_MS = 2000;
const PLANNING_CHECKPOINT_OBSERVATION_LIMIT = 80;
const PLANNING_CHECKPOINT_PERSIST_OBSERVATION_LIMIT = 12;
const PLANNING_CHECKPOINT_PERSIST_MAX_CHARS = 4200;
const PLANNING_CHECKPOINT_MB_MAX_CHARS = 1800;
const PLANNING_CHECKPOINT_EVENT_MAX_CHARS = 1200;
const HISTORICAL_ATTACHMENT_CONTEXT_MAX_TOKENS = 800;
const HISTORICAL_ATTACHMENT_CONTEXT_CHARS_PER_TOKEN = 2.5;
const HISTORICAL_ATTACHMENT_CONTEXT_MIN_CHARS = 320;
const HISTORICAL_ATTACHMENT_CONTEXT_SAFETY_MARGIN = 120;

function buildAttachmentReferences(attachments: AttachmentInfo[]): TaskAttachmentReference[] {
    return attachments
        .filter(attachment => attachment.localPath.trim())
        .map(attachment => ({
            fileName: attachment.fileName,
            path: attachment.localPath,
            type: attachment.type,
            extension: attachment.fileExtension,
            sizeBytes: attachment.size,
        }));
}

type PlanningCheckpointStatus = 'running' | 'failed' | 'abandoned';
type PlanningCheckpointTranslate = (key: TranslationKey, params?: TranslationParams) => string;
type PlanningCheckpointThinkingData = Partial<Record<'analyzing' | 'planning' | 'decided', string>>;
interface PlanningReasoningTraceData {
    content: string;
    isCompleted?: boolean;
}

type HistoricalAttachmentContextItem = Pick<
    AttachmentInfo,
    'fileName' | 'fileExtension' | 'type' | 'localPath'
> & Partial<Pick<AttachmentInfo, 'size' | 'parsedContent'>>;

function getHistoricalMessageAttachments(metadata: Message['metadata']): HistoricalAttachmentContextItem[] {
    if (!metadata) return [];

    const attachments = (metadata as Record<string, unknown>).attachments;
    if (!Array.isArray(attachments)) return [];

    return attachments.flatMap((attachment): HistoricalAttachmentContextItem[] => {
        if (!attachment || typeof attachment !== 'object') return [];

        const record = attachment as Record<string, unknown>;
        const type = record.type;
        if (type !== 'document' && type !== 'image') return [];
        if (
            typeof record.fileName !== 'string'
            || typeof record.fileExtension !== 'string'
            || typeof record.localPath !== 'string'
            || !record.localPath.trim()
        ) {
            return [];
        }

        return [{
            fileName: record.fileName,
            fileExtension: record.fileExtension,
            type,
            localPath: record.localPath,
            size: typeof record.size === 'number' ? record.size : undefined,
            parsedContent: typeof record.parsedContent === 'string' ? record.parsedContent : undefined,
        }];
    });
}

export function buildHistoricalAttachmentContext(
    attachments: HistoricalAttachmentContextItem[],
    userMessageContent: string,
    translateText: PlanningCheckpointTranslate,
    options: {
        maxTokens?: number;
        maxMessageChars?: number;
    } = {}
): string | undefined {
    const validAttachments = attachments.filter(attachment => attachment.localPath.trim());
    if (validAttachments.length === 0) return undefined;

    const maxTokens = options.maxTokens ?? HISTORICAL_ATTACHMENT_CONTEXT_MAX_TOKENS;
    const maxContextChars = Math.floor(maxTokens * HISTORICAL_ATTACHMENT_CONTEXT_CHARS_PER_TOKEN);
    const maxMessageChars = options.maxMessageChars ?? PLANNING_CONSTANTS.MASTER_BRAIN_MAX_MESSAGE_CHARS;
    const separatorChars = '\n\n'.length;
    const availableChars = Math.min(
        maxContextChars,
        Math.max(
            0,
            maxMessageChars
            - userMessageContent.length
            - separatorChars
            - HISTORICAL_ATTACHMENT_CONTEXT_SAFETY_MARGIN
        )
    );

    if (availableChars < HISTORICAL_ATTACHMENT_CONTEXT_MIN_CHARS) return undefined;

    const items = validAttachments
        .map(attachment => translateText('chat.historicalAttachmentContextItem', {
            fileName: attachment.fileName,
            type: attachment.type,
            extension: attachment.fileExtension,
            size: Math.max(1, Math.round((attachment.size ?? 0) / 1024)),
            path: attachment.localPath,
        }))
        .join('\n');

    const header = translateText('chat.historicalAttachmentContextHeader', { items });
    const contentBlocks = validAttachments
        .filter(attachment => attachment.type === 'document' && attachment.parsedContent?.trim())
        .map(attachment => translateText('chat.historicalAttachmentContentBlock', {
            fileName: attachment.fileName,
            content: attachment.parsedContent ?? '',
        }));

    const rawContext = [
        header,
        ...contentBlocks,
    ].join('\n\n');

    if (rawContext.length <= availableChars) {
        return rawContext;
    }

    const notice = translateText('chat.historicalAttachmentContextTruncatedNotice', { maxTokens });
    const contentBudget = Math.max(1, availableChars - notice.length - separatorChars);

    return `${rawContext.slice(0, contentBudget).trimEnd()}\n\n${notice}`;
}

interface PlanningCheckpointObservationData {
    thinking?: string;
    transient?: boolean;
    toolAction?: {
        tool: string;
        target: string;
        success?: boolean;
    };
    result?: string;
    step?: number;
}

interface PersistedMessageResult {
    id: string;
    agentId: string;
    role: string;
    content: string;
    metadata: string | null;
    createdAt: number;
}

export function isMessagePresentInList(
    messages: Array<{ id: string }>,
    messageId: string | null | undefined
): boolean {
    if (!messageId) return true;
    return messages.some((message) => message.id === messageId);
}

export function getPlanningHistoryEffectiveContent(
    message: Pick<Message, 'role' | 'content' | 'metadata'>
): string {
    // 跨请求上下文恢复：assistant 消息优先使用 persistContent（含 rationale + SA observations）。
    // chatStore 中 content 是 UI 剥离版，metadata.persistContent 才是下一轮 MB 恢复上下文所需的完整版。
    let effectiveContent = (message.role === 'assistant' && message.metadata)
        ? ((message.metadata as Record<string, unknown>).persistContent as string | undefined) ?? message.content
        : message.content;

    // 防御性清理：即使 persistContent 缺失导致回退到增强版 content，
    // 也要剥离可视化格式代码块，避免 MB 从对话历史中学习并模仿。
    if (message.role === 'assistant') {
        effectiveContent = stripVisualCodeBlocks(effectiveContent);
    }

    return effectiveContent;
}

export function trimPlanningCheckpointTextFromTail(
    content: string,
    maxChars = PLANNING_CHECKPOINT_PERSIST_MAX_CHARS,
    omittedNotice = ''
): string {
    const normalized = content.trim();
    if (normalized.length <= maxChars) return normalized;

    const notice = omittedNotice.trim();
    const separator = notice ? '\n' : '';
    const suffixBudget = Math.max(1, maxChars - notice.length - separator.length);
    let suffix = normalized.slice(-suffixBudget);
    const firstNewline = suffix.indexOf('\n');
    if (firstNewline > 0 && firstNewline < suffix.length - 1) {
        suffix = suffix.slice(firstNewline + 1);
    }

    return [notice, suffix.trimStart()].filter(Boolean).join('\n');
}

function buildPlanningCheckpointMbSection(
    thinkingChainData: PlanningCheckpointThinkingData,
    translateText: PlanningCheckpointTranslate,
    maxChars: number,
    omittedNotice: string
): string {
    const header = translateText('chat.planningCheckpointMbProgressHeader');
    const phases = [
        thinkingChainData.analyzing,
        thinkingChainData.planning,
        thinkingChainData.decided,
    ]
        .map(content => content?.trim())
        .filter((content): content is string => Boolean(content));

    if (phases.length === 0) return '';

    const buildSection = (items: string[]): string => [
        header,
        items.join('\n\n'),
    ].join('\n');

    const rawSection = buildSection(phases);
    if (rawSection.length <= maxChars) return rawSection;

    const overhead = header.length
        + 1
        + Math.max(0, phases.length - 1) * 2;
    const perPhaseBudget = Math.max(1, Math.floor((maxChars - overhead) / phases.length));
    const trimmedPhases = phases.map(content => (
        trimPlanningCheckpointTextFromTail(content, perPhaseBudget, omittedNotice)
    ));
    const trimmedSection = buildSection(trimmedPhases);

    return trimmedSection.length <= maxChars
        ? trimmedSection
        : trimPlanningCheckpointTextFromTail(trimmedSection, maxChars, omittedNotice);
}

function formatPlanningCheckpointObservationEvent(
    event: PlanningCheckpointObservationData,
    translateText: PlanningCheckpointTranslate
): string {
    const stepLabel = event.step === undefined
        ? translateText('chat.planningCheckpointUnknownStepLabel')
        : translateText('chat.subAgentStepLabel', { step: event.step });
    const details: string[] = [];
    const thinking = event.thinking?.trim();

    if (thinking) {
        details.push(`${translateText('chat.planningCheckpointSaThinkingLabel')} ${thinking}`);
    }

    if (event.toolAction) {
        const status = event.toolAction.success === undefined
            ? translateText('chat.planningCheckpointToolStatusPending')
            : event.toolAction.success
                ? translateText('chat.planningCheckpointToolStatusSuccess')
                : translateText('chat.planningCheckpointToolStatusFailed');
        details.push(
            `${translateText('chat.planningCheckpointSaToolLabel')} `
            + `${event.toolAction.tool}(${event.toolAction.target}) ${status}`
        );
    }

    const result = event.result?.trim();
    if (result) {
        details.push(`${translateText('chat.planningCheckpointSaResultLabel')}\n${result}`);
    }

    const body = details.length > 0
        ? details.join('\n  ')
        : translateText('chat.planningCheckpointEmptyObservation');

    return `- ${stepLabel}: ${body}`.slice(0, PLANNING_CHECKPOINT_EVENT_MAX_CHARS);
}

function buildPlanningCheckpointSaSection(
    observations: PlanningCheckpointObservationData[],
    translateText: PlanningCheckpointTranslate,
    observationLimit: number
): string {
    const observationLines = observations
        .filter(event => !event.transient)
        .slice(-observationLimit)
        .map(event => formatPlanningCheckpointObservationEvent(event, translateText))
        .join('\n');

    if (!observationLines.trim()) return '';

    return [
        translateText('chat.planningCheckpointSaProgressHeader'),
        observationLines,
    ].join('\n');
}

export function buildPlanningCheckpointProgressText(
    thinkingChainData: PlanningCheckpointThinkingData,
    subAgentObservationsData: PlanningCheckpointObservationData[],
    translateText: PlanningCheckpointTranslate,
    options: {
        maxChars?: number;
        observationLimit?: number;
    } = {}
): string {
    const maxChars = options.maxChars ?? PLANNING_CHECKPOINT_PERSIST_MAX_CHARS;
    const observationLimit = options.observationLimit ?? PLANNING_CHECKPOINT_PERSIST_OBSERVATION_LIMIT;
    const omittedNotice = translateText('chat.planningCheckpointOmittedOlderObservations');
    const saSection = buildPlanningCheckpointSaSection(
        subAgentObservationsData,
        translateText,
        observationLimit
    );
    const mbBudget = saSection
        ? Math.min(PLANNING_CHECKPOINT_MB_MAX_CHARS, Math.max(1, Math.floor(maxChars * 0.45)))
        : maxChars;
    const mbSection = buildPlanningCheckpointMbSection(
        thinkingChainData,
        translateText,
        mbBudget,
        omittedNotice
    );

    if (!mbSection && !saSection) {
        return translateText('chat.planningCheckpointNoObservations');
    }

    if (!mbSection) {
        return trimPlanningCheckpointTextFromTail(saSection, maxChars, omittedNotice);
    }

    if (!saSection) {
        return trimPlanningCheckpointTextFromTail(mbSection, maxChars, omittedNotice);
    }

    const saBudget = Math.max(1, maxChars - mbSection.length - 2);
    const trimmedSaSection = trimPlanningCheckpointTextFromTail(saSection, saBudget, omittedNotice);

    return [mbSection, trimmedSaSection].filter(Boolean).join('\n\n');
}

export function isPlanningCheckpointMessage(
    message: Pick<Message, 'role' | 'metadata'>
): boolean {
    const metadata = message.metadata;
    if (message.role !== 'assistant' || metadata?.mode !== 'planning') return false;

    return metadata.responseType === 'agent_loop_checkpoint'
        || metadata.responseType === 'agent_loop_checkpoint_abandoned'
        || metadata.agentLoopStatus === 'running'
        || metadata.agentLoopStatus === 'failed'
        || metadata.agentLoopStatus === 'abandoned';
}

export function isRecoverablePlanningCheckpointMessage(
    message: Pick<Message, 'role' | 'metadata'>,
    siblingMessages?: Array<Pick<Message, 'id'>>
): boolean {
    const metadata = message.metadata;
    if (!isPlanningCheckpointMessage(message)) return false;
    if (!metadata) return false;
    if (metadata.recoverable === false || metadata.agentLoopStatus === 'abandoned') return false;

    const hasCheckpointShape =
        metadata.responseType === 'agent_loop_checkpoint'
        || metadata.agentLoopStatus === 'running'
        || metadata.agentLoopStatus === 'failed';
    if (!hasCheckpointShape) return false;

    const sourceUserMessageId = typeof metadata.createdUserMessageId === 'string'
        ? metadata.createdUserMessageId
        : undefined;
    if (siblingMessages && sourceUserMessageId) {
        return siblingMessages.some(message => message.id === sourceUserMessageId);
    }

    return true;
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * usePlanningMode 配置选项
 */
export interface UsePlanningModeOptions {
    /** 上下文类型：agent 或 hub */
    contextType: 'agent' | 'hub';
    /** 上下文 ID（Agent ID 或 Hub ID） */
    contextId: string | null;
    /** Agent 配置（Agent 模式必填，Hub 模式 @提及时动态传入） */
    agentConfig?: {
        id?: string;          // Hub 模式下为 mentionedAgent ID
        name: string;
        hubId: string;
        mbRulesFilePath?: string;
        saRulesFilePath?: string;
        mbRules?: string;
        saRules?: string;
        modelProvider?: string;
        modelName?: string;
        /** 精准命中技能（JSON 数组字符串，如 '["skill1","skill2"]'） */
        pinnedSkills?: string;
        sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
        visualEnhancementEnabled?: boolean;
        subAgentSafetyFooterEnabled?: boolean;
        subAgentSafetyFooterText?: string;
    };
}

/**
 * 执行 Planning 任务的选项
 */
export interface ExecutePlanningOptions {
    /** Hub 模式下 @提及的 Agent 信息（动态传入） */
    mentionedAgent?: {
        id: string;
        name: string;
        hubId: string;
        mbRulesFilePath?: string;
        saRulesFilePath?: string;
        mbRules?: string;
        saRules?: string;
        modelProvider?: string;
        modelName?: string;
        /** 精准命中技能（JSON 数组字符串） */
        pinnedSkills?: string;
        sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
        visualEnhancementEnabled?: boolean;
        subAgentSafetyFooterEnabled?: boolean;
        subAgentSafetyFooterText?: string;
    };
    /** 附件列表（由 UI 层传入） */
    attachments?: AttachmentInfo[];
    /** 清空附件回调（发送成功后清理 UI 状态） */
    onClearAttachments?: () => void;
    /** 引用消息列表（由 UI 层传入，随用户消息一并发送） */
    quotes?: import('@/types/message').QuoteInfo[];
    /** 清空引用回调（发送成功后清理 UI 状态） */
    onClearQuotes?: () => void;
    /**
     * 额外的用户消息 metadata（合并到持久化的 user 消息中）
     * 例如定时任务触发时传入 { source: 'cron', cronJobId: '...' }
     * 用于后续 UI 过滤和历史上下文排除
     */
    userMessageMeta?: Record<string, unknown>;
    /**
     * 额外上下文数据（可选扩展点）
     *
     * 用途：IM 通道或绑定飞书 Bot 的 cron 触发时，经 AgentChatView 注入 imBotId，
     * 以便工具执行时精确定位当前 Bot（im_send 不影响其他机器人）。
     */
    extraContext?: Record<string, unknown>;
}

/**
 * usePlanningMode 返回值
 */
export interface UsePlanningModeReturn {
    /** 执行 Planning 任务 */
    executePlanningTask: (content: string, options?: ExecutePlanningOptions) => Promise<void>;
    /** 停止当前 Planning 任务 */
    stopPlanningTask: () => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 读取 Agent Rules 文件内容
 */
async function readRulesFile(filePath: string): Promise<string | undefined> {
    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const content = await readTextFile(filePath);
        return content.trim() || undefined;
    } catch (error) {
        logger.warn('[usePlanningMode] 读取 Rules 文件失败:', error);
        return undefined;
    }
}

function getNonEmptyRulesText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
}

/**
 * 清理文件夹名称（移除不安全字符）
 * 
 * Windows 不允许的字符: / \ : * ? " < > |
 * 同时替换空格为下划线，保留中文字符
 */
function sanitizeFolderName(name: string): string {
    return name
        .replace(/[/\\:*?"<>|]/g, '_')  // 替换不安全字符
        .replace(/\s+/g, '_')           // 替换空格
        .replace(/_+/g, '_')            // 合并连续下划线
        .replace(/^_|_$/g, '')          // 移除首尾下划线
        || 'unnamed';                   // 空名称兜底
}

/**
 * 对单条文本做首尾截断
 *
 * 策略：保留前 60%（通常是结论/完成状态）+ 后 40%（通常是总结/下一步建议），
 * 中间用省略提示连接。比纯头部截断能保留更多有效语义信息。
 *
 * 示例（budget = 100）：
 *   原文: "AAAA...（60字符）...BBBB...（中间省略）...CCCC...（40字符）"
 *
 * @param text 原始文本
 * @param budget 允许保留的最大字符数（含省略提示符本身的长度）
 * @returns 截断后的文本
 */
function truncateHeadAndTail(text: string, budget: number): string {
    if (text.length <= budget) return text;

    const ELLIPSIS = '... [truncated] ...';
    // 省略提示占用字符后，剩余分配给首尾
    const contentBudget = Math.max(0, budget - ELLIPSIS.length);
    // 前 60% 给头部（开头结论更关键），后 40% 给尾部
    const headChars = Math.floor(contentBudget * 0.6);
    const tailChars = contentBudget - headChars;

    const head = text.slice(0, headChars);
    const tail = tailChars > 0 ? text.slice(-tailChars) : '';

    return tail ? `${head}${ELLIPSIS}${tail}` : `${head}${ELLIPSIS}`;
}

/**
 * 构建引用上下文字符串，在用户居内容前拼接引用前缀
 *
 * 设计目标：无论引用内容多长，用户原始消息必然保留在最终拼接结果中，不会被
 * formatConversationHistory 的 MASTER_BRAIN_MAX_MESSAGE_CHARS(3000) 单条截断上限淹没。
 *
 * 动态配额算法：
 * 1. 计算引用区可用的总字符预算 = MAX_CHARS - 用户消息长度 - 分隔符 - 安全边距
 * 2. 将总预算平均分配到每条引用（至少保留 100 字符供语义感知）
 * 3. 不管引用多长或多少条，用户消息紧跟其后始终可见
 *
 * @param quotes 引用条目列表
 * @param userMessageContent 用户原始报文内容（用于动态计算引用配额）
 * @param maxTotalChars 单条消息最大允许字符数（与 formatConversationHistory 的截断上限一致）
 * @returns 引用前缀字符串（提供给外部拼接），无引用时返回 undefined
 */
function buildQuotesContext(
    quotes: Array<{ content: string; agentName?: string }>,
    userMessageContent: string,
    maxTotalChars = 5000
): string | undefined {
    if (quotes.length === 0) return undefined;

    // 计算引用区可用总字符数：
    // 预留 userMessage + 分隔符 "\n\n" + 50 字符安全边距，剩余全部属于引用区
    const SEPARATOR_CHARS = '\n\n'.length;
    const SAFETY_MARGIN = 80;
    const totalQuoteBudget = Math.max(
        0,
        maxTotalChars - userMessageContent.length - SEPARATOR_CHARS - SAFETY_MARGIN
    );

    // 每条引用的可用字符数：平均分配，至少保留 100 字符供语义感知
    // 每条引用的头部 prefix 无论如何都完整保留（"> [Quoted from X]:\n> " 小于 20 字符）
    const perQuoteBudget = Math.max(150, Math.floor(totalQuoteBudget / quotes.length));

    return quotes
        .map(q => {
            const truncated = truncateHeadAndTail(getQuoteContextContent(q), perQuoteBudget);
            return `> [Quoted from ${q.agentName ?? 'Hub'}]:\n> ${truncated}`;
        })
        .join('\n\n');
}

/**
 * 获取 Agent 工作目录
 * 
 * 使用应用数据目录下的 deliverables/<hubName>/<agentName> 文件夹作为工作目录
 * 名称经过清理以确保文件系统安全
 */
async function getAgentWorkdir(hubName: string, agentName: string): Promise<string | undefined> {
    try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        if (appData) {
            // 清理名称用于文件夹路径
            const safeHubName = sanitizeFolderName(hubName);
            const safeAgentName = sanitizeFolderName(agentName);
            // 工作目录 = deliverables/<hubName>/<agentName>
            const workdir = await join(appData, 'deliverables', safeHubName, safeAgentName);

            // 确保目录存在（递归创建），避免 exec 工具因 workdir 不存在而报 os error 267
            try {
                const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
                const dirExists = await exists(workdir);
                if (!dirExists) {
                    await mkdir(workdir, { recursive: true });
                    logger.trace('[usePlanningMode] 已创建 workdir:', workdir);
                }
            } catch (mkdirError) {
                logger.warn('[usePlanningMode] 创建 workdir 失败:', mkdirError);
            }

            logger.trace('[usePlanningMode] 使用 deliverables/<hub>/<agent> 目录作为 workdir:', workdir);
            return workdir;
        }
        return undefined;
    } catch (error) {
        logger.warn('[usePlanningMode] 获取 appDataDir 失败:', error);
        return undefined;
    }
}


/**
 * 安全解析精准命中技能 JSON 字符串为技能名称数组
 *
 * 输入 '["skill1","skill2"]' 或 undefined/null
 * 返回 string[] 或 undefined（无精准命中配置时）
 */
function parsePinnedSkills(raw: string | null | undefined): string[] | undefined {
    if (!raw) return undefined;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(s => typeof s === 'string')) {
            return parsed.slice(0, PLANNING_CONSTANTS.PINNED_SKILLS_MAX_COUNT);
        }
        return undefined;
    } catch {
        logger.warn('[usePlanningMode] 解析 pinnedSkills JSON 失败:', raw);
        return undefined;
    }
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * Planning 模式消息发送 Hook
 *
 * @param options - Hook 配置
 * @returns 执行方法
 *
 * @example Agent 模式
 * ```tsx
 * const { executePlanningTask } = usePlanningMode({
 *     contextType: 'agent',
 *     contextId: currentAgentId,
 *     agentConfig: { name: agent.name, hubId: agent.hubId, ... },
 * });
 *
 * await executePlanningTask(content);
 * ```
 *
 * @example Hub 模式
 * ```tsx
 * const { executePlanningTask } = usePlanningMode({
 *     contextType: 'hub',
 *     contextId: currentHubId,
 * });
 *
 * await executePlanningTask(content, {
 *     mentionedAgent: { id: agent.id, name: agent.name, ... },
 * });
 * ```
 */
export function usePlanningMode(options: UsePlanningModeOptions): UsePlanningModeReturn {
    const {
        contextType,
        contextId,
        agentConfig,
    } = options;

    const { toast } = useToast();
    const { t } = useI18n();
    // 同步防护：按 contextId 隔离，避免跨 Agent 共享导致的阻塞
    const sendingContextsRef = useRef<Set<string>>(new Set());
    // 预取消防护：按钮终止可能发生在 AgentService 引用挂载前，先记账，服务创建后立即取消。
    const cancelRequestedContextsRef = useRef<Set<string>>(new Set());
    // AgentService 引用（按 contextId 隔离，确保停止按钮取消正确 Agent 的任务）
    const agentServiceMapRef = useRef<Map<string, { cancelProcessing: () => void }>>(new Map());

    // 从 settingsStore 获取默认配置
    const defaultProvider = useSettingsStore((s) => s.defaultProvider);
    const defaultModel = useSettingsStore((s) => s.defaultModel);
    const localApiUrl = useSettingsStore((s) => s.localApiUrl);

    // chatStore 方法
    const addMessage = useChatStore((s) => s.addMessage);
    const addHubMessage = useChatStore((s) => s.addHubMessage);
    const startSending = useChatStore((s) => s.startSending);
    const finishSending = useChatStore((s) => s.finishSending);

    // FSM 可视化 Store（直接使用 Store 而非 Hook）
    const fsmVisualizationActions = useFSMVisualizationStore();

    /**
     * 执行 Planning 任务
     */
    const executePlanningTask = useCallback(async (
        content: string,
        executeOptions?: ExecutePlanningOptions
    ): Promise<void> => {
        if (!contextId || sendingContextsRef.current.has(contextId)) return;

        const {
            mentionedAgent,
            attachments = [],
            onClearAttachments,
            quotes = [],
            onClearQuotes,
            userMessageMeta,
            extraContext,
        } = executeOptions ?? {};

        // 从额外上下文中提取 imBotId（由 IM 或绑定飞书 Bot 的 cron 注入）
        const imBotId = extraContext?.imBotId as string | undefined;
        const imTaskId = extraContext?.imTaskId as string | undefined;

        // 确定有效的 Agent 配置
        // Agent 模式：使用 agentConfig
        // Hub 模式：使用 mentionedAgent
        const effectiveAgentConfig = contextType === 'agent'
            ? agentConfig
            : mentionedAgent
                ? {
                    id: mentionedAgent.id,
                    name: mentionedAgent.name,
                    hubId: mentionedAgent.hubId,
                    mbRulesFilePath: mentionedAgent.mbRulesFilePath,
                    saRulesFilePath: mentionedAgent.saRulesFilePath,
                    mbRules: mentionedAgent.mbRules,
                    saRules: mentionedAgent.saRules,
                    modelProvider: mentionedAgent.modelProvider,
                    modelName: mentionedAgent.modelName,
                    pinnedSkills: mentionedAgent.pinnedSkills,
                    sandboxMode: mentionedAgent.sandboxMode,
                    visualEnhancementEnabled: mentionedAgent.visualEnhancementEnabled,
                    subAgentSafetyFooterEnabled: mentionedAgent.subAgentSafetyFooterEnabled,
                    subAgentSafetyFooterText: mentionedAgent.subAgentSafetyFooterText,
                }
                : undefined;

        if (!effectiveAgentConfig) {
            logger.warn('[usePlanningMode] 无有效的 Agent 配置');
            return;
        }

        // 确定消息关联的 Agent ID
        // Agent 模式：使用 contextId
        // Hub 模式：使用 mentionedAgent.id（满足外键约束）
        const messageAgentId = contextType === 'agent'
            ? contextId
            : mentionedAgent?.id;

        if (!messageAgentId) {
            logger.warn('[usePlanningMode] 无有效的 messageAgentId');
            return;
        }

        sendingContextsRef.current.add(contextId);
        cancelRequestedContextsRef.current.delete(contextId);
        startSending(contextId);

        if (imBotId) {
            const activeImTask = getActiveImTask(imBotId);
            const taskIdToMark = imTaskId ?? activeImTask?.id;
            if (taskIdToMark) {
                markImTaskStarted(imBotId, taskIdToMark);
            }
        }

        const {
            startStreaming,
            finishStreaming,
        } = useChatStore.getState();

        // 用于追踪 onDiffData 回调中创建的临时 messageId
        // 关键：消息持久化后需要更新为真实 ID
        let tempMessageIdForDiff: string | undefined;
        let createdUserMessageId: string | null = null;
        let planningCheckpointMessage: PersistedMessageResult | null = null;
        const checkpointFlushTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
        let checkpointFlushPromise: Promise<void> | null = null;
        let checkpointDirty = false;
        let checkpointFinalized = false;

        // 收集思维链数据用于持久化
        const thinkingChainData: {
            analyzing: string;
            planning: string;
            decided: string;
        } = { analyzing: '', planning: '', decided: '' };
        const reasoningTraceData: PlanningReasoningTraceData = {
            content: '',
            isCompleted: false,
        };

        // 收集 Sub-Agent 观测数据用于持久化（与 thinkingChainData 同理）
        const subAgentObservationsData: import('@/services/planning/agent-loop/types').SubAgentObservationEvent[] = [];

        const isCreatedUserMessageStillPresent = () => {
            const messages = contextType === 'agent'
                ? useChatStore.getState().messagesByAgent.get(contextId) ?? []
                : useChatStore.getState().messagesByHub.get(contextId) ?? [];
            return isMessagePresentInList(messages, createdUserMessageId);
        };

        const buildPlanningCheckpointObservationText = (): string => {
            return buildPlanningCheckpointProgressText(
                thinkingChainData,
                subAgentObservationsData,
                t
            );
        };

        const buildPlanningCheckpointMetadata = (
            status: PlanningCheckpointStatus,
            errorMessage?: string
        ): Record<string, unknown> => ({
            responseType: status === 'running'
                ? 'agent_loop_checkpoint'
                : status === 'failed'
                    ? 'error'
                    : 'agent_loop_checkpoint_abandoned',
            mode: 'planning' as const,
            agentLoopStatus: status,
            recoverable: status !== 'abandoned',
            createdUserMessageId,
            error: errorMessage,
            reasoningTrace: reasoningTraceData.content.trim()
                ? { ...reasoningTraceData }
                : undefined,
            thinkingChain: thinkingChainData,
            thinkingSteps: fsmVisualizationActions.getContextState(contextId).thinkingSteps
                .map(step => ({
                    stepNumber: step.stepNumber,
                    analyzing: step.analyzing,
                    planning: step.planning,
                    decided: step.decided,
                })),
            subAgentObservations: subAgentObservationsData.length > 0
                ? subAgentObservationsData.slice(-PLANNING_CHECKPOINT_OBSERVATION_LIMIT)
                : undefined,
            persistContent: status === 'abandoned'
                ? ''
                : t('chat.planningCheckpointPersistContent', {
                    observations: buildPlanningCheckpointObservationText(),
                }),
            ...(contextType === 'hub' ? {
                sourceType: 'hub' as const,
                hubId: contextId,
                agentName: effectiveAgentConfig.name,
            } : {}),
        });

        const updatePlanningCheckpoint = async (
            status: PlanningCheckpointStatus,
            errorMessage?: string
        ): Promise<PersistedMessageResult | null> => {
            if (!planningCheckpointMessage || checkpointFinalized) return null;
            const contentForStatus = status === 'failed'
                ? `**${t('chat.planningExecutionFailed')}**\n\n${errorMessage ?? t('chat.processingFailed')}`
                : status === 'abandoned'
                    ? ''
                    : t('chat.planningCheckpointRunningContent');
            const updated = await invoke<PersistedMessageResult>('message_update', {
                request: {
                    id: planningCheckpointMessage.id,
                    content: contentForStatus,
                    metadata: JSON.stringify(buildPlanningCheckpointMetadata(status, errorMessage)),
                },
            });
            planningCheckpointMessage = updated;
            return updated;
        };

        const flushPlanningCheckpointNow = (): Promise<void> => {
            if (!planningCheckpointMessage || checkpointFinalized) {
                return Promise.resolve();
            }
            if (checkpointFlushPromise) return checkpointFlushPromise;

            checkpointDirty = false;
            const promise = updatePlanningCheckpoint('running')
                .catch((error: unknown) => {
                    logger.warn('[usePlanningMode] Planning checkpoint 更新失败:', error);
                })
                .then(() => undefined)
                .finally(() => {
                    if (checkpointFlushPromise === promise) {
                        checkpointFlushPromise = null;
                    }
                    if (checkpointDirty && !checkpointFinalized && !checkpointFlushTimerRef.current) {
                        schedulePlanningCheckpointFlush();
                    }
                });
            checkpointFlushPromise = promise;
            return promise;
        };

        const schedulePlanningCheckpointFlush = (): void => {
            if (!planningCheckpointMessage || checkpointFinalized) return;
            checkpointDirty = true;
            if (checkpointFlushTimerRef.current) return;
            checkpointFlushTimerRef.current = setTimeout(() => {
                checkpointFlushTimerRef.current = null;
                if (!checkpointDirty || checkpointFinalized) return;
                void flushPlanningCheckpointNow();
            }, PLANNING_CHECKPOINT_FLUSH_INTERVAL_MS);
        };

        const stopPlanningCheckpointFlushes = async (): Promise<void> => {
            if (checkpointFlushTimerRef.current) {
                clearTimeout(checkpointFlushTimerRef.current);
                checkpointFlushTimerRef.current = null;
            }
            checkpointDirty = false;
            if (checkpointFlushPromise) {
                await checkpointFlushPromise;
            }
        };

        const deletePlanningCheckpoint = async (reason: string): Promise<void> => {
            await stopPlanningCheckpointFlushes();
            if (!planningCheckpointMessage || checkpointFinalized) return;

            const checkpointId = planningCheckpointMessage.id;
            checkpointFinalized = true;
            try {
                await invoke('message_delete', { id: checkpointId });
                logger.debug('[usePlanningMode] Planning checkpoint 已删除:', reason);
            } catch (error) {
                logger.debug('[usePlanningMode] Planning checkpoint 删除跳过或失败:', reason, error);
                try {
                    await invoke('message_update', {
                        request: {
                            id: checkpointId,
                            content: '',
                            metadata: JSON.stringify(buildPlanningCheckpointMetadata('abandoned', reason)),
                        },
                    });
                    logger.debug('[usePlanningMode] Planning checkpoint 已标记为 abandoned:', reason);
                } catch (abandonError) {
                    logger.debug('[usePlanningMode] Planning checkpoint abandoned 标记跳过或失败:', abandonError);
                }
            } finally {
                planningCheckpointMessage = null;
            }
        };

        try {
            // ====== 步骤 0:  重置 FSM 可视化状态（绑定当前 Agent contextId，防止跨 Agent 思考内容泄露） ======
            const attachmentsForSend = attachments.length > 0
                ? await (await import('@services/attachment')).attachmentService.hydrateAttachmentsForContext(
                    attachments,
                    messageAgentId
                )
                : [];

            fsmVisualizationActions.reset(contextId);

            // ====== 步骤 1: 创建并添加用户消息 ======
            // Hub 模式的消息需要标记 sourceType 以便加载时过滤
            // 用户消息 metadata 中保存附件信息（与 Chat 模式一致）
            const userMetadata = {
                ...(attachmentsForSend.length > 0 ? { attachments: attachmentsForSend } : {}),
                ...(contextType === 'hub' ? { sourceType: 'hub' as const, hubId: contextId } : {}),
                // quotedFrom 写入 metadata，重启后能从 DB 恢复引用内容展示
                ...(quotes.length > 0 ? { quotedFrom: serializeQuotesForMessage(quotes) } : {}),
                // 合并调用方注入的额外 metadata（如定时任务标识 source:'cron'）
                ...(userMessageMeta ?? {}),
            };
            const hasUserMetadata = Object.keys(userMetadata).length > 0;

            const userMessageResult = await invoke<{
                id: string;
                agentId: string;
                role: string;
                content: string;
                createdAt: number;
            }>('message_create', {
                request: {
                    agentId: messageAgentId,
                    role: 'user',
                    content,
                    metadata: hasUserMetadata ? JSON.stringify(userMetadata) : undefined,
                },
            });
            createdUserMessageId = userMessageResult.id;

            // 添加到 Store，同时携带引用消息（quotedFrom 仅用于 UI 展示，不进入 LLM 上下文）
            const userMessage = {
                id: userMessageResult.id,
                content,
                role: 'user' as const,
                agentId: messageAgentId,
                createdAt: userMessageResult.createdAt,
                // 引用内容：将 QuoteInfo[] 映射为 Message.quotedFrom 格式
                quotedFrom: quotes.length > 0
                    ? serializeQuotesForMessage(quotes)
                    : undefined,
                metadata: hasUserMetadata ? userMetadata : undefined,
            };

            if (contextType === 'agent') {
                addMessage(contextId, userMessage);
            } else {
                addHubMessage(contextId, userMessage);
            }

            // 用户消息发送成功，立即清空附件预览和引用预览
            if (attachmentsForSend.length > 0 && onClearAttachments) {
                onClearAttachments();
            }
            // 引用消息在用户消息成功入库后清空，避免发送失败时引用丢失
            if (quotes.length > 0 && onClearQuotes) {
                onClearQuotes();
            }

            // 复制附件用于后续处理（已在清空前获取）
            const attachmentsToSend = [...attachmentsForSend];

            // ====== 步骤 2: 显示加载状态 ======
            startStreaming(contextId, effectiveAgentConfig.name);

            try {
                planningCheckpointMessage = await invoke<PersistedMessageResult>('message_create', {
                    request: {
                        agentId: messageAgentId,
                        role: 'assistant',
                        content: t('chat.planningCheckpointRunningContent'),
                        metadata: JSON.stringify(buildPlanningCheckpointMetadata('running')),
                    },
                });
                logger.debug('[usePlanningMode] Planning checkpoint 已创建:', planningCheckpointMessage.id);
            } catch (checkpointError) {
                logger.warn('[usePlanningMode] Planning checkpoint 创建失败，任务将继续执行:', checkpointError);
            }

            // ====== 步骤 3: 获取或创建 AgentService ======
            const { getOrCreateAgentService } = await import('@services/planning/AgentService');

            // 优先使用直接粘贴的 Rules 文本，旧版文件路径仅作为兼容 fallback。
            const mbAgentRules = getNonEmptyRulesText(effectiveAgentConfig.mbRules)
                ?? (effectiveAgentConfig.mbRulesFilePath
                    ? await readRulesFile(effectiveAgentConfig.mbRulesFilePath)
                    : undefined);
            const saAgentRules = getNonEmptyRulesText(effectiveAgentConfig.saRules)
                ?? (effectiveAgentConfig.saRulesFilePath
                    ? await readRulesFile(effectiveAgentConfig.saRulesFilePath)
                    : undefined);

            // 向后兼容：将新字段传入 AgentServiceConfig
            const agentRulesForService = {
                mbAgentRules,
                saAgentRules,
            };

            // 获取工作目录
            const hub = useHubStore.getState().hubs.find(h => h.id === effectiveAgentConfig.hubId);
            const hubName = hub?.name ?? 'default';
            const workdir = await getAgentWorkdir(hubName, effectiveAgentConfig.name);

            const effectiveProvider = effectiveAgentConfig.modelProvider ?? defaultProvider;
            const effectiveModel = effectiveAgentConfig.modelName ?? defaultModel;
            const supportsVisionInput = modelSupportsVision(effectiveModel, effectiveProvider);

            // Agent 头像注入（从 agentStore 获取当前 Agent 的 avatar base64 数据）
            // 用于 MB System Prompt 后以合成 user 消息方式注入身份形象感知
            let agentAvatarBase64: string | undefined;
            // per-agent MB 决策轮次预算（null/undefined 时使用全局默认值）
            let mbDecisionBudget: number | undefined;
            // 用户关联的外部项目路径（null/undefined 时表示未关联）
            let projectPath: string | undefined;
            let sandboxMode: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork' =
                effectiveAgentConfig.sandboxMode ?? 'LocalAudit';
            let visualEnhancementEnabled = effectiveAgentConfig.visualEnhancementEnabled !== false;
            let subAgentSafetyFooterEnabled = effectiveAgentConfig.subAgentSafetyFooterEnabled === true;
            let subAgentSafetyFooterText = effectiveAgentConfig.subAgentSafetyFooterText;
            try {
                const { useAgentStore } = await import('@stores/agentStore');
                const agents = useAgentStore.getState().agents;
                const currentAgent = agents.find(a => a.id === messageAgentId);
                if (currentAgent?.avatar) {
                    // 移除 data URL 前缀（若有），统一为纯 base64 字符串
                    const avatarRaw = currentAgent.avatar;
                    const base64Match = avatarRaw.match(/^data:[^;]+;base64,(.+)$/);
                    agentAvatarBase64 = base64Match?.[1] ?? avatarRaw;
                }
                // 读取 per-agent 决策预算，null 表示使用全局默认，转为 undefined 传递
                if (currentAgent?.planningLoopBudget != null) {
                    mbDecisionBudget = currentAgent.planningLoopBudget;
                }
                // 读取用户关联的外部项目路径（用户在授权弹窗确认后持久化）
                // 有设置时 SA 的 cwd 会切换为该路径（方案B）
                if (currentAgent?.projectPath) {
                    projectPath = currentAgent.projectPath;
                }
                sandboxMode = currentAgent?.sandboxMode ?? sandboxMode;
                if (currentAgent) {
                    visualEnhancementEnabled = currentAgent.visualEnhancementEnabled !== false;
                }
                subAgentSafetyFooterEnabled = currentAgent?.subAgentSafetyFooterEnabled === true;
                subAgentSafetyFooterText = currentAgent?.subAgentSafetyFooterText ?? subAgentSafetyFooterText;
            } catch (avatarError) {
                // avatar/budget/projectPath 读取失败不影响主流程
                logger.warn('[usePlanningMode] 读取 Agent avatar/budget/projectPath 失败:', avatarError);
            }

            const agentService = getOrCreateAgentService({
                agentId: messageAgentId,
                agentName: effectiveAgentConfig.name,
                mbAgentRules: agentRulesForService.mbAgentRules,
                saAgentRules: agentRulesForService.saAgentRules,
                providerId: effectiveProvider,
                modelId: effectiveModel,
                workdir,
                // Local 代理使用配置的 API URL
                baseUrl: effectiveProvider === 'local' ? localApiUrl : undefined,
                // 上下文 ID 用于 Session 隔离（Hub 模式使用 hubId，Agent 模式使用 agentId）
                contextId: contextId,
                // Hub @提及模式禁用 RAG 检索（与 Chat 模式一致，减少上下文压力）
                enableRag: contextType === 'agent',
                // 精准命中技能：解析 JSON 数组字符串为技能名称数组
                pinnedSkills: parsePinnedSkills(effectiveAgentConfig.pinnedSkills),
                // Agent 头像（身份形象感知注入）
                agentAvatar: agentAvatarBase64,
                // per-agent MB 决策轮次预算（undefined 时 AgentService 使用全局默认值）
                mbDecisionBudget,
                // 用户已授权的外部项目路径：有値时 SA 的 cwd 会切换为该路径（方案B）
                projectPath,
                sandboxMode,
                subAgentSafetyFooterEnabled,
                subAgentSafetyFooterText,
            });

            // ====== 步骤 3.3: 处理附件内容 ======
            // 构建附件文本内容，后续通过 processMessage 的 attachmentContent 选项注入
            let attachmentContent: string | undefined;
            // 结构化附件路径清单，用于注入 Sub-Agent TaskContext
            let attachmentReferences: TaskAttachmentReference[] | undefined;
            // 图片 base64 数据列表（与 attachmentContent 同级作用域，供 processMessage 使用）
            let imageDataForLLM: Array<{ mime_type: string; data: string }> = [];
            if (attachmentsToSend.length > 0) {
                attachmentReferences = buildAttachmentReferences(attachmentsToSend);

                try {
                    const imageAttachments = attachmentsToSend.filter(a => a.type === 'image');

                    const { attachmentService } = await import('@services/attachment');
                    let builtContent = attachmentService.buildAttachmentContext(
                        attachmentsToSend,
                        { mode: 'planning' }
                    ) || '';

                    // 图片附件：提取 base64 数据用于多模态传递，同时注入文件名提示到文本上下文
                    if (supportsVisionInput && imageAttachments.length > 0) {
                        // 构建 base64 图片数据供后端多模态处理
                        imageDataForLLM = imageAttachments
                            .flatMap(img => {
                                if (!img.base64Data) return [];
                                let base64 = img.base64Data;
                                // 移除 data:image/xxx;base64, 前缀（如果有）
                                const base64Match = base64.match(/^data:([^;]+);base64,(.+)$/);
                                if (base64Match?.[2]) {
                                    base64 = base64Match[2];
                                }
                                const ext = img.fileExtension;
                                return [{
                                    mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                                    data: base64,
                                }];
                            });

                        // 同时注入文件名提示到文本上下文（供 MasterBrain 参考）
                        const imageDescriptions = imageAttachments
                            .map(img => `- Image: ${img.fileName} (${img.fileExtension}, ${Math.round((img.size || 0) / 1024)}KB)`)
                            .join('\n');
                        const imageHint = `\n\n## User-Uploaded Images\n${imageDescriptions}\n(Note: image content is attached to the user message for visual understanding.)`;
                        builtContent += imageHint;
                        logger.trace('[usePlanningMode] 📷 已准备', imageDataForLLM.length, '张图片的 base64 数据');
                    }

                    if (builtContent.trim()) {
                        attachmentContent = builtContent;
                        logger.trace('[usePlanningMode] ✅ 附件内容已准备:', builtContent.length, '字符');
                    }
                } catch (attachmentError) {
                    logger.warn('[usePlanningMode] 附件处理失败:', attachmentError);
                    // 不阻塞主流程
                }
            }

            // 保存引用（用于取消，按 contextId 隔离）
            agentServiceMapRef.current.set(contextId, agentService);
            if (cancelRequestedContextsRef.current.has(contextId)) {
                agentService.cancelProcessing();
                logger.debug('[usePlanningMode] 检测到预取消请求，AgentService 创建后立即取消, contextId:', contextId);
            }

            // ====== 步骤 3.5: 加载历史对话 ======
            const storedMessages = contextType === 'agent'
                ? useChatStore.getState().messagesByAgent.get(contextId) ?? []
                : useChatStore.getState().messagesByHub.get(contextId) ?? [];
            const checkpointMessageIdsForHistory = new Set<string>();
            storedMessages.forEach((message, index) => {
                if (!isRecoverablePlanningCheckpointMessage(message, storedMessages)) return;
                const hasLaterNonCurrentMessage = storedMessages
                    .slice(index + 1)
                    .some(candidate => candidate.id !== userMessageResult.id && candidate.role !== 'system');
                if (!hasLaterNonCurrentMessage) {
                    checkpointMessageIdsForHistory.add(message.id);
                }
            });

            const historyMessages = storedMessages
                .filter(m => {
                    // 排除系统消息和当前刚创建的用户消息
                    if (m.role === 'system' || m.id === userMessageResult.id) return false;
                    // 中断 checkpoint 只注入紧随其后的下一次请求。后续轮次保留 UI 气泡，
                    // 但不再进入 LLM 历史，避免恢复提示长期污染上下文。
                    if (isPlanningCheckpointMessage(m)) {
                        return isRecoverablePlanningCheckpointMessage(m, storedMessages)
                            && checkpointMessageIdsForHistory.has(m.id);
                    }
                    // 排除定时任务触发的 user 消息，避免重复 prompt 污染上下文窗口
                    // IM 消息保留在上下文中，方便 Agent 连续对话时有完整记忆
                    if (m.role === 'user' && m.metadata) {
                        const meta = m.metadata as Record<string, unknown>;
                        if (meta.source === 'cron') return false;
                    }
                    return true;
                })
                .map(m => {
                    let effectiveContent = getPlanningHistoryEffectiveContent(m);

                    // 跨轮/重启后引用内容恢复：
                    // user 消息入库时 content 字段存原始内容（不含引用前缀），引用数据存入 metadata.quotedFrom。
                    // Session 重建后从 DB 加载历史时，需从 metadata 恢复引用前缀，
                    // 确保 MB 在 [CONVERSATION_HISTORY] 中看到完整的引用上下文。
                    // 动态配额：根据原始消息长度自动计算每条引用可用字符，用户消息必然可见。
                    if (m.role === 'user' && m.metadata) {
                        interface QuotedFromItem { content: string; agentName?: string }
                        const quotedFrom = (m.metadata as Record<string, unknown>).quotedFrom as QuotedFromItem[] | undefined;
                        if (quotedFrom && quotedFrom.length > 0) {
                            const recoveredContext = buildQuotesContext(quotedFrom, effectiveContent);
                            if (recoveredContext) {
                                effectiveContent = `${recoveredContext}\n\n${effectiveContent}`;
                            }
                        }

                        const historicalAttachmentContext = buildHistoricalAttachmentContext(
                            getHistoricalMessageAttachments(m.metadata),
                            effectiveContent,
                            t
                        );
                        if (historicalAttachmentContext) {
                            effectiveContent = `${historicalAttachmentContext}\n\n${effectiveContent}`;
                        }
                    }

                    const base: {
                        role: 'user' | 'assistant';
                        content: string;
                        createdAt?: number;
                        images?: Array<{ mime_type: string; data: string }>;
                    } = {
                        role: m.role as 'user' | 'assistant',
                        content: effectiveContent,
                        // 传递消息时间戳，让 CONVERSATION_HISTORY 渲染时间标签
                        createdAt: m.createdAt,
                    };


                    // 恢复历史 user 消息的图片附件（从 metadata.attachments 中读取 base64Data）
                    // 图片绑定原始消息，避免跨话题时注入无关噪音
                    if (supportsVisionInput && m.role === 'user' && m.metadata) {
                        const attachmentsList = (m.metadata as { attachments?: Array<{ type: string; base64Data?: string; fileExtension?: string }> }).attachments;
                        if (attachmentsList) {
                            const imgAttachments = attachmentsList.filter(
                                (a) => a.type === 'image' && a.base64Data
                            );
                            if (imgAttachments.length > 0) {
                                base.images = imgAttachments.flatMap((img) => {
                                    if (!img.base64Data) return [];
                                    let b64 = img.base64Data;
                                    const match = b64.match(/^data:([^;]+);base64,(.+)$/);
                                    if (match?.[2]) b64 = match[2];
                                    const ext = img.fileExtension ?? 'webp';
                                    return [{
                                        mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
                                        data: b64,
                                    }];
                                });
                                logger.trace('[usePlanningMode] 🖼️ 恢复历史 user 消息图片:', base.images.length, '张');
                            }
                        }
                    }

                    // 恢复上一轮 assistant 通过 generate_image 生成的最后一张图片。
                    // 完整路径仍保留在 metadata.generatedImages 中供 UI 展示和用户显式引用。
                    if (supportsVisionInput && m.role === 'assistant' && m.metadata) {
                        const genImages = (m.metadata as { generatedImages?: string[] }).generatedImages;
                        if (genImages && genImages.length > 0) {
                            // 标记需要异步加载的图片路径（在 map 外统一处理）
                            (base as { _pendingImagePaths?: string[] })._pendingImagePaths = genImages;
                        }
                    }

                    return base;
                });

            // 异步解析 assistant 消息标记的生成图片路径为 base64
            // 使用 Promise.allSettled 确保单张图片失败不阻塞整体
            const latestHistoryMessage = historyMessages[historyMessages.length - 1] as
                | ({ _pendingImagePaths?: string[] })
                | undefined;
            for (const msg of historyMessages) {
                const pending = (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
                if (!pending || pending.length === 0) continue;

                if (msg === latestHistoryMessage) {
                    const latestPath = pending[pending.length - 1];
                    (msg as { _pendingImagePaths?: string[] })._pendingImagePaths = latestPath ? [latestPath] : undefined;
                } else {
                    delete (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
                }
            }

            for (const msg of historyMessages) {
                const pending = (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
                if (pending && pending.length > 0) {
                    try {
                        const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
                        const results = await Promise.allSettled(
                            pending.map(async (imgPath) => {
                                const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
                                const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
                                const base64 = await tauriInvoke<string>('file_read_as_base64', { path: imgPath });
                                return { mime_type: mimeType, data: base64 };
                            })
                        );
                        const loadedImages = results
                            .filter((r): r is PromiseFulfilledResult<{ mime_type: string; data: string }> => r.status === 'fulfilled')
                            .map(r => r.value);
                        if (loadedImages.length > 0) {
                            msg.images = loadedImages;
                            logger.trace('[usePlanningMode] 🖼️ 恢复历史 assistant 生成图片:', loadedImages.length, '张');
                        }
                    } catch (error) {
                        // 图片恢复失败不影响对话流程（文件可能已被删除）
                        logger.warn('[usePlanningMode] assistant 图片恢复失败:', error);
                    }
                    // 清理临时标记
                    delete (msg as { _pendingImagePaths?: string[] })._pendingImagePaths;
                }
            }

            if (historyMessages.length > 0) {
                agentService.loadChatHistory(historyMessages);
            }

            // ====== 步骤 4: 执行 AgentLoop ======
            // 构建引用上下文字符串，注入到 LLM 消息内容前（与 Chat 模式保持一致）
            // 动态配额：根据用户消息长度自动计算每条引用可用字符，
            // 确保用户原始消息在 formatConversationHistory 字符单条上限中始终可见。
            const quotesContext = buildQuotesContext(quotes, content);
            // 组合用户消息：引用上下文（若有）+ 实际消息内容
            const contentWithQuotes = quotesContext
                ? `${quotesContext}\n\n${content}`
                : content;

            const result = await agentService.processMessage(contentWithQuotes, {
                // 附件文本内容注入（通过 RuntimeContext.attachments）
                attachmentContent,
                // 附件路径清单注入（通过 Sub-Agent TaskContext）
                attachmentReferences: attachmentReferences?.length ? attachmentReferences : undefined,
                // 图片 base64 数据注入（通过 AgentLoop.config.imageAttachments → 首轮 LLM 调用）
                imageAttachments: imageDataForLLM.length > 0 ? imageDataForLLM : undefined,
                // IM/cron 触发时携带的机器人 ID，经由 AgentLoop → ToolExecutionContext 传递给工具
                // im_send 通过此字段精确识别当前机器人，实现多 Bot 路由隔离
                imBotId,
                // Diff 数据回调：EditTool / FileWriteTool 返回预览时触发
                onDiffData: (diffData) => {
                    void (async () => {
                        logger.trace('[usePlanningMode] 收到 Diff 数据:', diffData.filePath);
                        const { useDiffStore } = await import('@stores/diffStore');
                        tempMessageIdForDiff = `temp_${Date.now()}`;
                        const extractedFileName = diffData.filePath.split(/[/\\]/).pop() ?? 'document';
                        if (contextId && diffData.xml) {
                            useDiffStore.getState().setCurrentContext(contextId);
                            // 统一走 loadModifications（file_write 覆盖模式现已由 DiffToXmlConverter 生成 XML）
                            await useDiffStore.getState().loadModifications(
                                contextId,
                                diffData.filePath,
                                diffData.originalContent,
                                diffData.xml,
                                tempMessageIdForDiff,
                                extractedFileName,
                                false,                    // isRestoring
                                undefined,                // currentContentForInference
                                diffData.newContent,      // preAppliedContent（LLM 写入的新内容）
                            );
                            logger.trace('[usePlanningMode] ✅ Diff 数据已加载到 diffStore');
                        }
                    })().catch((error: unknown) => {
                        logger.error('[usePlanningMode] Diff 数据加载失败:', error);
                    });
                },

                // ====== FSM 可视化回调 (Phase 1) ======
                onThinkingPhase: (event) => {
                    fsmVisualizationActions.handleThinkingPhaseEvent(event, contextId);
                    // CONTENT carries a full phase snapshot during MB streaming, so persist by replacement.
                    if (event.type === 'CONTENT' && event.content) {
                        if (event.phase === 'ANALYZING') {
                            thinkingChainData.analyzing = event.content;
                        } else if (event.phase === 'PLANNING') {
                            thinkingChainData.planning = event.content;
                        } else if (event.phase === 'DECIDED') {
                            thinkingChainData.decided = event.content;
                        }
                        schedulePlanningCheckpointFlush();
                    }
                    // IM 追踪器转发：将思维链事件推送到飞书卡片（以 imBotId 精确路由）
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker && event.type === 'CONTENT' && event.content) {
                        imTracker.handleThinkingPhase({
                            phase: event.phase.toLowerCase(),
                            content: event.content,
                        });
                    }
                },
                onReasoningTrace: (event) => {
                    fsmVisualizationActions.handleReasoningTraceEvent(event, contextId);
                    switch (event.type) {
                        case 'START':
                        case 'CONTENT':
                            reasoningTraceData.content = event.content ?? '';
                            reasoningTraceData.isCompleted = false;
                            break;
                        case 'COMPLETE':
                            reasoningTraceData.content = event.content ?? reasoningTraceData.content;
                            reasoningTraceData.isCompleted = Boolean(reasoningTraceData.content.trim());
                            break;
                    }
                    schedulePlanningCheckpointFlush();
                },
                onMetricsUpdate: (snapshot) => {
                    fsmVisualizationActions.updateMetrics(snapshot, contextId);
                },
                onFSMStateChange: (from, to) => {
                    // 类型转换：AgentLoopCallbacks 使用 string，Store 使用 AgentServiceState
                    fsmVisualizationActions.handleFSMStateChange(
                        from as import('@/services/planning/fsm/types').AgentServiceState,
                        to as import('@/services/planning/fsm/types').AgentServiceState,
                        contextId
                    );
                    // IM 追踪器转发：FSM 状态变化
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker) {
                        imTracker.handleStateChange(from, to);
                    }
                },

                // ====== Sub-Agent 实时观测回调 ======
                onSubAgentObservation: (event) => {
                    fsmVisualizationActions.addSubAgentObservation(event, contextId);
                    // IM 追踪器转发：imBotId 精确路由到对应 Bot 的飞书卡片
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker) {
                        imTracker.handleSubAgentObservation(event);
                    }
                    // 同时收集到持久化数组中
                    upsertSubAgentObservationEvent(subAgentObservationsData, event);
                    schedulePlanningCheckpointFlush();
                },
                onSubAgentSpawn: () => {
                    // Sub-Agent 创建时标记运行中；观测记录保留全轮次历史，由 runId 隔离分组。
                    fsmVisualizationActions.setSubAgentRunning(true, contextId);
                    // IM 追踪器转发（imBotId 精确路由）
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker) {
                        imTracker.handleSubAgentSpawn('Sub-Agent');
                    }
                    schedulePlanningCheckpointFlush();
                },
                onSubAgentComplete: () => {
                    fsmVisualizationActions.setSubAgentRunning(false, contextId);
                    // IM 追踪器转发（imBotId 精确路由）
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker) {
                        imTracker.handleSubAgentComplete();
                    }
                    schedulePlanningCheckpointFlush();
                },
                onSubAgentFail: () => {
                    fsmVisualizationActions.setSubAgentRunning(false, contextId);
                    // IM 追踪器转发（imBotId 精确路由）
                    const imTracker = getActiveImTracker(imBotId);
                    if (imTracker) {
                        imTracker.handleSubAgentFail('Sub-Agent execution failed');
                    }
                    schedulePlanningCheckpointFlush();
                },

                // Embedding 警告回调：语义检索降级时向用户弹出非阻塞性提示
                // 使用 warning 级别而非 error，因为消息流程将降级继续执行（只是缺少记忆检索助力）
                onEmbeddingWarning: (errorMessage) => {
                    logger.warn('[usePlanningMode] Embedding 服务降级，已通知用户:', errorMessage);
                    toast({
                        type: 'warning',
                        title: t('chat.toastEmbeddingDegradedTitle'),
                        description: t('chat.toastEmbeddingDegradedDescription'),
                        duration: 8000,
                    });
                },
            });

            // ====== 步骤 5: 处理执行结果 ======
            if (!result.success) {
                throw new Error(result.error ?? t('chat.processingFailed'));
            }

            // ====== 步骤 5.2: IM 通道提前回复（可视化增强前发送原始纯文本到飞书）======
            // 飞书手机端不支持渲染 echarts/mermaid 代码块，可视化增强后的内容在飞书会
            // 显示为原始的长篇代码块，体验极差。
            // 因此在增强前先用纯文本版本回复飞书，本地 UI 仍然使用增强后内容，两端各取所长。
            const preEnhanceImTask = getActiveImTask(imBotId);
            if (preEnhanceImTask) {
                if (result.terminationReason === 'cancelled') {
                    // 桌面端手动终止任务：cancelled 是正常返回路径（result.success=true），
                    // 不会走 catch 块，必须在此显式通知飞书端，否则飞书卡片将永远挂起。
                    emit('im:task_failed', {
                        taskId: preEnhanceImTask.id,
                        error: t('im.bridge.abortedByUser'),
                        botId: imBotId,
                    }).catch((emitError: unknown) => {
                        logger.warn('[usePlanningMode] 发射 im:task_failed (cancelled) 失败:', emitError);
                    });
                } else {
                    // 正常完成：防御性剥离可视化格式代码块，飞书手机端无法渲染这些格式
                    const imSafeContent = stripVisualCodeBlocks(result.content);
                    emit('im:task_completed', {
                        taskId: preEnhanceImTask.id,
                        result: imSafeContent.slice(0, 2000),
                        iterationCount: result.iterationCount,
                        botId: imBotId,
                    }).catch((emitError: unknown) => {
                        logger.warn('[usePlanningMode] 提前发射 im:task_completed 失败:', emitError);
                    });
                }
            }

            // ====== 步骤 5.5: 可视化增强（Post-Processor） ======
            // MB 输出纯文本 response 后，调用轻量级 LLM 将内容增强为带有
            // Widget/ECharts/Mermaid 交互格式的版本。增强失败时安全降级为原始内容。
            // cancelled 场景跳过增强：中断恢复消息无需美化，且节省一次 LLM 调用
            const shouldEnhance = result.terminationReason !== 'cancelled' && visualEnhancementEnabled;
            let finalContent = result.content;
            let visualEnhanced = false;
            if (shouldEnhance) try {
                const { enhance } = await import(
                    '@services/planning/visual-enhancer'
                );
                // 获取 chatStore 的流式内容覆盖方法，用于实时推送 VE 增强内容到 UI
                const {
                    setAbortController,
                    setSessionId,
                    setStreamingContent,
                } = useChatStore.getState();
                const visualEnhanceAbortController = new AbortController();
                if (contextId) {
                    setAbortController(contextId, visualEnhanceAbortController);
                }
                const enhanceResult = await enhance(
                    result.content,
                    {
                        provider: effectiveProvider,
                        model: effectiveModel,
                        tokenContextId: contextId,
                        baseUrl: effectiveProvider === 'local' ? localApiUrl : undefined,
                        signal: visualEnhanceAbortController.signal,
                        onSessionStart: (sessionId) => {
                            if (contextId && !visualEnhanceAbortController.signal.aborted) {
                                setSessionId(contextId, sessionId);
                            }
                        },
                        // 流式回调：VE 每收到一个 delta 就将累积内容推到 StreamingMessage
                        onStreamDelta: (accumulatedContent) => {
                            // 用户停止或外层任务已结束后，绝不允许过期 VE 流复活 StreamingMessage。
                            if (
                                contextId &&
                                !visualEnhanceAbortController.signal.aborted &&
                                sendingContextsRef.current.has(contextId)
                            ) {
                                setStreamingContent(contextId, accumulatedContent);
                            }
                        },
                    }
                );
                if (enhanceResult.enhanced) {
                    finalContent = enhanceResult.content;
                    visualEnhanced = true;
                    logger.debug('[usePlanningMode] ✨ 可视化增强成功');
                } else {
                    logger.debug('[usePlanningMode] 跳过可视化增强:', enhanceResult.reason);
                }
            } catch (enhanceError) {
                // 增强失败不影响主流程，降级使用原始内容
                logger.warn('[usePlanningMode] 可视化增强失败，使用原始内容:', enhanceError);
            }

            // ====== 步骤 6: 创建并添加助手消息 ======
            // Hub 模式的消息需要标记 sourceType 以便加载时过滤
            //  将收集的进度项包含在 metadata 中以便持久化显示
            const messageMetadata = {
                responseType: 'agent_loop',
                terminationReason: result.terminationReason,
                iterationCount: result.iterationCount,
                toolCallCount: result.toolCallCount,
                //  标识消息来源模式，用于 MessageBubble 条件渲染
                mode: 'planning' as const,
                //  持久化 provider reasoning_content，完成后作为 Thought 展示
                reasoningTrace: reasoningTraceData.content.trim()
                    ? { ...reasoningTraceData }
                    : undefined,
                //  持久化思维链数据（旧版格式，保留为 backward compatibility）
                thinkingChain: thinkingChainData,
                //  持久化思维步骤数组（新版格式，直接从 store 读取，避免排序穿插）
                thinkingSteps: fsmVisualizationActions.getContextState(contextId).thinkingSteps
                    .map(step => ({
                        stepNumber: step.stepNumber,
                        analyzing: step.analyzing,
                        planning: step.planning,
                        decided: step.decided,
                    })),
                //  持久化 Sub-Agent 观测数据（用于刷新后恢复显示）
                subAgentObservations: subAgentObservationsData.length > 0 ? subAgentObservationsData : undefined,
                // 可视化增强标记（调试/统计用途）
                visualEnhanced,
                // 跨请求上下文恢复：含 rationale + SA observations 的完整内容
                // chatStore 中 content 使用 finalContent（UI 剥离版），但下一轮
                // loadChatHistory 需要完整版供 MB 的 conversationHistory 读取
                // 使用 ?? 而非 ||：空字符串也是有效值，需要写入 metadata
                // 避免下次加载时因 persistContent 缺失而回退到增强版 content
                persistContent: result.persistContent,
                // SA 通过 generate_image 工具生成的图片本地路径（供 MessageBubble 内联展示）
                generatedImages: result.generatedImages,

                // Hub 模式添加 sourceType、hubId 和 agentName
                // agentName 与 Chat 模式（useChatSender）对称写入，确保 ChatHistory 能从
                // message.metadata?.agentName 读取到正确名称，而非降级显示 Hub 名称
                ...(contextType === 'hub' ? {
                    sourceType: 'hub' as const,
                    hubId: contextId,
                    agentName: effectiveAgentConfig.name,
                } : {}),
            };

            // cancelled 场景容错：用户可能在取消后立即删除 Agent，
            // 导致 message_create 时 FOREIGN KEY 失败（agent 已不在 DB）。
            // cancelled 时的持久化是"尽力而为"的优化，失败不应阻塞整个流程。
            if (!isCreatedUserMessageStillPresent()) {
                logger.debug('[usePlanningMode] 用户消息已撤回，跳过迟到的 Planning assistant 持久化:', createdUserMessageId);
                await deletePlanningCheckpoint('source user message disappeared before final assistant persistence');
                return;
            }

            let assistantMessageResult: PersistedMessageResult;
            try {
                await stopPlanningCheckpointFlushes();

                if (planningCheckpointMessage) {
                    try {
                        assistantMessageResult = await invoke<PersistedMessageResult>('message_update', {
                            request: {
                                id: planningCheckpointMessage.id,
                                // DB 存储可视化增强后的版本，确保重启后 UI 显示一致
                                // 跨请求上下文恢复所需的 persistContent 已冗余存储在 metadata 中
                                content: finalContent,
                                metadata: JSON.stringify(messageMetadata),
                                createdAt: Date.now(),
                            },
                        });
                        checkpointFinalized = true;
                    } catch (checkpointUpdateError) {
                        logger.warn('[usePlanningMode] Planning checkpoint 最终更新失败，回退创建 assistant 消息:', checkpointUpdateError);
                        assistantMessageResult = await invoke<PersistedMessageResult>('message_create', {
                            request: {
                                agentId: messageAgentId,
                                role: 'assistant',
                                content: finalContent,
                                metadata: JSON.stringify(messageMetadata),
                            },
                        });
                        await deletePlanningCheckpoint('stale checkpoint after final assistant fallback');
                    }
                } else {
                    assistantMessageResult = await invoke<PersistedMessageResult>('message_create', {
                        request: {
                            agentId: messageAgentId,
                            role: 'assistant',
                            content: finalContent,
                            metadata: JSON.stringify(messageMetadata),
                        },
                    });
                }
            } catch (dbError: unknown) {
                const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
                // FOREIGN KEY 失败 = agent 已从 DB 中删除（不论是用户删除还是其他原因）
                // message_create 是「尽力而为」的持久化，过程中 agent 消失时应静默跳过而不是崩溃
                if (dbErrorMsg.includes('FOREIGN KEY')) {
                    logger.warn(
                        `[usePlanningMode] assistant 消息持久化跳过（Agent 已不在 DB）, terminationReason=${result.terminationReason}:`,
                        dbErrorMsg,
                    );
                    return;
                }
                // 非 FK 错误，重新抛出由外层 catch 处理
                throw dbError;
            }

            const assistantMessage = {
                id: assistantMessageResult.id,
                content: finalContent,
                role: 'assistant' as const,
                agentId: messageAgentId,
                createdAt: assistantMessageResult.createdAt,
                metadata: messageMetadata,
            };

            if (contextType === 'agent') {
                addMessage(contextId, assistantMessage);
            } else {
                addHubMessage(contextId, assistantMessage);
            }

            logger.debug('[usePlanningMode]  Planning 模式完成:', {
                iterations: result.iterationCount,
                toolCalls: result.toolCallCount,
                reason: result.terminationReason,
            });

            if (result.terminationReason !== 'cancelled') {
                void notifyTaskCompleted({
                    id: assistantMessageResult.id,
                    contextType,
                    contextId,
                    agentId: messageAgentId,
                    agentName: effectiveAgentConfig.name,
                    hubId: effectiveAgentConfig.hubId,
                    content: finalContent,
                    source: resolveTaskCompletionNotificationSource(userMessageMeta?.source),
                    mode: 'planning',
                    createdAt: assistantMessageResult.createdAt,
                });
            }

            // IM 任务完成事件已在步骤 5.2（可视化增强前）提前发射，使用原始纯文本。
            // 飞书不支持渲染 echarts/mermaid，提前发射可避免飞书显示长篇代码块。
            // 此处无需重复发射：ImTaskBridge.handleTaskCompleted 在收到第一次事件后已
            // cleanupBotTask（activeTasks.delete），后续重复事件会被幂等保护拦截，
            // 但主动消除此冗余调用可杜绝无效日志噪音。
            // 本地 UI 已由 chatStore.addMessage(finalContent) 完成增强后内容的更新。

            // ====== 更新临时 messageId 为真实 ID ======
            if (tempMessageIdForDiff) {
                try {
                    const { useDiffStore } = await import('@stores/diffStore');
                    await useDiffStore.getState().updateMessageId(
                        contextId,
                        tempMessageIdForDiff,
                        assistantMessageResult.id
                    );
                    logger.trace('[usePlanningMode]  messageId 已更新:',
                        tempMessageIdForDiff, '->', assistantMessageResult.id);
                } catch (updateError) {
                    logger.warn('[usePlanningMode] 更新 tempMessageId 失败:', updateError);
                    // 不阻塞主流程
                }
            }

            // ====== 步骤 7: 添加到记忆系统（仅 Agent 模式） ======
            // Hub @提及模式不更新记忆，避免污染 Agent 的短期缓冲
            if (contextType === 'agent') {
                try {
                    const { getOrCreateMemoryService } = await import('@services/memory');
                    const { createLLMAdapter } = await import('@services/memory/LLMAdapter');

                    // dynamic 模式：LLMAdapter 在每次 generate 调用时从 settingsStore
                    // 实时解析 provider/model，UI 切换设置后无需重建实例即可生效
                    const llmService = createLLMAdapter({
                        dynamic: true,
                    });

                    // 使用全局工厂获取或创建 MemoryService 实例
                    const memoryService = getOrCreateMemoryService(messageAgentId, llmService);

                    // fire-and-forget：记忆处理（含水位线摘要生成）在后台异步进行，
                    // 不阻塞 setIsSending(false)，避免输入框在记忆整理期间被禁用
                    memoryService.addInteraction(
                        {
                            id: userMessageResult.id,
                            agentId: messageAgentId,
                            role: 'user',
                            content: content,
                            createdAt: userMessageResult.createdAt,
                        },
                        {
                            id: assistantMessageResult.id,
                            agentId: messageAgentId,
                            role: 'assistant',
                            // 记忆系统只接收原始/安全文本，避免可视化增强代码块进入摘要和召回证据
                            content: stripVisualCodeBlocks(
                                result.persistContent.trim() ? result.persistContent : result.content
                            ),
                            createdAt: assistantMessageResult.createdAt,
                        }
                    ).then(() => {
                        logger.trace('[usePlanningMode]  Planning 模式已添加到记忆系统');
                    }).catch((memoryError: unknown) => {
                        logger.warn('[usePlanningMode] Planning 模式记忆系统调用失败:', memoryError);
                    });
                } catch (memoryError) {
                    logger.warn('[usePlanningMode] Planning 模式记忆系统调用失败:', memoryError);
                }
            } else {
                logger.trace('[usePlanningMode] Hub @提及模式，跳过记忆系统更新');
            }

            // ====== 步骤 8: 可视化增强后保持当前模式 ======
            // 不再自动切回 Chat 模式。用户可能在 Planning 模式下继续通过
            // Widget 交互发起需要 MB+SA 能力的任务（如代码修复、深度搜索）。
            // Widget 交互路由已改为根据当前 mode 智能选择 Chat/Planning 处理。

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const imErrorMsg = errorMsg === 'User cancelled'
                ? t('im.bridge.abortedByUser')
                : errorMsg;
            if (contextId) {
                fsmVisualizationActions.setSubAgentRunning(false, contextId);
            }

            // FOREIGN KEY 错误表示 agent 在执行期间已被删除，降级为 WARN。
            // 该错误不影响用户操作结果，仅表示当次执行的 assistant 消息无法写入数据库
            if (errorMsg.includes('FOREIGN KEY') || errorMsg.includes('foreign key')) {
                logger.warn('[usePlanningMode] Planning 计划消息持久化失败（Agent 已不在 DB）:', errorMsg);
            } else {
                logger.error('[usePlanningMode] Planning 模式处理失败:', errorMsg);
            }

            // IM 任务失败：发射事件通知 ImTaskBridge 发送错误卡片
            // 携带 botId 确保事件路由到正确的 Bot
            if (!isCreatedUserMessageStillPresent()) {
                logger.debug('[usePlanningMode] 用户消息已撤回，跳过迟到的 Planning 错误消息:', createdUserMessageId);
                await deletePlanningCheckpoint('source user message disappeared before error assistant persistence');
                return;
            }

            const imTask = getActiveImTask(imBotId);
            if (imTask) {
                emit('im:task_failed', {
                    taskId: imTask.id,
                    error: imErrorMsg,
                    botId: imBotId,  // 供 ImTaskBridge 路由到正确 Bot
                }).catch((emitError: unknown) => {
                    logger.warn('[usePlanningMode] 发射 im:task_failed 事件失败:', emitError);
                });
            }

            let errorMessage: Message | null = null;
            await stopPlanningCheckpointFlushes();

            if (planningCheckpointMessage && !checkpointFinalized) {
                try {
                    const failedMetadata = buildPlanningCheckpointMetadata('failed', errorMsg);
                    const updatedCheckpoint = await invoke<PersistedMessageResult>('message_update', {
                        request: {
                            id: planningCheckpointMessage.id,
                            content: `**${t('chat.planningExecutionFailed')}**\n\n${errorMsg}`,
                            metadata: JSON.stringify(failedMetadata),
                            createdAt: Date.now(),
                        },
                    });
                    checkpointFinalized = true;
                    errorMessage = {
                        id: updatedCheckpoint.id,
                        content: updatedCheckpoint.content,
                        role: 'assistant',
                        agentId: updatedCheckpoint.agentId,
                        createdAt: updatedCheckpoint.createdAt,
                        metadata: failedMetadata,
                    };
                } catch (checkpointError) {
                    logger.warn('[usePlanningMode] Planning checkpoint 失败状态更新失败:', checkpointError);
                    await deletePlanningCheckpoint('failed checkpoint status update failed');
                }
            }

            // 添加错误消息到聊天历史（避免前端显示缓存的旧回复）
            errorMessage ??= {
                id: `error_${Date.now()}`,
                content: `**${t('chat.planningExecutionFailed')}**\n\n${error instanceof Error ? error.message : String(error)}`,
                role: 'assistant',
                agentId: messageAgentId,
                createdAt: Date.now(),
                metadata: {
                    responseType: 'error',
                    errorType: error instanceof Error ? error.name : 'UnknownError',
                },
            };

            if (contextType === 'agent') {
                addMessage(contextId, errorMessage);
            } else {
                addHubMessage(contextId, errorMessage);
            }

            toast({
                type: 'error',
                title: t('chat.toastPlanningFailed'),
                description: error instanceof Error ? error.message : String(error),
                duration: 6000,
            });
            // 设置状态栏为红灯
            useStatusStore.getState().setModelStatus('error');
        } finally {
            await stopPlanningCheckpointFlushes();
            sendingContextsRef.current.delete(contextId);
            cancelRequestedContextsRef.current.delete(contextId);
            finishSending(contextId);
            fsmVisualizationActions.setSubAgentRunning(false, contextId);
            // 结束加载状态
            if (contextId) {
                finishStreaming(contextId);
            }

            // 任务结束后恢复模型状态灯（瞬时错误不应持续红灯）
            useStatusStore.getState().setModelStatus('online');

            // Token 统计已在 SubAgentRunner/AgentLoopFSMIntegration 的 LLM 调用后
            // 通过 addTokenUsage 实时累计，此处仅清除上下文压力指示
            if (contextId) {
                useStatusStore.getState().clearContextPressure(contextId);
            }

            // 清理 HITL 残留状态（任务结束时的幂等兜底）。
            // SubAgentRunner 在循环退出时已调用一次 cleanup，此处为双重保障：
            // 覆盖 SubAgentRunner 未注入 contextId（如 overrideSystemPrompt 路径）、
            // 或任务在进入 SA 之前即抛出异常的边缘场景。
            // cleanup() 是幂等操作，重复调用不引起副作用。
            if (contextId) {
                const { useHitlStore } = await import('@stores/hitlStore');
                useHitlStore.getState().cleanup(contextId);
            }
        }
    }, [
        contextType,
        contextId,
        agentConfig,
        defaultProvider,
        defaultModel,
        localApiUrl,
        addMessage,
        addHubMessage,
        startSending,
        finishSending,
        fsmVisualizationActions,
        toast,
        t,
    ]);

    // 停止 Planning 任务
    const stopPlanningTask = useCallback(() => {
        // 按当前 contextId 取消对应的 AgentService（避免跨 Agent 误取消）
        if (contextId) {
            cancelRequestedContextsRef.current.add(contextId);
            const service = agentServiceMapRef.current.get(contextId);
            if (service) {
                service.cancelProcessing();
                logger.debug('[usePlanningMode] 已通过本地引用取消 Planning 任务, contextId:', contextId);
            } else if (cancelCachedAgentService(contextId)) {
                logger.debug('[usePlanningMode] 已通过全局缓存取消 Planning 任务, contextId:', contextId);
            } else {
                logger.warn('[usePlanningMode] 未找到可取消的 Planning 服务，仅清理 UI 状态, contextId:', contextId);
            }

            // 立即强制清理 UI 状态，不等待 processMessage 的 finally 块
            // 场景：Embedding 卡住时 finally 块旋要等到超时（15s）才能执行，
            // 用户点击取消后输入框将锁死 15s 之久。
            // 在此主动解锁 UI，finally 块最终执行时也会再调用一次（幂等操作无副作用）
            sendingContextsRef.current.delete(contextId);
            finishSending(contextId);
            const { stopStreaming } = useChatStore.getState();
            stopStreaming(contextId);
            logger.debug('[usePlanningMode] 已强制清理 UI 发送状态, contextId:', contextId);
        }
    }, [contextId, finishSending]);

    return {
        executePlanningTask,
        stopPlanningTask,
    };
}
