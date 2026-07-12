/**
 * WorkspaceImportService - 工作区事务式拖拽导入
 *
 * 将 HTML5 File 按固定小块发送到 Rust staging session，避免整文件
 * ArrayBuffer/base64/IPC 放大；全部文件完成后才提交到工作区。
 */

import { invoke } from '@tauri-apps/api/core';
import {
  reportRendererHealthSnapshot,
  setRendererHealthStage,
} from '@services/diagnostics/rendererHealth';

export const WORKSPACE_IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_IMPORT_PROGRESS_INTERVAL_MS = 100;
const BASE64_ENCODE_SLICE_BYTES = 0x8000;

export interface WorkspaceImportSourceItem {
  relativePath: string;
  file: File | null;
  isDirectory: boolean;
}

export interface WorkspaceImportTarget {
  hubName: string;
  agentName: string;
  rootDir: string | null;
  currentRelativePath: string;
}

export interface WorkspaceImportProgress {
  phase: 'uploading' | 'committing';
  doneEntries: number;
  totalEntries: number;
  doneFiles: number;
  totalFiles: number;
  bytesDone: number;
  totalBytes: number;
  currentPath: string;
}

export interface WorkspaceImportCommitResult {
  status: 'committed' | 'rolledBack' | 'partial';
  importedFiles: number;
  importedEntries: number;
  totalBytes: number;
  topLevelPaths: string[];
  errorMessage: string | null;
  rollbackErrors: string[];
  recoveryPath: string | null;
}

interface WorkspaceImportBeginResult {
  sessionId: string;
  totalBytes: number;
  totalFiles: number;
  totalEntries: number;
}

interface WorkspaceImportChunkResult {
  fileBytesReceived: number;
  bytesReceived: number;
  totalBytes: number;
}

export class WorkspaceImportCancelledError extends Error {
  constructor() {
    super('Workspace import cancelled');
    this.name = 'WorkspaceImportCancelledError';
  }
}

export type WorkspaceImportFailureStatus = 'rolledBack' | 'partial' | 'unknown';

export class WorkspaceImportCommitError extends Error {
  constructor(
    public readonly status: WorkspaceImportFailureStatus,
    message: string,
    public readonly result: WorkspaceImportCommitResult | null = null,
    public readonly originalError: unknown = null
  ) {
    super(message);
    this.name = 'WorkspaceImportCommitError';
  }
}

export function createWorkspaceImportProgressReporter(
  onProgress: (progress: WorkspaceImportProgress) => void,
  minIntervalMs = WORKSPACE_IMPORT_PROGRESS_INTERVAL_MS,
  now: () => number = () => performance.now()
): {
  report: (progress: WorkspaceImportProgress) => void;
  reportImmediately: (progress: WorkspaceImportProgress) => void;
  flush: () => void;
} {
  const intervalMs = Math.max(0, minIntervalMs);
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let pending: WorkspaceImportProgress | null = null;

  const emitPending = (emittedAt: number) => {
    if (!pending) return;
    const next = pending;
    pending = null;
    lastEmittedAt = emittedAt;
    onProgress(next);
  };

  const queueProgress = (progress: WorkspaceImportProgress, immediate: boolean) => {
    pending = progress;
    const currentTime = now();
    if (immediate || currentTime - lastEmittedAt >= intervalMs) {
      emitPending(currentTime);
    }
  };

  return {
    report(progress) {
      queueProgress(progress, false);
    },
    reportImmediately(progress) {
      queueProgress(progress, true);
    },
    flush() {
      emitPending(now());
    },
  };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_ENCODE_SLICE_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_ENCODE_SLICE_BYTES));
  }
  return btoa(binary);
}

export function getWorkspaceImportTotals(items: WorkspaceImportSourceItem[]): {
  totalEntries: number;
  totalFiles: number;
  totalBytes: number;
} {
  return items.reduce(
    (totals, item) => {
      if (item.file) {
        totals.totalFiles += 1;
        totals.totalBytes += item.file.size;
      }
      return totals;
    },
    { totalEntries: items.length, totalFiles: 0, totalBytes: 0 }
  );
}

export function getWorkspaceImportProgressPercent(progress: WorkspaceImportProgress): number {
  if (progress.phase === 'committing') return 100;
  if (progress.totalBytes > 0) {
    return Math.min(100, (progress.bytesDone / progress.totalBytes) * 100);
  }
  if (progress.totalEntries > 0) {
    return Math.min(100, (progress.doneEntries / progress.totalEntries) * 100);
  }
  return 0;
}

