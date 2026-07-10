/**
 * ReasoningTraceSection - Master Brain 推理内容流式区块
 *
 * 展示模型 provider 返回的 reasoning_content，并与结构化 Decision 展示分离。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import { useI18n } from '@/i18n';
import { cx } from '@utils/classNames';
import { ThinkingStream } from './ThinkingStream';
import styles from './ReasoningTraceSection.module.css';

export function ReasoningTraceSection({ contextId }: { contextId: string }) {
    const { t } = useI18n();
    const contextState = useFSMVisualizationStore((s) => s.contextStates[contextId]);
    const traceContainerRef = useRef<HTMLDivElement>(null);

    const reasoningTrace = contextState?.reasoningTrace;
    const content = reasoningTrace?.content ?? '';
    const isStreaming = reasoningTrace?.isStreaming ?? false;
    const isCompleted = reasoningTrace?.isCompleted ?? false;
    const hasContent = Boolean(content.trim());
    const [isExpanded, setIsExpanded] = useState(isStreaming);

    useEffect(() => {
        if (!traceContainerRef.current) return;
        traceContainerRef.current.scrollTop = traceContainerRef.current.scrollHeight;
    }, [content]);

    useEffect(() => {
        if (isStreaming) {
            setIsExpanded(true);
        } else if (isCompleted) {
            setIsExpanded(false);
        }
    }, [isCompleted, isStreaming]);

    if (!hasContent && !isStreaming) {
        return null;
    }

    const title = isStreaming
        ? t('chat.masterBrainReasoning')
        : t('chat.masterBrainReasoningCollapsedTitle');
    const toggleLabel = isExpanded
        ? t('chat.masterBrainReasoningCollapse')
        : t('chat.masterBrainReasoningExpand');

    return (
        <section className={cx(styles.section, isStreaming && styles.streaming)}>
            <button
                type="button"
                className={styles.header}
                onClick={() => setIsExpanded(value => !value)}
                aria-expanded={isExpanded}
                aria-label={toggleLabel}
            >
                <span className={styles.title}>{title}</span>
                <span className={styles.rule} />
                <span className={styles.toggle}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
            </button>

            <div
                ref={traceContainerRef}
                className={cx(styles.traceContainer, isExpanded ? styles.expanded : styles.collapsed)}
                aria-hidden={!isExpanded}
            >
                {hasContent ? (
                    <ThinkingStream
                        content={content}
                        isActive={isStreaming}
                        showCursor={isStreaming}
                        typeSpeed={24}
                    />
                ) : (
                    <div className={styles.placeholder}>{t('chat.masterBrainReasoning')}</div>
                )}
            </div>
        </section>
    );
}
