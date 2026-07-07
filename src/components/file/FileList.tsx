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
import { FolderOpen, RefreshCw, Loader2, ChevronLeft, ChevronRight, ChevronRight as BreadcrumbSep, Home, Play, UploadCloud } from 'lucide-react';
import { FileItem, type FileItemData } from './FileItem';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { usePreviewStore } from '@stores/previewStore';
import styles from './FileList.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { isPreviewableFile, inferTemplateFromFileNames } from '@services/preview';
import type { ProjectFile } from '@services/preview/types';
import { useI18n } from '@/i18n';
import { getMissingDirectoryRecoveryPath } from './FileListPathRecovery';

const logger = getLogger('FileList');

/** 后台静默刷新的防抖间隔（ms）：合并短时间内的批量文件写入事件 */
const SILENT_REFRESH_DEBOUNCE_MS = 300;

/** 拖入工作区时 ArrayBuffer 转 base64 的分块大小，避免一次性展开大数组 */
const BASE64_CHUNK_SIZE = 0x8000;

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
interface DroppedWorkspaceItem {
    relativePath: string;
    file: File | null;
    isDirectory: boolean;
}

/** 后端工作区导入结果 */
interface WorkspaceImportResult {
    filePath: string;
    relativePath: string;
    isDirectory: boolean;
}

interface ImportProgress {
    done: number;
    total: number;
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
    return name
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        || 'unnamed';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
        const chunk = bytes.subarray(index, index + BASE64_CHUNK_SIZE);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
    });
}

async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    const entries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];

    do {
        batch = await readDirectoryBatch(reader);
        entries.push(...batch);
    } while (batch.length > 0);

    return entries;
}

async function collectFileSystemEntryItems(
    entry: FileSystemEntry,
    parentPath = '',
): Promise<DroppedWorkspaceItem[]> {
    const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

    if (entry.isFile) {
        const file = await readFileEntry(entry as FileSystemFileEntry);
        return [{ relativePath, file, isDirectory: false }];
    }

    if (entry.isDirectory) {
        const directory = entry as FileSystemDirectoryEntry;
        const reader = directory.createReader();
        const childEntries = await readAllDirectoryEntries(reader);
        const childItems = await Promise.all(
            childEntries.map(childEntry => collectFileSystemEntryItems(childEntry, relativePath)),
        );
        return [
            { relativePath, file: null, isDirectory: true },
            ...childItems.flat(),
        ];
    }

    return [];
}

async function collectDroppedWorkspaceItems(dataTransfer: DataTransfer): Promise<DroppedWorkspaceItem[]> {
    const entryItems = Array.from(dataTransfer.items)
        .filter(item => item.kind === 'file')
        .map(item => item.webkitGetAsEntry())
        .filter((entry): entry is FileSystemEntry => entry !== null);

    if (entryItems.length > 0) {
        const collected = await Promise.all(
            entryItems.map(entry => collectFileSystemEntryItems(entry)),
        );
        return collected.flat();
    }

    return Array.from(dataTransfer.files).map(file => ({
        relativePath: file.name,
        file,
        isDirectory: false,
    }));
}

function isWorkspaceFileDrag(dataTransfer: DataTransfer): boolean {
    return dataTransfer.types.includes('Files')
        && !dataTransfer.types.includes('application/x-attachment-reorder');
}