export async function importWorkspaceItems(
  items: WorkspaceImportSourceItem[],
  target: WorkspaceImportTarget,
  options: {
    onProgress: (progress: WorkspaceImportProgress) => void;
    shouldCancel: () => boolean;
  }
): Promise<WorkspaceImportCommitResult> {
  if (options.shouldCancel()) throw new WorkspaceImportCancelledError();

  const manifest = items.map((item) => ({
    relativePath: item.relativePath,
    isDirectory: item.isDirectory,
    size: item.file?.size ?? 0,
  }));
  const begin = await invoke<WorkspaceImportBeginResult>('workspace_import_begin', {
    hubName: target.hubName,
    agentName: target.agentName,
    rootDir: target.rootDir,
    currentRelativePath: target.currentRelativePath,
    entries: manifest,
  });
  let commitStarted = false;
  let clearStage: (() => void) | null = null;
  let doneEntries = 0;
  let doneFiles = 0;
  let bytesReceived = 0;
  const progressReporter = createWorkspaceImportProgressReporter(options.onProgress);

  try {
    progressReporter.reportImmediately({
      phase: 'uploading',
      doneEntries,
      totalEntries: begin.totalEntries,
      doneFiles,
      totalFiles: begin.totalFiles,
      bytesDone: 0,
      totalBytes: begin.totalBytes,
      currentPath: '',
    });

    for (const item of items) {
      if (options.shouldCancel()) throw new WorkspaceImportCancelledError();
      if (!item.file) {
        doneEntries += 1;
        progressReporter.reportImmediately({
          phase: 'uploading',
          doneEntries,
          totalEntries: begin.totalEntries,
          doneFiles,
          totalFiles: begin.totalFiles,
          bytesDone: bytesReceived,
          totalBytes: begin.totalBytes,
          currentPath: item.relativePath,
        });
        continue;
      }

      let offset = 0;
      while (offset < item.file.size) {
        if (options.shouldCancel()) throw new WorkspaceImportCancelledError();
        const chunkEnd = Math.min(offset + WORKSPACE_IMPORT_CHUNK_BYTES, item.file.size);
        clearStage?.();
        clearStage = setRendererHealthStage('workspace-import:chunk', {
          sessionId: begin.sessionId,
          relativePath: item.relativePath,
          offset,
          chunkBytes: chunkEnd - offset,
          totalBytes: begin.totalBytes,
        });
        reportRendererHealthSnapshot();

        const chunkBuffer = await item.file.slice(offset, chunkEnd).arrayBuffer();
        const base64Data = arrayBufferToBase64(chunkBuffer);
        const chunkResult = await invoke<WorkspaceImportChunkResult>(
          'workspace_import_append_chunk',
          {
            sessionId: begin.sessionId,
            relativePath: item.relativePath,
            offset,
            base64Data,
          }
        );
        offset = chunkResult.fileBytesReceived;
        bytesReceived = chunkResult.bytesReceived;
        progressReporter.report({
          phase: 'uploading',
          doneEntries,
          totalEntries: begin.totalEntries,
          doneFiles,
          totalFiles: begin.totalFiles,
          bytesDone: bytesReceived,
          totalBytes: chunkResult.totalBytes,
          currentPath: item.relativePath,
        });
      }

      doneFiles += 1;
      doneEntries += 1;
      progressReporter.reportImmediately({
        phase: 'uploading',
        doneEntries,
        totalEntries: begin.totalEntries,
        doneFiles,
        totalFiles: begin.totalFiles,
        bytesDone: bytesReceived,
        totalBytes: begin.totalBytes,
        currentPath: item.relativePath,
      });
    }

    progressReporter.flush();
    if (options.shouldCancel()) throw new WorkspaceImportCancelledError();
    progressReporter.reportImmediately({
      phase: 'committing',
      doneEntries,
      totalEntries: begin.totalEntries,
      doneFiles,
      totalFiles: begin.totalFiles,
      bytesDone: bytesReceived,
      totalBytes: begin.totalBytes,
      currentPath: '',
    });
    commitStarted = true;
    clearStage?.();
    clearStage = setRendererHealthStage('workspace-import:commit', {
      sessionId: begin.sessionId,
      files: begin.totalFiles,
      bytes: begin.totalBytes,
    });
    reportRendererHealthSnapshot();
    let result: WorkspaceImportCommitResult;
    try {
      result = await invoke<WorkspaceImportCommitResult>('workspace_import_commit', {
        sessionId: begin.sessionId,
      });
    } catch (error) {
      throw new WorkspaceImportCommitError(
        'unknown',
        'Workspace import commit response was interrupted',
        null,
        error
      );
    }
    if (result.status !== 'committed') {
      throw new WorkspaceImportCommitError(
        result.status,
        result.errorMessage ?? `Workspace import ${result.status}`,
        result
      );
    }
    return result;
  } finally {
    clearStage?.();
    clearStage = null;
    if (!commitStarted) {
      progressReporter.flush();
      const cancelReason = options.shouldCancel() ? 'requested' : 'rollback';
      const clearCancelStage = setRendererHealthStage('workspace-import:cancel', {
        sessionId: begin.sessionId,
        reason: cancelReason,
        doneEntries,
        totalEntries: begin.totalEntries,
        bytesReceived,
        totalBytes: begin.totalBytes,
      });
      reportRendererHealthSnapshot();
      try {
        await invoke('workspace_import_cancel', { sessionId: begin.sessionId });
      } catch {
        // 取消/回滚错误由原始导入错误主导；Rust 侧保留耗时和失败诊断。
      } finally {
        clearCancelStage();
      }
    }
  }
}
