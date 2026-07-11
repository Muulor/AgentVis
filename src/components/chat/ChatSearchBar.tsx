/**
 * ChatSearchBar - 聊天历史搜索栏组件
 *
 * 功能：
 * - 位于消息列表顶部（sticky）
 * - 输入关键字后实时过滤消息（前端内存搜索，300ms 防抖）
 * - 下拉面板展示匹配结果（关键字高亮片段）
 * - 键盘导航（↑/↓ 切换，Enter 跳转，Escape 关闭）
 * - 最多显示 50 条结果
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, User, Bot } from 'lucide-react';
import { useChatStore } from '@stores/chatStore';
import type { SearchResult } from '@stores/chatStore';
import type { UIMessage } from '@/types/message';
import { formatTimestamp } from '@/types/message';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ChatSearchBar.module.css';

// ==================== 常量 ====================

/** 搜索防抖延迟（毫秒） */
const SEARCH_DEBOUNCE_MS = 300;
/** 搜索结果最大数量 */
const MAX_SEARCH_RESULTS = 50;
/** 高亮片段前后截取字符数 */
const SNIPPET_CONTEXT_LENGTH = 40;

// ==================== 类型定义 ====================

interface ChatSearchBarProps {
  /** 上下文 ID（Agent ID 或 Hub ID） */
  contextId: string;
  /** 当前上下文的消息列表 */
  messages: UIMessage[];
  /** Agent 名称（用于搜索结果显示发送者） */
  agentName?: string;
  /** 点击结果后的跳转回调 */
  onJumpToMessage: (messageId: string) => void;
  /** 关闭搜索栏回调 */
  onClose: () => void;
}

// ==================== 工具函数 ====================

/**
 * 生成带高亮标记的内容片段
 *
 * 截取关键字前后各 SNIPPET_CONTEXT_LENGTH 个字符，
 * 并将所有匹配位置用 <mark> 标签包裹
 */
function buildMatchSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex === -1) return content.slice(0, SNIPPET_CONTEXT_LENGTH * 2);

  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_LENGTH);
  const end = Math.min(content.length, matchIndex + query.length + SNIPPET_CONTEXT_LENGTH);
  let snippet = content.slice(start, end);

  // 添加省略号
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * 前端内存搜索：遍历消息列表，匹配包含关键字的消息
 */
function searchMessages(
  messages: UIMessage[],
  query: string,
  agentName: string,
  userLabel: string
): SearchResult[] {
  if (!query.trim()) return [];

  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const msg of messages) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    // 跳过系统消息
    if (msg.role === 'system') continue;

    if (msg.content.toLowerCase().includes(lowerQuery)) {
      const senderName = msg.role === 'user' ? userLabel : (msg.metadata?.agentName ?? agentName);
      results.push({
        messageId: msg.id,
        role: msg.role,
        content: msg.content,
        senderName,
        timestamp: msg.createdAt,
        matchSnippet: buildMatchSnippet(msg.content, query),
      });
    }
  }

  return results;
}

// ==================== 组件实现 ====================

