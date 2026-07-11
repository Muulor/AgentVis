/**
 * imChannelStore - IM 通道 Zustand 状态管理
 *
 * 多 Bot 架构版本：持久化状态改为 botConfigs[] 列表，
 * 每条配置描述一个机器人实例（凭据元信息 + Agent 绑定）。
 * 运行时连接状态以 per-botId Map 独立维护。
 *
 * 迁移兼容：旧字段 defaultHubId / defaultAgentId 保留为迁移哨兵，
 * 前端组件在挂载时检测并一次性转换为新格式，之后置空。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ImPlatform, ImTask, BotConfig } from '@services/im-channel/types';
import { getLogger } from '@services/logger';

const logger = getLogger('imChannelStore');

// ============================================================================
// per-Bot 运行时连接状态
// ============================================================================

/** 单个 Bot 的运行时连接状态（不持久化） */
export interface BotConnectionState {
  /** 当前是否已连接 */
  isConnected: boolean;
  /** 正在连接中 */
  isConnecting: boolean;
  /** 连接错误信息 */
  connectionError: string | null;
  /** 当前活跃的 IM 任务 */
  activeTask: ImTask | null;
  /** 历史处理任务总数（本次运行期间） */
  totalTasksHandled: number;
}

/** 创建空的 Bot 连接状态 */
function createEmptyBotConnectionState(): BotConnectionState {
  return {
    isConnected: false,
    isConnecting: false,
    connectionError: null,
    activeTask: null,
    totalTasksHandled: 0,
  };
}

// ============================================================================
// Store 类型定义
// ============================================================================

/** IM Channel 持久化配置 */
interface ImChannelPersistedConfig {
  /** Bot 配置列表（每条对应一个飞书机器人实例） */
  botConfigs: BotConfig[];
  /** 全局平台（保留用于未来扩展其他平台） */
  platform: ImPlatform | null;
  /** 是否在应用启动时自动连接所有启用的 Bot */
  autoConnect: boolean;

  // ─── 旧版字段（仅作迁移哨兵，读取后置空） ───
  /** @deprecated 已迁移至 botConfigs[0].hubId，保留用于一次性迁移检测 */
  defaultHubId: string | null;
  /** @deprecated 已迁移至 botConfigs[0].agentId，保留用于一次性迁移检测 */
  defaultAgentId: string | null;
}

/** IM Channel 运行时状态（不持久化） */
interface ImChannelRuntimeState {
  /** per-bot 连接状态，key = botId */
  connectionStates: Record<string, BotConnectionState>;
}

/** Store 动作 */
interface ImChannelActions {
  // ═══ Bot 配置管理 ═══
  addBotConfig: (config: BotConfig) => void;
  updateBotConfig: (botId: string, updates: Partial<Omit<BotConfig, 'botId'>>) => void;
  removeBotConfig: (botId: string) => void;

  // ═══ 全局配置操作 ═══
  setPlatform: (platform: ImPlatform | null) => void;
  setAutoConnect: (enabled: boolean) => void;

  // ═══ per-Bot 运行时状态操作 ═══
  setBotConnected: (botId: string, connected: boolean) => void;
  setBotConnectionError: (botId: string, error: string | null) => void;
  setBotConnecting: (botId: string, connecting: boolean) => void;
  setBotActiveTask: (botId: string, task: ImTask | null) => void;
  incrementBotTaskCount: (botId: string) => void;
  resetBotRuntime: (botId: string) => void;
  resetAllRuntime: () => void;

  // ─── 兼容旧接口（供自动连接逻辑读取唯一 Bot 状态） ───
  /** @deprecated 单 Bot 时代的接口，请直接操作 connectionStates */
  setConnected: (connected: boolean) => void;
  /** @deprecated */
  setConnectionError: (error: string | null) => void;
  /** @deprecated */
  setConnecting: (connecting: boolean) => void;
  /** @deprecated */
  setActiveTask: (task: ImTask | null) => void;
  /** @deprecated */
  incrementTaskCount: () => void;

