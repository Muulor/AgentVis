import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Buffer } from 'node:buffer';
import {
  reportRendererHealthSnapshot,
  setRendererHealthStage,
} from '@services/diagnostics/rendererHealth';
import {
  WORKSPACE_IMPORT_CHUNK_BYTES,
  WORKSPACE_IMPORT_COLLECTION_CONCURRENCY,
  WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE,
  WorkspaceImportCancelledError,
  WorkspaceImportCommitError,
  collectFileSystemEntries,
  createAbortSignalGuardedCallback,
  createWorkspaceImportProgressReporter,
  getWorkspaceImportProgressPercent,
  getWorkspaceImportTotals,
  importWorkspaceItems,
  registerAbortableDisposable,
  type WorkspaceImportCommitResult,
  type WorkspaceImportProgress,
  type WorkspaceImportSourceItem,
} from '../WorkspaceImportService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@services/diagnostics/rendererHealth', () => ({
  reportRendererHealthSnapshot: vi.fn(),
  setRendererHealthStage: vi.fn(() => vi.fn()),
}));

const invokeMock = vi.mocked(invoke);
const reportRendererHealthSnapshotMock = vi.mocked(reportRendererHealthSnapshot);
const setRendererHealthStageMock = vi.mocked(setRendererHealthStage);

function fakeFile(bytes: Uint8Array): File {
  return {
    size: bytes.length,
    slice(start = 0, end = bytes.length) {
      const chunk = bytes.slice(start, end);
      return {
        arrayBuffer: async () => chunk.buffer,
      } as Blob;
    },
  } as File;
}

function source(relativePath: string, bytes: Uint8Array): WorkspaceImportSourceItem {
  return { relativePath, file: fakeFile(bytes), isDirectory: false };
}

