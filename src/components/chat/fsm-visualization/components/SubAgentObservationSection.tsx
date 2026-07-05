/**
 * SubAgentObservationSection - Sub-Agent 实时观测面板
 *
 * 展示 Sub-Agent 执行过程中的 LLM 思考文字和工具行为
 * 会将连续的 observations 按"步骤"分组，每步包含一条 thinking + N 个工具调用
 * 步骤数 = LLM 决策轮次，非工具调用总数
 *
 * 设计对标截图：
 * - LLM 思考文字渲染为段落（每步只显示一次）
 * - 工具行为使用 lucide icon + 行内指示器
 * - 内容区域自动滚动到底部
 */

import { useEffect, useRef, useMemo } from 'react';
import {
    ChevronDown,
    ChevronRight,
    FileImage,
    FileText,
    FilePenLine,
    Terminal,
    Search,
    History,
    Loader,
    MessageSquare,
} from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import type { SubAgentObservationEvent } from '@/services/planning/agent-loop/types';
import { extractJsonFromText } from '@/services/memory/utils/JsonParser';
import { MarkdownRenderer } from '@components/file/MarkdownRenderer';
import { Tooltip } from '@components/ui/Tooltip';
import { HitlInterventionBar } from './HitlInterventionBar';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { useExpandableToolTarget } from '../../useExpandableToolTarget';
import { getPendingExecTimeoutStatus } from '@/services/planning/utils/ExecTimeoutObservation';
import styles from './SubAgentObservationSection.module.css';

// ═══════════════════════════════════════════════════════════════
// 工具图标映射
// ═══════════════════════════════════════════════════════════════

/** 工具名 → lucide icon 映射 */
const TOOL_ICON_MAP: Record<string, typeof FileText> = {
    read: FileText,
    file_write: FilePenLine,
    exec: Terminal,
    web_search: Search,
    conversation_search: History,
    generate_image: FileImage,
};

/** 工具名 → 操作标签映射（用于 UI 显示） */
const TOOL_LABEL_MAP: Record<string, string> = {
    read: 'Read',
    file_write: 'Write',
    exec: 'Exec',
    web_search: 'Search',
    conversation_search: 'History',
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
    /** 是否为用户 HITL 介入步骤（特殊渲染，黄色 amber 主题） */
    isIntervention?: boolean;
    /** 用户介入消息原文（去掉 "🧑 [用户介入] " 前缀后的内容） */
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
        // 这解决了 emitObservation 使用相同 stepCount 时介入消息被吸入当前步骤、无法渲染为独立气泡的问题
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

            // 检测用户介入标记（由 SubAgentRunner HITL 分支通过 emitObservation 注入）
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
// 工具行为渲染
// ═══════════════════════════════════════════════════════════════

interface ToolActionIndicatorProps {
    action: NonNullable<SubAgentObservationEvent['toolAction']>;
    animatePending: boolean;
}

/**
 * 工具行为指示器（行内组件）
 *
 * 展示格式：[icon] Label  target
 * 例如：📄 Read  config.ts
 */
function ToolActionIndicator({ action, animatePending }: ToolActionIndicatorProps) {
    const { t } = useI18n();
    const IconComponent = TOOL_ICON_MAP[action.tool] ?? FileText;
    const label = TOOL_LABEL_MAP[action.tool] ?? action.tool;
    const isPending = action.success === undefined;
    const shouldAnimate = isPending && animatePending;
    const {
        targetRef,
        isExpanded,
        canExpand,
        displayedTarget,
        toggleExpanded,
    } = useExpandableToolTarget(action.target, action.fullTarget);

    // 根据执行结果选择图标颜色
    const iconStatusClass = isPending
        ? styles.pending
        : action.success
            ? styles.success
            : styles.failure;
    const targetStatusClass = !isPending && action.success
        ? styles.toolTargetSuccess
        : undefined;

    return (
        <div className={cx(styles.toolAction, isExpanded && styles.toolActionExpanded)}>
            <span className={cx(styles.toolIcon, iconStatusClass)}>
                <IconComponent size={13} />
            </span>
            <span className={styles.toolLabel}>{label}</span>
            {action.target && (
                <>
                    <span className={cx(
                        styles.toolTarget,
                        isExpanded && styles.toolTargetExpanded,
                        targetStatusClass,
                        shouldAnimate && !isExpanded && styles.pendingInstructionText
                    )} ref={targetRef}>
                        {displayedTarget}
                    </span>
                    {canExpand && (
                        <Tooltip content={isExpanded ? t('chat.collapseToolTarget') : t('chat.expandToolTarget')}>
                            <button
                                type="button"
                                className={styles.toolTargetToggle}
                                onClick={toggleExpanded}
                                aria-label={isExpanded ? t('chat.collapseToolTarget') : t('chat.expandToolTarget')}
                            >
                                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                        </Tooltip>
                    )}
                </>
            )}
        </div>
    );
}

/**
 * 用户 HITL 介入消息指示器
 *
 * 黄色 amber 主题，与暂停条风格一致。
 * 使用 MessageSquare icon + "User" 标题，替代工具名称。
 */
function UserInterventionIndicator({ message }: { message: string }) {
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
// 主组件
// ═══════════════════════════════════════════════════════════════

/**
 * Sub-Agent 实时观测面板
 *
 * 从 fsmVisualizationStore 读取 observations，按步骤分组后渲染
 */
export function SubAgentObservationSection({
    contextId,
}: {
    contextId: string;
}) {
    const { t } = useI18n();
    // 从 per-context Map 中读取对应 Agent 的观测数据
    const contextState = useFSMVisualizationStore((s) => s.contextStates[contextId]);
    const observations = useMemo(
        () => contextState?.subAgentObservations ?? [],
        [contextState?.subAgentObservations]
    );
    const isRunning = contextState?.isSubAgentRunning ?? false;

    // 自动滚动到底部
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }
    }, [observations.length]);

    // 将扁平 observations 分组为步骤（去重 thinking 文字）
    const steps = useMemo(
        () => groupObservationsIntoSteps(observations),
        [observations]
    );
    const pendingExecTimeoutStatus = useMemo(
        () => getPendingExecTimeoutStatus(observations),
        [observations]
    );

    // 无观测数据时不渲染
    if (observations.length === 0 && !isRunning) {
        return null;
    }

    // 状态标签：运行中显示动态指示，完成后显示步骤数
    const statusBadge = isRunning ? (
        <span className={styles.runningBadge}>
            <span className={styles.runningDot} />
            {t('chat.running')}
        </span>
    ) : steps.length > 0 ? (
        <span className={styles.stepCount}>
            {t('chat.stepCount', { count: steps.length })}
        </span>
    ) : null;

    // 折叠摘要
    const collapsedSummary = steps.length > 0
        ? t('chat.stepCount', { count: steps.length })
        : undefined;

    return (
        <CollapsibleSection
            title="Sub-Agent"
            icon={<Loader size={14} />}
            statusBadge={statusBadge}
            collapsedSummary={collapsedSummary}
            defaultExpanded={true}
        >
            <div ref={listRef} className={styles.observationList}>
                {observations.length === 0 && isRunning && (
                    <div className={styles.emptyState}>{t('chat.waitingSubAgent')}</div>
                )}
                {steps.map((step, index) => (
                    <StepItem key={`step-${index}-${step.timestamp}`} step={step} isRunning={isRunning} />
                ))}
            </div>
            {/* HITL 暂停介入条（SA 运行中或暂停后展示） */}
            <HitlInterventionBar
                contextId={contextId}
                isRunning={isRunning}
                execTimeoutSeconds={pendingExecTimeoutStatus?.timeoutSeconds}
                execTimeoutStartedAtMs={pendingExecTimeoutStatus?.startedAtMs}
            />
        </CollapsibleSection>
    );
}

