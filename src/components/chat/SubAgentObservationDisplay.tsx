/**
 * SubAgentObservationDisplay - 静态 Sub-Agent 观测展示组件
 *
 * 用于在 MessageBubble 中显示持久化的 Sub-Agent 观测数据
 * 从 message.metadata.subAgentObservations 读取
 *
 * 会将连续的 observations 按"步骤"分组，每步包含一条 thinking + N 个工具调用
 * 步骤数 = LLM 决策轮次，非工具调用总数
 *
 * 样式与 ThinkingChainDisplay 保持一致（可折叠面板）
 */

import { useState, useMemo, memo } from 'react';
import {
    ChevronDown,
    ChevronRight,
    FileImage,
    FileText,
    FilePenLine,
    Loader,
    Terminal,
    Search,
    MessageSquare,
} from 'lucide-react';
import type { SubAgentObservationEvent } from '@/services/planning/agent-loop/types';
import { extractJsonFromText } from '@/services/memory/utils/JsonParser';
import { MarkdownRenderer } from '@components/file/MarkdownRenderer';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { useExpandableToolTarget } from './useExpandableToolTarget';
import styles from './SubAgentObservationDisplay.module.css';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface SubAgentObservationDisplayProps {
    /** 持久化的观测数据数组 */
    data: SubAgentObservationEvent[];
}

// ═══════════════════════════════════════════════════════════════
// 工具图标映射（与 SubAgentObservationSection 共享逻辑）
// ═══════════════════════════════════════════════════════════════

const TOOL_ICON_MAP: Record<string, typeof FileText> = {
    read: FileText,
    file_write: FilePenLine,
    exec: Terminal,
    web_search: Search,
    generate_image: FileImage,
};

const TOOL_LABEL_MAP: Record<string, string> = {
    read: 'Read',
    file_write: 'Write',
    exec: 'Exec',
    web_search: 'Search',
};

// ═══════════════════════════════════════════════════════════════
// 步骤分组类型与工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 一个"步骤" = 一次 LLM 决策 + 该决策驱动的所有工具调用
 *
 * 将扁平的 observation 事件列表按 thinking 文字变化边界分组，
 * 实现 UI 层去重：每步 thinking 文字只显示一次
 */
interface ObservationStep {
    /** LLM 思考文字（已去重，仅保留首次出现） */
    thinking: string;
    /** 该步的工具调用列表 */
    toolActions: Array<NonNullable<SubAgentObservationEvent['toolAction']>>;
    /** 最终结果（仅最后一步可能有） */
    result?: string;
    /** 时间戳（取首条事件的时间） */
    timestamp: number;
    /** 内部用：LLM 调用轮次序号（用于分组边界检测） */
    _step?: number;
    /** 内部用：Sub-Agent 派遣轮次命名空间 */
    _runId?: string;
    /** 是否为用户 HITL 介入步骤 */
    isIntervention?: boolean;
    /** 用户介入消息原文 */
    interventionMessage?: string;
}

const INTERVENTION_PREFIXES = [
    '🧑 [User intervention] ',
    '🧑 [用户介入] ',
];

function getInterventionMessage(thinking?: string): string | undefined {
    if (!thinking) return undefined;
    const prefix = INTERVENTION_PREFIXES.find(item => thinking.startsWith(item));
    return prefix ? thinking.slice(prefix.length) : undefined;
}

/**
 * 将扁平的 observation 列表分组为步骤
 *
 * 分组规则（按优先级）：
 * 1. 优先按 step 序号分组（每个不同的 step 值 = 一个新步骤）
 * 2. 回退到 thinking 文字变化检测（兼容旧版无 step 字段的持久化数据）
 * 3. thinking 为空的工具调用事件合并到当前步骤
 * 4. result 事件附加到当前步骤
 */
