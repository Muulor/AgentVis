/**
 * fileStore - 文件状态管理
 *
 * 管理文件列表、预览状态、快照历史。
 */

import { create } from 'zustand';

// ==================== 类型定义 ====================

/** 文件信息 */
interface FileInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  type: 'markdown' | 'text' | 'code' | 'unknown';
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

/** 快照信息 */
interface SnapshotInfo {
  id: string;
  documentId: string;
  description: string;
  createdAt: number;
}

/** 预览状态 */
interface PreviewState {
  fileId: string | null;
  content: string;
  isLoading: boolean;
}

/** File Store 状态 */
interface FileStoreState {
  /** 文件列表（按 Agent 分组） */
  filesByAgent: Map<string, FileInfo[]>;
  /** 当前预览状态 */
  preview: PreviewState;
  /** 快照列表（按文档 ID 分组） */
  snapshotsByDocument: Map<string, SnapshotInfo[]>;
  /** 当前选中的文件 ID */
  selectedFileId: string | null;
  /** 是否正在加载文件列表 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
}

/** File Store 操作 */
interface FileStoreActions {
  /** 设置文件列表 */
  setFiles: (agentId: string, files: FileInfo[]) => void;
  /** 添加文件 */
  addFile: (agentId: string, file: FileInfo) => void;
  /** 删除文件 */
  removeFile: (agentId: string, fileId: string) => void;
  /** 获取 Agent 文件 */
  getAgentFiles: (agentId: string) => FileInfo[];
  /** 设置预览 */
  setPreview: (fileId: string | null, content: string) => void;
  /** 设置预览加载状态 */
  setPreviewLoading: (isLoading: boolean) => void;
  /** 设置快照列表 */
  setSnapshots: (documentId: string, snapshots: SnapshotInfo[]) => void;
  /** 添加快照 */
  addSnapshot: (documentId: string, snapshot: SnapshotInfo) => void;
  /** 设置选中文件 */
  setSelectedFile: (fileId: string | null) => void;
  /** 设置加载状态 */
  setIsLoading: (isLoading: boolean) => void;
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 重置 */
  reset: () => void;
}

// ==================== 初始状态 ====================

const initialState: FileStoreState = {
  filesByAgent: new Map(),
  preview: {
    fileId: null,
    content: '',
    isLoading: false,
  },
  snapshotsByDocument: new Map(),
  selectedFileId: null,
  isLoading: false,
  error: null,
};

// ==================== Store 创建 ====================

export const useFileStore = create<FileStoreState & FileStoreActions>((set, get) => ({
  ...initialState,

  setFiles: (agentId, files) =>
    set((state) => {
      const newMap = new Map(state.filesByAgent);
      newMap.set(agentId, files);
      return { filesByAgent: newMap };
    }),

  addFile: (agentId, file) =>
    set((state) => {
      const newMap = new Map(state.filesByAgent);
      const files = newMap.get(agentId) ?? [];
      newMap.set(agentId, [...files, file]);
      return { filesByAgent: newMap };
    }),

  removeFile: (agentId, fileId) =>
    set((state) => {
      const newMap = new Map(state.filesByAgent);
      const files = newMap.get(agentId) ?? [];
      newMap.set(
        agentId,
        files.filter((f) => f.id !== fileId)
      );
      return { filesByAgent: newMap };
    }),

  getAgentFiles: (agentId) => {
    return get().filesByAgent.get(agentId) ?? [];
  },

  setPreview: (fileId, content) =>
    set({
      preview: {
        fileId,
        content,
        isLoading: false,
      },
    }),

  setPreviewLoading: (isLoading) =>
    set((state) => ({
      preview: { ...state.preview, isLoading },
    })),

  setSnapshots: (documentId, snapshots) =>
    set((state) => {
      const newMap = new Map(state.snapshotsByDocument);
      newMap.set(documentId, snapshots);
      return { snapshotsByDocument: newMap };
    }),

  addSnapshot: (documentId, snapshot) =>
    set((state) => {
      const newMap = new Map(state.snapshotsByDocument);
      const snapshots = newMap.get(documentId) ?? [];
      newMap.set(documentId, [...snapshots, snapshot]);
      return { snapshotsByDocument: newMap };
    }),

  setSelectedFile: (fileId) => set({ selectedFileId: fileId }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  reset: () => set(initialState),
}));
