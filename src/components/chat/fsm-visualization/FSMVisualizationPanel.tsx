/**
 * FSMVisualizationPanel - FSM 可视化主面板
 *
 * 整合所有可视化子组件，展示 Agent 的思维过程和状态
 *
 */

import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import { ReasoningTraceSection } from './components/ReasoningTraceSection';
import { ThinkingChainSection } from './components/ThinkingChainSection';
import { SubAgentObservationSection } from './components/SubAgentObservationSection';
import { DecisionCard } from './components/DecisionCard';
import { cx } from '@utils/classNames';
import styles from './FSMVisualizationPanel.module.css';

export interface FSMVisualizationPanelProps {
    className?: string;
    contextId?: string;
}

/**
 * FSM 可视化主面板
 *
 * 根据 contextId 从 Store 的 contextStates Map 中读取对应 Agent 的可视化数据，
 * 多 Agent 并发运行时各自独立显示。
 */
export function FSMVisualizationPanel({ className, contextId }: FSMVisualizationPanelProps) {
    // 从 per-context Map 中读取对应 Agent 的可视化状态
    const contextState = useFSMVisualizationStore(
        (s) => contextId ? s.contextStates[contextId] : undefined
    );

    // 无 contextId 或无对应状态时不渲染
    if (!contextId || !contextState) {
        return null;
    }

    const {
        currentDecision,
        isThinking,
        thinkingSteps,
        subAgentObservations,
        isSubAgentRunning,
    } = contextState;

    // 检查是否有内容需要显示
    const hasThinkingContent = thinkingSteps.length > 0;
    const maybeReasoningTrace = (contextState as Partial<typeof contextState>).reasoningTrace;
    const hasReasoningTrace = Boolean(maybeReasoningTrace?.content ?? '')
        || (maybeReasoningTrace?.isStreaming ?? false);
    const hasObservations = subAgentObservations.length > 0 || isSubAgentRunning;
    const shouldShow = hasReasoningTrace || isThinking || hasThinkingContent || currentDecision !== null || hasObservations;

    if (!shouldShow) {
        return null;
    }

    return (
        <div className={cx(styles.container, className)}>
            {/* provider reasoning_content 推理流 */}
            <ReasoningTraceSection contextId={contextId} />

            {/* 思维链区块 */}
            <ThinkingChainSection contextId={contextId} />

            {/* Sub-Agent 实时观测区块 */}
            <SubAgentObservationSection contextId={contextId} />

            {/* 决策卡片 */}
            {currentDecision && (
                <div className={styles.decisionWrapper}>
                    <DecisionCard decision={currentDecision} />
                </div>
            )}
        </div>
    );
}
