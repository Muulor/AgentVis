/**
 * FileList - 文件列表组件（文件夹导航模式）
 *
 * 显示当前 Agent 的交付物文件，支持文件夹浏览。
 * 采用面包屑导航 + 前进/后退按钮的文件管理器风格。
 *
 * 功能：
 * - 根目录显示当前目录的直接子项（文件和文件夹）
 * - 单击文件夹进入子目录
 * - 面包屑导航支持跳转到任意层级
 * - 前进/后退按钮基于导航历史栈
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  FolderOpen,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronRight as BreadcrumbSep,
  Home,
  Play,
  UploadCloud,
} from 'lucide-react';
import { FileItem, type FileItemData } from './FileItem';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { usePreviewStore } from '@stores/previewStore';
import styles from './FileList.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { inferTemplateFromFileNames, isPreviewableFile } from '@services/preview';
import { isPreviewCancellation, PreviewServiceError } from '@services/preview/previewErrors';
import {
  listPreviewSourceTree,
  readPreviewPackageJson,
  readPreviewSourceFiles,
} from '@services/preview/previewSourceStaging';
import { useI18n } from '@/i18n';
import { getMissingDirectoryRecoveryPath } from './FileListPathRecovery';
import {
  getWorkspaceImportProgressPercent,
  getWorkspaceImportTotals,
  collectDroppedWorkspaceItems,
  createAbortSignalGuardedCallback,
  importWorkspaceItems,
  registerAbortableDisposable,
  WorkspaceImportCancelledError,
  WorkspaceImportCommitError,
  type WorkspaceImportProgress,
} from './WorkspaceImportService';

const logger = getLogger('FileList');

/** 后台静默刷新的防抖间隔（ms）：合并短时间内的批量文件写入事件 */
const SILENT_REFRESH_DEBOUNCE_MS = 300;

/** 后端返回的目录条目类型 */
interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  createdAt: number;
  relativePath: string;
  absolutePath: string;
}

/** 拖入工作区的待导入项目 */
interface ImportProgress extends WorkspaceImportProgress {
  cancelRequested: boolean;
}

interface WorkspaceImportOperation {
  controller: AbortController;
  phase: WorkspaceImportProgress['phase'];
  abortReason: 'user' | 'context-change' | null;
}

interface FileListProps {
  /** Agent ID */
  agentId: string;
  /** Hub 名称（用于目录查找） */
  hubName: string;
  /** Agent 名称（用于目录查找） */
  agentName: string;
  /**
   * 外部项目根目录绝对路径（可选）
   *
   * 设置时切换为项目目录浏览模式：
   * - 调用 file_list_project_directory 替代 file_list_directory
   * - 文件 ID 使用路径哈希前缀（避免与 deliverables ID 冲突）
   * - 隐藏 Vite Preview 按钮（外部项目有自己的构建流程）
   */
  rootDir?: string;
  /** 选中的文件 ID */
  selectedFileId: string | null;
  /** 选择文件回调 */
  onSelectFile: (file: FileItemData) => void;
  /** 文件删除后回调（用于清理预览状态） */
  onFileDeleted?: (fileId: string) => void;
}

/**
 * 清理文件夹名称（移除不安全字符）
 */
function sanitizeFolderName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unnamed'
  );
}

function formatImportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isWorkspaceFileDrag(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes('Files') &&
    !dataTransfer.types.includes('application/x-attachment-reorder')
  );
}