function groupObservationsIntoSteps(observations: SubAgentObservationEvent[]): ObservationStep[] {
    const steps: ObservationStep[] = [];

    for (const obs of observations) {
        const currentStep = steps[steps.length - 1];
        const isInterventionEvent = getInterventionMessage(obs.thinking) !== undefined;

        // 判断是否需要开始新步骤
        let shouldStartNewStep = false;

        if (obs.step !== undefined) {
            // 优先按 step 序号分组：step 变化 = 新的 LLM 调用轮次
            shouldStartNewStep = obs.runId !== currentStep?._runId
                || obs.step !== currentStep?._step;
        } else {
            // 回退：按 thinking 文字变化边界分组（兼容旧版数据）
            const hasNewThinking = Boolean(obs.thinking
                && obs.thinking.trim().length > 0
                && !obs.thinking.includes('TASK_COMPLETE'));
            shouldStartNewStep = hasNewThinking
                && (obs.runId !== currentStep?._runId || obs.thinking !== currentStep?.thinking);
        }

        // 用户介入淨化：无论 step 编号是否相同，一律强制开新步骤
        if (isInterventionEvent) {
            shouldStartNewStep = true;
        }

        // 用户介入节点使用专门 UI 渲染并提前返回，后续工具事件不能继续合并到该节点。
        if (!isInterventionEvent && currentStep?.isIntervention) {
            shouldStartNewStep = true;
        }

        if (shouldStartNewStep) {
            // 过滤掉 TASK_COMPLETE 终止信号
            const rawThinking = obs.thinking;
            const cleanThinking = (!rawThinking.includes('TASK_COMPLETE')) ? rawThinking : '';

            const interventionMessage = getInterventionMessage(cleanThinking);
            const isIntervention = interventionMessage !== undefined;

            steps.push({
                thinking: isIntervention ? '' : cleanThinking,
                toolActions: [],
                timestamp: obs.timestamp,
                _step: obs.step,
                _runId: obs.runId,
                isIntervention,
                interventionMessage,
            });
        }

        // 确保至少有一个步骤容器（处理首条无 thinking 事件的边界情况）
        if (steps.length === 0) {
            steps.push({
                thinking: '',
                toolActions: [],
                timestamp: obs.timestamp,
                _step: obs.step,
                _runId: obs.runId,
            });
        }

        const activeStep = steps[steps.length - 1];
        if (!activeStep) continue;

        // 工具行为合并到当前步骤
        if (obs.toolAction) {
            activeStep.toolActions.push(obs.toolAction);
        }

        // 结果附加到当前步骤
        if (obs.result) {
            activeStep.result = obs.result;
        }
    }

    return steps;
}

// ═══════════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════════

/**
 * 静态 Sub-Agent 观测展示
 *
 * 从持久化数据中渲染工具调用步骤和最终结果
 */
