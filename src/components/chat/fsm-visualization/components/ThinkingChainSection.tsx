/**
 * ThinkingChainSection - 思维链区块组件
 *
 * 按步展示 Agent 的思维过程，每步合并分析、规划、决策为连贯文字
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useFSMVisualizationStore, type ThinkingStep } from '@stores/fsmVisualizationStore';
import { ThinkingStream } from './ThinkingStream';
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
  const [isExpanded, setIsExpanded] = useState(true);

  const thinkingSteps = useMemo(
    () => contextState?.thinkingSteps ?? [],
    [contextState?.thinkingSteps]
  );
  const latestStepNumber = thinkingSteps[thinkingSteps.length - 1]?.stepNumber ?? 0;
  const hasStepContent = thinkingSteps.some(
    (step) => Boolean(step.analyzing) || Boolean(step.planning) || Boolean(step.decided)
  );

  useEffect(() => {
    setIsExpanded(true);
  }, [contextId, latestStepNumber]);

  // Avoid rendering an empty Decision header before the first decision token arrives.
  if (!hasStepContent) {
    return null;
  }

  const decisionTitle = t('chat.masterBrainThought');
  const toggleLabel = isExpanded
    ? t('chat.collapseProcessingDetails')
    : t('chat.expandProcessingDetails');

  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
      >
        <span className={styles.title}>{decisionTitle}</span>
        <span className={styles.rule} />
        <span className={styles.toggle}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {isExpanded && (
        <div className={styles.stepsContainer}>
          {thinkingSteps.map((step) => {
            const content = mergeStepContent(step);
            const isActive = !step.isCompleted;

            return (
              <div
                key={step.stepNumber}
                className={cx(styles.stepItem, isActive ? styles.active : styles.completed)}
              >
                <div className={styles.stepContent}>
                  {isActive ? (
                    <ThinkingStream content={content} isActive={isActive} showCursor={true} />
                  ) : (
                    <div className={styles.completedContent}>{content}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
