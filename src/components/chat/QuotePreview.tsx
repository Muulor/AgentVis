/**
 * QuotePreview - 引用预览块组件
 *
 * 功能：
 * - 显示待引用的消息列表
 * - 支持移除单条引用
 */

import { memo, useCallback } from 'react';
import type { QuoteInfo } from '@/types/message';
import { useI18n } from '@/i18n';
import styles from './QuotePreview.module.css';

// ==================== 类型定义 ====================

interface QuotePreviewProps {
  /** 引用列表 */
  quotes: QuoteInfo[];
  /** 移除引用回调 */
  onRemove?: (messageId: string) => void;
}

// ==================== 组件实现 ====================

/**
 * QuotePreview 引用预览组件
 */
export const QuotePreview = memo(function QuotePreview({ quotes, onRemove }: QuotePreviewProps) {
  const { t } = useI18n();
  const handleRemove = useCallback(
    (messageId: string) => {
      onRemove?.(messageId);
    },
    [onRemove]
  );

  if (quotes.length === 0) {
    return null;
  }

  return (
    <div className={styles.quoteList}>
      {quotes.map((quote) => (
        <div key={quote.messageId} className={styles.quoteItem}>
          <div className={styles.quoteContent}>
            <span className={styles.quoteLabel}>{t('chat.quoteMention')}</span>
            {quote.agentName && (
              <span className={styles.quoteSender}>
                {quote.agentName}
                {quote.turnNumber !== undefined && ` #${quote.turnNumber}`}
              </span>
            )}
            <span className={styles.quoteText}>{truncateText(quote.content, 50)}</span>
          </div>
          <button
            className={styles.removeBtn}
            onClick={() => handleRemove(quote.messageId)}
            aria-label={t('chat.removeQuote')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
});

// ==================== 工具函数 ====================

/**
 * 截断文本
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
