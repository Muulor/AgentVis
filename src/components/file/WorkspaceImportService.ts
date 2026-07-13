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
export const WORKSPACE_IMPORT_COLLECTION_CONCURRENCY = 8;
export const WORKSPACE_IMPORT_COLLECTION_DRAIN_TIMEOUT_MS = 250;
export const WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE = 128;
const BASE64_ENCODE_SLICE_BYTES = 0x8000;
const BASE64_ENCODE_YIELD_BYTES = 512 * 1024;
const pendingFileSystemCallbacks = new Set<symbol>();

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

function throwIfWorkspaceImportCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkspaceImportCancelledError();
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * 注册一个与 AbortSignal 同生命周期的异步资源。
 *
 * 如果 signal 在 register() 完成前被取消，迟到的 disposer 会在返回后立即执行，
 * 避免异步 listener 在组件卸载或 Agent 切换后泄漏。
 */
export async function registerAbortableDisposable(
  signal: AbortSignal,
  register: () => Promise<() => void>
): Promise<() => void> {
  if (signal.aborted) return () => undefined;

  let disposer: (() => void) | null = null;
  let disposeRequested = false;
  let disposed = false;

  const disposeOnce = () => {
    disposeRequested = true;
    if (!disposer || disposed) return;
    disposed = true;
    disposer();
  };
  signal.addEventListener('abort', disposeOnce, { once: true });
  const shouldDisposeAfterRegistration = () => disposeRequested || signal.aborted;

  try {
    disposer = await register();
    if (shouldDisposeAfterRegistration()) {
      disposeOnce();
    }
  } catch (error) {
    signal.removeEventListener('abort', disposeOnce);
    throw error;
  }

  return () => {
    signal.removeEventListener('abort', disposeOnce);
    disposeOnce();
  };
}

/**
 * 创建一个在 AbortSignal 取消后不再产生副作用的回调。
 *
 * 适用于 disposer 可能迟到的异步 listener，以及已经进入任务队列、无法再可靠取消的回调。
 */
export function createAbortSignalGuardedCallback<Arguments extends unknown[]>(
  signal: AbortSignal,
  callback: (...args: Arguments) => void
): (...args: Arguments) => void {
  return (...args) => {
    if (signal.aborted) return;
    callback(...args);
  };
}

class WorkspaceImportCollectionCapacityError extends Error {
  constructor() {
    super('Workspace import file discovery has too many pending browser callbacks');
    this.name = 'WorkspaceImportCollectionCapacityError';
  }
}

