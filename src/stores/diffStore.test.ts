/**
 * diffStore lifecycle regression tests.
 *
 * Covers workspace deletion synchronization and snapshot rollback consistency,
 * including multi-file handoff, path matching, persistence cleanup, and stale async work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BatchApplyResult,
  DocumentSnapshot,
  ModificationApplyResult,
} from '../services/fast-apply/types';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

const fastApply = vi.hoisted(() => {
  const createSnapshot = vi.fn();
  return {
    createSnapshot,
    engine: {
      preview: vi.fn(),
      listSnapshots: vi.fn().mockResolvedValue([]),
      rollback: vi.fn(),
      getSnapshotManager: vi.fn(() => ({ createSnapshot })),
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
}));

vi.mock('@services/logger', () => ({
  getLogger: () => ({
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../services/fast-apply', () => ({
  fastApplyEngine: fastApply.engine,
}));

import {
  useDiffStore,
  type ContextDiffState,
  type FileDiffEntry,
  type HistoryEntry,
} from './diffStore';
import { FullFileDiffBuilder } from '../services/fast-apply/FullFileDiffBuilder';
import { generateWholeFileReplaceXml } from '../services/fast-apply/DiffToXmlConverter';

function createPendingModification(
  modificationId: string,
  documentId: string,
  originalContent = 'before',
  newContent = 'after'
): ModificationApplyResult {
  return {
    modificationId,
    modification: {
      file: documentId,
      operation: 'REPLACE',
      search: originalContent,
      replace: newContent,
    },
    matchResult: {
      success: true,
      matchLevel: 'exact',
      confidence: 1,
      startLine: 1,
      endLine: 1,
      matchedContent: originalContent,
    },
    diff: {
      oldContent: originalContent,
      newContent,
      hasChanges: true,
      hunks: [],
    },
    status: 'pending',
  };
}

function getFileName(documentId: string): string {
  return documentId.split(/[/\\]/).pop() ?? documentId;
}

function createFileEntry(
  documentId: string,
  modification = createPendingModification(`mod:${documentId}`, documentId),
  options: {
    snapshots?: DocumentSnapshot[];
    undoStack?: HistoryEntry[];
    activeSnapshotId?: string | null;
  } = {}
): FileDiffEntry {
  return {
    documentId,
    fileName: getFileName(documentId),
    content: modification.diff.newContent,
    originalContent: modification.diff.oldContent,
    pendingModifications: [modification],
    originalXml: `<modifications file="${documentId}" />`,
    preAppliedContent: modification.diff.newContent,
    snapshots: options.snapshots ?? [],
    undoStack: options.undoStack ?? [],
    redoStack: [],
    activeSnapshotId: options.activeSnapshotId ?? options.snapshots?.[0]?.id ?? null,
  };
}

function createContextState(
  activeEntry: FileDiffEntry,
  entries: FileDiffEntry[],
  mode: ContextDiffState['mode'] = 'normal'
): ContextDiffState {
  return {
    mode,
    documentId: activeEntry.documentId,
    content: activeEntry.content,
    originalContent: activeEntry.originalContent,
    fileName: activeEntry.fileName,
    pendingModifications: activeEntry.pendingModifications,
    originalXml: activeEntry.originalXml,
    snapshots: activeEntry.snapshots,
    undoStack: activeEntry.undoStack,
    redoStack: activeEntry.redoStack,
    isLoading: false,
    error: null,
    preAppliedContent: activeEntry.preAppliedContent,
    fileEntries: new Map(entries.map((entry) => [entry.documentId, entry])),
    activeFileId: activeEntry.documentId,
    activeSnapshotId: activeEntry.activeSnapshotId,
  };
}

function seedContext(contextId: string, context: ContextDiffState): void {
  useDiffStore.setState({
    currentContextId: contextId,
    diffByContext: new Map([[contextId, context]]),
    isSnapshotPanelOpen: false,
  });
}

function createDeferred<T>(): {
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

describe('diffStore deleted-file lifecycle', () => {
  beforeEach(() => {
    useDiffStore.getState().reset();
    tauri.invoke.mockReset();
    fastApply.engine.preview.mockReset();
    fastApply.engine.listSnapshots.mockReset().mockResolvedValue([]);
    fastApply.engine.rollback.mockReset();
    fastApply.createSnapshot.mockReset();
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [];
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cannot re-enter Diff mode after the only pending file is deleted from Normal mode', async () => {
    const contextId = 'agent-single-file';
    const deletedPath = String.raw`D:\projects\demo\src\App.tsx`;
    const deletedEntry = createFileEntry(deletedPath);
    seedContext(contextId, createContextState(deletedEntry, [deletedEntry]));

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);

    const stateAfterDelete = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterDelete.mode).toBe('normal');
    expect(stateAfterDelete.documentId).toBeNull();
    expect(stateAfterDelete.activeFileId).toBeNull();
    expect(stateAfterDelete.pendingModifications).toEqual([]);
    expect(stateAfterDelete.fileEntries.has(deletedPath)).toBe(false);
    expect(useDiffStore.getState().getFileList(contextId)).toEqual([]);

    useDiffStore.getState().setMode(contextId, 'diff');

    expect(useDiffStore.getState().getDiffState(contextId).mode).toBe('normal');
  });

  it('hands off an active deleted file to the remaining pending file without leaving Normal mode', async () => {
    const contextId = 'agent-multi-file';
    const deletedPath = String.raw`D:\projects\demo\src\deleted.ts`;
    const remainingPath = String.raw`D:\projects\demo\src\remaining.ts`;
    const deletedEntry = createFileEntry(deletedPath);
    const remainingSnapshot: DocumentSnapshot = {
      id: 'remaining-snapshot',
      documentId: remainingPath,
      content: 'remaining after',
      timestamp: new Date('2026-07-15T00:00:00.000Z'),
      description: 'Remaining version',
    };
    const remainingUndo: HistoryEntry = {
      type: 'accept',
      contentBefore: 'remaining before',
      contentAfter: 'remaining after',
      description: 'Keep remaining history',
      timestamp: 1,
    };
    const remainingModification = createPendingModification(
      'remaining-modification',
      remainingPath,
      'remaining before',
      'remaining after'
    );
    const remainingEntry = createFileEntry(remainingPath, remainingModification, {
      snapshots: [remainingSnapshot],
      undoStack: [remainingUndo],
    });
    seedContext(
      contextId,
      createContextState(deletedEntry, [deletedEntry, remainingEntry], 'normal')
    );

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);

    const stateAfterDelete = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterDelete).toMatchObject({
      mode: 'normal',
      documentId: remainingPath,
      activeFileId: remainingPath,
      fileName: 'remaining.ts',
      content: 'remaining after',
      originalContent: 'remaining before',
    });
    expect(stateAfterDelete.pendingModifications).toEqual([remainingModification]);
    expect(stateAfterDelete.snapshots).toEqual([remainingSnapshot]);
    expect(stateAfterDelete.undoStack).toEqual([remainingUndo]);
    expect([...stateAfterDelete.fileEntries.keys()]).toEqual([remainingPath]);

    useDiffStore.getState().setMode(contextId, 'diff');

    const stateAfterReopen = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterReopen.mode).toBe('diff');
    expect(stateAfterReopen.documentId).toBe(remainingPath);
  });

  it('matches Windows directory descendants case-insensitively across slash styles without crossing a path boundary', async () => {
    const contextId = 'agent-directory-delete';
    const deletedDirectory = 'c:/WORK/demo/src/';
    const nestedPath = String.raw`C:\Work\Demo\Src\components\Panel.tsx`;
    const directChildPath = 'c:/work/demo/SRC/index.ts';
    const prefixSiblingPath = String.raw`C:\Work\Demo\src-old\keep.ts`;
    const nestedEntry = createFileEntry(nestedPath);
    const directChildEntry = createFileEntry(directChildPath);
    const prefixSiblingEntry = createFileEntry(prefixSiblingPath);
    seedContext(
      contextId,
      createContextState(nestedEntry, [nestedEntry, directChildEntry, prefixSiblingEntry])
    );

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedDirectory, true);

    const stateAfterDelete = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterDelete.fileEntries.has(nestedPath)).toBe(false);
    expect(stateAfterDelete.fileEntries.has(directChildPath)).toBe(false);
    expect(stateAfterDelete.fileEntries.has(prefixSiblingPath)).toBe(true);
    expect(stateAfterDelete.documentId).toBe(prefixSiblingPath);
    expect(stateAfterDelete.activeFileId).toBe(prefixSiblingPath);
  });

  it('matches lexically equivalent paths that contain dot segments', async () => {
    const contextId = 'agent-dot-segments';
    const diffPath = String.raw`D:\projects\demo\src\..\App.tsx`;
    const deletedPath = String.raw`D:\projects\demo\App.tsx`;
    const deletedEntry = createFileEntry(diffPath);
    seedContext(contextId, createContextState(deletedEntry, [deletedEntry]));

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);

    const stateAfterDelete = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterDelete.documentId).toBeNull();
    expect(stateAfterDelete.fileEntries.size).toBe(0);
  });

  it('marks only matching pending records as reverted', async () => {
    const contextId = 'agent-persistence-filter';
    const deletedPath = String.raw`D:\projects\demo\deleted.ts`;
    const keptPath = String.raw`D:\projects\demo\kept.ts`;
    const deletedEntry = createFileEntry(deletedPath);
    seedContext(contextId, createContextState(deletedEntry, [deletedEntry]));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        return [
          { id: 'deleted-record-1', documentId: deletedPath, createdAt: 900 },
          { id: 'kept-record', documentId: keptPath, createdAt: 900 },
          { id: 'deleted-record-2', documentId: deletedPath, createdAt: 999 },
          { id: 'same-millisecond-record', documentId: deletedPath, createdAt: 1_000 },
          { id: 'recreated-record', documentId: deletedPath, createdAt: 1_001 },
        ];
      }
      return undefined;
    });

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);

    expect(tauri.invoke).toHaveBeenCalledWith('diff_record_get_pending', { contextId });
    const statusUpdates = tauri.invoke.mock.calls.filter(
      ([command]) => command === 'diff_record_update_status'
    );
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates).toEqual(
      expect.arrayContaining([
        ['diff_record_update_status', { id: 'deleted-record-1', status: 'reverted' }],
        ['diff_record_update_status', { id: 'deleted-record-2', status: 'reverted' }],
      ])
    );
    expect(statusUpdates).not.toContainEqual([
      'diff_record_update_status',
      { id: 'kept-record', status: 'reverted' },
    ]);
    expect(statusUpdates).not.toContainEqual([
      'diff_record_update_status',
      { id: 'recreated-record', status: 'reverted' },
    ]);
    expect(statusUpdates).not.toContainEqual([
      'diff_record_update_status',
      { id: 'same-millisecond-record', status: 'reverted' },
    ]);
  });

  it('clears in-memory Diff state immediately even when persistence cleanup fails', async () => {
    const contextId = 'agent-persistence-failure';
    const deletedPath = String.raw`D:\projects\demo\failure.ts`;
    const deletedEntry = createFileEntry(deletedPath);
    seedContext(contextId, createContextState(deletedEntry, [deletedEntry]));
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        return [{ id: 'failing-record', documentId: deletedPath }];
      }
      if (command === 'diff_record_update_status') {
        throw new Error('database unavailable');
      }
      return undefined;
    });

    const discardPromise = useDiffStore
      .getState()
      .discardDiffsForDeletedPath(contextId, deletedPath, false);

    const stateBeforePersistenceSettles = useDiffStore.getState().getDiffState(contextId);
    expect(stateBeforePersistenceSettles.documentId).toBeNull();
    expect(stateBeforePersistenceSettles.activeFileId).toBeNull();
    expect(stateBeforePersistenceSettles.pendingModifications).toEqual([]);
    expect(stateBeforePersistenceSettles.fileEntries.size).toBe(0);
    await expect(discardPromise).resolves.toBeUndefined();
  });

  it('does not resurrect a deleted file when an older preview finishes late', async () => {
    const contextId = 'agent-stale-preview';
    const deletedPath = String.raw`D:\projects\demo\stale.ts`;
    const deletedEntry = createFileEntry(deletedPath);
    seedContext(contextId, createContextState(deletedEntry, [deletedEntry]));
    const previewDeferred = createDeferred<BatchApplyResult>();
    fastApply.engine.preview.mockImplementation(() => previewDeferred.promise);
    const refreshedModification = createPendingModification(
      'late-modification',
      deletedPath,
      'before',
      'late after'
    );

    const loadPromise = useDiffStore
      .getState()
      .loadModifications(
        contextId,
        deletedPath,
        'before',
        '<modifications />',
        'late-message',
        'stale.ts',
        false,
        undefined,
        'late after'
      );
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));

    const discardPromise = useDiffStore
      .getState()
      .discardDiffsForDeletedPath(contextId, deletedPath, false);
    previewDeferred.resolve({
      documentId: deletedPath,
      results: [refreshedModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });

    await Promise.all([loadPromise, discardPromise]);

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.mode).toBe('normal');
    expect(finalState.documentId).toBeNull();
    expect(finalState.activeFileId).toBeNull();
    expect(finalState.pendingModifications).toEqual([]);
    expect(finalState.fileEntries.has(deletedPath)).toBe(false);
  });

  it('clears loading when the deleted in-flight file has not entered fileEntries yet', async () => {
    const contextId = 'agent-uncommitted-preview';
    const activePath = String.raw`D:\projects\demo\active.ts`;
    const deletedPath = String.raw`D:\projects\demo\not-committed.ts`;
    const activeEntry = createFileEntry(activePath);
    seedContext(contextId, createContextState(activeEntry, [activeEntry]));
    const previewDeferred = createDeferred<BatchApplyResult>();
    fastApply.engine.preview.mockImplementation(() => previewDeferred.promise);
    const lateModification = createPendingModification(
      'not-committed-modification',
      deletedPath,
      'before',
      'after'
    );

    const loadPromise = useDiffStore
      .getState()
      .loadModifications(
        contextId,
        deletedPath,
        'before',
        '<modifications />',
        'not-committed-message',
        'not-committed.ts',
        false,
        undefined,
        'after'
      );
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);

    const stateAfterDelete = useDiffStore.getState().getDiffState(contextId);
    expect(stateAfterDelete.isLoading).toBe(false);
    expect(stateAfterDelete.documentId).toBe(activePath);
    previewDeferred.resolve({
      documentId: deletedPath,
      results: [lateModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    await loadPromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.isLoading).toBe(false);
    expect(finalState.documentId).toBe(activePath);
    expect(finalState.fileEntries.has(deletedPath)).toBe(false);
  });

  it('drops a Diff callback that starts only after its file was deleted', async () => {
    const contextId = 'agent-callback-after-delete';
    const activePath = String.raw`D:\projects\demo\active.ts`;
    const deletedPath = String.raw`D:\projects\demo\deleted-before-callback.ts`;
    const activeEntry = createFileEntry(activePath);
    seedContext(contextId, createContextState(activeEntry, [activeEntry]));

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'file_read_content') throw new Error('file not found');
      if (command === 'diff_record_get_pending') return [];
      return undefined;
    });

    await useDiffStore
      .getState()
      .loadModifications(
        contextId,
        deletedPath,
        'before',
        '<modifications />',
        'post-delete-message',
        'deleted-before-callback.ts',
        false,
        undefined,
        'after'
      );

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(fastApply.engine.preview).not.toHaveBeenCalled();
    expect(finalState.isLoading).toBe(false);
    expect(finalState.documentId).toBe(activePath);
    expect(finalState.fileEntries.has(deletedPath)).toBe(false);
  });

  it('does not restore a pending record held in memory when deletion wins during file I/O', async () => {
    const contextId = 'agent-restore-before-preview';
    const deletedPath = String.raw`D:\projects\demo\restore-deleted.ts`;
    const currentContentDeferred = createDeferred<string>();
    let pendingReadCount = 0;
    let fileReadCount = 0;
    const persistedRecord = {
      id: 'persisted-before-preview',
      contextId,
      messageId: 'persisted-message',
      documentId: deletedPath,
      originalContent: 'before',
      modifiedContent: 'after',
      xmlModification: '<modifications />',
      status: 'pending',
      activeSnapshotId: null,
      modificationStatuses: null,
      createdAt: 1,
      updatedAt: 1,
    };
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        pendingReadCount++;
        return pendingReadCount === 1 ? [persistedRecord] : [];
      }
      if (command === 'file_read_content') {
        fileReadCount++;
        if (fileReadCount === 2) return currentContentDeferred.promise;
        return 'after';
      }
      return undefined;
    });

    const restorePromise = useDiffStore.getState().loadPersistedDiffs(contextId);
    await vi.waitFor(() => expect(fileReadCount).toBe(2));
    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);
    currentContentDeferred.resolve('after');
    await restorePromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(fastApply.engine.preview).not.toHaveBeenCalled();
    expect(finalState.mode).toBe('normal');
    expect(finalState.documentId).toBeNull();
    expect(finalState.fileEntries.size).toBe(0);
  });

  it('guards active-snapshot post-processing after a restored file is deleted', async () => {
    const contextId = 'agent-restore-snapshot-race';
    const deletedPath = String.raw`D:\projects\demo\restore-snapshot.ts`;
    const snapshotListDeferred = createDeferred<DocumentSnapshot[]>();
    const restoredModification = createPendingModification(
      'restored-modification',
      deletedPath,
      'before',
      'after'
    );
    const activeSnapshot: DocumentSnapshot = {
      id: 'active-snapshot',
      documentId: deletedPath,
      content: 'after',
      timestamp: new Date('2026-07-15T00:00:00.000Z'),
      description: 'Active snapshot',
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'base-snapshot',
      documentId: deletedPath,
      content: 'before',
      timestamp: new Date('2026-07-14T00:00:00.000Z'),
      description: 'Original file version',
    };
    let pendingReadCount = 0;
    let snapshotListCount = 0;
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        pendingReadCount++;
        return pendingReadCount === 1
          ? [
              {
                id: 'persisted-snapshot-record',
                contextId,
                messageId: 'persisted-snapshot-message',
                documentId: deletedPath,
                originalContent: 'before',
                modifiedContent: 'after',
                xmlModification: '<modifications />',
                status: 'pending',
                activeSnapshotId: activeSnapshot.id,
                modificationStatuses: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          : [];
      }
      if (command === 'file_read_content') return 'after';
      if (command === 'snapshot_get') {
        return {
          id: activeSnapshot.id,
          documentId: deletedPath,
          content: activeSnapshot.content,
          description: activeSnapshot.description,
          modificationStatusesJson: null,
          createdAt: 1,
        };
      }
      return undefined;
    });
    fastApply.engine.preview.mockResolvedValue({
      documentId: deletedPath,
      results: [restoredModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    fastApply.engine.listSnapshots.mockImplementation(() => {
      snapshotListCount++;
      return snapshotListCount === 1 ? Promise.resolve([]) : snapshotListDeferred.promise;
    });

    const restorePromise = useDiffStore.getState().loadPersistedDiffs(contextId);
    await vi.waitFor(() => expect(snapshotListCount).toBe(2));
    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, deletedPath, false);
    snapshotListDeferred.resolve([activeSnapshot, baseSnapshot]);
    await restorePromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.mode).toBe('normal');
    expect(finalState.documentId).toBeNull();
    expect(finalState.pendingModifications).toEqual([]);
    expect(finalState.fileEntries.size).toBe(0);
    expect(finalState.activeSnapshotId).toBeNull();
  });

  it('does not let superseded restore post-processing overwrite a newer Diff for the same path', async () => {
    const contextId = 'agent-live-supersedes-restore';
    const documentPath = String.raw`D:\projects\demo\same-path.ts`;
    const restoredPreviewDeferred = createDeferred<BatchApplyResult>();
    const restoredModification = createPendingModification(
      'restored-modification',
      documentPath,
      'restored before',
      'restored after'
    );
    const liveModification = createPendingModification(
      'live-modification',
      documentPath,
      'live before',
      'live after'
    );
    let pendingReadCount = 0;
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        pendingReadCount++;
        return pendingReadCount === 1
          ? [
              {
                id: 'superseded-restore-record',
                contextId,
                messageId: 'restored-message',
                documentId: documentPath,
                originalContent: 'restored before',
                modifiedContent: 'restored after',
                xmlModification: '<restored-modifications />',
                status: 'pending',
                activeSnapshotId: 'restored-active-snapshot',
                modificationStatuses: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          : [];
      }
      if (command === 'file_read_content') return 'restored after';
      if (command === 'diff_record_create') return { id: 'live-diff-record' };
      return undefined;
    });
    fastApply.engine.preview
      .mockImplementationOnce(() => restoredPreviewDeferred.promise)
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [liveModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      });

    const restorePromise = useDiffStore.getState().loadPersistedDiffs(contextId);
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));

    await useDiffStore
      .getState()
      .loadModifications(
        contextId,
        documentPath,
        'live before',
        '<live-modifications />',
        'live-message',
        'same-path.ts',
        false,
        undefined,
        'live after'
      );

    restoredPreviewDeferred.resolve({
      documentId: documentPath,
      results: [restoredModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    await restorePromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.pendingModifications).toEqual([liveModification]);
    expect(finalState.activeSnapshotId).toBeNull();
    expect(fastApply.engine.preview).toHaveBeenCalledTimes(2);
  });

  it('allows a genuinely recreated file whose disk content matches the new Diff', async () => {
    const contextId = 'agent-recreated-file';
    const recreatedPath = String.raw`D:\projects\demo\recreated.ts`;
    const recreatedModification = createPendingModification(
      'recreated-modification',
      recreatedPath,
      'before recreation',
      'after recreation'
    );

    await useDiffStore.getState().discardDiffsForDeletedPath(contextId, recreatedPath, false);
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'file_read_content') return 'after recreation';
      if (command === 'diff_record_get_pending') return [];
      if (command === 'diff_record_create') return { id: 'recreated-diff-record' };
      return undefined;
    });
    fastApply.engine.preview.mockResolvedValue({
      documentId: recreatedPath,
      results: [recreatedModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });

    await useDiffStore
      .getState()
      .loadModifications(
        contextId,
        recreatedPath,
        'before recreation',
        '<modifications />',
        'recreated-message',
        'recreated.ts',
        false,
        undefined,
        'after recreation'
      );

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.mode).toBe('diff');
    expect(finalState.documentId).toBe(recreatedPath);
    expect(finalState.pendingModifications).toEqual([recreatedModification]);
    expect(finalState.isLoading).toBe(false);
  });
});

describe('diffStore snapshot rollback lifecycle', () => {
  beforeEach(() => {
    useDiffStore.getState().reset();
    tauri.invoke.mockReset();
    fastApply.engine.preview.mockReset();
    fastApply.engine.listSnapshots.mockReset().mockResolvedValue([]);
    fastApply.engine.rollback.mockReset();
    fastApply.createSnapshot.mockReset();
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [];
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the rollback preview baseline aligned with the snapshots used to generate its XML', async () => {
    const contextId = 'agent-rollback-baseline';
    const documentPath = String.raw`D:\projects\demo\index.html`;
    const baseContent = ['<!doctype html>', '<header>', 'old value', '<footer>'].join('\n');
    const targetContent = ['<!doctype html>', '<header>', 'new value', '<footer>'].join('\n');
    const staleRoundBaseline = `${baseContent}\nstale tail from a later incremental round`;
    const latestRoundContent = `${staleRoundBaseline}\nlatest write`;
    const targetSnapshot: DocumentSnapshot = {
      id: 'target-snapshot',
      documentId: documentPath,
      content: targetContent,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      // This belongs to the historical XML, not the generated adjacent-snapshot block.
      modificationStatuses: { '0': 'applied' },
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'base-snapshot',
      documentId: documentPath,
      content: baseContent,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
      modificationStatuses: { '0': 'pending' },
    };
    const misorderedRetainedSnapshot: DocumentSnapshot = {
      id: 'misordered-retained-snapshot',
      documentId: documentPath,
      content: 'an older retained snapshot that is not the semantic baseline',
      timestamp: new Date('2026-07-15T00:00:00.000Z'),
      description: 'Post-write version',
    };
    const latestRoundModification = createPendingModification(
      'latest-round-modification',
      documentPath,
      staleRoundBaseline,
      latestRoundContent
    );
    const activeEntry = createFileEntry(documentPath, latestRoundModification, {
      snapshots: [targetSnapshot, baseSnapshot, misorderedRetainedSnapshot],
    });
    const rollbackModification = createPendingModification(
      'rollback-modification',
      documentPath,
      baseContent,
      targetContent
    );
    rollbackModification.matchResult.endLine = baseContent.split('\n').length;
    rollbackModification.matchResult.matchedContent = baseContent;
    rollbackModification.status = 'applied';
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    fastApply.engine.rollback.mockResolvedValue(targetContent);
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [rollbackModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });

    await useDiffStore.getState().rollback(contextId, targetSnapshot.id);

    const previewXml = fastApply.engine.preview.mock.calls[0]?.[2];
    expect(previewXml).toBe(generateWholeFileReplaceXml(baseContent, targetContent));
    expect(fastApply.engine.preview).toHaveBeenCalledWith(
      documentPath,
      baseContent,
      expect.any(String)
    );
    const rolledBackState = useDiffStore.getState().getDiffState(contextId);
    expect(rolledBackState.content).toBe(targetContent);
    expect(rolledBackState.originalContent).toBe(baseContent);
    expect(rolledBackState.preAppliedContent).toBe(targetContent);
    expect(rolledBackState.originalXml).toBe(previewXml);
    expect(rolledBackState.pendingModifications[0]?.status).toBe('pending');

    const renderedDiff = new FullFileDiffBuilder(
      rolledBackState.originalContent,
      rolledBackState.pendingModifications,
      rolledBackState.fileName
    ).build();
    expect(renderedDiff.lines.some((line) => line.content.includes('stale tail'))).toBe(false);
    expect(
      renderedDiff.lines.find((line) => line.type === 'remove' && line.content === 'old value')
        ?.oldLineNumber
    ).toBe(3);
    expect(
      renderedDiff.lines.find((line) => line.type === 'add' && line.content === 'new value')
        ?.newLineNumber
    ).toBe(3);
  });

  it('restores the exact source Diff for a historical post-write snapshot when its record exists', async () => {
    const contextId = 'agent-rollback-source-record';
    const documentPath = String.raw`D:\projects\demo\source-record.html`;
    const originalVersion = ['line 1', 'line 2', 'line 3'].join('\n');
    const previousVersion = ['line 1', 'inserted earlier', 'line 2', 'line 3'].join('\n');
    const targetVersion = ['line 1', 'inserted earlier', 'line 2 changed', 'line 3'].join('\n');
    const latestVersion = `${targetVersion}\nlatest round tail`;
    const sourceXml = '<modifications source="matched-history-record" />';
    const targetSnapshot: DocumentSnapshot = {
      id: 'source-target-snapshot',
      documentId: documentPath,
      content: targetVersion,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      // The old XML had two blocks, while the matched source preview below is one whole-file block.
      modificationStatuses: { '0': 'applied', '1': 'pending' },
    };
    const originalSnapshot: DocumentSnapshot = {
      id: 'source-original-snapshot',
      documentId: documentPath,
      content: originalVersion,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const latestModification = createPendingModification(
      'latest-source-round',
      documentPath,
      targetVersion,
      latestVersion
    );
    const activeEntry = createFileEntry(documentPath, latestModification, {
      snapshots: [targetSnapshot, originalSnapshot],
    });
    const sourceModification = createPendingModification(
      'matched-source-modification',
      documentPath,
      previousVersion,
      targetVersion
    );
    sourceModification.matchResult.endLine = previousVersion.split('\n').length;
    sourceModification.matchResult.matchedContent = previousVersion;
    sourceModification.status = 'applied';
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        return [
          {
            documentId: documentPath,
            originalContent: previousVersion,
            modifiedContent: targetVersion,
            xmlModification: sourceXml,
            modificationStatuses: JSON.stringify({ '0': 'pending' }),
          },
        ];
      }
      return undefined;
    });
    fastApply.engine.rollback.mockResolvedValue(targetVersion);
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [sourceModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });

    await useDiffStore.getState().rollback(contextId, targetSnapshot.id);

    expect(fastApply.engine.preview).toHaveBeenCalledWith(documentPath, previousVersion, sourceXml);
    const rolledBackState = useDiffStore.getState().getDiffState(contextId);
    expect(rolledBackState.originalContent).toBe(previousVersion);
    expect(rolledBackState.preAppliedContent).toBe(targetVersion);
    expect(rolledBackState.originalXml).toBe(sourceXml);
    expect(rolledBackState.pendingModifications[0]?.status).toBe('pending');
    expect(rolledBackState.fileEntries.get(documentPath)).toMatchObject({
      content: targetVersion,
      originalContent: previousVersion,
      preAppliedContent: targetVersion,
      originalXml: sourceXml,
    });

    const renderedDiff = new FullFileDiffBuilder(
      rolledBackState.originalContent,
      rolledBackState.pendingModifications,
      rolledBackState.fileName
    ).build();
    const renderedNewContent = renderedDiff.lines
      .filter((line) => line.type !== 'remove')
      .map((line) => line.content)
      .join('\n');
    expect(renderedNewContent).toBe(targetVersion);
    expect(
      renderedDiff.lines.find((line) => line.type === 'remove' && line.content === 'line 2')
        ?.oldLineNumber
    ).toBe(3);
    expect(
      renderedDiff.lines.find((line) => line.type === 'add' && line.content === 'line 2 changed')
        ?.newLineNumber
    ).toBe(3);
  });

  it('rehydrates an active snapshot with the matching source Diff basis after restart', async () => {
    const contextId = 'agent-rehydrate-source-record';
    const documentPath = String.raw`D:\projects\demo\rehydrated.html`;
    const originalVersion = ['original 1', 'original 2'].join('\n');
    const sourceBaseline = ['original 1', 'prior inserted line', 'original 2'].join('\n');
    const targetVersion = ['original 1', 'prior inserted line', 'target changed'].join('\n');
    const latestBaseline = `${targetVersion}\nlatest baseline tail`;
    const latestVersion = `${latestBaseline}\nlatest target tail`;
    const sourceXml = '<modifications source="rehydrated-history-record" />';
    const targetSnapshot: DocumentSnapshot = {
      id: 'rehydrated-target-snapshot',
      documentId: documentPath,
      content: targetVersion,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      modificationStatuses: { '0': 'pending' },
    };
    const originalSnapshot: DocumentSnapshot = {
      id: 'rehydrated-original-snapshot',
      documentId: documentPath,
      content: originalVersion,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const latestModification = createPendingModification(
      'latest-rehydrated-modification',
      documentPath,
      latestBaseline,
      latestVersion
    );
    const sourceModification = createPendingModification(
      'source-rehydrated-modification',
      documentPath,
      sourceBaseline,
      targetVersion
    );
    sourceModification.matchResult.endLine = sourceBaseline.split('\n').length;
    sourceModification.matchResult.matchedContent = sourceBaseline;
    const latestRecord = {
      id: 'latest-rehydrated-record',
      contextId,
      messageId: 'latest-message',
      documentId: documentPath,
      originalContent: latestBaseline,
      modifiedContent: latestVersion,
      xmlModification: '<latest-modifications />',
      status: 'pending',
      activeSnapshotId: targetSnapshot.id,
      modificationStatuses: JSON.stringify({ '0': 'pending' }),
      createdAt: 2,
      updatedAt: 2,
    };
    const sourceRecord = {
      ...latestRecord,
      id: 'source-rehydrated-record',
      messageId: 'source-message',
      originalContent: sourceBaseline,
      modifiedContent: targetVersion,
      xmlModification: sourceXml,
      createdAt: 1,
      updatedAt: 1,
    };
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [latestRecord, sourceRecord];
      if (command === 'file_read_content') return targetVersion;
      if (command === 'snapshot_get') {
        return {
          id: targetSnapshot.id,
          documentId: documentPath,
          content: targetVersion,
          description: targetSnapshot.description,
          modificationStatusesJson: JSON.stringify({ '0': 'pending' }),
          createdAt: targetSnapshot.timestamp.getTime(),
        };
      }
      return undefined;
    });
    fastApply.engine.listSnapshots.mockResolvedValue([targetSnapshot, originalSnapshot]);
    fastApply.engine.preview
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [latestModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      })
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [sourceModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      });

    await useDiffStore.getState().loadPersistedDiffs(contextId);

    expect(fastApply.engine.preview).toHaveBeenNthCalledWith(
      2,
      documentPath,
      sourceBaseline,
      sourceXml
    );
    const restoredState = useDiffStore.getState().getDiffState(contextId);
    expect(restoredState.content).toBe(targetVersion);
    expect(restoredState.originalContent).toBe(sourceBaseline);
    expect(restoredState.preAppliedContent).toBe(targetVersion);
    expect(restoredState.originalXml).toBe(sourceXml);
    expect(restoredState.pendingModifications).toEqual([sourceModification]);
    expect(restoredState.fileEntries.get(documentPath)?.originalContent).toBe(sourceBaseline);
  });

  it('closes an untrusted restored Diff when active-snapshot preview fails', async () => {
    const contextId = 'agent-rehydrate-preview-failure';
    const documentPath = String.raw`D:\projects\demo\rehydrate-preview-failure.ts`;
    const sourceBaseline = 'source baseline';
    const targetContent = 'historical target';
    const latestContent = 'latest content';
    const targetSnapshot: DocumentSnapshot = {
      id: 'rehydrate-preview-failure-target',
      documentId: documentPath,
      content: targetContent,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      modificationStatuses: { '0': 'pending' },
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'rehydrate-preview-failure-base',
      documentId: documentPath,
      content: sourceBaseline,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const latestRecord = {
      id: 'rehydrate-preview-failure-latest-record',
      contextId,
      messageId: 'latest-message',
      documentId: documentPath,
      originalContent: targetContent,
      modifiedContent: latestContent,
      xmlModification: '<latest-diff />',
      status: 'pending',
      activeSnapshotId: targetSnapshot.id,
      modificationStatuses: JSON.stringify({ '0': 'pending' }),
      createdAt: 2,
      updatedAt: 2,
    };
    const sourceRecord = {
      ...latestRecord,
      id: 'rehydrate-preview-failure-source-record',
      messageId: 'source-message',
      originalContent: sourceBaseline,
      modifiedContent: targetContent,
      xmlModification: '<source-diff />',
      createdAt: 1,
      updatedAt: 1,
    };
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [latestRecord, sourceRecord];
      if (command === 'file_read_content') return targetContent;
      if (command === 'snapshot_get') {
        return {
          id: targetSnapshot.id,
          documentId: documentPath,
          content: targetContent,
          description: targetSnapshot.description,
          modificationStatusesJson: JSON.stringify({ '0': 'pending' }),
          createdAt: targetSnapshot.timestamp.getTime(),
        };
      }
      return undefined;
    });
    fastApply.engine.listSnapshots.mockResolvedValue([targetSnapshot, baseSnapshot]);
    fastApply.engine.preview
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [
          createPendingModification(
            'rehydrate-preview-failure-latest',
            documentPath,
            targetContent,
            latestContent
          ),
        ],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      })
      .mockRejectedValueOnce(new Error('active snapshot preview failed'));

    await useDiffStore.getState().loadPersistedDiffs(contextId);

    const restoredState = useDiffStore.getState().getDiffState(contextId);
    expect(restoredState).toMatchObject({
      mode: 'normal',
      content: targetContent,
      originalContent: sourceBaseline,
      originalXml: '<source-diff />',
      activeSnapshotId: targetSnapshot.id,
    });
    expect(restoredState.pendingModifications).toEqual([]);
    expect(restoredState.fileEntries.get(documentPath)).toMatchObject({
      pendingModifications: [],
      originalContent: sourceBaseline,
      activeSnapshotId: targetSnapshot.id,
    });
  });

  it('restores the complete Diff projection through rollback undo and redo', async () => {
    const contextId = 'agent-rollback-undo-redo';
    const documentPath = String.raw`D:\projects\demo\undo-redo.html`;
    const sourceBaseline = ['line 1', 'line 2'].join('\n');
    const targetVersion = ['line 1', 'line 2 changed'].join('\n');
    const latestVersion = `${targetVersion}\nlatest tail`;
    const sourceXml = '<modifications source="undo-redo-history" />';
    const targetSnapshot: DocumentSnapshot = {
      id: 'undo-redo-target',
      documentId: documentPath,
      content: targetVersion,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      modificationStatuses: { '0': 'pending' },
    };
    const originalSnapshot: DocumentSnapshot = {
      id: 'undo-redo-original',
      documentId: documentPath,
      content: sourceBaseline,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const latestModification = createPendingModification(
      'undo-redo-latest-modification',
      documentPath,
      targetVersion,
      latestVersion
    );
    const sourceModification = createPendingModification(
      'undo-redo-source-modification',
      documentPath,
      sourceBaseline,
      targetVersion
    );
    const activeEntry = createFileEntry(documentPath, latestModification, {
      snapshots: [targetSnapshot, originalSnapshot],
      activeSnapshotId: 'undo-redo-latest-snapshot',
    });
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') {
        return [
          {
            documentId: documentPath,
            originalContent: sourceBaseline,
            modifiedContent: targetVersion,
            xmlModification: sourceXml,
            modificationStatuses: JSON.stringify({ '0': 'pending' }),
          },
        ];
      }
      return undefined;
    });
    fastApply.engine.rollback.mockResolvedValue(targetVersion);
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [sourceModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });

    await useDiffStore.getState().rollback(contextId, targetSnapshot.id);
    await useDiffStore.getState().undo(contextId);

    const undoneState = useDiffStore.getState().getDiffState(contextId);
    expect(undoneState).toMatchObject({
      content: latestVersion,
      originalContent: targetVersion,
      preAppliedContent: latestVersion,
      originalXml: activeEntry.originalXml,
      activeSnapshotId: 'undo-redo-latest-snapshot',
      mode: 'diff',
    });
    expect(undoneState.pendingModifications).toEqual([latestModification]);
    expect(undoneState.fileEntries.get(documentPath)?.originalContent).toBe(targetVersion);

    await useDiffStore.getState().redo(contextId);

    const redoneState = useDiffStore.getState().getDiffState(contextId);
    expect(redoneState).toMatchObject({
      content: targetVersion,
      originalContent: sourceBaseline,
      preAppliedContent: targetVersion,
      originalXml: sourceXml,
      activeSnapshotId: targetSnapshot.id,
      mode: 'diff',
    });
    expect(redoneState.pendingModifications).toEqual([sourceModification]);
    expect(redoneState.fileEntries.get(documentPath)?.originalXml).toBe(sourceXml);
    expect(tauri.invoke).toHaveBeenCalledWith('diff_record_update_active_snapshot', {
      contextId,
      documentId: documentPath,
      snapshotId: targetSnapshot.id,
    });
  });

  it('does not let a late rollback preview overwrite a newer Diff load', async () => {
    const contextId = 'agent-late-rollback';
    const documentPath = String.raw`D:\projects\demo\late-rollback.ts`;
    const baseContent = 'base';
    const targetContent = 'historical target';
    const liveBase = 'new live base';
    const liveTarget = 'new live target';
    const targetSnapshot: DocumentSnapshot = {
      id: 'late-rollback-target',
      documentId: documentPath,
      content: targetContent,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'late-rollback-base',
      documentId: documentPath,
      content: baseContent,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const initialModification = createPendingModification(
      'late-rollback-initial',
      documentPath,
      targetContent,
      `${targetContent} latest`
    );
    const rollbackModification = createPendingModification(
      'late-rollback-result',
      documentPath,
      baseContent,
      targetContent
    );
    const liveModification = createPendingModification(
      'late-rollback-live',
      documentPath,
      liveBase,
      liveTarget
    );
    const activeEntry = createFileEntry(documentPath, initialModification, {
      snapshots: [targetSnapshot, baseSnapshot],
    });
    const rollbackPreview = createDeferred<BatchApplyResult>();
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [];
      if (command === 'diff_record_create') return { id: 'late-rollback-live-record' };
      if (command === 'file_read_content') return liveTarget;
      return undefined;
    });
    fastApply.engine.rollback.mockResolvedValue(targetContent);
    fastApply.engine.preview
      .mockImplementationOnce(() => rollbackPreview.promise)
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [liveModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      });

    const rollbackPromise = useDiffStore.getState().rollback(contextId, targetSnapshot.id);
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));
    await useDiffStore
      .getState()
      .loadModifications(
        contextId,
        documentPath,
        liveBase,
        '<live-diff />',
        'late-rollback-live-message',
        'late-rollback.ts',
        false,
        undefined,
        liveTarget
      );
    rollbackPreview.resolve({
      documentId: documentPath,
      results: [rollbackModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    await rollbackPromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState).toMatchObject({
      content: liveTarget,
      originalContent: liveBase,
      originalXml: '<live-diff />',
      activeSnapshotId: null,
    });
    expect(finalState.pendingModifications).toEqual([liveModification]);
  });

  it('does not start a history rollback while the same file Diff is still loading', async () => {
    const contextId = 'agent-load-before-rollback';
    const documentPath = String.raw`D:\projects\demo\load-before-rollback.ts`;
    const historicalContent = 'historical target';
    const liveBase = 'live base';
    const liveTarget = 'live target';
    const targetSnapshot: DocumentSnapshot = {
      id: 'load-before-rollback-target',
      documentId: documentPath,
      content: historicalContent,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
    };
    const currentModification = createPendingModification(
      'load-before-rollback-current',
      documentPath,
      'current base',
      'current target'
    );
    const activeEntry = createFileEntry(documentPath, currentModification, {
      snapshots: [targetSnapshot],
      activeSnapshotId: 'current-active-snapshot',
    });
    const liveModification = createPendingModification(
      'load-before-rollback-live',
      documentPath,
      liveBase,
      liveTarget
    );
    const livePreview = createDeferred<BatchApplyResult>();
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    fastApply.engine.rollback.mockResolvedValue(historicalContent);
    fastApply.engine.preview.mockImplementationOnce(() => livePreview.promise);

    const loadPromise = useDiffStore
      .getState()
      .loadModifications(
        contextId,
        documentPath,
        liveBase,
        '<load-before-rollback-diff />',
        'load-before-rollback-message',
        'load-before-rollback.ts',
        true,
        liveTarget,
        liveTarget
      );
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));

    const stateBeforeRollback = useDiffStore.getState().getDiffState(contextId);
    const rollbackResult = await useDiffStore.getState().rollback(contextId, targetSnapshot.id);
    const stateWhileLoadPending = useDiffStore.getState().getDiffState(contextId);

    expect(rollbackResult).toBe(activeEntry.content);
    expect(fastApply.engine.rollback).not.toHaveBeenCalled();
    expect(fastApply.engine.preview).toHaveBeenCalledTimes(1);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'file_write_to_path')).toEqual(
      []
    );
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === 'diff_record_update_active_snapshot'
      )
    ).toEqual([]);
    expect(stateWhileLoadPending.content).toBe(stateBeforeRollback.content);
    expect(stateWhileLoadPending.activeSnapshotId).toBe(stateBeforeRollback.activeSnapshotId);
    expect(stateWhileLoadPending.undoStack).toBe(stateBeforeRollback.undoStack);

    livePreview.resolve({
      documentId: documentPath,
      results: [liveModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    await loadPromise;

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState).toMatchObject({
      content: liveTarget,
      originalContent: liveBase,
      originalXml: '<load-before-rollback-diff />',
      activeSnapshotId: null,
      isLoading: false,
    });
    expect(finalState.pendingModifications).toEqual([liveModification]);
  });

  it.each(['undo', 'redo'] as const)(
    'does not start %s while the same file Diff is still loading',
    async (operation) => {
      const contextId = `agent-load-before-${operation}`;
      const documentPath = String.raw`D:\projects\demo\load-before-${operation}.ts`;
      const currentModification = createPendingModification(
        `load-before-${operation}-current`,
        documentPath,
        'current base',
        'current target'
      );
      const historyEntry: HistoryEntry = {
        type: 'rollback',
        contentBefore: 'history before',
        contentAfter: 'history after',
        description: `${operation} history entry`,
        timestamp: Date.now(),
      };
      const activeEntry = createFileEntry(documentPath, currentModification, {
        undoStack: operation === 'undo' ? [historyEntry] : [],
        activeSnapshotId: 'current-active-snapshot',
      });
      if (operation === 'redo') {
        activeEntry.redoStack = [historyEntry];
      }
      const liveBase = 'live base';
      const liveTarget = 'live target';
      const liveModification = createPendingModification(
        `load-before-${operation}-live`,
        documentPath,
        liveBase,
        liveTarget
      );
      const livePreview = createDeferred<BatchApplyResult>();
      seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
      fastApply.engine.preview.mockImplementationOnce(() => livePreview.promise);

      const loadPromise = useDiffStore
        .getState()
        .loadModifications(
          contextId,
          documentPath,
          liveBase,
          `<load-before-${operation}-diff />`,
          `load-before-${operation}-message`,
          `load-before-${operation}.ts`,
          true,
          liveTarget,
          liveTarget
        );
      await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(1));

      const stateBeforeHistoryAction = useDiffStore.getState().getDiffState(contextId);
      await useDiffStore.getState()[operation](contextId);
      const stateWhileLoadPending = useDiffStore.getState().getDiffState(contextId);

      expect(
        tauri.invoke.mock.calls.filter(([command]) => command === 'file_write_to_path')
      ).toEqual([]);
      expect(stateWhileLoadPending.content).toBe(stateBeforeHistoryAction.content);
      expect(stateWhileLoadPending.activeSnapshotId).toBe(
        stateBeforeHistoryAction.activeSnapshotId
      );
      expect(stateWhileLoadPending.undoStack).toBe(stateBeforeHistoryAction.undoStack);
      expect(stateWhileLoadPending.redoStack).toBe(stateBeforeHistoryAction.redoStack);

      livePreview.resolve({
        documentId: documentPath,
        results: [liveModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      });
      await loadPromise;

      const finalState = useDiffStore.getState().getDiffState(contextId);
      expect(finalState.content).toBe(liveTarget);
      expect(finalState.pendingModifications).toEqual([liveModification]);
      expect(finalState.isLoading).toBe(false);
    }
  );

  it('repairs disk content when a newer Diff takes over during rollback writing', async () => {
    const contextId = 'agent-rollback-write-race';
    const documentPath = String.raw`D:\projects\demo\write-race.ts`;
    const baseContent = 'base';
    const historicalContent = 'historical target';
    const liveBase = 'live base';
    const liveTarget = 'live target';
    const targetSnapshot: DocumentSnapshot = {
      id: 'write-race-target',
      documentId: documentPath,
      content: historicalContent,
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'write-race-base',
      documentId: documentPath,
      content: baseContent,
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const activeEntry = createFileEntry(
      documentPath,
      createPendingModification(
        'write-race-current',
        documentPath,
        historicalContent,
        `${historicalContent} latest`
      ),
      { snapshots: [targetSnapshot, baseSnapshot] }
    );
    const rollbackModification = createPendingModification(
      'write-race-rollback',
      documentPath,
      baseContent,
      historicalContent
    );
    const liveModification = createPendingModification(
      'write-race-live',
      documentPath,
      liveTarget,
      `${liveTarget}\nprojected change`
    );
    const rollbackWrite = createDeferred<{ success: boolean }>();
    const livePreview = createDeferred<BatchApplyResult>();
    let fileWriteCount = 0;
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [];
      if (command === 'diff_record_create') return { id: 'write-race-live-record' };
      if (command === 'file_read_content') return liveTarget;
      if (command === 'file_write_to_path') {
        fileWriteCount++;
        return fileWriteCount === 1 ? rollbackWrite.promise : { success: true };
      }
      return undefined;
    });
    fastApply.engine.rollback.mockResolvedValue(historicalContent);
    fastApply.engine.preview
      .mockResolvedValueOnce({
        documentId: documentPath,
        results: [rollbackModification],
        successCount: 1,
        failedCount: 0,
        pendingCount: 1,
      })
      .mockImplementationOnce(() => livePreview.promise);

    const rollbackPromise = useDiffStore.getState().rollback(contextId, targetSnapshot.id);
    await vi.waitFor(() => expect(fileWriteCount).toBe(1));
    const liveLoadPromise = useDiffStore
      .getState()
      .loadModifications(
        contextId,
        documentPath,
        liveBase,
        '<write-race-live-diff />',
        'write-race-live-message',
        'write-race.ts',
        false
      );
    await vi.waitFor(() => expect(fastApply.engine.preview).toHaveBeenCalledTimes(2));
    rollbackWrite.resolve({ success: true });
    await rollbackPromise;

    const fileWrites = tauri.invoke.mock.calls.filter(
      ([command]) => command === 'file_write_to_path'
    );
    expect(fileWrites.map(([, args]) => args?.content)).toEqual([historicalContent, liveTarget]);
    expect(fastApply.engine.preview).toHaveBeenNthCalledWith(
      2,
      documentPath,
      liveTarget,
      '<write-race-live-diff />'
    );
    livePreview.resolve({
      documentId: documentPath,
      results: [liveModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    await liveLoadPromise;
    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.content).toBe(liveTarget);
    expect(finalState.originalContent).toBe(liveTarget);
    expect(finalState.pendingModifications).toEqual([liveModification]);
  });

  it('keeps disk and Diff state unchanged when rollback file writing fails', async () => {
    const contextId = 'agent-rollback-write-failure';
    const documentPath = String.raw`D:\projects\demo\write-failure.ts`;
    const originalModification = createPendingModification(
      'write-failure-original',
      documentPath,
      'before',
      'current'
    );
    const targetSnapshot: DocumentSnapshot = {
      id: 'write-failure-target',
      documentId: documentPath,
      content: 'historical',
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
    };
    const activeEntry = createFileEntry(documentPath, originalModification, {
      snapshots: [targetSnapshot],
      activeSnapshotId: 'write-failure-current',
    });
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    fastApply.engine.rollback.mockResolvedValue(targetSnapshot.content);
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [
        createPendingModification(
          'write-failure-preview',
          documentPath,
          originalModification.diff.oldContent,
          targetSnapshot.content
        ),
      ],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'file_write_to_path') throw new Error('disk denied');
      if (command === 'diff_record_get_pending') return [];
      return undefined;
    });

    await expect(useDiffStore.getState().rollback(contextId, targetSnapshot.id)).rejects.toThrow(
      'disk denied'
    );

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.content).toBe(activeEntry.content);
    expect(finalState.originalContent).toBe(activeEntry.originalContent);
    expect(finalState.originalXml).toBe(activeEntry.originalXml);
    expect(finalState.activeSnapshotId).toBe('write-failure-current');
    expect(fastApply.engine.preview).toHaveBeenCalledTimes(1);
  });

  it('does not write or commit a rollback when its refreshed preview fails', async () => {
    const contextId = 'agent-rollback-preview-failure';
    const documentPath = String.raw`D:\projects\demo\preview-failure.ts`;
    const baseSnapshot: DocumentSnapshot = {
      id: 'preview-failure-base',
      documentId: documentPath,
      content: 'base',
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const targetSnapshot: DocumentSnapshot = {
      id: 'preview-failure-target',
      documentId: documentPath,
      content: 'historical target',
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
    };
    const currentModification = createPendingModification(
      'preview-failure-current',
      documentPath,
      'historical target',
      'latest content'
    );
    const activeEntry = createFileEntry(documentPath, currentModification, {
      snapshots: [targetSnapshot, baseSnapshot],
      activeSnapshotId: 'preview-failure-latest',
    });
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    fastApply.engine.rollback.mockResolvedValue(targetSnapshot.content);
    fastApply.engine.preview.mockRejectedValue(new Error('preview failed'));

    await expect(useDiffStore.getState().rollback(contextId, targetSnapshot.id)).rejects.toThrow(
      'preview failed'
    );

    const finalState = useDiffStore.getState().getDiffState(contextId);
    expect(finalState.content).toBe(activeEntry.content);
    expect(finalState.originalContent).toBe(activeEntry.originalContent);
    expect(finalState.originalXml).toBe(activeEntry.originalXml);
    expect(finalState.activeSnapshotId).toBe('preview-failure-latest');
    expect(tauri.invoke).not.toHaveBeenCalledWith('file_write_to_path', expect.any(Object));
  });

  it('preserves failed results while resetting synthetic snapshot statuses to pending', async () => {
    const contextId = 'agent-synthetic-statuses';
    const documentPath = String.raw`D:\projects\demo\synthetic-statuses.ts`;
    const targetSnapshot: DocumentSnapshot = {
      id: 'synthetic-status-target',
      documentId: documentPath,
      content: 'target',
      timestamp: new Date('2026-07-15T02:00:00.000Z'),
      description: 'Post-write version',
      modificationStatuses: { '0': 'applied', '1': 'rejected' },
    };
    const baseSnapshot: DocumentSnapshot = {
      id: 'synthetic-status-base',
      documentId: documentPath,
      content: 'base',
      timestamp: new Date('2026-07-15T01:00:00.000Z'),
      description: 'Original file version',
    };
    const activeEntry = createFileEntry(documentPath, undefined, {
      snapshots: [targetSnapshot, baseSnapshot],
    });
    const applicable = createPendingModification('synthetic-applicable', documentPath);
    applicable.status = 'applied';
    const failed = createPendingModification('synthetic-failed', documentPath);
    failed.status = 'failed';
    failed.matchResult.success = false;
    seedContext(contextId, createContextState(activeEntry, [activeEntry], 'diff'));
    fastApply.engine.rollback.mockResolvedValue(targetSnapshot.content);
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [applicable, failed],
      successCount: 1,
      failedCount: 1,
      pendingCount: 0,
    });

    await useDiffStore.getState().rollback(contextId, targetSnapshot.id);

    expect(
      useDiffStore
        .getState()
        .getDiffState(contextId)
        .pendingModifications.map((modification) => modification.status)
    ).toEqual(['pending', 'failed']);
  });

  it('ignores a persisted active snapshot that belongs to another document', async () => {
    const contextId = 'agent-foreign-active-snapshot';
    const documentPath = String.raw`D:\projects\demo\document-b.ts`;
    const foreignPath = String.raw`D:\projects\demo\document-a.ts`;
    const restoredModification = createPendingModification(
      'foreign-snapshot-restored',
      documentPath,
      'before b',
      'after b'
    );
    const persistedRecord = {
      id: 'foreign-snapshot-record',
      contextId,
      messageId: 'foreign-snapshot-message',
      documentId: documentPath,
      originalContent: 'before b',
      modifiedContent: 'after b',
      xmlModification: '<document-b-diff />',
      status: 'pending',
      activeSnapshotId: 'document-a-snapshot',
      modificationStatuses: JSON.stringify({ '0': 'pending' }),
      createdAt: 1,
      updatedAt: 1,
    };
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'diff_record_get_pending') return [persistedRecord];
      if (command === 'file_read_content') return 'after b';
      if (command === 'snapshot_get') {
        return {
          id: 'document-a-snapshot',
          documentId: foreignPath,
          content: 'foreign content',
          description: 'Post-write version',
          modificationStatusesJson: JSON.stringify({ '0': 'applied' }),
          createdAt: 1,
        };
      }
      return undefined;
    });
    fastApply.engine.preview.mockResolvedValue({
      documentId: documentPath,
      results: [restoredModification],
      successCount: 1,
      failedCount: 0,
      pendingCount: 1,
    });
    fastApply.engine.listSnapshots.mockResolvedValue([]);

    await useDiffStore.getState().loadPersistedDiffs(contextId);

    const restoredState = useDiffStore.getState().getDiffState(contextId);
    expect(restoredState.documentId).toBe(documentPath);
    expect(restoredState.content).toBe('after b');
    expect(restoredState.originalContent).toBe('before b');
    expect(restoredState.activeSnapshotId).toBeNull();
    expect(fastApply.engine.preview).toHaveBeenCalledTimes(1);
  });

  it('keeps active snapshot ids isolated while switching between files', () => {
    const contextId = 'agent-snapshot-file-switch';
    const pathA = String.raw`D:\projects\demo\file-a.ts`;
    const pathB = String.raw`D:\projects\demo\file-b.ts`;
    const entryA = createFileEntry(pathA, undefined, { activeSnapshotId: 'snapshot-a' });
    const entryB = createFileEntry(pathB, undefined, { activeSnapshotId: 'snapshot-b' });
    seedContext(contextId, createContextState(entryA, [entryA, entryB], 'diff'));

    useDiffStore.getState().selectFile(contextId, pathB);
    expect(useDiffStore.getState().getDiffState(contextId).activeSnapshotId).toBe('snapshot-b');

    useDiffStore.getState().selectFile(contextId, pathA);
    expect(useDiffStore.getState().getDiffState(contextId).activeSnapshotId).toBe('snapshot-a');
  });
});
