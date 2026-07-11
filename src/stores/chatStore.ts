/**
 * chatStore - 对话状态管理
 *
 * 管理对话消息列表、当前输入、发送状态、引用管理等。
 *
 * 重要设计：
 * - Hub 窗口：引用按 Hub ID 隔离存储（pendingQuotesByHub）
 * - Agent 窗口：引用按 Agent ID 隔离存储（pendingQuotesByAgent），避免跨 Agent 共享
 * - 流式输出：按 contextId（Agent ID 或 Hub ID）隔离存储，避免切换窗口时状态混乱
 */

import { create } from 'zustand';
import type { Message } from '../types';
import type { QuoteInfo } from '../types/message';
import { getLogger } from '@services/logger';
import type { ChatMode, LegacyChatMode } from '@/types/chatMode';
import { normalizeChatMode } from '@/types/chatMode';
import type { VisualEnhancementJobState } from '@services/planning/visual-enhancer/VisualEnhancementJobManager';

const logger = getLogger('chatStore');

// ==================== 类型定义 ====================

/** 流式状态（按 contextId 隔离） */
interface StreamingState {
  content: string;
  reasoningContent?: string;
  isStreaming: boolean;
  /** 响应中的 Agent 名称（用于 Hub 窗口显示） */
  agentName?: string;
}

/** 搜索结果条目 */
interface SearchResult {
  /** 匹配消息 ID */
  messageId: string;
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 消息原始内容（用于高亮片段提取） */
  content: string;
  /** 发送者名称 */
  senderName: string;
  /** 时间戳 */
  timestamp: string | number;
  /** 包含高亮标记的内容片段 */
  matchSnippet: string;
}

/** 搜索状态（按 contextId 隔离） */
interface SearchState {
  /** 搜索栏是否展开 */
  isOpen: boolean;
  /** 搜索关键字 */
  query: string;
  /** 匹配结果列表 */
  results: SearchResult[];
  /** 键盘导航当前选中索引（-1 = 无选中） */
  activeIndex: number;
}

/** 多选状态（按 contextId 隔离） */
interface MultiSelectState {
  /** 是否处于多选模式 */
  isActive: boolean;
  /** 已选消息 ID 集合 */
  selectedIds: Set<string>;
}

export type { SearchResult, SearchState, MultiSelectState };

/** 对话状态 */
interface ChatState {
  /** 当前 Agent ID */
  currentAgentId: string | null;
  /** Agent 消息列表（按 Agent ID 分组） */
  messagesByAgent: Map<string, Message[]>;
  /** Hub 消息列表（按 Hub ID 分组） */
  messagesByHub: Map<string, Message[]>;
  /** 当前输入内容 */
  inputContent: string;
  /** 正在发送的上下文 ID 集合（按 contextId 隔离，支持跨 Agent 并行发送） */
  sendingContexts: Set<string>;
  /** 模式选择（按 contextId 隔离，每个 Agent/Hub 独立维护） */
  modeByContext: Map<string, ChatMode>;
  /** Hub 窗口引用列表（按 Hub ID 分组） */
  pendingQuotesByHub: Map<string, QuoteInfo[]>;
  /** Agent 窗口引用列表（按 Agent ID 分组，隔离存储） */
  pendingQuotesByAgent: Map<string, QuoteInfo[]>;
  /** 流式响应状态（按 contextId 隔离：Agent ID 或 Hub ID） */
  streamingByContext: Map<string, StreamingState>;
  /** 消息级可视化增强后台任务状态（按 messageId 隔离） */
  visualEnhancementJobsByMessage: Map<string, VisualEnhancementJobState>;
  /** 中断控制器（按 contextId 隔离） */
  abortControllers: Map<string, AbortController>;
  /** 流式请求 session ID（按 contextId 隔离，用于后端取消） */
  sessionIdByContext: Map<string, string>;
  /** 搜索状态（按 contextId 隔离） */
  searchByContext: Map<string, SearchState>;
  /** 多选状态（按 contextId 隔离） */
  multiSelectByContext: Map<string, MultiSelectState>;
  /** 每个 Agent 的最后查看时间戳（用于未读消息判断） */
  lastReadByAgent: Map<string, number>;
  /** 标记每个 Agent 是否还有更早的历史消息可加载（分页用） */
  hasMoreByAgent: Map<string, boolean>;
  /** 标记每个 Hub 是否还有更早的历史消息可加载（分页用） */
  hasMoreByHub: Map<string, boolean>;
}