export function FileList({
  agentId,
  hubName,
  agentName,
  rootDir,
  selectedFileId,
  onSelectFile,
  onFileDeleted,
}: FileListProps) {
  const [entries, setEntries] = useState<FileItemData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileItemData | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDropActive, setIsDropActive] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const activeImportRef = useRef<WorkspaceImportOperation | null>(null);
  const isMountedRef = useRef(true);
  const lastImportProgressAtRef = useRef(0);
  const [isImportStalled, setIsImportStalled] = useState(false);
  const workspaceDragCounterRef = useRef(0);
  const { toast } = useToast();

  useEffect(() => {
    if (!isImporting) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() - lastImportProgressAtRef.current >= 30_000) {
        setIsImportStalled(true);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [isImporting]);
  const { t } = useI18n();
  const {
    startProjectPreview,
    markProjectRequestSubmitted,
    projectRequestId: currentProjectRequestId,
    setProjectStatus,
    setProjectTemplate,
    setProjectUrl,
  } = usePreviewStore();
  const [isStartingPreview, setIsStartingPreview] = useState(false);
  const startingPreviewRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const startingRequestId = startingPreviewRequestIdRef.current;
    if (startingRequestId !== null && startingRequestId !== currentProjectRequestId) {
      startingPreviewRequestIdRef.current = null;
      setIsStartingPreview(false);
    }
  }, [currentProjectRequestId]);

  // ==================== 文件夹导航状态 ====================
  /** 当前相对路径（空字符串 = 根目录） */
  const [currentPath, setCurrentPath] = useState('');
  /** 后退栈 */
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  /** 前进栈 */
  const [forwardStack, setForwardStack] = useState<string[]>([]);

  const sanitizedHubName = sanitizeFolderName(hubName);
  const sanitizedAgentName = sanitizeFolderName(agentName);

  // 面包屑路径段
  const breadcrumbSegments = useMemo(
    () => (currentPath ? currentPath.split('/').filter(Boolean) : []),
    [currentPath]
  );

  const canGoBack = historyStack.length > 0;
  const canGoForward = forwardStack.length > 0;

  /**
   * 加载当前目录内容
   *
   * @param path - 要加载的相对路径
   * @param silent - 静默刷新模式（true=不显示 loading 状态，用于后台事件触发的刷新）
   *
   * 为什么需要区分两种模式？
   * - 首次加载/切换 Agent 时需要显示 loading，让用户知道数据正在加载
   * - 文件写入事件触发的后台刷新不应显示 loading，否则会导致列表区域闪烁（
   *   尤其在用户正在浏览其他 Agent 窗口时，右栏出现无意义的刷新动画）
   */
  const loadDirectory = useCallback(
    async (path: string, silent = false) => {
      if (!agentId) {
        setEntries([]);
        return;
      }

      // 静默刷新不进入 loading 状态，避免视觉闪烁
      if (!silent) {
        setIsLoading(true);
      }
      setError(null);

      try {
        // 项目目录模式 vs 交付物目录模式：调用不同的 Tauri 命令
        const result = rootDir
          ? await invoke<DirectoryEntry[]>('file_list_project_directory', {
              rootDir,
              relativePath: path,
            })
          : await invoke<DirectoryEntry[]>('file_list_directory', {
              hubName: sanitizedHubName,
              agentName: sanitizedAgentName,
              relativePath: path,
            });

        // 文件 ID 前缀：项目模式使用 'proj_' 避免与 deliverables ID 冲突
        const idPrefix = rootDir ? 'proj' : sanitizedHubName;
        const idSuffix = rootDir ? '' : `_${sanitizedAgentName}`;
        const newEntries = result.map((e) => {
          const safeRelative = e.relativePath.replace(/[/\\]/g, '_');
          return {
            id: `${idPrefix}${idSuffix}_${safeRelative}`,
            fileName: e.name,
            filePath: e.absolutePath,
            size: e.size,
            createdAt: e.createdAt,
            isDirectory: e.isDirectory,
          } as FileItemData;
        });

        // 内容相等性检查：避免数据未变化时触发不必要的 React 重渲染
        setEntries((prev) => {
          const prevIds = prev.map((e) => e.id).join(',');
          const newIds = newEntries.map((e) => e.id).join(',');
          if (prevIds === newIds) {
            return prev;
          }
          return newEntries;
        });
      } catch (err) {
        const recoveryPath = getMissingDirectoryRecoveryPath(path, err);
        if (recoveryPath !== null) {
          logger.warn('[FileList] 当前目录不存在，已回退到父目录:', { path, recoveryPath, err });
          setEntries([]);
          setCurrentPath(recoveryPath);
          setForwardStack([]);
          setError(null);
          return;
        }

        logger.error('[FileList] 加载目录失败:', err);
        setError(t('file.loadDirectoryFailed'));
      } finally {
        if (!silent) {
          setIsLoading(false);
        }
      }
    },
    [agentId, sanitizedHubName, sanitizedAgentName, rootDir, t]
  );

  // Agent 切换或 rootDir 变化时重置导航状态并加载根目录
  useEffect(() => {
    const activeImport = activeImportRef.current;
    if (activeImport) {
      activeImport.abortReason = 'context-change';
      activeImport.controller.abort();
    }
    setCurrentPath('');
    setHistoryStack([]);
    setForwardStack([]);
    void loadDirectory('');
  }, [agentId, hubName, agentName, rootDir]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const activeImport = activeImportRef.current;
      if (activeImport) {
        activeImport.abortReason = 'context-change';
        activeImport.controller.abort();
      }
    };
  }, []);

  // currentPath 变化时加载目录（排除初始化场景，由上面的 effect 处理）
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    // 用户主动导航切换目录时，显示 loading（非静默）
    void loadDirectory(currentPath);
  }, [currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // 监听新交付物创建事件，自动静默刷新当前目录
  const loadDirectoryRef = useRef(loadDirectory);
  const currentPathRef = useRef(currentPath);
  loadDirectoryRef.current = loadDirectory;
  currentPathRef.current = currentPath;

  /** 后台静默刷新的防抖定时器引用 */
  const silentRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const listenerController = new AbortController();
    void registerAbortableDisposable(listenerController.signal, async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (listenerController.signal.aborted) return () => undefined;

      return listen<{ agentId: string; filePath: string }>(
        'file:deliverable_created',
        createAbortSignalGuardedCallback(
          listenerController.signal,
          (event: { payload: { agentId: string; filePath: string } }) => {
            // 严格过滤：只响应当前显示 Agent 的事件
            // 当用户切换到 Agent B 时，agentId 变为 B，Agent A 的事件被忽略，
            // 避免后台 Agent 写文件导致右栏出现闪动刷新动画
            if (event.payload.agentId !== agentId) {
              return;
            }

            logger.trace('[FileList] 收到交付物创建事件，静默刷新:', event.payload);

            // 防抖：合并短时间内的多次写文件事件（如 Agent 连续写多个文件时）
            // 避免每次写入都触发一次重渲染，降低 UI 抖动频率
            if (silentRefreshTimerRef.current !== null) {
              clearTimeout(silentRefreshTimerRef.current);
            }
            silentRefreshTimerRef.current = setTimeout(
              createAbortSignalGuardedCallback(listenerController.signal, () => {
                silentRefreshTimerRef.current = null;
                // silent=true：不触发 loading 状态，内容相等时不重渲染
                void loadDirectoryRef.current(currentPathRef.current, true);
              }),
              SILENT_REFRESH_DEBOUNCE_MS
            );
          }
        )
      );
    }).catch((listenerError: unknown) => {
      if (!listenerController.signal.aborted) {
        logger.warn('[FileList] 注册交付物监听失败:', listenerError);
      }
    });

    return () => {
      listenerController.abort();
      // 清理防抖定时器，防止 Agent 切换后定时器仍然触发旧的刷新
      if (silentRefreshTimerRef.current !== null) {
        clearTimeout(silentRefreshTimerRef.current);
        silentRefreshTimerRef.current = null;
      }
    };
  }, [agentId]);

  // ==================== 导航操作 ====================

  /** 进入子目录 */
  const navigateToFolder = useCallback(
    (relativePath: string) => {
      setHistoryStack((prev) => [...prev, currentPath]);
      setForwardStack([]); // 进入新目录时清空前进栈
      setCurrentPath(relativePath);
    },
    [currentPath]
  );

  /** 后退 */
  const goBack = useCallback(() => {
    if (historyStack.length === 0) return;
    const prevPath = historyStack[historyStack.length - 1] ?? '';
    setHistoryStack((prev) => prev.slice(0, -1));
    setForwardStack((prev) => [...prev, currentPath]);
    setCurrentPath(prevPath);
  }, [historyStack, currentPath]);

  /** 前进 */
  const goForward = useCallback(() => {
    if (forwardStack.length === 0) return;
    const nextPath = forwardStack[forwardStack.length - 1] ?? '';
    setForwardStack((prev) => prev.slice(0, -1));
    setHistoryStack((prev) => [...prev, currentPath]);
    setCurrentPath(nextPath);
  }, [forwardStack, currentPath]);

  /** 跳转到面包屑指定层级 */
  const navigateToBreadcrumb = useCallback(
    (segmentIndex: number) => {
      // segmentIndex = -1 表示根目录
      const targetPath =
        segmentIndex < 0 ? '' : breadcrumbSegments.slice(0, segmentIndex + 1).join('/');

      if (targetPath !== currentPath) {
        setHistoryStack((prev) => [...prev, currentPath]);
        setForwardStack([]);
        setCurrentPath(targetPath);
      }
    },
    [breadcrumbSegments, currentPath]
  );

  // ==================== 文件操作 ====================

  /** 点击条目：文件夹 → 进入，文件 → 选中预览 */
  const handleItemClick = useCallback(
    (item: FileItemData) => {
      if (item.isDirectory) {
        // 通过当前路径 + 文件夹名拼接相对路径
        const folderRelativePath = currentPath ? `${currentPath}/${item.fileName}` : item.fileName;
        navigateToFolder(folderRelativePath);
      } else {
        onSelectFile(item);
      }
    },
    [currentPath, navigateToFolder, onSelectFile]
  );

  // 导出文件（二进制安全：使用 copyFile 而非文本读写，支持图片等非 UTF-8 文件）
  const handleExport = async (file: FileItemData) => {
    try {
      const savePath = await save({
        defaultPath: file.fileName,
        filters: [{ name: t('file.allFiles'), extensions: ['*'] }],
      });

      if (savePath) {
        const { copyFile } = await import('@tauri-apps/plugin-fs');
        await copyFile(file.filePath, savePath);
        toast({ type: 'success', title: t('file.exportSuccess', { path: savePath }) });
      }
    } catch (err) {
      logger.error('[FileList] 导出文件失败:', err);
      toast({ type: 'error', title: t('file.exportFailed') });
    }
  };

  /** 在资源管理器中显示文件 */
  const handleRevealInExplorer = async (file: FileItemData) => {
    try {
      await invoke('file_reveal_in_explorer', {
        filePath: file.filePath,
      });
    } catch (err) {
      logger.error('[FileList] 打开路径失败:', err);
      toast({ type: 'error', title: t('file.revealFailed') });
    }
  };

  // 请求移入系统回收站（打开确认对话框）
  const handleDeleteRequest = (file: FileItemData) => {
    setDeleteTarget(file);
  };

  // 确认移入系统回收站
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;

    const deletedFileId = deleteTarget.id;
    setIsDeleting(true);
    try {
      await invoke('file_move_to_system_trash', {
        agentId,
        filePath: deleteTarget.filePath,
      });

      // 刷新当前目录
      await loadDirectory(currentPath);

      // 通知父组件清理预览
      if (onFileDeleted) {
        onFileDeleted(deletedFileId);
      }

      toast({
        type: 'success',
        title: deleteTarget.isDirectory ? t('file.folderMovedToTrash') : t('file.fileMovedToTrash'),
      });
      setDeleteTarget(null);
    } catch (err) {
      logger.error('[FileList] 移入系统回收站失败:', err);
      toast({
        type: 'error',
        title: t('file.moveToTrashFailed'),
        description: t('file.moveToTrashFailedDescription'),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // 取消删除
  const handleCancelDelete = () => {
    setDeleteTarget(null);
  };

  // ==================== 拖拽导入工作区 ====================

  const handleWorkspaceDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isWorkspaceFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    workspaceDragCounterRef.current++;
    setIsDropActive(true);
  }, []);

  const handleWorkspaceDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isWorkspaceFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    workspaceDragCounterRef.current = Math.max(0, workspaceDragCounterRef.current - 1);
    if (workspaceDragCounterRef.current === 0) {
      setIsDropActive(false);
    }
  }, []);

  const handleWorkspaceDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isWorkspaceFileDrag(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleWorkspaceDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      if (!isWorkspaceFileDrag(e.dataTransfer)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      workspaceDragCounterRef.current = 0;
      setIsDropActive(false);

      if (activeImportRef.current) {
        return;
      }

      const operation: WorkspaceImportOperation = {
        controller: new AbortController(),
        phase: 'uploading',
        abortReason: null,
      };
      activeImportRef.current = operation;
      setIsImporting(true);
      setImportProgress(null);
      lastImportProgressAtRef.current = Date.now();
      setIsImportStalled(false);

      const canUpdateOperationUi = () =>
        isMountedRef.current &&
        activeImportRef.current === operation &&
        operation.abortReason !== 'context-change';
      const canShowOperationUi = () =>
        canUpdateOperationUi() && !operation.controller.signal.aborted;

      try {
        const droppedItems = await collectDroppedWorkspaceItems(
          e.dataTransfer,
          operation.controller.signal
        );
        if (droppedItems.length === 0) {
          if (canUpdateOperationUi()) {
            toast({ type: 'warning', title: t('file.importUnsupported') });
          }
          return;
        }

        const totals = getWorkspaceImportTotals(droppedItems);
        if (canUpdateOperationUi()) {
          setImportProgress({
            phase: 'uploading',
            doneEntries: 0,
            totalEntries: totals.totalEntries,
            doneFiles: 0,
            totalFiles: totals.totalFiles,
            bytesDone: 0,
            totalBytes: totals.totalBytes,
            currentPath: '',
            cancelRequested: false,
          });
        }

        const result = await importWorkspaceItems(
          droppedItems,
          {
            hubName: sanitizedHubName,
            agentName: sanitizedAgentName,
            rootDir: rootDir ?? null,
            currentRelativePath: currentPath,
          },
          {
            signal: operation.controller.signal,
            onProgress: (progress) => {
              operation.phase = progress.phase;
              if (!canUpdateOperationUi()) return;
              lastImportProgressAtRef.current = Date.now();
              setIsImportStalled(false);
              setImportProgress({
                ...progress,
                cancelRequested: operation.controller.signal.aborted,
              });
            },
          }
        );

        if (canShowOperationUi()) {
          await loadDirectory(currentPath, true);
          if (canShowOperationUi()) {
            toast({
              type: 'success',
              title: t('file.importSuccess', { count: result.importedEntries }),
            });
          }
        }
      } catch (dropError) {
        if (dropError instanceof WorkspaceImportCancelledError) {
          if (operation.abortReason === 'user' && canUpdateOperationUi()) {
            toast({ type: 'info', title: t('file.importCancelled') });
          }
        } else if (dropError instanceof WorkspaceImportCommitError) {
          logger.error('[FileList] 工作区导入提交未完整成功:', {
            status: dropError.status,
            result: dropError.result,
            originalError: dropError.originalError,
          });
          if (!canUpdateOperationUi()) {
            return;
          }
          if (dropError.status === 'rolledBack') {
            toast({ type: 'error', title: t('file.importRolledBack') });
          } else {
            await loadDirectory(currentPath, true);
            if (!canUpdateOperationUi()) return;
            if (dropError.status === 'partial') {
              toast({
                type: 'error',
                title: t('file.importPartialCommit'),
                description: t('file.importPartialCommitDescription', {
                  count: dropError.result?.topLevelPaths.length ?? 0,
                }),
                duration: 10_000,
              });
            } else {
              toast({
                type: 'warning',
                title: t('file.importUnknownState'),
                description: t('file.importUnknownStateDescription'),
                duration: 10_000,
              });
            }
          }
        } else {
          logger.error('[FileList] 处理拖拽导入失败，已回滚整个批次:', dropError);
          if (canUpdateOperationUi()) {
            toast({ type: 'error', title: t('file.importRolledBack') });
          }
        }
      } finally {
        if (activeImportRef.current === operation) {
          activeImportRef.current = null;
          if (isMountedRef.current) {
            setIsImporting(false);
            setImportProgress(null);
            setIsImportStalled(false);
          }
        }
      }
    },
    [currentPath, loadDirectory, rootDir, sanitizedAgentName, sanitizedHubName, t, toast]
  );

  const handleCancelImport = useCallback(() => {
    const activeImport = activeImportRef.current;
    if (!activeImport || activeImport.phase === 'committing') return;
    activeImport.abortReason = 'user';
    activeImport.controller.abort();
    setImportProgress((current) => (current ? { ...current, cancelRequested: true } : current));
  }, []);

  /**
   * 运行项目预览
   *
   * 收集当前目录中所有可预览的源文件（JSX/TSX/JS/CSS），
   * 读取内容后交给 VitePreviewService 启动预览。
   */
  const handleRunPreview = useCallback(async () => {
    const initialTemplate = inferTemplateFromFileNames(entries.map((entry) => entry.fileName));
    const activeProjectRequestId = startProjectPreview(initialTemplate);
    const projectRequestId = activeProjectRequestId;
    startingPreviewRequestIdRef.current = projectRequestId;
    setProjectStatus('installing');
    setIsStartingPreview(true);

    try {
      // 交付物根目录: {appDataDir}/deliverables/{hubName}/{agentName}/
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const dataDir = await appDataDir();
      const deliverableRoot = await join(
        dataDir,
        'deliverables',
        sanitizedHubName,
        sanitizedAgentName
      );

      // Native 负责 root containment、no-follow 遍历和 list-time 硬预算；
      // 返回路径仍在 renderer 边界规范化后才进入 preview service。
      const sourceTree = await listPreviewSourceTree(deliverableRoot, currentPath);
      if (!usePreviewStore.getState().isProjectRequestCurrent(activeProjectRequestId)) return;
      if (sourceTree.sourcePrefix) {
        logger.debug(
          `[FileList] 检测到 src/ 子目录预览模式，补全路径前缀: "${sourceTree.sourcePrefix}"`
        );
      }

      if (sourceTree.entries.length === 0) {
        throw new PreviewServiceError(
          'entry-not-found',
          undefined,
          undefined,
          sourceTree.omittedEnvironmentFiles > 0
            ? [
                {
                  code: 'environment-files-omitted',
                  count: sourceTree.omittedEnvironmentFiles,
                },
              ]
            : []
        );
      }

      const templateId = inferTemplateFromFileNames(sourceTree.entries.map((entry) => entry.path));
      setProjectTemplate(templateId);

      // 每次 native read 都拿到剩余总预算作为 maxBytes；实际 UTF-8 字节数再次累计。
      const fileContents = await readPreviewSourceFiles(
        sourceTree.projectRoot,
        sourceTree.entries,
        {
          assertActive: () => {
            if (!usePreviewStore.getState().isProjectRequestCurrent(activeProjectRequestId)) {
              throw new PreviewServiceError('cancelled');
            }
          },
        }
      );

      // 尝试读取项目根目录的 package.json，用于合并第三方依赖
      let projectPackageJson: string | undefined;
      if (sourceTree.hasPackageJson) {
        try {
          projectPackageJson = await readPreviewPackageJson(sourceTree.projectRoot);
          if (projectPackageJson !== undefined) {
            logger.debug('[FileList] 已通过安全边界读取项目 package.json');
          }
        } catch (readError) {
          if (
            readError instanceof PreviewServiceError &&
            readError.code !== 'server-start-failed'
          ) {
            throw readError;
          }
          // 普通 IO 失败不阻塞预览启动，仅使用模板基础依赖；安全/预算拒绝必须保留。
          logger.warn('[FileList] 读取 package.json 失败:', readError);
        }
      }

      const { vitePreviewService } = await import('@services/preview');
      if (!usePreviewStore.getState().isProjectRequestCurrent(projectRequestId)) return;
      const startPromise = vitePreviewService.startProject(
        sourceTree.projectRoot,
        'vite_preview',
        templateId,
        fileContents,
        projectPackageJson,
        sourceTree.sourcePrefix,
        projectRequestId,
        true,
        sourceTree.omittedEnvironmentFiles
      );
      markProjectRequestSubmitted(projectRequestId);
      const url = await startPromise;

      if (!usePreviewStore.getState().isProjectRequestCurrent(projectRequestId)) return;
      setProjectUrl(url, templateId);
      logger.debug('[FileList] Project preview started:', url);
    } catch (error) {
      if (isPreviewCancellation(error)) return;
      if (!usePreviewStore.getState().isProjectRequestCurrent(projectRequestId)) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[FileList] Project preview failed:', errorMessage);
      setProjectStatus('error', errorMessage);
    } finally {
      if (startingPreviewRequestIdRef.current === projectRequestId) {
        startingPreviewRequestIdRef.current = null;
        setIsStartingPreview(false);
      }
    }
  }, [
    currentPath,
    entries,
    sanitizedHubName,
    sanitizedAgentName,
    startProjectPreview,
    markProjectRequestSubmitted,
    setProjectStatus,
    setProjectTemplate,
    setProjectUrl,
  ]);

  // 加载状态
  if (isLoading && entries.length === 0) {
    return (
      <div className={styles.loading}>
        <Loader2 className={styles.spinner} size={20} />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={styles.error}>
        <span>{error}</span>
        <button onClick={() => loadDirectory(currentPath)} className={styles.retryBtn}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const importProgressPercent = importProgress
    ? getWorkspaceImportProgressPercent(importProgress)
    : 0;

  return (
    <div
      className={cx(styles.fileList, isDropActive && styles.fileListDragActive)}
      onDragEnter={handleWorkspaceDragEnter}
      onDragLeave={handleWorkspaceDragLeave}
      onDragOver={handleWorkspaceDragOver}
      onDrop={handleWorkspaceDrop}
    >
      {/* 导航栏：后退/前进按钮 + 面包屑 + 刷新 */}
      <div className={styles.header}>
        <div className={styles.navButtons}>
          <Tooltip content={t('common.back')}>
            <button
              className={styles.navBtn}
              onClick={goBack}
              disabled={!canGoBack}
              aria-label={t('common.back')}
            >
              <ChevronLeft size={14} />
            </button>
          </Tooltip>
          <Tooltip content={t('common.forward')}>
            <button
              className={styles.navBtn}
              onClick={goForward}
              disabled={!canGoForward}
              aria-label={t('common.forward')}
            >
              <ChevronRight size={14} />
            </button>
          </Tooltip>
        </div>

        <div className={styles.breadcrumb}>
          <Tooltip content={t('file.rootDirectory')}>
            <button
              className={cx(styles.breadcrumbItem, currentPath === '' && styles.breadcrumbActive)}
              onClick={() => navigateToBreadcrumb(-1)}
              aria-label={t('file.rootDirectory')}
            >
              <Home size={12} />
            </button>
          </Tooltip>
          {breadcrumbSegments.map((segment, index) => (
            <span key={index} className={styles.breadcrumbGroup}>
              <BreadcrumbSep size={10} className={styles.breadcrumbSeparator} />
              <Tooltip content={segment}>
                <button
                  className={cx(
                    styles.breadcrumbItem,
                    index === breadcrumbSegments.length - 1 && styles.breadcrumbActive
                  )}
                  onClick={() => navigateToBreadcrumb(index)}
                >
                  {segment}
                </button>
              </Tooltip>
            </span>
          ))}
        </div>

        <Tooltip content={t('file.refreshList')}>
          <button
            className={styles.refreshBtn}
            onClick={() => loadDirectory(currentPath)}
            disabled={isLoading}
            aria-label={t('file.refreshList')}
          >
            <RefreshCw size={14} className={isLoading ? styles.spinning : ''} />
          </button>
        </Tooltip>

        {/* run project preview button: only shown in deliverables mode (not project dir)
         * and when current dir has previewable files */}
        {!rootDir && entries.some((e) => !e.isDirectory && isPreviewableFile(e.fileName)) && (
          <Tooltip content={t('file.projectPreview')}>
            <button
              className={styles.previewBtn}
              onClick={handleRunPreview}
              disabled={isStartingPreview}
              aria-label={t('file.projectPreview')}
            >
              <Play size={14} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* 文件列表 */}
      {entries.length === 0 ? (
        <div className={styles.emptyInline}>
          <FolderOpen size={20} className={styles.emptyIcon} />
          <span className={styles.emptyText}>
            {currentPath ? t('file.emptyFolder') : t('file.noFiles')}
          </span>
        </div>
      ) : (
        <div className={styles.list}>
          {entries.map((item) => (
            <FileItem
              key={item.id}
              file={item}
              isSelected={item.id === selectedFileId}
              onClick={() => handleItemClick(item)}
              onExport={() => handleExport(item)}
              onRevealInExplorer={() => handleRevealInExplorer(item)}
              onDelete={() => handleDeleteRequest(item)}
            />
          ))}
        </div>
      )}

      {(isDropActive || isImporting) && (
        <div className={cx(styles.importOverlay, isImporting && styles.importOverlayInteractive)}>
          <div className={styles.importOverlayIcon}>
            {isImporting ? (
              <Loader2 size={22} className={styles.spinner} />
            ) : (
              <UploadCloud size={24} />
            )}
          </div>
          <span className={styles.importOverlayTitle}>
            {isImporting
              ? importProgress?.phase === 'committing'
                ? t('file.importCommitting')
                : t('file.importing')
              : t('file.dropToImport')}
          </span>
          <span className={styles.importOverlayHint}>
            {isImporting && importProgress
              ? importProgress.phase === 'committing'
                ? t('file.importCommitHint')
                : importProgress.totalFiles > 0
                  ? t('file.importProgressBytes', {
                      done: importProgress.doneFiles,
                      total: importProgress.totalFiles,
                      bytesDone: formatImportBytes(importProgress.bytesDone),
                      totalBytes: formatImportBytes(importProgress.totalBytes),
                    })
                  : t('file.importProgressItems', {
                      done: importProgress.doneEntries,
                      total: importProgress.totalEntries,
                    })
              : t('file.dropImportHint')}
          </span>
          {isImporting && importProgress?.phase !== 'committing' && importProgress?.currentPath && (
            <span className={styles.importCurrentPath} title={importProgress.currentPath}>
              {importProgress.currentPath}
            </span>
          )}
          {isImporting && isImportStalled && importProgress?.phase !== 'committing' && (
            <span className={styles.importStalledHint}>{t('file.importStalled')}</span>
          )}
          {isImporting && importProgress && (
            <div
              className={styles.importProgressTrack}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={importProgressPercent}
            >
              <div
                className={styles.importProgressFill}
                style={{
                  width: `${importProgressPercent}%`,
                }}
              />
            </div>
          )}
          {isImporting && (
            <button
              type="button"
              className={styles.importCancelBtn}
              onClick={handleCancelImport}
              disabled={
                importProgress?.phase === 'committing' || importProgress?.cancelRequested === true
              }
            >
              {importProgress?.phase === 'committing'
                ? t('file.importCommitting')
                : importProgress?.cancelRequested
                  ? t('file.importCancelling')
                  : t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {/* 移入系统回收站确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title={t('file.moveToTrashTitle')}
        description={
          deleteTarget?.isDirectory
            ? t('file.moveFolderToTrashConfirm', { name: deleteTarget.fileName })
            : t('file.moveFileToTrashConfirm', { name: deleteTarget?.fileName ?? '' })
        }
        confirmText={t('file.moveToTrashConfirm')}
        cancelText={t('common.cancel')}
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  );
}