  // ═══ 迁移辅助 ═══
  /** 清除旧版迁移哨兵字段 */
  clearLegacyFields: () => void;
  /** 设置旧版字段（仅供迁移读取，不对外暴露） */
  setDefaultHubId: (hubId: string | null) => void;
  setDefaultAgentId: (agentId: string | null) => void;
}

type ImChannelState = ImChannelPersistedConfig & ImChannelRuntimeState & ImChannelActions;

// ============================================================================
// 辅助：安全获取或初始化 per-bot 状态
// ============================================================================

function ensureBotState(
  states: Record<string, BotConnectionState>,
  botId: string
): Record<string, BotConnectionState> {
  if (!states[botId]) {
    return { ...states, [botId]: createEmptyBotConnectionState() };
  }
  return states;
}

// ============================================================================
// Store 创建
// ============================================================================

export const useImChannelStore = create<ImChannelState>()(
  persist(
    (set, get) => ({
      // ═══ 持久化配置（初始值） ═══
      botConfigs: [],
      platform: null,
      autoConnect: false,
      // 旧版迁移哨兵（初始 null，迁移完成后也为 null）
      defaultHubId: null,
      defaultAgentId: null,

      // ═══ 运行时状态（初始值） ═══
      connectionStates: {},

      // ═══ Bot 配置管理 ═══
      addBotConfig: (config) => {
        const { botConfigs } = get();
        const platformBotCount = botConfigs.filter(
          (bot) => bot.platform === config.platform
        ).length;
        if (platformBotCount >= 10) {
          // MAX_BOT_COUNT = 10，超出单平台数量限制时拒绝添加
          logger.warn(`平台 ${config.platform} 已达到最大 Bot 数量限制（10 个），无法继续添加`);
          return;
        }
        set({ botConfigs: [...botConfigs, config] });
        logger.info(`Bot 配置已添加: ${config.botId} (${config.displayName})`);
      },

      updateBotConfig: (botId, updates) => {
        set((state) => ({
          botConfigs: state.botConfigs.map((c) => (c.botId === botId ? { ...c, ...updates } : c)),
        }));
        logger.info(`Bot 配置已更新: ${botId}`);
      },

      removeBotConfig: (botId) => {
        set((state) => ({
          botConfigs: state.botConfigs.filter((c) => c.botId !== botId),
          // 同步清理对应的运行时状态，防止内存泄漏
          connectionStates: Object.fromEntries(
            Object.entries(state.connectionStates).filter(([k]) => k !== botId)
          ),
        }));
        logger.info(`Bot 配置已删除: ${botId}`);
      },

      // ═══ 全局配置操作 ═══
      setPlatform: (platform) => {
        set({ platform });
        logger.info(`IM 平台已设置: ${platform ?? 'none'}`);
      },

      setAutoConnect: (enabled) => {
        set({ autoConnect: enabled });
      },

      // ═══ per-Bot 运行时状态操作 ═══
      setBotConnected: (botId, connected) => {
        set((state) => {
          const states = ensureBotState(state.connectionStates, botId);
          const botState = states[botId] ?? createEmptyBotConnectionState();
          return {
            connectionStates: {
              ...states,
              [botId]: {
                ...botState,
                isConnected: connected,
                isConnecting: false,
                // 连接成功时清除错误信息
                connectionError: connected ? null : botState.connectionError,
              },
            },
          };
        });
      },

      setBotConnectionError: (botId, error) => {
        set((state) => {
          const states = ensureBotState(state.connectionStates, botId);
          const botState = states[botId] ?? createEmptyBotConnectionState();
          return {
            connectionStates: {
              ...states,
              [botId]: {
                ...botState,
                connectionError: error,
                isConnecting: false,
              },
            },
          };
        });
      },

      setBotConnecting: (botId, connecting) => {
        set((state) => {
          const states = ensureBotState(state.connectionStates, botId);
          const botState = states[botId] ?? createEmptyBotConnectionState();
          return {
            connectionStates: {
              ...states,
              [botId]: { ...botState, isConnecting: connecting },
            },
          };
        });
      },

      setBotActiveTask: (botId, task) => {
        set((state) => {
          const states = ensureBotState(state.connectionStates, botId);
          const botState = states[botId] ?? createEmptyBotConnectionState();
          return {
            connectionStates: {
              ...states,
              [botId]: { ...botState, activeTask: task },
            },
          };
        });
      },

      incrementBotTaskCount: (botId) => {
        set((state) => {
          const states = ensureBotState(state.connectionStates, botId);
          const botState = states[botId] ?? createEmptyBotConnectionState();
          return {
            connectionStates: {
              ...states,
              [botId]: {
                ...botState,
                totalTasksHandled: botState.totalTasksHandled + 1,
              },
            },
          };
        });
      },

      resetBotRuntime: (botId) => {
        set((state) => ({
          connectionStates: {
            ...state.connectionStates,
            [botId]: createEmptyBotConnectionState(),
          },
        }));
      },

      resetAllRuntime: () => {
        set({ connectionStates: {} });
      },

      // ─── 旧版兼容接口（操作第一个 Bot 的状态） ───
      // 用于 autoConnect 等只有单 Bot 的旧路径平滑过渡
      setConnected: (connected) => {
        const firstBotId = get().botConfigs[0]?.botId;
        if (firstBotId) {
          get().setBotConnected(firstBotId, connected);
        } else {
          logger.warn(
            'setConnected 调用失败：botConfigs 为空，状态未更新。请通过 setBotConnected(botId, ...) 调用。'
          );
        }
      },
      setConnectionError: (error) => {
        const firstBotId = get().botConfigs[0]?.botId;
        if (firstBotId) {
          get().setBotConnectionError(firstBotId, error);
        } else {
          logger.warn('setConnectionError 调用失败：botConfigs 为空。');
        }
      },
      setConnecting: (connecting) => {
        const firstBotId = get().botConfigs[0]?.botId;
        if (firstBotId) {
          get().setBotConnecting(firstBotId, connecting);
        } else {
          logger.warn('setConnecting 调用失败：botConfigs 为空。');
        }
      },
      setActiveTask: (task) => {
        const firstBotId = get().botConfigs[0]?.botId;
        if (firstBotId) {
          get().setBotActiveTask(firstBotId, task);
        } else {
          logger.warn('setActiveTask 调用失败：botConfigs 为空。');
        }
      },
      incrementTaskCount: () => {
        const firstBotId = get().botConfigs[0]?.botId;
        if (firstBotId) {
          get().incrementBotTaskCount(firstBotId);
        } else {
          logger.warn('incrementTaskCount 调用失败：botConfigs 为空。');
        }
      },

      // ═══ 迁移辅助 ═══
      clearLegacyFields: () => {
        set({ defaultHubId: null, defaultAgentId: null });
        logger.info('旧版 IM 迁移哨兵字段已清除');
      },
      setDefaultHubId: (hubId) => set({ defaultHubId: hubId }),
      setDefaultAgentId: (agentId) => set({ defaultAgentId: agentId }),
    }),
    {
      name: 'agentvis-im-channel',
      // 只持久化配置项，不持久化运行时连接状态
      partialize: (state) => ({
        botConfigs: state.botConfigs,
        platform: state.platform,
        autoConnect: state.autoConnect,
        // 旧版迁移哨兵字段（迁移完成后为 null）
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        defaultHubId: state.defaultHubId,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        defaultAgentId: state.defaultAgentId,
      }),
    }
  )
);

// ============================================================================
// 便捷选择器
// ============================================================================

/** 获取指定 Bot 的连接状态（不存在时返回默认空状态） */
export function getBotConnectionState(
  store: Pick<ImChannelState, 'connectionStates'>,
  botId: string
): BotConnectionState {
  return store.connectionStates[botId] ?? createEmptyBotConnectionState();
}