/** 对话操作 */
interface ChatActions {
  /** 设置当前 Agent */
  setCurrentAgent: (agentId: string | null) => void;

  // ========== Agent 消息操作 ==========
  /** 添加 Agent 消息 */
  addMessage: (agentId: string, message: Message) => void;
  /** 设置 Agent 消息列表 */
  setMessages: (agentId: string, messages: Message[]) => void;
  /** 更新指定 Agent 消息 */
  updateMessage: (agentId: string, messageId: string, updates: Partial<Message>) => void;
  /** 向头部插入更早的历史消息（"加载更多"用） */
  prependMessages: (agentId: string, olderMessages: Message[]) => void;
  /** 清空 Agent 消息 */
  clearMessages: (agentId: string) => void;
  /** 设置指定 Agent 是否还有更早历史可加载 */
  setHasMore: (agentId: string, hasMore: boolean) => void;
  /** 查询指定 Agent 是否还有更早历史可加载 */
  getHasMore: (agentId: string) => boolean;

  // ========== Hub 消息操作 ==========
  /** 添加 Hub 消息 */
  addHubMessage: (hubId: string, message: Message) => void;
  /** 设置 Hub 消息列表 */
  setHubMessages: (hubId: string, messages: Message[]) => void;
  /** 更新指定 Hub 消息 */
  updateHubMessage: (hubId: string, messageId: string, updates: Partial<Message>) => void;
  /** 向头部插入更早的 Hub 历史消息（"加载更多"用） */
  prependHubMessages: (hubId: string, olderMessages: Message[]) => void;
  /** 获取 Hub 消息列表 */
  getHubMessages: (hubId: string) => Message[];
  /** 设置指定 Hub 是否还有更早历史可加载 */
  setHubHasMore: (hubId: string, hasMore: boolean) => void;
  /** 查询指定 Hub 是否还有更早历史可加载 */
  getHubHasMore: (hubId: string) => boolean;

  /** 设置输入内容 */
  setInputContent: (content: string) => void;
  /** 标记指定上下文开始发送 */
  startSending: (contextId: string) => void;
  /** 标记指定上下文完成发送 */
  finishSending: (contextId: string) => void;
  /** 查询指定上下文是否正在发送 */
  isSendingFor: (contextId: string) => boolean;
  /** 设置指定上下文的模式 */
  setModeFor: (contextId: string, mode: LegacyChatMode) => void;
  /** 获取指定上下文的模式（默认 planning） */
  getModeFor: (contextId: string) => ChatMode;

  // ========== Hub 窗口引用操作 ==========
  /** 添加引用到 Hub（需指定 Hub ID） */
  addQuote: (hubId: string, quote: QuoteInfo) => void;
  /** 获取指定 Hub 的引用列表 */
  getQuotesByHub: (hubId: string) => QuoteInfo[];
  /** 从 Hub 移除引用（需指定 Hub ID） */
  removeQuote: (hubId: string, messageId: string) => void;
  /** 清空指定 Hub 的引用 */
  clearQuotes: (hubId: string) => void;

  // ========== Agent 窗口引用操作（隔离存储）==========
  /** 添加引用到 Agent（按 Agent ID 隔离） */
  addQuoteToAgent: (agentId: string, quote: QuoteInfo) => void;
  /** 获取指定 Agent 的引用列表 */
  getQuotesByAgent: (agentId: string) => QuoteInfo[];
  /** 从 Agent 移除引用 */
  removeQuoteFromAgent: (agentId: string, messageId: string) => void;
  /** 清空指定 Agent 的引用 */
  clearAgentQuotes: (agentId: string) => void;

