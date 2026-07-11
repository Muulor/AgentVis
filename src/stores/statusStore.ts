/**
 * statusStore - 状态栏状态管理
 *
 * 管理底部状态栏显示的信息：
 * - 当前使用的模型名称和状态
 * - Token 使用情况（按 Agent 隔离，双维度：实时压力 + 累积用量）
 * - 记忆系统状态
 * - 文档处理进度
 */

import { create } from 'zustand';

// ==================== 类型定义 ====================

/** 记忆系统状态 */
type MemoryStatus = 'idle' | 'organizing' | 'completed';

/** 模型状态：已配置/未配置/错误 */
type ModelStatus = 'online' | 'unconfigured' | 'error';

/** 文档处理进度状态 */
export interface DocumentProgress {
  /** 是否正在处理 */
  isProcessing: boolean;
  /** 当前进度消息 */
  message: string;
  /** 正在处理的文件名 */
  fileName: string;
}

/** 单个 Agent 的累积 Token 用量（应用重启自动清零） */
export interface AgentTokenUsage {
  /** 累积输入 token 总和（所有 LLM 调用的 input_tokens） */
  inputTokens: number;
  /** 累积输出 token 总和（所有 LLM 调用的 output_tokens） */
  outputTokens: number;
}

/** 实时上下文压力（当前 LLM 调用的 input 占上下文窗口比例） */
export interface ContextPressure {
  /** 当前调用的 input token 数 */
  currentInputTokens: number;
  /** 模型上下文窗口大小 */
  contextWindowSize: number;
}

/** 状态栏状态 */
interface StatusState {
  // ══ Token 统计（双维度，按 Agent 隔离） ══

  /** 累积 Token 用量（按 Agent 隔离） */
  tokenUsageByAgent: Record<string, AgentTokenUsage>;
  /** 实时上下文压力（按 Agent 隔离，仅活跃 LLM 调用时有值） */
  contextPressureByAgent: Record<string, ContextPressure>;

  /**
   * 当前活跃视图的上下文 ID（Agent 视图 = agentId，Hub 视图 = hubId）
   *
   * 由 AgentChatView / HubChatView 在挂载时设置，
   * StatusBar 和 token 写入侧统一通过此字段确定 token 读写键，
   * 解决 Hub 视图下 currentAgentId 为 null 导致 token 数据读写不一致的问题。
   */
  activeTokenContextId: string | null;

  // ══ 兼容旧接口（向后兼容，逐步废弃） ══

  /** @deprecated 使用 tokenUsageByAgent 代替 */
  tokenUsedByAgent: Record<string, number>;
  /** @deprecated 使用 contextPressureByAgent 代替 */
  tokenTotal: number;

  // ══ 其他状态 ══

  /** 模型状态 */
  modelStatus: ModelStatus;
  /** 记忆系统状态 */
  memoryStatus: MemoryStatus;
  /** 文档处理进度 */
  documentProgress: DocumentProgress | null;

  // ══ Token Actions ══

  /** 累加一次 LLM 调用的 token 用量（来自 API usage 响应） */
  addTokenUsage: (agentId: string, inputTokens: number, outputTokens: number) => void;
  /** 更新实时上下文压力（LLM 调用开始时） */
  setContextPressure: (agentId: string, currentInput: number, windowSize: number) => void;
  /** 清除实时上下文压力（LLM 调用结束时） */
  clearContextPressure: (agentId: string) => void;
  /** 获取指定 Agent 的累积 token 用量 */
  getAgentTokenUsage: (agentId: string) => AgentTokenUsage;
  /** 获取指定 Agent 的实时上下文压力（无则返回 null） */
  getContextPressure: (agentId: string) => ContextPressure | null;
  /** 设置当前活跃视图的上下文 ID */
  setActiveTokenContextId: (id: string | null) => void;

  // ══ 兼容旧 Actions（逐步废弃） ══

  /** @deprecated 使用 addTokenUsage 代替 */
  setTokenUsage: (agentId: string, used: number, total: number) => void;
  /** @deprecated 使用 addTokenUsage 代替 */
  setTokenUsed: (agentId: string, used: number) => void;
  /** @deprecated 使用 getAgentTokenUsage 代替 */
  getTokenUsed: (agentId: string) => number;
  /** 重置指定 Agent 的 token 使用量 */
  resetTokenUsage: (agentId: string) => void;

  // ══ 其他 Actions ══

  setModelStatus: (status: ModelStatus) => void;
  setMemoryStatus: (status: MemoryStatus) => void;
  setDocumentProgress: (progress: DocumentProgress | null) => void;
}

// ==================== Store 创建 ====================

export const useStatusStore = create<StatusState>((set, get) => ({
  // 初始状态
  tokenUsageByAgent: {},
  contextPressureByAgent: {},
  activeTokenContextId: null,

  // 兼容旧接口
  tokenUsedByAgent: {},
  tokenTotal: 128000,

  modelStatus: 'unconfigured',
  memoryStatus: 'idle',
  documentProgress: null,

  // ══ 新 Token Actions ══

  addTokenUsage: (agentId, inputTokens, outputTokens) =>
    set((state) => {
      const existing = state.tokenUsageByAgent[agentId] ?? { inputTokens: 0, outputTokens: 0 };
      const newUsage: AgentTokenUsage = {
        inputTokens: existing.inputTokens + inputTokens,
        outputTokens: existing.outputTokens + outputTokens,
      };
      // 同步更新旧接口的 tokenUsedByAgent（向后兼容）
      const totalUsed = newUsage.inputTokens + newUsage.outputTokens;
      return {
        tokenUsageByAgent: { ...state.tokenUsageByAgent, [agentId]: newUsage },
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        tokenUsedByAgent: { ...state.tokenUsedByAgent, [agentId]: totalUsed },
      };
    }),

  setContextPressure: (agentId, currentInput, windowSize) =>
    set((state) => ({
      contextPressureByAgent: {
        ...state.contextPressureByAgent,
        [agentId]: { currentInputTokens: currentInput, contextWindowSize: windowSize },
      },
    })),

  clearContextPressure: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.contextPressureByAgent;
      return { contextPressureByAgent: rest };
    }),

  getAgentTokenUsage: (agentId) =>
    get().tokenUsageByAgent[agentId] ?? { inputTokens: 0, outputTokens: 0 },

  getContextPressure: (agentId) => get().contextPressureByAgent[agentId] ?? null,

  // ══ 兼容旧 Actions ══

  setTokenUsage: (agentId, used, total) =>
    set((state) => ({
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      tokenUsedByAgent: { ...state.tokenUsedByAgent, [agentId]: used },
      tokenTotal: total,
    })),
  setTokenUsed: (agentId, used) =>
    set((state) => ({
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      tokenUsedByAgent: { ...state.tokenUsedByAgent, [agentId]: used },
    })),
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  getTokenUsed: (agentId) => get().tokenUsedByAgent[agentId] ?? 0,
  resetTokenUsage: (agentId) =>
    set((state) => ({
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      tokenUsedByAgent: { ...state.tokenUsedByAgent, [agentId]: 0 },
      tokenUsageByAgent: {
        ...state.tokenUsageByAgent,
        [agentId]: { inputTokens: 0, outputTokens: 0 },
      },
    })),

  // ══ 上下文 ID 管理 ══

  setActiveTokenContextId: (id) => set({ activeTokenContextId: id }),

  // ══ 其他 Actions ══

  setModelStatus: (status) => set({ modelStatus: status }),
  setMemoryStatus: (status) => set({ memoryStatus: status }),
  setDocumentProgress: (progress) => set({ documentProgress: progress }),
}));