function runBoundedFileSystemCallback<T>(
  start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void
): Promise<T> {
  if (pendingFileSystemCallbacks.size >= WORKSPACE_IMPORT_COLLECTION_CONCURRENCY) {
    return Promise.reject(new WorkspaceImportCollectionCapacityError());
  }

  const callbackToken = Symbol();
  pendingFileSystemCallbacks.add(callbackToken);
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      pendingFileSystemCallbacks.delete(callbackToken);
      return true;
    };
    const resolveOnce = (value: T) => {
      if (release()) resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (!release()) return;
      reject(
        error instanceof Error ? error : new Error('Workspace import browser callback failed')
      );
    };

    try {
      start(resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return runBoundedFileSystemCallback((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return runBoundedFileSystemCallback((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
  signal: AbortSignal
): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];

  do {
    throwIfWorkspaceImportCancelled(signal);
    batch = await readDirectoryBatch(reader);
    throwIfWorkspaceImportCancelled(signal);
    entries.push(...batch);
  } while (batch.length > 0);

  return entries;
}

interface WorkspaceEntryCollectionJob {
  entry: FileSystemEntry;
  parentPath: string;
}

interface WorkspaceEntryCollectionResult {
  item: WorkspaceImportSourceItem | null;
  children: WorkspaceEntryCollectionJob[];
}

interface WorkspaceEntryBatchCompleted {
  kind: 'completed';
  settled: PromiseSettledResult<WorkspaceEntryCollectionResult>[];
}

interface WorkspaceEntryBatchTerminated {
  kind: 'terminated';
  error: unknown;
}

type WorkspaceEntryBatchOutcome = WorkspaceEntryBatchCompleted | WorkspaceEntryBatchTerminated;

async function collectWorkspaceEntryJob(
  job: WorkspaceEntryCollectionJob,
  signal: AbortSignal
): Promise<WorkspaceEntryCollectionResult> {
  throwIfWorkspaceImportCancelled(signal);
  const { entry, parentPath } = job;
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntry);
    throwIfWorkspaceImportCancelled(signal);
    return {
      item: { relativePath, file, isDirectory: false },
      children: [],
    };
  }

  if (entry.isDirectory) {
    const directory = entry as FileSystemDirectoryEntry;
    const childEntries = await readAllDirectoryEntries(directory.createReader(), signal);
    return {
      item: { relativePath, file: null, isDirectory: true },
      children: childEntries.map((childEntry) => ({ entry: childEntry, parentPath: relativePath })),
    };
  }

  return { item: null, children: [] };
}

async function waitForWorkspaceEntryBatchDrain(
  settledPromise: Promise<PromiseSettledResult<WorkspaceEntryCollectionResult>[]>,
  timeoutMs: number
): Promise<void> {
  if (timeoutMs <= 0) return;

  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = globalThis.setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([settledPromise.then(() => undefined), timeoutPromise]);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

/**
 * 启动一个有界批次并观察首个错误/取消。终止后先给已启动任务一个有限的收敛窗口；
 * 未及时返回的原生 FileSystem 回调仍由 allSettled 接管，但内部 signal 会阻止它继续遍历目录。
 */
async function collectWorkspaceEntryBatch(
  batch: WorkspaceEntryCollectionJob[],
  signal: AbortSignal,
  drainTimeoutMs: number
): Promise<PromiseSettledResult<WorkspaceEntryCollectionResult>[]> {
  const batchController = new AbortController();
  let terminalOutcome: WorkspaceEntryBatchTerminated | null = null;
  let resolveTerminal!: (outcome: WorkspaceEntryBatchTerminated) => void;
  const terminalPromise = new Promise<WorkspaceEntryBatchTerminated>((resolve) => {
    resolveTerminal = resolve;
  });
  const terminate = (error: unknown) => {
    if (terminalOutcome) return;
    terminalOutcome = { kind: 'terminated', error };
    batchController.abort();
    resolveTerminal(terminalOutcome);
  };
  const handleAbort = () => terminate(new WorkspaceImportCancelledError());

  signal.addEventListener('abort', handleAbort, { once: true });
  if (signal.aborted) handleAbort();

  const tasks = batch.map((job) => {
    const task = collectWorkspaceEntryJob(job, batchController.signal);
    void task.catch((error: unknown) => {
      terminate(signal.aborted ? new WorkspaceImportCancelledError() : error);
    });
    return task;
  });
  const settledPromise = Promise.allSettled(tasks);

  try {
    const outcome = await Promise.race<WorkspaceEntryBatchOutcome>([
      settledPromise.then((settled) => ({ kind: 'completed', settled })),
      terminalPromise,
    ]);

    if (outcome.kind === 'terminated') {
      await waitForWorkspaceEntryBatchDrain(settledPromise, drainTimeoutMs);
      throw outcome.error;
    }

    throwIfWorkspaceImportCancelled(signal);
    return outcome.settled;
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/**
 * 以全局有界批次遍历拖入目录。首个错误或取消会停止启动新任务，并中止当前批次继续派生读取；
 * 已启动的 FileSystem 回调只等待有限时间，避免异常回调永久阻塞本次导入。
 */
export async function collectFileSystemEntries(
  rootEntries: FileSystemEntry[],
  signal: AbortSignal,
  concurrency = WORKSPACE_IMPORT_COLLECTION_CONCURRENCY,
  drainTimeoutMs = WORKSPACE_IMPORT_COLLECTION_DRAIN_TIMEOUT_MS
): Promise<WorkspaceImportSourceItem[]> {
  const requestedBatchSize = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : WORKSPACE_IMPORT_COLLECTION_CONCURRENCY;
  const batchSize = Math.min(
    WORKSPACE_IMPORT_COLLECTION_CONCURRENCY,
    Math.max(1, requestedBatchSize)
  );
  const boundedDrainTimeoutMs = Number.isFinite(drainTimeoutMs)
    ? Math.min(WORKSPACE_IMPORT_COLLECTION_DRAIN_TIMEOUT_MS, Math.max(0, drainTimeoutMs))
    : WORKSPACE_IMPORT_COLLECTION_DRAIN_TIMEOUT_MS;
  const queue: WorkspaceEntryCollectionJob[] = rootEntries.map((entry) => ({
    entry,
    parentPath: '',
  }));
  const items: WorkspaceImportSourceItem[] = [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    throwIfWorkspaceImportCancelled(signal);
    const availableCallbackSlots =
      WORKSPACE_IMPORT_COLLECTION_CONCURRENCY - pendingFileSystemCallbacks.size;
    if (availableCallbackSlots <= 0) {
      throw new WorkspaceImportCollectionCapacityError();
    }
    const batch = queue.slice(queueIndex, queueIndex + Math.min(batchSize, availableCallbackSlots));
    queueIndex += batch.length;
    const settled = await collectWorkspaceEntryBatch(batch, signal, boundedDrainTimeoutMs);

    throwIfWorkspaceImportCancelled(signal);
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      if (result.value.item) items.push(result.value.item);
      queue.push(...result.value.children);
    }
  }

  return items;
}

export async function collectDroppedWorkspaceItems(
  dataTransfer: DataTransfer,
  signal: AbortSignal
): Promise<WorkspaceImportSourceItem[]> {
  throwIfWorkspaceImportCancelled(signal);
  const entryItems = Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entryItems.length > 0) {
    return collectFileSystemEntries(entryItems, signal);
  }

  throwIfWorkspaceImportCancelled(signal);
  return Array.from(dataTransfer.files).map((file) => ({
    relativePath: file.name,
    file,
    isDirectory: false,
  }));
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

export async function arrayBufferToBase64(
  buffer: ArrayBuffer,
  signal: AbortSignal
): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const binarySlices: string[] = [];
  let bytesSinceYield = 0;
  for (let index = 0; index < bytes.length; index += BASE64_ENCODE_SLICE_BYTES) {
    throwIfWorkspaceImportCancelled(signal);
    const binary = String.fromCharCode(...bytes.subarray(index, index + BASE64_ENCODE_SLICE_BYTES));
    binarySlices.push(binary);
    bytesSinceYield += binary.length;
    if (bytesSinceYield >= BASE64_ENCODE_YIELD_BYTES) {
      bytesSinceYield = 0;
      await yieldToMainThread();
    }
  }
  throwIfWorkspaceImportCancelled(signal);
  return btoa(binarySlices.join(''));
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
    signal: AbortSignal;
  }
): Promise<WorkspaceImportCommitResult> {
  throwIfWorkspaceImportCancelled(options.signal);

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
    throwIfWorkspaceImportCancelled(options.signal);
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

    let synchronousEntriesSinceYield = 0;
    for (const item of items) {
      throwIfWorkspaceImportCancelled(options.signal);
      const completedSynchronously = !item.file || item.file.size === 0;
      if (item.file) {
        let offset = 0;
        while (offset < item.file.size) {
          throwIfWorkspaceImportCancelled(options.signal);
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
          throwIfWorkspaceImportCancelled(options.signal);
          const base64Data = await arrayBufferToBase64(chunkBuffer, options.signal);
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
      }

      doneEntries += 1;
      const completedProgress: WorkspaceImportProgress = {
        phase: 'uploading',
        doneEntries,
        totalEntries: begin.totalEntries,
        doneFiles,
        totalFiles: begin.totalFiles,
        bytesDone: bytesReceived,
        totalBytes: begin.totalBytes,
        currentPath: item.relativePath,
      };
      if (completedSynchronously) {
        progressReporter.report(completedProgress);
        synchronousEntriesSinceYield += 1;
        if (synchronousEntriesSinceYield >= WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE) {
          progressReporter.flush();
          synchronousEntriesSinceYield = 0;
          await yieldToMainThread();
          throwIfWorkspaceImportCancelled(options.signal);
        }
      } else {
        progressReporter.reportImmediately(completedProgress);
        synchronousEntriesSinceYield = 0;
      }
    }

    progressReporter.flush();
    throwIfWorkspaceImportCancelled(options.signal);
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
      const cancelReason = options.signal.aborted ? 'requested' : 'rollback';
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