  // ========== 流式状态操作（按 contextId 隔离）==========
  /** 开始流式接收 */
  startStreaming: (contextId: string, agentName?: string) => void;
  /** 追加流式内容 */
  appendStreamingContent: (contextId: string, chunk: string) => void;
  /** 追加流式 reasoning 内容 */
  appendStreamingReasoning: (contextId: string, chunk: string) => void;
  /** 覆盖式设置流式内容（VE 增强等场景，回调传入的是累积内容而非增量 delta） */
  setStreamingContent: (contextId: string, content: string) => void;

  /** 完成流式接收 */
  finishStreaming: (contextId: string) => void;
  /** 获取指定 context 的流式状态 */
  getStreamingState: (contextId: string) => StreamingState;
  /** 设置中断控制器 */
  setAbortController: (contextId: string, controller: AbortController) => void;
  /** 设置流式请求 session ID（用于后端取消） */
  setSessionId: (contextId: string, sessionId: string) => void;
  /** 停止流式输出（触发中断） */
  stopStreaming: (contextId: string) => void;

  // ========== 可视化增强后台任务状态 ==========
  /** 设置或清理指定消息的增强任务状态 */
  setVisualEnhancementJobState: (
    messageId: string,
    jobState: VisualEnhancementJobState | null
  ) => void;

  // ========== 搜索操作（按 contextId 隔离）==========
  /** 打开搜索栏 */
  openSearch: (contextId: string) => void;
  /** 关闭搜索栏 */
  closeSearch: (contextId: string) => void;
  /** 设置搜索关键字 */
  setSearchQuery: (contextId: string, query: string) => void;
  /** 设置搜索结果 */
  setSearchResults: (contextId: string, results: SearchResult[]) => void;
  /** 设置键盘导航活跃索引 */
  setSearchActiveIndex: (contextId: string, index: number) => void;

  // ========== 多选操作（按 contextId 隔离）==========
  /** 进入多选模式（可带初始选中的消息 ID） */
  enterMultiSelect: (contextId: string, initialId?: string) => void;
  /** 退出多选模式 */
  exitMultiSelect: (contextId: string) => void;
  /** 切换消息选中状态 */
  toggleMessageSelect: (contextId: string, messageId: string) => void;
  /** 全选 */
  selectAllMessages: (contextId: string, messageIds: string[]) => void;
  /** 清空选中 */
  clearSelection: (contextId: string) => void;

  /** 获取当前 Agent 消息 */
  getCurrentMessages: () => Message[];

  // ========== 未读追踪 ==========
  /** 标记 Agent 消息已读（将 lastRead 设为当前时间） */
  markAsRead: (agentId: string) => void;
}

// ==================== Store 创建 ====================