export const SubAgentObservationDisplay = memo(function SubAgentObservationDisplay({
    data,
}: SubAgentObservationDisplayProps) {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = useState(false);

    // 将扁平 observations 分组为步骤（去重 thinking 文字）
    const steps = useMemo(
        () => groupObservationsIntoSteps(data),
        [data]
    );

    if (data.length === 0) {
        return null;
    }

    return (
        <div className={styles.container}>
            {/* 标题栏（可点击折叠） */}
            <button
                className={styles.header}
                onClick={() => setIsExpanded(!isExpanded)}
                type="button"
            >
                <Loader size={10} className={styles.headerIcon} />
                <span className={styles.headerTitle}>Sub-Agent</span>
                {steps.length > 0 && (
                    <span className={styles.stepCount}>{t('chat.stepCount', { count: steps.length })}</span>
                )}
                <span className={styles.toggle}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
            </button>

            {/* 折叠内容 */}
            {isExpanded && (
                <div className={styles.contentContainer}>
                    {steps.map((step, index) => (
                        <StaticStepItem
                            key={`step-static-${index}-${step.timestamp}`}
                            step={step}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

// ═══════════════════════════════════════════════════════════════
// 单步渲染（静态版）
// ═══════════════════════════════════════════════════════════════

interface StaticStepItemProps {
    step: ObservationStep;
}

/**
 * 解析最终结果文本
 *
 * 复用项目统一的 JsonParser 处理 LLM 返回的各种格式：
 * - 纯 JSON / Markdown 代码块 / 截断 JSON 等
 *
 * 提取 result 字段（SubAgent 输出 schema 为 `{ success, result }`）
 */
function parseResultText(raw: string): string {
    // Step 1: 移除终止信号
    const cleaned = raw
        .replace(/TASK_COMPLETE/g, '')
        .trim();

    // Step 2: 使用项目统一 JsonParser 提取 JSON
    const jsonStr = extractJsonFromText(cleaned);
    if (jsonStr) {
        try {
            const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
            if (typeof parsed.result === 'string') return parsed.result;
        } catch {
            // 提取到的 JSON 仍无法解析，回退
        }
    }

    // 回退：返回清理后的文本
    return cleaned || raw;
}

/**
 * 单步渲染（静态版）
 *
 * 结构：
 * 1. LLM 思考文字（每步只显示一次）
 * 2. 该步所有工具行为指示器
 * 3. 最终结果文字（如果有 result 字段）
 */
function StaticStepItem({ step }: StaticStepItemProps) {
    const showThinking = step.thinking.trim().length > 0;

    const resultText = useMemo(
        () => step.result ? parseResultText(step.result) : null,
        [step.result]
    );

    // 用户介入步骤：整步渲染为黄色介入气泡
    if (step.isIntervention && step.interventionMessage) {
        return <StaticUserInterventionIndicator message={step.interventionMessage} />;
    }

    return (
        <>
            {/* LLM 思考文字：每步只显示一次 */}
            {showThinking && (
                <div style={{
                    fontSize: '12px',
                    color: 'var(--color-text-tertiary, #6B7280)',
                    padding: '2px 0',
                }}>
                    {step.thinking}
                </div>
            )}

            {/* 该步所有工具行为 */}
            {step.toolActions.map((action, i) => (
                <StaticToolAction
                    key={action.toolCallId ?? `tool-${i}-${action.tool}-${action.target}`}
                    action={action}
                />
            ))}

            {/* 最终结果 */}
            {resultText && (
                <div className={styles.resultCard}>
                    <MarkdownRenderer content={resultText} />
                </div>
            )}
        </>
    );
}

// ═══════════════════════════════════════════════════════════════
// 用户介入气泡（静态版）
// ═══════════════════════════════════════════════════════════════

/**
 * 用户 HITL 介入气泡（静态版）
 *
 * 与实时版 UserInterventionIndicator 风格一致，使用 MessageSquare icon + "User" 标题。
 */
function StaticUserInterventionIndicator({ message }: { message: string }) {
    return (
        <div className={styles.interventionAction}>
            <span className={styles.interventionIcon}>
                <MessageSquare size={13} />
            </span>
            <span className={styles.interventionLabel}>User</span>
            <span className={styles.interventionMessage}>{message}</span>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// 工具行为渲染（静态版）
// ═══════════════════════════════════════════════════════════════

interface StaticToolActionProps {
    action: NonNullable<SubAgentObservationEvent['toolAction']>;
}

function StaticToolAction({ action }: StaticToolActionProps) {
    const { t } = useI18n();
    const IconComponent = TOOL_ICON_MAP[action.tool] ?? FileText;
    const label = TOOL_LABEL_MAP[action.tool] ?? action.tool;
    const isPending = action.success === undefined;
    const {
        targetRef,
        isExpanded,
        canExpand,
        displayedTarget,
        toggleExpanded,
    } = useExpandableToolTarget(action.target, action.fullTarget);

    const iconStatusClass = isPending
        ? styles.pending
        : action.success
            ? styles.success
            : styles.failure;

    return (
        <div className={cx(styles.toolAction, isExpanded && styles.toolActionExpanded)}>
            <span className={cx(styles.toolIcon, iconStatusClass)}>
                <IconComponent size={13} />
            </span>
            <span className={styles.toolLabel}>{label}</span>
            {action.target && (
                <>
                    <span
                        ref={targetRef}
                        className={cx(styles.toolTarget, isExpanded && styles.toolTargetExpanded)}
                    >
                        {displayedTarget}
                    </span>
                    {canExpand && (
                        <button
                            type="button"
                            className={styles.toolTargetToggle}
                            onClick={toggleExpanded}
                            aria-label={isExpanded ? t('chat.collapseToolTarget') : t('chat.expandToolTarget')}
                            title={isExpanded ? t('chat.collapseToolTarget') : t('chat.expandToolTarget')}
                        >
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