function directorySource(relativePath: string): WorkspaceImportSourceItem {
  return { relativePath, file: null, isDirectory: true };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fileSystemFileEntry(
  name: string,
  readFile: () => Promise<File>,
  onRead: () => void = () => undefined
): FileSystemFileEntry {
  return {
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    isFile: true,
    isDirectory: false,
    file(successCallback: (file: File) => void, errorCallback?: ErrorCallback) {
      onRead();
      void readFile().then(successCallback, (error: unknown) => {
        errorCallback?.(error as DOMException);
      });
    },
    getParent: vi.fn(),
  } as unknown as FileSystemFileEntry;
}

function committedResult(
  importedFiles: number,
  importedEntries: number,
  totalBytes: number,
  topLevelPaths: string[]
): WorkspaceImportCommitResult {
  return {
    status: 'committed',
    importedFiles,
    importedEntries,
    totalBytes,
    topLevelPaths,
    errorMessage: null,
    rollbackErrors: [],
    recoveryPath: null,
  };
}

describe('WorkspaceImportService', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reportRendererHealthSnapshotMock.mockReset();
    setRendererHealthStageMock.mockReset();
    setRendererHealthStageMock.mockImplementation(() => vi.fn());
  });

  it('disposes a listener that finishes registering after its owner is unmounted', async () => {
    const controller = new AbortController();
    const registration = deferred<() => void>();
    const dispose = vi.fn();
    const registered = registerAbortableDisposable(controller.signal, () => registration.promise);

    controller.abort();
    registration.resolve(dispose);
    const cleanup = await registered;

    expect(dispose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps listener handlers and already queued effects inert after abort', () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const effect = vi.fn();
      const guardedEffect = createAbortSignalGuardedCallback(controller.signal, effect);
      const scheduleEffect = vi.fn(() => globalThis.setTimeout(guardedEffect, 0));
      const guardedHandler = createAbortSignalGuardedCallback(controller.signal, scheduleEffect);

      guardedHandler();
      expect(scheduleEffect).toHaveBeenCalledTimes(1);
      controller.abort();
      guardedHandler();
      vi.runAllTimers();

      expect(scheduleEffect).toHaveBeenCalledTimes(1);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for started sibling reads after cancellation and does not start the next batch', async () => {
    const controller = new AbortController();
    const firstRead = deferred<File>();
    const secondRead = deferred<File>();
    const thirdRead = deferred<File>();
    const onFirstRead = vi.fn();
    const onSecondRead = vi.fn();
    const onThirdRead = vi.fn();
    const collection = collectFileSystemEntries(
      [
        fileSystemFileEntry('first.txt', () => firstRead.promise, onFirstRead),
        fileSystemFileEntry('second.txt', () => secondRead.promise, onSecondRead),
        fileSystemFileEntry('third.txt', () => thirdRead.promise, onThirdRead),
      ],
      controller.signal,
      2
    );
    let collectionSettled = false;
    void collection.then(
      () => {
        collectionSettled = true;
      },
      () => {
        collectionSettled = true;
      }
    );

    expect(onFirstRead).toHaveBeenCalledTimes(1);
    expect(onSecondRead).toHaveBeenCalledTimes(1);
    expect(onThirdRead).not.toHaveBeenCalled();

    controller.abort();
    firstRead.resolve(fakeFile(new Uint8Array([1])));
    await Promise.resolve();
    expect(collectionSettled).toBe(false);
    expect(onThirdRead).not.toHaveBeenCalled();

    secondRead.resolve(fakeFile(new Uint8Array([2])));
    await expect(collection).rejects.toBeInstanceOf(WorkspaceImportCancelledError);
    expect(onThirdRead).not.toHaveBeenCalled();
  });

  it('returns a read error after a bounded drain when a started sibling never settles', async () => {
    const readError = new DOMException('read denied', 'NotReadableError');
    const hungRead = deferred<File>();
    const onThirdRead = vi.fn();
    const collection = collectFileSystemEntries(
      [
        fileSystemFileEntry('failed.txt', () => Promise.reject(readError)),
        fileSystemFileEntry('hung.txt', () => hungRead.promise),
        fileSystemFileEntry('third.txt', async () => fakeFile(new Uint8Array([3])), onThirdRead),
      ],
      activeSignal(),
      2,
      0
    );

    await expect(collection).rejects.toBe(readError);
    expect(onThirdRead).not.toHaveBeenCalled();

    hungRead.resolve(fakeFile(new Uint8Array([2])));
    await Promise.resolve();
    expect(onThirdRead).not.toHaveBeenCalled();
  });

  it('returns cancellation after a bounded drain when a started sibling never settles', async () => {
    const controller = new AbortController();
    const hungRead = deferred<File>();
    const onFirstRead = vi.fn();
    const onSecondRead = vi.fn();
    const onThirdRead = vi.fn();
    const collection = collectFileSystemEntries(
      [
        fileSystemFileEntry('first.txt', () => hungRead.promise, onFirstRead),
        fileSystemFileEntry('second.txt', () => hungRead.promise, onSecondRead),
        fileSystemFileEntry('third.txt', async () => fakeFile(new Uint8Array([3])), onThirdRead),
      ],
      controller.signal,
      2,
      0
    );

    expect(onFirstRead).toHaveBeenCalledTimes(1);
    expect(onSecondRead).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(collection).rejects.toBeInstanceOf(WorkspaceImportCancelledError);
    expect(onThirdRead).not.toHaveBeenCalled();

    hungRead.resolve(fakeFile(new Uint8Array([1])));
    await Promise.resolve();
    expect(onThirdRead).not.toHaveBeenCalled();
  });

  it('caps native callbacks that remain pending after a bounded drain', async () => {
    const controller = new AbortController();
    const hungRead = deferred<File>();
    const onRead = vi.fn();
    const pendingEntries = Array.from(
      { length: WORKSPACE_IMPORT_COLLECTION_CONCURRENCY },
      (_, index) => fileSystemFileEntry(`hung-${index}.txt`, () => hungRead.promise, onRead)
    );
    const collection = collectFileSystemEntries(
      pendingEntries,
      controller.signal,
      WORKSPACE_IMPORT_COLLECTION_CONCURRENCY,
      0
    );

    try {
      expect(onRead).toHaveBeenCalledTimes(WORKSPACE_IMPORT_COLLECTION_CONCURRENCY);
      controller.abort();
      await expect(collection).rejects.toBeInstanceOf(WorkspaceImportCancelledError);

      const nextRead = vi.fn();
      await expect(
        collectFileSystemEntries(
          [fileSystemFileEntry('next.txt', async () => fakeFile(new Uint8Array([1])), nextRead)],
          activeSignal(),
          1,
          0
        )
      ).rejects.toThrow('too many pending browser callbacks');
      expect(nextRead).not.toHaveBeenCalled();
    } finally {
      hungRead.resolve(fakeFile(new Uint8Array([1])));
      await Promise.resolve();
    }
  });

  it('coalesces chunk progress while preserving forced and flushed updates', () => {
    let now = 0;
    const updates: WorkspaceImportProgress[] = [];
    const reporter = createWorkspaceImportProgressReporter(
      (progress) => updates.push(progress),
      100,
      () => now
    );
    const progress = (bytesDone: number): WorkspaceImportProgress => ({
      phase: 'uploading',
      doneEntries: 0,
      totalEntries: 1,
      doneFiles: 0,
      totalFiles: 1,
      bytesDone,
      totalBytes: 400,
      currentPath: 'large.bin',
    });

    reporter.reportImmediately(progress(0));
    now = 10;
    reporter.report(progress(100));
    now = 50;
    reporter.report(progress(200));
    expect(updates.map((update) => update.bytesDone)).toEqual([0]);

    now = 100;
    reporter.report(progress(300));
    now = 110;
    reporter.report(progress(400));
    reporter.flush();
    reporter.flush();

    expect(updates.map((update) => update.bytesDone)).toEqual([0, 300, 400]);
  });

  it('uploads a large file in bounded chunks before committing', async () => {
    const bytes = new Uint8Array(WORKSPACE_IMPORT_CHUNK_BYTES + 17);
    bytes.forEach((_, index) => {
      bytes[index] = index % 251;
    });
    const btoaSpy = vi
      .spyOn(globalThis, 'btoa')
      .mockImplementation((binary) => Buffer.from(binary, 'latin1').toString('base64'));
    const received: Uint8Array[] = [];
    let receivedBytes = 0;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'workspace_import_begin') {
        return {
          sessionId: 'session-1',
          totalBytes: bytes.length,
          totalFiles: 1,
          totalEntries: 1,
        };
      }
      if (command === 'workspace_import_append_chunk') {
        const encoded = (args as { base64Data: string }).base64Data;
        const decoded = Buffer.from(encoded, 'base64');
        received.push(decoded);
        receivedBytes += decoded.length;
        return {
          fileBytesReceived: receivedBytes,
          bytesReceived: receivedBytes,
          totalBytes: bytes.length,
        };
      }
      if (command === 'workspace_import_commit') {
        return committedResult(1, 1, bytes.length, ['large.bin']);
      }
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await importWorkspaceItems(
      [source('large.bin', bytes)],
      { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
      { onProgress: () => undefined, signal: activeSignal() }
    ).finally(() => btoaSpy.mockRestore());

    expect(result.importedFiles).toBe(1);
    expect(received).toHaveLength(2);
    expect(received.every((chunk) => chunk.length <= WORKSPACE_IMPORT_CHUNK_BYTES)).toBe(true);
    const reconstructed = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of received) {
      reconstructed.set(chunk, offset);
      offset += chunk.length;
    }
    expect(Buffer.from(reconstructed).equals(bytes)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_cancel', expect.anything());
  }, 10_000);

  it('rolls back the session when a chunk fails', async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-2', totalBytes: 3, totalFiles: 1, totalEntries: 1 };
      }
      if (command === 'workspace_import_append_chunk') throw new Error('disk full');
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      importWorkspaceItems(
        [source('folder/file.txt', new Uint8Array([1, 2, 3]))],
        { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
        { onProgress: () => undefined, signal: activeSignal() }
      )
    ).rejects.toThrow('disk full');
    expect(invokeMock).toHaveBeenCalledWith('workspace_import_cancel', {
      sessionId: 'session-2',
    });
    expect(setRendererHealthStageMock).toHaveBeenCalledWith(
      'workspace-import:cancel',
      expect.objectContaining({ sessionId: 'session-2', reason: 'rollback' })
    );
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_commit', expect.anything());
  });

  it('cancels between chunks without committing partial content', async () => {
    const controller = new AbortController();
    const progressUpdates: WorkspaceImportProgress[] = [];
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return {
          sessionId: 'session-3',
          totalBytes: WORKSPACE_IMPORT_CHUNK_BYTES + 1,
          totalFiles: 1,
          totalEntries: 1,
        };
      }
      if (command === 'workspace_import_append_chunk') {
        controller.abort();
        return {
          fileBytesReceived: WORKSPACE_IMPORT_CHUNK_BYTES,
          bytesReceived: WORKSPACE_IMPORT_CHUNK_BYTES,
          totalBytes: WORKSPACE_IMPORT_CHUNK_BYTES + 1,
        };
      }
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      importWorkspaceItems(
        [source('large.bin', new Uint8Array(WORKSPACE_IMPORT_CHUNK_BYTES + 1))],
        { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
        {
          onProgress: (progress) => progressUpdates.push(progress),
          signal: controller.signal,
        }
      )
    ).rejects.toBeInstanceOf(WorkspaceImportCancelledError);
    expect(invokeMock).toHaveBeenCalledWith('workspace_import_cancel', {
      sessionId: 'session-3',
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'workspace_import_append_chunk')
    ).toHaveLength(1);
    expect(
      progressUpdates.filter((progress) => progress.phase === 'uploading').at(-1)?.bytesDone
    ).toBe(WORKSPACE_IMPORT_CHUNK_BYTES);
    expect(progressUpdates.some((progress) => progress.phase === 'committing')).toBe(false);
    expect(setRendererHealthStageMock).toHaveBeenCalledWith(
      'workspace-import:cancel',
      expect.objectContaining({ sessionId: 'session-3', reason: 'requested' })
    );
  });

  it('emits every file completion even inside the throttle window', async () => {
    const progressUpdates: WorkspaceImportProgress[] = [];
    let receivedBytes = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-files', totalBytes: 2, totalFiles: 2, totalEntries: 2 };
      }
      if (command === 'workspace_import_append_chunk') {
        receivedBytes += 1;
        return { fileBytesReceived: 1, bytesReceived: receivedBytes, totalBytes: 2 };
      }
      if (command === 'workspace_import_commit') {
        return committedResult(2, 2, 0, ['a.txt', 'b.txt']);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await importWorkspaceItems(
      [source('a.txt', new Uint8Array([1])), source('b.txt', new Uint8Array([2]))],
      { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
      { onProgress: (progress) => progressUpdates.push(progress), signal: activeSignal() }
    );

    const completedFiles = progressUpdates
      .filter((progress) => progress.phase === 'uploading')
      .map((progress) => progress.doneFiles);
    expect(completedFiles).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('yields and coalesces progress for large batches of empty entries', async () => {
    const controller = new AbortController();
    const entryCount = WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE * 3;
    const items = Array.from({ length: entryCount }, (_, index) =>
      index % 2 === 0
        ? directorySource(`folder-${index}`)
        : source(`empty-${index}.txt`, new Uint8Array())
    );
    const totalFiles = items.filter((item) => item.file !== null).length;
    const progressUpdates: WorkspaceImportProgress[] = [];
    let cancellationScheduled = false;

    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return {
          sessionId: 'session-empty-batch',
          totalBytes: 0,
          totalFiles,
          totalEntries: entryCount,
        };
      }
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      importWorkspaceItems(
        items,
        { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            progressUpdates.push(progress);
            if (
              !cancellationScheduled &&
              progress.phase === 'uploading' &&
              progress.doneEntries === WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE
            ) {
              cancellationScheduled = true;
              globalThis.setTimeout(() => controller.abort(), 0);
            }
          },
        }
      )
    ).rejects.toBeInstanceOf(WorkspaceImportCancelledError);

    const uploadingUpdates = progressUpdates.filter((progress) => progress.phase === 'uploading');
    expect(cancellationScheduled).toBe(true);
    expect(uploadingUpdates.length).toBeLessThan(entryCount);
    expect(Math.max(...uploadingUpdates.map((progress) => progress.doneEntries))).toBe(
      WORKSPACE_IMPORT_SYNC_ENTRY_BATCH_SIZE
    );
    expect(invokeMock).toHaveBeenCalledWith('workspace_import_cancel', {
      sessionId: 'session-empty-batch',
    });
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_commit', expect.anything());
  });

  it('counts an empty folder as one entry and advances zero-byte progress by entries', async () => {
    const item = directorySource('empty-folder');
    expect(getWorkspaceImportTotals([item])).toEqual({
      totalEntries: 1,
      totalFiles: 0,
      totalBytes: 0,
    });

    const progressUpdates: WorkspaceImportProgress[] = [];
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-4', totalBytes: 0, totalFiles: 0, totalEntries: 1 };
      }
      if (command === 'workspace_import_commit') {
        return committedResult(0, 1, 0, ['empty-folder']);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await importWorkspaceItems(
      [item],
      { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
      { onProgress: (progress) => progressUpdates.push(progress), signal: activeSignal() }
    );

    expect(result.importedEntries).toBe(1);
    expect(getWorkspaceImportProgressPercent(progressUpdates[0]!)).toBe(0);
    expect(
      progressUpdates.some(
        (progress) =>
          progress.phase === 'uploading' &&
          progress.doneEntries === 1 &&
          getWorkspaceImportProgressPercent(progress) === 100
      )
    ).toBe(true);
    expect(progressUpdates.at(-1)?.phase).toBe('committing');
  });

  it('does not cancel after the commit point of no return', async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-5', totalBytes: 0, totalFiles: 1, totalEntries: 1 };
      }
      if (command === 'workspace_import_commit') {
        return committedResult(1, 1, 0, ['empty.txt']);
      }
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    await importWorkspaceItems(
      [source('empty.txt', new Uint8Array())],
      { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
      {
        onProgress: (progress) => {
          if (progress.phase === 'committing') controller.abort();
        },
        signal: controller.signal,
      }
    );

    expect(invokeMock).toHaveBeenCalledWith('workspace_import_commit', {
      sessionId: 'session-5',
    });
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_cancel', expect.anything());
  });

  it('still cancels after upload completion when commit has not started', async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-6', totalBytes: 0, totalFiles: 1, totalEntries: 1 };
      }
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      importWorkspaceItems(
        [source('empty.txt', new Uint8Array())],
        { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
        {
          onProgress: (progress) => {
            if (progress.phase === 'uploading' && progress.doneEntries === 1) {
              controller.abort();
            }
          },
          signal: controller.signal,
        }
      )
    ).rejects.toBeInstanceOf(WorkspaceImportCancelledError);
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_commit', expect.anything());
    expect(invokeMock).toHaveBeenCalledWith('workspace_import_cancel', {
      sessionId: 'session-6',
    });
  });

  it.each([
    ['rolledBack', null],
    ['partial', 'recovery/session-7'],
  ] as const)(
    'classifies a %s commit result without cancelling recovery state',
    async (status, recoveryPath) => {
      invokeMock.mockImplementation(async (command) => {
        if (command === 'workspace_import_begin') {
          return { sessionId: 'session-7', totalBytes: 0, totalFiles: 1, totalEntries: 1 };
        }
        if (command === 'workspace_import_commit') {
          return {
            ...committedResult(0, 0, 0, []),
            status,
            errorMessage: 'injected commit failure',
            rollbackErrors: status === 'partial' ? ['injected rollback failure'] : [],
            recoveryPath,
          } satisfies WorkspaceImportCommitResult;
        }
        if (command === 'workspace_import_cancel') return { cancelled: true };
        throw new Error(`Unexpected command: ${command}`);
      });

      const error = await importWorkspaceItems(
        [source('empty.txt', new Uint8Array())],
        { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
        { onProgress: () => undefined, signal: activeSignal() }
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WorkspaceImportCommitError);
      expect((error as WorkspaceImportCommitError).status).toBe(status);
      expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_cancel', expect.anything());
    }
  );

  it('classifies an interrupted commit response as unknown without cancelling', async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === 'workspace_import_begin') {
        return { sessionId: 'session-8', totalBytes: 0, totalFiles: 1, totalEntries: 1 };
      }
      if (command === 'workspace_import_commit') throw new Error('IPC disconnected');
      if (command === 'workspace_import_cancel') return { cancelled: true };
      throw new Error(`Unexpected command: ${command}`);
    });

    const error = await importWorkspaceItems(
      [source('empty.txt', new Uint8Array())],
      { hubName: 'hub', agentName: 'agent', rootDir: null, currentRelativePath: '' },
      { onProgress: () => undefined, signal: activeSignal() }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceImportCommitError);
    expect((error as WorkspaceImportCommitError).status).toBe('unknown');
    expect(invokeMock).not.toHaveBeenCalledWith('workspace_import_cancel', expect.anything());
  });
});