export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  // 初始状态
  currentAgentId: null,
  messagesByAgent: new Map(),
  messagesByHub: new Map(), // Hub 消息存储
  inputContent: '',
  sendingContexts: new Set(), // 发送状态（按 contextId 隔离）
  modeByContext: new Map(), // 模式状态（按 contextId 隔离）
  pendingQuotesByHub: new Map(), // Hub 窗口引用存储
  pendingQuotesByAgent: new Map(), // Agent 窗口引用存储（隔离）
  streamingByContext: new Map(), // 流式状态（按 contextId 隔离）
  visualEnhancementJobsByMessage: new Map(), // VE 后台任务状态（按 messageId 隔离）
  abortControllers: new Map(), // 中断控制器（按 contextId 隔离）
  sessionIdByContext: new Map(), // 流式 session ID（用于后端取消）
  searchByContext: new Map(), // 搜索状态（按 contextId 隔离）
  multiSelectByContext: new Map(), // 多选状态（按 contextId 隔离）
  lastReadByAgent: new Map(), // 未读追踪（agentId → lastRead 时间戳）
  hasMoreByAgent: new Map(), // 分页标记（agentId → 是否还有更早消息）
  hasMoreByHub: new Map(), // 分页标记（hubId → 是否还有更早消息）

  // 操作
  setCurrentAgent: (agentId) => set({ currentAgentId: agentId }),

  addMessage: (agentId, message) =>
    set((state) => {
      const newMap = new Map(state.messagesByAgent);
      const messages = newMap.get(agentId) ?? [];
      newMap.set(agentId, [...messages, message]);
      return { messagesByAgent: newMap };
    }),

  setMessages: (agentId, messages) =>
    set((state) => {
      const newMap = new Map(state.messagesByAgent);
      newMap.set(agentId, messages);
      return { messagesByAgent: newMap };
    }),

  updateMessage: (agentId, messageId, updates) =>
    set((state) => {
      const newMap = new Map(state.messagesByAgent);
      const messages = newMap.get(agentId) ?? [];
      newMap.set(
        agentId,
        messages.map((message) => (message.id === messageId ? { ...message, ...updates } : message))
      );
      return { messagesByAgent: newMap };
    }),

  prependMessages: (agentId, olderMessages) =>
    set((state) => {
      const newMap = new Map(state.messagesByAgent);
      const existing = newMap.get(agentId) ?? [];
      // 去重：避免边界条件下同一消息被插入两次
      const existingIds = new Set(existing.map((m) => m.id));
      const uniqueOlder = olderMessages.filter((m) => !existingIds.has(m.id));
      newMap.set(agentId, [...uniqueOlder, ...existing]);
      return { messagesByAgent: newMap };
    }),

  clearMessages: (agentId) =>
    set((state) => {
      const newMap = new Map(state.messagesByAgent);
      newMap.delete(agentId);
      return { messagesByAgent: newMap };
    }),

  setHasMore: (agentId, hasMore) =>
    set((state) => {
      const newMap = new Map(state.hasMoreByAgent);
      newMap.set(agentId, hasMore);
      return { hasMoreByAgent: newMap };
    }),

  getHasMore: (agentId) => get().hasMoreByAgent.get(agentId) ?? false,

  // ========== Hub 消息操作 ==========
  addHubMessage: (hubId, message) =>
    set((state) => {
      const newMap = new Map(state.messagesByHub);
      const messages = newMap.get(hubId) ?? [];
      newMap.set(hubId, [...messages, message]);
      return { messagesByHub: newMap };
    }),

  setHubMessages: (hubId, messages) =>
    set((state) => {
      const newMap = new Map(state.messagesByHub);
      newMap.set(hubId, messages);
      return { messagesByHub: newMap };
    }),

  updateHubMessage: (hubId, messageId, updates) =>
    set((state) => {
      const newMap = new Map(state.messagesByHub);
      const messages = newMap.get(hubId) ?? [];
      newMap.set(
        hubId,
        messages.map((message) => (message.id === messageId ? { ...message, ...updates } : message))
      );
      return { messagesByHub: newMap };
    }),

  prependHubMessages: (hubId, olderMessages) =>
    set((state) => {
      const newMap = new Map(state.messagesByHub);
      const existing = newMap.get(hubId) ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const uniqueOlder = olderMessages.filter((m) => !existingIds.has(m.id));
      newMap.set(hubId, [...uniqueOlder, ...existing]);
      return { messagesByHub: newMap };
    }),

  getHubMessages: (hubId) => {
    const { messagesByHub } = get();
    return messagesByHub.get(hubId) ?? [];
  },

  setHubHasMore: (hubId, hasMore) =>
    set((state) => {
      const newMap = new Map(state.hasMoreByHub);
      newMap.set(hubId, hasMore);
      return { hasMoreByHub: newMap };
    }),

  getHubHasMore: (hubId) => get().hasMoreByHub.get(hubId) ?? false,

  setInputContent: (content: string) => set({ inputContent: content }),

  // 按 contextId 隔离的发送状态管理
  startSending: (contextId) =>
    set((state) => {
      const next = new Set(state.sendingContexts);
      next.add(contextId);
      return { sendingContexts: next };
    }),
  finishSending: (contextId) =>
    set((state) => {
      const next = new Set(state.sendingContexts);
      next.delete(contextId);
      return { sendingContexts: next };
    }),
  isSendingFor: (contextId) => get().sendingContexts.has(contextId),

  setModeFor: (contextId, mode) =>
    set((state) => {
      const newMap = new Map(state.modeByContext);
      newMap.set(contextId, normalizeChatMode(mode));
      return { modeByContext: newMap };
    }),
  getModeFor: (contextId) => normalizeChatMode(get().modeByContext.get(contextId)),

  // ========== Hub 窗口引用操作 ==========
  addQuote: (hubId, quote) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByHub);
      const quotes = newMap.get(hubId) ?? [];
      if (!quotes.some((q) => q.messageId === quote.messageId)) {
        newMap.set(hubId, [...quotes, quote]);
      }
      return { pendingQuotesByHub: newMap };
    }),

  getQuotesByHub: (hubId) => {
    const { pendingQuotesByHub } = get();
    return pendingQuotesByHub.get(hubId) ?? [];
  },

  removeQuote: (hubId, messageId) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByHub);
      const quotes = newMap.get(hubId) ?? [];
      newMap.set(
        hubId,
        quotes.filter((q) => q.messageId !== messageId)
      );
      return { pendingQuotesByHub: newMap };
    }),

  clearQuotes: (hubId) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByHub);
      newMap.delete(hubId);
      return { pendingQuotesByHub: newMap };
    }),

  // ========== Agent 窗口引用操作（隔离存储）==========
  addQuoteToAgent: (agentId, quote) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByAgent);
      const quotes = newMap.get(agentId) ?? [];
      if (!quotes.some((q) => q.messageId === quote.messageId)) {
        newMap.set(agentId, [...quotes, quote]);
      }
      return { pendingQuotesByAgent: newMap };
    }),

  getQuotesByAgent: (agentId) => {
    const { pendingQuotesByAgent } = get();
    return pendingQuotesByAgent.get(agentId) ?? [];
  },

  removeQuoteFromAgent: (agentId, messageId) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByAgent);
      const quotes = newMap.get(agentId) ?? [];
      newMap.set(
        agentId,
        quotes.filter((q) => q.messageId !== messageId)
      );
      return { pendingQuotesByAgent: newMap };
    }),

  clearAgentQuotes: (agentId) =>
    set((state) => {
      const newMap = new Map(state.pendingQuotesByAgent);
      newMap.delete(agentId);
      return { pendingQuotesByAgent: newMap };
    }),

  // ========== 流式状态操作（按 contextId 隔离）==========
  startStreaming: (contextId: string, agentName?: string) =>
    set((state) => {
      const newMap = new Map(state.streamingByContext);
      newMap.set(contextId, {
        content: '',
        reasoningContent: '',
        isStreaming: true,
        agentName,
      });
      return { streamingByContext: newMap };
    }),

  appendStreamingContent: (contextId: string, chunk: string) =>
    set((state) => {
      const newMap = new Map(state.streamingByContext);
      const current = newMap.get(contextId) ?? {
        content: '',
        isStreaming: true,
        agentName: undefined,
      };
      // 保留 agentName 不变
      newMap.set(contextId, {
        content: current.content + chunk,
        reasoningContent: current.reasoningContent,
        isStreaming: true,
        agentName: current.agentName,
      });
      return { streamingByContext: newMap };
    }),

  appendStreamingReasoning: (contextId: string, chunk: string) =>
    set((state) => {
      const newMap = new Map(state.streamingByContext);
      const current = newMap.get(contextId) ?? {
        content: '',
        reasoningContent: '',
        isStreaming: true,
        agentName: undefined,
      };
      newMap.set(contextId, {
        content: current.content,
        reasoningContent: (current.reasoningContent ?? '') + chunk,
        isStreaming: true,
        agentName: current.agentName,
      });
      return { streamingByContext: newMap };
    }),

  setStreamingContent: (contextId: string, content: string) =>
    set((state) => {
      const newMap = new Map(state.streamingByContext);
      const current = newMap.get(contextId) ?? {
        content: '',
        isStreaming: true,
        agentName: undefined,
      };
      // 覆盖式设置内容，保留 agentName 和 isStreaming 状态
      newMap.set(contextId, {
        content,
        reasoningContent: current.reasoningContent,
        isStreaming: true,
        agentName: current.agentName,
      });
      return { streamingByContext: newMap };
    }),

  finishStreaming: (contextId: string) =>
    set((state) => {
      const newMap = new Map(state.streamingByContext);
      const current = newMap.get(contextId);
      if (current) {
        // 清空内容和流式状态，但保留 agentName
        newMap.set(contextId, {
          content: '',
          reasoningContent: '',
          isStreaming: false,
          agentName: current.agentName,
        });
      }
      const newAbortMap = new Map(state.abortControllers);
      newAbortMap.delete(contextId);
      const newSessionMap = new Map(state.sessionIdByContext);
      newSessionMap.delete(contextId);
      return {
        abortControllers: newAbortMap,
        sessionIdByContext: newSessionMap,
        streamingByContext: newMap,
      };
    }),

  getStreamingState: (contextId: string): StreamingState => {
    const { streamingByContext } = get();
    return streamingByContext.get(contextId) ?? { content: '', isStreaming: false };
  },

  // 设置中断控制器
  setAbortController: (contextId: string, controller: AbortController) =>
    set((state) => {
      const newMap = new Map(state.abortControllers);
      newMap.set(contextId, controller);
      return { abortControllers: newMap };
    }),

  // 设置流式请求 session ID（用于后端取消）
  setSessionId: (contextId: string, sessionId: string) =>
    set((state) => {
      const newMap = new Map(state.sessionIdByContext);
      newMap.set(contextId, sessionId);
      return { sessionIdByContext: newMap };
    }),

  // 停止流式输出（触发中断并清理状态，同时通知后端取消）
  stopStreaming: (contextId: string) => {
    const { abortControllers, sessionIdByContext } = get();

    // 1. 中断本地 AbortController
    const controller = abortControllers.get(contextId);
    if (controller) {
      controller.abort();
      logger.debug('[chatStore] 已中断流式输出:', contextId);
    }

    // 2. 调用后端取消命令（如果有活跃的 session）
    const sessionId = sessionIdByContext.get(contextId);
    if (sessionId) {
      // 使用动态导入避免顶层依赖
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => {
          return invoke('llm_cancel_stream', { sessionId })
            .then(() => logger.debug('[chatStore] 已发送后端取消信号:', sessionId))
            .catch((err: unknown) => logger.warn('[chatStore] 后端取消失败:', err));
        })
        .catch((err: unknown) => {
          logger.warn('[chatStore] 加载 Tauri invoke 失败:', err);
        });
    }

    // 3. 清理状态
    set((state) => {
      const newAbortMap = new Map(state.abortControllers);
      newAbortMap.delete(contextId);
      const newSessionMap = new Map(state.sessionIdByContext);
      newSessionMap.delete(contextId);
      const newStreamingMap = new Map(state.streamingByContext);
      const current = newStreamingMap.get(contextId);
      if (current) {
        newStreamingMap.set(contextId, {
          ...current,
          isStreaming: false,
        });
      }
      return {
        abortControllers: newAbortMap,
        sessionIdByContext: newSessionMap,
        streamingByContext: newStreamingMap,
      };
    });
  },

  setVisualEnhancementJobState: (messageId, jobState) =>
    set((state) => {
      const next = new Map(state.visualEnhancementJobsByMessage);
      if (jobState) {
        next.set(messageId, jobState);
      } else {
        next.delete(messageId);
      }
      return { visualEnhancementJobsByMessage: next };
    }),

  // ========== 搜索操作（按 contextId 隔离）==========
  openSearch: (contextId) =>
    set((state) => {
      const newMap = new Map(state.searchByContext);
      const current = newMap.get(contextId);
      newMap.set(contextId, {
        isOpen: true,
        query: current?.query ?? '',
        results: current?.results ?? [],
        activeIndex: -1,
      });
      return { searchByContext: newMap };
    }),

  closeSearch: (contextId) =>
    set((state) => {
      const newMap = new Map(state.searchByContext);
      newMap.delete(contextId);
      return { searchByContext: newMap };
    }),

  setSearchQuery: (contextId, query) =>
    set((state) => {
      const newMap = new Map(state.searchByContext);
      const current = newMap.get(contextId) ?? {
        isOpen: true,
        query: '',
        results: [],
        activeIndex: -1,
      };
      newMap.set(contextId, { ...current, query, activeIndex: -1 });
      return { searchByContext: newMap };
    }),

  setSearchResults: (contextId, results) =>
    set((state) => {
      const newMap = new Map(state.searchByContext);
      const current = newMap.get(contextId) ?? {
        isOpen: true,
        query: '',
        results: [],
        activeIndex: -1,
      };
      newMap.set(contextId, { ...current, results });
      return { searchByContext: newMap };
    }),

  setSearchActiveIndex: (contextId, index) =>
    set((state) => {
      const newMap = new Map(state.searchByContext);
      const current = newMap.get(contextId);
      if (current) {
        newMap.set(contextId, { ...current, activeIndex: index });
      }
      return { searchByContext: newMap };
    }),

  // ========== 多选操作（按 contextId 隔离）==========
  enterMultiSelect: (contextId, initialId) =>
    set((state) => {
      const newMap = new Map(state.multiSelectByContext);
      const selectedIds = new Set<string>();
      if (initialId) selectedIds.add(initialId);
      newMap.set(contextId, { isActive: true, selectedIds });
      return { multiSelectByContext: newMap };
    }),

  exitMultiSelect: (contextId) =>
    set((state) => {
      const newMap = new Map(state.multiSelectByContext);
      newMap.delete(contextId);
      return { multiSelectByContext: newMap };
    }),

  toggleMessageSelect: (contextId, messageId) =>
    set((state) => {
      const newMap = new Map(state.multiSelectByContext);
      const current = newMap.get(contextId);
      if (!current) return state;
      const newSelected = new Set(current.selectedIds);
      if (newSelected.has(messageId)) {
        newSelected.delete(messageId);
      } else {
        newSelected.add(messageId);
      }
      newMap.set(contextId, { ...current, selectedIds: newSelected });
      return { multiSelectByContext: newMap };
    }),

  selectAllMessages: (contextId, messageIds) =>
    set((state) => {
      const newMap = new Map(state.multiSelectByContext);
      const current = newMap.get(contextId);
      if (!current) return state;
      newMap.set(contextId, { ...current, selectedIds: new Set(messageIds) });
      return { multiSelectByContext: newMap };
    }),

  clearSelection: (contextId) =>
    set((state) => {
      const newMap = new Map(state.multiSelectByContext);
      const current = newMap.get(contextId);
      if (!current) return state;
      newMap.set(contextId, { ...current, selectedIds: new Set<string>() });
      return { multiSelectByContext: newMap };
    }),

  getCurrentMessages: () => {
    const { currentAgentId, messagesByAgent } = get();
    if (!currentAgentId) return [];
    return messagesByAgent.get(currentAgentId) ?? [];
  },

  // ========== 未读追踪 ==========
  markAsRead: (agentId) =>
    set((state) => {
      const newMap = new Map(state.lastReadByAgent);
      newMap.set(agentId, Date.now());
      return { lastReadByAgent: newMap };
    }),
}));
