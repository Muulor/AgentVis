/**
 * memoryStore - 记忆系统状态管理
 *
 * 管理记忆系统状态、水位线、事实/摘要缓存。
 */

import { create } from 'zustand';

// ==================== 类型定义 ====================

/** 事实信息 */
interface FactInfo {
  id: string;
  content: string;
  category: string;
  createdAt: number;
}

/** 摘要信息 */
interface SummaryInfo {
  id: string;
  content: string;
  createdAt: number;
}

/** 记忆统计 */
interface MemoryStats {
  shortTermCount: number;
  summaryCount: number;
  factCount: number;
  totalCount: number;
}

/** Memory Store 状态 */
interface MemoryStoreState {
  /** 当前 Agent ID */
  currentAgentId: string | null;
  /** 事实列表 */
  facts: FactInfo[];
  /** 摘要列表 */
  summaries: SummaryInfo[];
  /** 短期缓冲使用率 */
  bufferUsageRatio: number;
  /** 是否超过水位线 */
  isAboveWatermark: boolean;
  /** 记忆统计 */
  stats: MemoryStats | null;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
}

/** Memory Store 操作 */
interface MemoryStoreActions {
  /** 设置当前 Agent */
  setCurrentAgent: (agentId: string | null) => void;
  /** 设置事实列表 */
  setFacts: (facts: FactInfo[]) => void;
  /** 添加事实 */
  addFact: (fact: FactInfo) => void;
  /** 删除事实 */
  removeFact: (factId: string) => void;
  /** 更新事实 */
  updateFact: (factId: string, content: string) => void;
  /** 设置摘要列表 */
  setSummaries: (summaries: SummaryInfo[]) => void;
  /** 更新缓冲使用率 */
  setBufferUsage: (ratio: number, isAbove: boolean) => void;
  /** 设置统计 */
  setStats: (stats: MemoryStats) => void;
  /** 设置加载状态 */
  setIsLoading: (isLoading: boolean) => void;
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 重置 */
  reset: () => void;
}

// ==================== 初始状态 ====================

const initialState: MemoryStoreState = {
  currentAgentId: null,
  facts: [],
  summaries: [],
  bufferUsageRatio: 0,
  isAboveWatermark: false,
  stats: null,
  isLoading: false,
  error: null,
};

// ==================== Store 创建 ====================

export const useMemoryStore = create<MemoryStoreState & MemoryStoreActions>((set) => ({
  ...initialState,

  setCurrentAgent: (agentId) => set({ currentAgentId: agentId }),

  setFacts: (facts) => set({ facts }),

  addFact: (fact) =>
    set((state) => ({
      facts: [...state.facts, fact],
    })),

  removeFact: (factId) =>
    set((state) => ({
      facts: state.facts.filter((f) => f.id !== factId),
    })),

  updateFact: (factId, content) =>
    set((state) => ({
      facts: state.facts.map((f) => (f.id === factId ? { ...f, content } : f)),
    })),

  setSummaries: (summaries) => set({ summaries }),

  setBufferUsage: (ratio, isAbove) =>
    set({
      bufferUsageRatio: ratio,
      isAboveWatermark: isAbove,
    }),

  setStats: (stats) => set({ stats }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  reset: () => set(initialState),
}));
