/**
 * PlanningTraceDetails - Planning 持久化执行详情收纳组件
 *
 * 将已完成任务的 Master Brain 思维链与 Sub-Agent 执行记录合并为一条轻量分隔线，
 * 默认收起，展开后再展示完整追踪明细，减少聊天窗口中的重复视觉负担。
 */

import { useMemo, useState } from 'react';
import { BrainCog, ChevronDown, ChevronRight, Loader } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Tooltip } from '@components/ui/Tooltip';
import type { SubAgentObservationEvent } from '@/services/planning/agent-loop/types';
import { ThinkingChainDisplay, type PersistedThinkingStep, type ThinkingChainData } from './ThinkingChainDisplay';
import { SubAgentObservationDisplay } from './SubAgentObservationDisplay';
import styles from './PlanningTraceDetails.module.css';

interface PlanningTraceDetailsProps {
    /** 旧版持久化思维链数据 */
    thinkingChain?: ThinkingChainData;
    /** 新版持久化思维步骤 */
    thinkingSteps?: PersistedThinkingStep[];
    /** 持久化 Sub-Agent 观测数据 */
    subAgentObservations?: SubAgentObservationEvent[];
    /** 当前 assistant 消息创建时间，用于推导执行耗时 */
    completedAt?: string | number;
}

const EMPTY_THINKING_CHAIN: ThinkingChainData = {
    analyzing: '',
    planning: '',
    decided: '',
};

function getTimestampMs(value: string | number | undefined): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (!value) return null;

    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function hasThinkingContent(thinkingChain?: ThinkingChainData, thinkingSteps?: PersistedThinkingStep[]): boolean {
    if (thinkingSteps?.some(step => step.analyzing || step.planning || step.decided)) {
        return true;
    }

    return [thinkingChain?.analyzing, thinkingChain?.planning, thinkingChain?.decided]
        .some(content => Boolean(content));
}

function getTraceDurationMs(
    observations: SubAgentObservationEvent[] | undefined,
    completedAt: string | number | undefined
): number | null {
    const observationTimes = (observations ?? [])
        .map(observation => observation.timestamp)
        .filter((timestamp): timestamp is number => Number.isFinite(timestamp));

    if (observationTimes.length === 0) return null;

    const startedAt = Math.min(...observationTimes);
    const latestObservationAt = Math.max(...observationTimes);
    const completedAtMs = getTimestampMs(completedAt);
    const endedAt = Math.max(latestObservationAt, completedAtMs ?? latestObservationAt);
    const duration = endedAt - startedAt;

    return duration >= 1000 ? duration : null;
}

function formatDuration(durationMs: number, t: ReturnType<typeof useI18n>['t']): string {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1000));

    if (totalSeconds < 60) {
        return t('chat.durationSeconds', { seconds: totalSeconds });
    }

    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (totalMinutes < 60) {
        return t('chat.durationMinutesSeconds', {
            minutes: totalMinutes,
            seconds,
        });
    }

    return t('chat.durationHoursMinutes', {
        hours: Math.floor(totalMinutes / 60),
        minutes: totalMinutes % 60,
    });
}

/**
 * Planning 持久化执行详情收纳组件
 */
export function PlanningTraceDetails({
    thinkingChain,
    thinkingSteps,
    subAgentObservations,
    completedAt,
}: PlanningTraceDetailsProps) {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = useState(false);

    const hasThinking = useMemo(
        () => hasThinkingContent(thinkingChain, thinkingSteps),
        [thinkingChain, thinkingSteps]
    );
    const hasSubAgentTrace = Boolean(subAgentObservations?.length);

    const durationText = useMemo(() => {
        const durationMs = getTraceDurationMs(subAgentObservations, completedAt);
        return durationMs ? formatDuration(durationMs, t) : null;
    }, [completedAt, subAgentObservations, t]);

    if (!hasThinking && !hasSubAgentTrace) {
        return null;
    }

    const summaryText = durationText
        ? t('chat.processedDuration', { duration: durationText })
        : t('chat.processed');
    const toggleLabel = isExpanded
        ? t('chat.collapseProcessingDetails')
        : t('chat.expandProcessingDetails');

    return (
        <div className={styles.container}>
            <Tooltip content={toggleLabel}>
                <button
                    type="button"
                    className={styles.summaryButton}
                    onClick={() => setIsExpanded(prev => !prev)}
                    aria-expanded={isExpanded}
                    aria-label={toggleLabel}
                >
                    <span className={styles.summaryText}>{summaryText}</span>
                    <span className={styles.chevron}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    <span className={styles.rule} />
                </button>
            </Tooltip>

            {isExpanded && (
                <div className={styles.details}>
                    {hasThinking && (
                        <section className={styles.detailSection}>
                            <div className={styles.detailHeader}>
                                <BrainCog size={13} />
                                <span>{t('chat.masterBrainThought')}</span>
                            </div>
                            <ThinkingChainDisplay
                                data={thinkingChain ?? EMPTY_THINKING_CHAIN}
                                steps={thinkingSteps}
                                showHeader={false}
                                defaultExpanded
                            />
                        </section>
                    )}

                    {hasSubAgentTrace && subAgentObservations && (
                        <section className={styles.detailSection}>
                            <div className={styles.detailHeader}>
                                <Loader size={13} />
                                <span>{t('chat.subAgentTrace')}</span>
                            </div>
                            <SubAgentObservationDisplay
                                data={subAgentObservations}
                                showHeader={false}
                                defaultExpanded
                            />
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
