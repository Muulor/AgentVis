/**
 * FileProtectionSettings - 文件保护设置标签页
 *
 * 承载 Agent 回收站的最近删除查看与恢复，以及路径保护名单管理。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FileText,
  Folder,
  FolderOpen,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash,
  Trash2,
  X,
} from 'lucide-react';
import { useToast } from '../ui/Toast';
import { Tooltip } from '@components/ui/Tooltip';
import { ConfirmDialog, SelectionCheck } from '@components/ui';
import { getLogger } from '@services/logger';
import { TrashOperationInProgressError, useTrashOperationStore } from '@stores/trashOperationStore';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './FileProtectionSettings.module.css';
import {
  createPendingTrashClean,
  executeConfirmedTrashClean,
  type PendingTrashClean,
} from './trashCleanConfirmation';
import { normalizeTrashBinListResponse, type TrashBinListResponse } from './trashListState';

const logger = getLogger('FileProtectionSettings');

interface TrashEntryInfo {
  id: string;
  originalPath: string;
  trashPath: string;
  deletedAt: string;
  command: string;
  batchId: string;
  isDirectory: boolean;
  originalExists: boolean;
  trashExists: boolean;
}

interface TrashRestoreIssue {
  id: string;
  originalPath: string;
  trashPath: string;
  reason: string;
}

interface TrashRestoreResult {
  restoredCount: number;
  restored: string[];
  conflicts: TrashRestoreIssue[];
  missing: TrashRestoreIssue[];
}

interface TrashDeleteResult {
  deletedCount: number;
  deleted: string[];
  missing: TrashRestoreIssue[];
  failed: TrashRestoreIssue[];
}

type TrashListStatus = 'idle' | 'loading' | 'ready' | 'busy' | 'error';

const DEFAULT_TRASH_LIST_RETRY_MS = 750;
const MIN_TRASH_LIST_RETRY_MS = 250;
const MAX_TRASH_LIST_RETRY_MS = 5_000;

function getFileName(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

function canRestoreEntry(entry: TrashEntryInfo) {
  return entry.trashExists && !entry.originalExists;
}

export function FileProtectionSettings() {
  const { language, t } = useI18n();
  const { toast } = useToast();
  const [trashBinPath, setTrashBinPath] = useState<string>('');
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntryInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isProtectionLoading, setIsProtectionLoading] = useState(
    () => typeof window !== 'undefined' && '__TAURI__' in window
  );
  const [trashListStatus, setTrashListStatus] = useState<TrashListStatus>('idle');
  const [trashListRetryAfterMs, setTrashListRetryAfterMs] = useState(DEFAULT_TRASH_LIST_RETRY_MS);
  const [loadedTrashRevision, setLoadedTrashRevision] = useState<number | null>(null);
  const [isSavingPaths, setIsSavingPaths] = useState(false);
  const [pendingTrashClean, setPendingTrashClean] = useState<PendingTrashClean | null>(null);
  const activeTrashOperation = useTrashOperationStore((state) => state.activeOperation);
  const settledTrashRevision = useTrashOperationStore((state) => state.settledRevision);
  const runTrashOperation = useTrashOperationStore((state) => state.runOperation);
  const isMountedRef = useRef(false);
  const protectionRequestRef = useRef(0);
  const trashListRequestRef = useRef(0);

  const restoringKey = activeTrashOperation?.kind === 'restore' ? activeTrashOperation.key : null;
  const deletingKey = activeTrashOperation?.kind === 'clean' ? activeTrashOperation.key : null;
  const isTrashListFresh = loadedTrashRevision === settledTrashRevision;
  const trashControlsDisabled =
    activeTrashOperation !== null || trashListStatus !== 'ready' || !isTrashListFresh;

  const batchCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of trashEntries) {
      counts.set(entry.batchId, (counts.get(entry.batchId) ?? 0) + 1);
    }
    return counts;
  }, [trashEntries]);

  const restorableEntries = useMemo(() => trashEntries.filter(canRestoreEntry), [trashEntries]);

  const selectedRestorableCount = useMemo(
    () => restorableEntries.filter((entry) => selectedIds.has(entry.id)).length,
    [restorableEntries, selectedIds]
  );

  const selectedCount = selectedIds.size;
  const allEntriesSelected =
    trashEntries.length > 0 && trashEntries.every((entry) => selectedIds.has(entry.id));

  const formatDeletedAt = useCallback(
    (deletedAt: string) => {
      const date = new Date(deletedAt);
      if (Number.isNaN(date.getTime())) {
        return deletedAt;
      }
      return new Intl.DateTimeFormat(language, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    },
    [language]
  );

  const loadProtectionData = useCallback(async () => {
    const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    if (!hasTauri) return;

    const requestId = ++protectionRequestRef.current;
    setIsProtectionLoading(true);
    try {
      const [trashPath, paths] = await Promise.all([
        invoke<string>('get_trash_bin_path'),
        invoke<string[]>('get_protected_paths'),
      ]);
      if (!isMountedRef.current || requestId !== protectionRequestRef.current) return;
      setTrashBinPath(trashPath);
      setProtectedPaths(paths);
    } catch (error) {
      if (!isMountedRef.current || requestId !== protectionRequestRef.current) return;
      logger.error('[FileProtectionSettings] 加载文件保护设置失败:', error);
      toast({ type: 'error', title: t('settings.fileProtection.toastLoadFailed') });
    } finally {
      if (isMountedRef.current && requestId === protectionRequestRef.current) {
        setIsProtectionLoading(false);
      }
    }
  }, [t, toast]);

  const loadTrashEntries = useCallback(async () => {
    const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    if (!hasTauri) return;

    const operationState = useTrashOperationStore.getState();
    if (operationState.activeOperation) return;
    const expectedRevision = operationState.settledRevision;

    const requestId = ++trashListRequestRef.current;
    setTrashListStatus((current) => (current === 'busy' ? 'busy' : 'loading'));
    try {
      const response = await invoke<TrashBinListResponse<TrashEntryInfo> | TrashEntryInfo[]>(
        'trash_bin_list_entries'
      );
      if (!isMountedRef.current || requestId !== trashListRequestRef.current) return;
      const currentOperationState = useTrashOperationStore.getState();
      if (
        currentOperationState.activeOperation ||
        currentOperationState.settledRevision !== expectedRevision
      ) {
        return;
      }

      const normalized = normalizeTrashBinListResponse(response);
      if (normalized.status === 'busy') {
        const requestedDelay = normalized.retryAfterMs ?? DEFAULT_TRASH_LIST_RETRY_MS;
        setTrashListRetryAfterMs(
          Math.min(MAX_TRASH_LIST_RETRY_MS, Math.max(MIN_TRASH_LIST_RETRY_MS, requestedDelay))
        );
        setTrashListStatus('busy');
        return;
      }

      const entries = normalized.entries ?? [];
      setTrashEntries(entries);
      setSelectedIds((current) => {
        const existingIds = new Set(entries.map((entry) => entry.id));
        return new Set([...current].filter((id) => existingIds.has(id)));
      });
      setLoadedTrashRevision(expectedRevision);
      setTrashListStatus('ready');
    } catch (error) {
      if (!isMountedRef.current || requestId !== trashListRequestRef.current) return;
      logger.error('[FileProtectionSettings] 加载 Agent Trash 条目失败:', error);
      setTrashListStatus('error');
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void loadProtectionData();
    return () => {
      isMountedRef.current = false;
      protectionRequestRef.current += 1;
      trashListRequestRef.current += 1;
    };
  }, [loadProtectionData]);

  useEffect(() => {
    if (activeTrashOperation) {
      trashListRequestRef.current += 1;
      return;
    }
    void loadTrashEntries();
  }, [activeTrashOperation, loadTrashEntries, settledTrashRevision]);

  useEffect(() => {
    if (trashListStatus !== 'busy' || activeTrashOperation) return;
    const retryTimer = window.setTimeout(() => {
      void loadTrashEntries();
    }, trashListRetryAfterMs);
    return () => window.clearTimeout(retryTimer);
  }, [activeTrashOperation, loadTrashEntries, trashListRetryAfterMs, trashListStatus]);

  const handleRefresh = useCallback(() => {
    void loadProtectionData();
    if (!activeTrashOperation) {
      void loadTrashEntries();
    }
  }, [activeTrashOperation, loadProtectionData, loadTrashEntries]);

  const handleOpenTrashBin = useCallback(async () => {
    if (!trashBinPath) return;
    try {
      await invoke('file_reveal_in_explorer', { filePath: trashBinPath });
    } catch (error) {
      logger.error('[FileProtectionSettings] 打开回收站目录失败:', error);
      toast({ type: 'error', title: t('settings.fileProtection.toastOpenDirectoryFailed') });
    }
  }, [trashBinPath, toast, t]);

  const showRestoreToast = useCallback(
    (result: TrashRestoreResult) => {
      const issueCount = result.conflicts.length + result.missing.length;
      if (result.restoredCount > 0 && issueCount === 0) {
        toast({
          type: 'success',
          title: t('settings.fileProtection.toastRestoreSuccess', { count: result.restoredCount }),
        });
        return;
      }

      if (result.restoredCount > 0) {
        toast({
          type: 'warning',
          title: t('settings.fileProtection.toastRestorePartial', {
            restored: result.restoredCount,
            issues: issueCount,
          }),
        });
        return;
      }

      if (issueCount > 0) {
        toast({
          type: 'warning',
          title: t('settings.fileProtection.toastRestoreBlocked', { count: issueCount }),
        });
        return;
      }

      toast({ type: 'info', title: t('settings.fileProtection.toastNothingRestored') });
    },
    [t, toast]
  );

  const showDeleteToast = useCallback(
    (result: TrashDeleteResult) => {
      const cleanedCount = result.deletedCount + result.missing.length;
      const failedCount = result.failed.length;
      if (cleanedCount > 0 && failedCount === 0) {
        toast({
          type: 'success',
          title: t('settings.fileProtection.toastCleanSuccess', { count: cleanedCount }),
        });
        return;
      }

      if (cleanedCount > 0) {
        toast({
          type: 'warning',
          title: t('settings.fileProtection.toastCleanPartial', {
            cleaned: cleanedCount,
            failed: failedCount,
          }),
        });
        return;
      }

      if (failedCount > 0) {
        toast({
          type: 'warning',
          title: t('settings.fileProtection.toastCleanBlocked', { count: failedCount }),
        });
        return;
      }

      toast({ type: 'info', title: t('settings.fileProtection.toastNothingCleaned') });
    },
    [t, toast]
  );

  const restoreEntries = useCallback(
    async (ids: string[], restoreKey: string) => {
      if (ids.length === 0) {
        toast({ type: 'warning', title: t('settings.fileProtection.toastSelectEntries') });
        return;
      }
      if (useTrashOperationStore.getState().activeOperation) return;

      try {
        const result = await runTrashOperation({ kind: 'restore', key: restoreKey }, () =>
          invoke<TrashRestoreResult>('trash_bin_restore_entries', { ids })
        );
        showRestoreToast(result);
        if (isMountedRef.current) {
          setSelectedIds(new Set());
        }
      } catch (error) {
        if (error instanceof TrashOperationInProgressError) return;
        logger.error('[FileProtectionSettings] 恢复回收站条目失败:', error);
        toast({
          type: 'error',
          title: t('settings.fileProtection.toastRestoreFailed', { error: String(error) }),
        });
      }
    },
    [runTrashOperation, showRestoreToast, t, toast]
  );

  const handleRestoreSelected = useCallback(() => {
    const ids = trashEntries
      .filter((entry) => selectedIds.has(entry.id) && canRestoreEntry(entry))
      .map((entry) => entry.id);
    void restoreEntries(ids, 'selected');
  }, [restoreEntries, selectedIds, trashEntries]);

  const cleanEntries = useCallback(
    async (ids: string[], deleteKey: string) => {
      if (ids.length === 0) {
        toast({ type: 'warning', title: t('settings.fileProtection.toastSelectEntriesToClean') });
        return;
      }
      if (useTrashOperationStore.getState().activeOperation) return;

      try {
        const result = await runTrashOperation({ kind: 'clean', key: deleteKey }, () =>
          invoke<TrashDeleteResult>('trash_bin_delete_entries', { ids })
        );
        showDeleteToast(result);
        if (isMountedRef.current) {
          setSelectedIds(new Set());
        }
      } catch (error) {
        if (error instanceof TrashOperationInProgressError) return;
        logger.error('[FileProtectionSettings] 清理回收站条目失败:', error);
        toast({
          type: 'error',
          title: t('settings.fileProtection.toastCleanFailed', { error: String(error) }),
        });
      }
    },
    [runTrashOperation, showDeleteToast, t, toast]
  );

  const handleCleanSelected = useCallback(() => {
    const request = createPendingTrashClean(selectedIds, 'selected');
    if (!request) {
      toast({ type: 'warning', title: t('settings.fileProtection.toastSelectEntriesToClean') });
      return;
    }
    if (useTrashOperationStore.getState().activeOperation) return;
    setPendingTrashClean(request);
  }, [selectedIds, t, toast]);

  const handleConfirmTrashClean = useCallback(async () => {
    const request = pendingTrashClean;
    if (!request) return;
    await executeConfirmedTrashClean(request, cleanEntries);
    if (isMountedRef.current) {
      setPendingTrashClean(null);
    }
  }, [cleanEntries, pendingTrashClean]);

  const handleCancelTrashClean = useCallback(() => {
    if (useTrashOperationStore.getState().activeOperation) return;
    setPendingTrashClean(null);
  }, []);

  const handleToggleEntry = useCallback((entry: TrashEntryInfo) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(entry.id)) {
        next.delete(entry.id);
      } else {
        next.add(entry.id);
      }
      return next;
    });
  }, []);

  const handleSelectBatch = useCallback(
    (batchId: string) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const entry of trashEntries) {
          if (entry.batchId === batchId) {
            next.add(entry.id);
          }
        }
        return next;
      });
    },
    [trashEntries]
  );

  const handleToggleAllEntries = useCallback(() => {
    setSelectedIds((current) => {
      if (allEntriesSelected) {
        const next = new Set(current);
        for (const entry of trashEntries) {
          next.delete(entry.id);
        }
        return next;
      }
      return new Set([...current, ...trashEntries.map((entry) => entry.id)]);
    });
  }, [allEntriesSelected, trashEntries]);

  const handleAddPath = useCallback(async () => {
    try {
      const selected = (await open({
        directory: true,
        multiple: false,
        title: t('settings.fileProtection.selectProtectedPathTitle'),
      })) as string | string[] | null;
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (typeof selectedPath !== 'string' || selectedPath.length === 0) return;

      const isDuplicate = protectedPaths.some(
        (existPath) => existPath.toLowerCase() === selectedPath.toLowerCase()
      );
      if (isDuplicate) {
        toast({ type: 'error', title: t('settings.fileProtection.toastPathDuplicate') });
        return;
      }

      const newPaths = [...protectedPaths, selectedPath];
      setIsSavingPaths(true);
      try {
        await invoke('set_protected_paths', { paths: newPaths });
        setProtectedPaths(newPaths);
        toast({ type: 'success', title: t('settings.fileProtection.toastPathAdded') });
      } catch (error) {
        logger.error('[FileProtectionSettings] 保存保护路径失败:', error);
        toast({
          type: 'error',
          title: t('settings.fileProtection.toastSaveFailed', { error: String(error) }),
        });
      } finally {
        setIsSavingPaths(false);
      }
    } catch (error) {
      logger.error('[FileProtectionSettings] 选择目录失败:', error);
    }
  }, [protectedPaths, toast, t]);

  const handleRemovePath = useCallback(
    async (index: number) => {
      const newPaths = protectedPaths.filter((_, i) => i !== index);
      setIsSavingPaths(true);
      try {
        await invoke('set_protected_paths', { paths: newPaths });
        setProtectedPaths(newPaths);
        toast({ type: 'success', title: t('settings.fileProtection.toastPathRemoved') });
      } catch (error) {
        logger.error('[FileProtectionSettings] 移除保护路径失败:', error);
        toast({
          type: 'error',
          title: t('settings.fileProtection.toastRemoveFailed', { error: String(error) }),
        });
      } finally {
        setIsSavingPaths(false);
      }
    },
    [protectedPaths, toast, t]
  );

  const getEntryStatus = (entry: TrashEntryInfo) => {
    if (!entry.trashExists) {
      return t('settings.fileProtection.statusTrashMissing');
    }
    if (entry.originalExists) {
      return t('settings.fileProtection.statusOriginalExists');
    }
    return null;
  };

  const trashStatusMessage = activeTrashOperation
    ? t(
        activeTrashOperation.kind === 'restore'
          ? 'settings.fileProtection.trashRestoreInProgress'
          : 'settings.fileProtection.trashCleanInProgress'
      )
    : trashListStatus === 'busy'
      ? t('settings.fileProtection.trashBusy')
      : trashListStatus === 'error'
        ? t('settings.fileProtection.trashLoadFailed')
        : trashListStatus === 'idle' || trashListStatus === 'loading' || !isTrashListFresh
          ? t('settings.fileProtection.loadingTrash')
          : null;
  const trashStatusIsError = activeTrashOperation === null && trashListStatus === 'error';
  const isTrashRefreshPending =
    activeTrashOperation !== null ||
    trashListStatus === 'idle' ||
    trashListStatus === 'loading' ||
    trashListStatus === 'busy' ||
    (trashListStatus !== 'error' && !isTrashListFresh);

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>
              <Trash size={16} strokeWidth={1.5} className={styles.sectionIcon} />
              {t('settings.fileProtection.trashBin')}
            </h3>
            <p className={styles.hint}>{t('settings.fileProtection.trashBinHint')}</p>
          </div>
          <Tooltip content={t('settings.fileProtection.refreshTrashTitle')}>
            <button
              className={styles.iconButton}
              onClick={handleRefresh}
              disabled={isTrashRefreshPending}
              aria-label={t('settings.fileProtection.refreshTrashTitle')}
            >
              <RefreshCw
                size={15}
                strokeWidth={1.7}
                className={cx(isTrashRefreshPending && styles.spinIcon)}
              />
            </button>
          </Tooltip>
        </div>

        <div className={styles.pathDisplay}>
          <span className={styles.pathText}>
            {trashBinPath ||
              t(
                isProtectionLoading
                  ? 'common.loading'
                  : 'settings.fileProtection.trashBinMissingPath'
              )}
          </span>
          <Tooltip content={t('settings.fileProtection.trashBinOpenTitle')}>
            <button
              className={styles.openButton}
              onClick={handleOpenTrashBin}
              disabled={!trashBinPath}
              aria-label={t('settings.fileProtection.trashBinOpenTitle')}
            >
              <FolderOpen size={14} strokeWidth={1.6} />
              {t('common.open')}
            </button>
          </Tooltip>
        </div>

        <div className={styles.trashToolbar}>
          <label
            className={styles.selectAllControl}
            data-disabled={trashEntries.length === 0 || trashControlsDisabled}
          >
            <input
              className={styles.selectionInput}
              type="checkbox"
              checked={allEntriesSelected}
              disabled={trashEntries.length === 0 || trashControlsDisabled}
              onChange={handleToggleAllEntries}
            />
            <SelectionCheck
              checked={allEntriesSelected}
              indeterminate={selectedCount > 0 && !allEntriesSelected}
              disabled={trashEntries.length === 0 || trashControlsDisabled}
              className={styles.trashSelectionIndicator}
            />
            <span>
              {t('settings.fileProtection.selectTrashEntries', { count: trashEntries.length })}
            </span>
          </label>
          <div className={styles.toolbarActions}>
            <button
              className={styles.secondaryButton}
              onClick={handleCleanSelected}
              disabled={selectedCount === 0 || trashControlsDisabled}
            >
              {deletingKey === 'selected' ? (
                <span className={styles.spinner} />
              ) : (
                <Trash2 size={14} strokeWidth={1.7} />
              )}
              {t('settings.fileProtection.cleanSelected', { count: selectedCount })}
            </button>
            <button
              className={styles.secondaryButton}
              onClick={handleRestoreSelected}
              disabled={selectedRestorableCount === 0 || trashControlsDisabled}
            >
              {restoringKey === 'selected' ? (
                <span className={styles.spinner} />
              ) : (
                <RotateCcw size={14} strokeWidth={1.7} />
              )}
              {t('settings.fileProtection.restoreSelected', { count: selectedRestorableCount })}
            </button>
          </div>
        </div>

        {trashStatusMessage && (
          <div
            className={cx(styles.operationHint, trashStatusIsError && styles.loadErrorHint)}
            role={trashStatusIsError ? 'alert' : 'status'}
            aria-live={trashStatusIsError ? 'assertive' : 'polite'}
          >
            {!trashStatusIsError && <span className={styles.spinner} />}
            <span>{trashStatusMessage}</span>
          </div>
        )}

        {trashEntries.length > 0 ? (
          <div className={styles.trashList}>
            {trashEntries.map((entry) => {
              const status = getEntryStatus(entry);
              const batchCount = batchCounts.get(entry.batchId) ?? 1;
              return (
                <div
                  key={entry.id}
                  className={styles.trashRow}
                  data-disabled={trashControlsDisabled}
                >
                  <label className={styles.entryCheckbox}>
                    <input
                      className={styles.selectionInput}
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      disabled={trashControlsDisabled}
                      onChange={() => handleToggleEntry(entry)}
                      aria-label={t('settings.fileProtection.selectEntryAria', {
                        path: entry.originalPath,
                      })}
                    />
                    <SelectionCheck
                      checked={selectedIds.has(entry.id)}
                      disabled={trashControlsDisabled}
                      className={styles.trashSelectionIndicator}
                    />
                  </label>
                  <span className={styles.entryIcon}>
                    {entry.isDirectory ? (
                      <Folder size={16} strokeWidth={1.6} />
                    ) : (
                      <FileText size={16} strokeWidth={1.6} />
                    )}
                  </span>
                  <div className={styles.entryMain}>
                    <div className={styles.entryTitleLine}>
                      <Tooltip content={entry.originalPath}>
                        <span className={styles.entryName}>{getFileName(entry.originalPath)}</span>
                      </Tooltip>
                      {status && <span className={styles.warningBadge}>{status}</span>}
                    </div>
                    <Tooltip content={entry.originalPath}>
                      <div className={styles.entryPath}>{entry.originalPath}</div>
                    </Tooltip>
                    <div className={styles.entryMeta}>
                      <span>{formatDeletedAt(entry.deletedAt)}</span>
                      <Tooltip content={entry.command}>
                        <span>{entry.command}</span>
                      </Tooltip>
                    </div>
                  </div>
                  {batchCount > 1 && (
                    <div className={styles.entryActions}>
                      <Tooltip
                        content={t('settings.fileProtection.selectBatchTitle', {
                          count: batchCount,
                        })}
                      >
                        <button
                          className={styles.secondaryButton}
                          onClick={() => handleSelectBatch(entry.batchId)}
                          disabled={trashControlsDisabled}
                          aria-label={t('settings.fileProtection.selectBatchTitle', {
                            count: batchCount,
                          })}
                        >
                          <Layers size={13} strokeWidth={1.7} />
                          {t('settings.fileProtection.selectBatch')}
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : trashListStatus === 'ready' && isTrashListFresh ? (
          <div className={styles.emptyHint}>{t('settings.fileProtection.trashEmpty')}</div>
        ) : null}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>
              <ShieldCheck size={16} strokeWidth={1.5} className={styles.sectionIcon} />
              {t('settings.fileProtection.protectedPaths')}
            </h3>
            <p className={styles.hint}>{t('settings.fileProtection.protectedPathsHint')}</p>
          </div>
          <button className={styles.addButton} onClick={handleAddPath} disabled={isSavingPaths}>
            {isSavingPaths ? (
              <span className={styles.spinner} />
            ) : (
              <Plus size={14} strokeWidth={1.8} />
            )}
            {t('settings.fileProtection.protectedPathsAdd')}
          </button>
        </div>

        {isProtectionLoading ? (
          <div className={styles.loadingHint}>{t('common.loading')}</div>
        ) : (
          <div className={styles.pathList}>
            {protectedPaths.length === 0 ? (
              <div className={styles.emptyHint}>
                {t('settings.fileProtection.protectedPathsEmpty')}
              </div>
            ) : (
              protectedPaths.map((path, index) => (
                <div key={`${path}-${index}`} className={styles.pathRow}>
                  <Tooltip content={path}>
                    <span className={styles.pathRowText}>{path}</span>
                  </Tooltip>
                  <Tooltip content={t('settings.fileProtection.protectedPathRemoveTitle')}>
                    <button
                      className={styles.removeButton}
                      onClick={() => void handleRemovePath(index)}
                      disabled={isSavingPaths}
                      aria-label={t('settings.fileProtection.protectedPathRemoveAria', { path })}
                    >
                      <X size={14} strokeWidth={1.8} />
                    </button>
                  </Tooltip>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingTrashClean !== null}
        onClose={handleCancelTrashClean}
        onConfirm={() => void handleConfirmTrashClean()}
        title={t('settings.fileProtection.confirmCleanTitle')}
        description={t('settings.fileProtection.confirmCleanEntries', {
          count: pendingTrashClean?.ids.length ?? 0,
        })}
        confirmText={t('settings.fileProtection.confirmCleanAction')}
        variant="danger"
        isLoading={pendingTrashClean !== null && deletingKey === pendingTrashClean.deleteKey}
        disableDismiss={pendingTrashClean !== null && deletingKey === pendingTrashClean.deleteKey}
      />
    </div>
  );
}