// ═══════════════════════════════════════════════════════════════
// 单步渲染
// ═══════════════════════════════════════════════════════════════

interface StepItemProps {
    step: ObservationStep;
    isRunning: boolean;
}

/**
 * 单步渲染
 *
 * 结构：
 * 1. LLM 思考文字（如果有且非空，每步只显示一次）
 * 2. 该步所有工具行为指示器
 * 3. 最终结果文字（如果有 result 字段）
 */
function StepItem({ step, isRunning }: StepItemProps) {
    const showThinking = step.thinking.trim().length > 0;

    // 解析最终结果：复用项目统一的 JsonParser 处理各种 LLM 格式
    const resultText = useMemo(() => {
        if (!step.result) return null;

        // 移除终止信号
        const cleaned = step.result
            .replace(/TASK_COMPLETE/g, '')
            .trim();

        // 使用项目统一 JsonParser 提取 JSON
        const jsonStr = extractJsonFromText(cleaned);
        if (jsonStr) {
            try {
                const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
                if (typeof parsed.result === 'string') return parsed.result;
            } catch {
                // 提取到的 JSON 仍无法解析，回退
            }
        }

        return cleaned || step.result;
    }, [step.result]);

    // 用户介入步骤：整步渲染为黄色介入消息条，不展示普通工具行
    if (step.isIntervention && step.interventionMessage) {
        return <UserInterventionIndicator message={step.interventionMessage} />;
    }

    return (
        <>
            {showThinking && (
                <div className={styles.thinkingText}>
                    {step.thinking}
                </div>
            )}
            {step.toolActions.map((action, i) => (
                <ToolActionIndicator
                    key={action.toolCallId ?? `tool-${i}-${action.tool}-${action.target}`}
                    action={action}
                    animatePending={isRunning}
                />
            ))}
            {resultText && (
                <div className={styles.resultCard}>
                    <MarkdownRenderer content={resultText} />
                </div>
            )}
        </>
    );
}
