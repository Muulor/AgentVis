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

/** TODO(token-usage-ledger): 迁移到统一调用账本后移除 Session 累计类型。 */
export interface AgentTokenUsage {
  /** 累积输入 token 总和（所有 LLM 调用的 input_tokens） */
  inputTokens: number;
  /** 累积输出 token 总和（所有 LLM 调用的 output_tokens） */
  outputTokens: number;
}

export type ContextUsagePhase = 'active' | 'last';

/** 当前或最近一次 LLM 调用的上下文用量。 */
export interface ContextPressure {
  /** 当前或最近一次调用的 input token 数 */
  currentInputTokens: number;
  /** 当前或最近一次调用的 output token 数 */
  currentOutputTokens: number;
  /** 模型上下文窗口大小 */
  contextWindowSize: number;
  /** active 表示调用进行中，last 表示调用已完成但任务仍在继续。 */
  phase: ContextUsagePhase;
  /** 调用唯一 ID，用于阻止旧调用覆盖较新的上下文状态。 */
  callId: string;
  /** 调用用途，例如 chat、master-brain、sub-agent。 */
  purpose?: string;
  /** 调用使用的 Provider ID。 */
  providerId?: string;
  /** 调用使用的模型 ID。 */
  modelId?: string;
}

/** 开始追踪一次上下文调用所需的数据。 */
export interface BeginContextUsageData {
  callId: string;
  currentInputTokens?: number;
  currentOutputTokens?: number;
  contextWindowSize: number;
  purpose?: string;
  providerId?: string;
  modelId?: string;
}

/** 调用进行中或完成时可更新的上下文字段。 */
export type ContextUsagePatch = Partial<Omit<ContextPressure, 'phase' | 'callId'>>;

/** 状态栏状态 */
interface StatusState {
  // ══ Token 统计（双维度，按 Agent 隔离） ══

  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除 Session 累计。 */
  tokenUsageByAgent: Record<string, AgentTokenUsage>;
  /** 当前或最近一次调用的上下文用量（按 Agent/Hub 上下文隔离） */
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

  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除 Session 累计。 */
  addTokenUsage: (agentId: string, inputTokens: number, outputTokens: number) => void;
  /** 开始追踪一次 LLM 调用的上下文用量。 */
  beginContextUsage: (contextId: string, data: BeginContextUsageData) => void;
  /** 更新仍在进行中的调用；callId 不匹配或调用已完成时忽略。 */
  updateContextUsage: (contextId: string, callId: string, patch: ContextUsagePatch) => void;
  /** 完成调用并保留 Last Context；callId 不匹配时忽略。 */
  completeContextUsage: (contextId: string, callId: string, patch?: ContextUsagePatch) => void;
  /** @deprecated 使用 beginContextUsage / updateContextUsage / completeContextUsage 代替。 */
  setContextPressure: (agentId: string, currentInput: number, windowSize: number) => void;
  /** 清除上下文用量；传入 callId 时仅清除匹配调用。 */
  clearContextPressure: (contextId: string, callId?: string) => void;
  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除 Session 累计。 */
  getAgentTokenUsage: (agentId: string) => AgentTokenUsage;
  /** 获取指定 Agent 的实时上下文压力（无则返回 null） */
  getContextPressure: (agentId: string) => ContextPressure | null;
  /** 设置当前活跃视图的上下文 ID */
  setActiveTokenContextId: (id: string | null) => void;

  // ══ 兼容旧 Actions（逐步废弃） ══

  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除。 */
  setTokenUsage: (agentId: string, used: number, total: number) => void;
  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除。 */
  setTokenUsed: (agentId: string, used: number) => void;
  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除。 */
  getTokenUsed: (agentId: string) => number;
  /** @deprecated TODO(token-usage-ledger): 迁移到统一调用账本后移除。 */
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
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const existing = state.tokenUsageByAgent[agentId] ?? { inputTokens: 0, outputTokens: 0 };
      const newUsage: AgentTokenUsage = {
        inputTokens: existing.inputTokens + inputTokens,
        outputTokens: existing.outputTokens + outputTokens,
      };
      // 同步更新旧接口的 tokenUsedByAgent（向后兼容）
      const totalUsed = newUsage.inputTokens + newUsage.outputTokens;
      return {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        tokenUsageByAgent: { ...state.tokenUsageByAgent, [agentId]: newUsage },
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        tokenUsedByAgent: { ...state.tokenUsedByAgent, [agentId]: totalUsed },
      };
    }),

  beginContextUsage: (contextId, data) =>
    set((state) => ({
      contextPressureByAgent: {
        ...state.contextPressureByAgent,
        [contextId]: {
          currentInputTokens: data.currentInputTokens ?? 0,
          currentOutputTokens: data.currentOutputTokens ?? 0,
          contextWindowSize: data.contextWindowSize,
          phase: 'active',
          callId: data.callId,
          ...(data.purpose !== undefined ? { purpose: data.purpose } : {}),
          ...(data.providerId !== undefined ? { providerId: data.providerId } : {}),
          ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
        },
      },
    })),

  updateContextUsage: (contextId, callId, patch) =>
    set((state) => {
      const existing = state.contextPressureByAgent[contextId];
      if (existing?.callId !== callId || existing.phase !== 'active') {
        return state;
      }

      return {
        contextPressureByAgent: {
          ...state.contextPressureByAgent,
          [contextId]: { ...existing, ...patch, phase: 'active', callId },
        },
      };
    }),

  completeContextUsage: (contextId, callId, patch = {}) =>
    set((state) => {
      const existing = state.contextPressureByAgent[contextId];
      if (existing?.callId !== callId) {
        return state;
      }

      return {
        contextPressureByAgent: {
          ...state.contextPressureByAgent,
          [contextId]: { ...existing, ...patch, phase: 'last', callId },
        },
      };
    }),

  setContextPressure: (agentId, currentInput, windowSize) =>
    set((state) => ({
      contextPressureByAgent: {
        ...state.contextPressureByAgent,
        [agentId]: {
          currentInputTokens: currentInput,
          currentOutputTokens: 0,
          contextWindowSize: windowSize,
          phase: 'active',
          callId: `legacy:${agentId}`,
        },
      },
    })),

  clearContextPressure: (contextId, callId) =>
    set((state) => {
      const existing = state.contextPressureByAgent[contextId];
      if (!existing || (callId !== undefined && existing.callId !== callId)) {
        return state;
      }

      const { [contextId]: _, ...rest } = state.contextPressureByAgent;
      return { contextPressureByAgent: rest };
    }),

  getAgentTokenUsage: (agentId) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return get().tokenUsageByAgent[agentId] ?? { inputTokens: 0, outputTokens: 0 };
  },

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
        // eslint-disable-next-line @typescript-eslint/no-deprecated
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
