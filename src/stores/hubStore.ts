import { create } from 'zustand';
import { useAgentStore } from './agentStore';

export const CURRENT_HUB_STORAGE_KEY = 'agentvis.currentHubId';

function getHubSelectionStorage(): Storage | null {
  try {
    const globalScope = globalThis as typeof globalThis & { localStorage?: Storage };
    return globalScope.localStorage ?? null;
  } catch {
    return null;
  }
}

function loadPersistedCurrentHubId(): string | null {
  try {
    const value = getHubSelectionStorage()?.getItem(CURRENT_HUB_STORAGE_KEY) ?? null;
    return value?.trim() ? value : null;
  } catch {
    return null;
  }
}

function persistCurrentHubId(id: string | null): void {
  try {
    const storage = getHubSelectionStorage();
    if (!storage) return;

    if (id) {
      storage.setItem(CURRENT_HUB_STORAGE_KEY, id);
    } else {
      storage.removeItem(CURRENT_HUB_STORAGE_KEY);
    }
  } catch {
    // Hub selection persistence is a convenience; switching should still work without storage.
  }
}

/**
 * Hub 类型定义
 */
interface Hub {
  id: string;
  name: string;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hub 状态类型
 */
interface HubState {
  // 数据
  hubs: Hub[];
  currentHubId: string | null;

  // 加载状态
  isLoading: boolean;
  error: string | null;

  // Actions
  setHubs: (hubs: Hub[]) => void;
  addHub: (hub: Hub) => void;
  updateHub: (id: string, data: Partial<Hub>) => void;
  reorderHubs: (orderedIds: string[]) => void;
  removeHub: (id: string) => void;
  setCurrentHubId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

/**
 * Hub Store - 管理 Hub 列表和当前选中的 Hub
 *
 * Phase 1 将与 Tauri Commands 集成实现持久化
 */
export const useHubStore = create<HubState>((set, get) => ({
  // 初始状态
  hubs: [],
  currentHubId: loadPersistedCurrentHubId(),
  isLoading: false,
  error: null,

  // Actions
  setHubs: (hubs) => set({ hubs }),
  addHub: (hub) => set((state) => ({ hubs: [...state.hubs, hub] })),
  updateHub: (id, data) =>
    set((state) => ({
      hubs: state.hubs.map((h) => (h.id === id ? { ...h, ...data } : h)),
    })),
  reorderHubs: (orderedIds) =>
    set((state) => {
      const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
      return {
        hubs: [...state.hubs]
          .sort((a, b) => {
            const aOrder = orderMap.get(a.id);
            const bOrder = orderMap.get(b.id);
            if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
            if (aOrder !== undefined) return -1;
            if (bOrder !== undefined) return 1;
            return 0;
          })
          .map((hub) => {
            const sortOrder = orderMap.get(hub.id);
            return sortOrder === undefined ? hub : { ...hub, sortOrder };
          }),
      };
    }),
  removeHub: (id) => {
    useAgentStore.getState().removeAgentsByHubId(id);
    const nextCurrentHubId = get().currentHubId === id ? null : get().currentHubId;
    persistCurrentHubId(nextCurrentHubId);
    set((state) => ({
      hubs: state.hubs.filter((h) => h.id !== id),
      // 如果删除的是当前 Hub，清空选中状态
      currentHubId: nextCurrentHubId,
    }));
  },
  setCurrentHubId: (id) => {
    persistCurrentHubId(id);
    set({ currentHubId: id });
  },
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}));