export function FileList({ agentId, hubName, agentName, rootDir, selectedFileId, onSelectFile, onFileDeleted }: FileListProps) {
    const [entries, setEntries] = useState<FileItemData[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<FileItemData | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isDropActive, setIsDropActive] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
    const workspaceDragCounterRef = useRef(0);
    const { toast } = useToast();
    const { t } = useI18n();
    const { startProjectPreview, setProjectStatus, setProjectUrl } = usePreviewStore();
    const [isStartingPreview, setIsStartingPreview] = useState(false);

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
        () => currentPath ? currentPath.split('/').filter(Boolean) : [],
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
    const loadDirectory = useCallback(async (path: string, silent = false) => {
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
            const newEntries = result.map(e => {
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
            setEntries(prev => {
                const prevIds = prev.map(e => e.id).join(',');
                const newIds = newEntries.map(e => e.id).join(',');
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
    }, [agentId, sanitizedHubName, sanitizedAgentName, rootDir, t]);

    // Agent 切换或 rootDir 变化时重置导航状态并加载根目录
    useEffect(() => {
        setCurrentPath('');
        setHistoryStack([]);
        setForwardStack([]);
        void loadDirectory('');
    }, [agentId, hubName, agentName, rootDir]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // 使用 aborted 标志处理竞态：当 agentId 切换时，
        // setupListener 是 async 的，如果旧的 await listen() 还未返回，
        // cleanup 执行时 unlisten 仍为 undefined，导致旧 listener 泄漏。
        // aborted 标志保证即使 listen() 在清理后才完成，也不会实际订阅事件。
        let aborted = false;
        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            const { listen } = await import('@tauri-apps/api/event');

            // 如果在 await 期间 agentId 已经变化（cleanup 已被调用），放弃注册
            if (aborted) return;

            unlisten = await listen<{ agentId: string; filePath: string }>('file:deliverable_created', (event) => {
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
                silentRefreshTimerRef.current = setTimeout(() => {
                    silentRefreshTimerRef.current = null;
                    // silent=true：不触发 loading 状态，内容相等时不重渲染
                    void loadDirectoryRef.current(currentPathRef.current, true);
                }, SILENT_REFRESH_DEBOUNCE_MS);
            });
        };

        void setupListener();

        return () => {
            aborted = true;
            // 清理防抖定时器，防止 Agent 切换后定时器仍然触发旧的刷新
            if (silentRefreshTimerRef.current !== null) {
                clearTimeout(silentRefreshTimerRef.current);
                silentRefreshTimerRef.current = null;
            }
            if (unlisten) {
                unlisten();
            }
        };
    }, [agentId]);

    // ==================== 导航操作 ====================

    /** 进入子目录 */
    const navigateToFolder = useCallback((relativePath: string) => {
        setHistoryStack(prev => [...prev, currentPath]);
        setForwardStack([]); // 进入新目录时清空前进栈
        setCurrentPath(relativePath);
    }, [currentPath]);

    /** 后退 */
    const goBack = useCallback(() => {
        if (historyStack.length === 0) return;
        const prevPath = historyStack[historyStack.length - 1] ?? '';
        setHistoryStack(prev => prev.slice(0, -1));
        setForwardStack(prev => [...prev, currentPath]);
        setCurrentPath(prevPath);
    }, [historyStack, currentPath]);

    /** 前进 */
    const goForward = useCallback(() => {
        if (forwardStack.length === 0) return;
        const nextPath = forwardStack[forwardStack.length - 1] ?? '';
        setForwardStack(prev => prev.slice(0, -1));
        setHistoryStack(prev => [...prev, currentPath]);
        setCurrentPath(nextPath);
    }, [forwardStack, currentPath]);

    /** 跳转到面包屑指定层级 */
    const navigateToBreadcrumb = useCallback((segmentIndex: number) => {
        // segmentIndex = -1 表示根目录
        const targetPath = segmentIndex < 0
            ? ''
            : breadcrumbSegments.slice(0, segmentIndex + 1).join('/');

        if (targetPath !== currentPath) {
            setHistoryStack(prev => [...prev, currentPath]);
            setForwardStack([]);
            setCurrentPath(targetPath);
        }
    }, [breadcrumbSegments, currentPath]);

    // ==================== 文件操作 ====================

    /** 点击条目：文件夹 → 进入，文件 → 选中预览 */
    const handleItemClick = useCallback((item: FileItemData) => {
        if (item.isDirectory) {
            // 通过当前路径 + 文件夹名拼接相对路径
            const folderRelativePath = currentPath
                ? `${currentPath}/${item.fileName}`
                : item.fileName;
            navigateToFolder(folderRelativePath);
        } else {
            onSelectFile(item);
        }
    }, [currentPath, navigateToFolder, onSelectFile]);

    // 导出文件（二进制安全：使用 copyFile 而非文本读写，支持图片等非 UTF-8 文件）
    const handleExport = async (file: FileItemData) => {
        try {
            const savePath = await save({
                defaultPath: file.fileName,
                filters: [
                    { name: t('file.allFiles'), extensions: ['*'] },
                ],
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

    // 请求删除文件（打开确认对话框）
    const handleDeleteRequest = (file: FileItemData) => {
        setDeleteTarget(file);
    };

    // 确认删除
    const handleConfirmDelete = async () => {
        if (!deleteTarget) return;

        const deletedFileId = deleteTarget.id;
        setIsDeleting(true);
        try {
            await invoke('file_delete', {
                filePath: deleteTarget.filePath,
            });

            // 刷新当前目录
            await loadDirectory(currentPath);

            // 通知父组件清理预览
            if (onFileDeleted) {
                onFileDeleted(deletedFileId);
            }

            toast({ type: 'success', title: deleteTarget.isDirectory ? t('file.folderDeleted') : t('file.fileDeleted') });
            setDeleteTarget(null);
        } catch (err) {
            logger.error('[FileList] 删除文件失败:', err);
            toast({ type: 'error', title: t('file.deleteFailed') });
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

    const handleWorkspaceDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        if (!isWorkspaceFileDrag(e.dataTransfer)) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        workspaceDragCounterRef.current = 0;
        setIsDropActive(false);

        if (isImporting) {
            return;
        }

        setIsImporting(true);
        setImportProgress(null);

        try {
            const droppedItems = await collectDroppedWorkspaceItems(e.dataTransfer);
            if (droppedItems.length === 0) {
                toast({ type: 'warning', title: t('file.importUnsupported') });
                return;
            }

            let importedCount = 0;
            let failedCount = 0;
            setImportProgress({ done: 0, total: droppedItems.length });

            for (const item of droppedItems) {
                try {
                    const base64Data = item.file
                        ? arrayBufferToBase64(await item.file.arrayBuffer())
                        : null;

                    await invoke<WorkspaceImportResult>('file_import_to_workspace', {
                        hubName: sanitizedHubName,
                        agentName: sanitizedAgentName,
                        rootDir: rootDir ?? null,
                        currentRelativePath: currentPath,
                        itemRelativePath: item.relativePath,
                        isDirectory: item.isDirectory,
                        base64Data,
                    });

                    importedCount++;
                } catch (itemError) {
                    failedCount++;
                    logger.error('[FileList] 导入拖拽项目失败:', item.relativePath, itemError);
                } finally {
                    setImportProgress({
                        done: importedCount + failedCount,
                        total: droppedItems.length,
                    });
                }
            }

            await loadDirectory(currentPath, true);

            if (importedCount > 0 && failedCount === 0) {
                toast({ type: 'success', title: t('file.importSuccess', { count: importedCount }) });
            } else if (importedCount > 0) {
                toast({
                    type: 'warning',
                    title: t('file.importPartial', { success: importedCount, failed: failedCount }),
                });
            } else {
                toast({ type: 'error', title: t('file.importFailed') });
            }
        } catch (dropError) {
            logger.error('[FileList] 处理拖拽导入失败:', dropError);
            toast({ type: 'error', title: t('file.importFailed') });
        } finally {
            setIsImporting(false);
            setImportProgress(null);
        }
    }, [
        currentPath,
        isImporting,
        loadDirectory,
        rootDir,
        sanitizedAgentName,
        sanitizedHubName,
        t,
        toast,
    ]);

    /**
     * 运行项目预览
     *
     * 收集当前目录中所有可预览的源文件（JSX/TSX/JS/CSS），
     * 读取内容后交给 VitePreviewService 启动预览。
     */
    const handleRunPreview = useCallback(async () => {
        // 递归收集当前目录及子目录下所有可预览文件
        // 保留相对路径结构（如 src/components/Sidebar.vue → src/components/Sidebar.vue）
        async function collectPreviewableFiles(
            dirPath: string,
            relativeTo: string,
        ): Promise<{ filePath: string; relativePath: string; fileName: string }[]> {
            const { readDir } = await import('@tauri-apps/plugin-fs');
            const { join } = await import('@tauri-apps/api/path');
            const dirEntries = await readDir(dirPath);

            const files: { filePath: string; relativePath: string; fileName: string }[] = [];

            // 需要跳过的目录：避免收集构建产物和预览目录
            const SKIP_DIRS = new Set(['vite_preview', 'node_modules', '.git', 'dist', 'build']);

            for (const entry of dirEntries) {
                if (entry.isDirectory && SKIP_DIRS.has(entry.name)) continue;

                const entryPath = await join(dirPath, entry.name);

                if (entry.isDirectory) {
                    const subFiles = await collectPreviewableFiles(
                        entryPath,
                        `${relativeTo}${entry.name}/`,
                    );
                    files.push(...subFiles);
                } else if (isPreviewableFile(entry.name)) {
                    files.push({
                        filePath: entryPath,
                        relativePath: `${relativeTo}${entry.name}`,
                        fileName: entry.name,
                    });
                }
            }

            return files;
        }

        setIsStartingPreview(true);

        try {
            // 将相对路径 currentPath（如 "src"）转为绝对路径
            // 交付物根目录: {appDataDir}/deliverables/{hubName}/{agentName}/
            const { appDataDir } = await import('@tauri-apps/api/path');
            const { join } = await import('@tauri-apps/api/path');
            const dataDir = await appDataDir();
            const deliverableRoot = await join(dataDir, 'deliverables', sanitizedHubName, sanitizedAgentName);
            const absoluteCurrentDir = currentPath
                ? await join(deliverableRoot, currentPath)
                : deliverableRoot;

            // 检测项目根目录：从当前目录向上查找 package.json
            // 当用户从 src/ 子目录触发时，需要回到项目根以正确收集所有文件
            const { exists } = await import('@tauri-apps/plugin-fs');
            let projectRoot = absoluteCurrentDir;
            let searchDir = absoluteCurrentDir;
            let foundPackageJson = false;
            while (searchDir.length >= deliverableRoot.length) {
                const pkgPath = await join(searchDir, 'package.json');
                if (await exists(pkgPath)) {
                    projectRoot = searchDir;
                    foundPackageJson = true;
                    break;
                }
                // 已到达 deliverable 根目录，停止向上查找
                if (searchDir === deliverableRoot) break;
                const { dirname } = await import('@tauri-apps/api/path');
                searchDir = await dirname(searchDir);
            }

            if (projectRoot !== absoluteCurrentDir) {
                logger.debug(`[FileList] 检测到项目根目录: ${projectRoot}（当前浏览: ${absoluteCurrentDir}）`);
            }

            // 计算文件收集时的路径前缀
            // 当未找到 package.json 且 projectRoot 的末段名称恰好是 "src" 时，
            // 补全 "src/" 前缀，使文件被写到正确路径（vite_preview/src/App.vue）。
            // 对于 website/、pages/ 等独立网站子目录，projectRoot 本身就是 vite 项目根，
            // 文件应写在 vite_preview/ 根目录下，无需任何前缀。
            // 只有 src/ 这一约定俗成的组件子目录需要补全，以匹配模板的 src/main.js import 路径。
            const lastPathSegment = projectRoot.split(/[\\/]/).pop() ?? '';
            const sourcePrefix = (!foundPackageJson && projectRoot !== deliverableRoot && lastPathSegment === 'src')
                ? 'src/'
                : '';

            if (sourcePrefix) {
                logger.debug(`[FileList] 检测到 src/ 子目录预览模式，补全路径前缀: "${sourcePrefix}"`);
            }

            // 从项目根目录开始递归收集
            const allPreviewableFiles = await collectPreviewableFiles(projectRoot, sourcePrefix);

            if (allPreviewableFiles.length === 0) {
                logger.warn('[FileList] 未找到可预览文件');
                return;
            }

            const templateId = inferTemplateFromFileNames(
                allPreviewableFiles.map(f => f.fileName)
            );
            startProjectPreview(templateId);
            setProjectStatus('installing');

            // 并行读取所有文件内容，保留原始相对路径
            // 项目结构已包含 src/ 前缀（如 src/App.tsx），无需再添加
            const fileContents = await Promise.all(
                allPreviewableFiles.map(async (file): Promise<ProjectFile> => {
                    const content = await invoke<string>('file_read_content', {
                        filePath: file.filePath,
                    });
                    return {
                        path: file.relativePath,
                        content,
                    };
                })
            );

            // 尝试读取项目根目录的 package.json，用于合并第三方依赖
            let projectPackageJson: string | undefined;
            try {
                const pkgPath = await join(projectRoot, 'package.json');
                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                if (await exists(pkgPath)) {
                    projectPackageJson = await readTextFile(pkgPath);
                    logger.debug('[FileList] 已读取项目 package.json');
                }
            } catch (readError) {
                // 读取失败不阻塞预览启动，仅使用模板基础依赖
                logger.warn('[FileList] 读取 package.json 失败:', readError);
            }

            const { vitePreviewService } = await import('@services/preview');
            const url = await vitePreviewService.startProject(
                projectRoot,
                'vite_preview',
                templateId,
                fileContents,
                projectPackageJson,
            );

            setProjectUrl(url, templateId);
            logger.debug('[FileList] Project preview started:', url);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('[FileList] Project preview failed:', errorMessage);
            setProjectStatus('error', errorMessage);
        } finally {
            setIsStartingPreview(false);
        }
    }, [currentPath, sanitizedHubName, sanitizedAgentName, startProjectPreview, setProjectStatus, setProjectUrl]);

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
                                    className={cx(styles.breadcrumbItem, index === breadcrumbSegments.length - 1 && styles.breadcrumbActive)}
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
                {!rootDir && entries.some(e => !e.isDirectory && isPreviewableFile(e.fileName)) && (
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
                <div className={styles.importOverlay}>
                    <div className={styles.importOverlayIcon}>
                        {isImporting ? (
                            <Loader2 size={22} className={styles.spinner} />
                        ) : (
                            <UploadCloud size={24} />
                        )}
                    </div>
                    <span className={styles.importOverlayTitle}>
                        {isImporting ? t('file.importing') : t('file.dropToImport')}
                    </span>
                    <span className={styles.importOverlayHint}>
                        {isImporting && importProgress
                            ? t('file.importProgress', { done: importProgress.done, total: importProgress.total })
                            : t('file.dropImportHint')
                        }
                    </span>
                </div>
            )}

            {/* 删除确认对话框 */}
            <ConfirmDialog
                open={deleteTarget !== null}
                onClose={handleCancelDelete}
                onConfirm={handleConfirmDelete}
                title={t('agent.context.deleteTitle')}
                description={deleteTarget?.isDirectory
                    ? t('file.deleteFolderConfirm', { name: deleteTarget.fileName })
                    : t('file.deleteFileConfirm', { name: deleteTarget?.fileName ?? '' })
                }
                confirmText={t('common.delete')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