export const ChatSearchBar = memo(function ChatSearchBar({
  contextId,
  messages,
  agentName = 'Agent',
  onJumpToMessage,
  onClose,
}: ChatSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBarRef = useRef<HTMLDivElement>(null);
  const [localQuery, setLocalQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const resultListRef = useRef<HTMLDivElement>(null);

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 点击搜索栏外部关闭搜索
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchBarRef.current && !searchBarRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定，避免点击搜索按钮时立刻触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // 执行搜索（防抖）
  const performSearch = useCallback(
    (query: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(() => {
        const searchResults = searchMessages(messages, query, agentName, t('chat.userLabel'));
        setResults(searchResults);
        setActiveIndex(-1);
        // 同步到 store（其他组件可能需要）
        useChatStore.getState().setSearchQuery(contextId, query);
        useChatStore.getState().setSearchResults(contextId, searchResults);
      }, SEARCH_DEBOUNCE_MS);
    },
    [messages, agentName, contextId, t]
  );

  // 处理输入变化
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      setLocalQuery(query);
      performSearch(query);
    },
    [performSearch]
  );

  // 清空搜索
  const handleClear = useCallback(() => {
    setLocalQuery('');
    setResults([]);
    setActiveIndex(-1);
    useChatStore.getState().setSearchQuery(contextId, '');
    useChatStore.getState().setSearchResults(contextId, []);
    inputRef.current?.focus();
  }, [contextId]);

  // 跳转到消息
  const handleJump = useCallback(
    (messageId: string) => {
      onJumpToMessage(messageId);
    },
    [onJumpToMessage]
  );

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (results.length === 0) {
        if (e.key === 'Escape') {
          onClose();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setActiveIndex((prev) => {
            const next = prev < results.length - 1 ? prev + 1 : 0;
            // 滚动活跃项到可视区域
            scrollActiveIntoView(next);
            return next;
          });
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setActiveIndex((prev) => {
            const next = prev > 0 ? prev - 1 : results.length - 1;
            scrollActiveIntoView(next);
            return next;
          });
          break;
        }
        case 'Enter': {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < results.length) {
            const result = results[activeIndex];
            if (result) {
              handleJump(result.messageId);
            }
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          onClose();
          break;
        }
      }
    },
    // scrollActiveIntoView is declared below; the callback runs only after render when it is initialized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, activeIndex, handleJump, onClose]
  );

  // 将活跃项滚动到下拉面板可视区域
  const scrollActiveIntoView = useCallback((index: number) => {
    requestAnimationFrame(() => {
      const container = resultListRef.current;
      if (!container) return;
      const items = container.querySelectorAll('[data-search-item]');
      const target = items[index];
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
      }
    });
  }, []);

  // 高亮关键字的渲染函数
  const renderHighlightedSnippet = useCallback((snippet: string, query: string) => {
    if (!query.trim()) return snippet;

    const lowerSnippet = snippet.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    let searchStart = 0;
    while (searchStart < snippet.length) {
      const matchIndex = lowerSnippet.indexOf(lowerQuery, searchStart);
      if (matchIndex === -1) break;

      // 未匹配部分
      if (matchIndex > lastIndex) {
        parts.push(snippet.slice(lastIndex, matchIndex));
      }
      // 匹配部分（高亮）
      parts.push(
        <mark key={matchIndex} className={styles.highlight}>
          {snippet.slice(matchIndex, matchIndex + query.length)}
        </mark>
      );
      lastIndex = matchIndex + query.length;
      searchStart = lastIndex;
    }

    // 剩余未匹配部分
    if (lastIndex < snippet.length) {
      parts.push(snippet.slice(lastIndex));
    }

    return parts.length > 0 ? parts : snippet;
  }, []);

  // 组件卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className={styles.searchBar} ref={searchBarRef}>
      {/* 搜索输入区 */}
      <div className={styles.inputRow}>
        <Search size={16} className={styles.searchIcon} />
        <input
          ref={inputRef}
          type="text"
          className={styles.searchInput}
          placeholder={t('chat.searchPlaceholder')}
          value={localQuery}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          aria-label={t('chat.searchAria')}
        />
        {localQuery && (
          <button
            className={styles.clearBtn}
            onClick={handleClear}
            aria-label={t('chat.clearSearch')}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* 搜索结果下拉面板 */}
      {localQuery.trim() && (
        <div className={styles.resultPanel} ref={resultListRef}>
          {results.length === 0 ? (
            <div className={styles.noResults}>{t('chat.noSearchResults')}</div>
          ) : (
            <>
              <div className={styles.resultCount}>
                {results.length >= MAX_SEARCH_RESULTS
                  ? t('chat.searchCountTruncated', { count: results.length })
                  : t('chat.searchCount', { count: results.length })}
              </div>
              {results.map((result, index) => (
                <button
                  key={result.messageId}
                  data-search-item
                  className={cx(
                    styles.resultItem,
                    index === activeIndex && styles.resultItemActive
                  )}
                  onClick={() => handleJump(result.messageId)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <div className={styles.resultHeader}>
                    <span className={styles.resultRole}>
                      {result.role === 'user' ? <User size={12} /> : <Bot size={12} />}
                    </span>
                    <span className={styles.resultSender}>{result.senderName}</span>
                    <span className={styles.resultTime}>
                      {formatTimestamp(result.timestamp, { showDate: true, use12Hour: true })}
                    </span>
                  </div>
                  <div className={styles.resultSnippet}>
                    {renderHighlightedSnippet(result.matchSnippet, localQuery)}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
});
