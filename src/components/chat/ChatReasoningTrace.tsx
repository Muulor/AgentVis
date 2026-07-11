/**
 * ChatReasoningTrace - Chat 模式推理内容折叠块
 *
 * 运行中显示 Thinking，正文开始后折叠为 Thought，完成消息中也复用同一视觉。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n } from '@/i18n';
import styles from './ChatReasoningTrace.module.css';

interface ChatReasoningTraceProps {
  content: string;
  isStreaming?: boolean;
  answerStarted?: boolean;
  defaultExpanded?: boolean;
}

export function ChatReasoningTrace({
  content,
  isStreaming = false,
  answerStarted = false,
  defaultExpanded,
}: ChatReasoningTraceProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? (isStreaming && !answerStarted));
  const autoCollapsedRef = useRef(false);
  const normalizedContent = content.trim();

  useEffect(() => {
    if (!normalizedContent) return;

    if (isStreaming && !answerStarted) {
      setIsExpanded(true);
      autoCollapsedRef.current = false;
      return;
    }

    if (answerStarted && !autoCollapsedRef.current) {
      setIsExpanded(false);
      autoCollapsedRef.current = true;
    }
  }, [answerStarted, isStreaming, normalizedContent]);

  if (!normalizedContent) {
    return null;
  }

  const title =
    isStreaming && !answerStarted
      ? t('chat.masterBrainReasoning')
      : t('chat.masterBrainReasoningCollapsedTitle');
  const toggleLabel = isExpanded
    ? t('chat.masterBrainReasoningCollapse')
    : t('chat.masterBrainReasoningExpand');

  return (
    <div className={styles.trace}>
      <Tooltip content={toggleLabel}>
        <button
          type="button"
          className={styles.header}
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
          aria-label={toggleLabel}
        >
          <span className={styles.title}>{title}</span>
          <span className={styles.rule} />
          <span className={styles.toggle}>
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>
      </Tooltip>

      {isExpanded && <div className={styles.body}>{normalizedContent}</div>}
    </div>
  );
}
