/**
 * ThinkingChainSection - 思维链区块组件
 *
 * 按步展示 Agent 的思维过程，每步合并分析、规划、决策为连贯文字
 */

import { useMemo, useEffect, useRef } from 'react';
import { BrainCog, Loader2 } from 'lucide-react';
import { useFSMVisualizationStore, type ThinkingStep } from '@stores/fsmVisualizationStore';
import { ThinkingStream } from './ThinkingStream';
import { CollapsibleSection } from './CollapsibleSection';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ThinkingChainSection.module.css';

/**
 * 合并思维步骤的三阶段内容为连贯文字
 */
function mergeStepContent(step: ThinkingStep): string {
    const parts: string[] = [];

    if (step.analyzing) {
        parts.push(step.analyzing);
    }
    if (step.planning) {
        parts.push(step.planning);
    }
    if (step.decided) {
        parts.push(step.decided);
    }

    // 直接拼接，中间用换行分隔（如果都有内容的话）
    return parts.join('\n\n');
}

/**
 * 思维链区块组件
 */
export function ThinkingChainSection({ contextId }: { contextId: string }) {
    const { t } = useI18n();
    // 从 per-context Map 中读取对应 Agent 的思维链数据
    const contextState = useFSMVisualizationStore((s) => s.contextStates[contextId]);
    const isThinkingExpanded = useFSMVisualizationStore((s) => s.isThinkingExpanded);
    const toggleThinkingExpanded = useFSMVisualizationStore((s) => s.toggleThinkingExpanded);

    const thinkingSteps = useMemo(
        () => contextState?.thinkingSteps ?? [],
        [contextState?.thinkingSteps]
    );
    const isThinking = contextState?.isThinking ?? false;

    // 自动滚动到底部：响应 step 数量变化和流式内容增长
    // 流式更新只修改现有 step 的内容（thinkingSteps.length 不变），
    // 因此需要额外监听最后一步的内容长度来触发滚动。
    // 使用节流（100ms）避免高频 store 更新导致的性能开销。
    const stepsContainerRef = useRef<HTMLDivElement>(null);
    const scrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 计算最后一步的内容长度作为滚动触发信号
    const lastStep = thinkingSteps[thinkingSteps.length - 1];
    const contentSignal = lastStep
        ? lastStep.analyzing.length
        + lastStep.planning.length
        + lastStep.decided.length
        : 0;

    useEffect(() => {
        if (!stepsContainerRef.current) return;

        // 节流：100ms 内最多触发一次滚动
        scrollThrottleRef.current ??= setTimeout(() => {
            if (stepsContainerRef.current) {
                stepsContainerRef.current.scrollTop = stepsContainerRef.current.scrollHeight;
            }
            scrollThrottleRef.current = null;
        }, 100);

        return () => {
            if (scrollThrottleRef.current) {
                clearTimeout(scrollThrottleRef.current);
                scrollThrottleRef.current = null;
            }
        };
    }, [thinkingSteps.length, contentSignal]);

    // 计算摘要信息（折叠时显示）
    const summary = useMemo(() => {
        if (thinkingSteps.length === 0) {
            return '';
        }

        const lastStep = thinkingSteps[thinkingSteps.length - 1];
        if (!lastStep) return '';

        if (lastStep.isCompleted) {
            return t('chat.completedSteps', { count: thinkingSteps.length });
        }

        // 正在进行中，显示当前阶段
        const phaseLabels: Record<string, string> = {
            ANALYZING: t('chat.phaseAnalyzing'),
            PLANNING: t('chat.phasePlanning'),
            DECIDED: t('chat.phaseDecided'),
        };
        return t('chat.stepPhase', {
            step: lastStep.stepNumber,
            phase: lastStep.activePhase ? phaseLabels[lastStep.activePhase] ?? '' : '',
        });
    }, [thinkingSteps, t]);

    // 如果没有思维步骤，不渲染
    if (thinkingSteps.length === 0 && !isThinking) {
        return null;
    }

    // 动态标题：进行中时添加动画点
    const titleContent = isThinking ? (
        <span className={styles.titleWithAnimation}>
            Thought
            <span className={styles.thinkingDots}>
                <span className={styles.thinkingDot}>.</span>
                <span className={styles.thinkingDot}>.</span>
                <span className={styles.thinkingDot}>.</span>
            </span>
        </span>
    ) : 'Thought';

    return (
        <CollapsibleSection
            title={titleContent}
            icon={<BrainCog size={14} />}
            collapsedSummary={summary}
            isExpanded={isThinkingExpanded}
            onToggle={toggleThinkingExpanded}
        >
            {/* 步骤列表 */}
            <div ref={stepsContainerRef} className={styles.stepsContainer}>
                {thinkingSteps.map((step) => {
                    const content = mergeStepContent(step);
                    const isActive = !step.isCompleted;

                    return (
                        <div
                            key={step.stepNumber}
                            className={cx(styles.stepItem, isActive ? styles.active : styles.completed)}
                        >
                            {/* 步骤指示器 */}
                            <div className={styles.stepIndicator}>
                                {isActive ? (
                                    <Loader2 size={12} className={styles.spinningIcon} />
                                ) : (
                                    <span className={styles.stepNumber}>{step.stepNumber}</span>
                                )}
                            </div>

                            {/* 步骤内容 */}
                            <div className={styles.stepContent}>
                                {isActive ? (
                                    <ThinkingStream
                                        content={content}
                                        isActive={isActive}
                                        showCursor={true}
                                    />
                                ) : (
                                    <div className={styles.completedContent}>{content}</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </CollapsibleSection>
    );
}

