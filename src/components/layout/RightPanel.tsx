import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '@stores/uiStore';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useDiffStore } from '@stores/diffStore';
import { useAttachmentViewerStore } from '@stores/attachmentViewerStore';
import { usePreviewStore } from '@stores/previewStore';
import styles from './RightPanel.module.css';
import { FullFileDiffViewer, SnapshotHistory } from '../diff';
import { FileList, FilePreview, type FileItemData } from '../file';
import { LivePreviewPanel } from '../file/LivePreviewPanel';
import { ResizeHandle } from '../ui/ResizeHandle';
import { Tooltip } from '@components/ui/Tooltip';
import { Undo2, Redo2, Maximize2, Minimize2 } from 'lucide-react';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

const logger = getLogger('RightPanel');

/**
 * RightPanel 右栏文件区
 *
 * 支持两种模式：
 * - 普通模式：显示文件列表和预览区域
 * - Diff 模式：显示修改列表和审批界面
 *
 */
export function RightPanel() {
    const { t } = useI18n();
    const toggleRightPanel = useUIStore((state) => state.toggleRightPanel);

    // 获取当前 Agent 和 Hub ID
    const currentAgentId = useAgentStore((state) => state.currentAgentId);
    const currentHubId = useHubStore((state) => state.currentHubId);
    const agents = useAgentStore((state) => state.agents);
    const hubs = useHubStore((state) => state.hubs);

    // 获取当前活动视图（Hub 或 Agent）
    // 通过 useUIStore 或检测 URL/路由来判断，这里简化处理：优先使用 Agent，其次 Hub
    // 更好的方案是根据实际活动窗口来判断，暂时使用 Agent 优先
    const contextId = currentAgentId ?? currentHubId ?? '';

    // 获取当前 Agent 和 Hub 信息（用于交付物目录）
    const currentAgent = useMemo(() => agents.find(a => a.id === currentAgentId), [agents, currentAgentId]);
    const currentHub = useMemo(() => hubs.find(h => h.id === currentAgent?.hubId), [hubs, currentAgent?.hubId]);
    const hubName = currentHub?.name ?? 'default';
    const agentName = currentAgent?.name ?? 'unknown';

    // Preview Store 状态
    const isPreviewActive = usePreviewStore((state) => state.isPreviewActive);
    const closePreview = usePreviewStore((state) => state.closePreview);

    // 切换 Agent 时自动关闭 Live Preview（预览内容属于前一个 Agent 上下文）
    useEffect(() => {
        if (isPreviewActive) {
            closePreview();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 contextId 变化时触发，不依赖 isPreviewActive
    }, [contextId]);

    // Diff Store 操作
    const loadPersistedDiffs = useDiffStore((state) => state.loadPersistedDiffs);

    // 切换 Agent 时从数据库加载持久化的 Diff 记录
    useEffect(() => {
        if (contextId) {
            void loadPersistedDiffs(contextId);
        }
    }, [contextId, loadPersistedDiffs]);

    // Diff Store 状态（按 contextId 隔离）
    const diffByContext = useDiffStore((state) => state.diffByContext);
    const isSnapshotPanelOpen = useDiffStore((state) => state.isSnapshotPanelOpen);

    // 获取当前上下文的 Diff 状态
    const diffState = useMemo(() => {
        if (!contextId) {
            // 无上下文时返回空状态
            return {
                mode: 'normal' as const,
                documentId: null,
                content: '',
                originalContent: '',
                fileName: '',
                pendingModifications: [],
                originalXml: '',
                snapshots: [],
                undoStack: [],
                redoStack: [],
                isLoading: false,
                error: null,
                fileEntries: new Map(),
                activeFileId: null,
            };
        }
        return diffByContext.get(contextId) ?? {
            mode: 'normal' as const,
            documentId: null,
            content: '',
            originalContent: '',
            fileName: '',
            pendingModifications: [],
            originalXml: '',
            snapshots: [],
            undoStack: [],
            redoStack: [],
            isLoading: false,
            error: null,
            fileEntries: new Map(),
            activeFileId: null,
            activeSnapshotId: null,
        };
    }, [contextId, diffByContext]);

    const mode = diffState.mode;
    const fileName = diffState.fileName;
    const pendingModifications = diffState.pendingModifications;
    const currentContent = diffState.content;
    const originalContent = diffState.originalContent;
    const snapshots = diffState.snapshots;
    const isLoading = diffState.isLoading;
    const pendingCount = useMemo(() =>
        pendingModifications.filter(m => m.status === 'pending').length,
        [pendingModifications]
    );

    // Diff Store Actions（传递 contextId）
    const setMode = useDiffStore((state) => state.setMode);
    const acceptModification = useDiffStore((state) => state.acceptModification);
    const rejectModification = useDiffStore((state) => state.rejectModification);
    const acceptAll = useDiffStore((state) => state.acceptAll);
    const rejectAll = useDiffStore((state) => state.rejectAll);
    const toggleSnapshotPanel = useDiffStore((state) => state.toggleSnapshotPanel);
    const rollback = useDiffStore((state) => state.rollback);
    const deleteSnapshot = useDiffStore((state) => state.deleteSnapshot);
    const undo = useDiffStore((state) => state.undo);
    const redo = useDiffStore((state) => state.redo);
    const canUndo = useDiffStore((state) => state.canUndo);
    const canRedo = useDiffStore((state) => state.canRedo);
    const selectFile = useDiffStore((state) => state.selectFile);
    const getFileList = useDiffStore((state) => state.getFileList);
    const hasCompletedDiff = useDiffStore((state) => state.getCompletedDiffFiles);

    // 审批已完成的文件列表（normal 模式下，为每个文件提供独立的历史版本入口）
    // 空数组 = 没有可查历史的文件，不展示任何提示条
    const completedDiffFiles = contextId ? hasCompletedDiff(contextId) : [];

    // ==================== 文件管理状态 ====================
    const [selectedFile, setSelectedFile] = useState<FileItemData | null>(null);
    const [previewContent, setPreviewContent] = useState<string>('');
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    // 文件预览全屏状态
    const [isFilePreviewFullscreen, setIsFilePreviewFullscreen] = useState(false);

    // 全屏切换
    const handleToggleFilePreviewFullscreen = useCallback(() => {
        setIsFilePreviewFullscreen((prev) => !prev);
    }, []);

    // Escape 键退出全屏
    useEffect(() => {
        if (!isFilePreviewFullscreen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsFilePreviewFullscreen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFilePreviewFullscreen]);

    // ==================== 拖拽分隔条状态 ====================
    /** 文件列表区域高度（px），默认 200px */
    const [fileListHeight, setFileListHeight] = useState(200);
    /** 拖拽中标记：用于 RightPanel 容器添加 no-select 样式 */
    const [isResizing, setIsResizing] = useState(false);

    const FILE_LIST_MIN_HEIGHT = 80;
    const FILE_LIST_MAX_HEIGHT = 500;

    const handleFileListResize = useCallback((delta: number) => {
        setFileListHeight(prev => {
            const next = prev + delta;
            return Math.max(FILE_LIST_MIN_HEIGHT, Math.min(FILE_LIST_MAX_HEIGHT, next));
        });
    }, []);

    // 加载文件预览内容
    const loadFilePreview = useCallback(async (file: FileItemData) => {
        setSelectedFile(file);

        // 二进制文件（图片/视频/音频等）不通过 file_read_content 读取，交由 FilePreview 通过路径渲染
        const binaryExtensions = [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
            'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'rmvb', 'ts',
            'mp3', 'wav', 'aac', 'flac', 'm4a', 'wma',
            'pdf',
        ];
        const ext = file.fileName.split('.').pop()?.toLowerCase() ?? '';
        if (binaryExtensions.includes(ext)) {
            setPreviewContent('');
            setIsPreviewLoading(false);
            return;
        }

        setIsPreviewLoading(true);
        try {
            const content = await invoke<string>('file_read_content', {
                filePath: file.filePath,
            });
            setPreviewContent(content);
        } catch (err) {
            logger.error('[RightPanel] 加载文件预览失败:', err);
            setPreviewContent(t('layout.loadFileContentFailed'));
        } finally {
            setIsPreviewLoading(false);
        }
    }, [t]);

    // ==================== 附件文档预览 ====================
    const {
        previewDocument,
        clearDocumentPreview,
        attachmentsByContext,
        previewByContext,
        setDocumentPreview,
        clearContextAttachments,
        clearPreviewSignal
    } = useAttachmentViewerStore();

    // 获取当前上下文的附件列表
    const currentAttachments = useMemo(
        () => contextId ? (attachmentsByContext[contextId] ?? []) : [],
        [attachmentsByContext, contextId]
    );

    // 追踪上一次的上下文 ID，用于切换时保存预览状态
    const prevContextIdRef = useRef<string | null>(null);
    const selectedFileRef = useRef(selectedFile);
    const attachmentsByContextRef = useRef(attachmentsByContext);
    const previewByContextRef = useRef(previewByContext);
    const setDocumentPreviewRef = useRef(setDocumentPreview);
    selectedFileRef.current = selectedFile;
    attachmentsByContextRef.current = attachmentsByContext;
    previewByContextRef.current = previewByContext;
    setDocumentPreviewRef.current = setDocumentPreview;

    // 切换 Agent 时：保存当前预览状态，恢复目标 Agent 的预览状态
    useEffect(() => {
        // 保存当前预览状态到上一个上下文
        const prevContextId = prevContextIdRef.current;
        const currentSelectedFile = selectedFileRef.current;
        if (prevContextId && currentSelectedFile) {
            useAttachmentViewerStore.setState((state) => ({
                previewByContext: {
                    ...state.previewByContext,
                    [prevContextId]: currentSelectedFile.id,
                },
            }));
        }

        // 恢复目标上下文的预览状态
        if (contextId) {
            const savedPreviewId = previewByContextRef.current[contextId];
            const attachments = attachmentsByContextRef.current[contextId] ?? [];
            const savedAttachment = savedPreviewId ? attachments.find(a => a.id === savedPreviewId) : null;

            if (savedAttachment) {
                // 恢复之前保存的预览
                setDocumentPreviewRef.current(savedAttachment);
            } else {
                // 没有保存的预览，清空状态
                setSelectedFile(null);
                setPreviewContent('');
            }
        } else {
            setSelectedFile(null);
            setPreviewContent('');
        }

        prevContextIdRef.current = contextId;
    }, [contextId]); // 注意：不依赖 attachmentsByContext 和 previewByContext，避免循环

    // 监听清空预览信号：当撤销消息等操作时清空本地预览状态
    useEffect(() => {
        if (clearPreviewSignal > 0) {
            setSelectedFile(null);
            setPreviewContent('');
            logger.debug('[RightPanel] 收到清空预览信号，已清理本地预览状态');
        }
    }, [clearPreviewSignal]);

    // 监听附件文档预览请求
    useEffect(() => {
        if (previewDocument) {
            // 有附件文档需要预览时
            const loadAttachmentPreview = async () => {
                setIsPreviewLoading(true);
                try {
                    // 如果附件已有解析内容，直接使用
                    if (previewDocument.parsedContent) {
                        setPreviewContent(previewDocument.parsedContent);
                        setSelectedFile({
                            id: previewDocument.id,
                            fileName: previewDocument.fileName,
                            filePath: previewDocument.localPath,
                            size: previewDocument.size,
                            createdAt: previewDocument.createdAt,
                        });
                    } else {
                        // 否则从本地路径读取
                        const content = await invoke<string>('file_read_content', {
                            filePath: previewDocument.localPath,
                        });
                        setPreviewContent(content);
                        setSelectedFile({
                            id: previewDocument.id,
                            fileName: previewDocument.fileName,
                            filePath: previewDocument.localPath,
                            size: previewDocument.size,
                            createdAt: previewDocument.createdAt,
                        });
                    }
                    // 切换到普通模式以显示预览
                    if (contextId && mode === 'diff') {
                        setMode(contextId, 'normal');
                    }
                } catch (err) {
                    logger.error('[RightPanel] 加载附件预览失败:', err);
                    setPreviewContent(t('layout.loadAttachmentContentFailed'));
                } finally {
                    setIsPreviewLoading(false);
                    // 清除预览请求状态，避免重复加载
                    clearDocumentPreview();
                }
            };
            void loadAttachmentPreview();
        }
    }, [previewDocument, clearDocumentPreview, contextId, mode, setMode, t]);

    // 监听附件列表变化：当当前预览的附件被单独移除时处理
    // 注意：附件列表变空时不清空预览，让发送后预览仍然显示
    const prevAttachmentCountRef = useRef(currentAttachments.length);
    useEffect(() => {
        const currentCount = currentAttachments.length;

        // 如果当前预览的文件不在附件列表中且列表不为空（被单独移除），切换到其他文件
        if (selectedFile && currentCount > 0) {
            const isInList = currentAttachments.some(att => att.id === selectedFile.id);
            if (!isInList) {
                // 当前预览的附件已被移除，自动预览第一个文档
                const firstDocument = currentAttachments.find(att => att.type === 'document');
                if (firstDocument) {
                    setDocumentPreview(firstDocument);
                } else {
                    setSelectedFile(null);
                    setPreviewContent('');
                }
                logger.debug('[RightPanel] 当前预览的附件已被移除，切换预览');
            }
        }

        prevAttachmentCountRef.current = currentCount;
    }, [currentAttachments, selectedFile, setDocumentPreview]);

    // 渲染模式切换按钮
    const renderModeSwitch = () => (
        <div className={styles.modeSwitch}>
            <button
                className={cx(styles.modeBtn, mode === 'normal' && styles.modeActive)}
                onClick={() => contextId && setMode(contextId, 'normal')}
                disabled={!contextId}
            >
                Normal
            </button>
            <button
                className={cx(styles.modeBtn, mode === 'diff' && styles.modeActive)}
                onClick={() => contextId && setMode(contextId, 'diff')}
                disabled={!contextId}
            >
                {t('layout.diffMode')}
                {pendingCount > 0 && (
                    <span className={styles.badge}>{pendingCount}</span>
                )}
            </button>
        </div>
    );

    // 处理文件删除（清理预览状态）
    const handleFileDeleted = useCallback((deletedFileId: string) => {
        // 如果删除的是当前选中的文件，清理预览
        if (selectedFile?.id === deletedFileId) {
            setSelectedFile(null);
            setPreviewContent('');
        }
    }, [selectedFile]);

    /**
     * 打开指定文件的历史快照面板
     *
     * 若目标文件不是当前活跃文件，先切换到该文件（selectFile 内部会调用 loadSnapshots），
     * 再打开快照面板。快照面板会在 loadSnapshots 完成后动态填充内容。
     */
    const handleOpenFileHistory = useCallback((documentId: string) => {
        if (!contextId) return;
        // 如果点击的不是当前活跃文件，先切换到此文件使快照面板内容正确
        if (documentId !== diffState.activeFileId) {
            selectFile(contextId, documentId);
        }
        toggleSnapshotPanel();
    }, [contextId, diffState.activeFileId, selectFile, toggleSnapshotPanel]);

    // 渲染普通模式
    const renderNormalMode = () => (
        <>
            {/* 审批已完成后的历史版本快速访问入口 */}
            {/* 单文件：显示带标题文字 + 查看历史 按鈕 */}
            {/* 多文件：显示文件 chip 列表，每个 chip 独立触发对应文件的快照面板 */}
            {completedDiffFiles.length === 1 && (
                <div className={styles.historyAccessBar}>
                    <span className={styles.historyAccessHint}>
                        {t('layout.historyHint')}
                    </span>
                    <Tooltip content={t('layout.historyTitle')}>
                        <button
                            id="history-access-btn"
                            className={styles.historyAccessBtn}
                            onClick={() => {
                                const completedDiffFile = completedDiffFiles[0];
                                if (completedDiffFile) handleOpenFileHistory(completedDiffFile.documentId);
                            }}
                        >
                            Review
                        </button>
                    </Tooltip>
                </div>
            )}
            {completedDiffFiles.length > 1 && (
                <div className={styles.historyAccessBar}>
                    <span className={styles.historyAccessHint}>{t('layout.filesChanged')}</span>
                    <div className={styles.historyFileChips}>
                        {completedDiffFiles.map((file) => (
                            <Tooltip
                                key={file.documentId}
                                content={t('layout.fileHistoryTitle', { file: file.documentId })}
                            >
                                <button
                                    className={styles.historyFileChip}
                                    onClick={() => handleOpenFileHistory(file.documentId)}
                                >
                                    {file.fileName}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                </div>
            )}
            {/* 附件列表 */}
            {currentAttachments.length > 0 && (
                <div className={styles.attachmentListContainer}>
                    <div className={styles.attachmentListHeader}>
                        <span className={styles.attachmentListTitle}>{t('layout.attachmentsTitle', { count: currentAttachments.length })}</span>
                        <Tooltip content={t('layout.clearAttachments')}>
                        <button
                            className={styles.attachmentClearBtn}
                            onClick={() => {
                                if (contextId) {
                                    clearContextAttachments(contextId);
                                }
                                setSelectedFile(null);
                                setPreviewContent('');
                            }}
                            aria-label={t('layout.clearAttachments')}
                        >
                            ×
                        </button>
                        </Tooltip>
                    </div>
                    <div className={styles.attachmentList}>
                        {currentAttachments.map(att => (
                            <Tooltip key={att.id} content={att.fileName}>
                                <div
                                    className={cx(styles.attachmentItem, selectedFile?.id === att.id && styles.attachmentItemSelected)}
                                    onClick={() => {
                                        if (att.type === 'document') {
                                            setDocumentPreview(att);
                                        }
                                    }}
                                >
                                    <span className={styles.attachmentIcon}>
                                        {att.type === 'image' ? '🖼️' : '📄'}
                                    </span>
                                    <span className={styles.attachmentName}>
                                        {att.fileName.length > 20 ? att.fileName.slice(0, 17) + '...' : att.fileName}
                                    </span>
                                </div>
                            </Tooltip>
                        ))}
                    </div>
                </div>
            )}

            {/* 交付物列表 */}
            <div
                className={styles.fileListContainer}
                style={{ height: fileListHeight }}
            >
                {/* 仅在 Agent 视图（currentAgentId 非空）时渲染交付物列表。
                 * Hub 视图（contextId = hubId）时不渲染，避免以 hubName='default'、agentName='unknown'
                 * 当作参数调用 file_list_directory，误读 deliverables/default/unknown 目录下的文件。
                 * agentId 使用 currentAgentId（真实 agent entity ID）而非 contextId（Hub 视图下为 hubId），
                 * 确保 FileList 监听 'file:deliverable_created' 事件时能正确匹配 agent entity ID。
                 *
                 * rootDir：当 agent 关联了外部项目路径时，切换为项目目录浏览模式。
                 * 解除关联后 projectPath 变为 null/undefined，FileList 自动回退到 deliverables 目录。 */}
                {currentAgentId && (
                    <FileList
                        agentId={currentAgentId}
                        hubName={hubName}
                        agentName={agentName}
                        rootDir={currentAgent?.projectPath ?? undefined}
                        selectedFileId={selectedFile?.id ?? null}
                        onSelectFile={loadFilePreview}
                        onFileDeleted={handleFileDeleted}
                    />
                )}
            </div>

            {/* 可拖拽分隔条 */}
            <ResizeHandle
                direction="vertical"
                onResize={handleFileListResize}
                onResizeStart={() => setIsResizing(true)}
                onResizeEnd={() => setIsResizing(false)}
            />

            {/* 预览区 */}
            <div className={cx(styles.previewContainer, isFilePreviewFullscreen && styles.previewFullscreen)}>
                {/* 预览头部：文件名 + 全屏/关闭按钮 */}
                {selectedFile && (
                    <div className={styles.previewHeader}>
                        <span className={styles.previewFileName}>{selectedFile.fileName}</span>
                        <div className={styles.previewHeaderActions}>
                            {/* 全屏切换按钮 */}
                            <Tooltip content={isFilePreviewFullscreen ? t('layout.fullscreenExit') : t('layout.fullscreenPreview')}>
                                <button
                                    className={styles.previewIconBtn}
                                    onClick={handleToggleFilePreviewFullscreen}
                                    aria-label={isFilePreviewFullscreen ? t('layout.fullscreenExit') : t('layout.fullscreenPreview')}
                                >
                                    {isFilePreviewFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                                </button>
                            </Tooltip>
                            {/* 关闭预览按钮 */}
                            <Tooltip content={t('layout.closePreview')}>
                            <button
                                className={styles.previewCloseBtn}
                                onClick={() => {
                                    setIsFilePreviewFullscreen(false);
                                    setSelectedFile(null);
                                    setPreviewContent('');
                                }}
                                aria-label={t('layout.closePreview')}
                            >
                                ×
                            </button>
                            </Tooltip>
                        </div>
                    </div>
                )}
                <FilePreview
                    fileName={selectedFile?.fileName ?? null}
                    content={previewContent}
                    filePath={selectedFile?.filePath ?? null}
                    isLoading={isPreviewLoading}
                />
            </div>
        </>
    );

    // 获取多文件列表（仅 diff 模式使用）
    const fileList = useMemo(() => {
        void diffState.fileEntries;
        if (!contextId || mode !== 'diff') return [];
        return getFileList(contextId);
    }, [contextId, diffState.fileEntries, getFileList, mode]);

    // ==================== fileTabBar 滚轮切换 ====================

    /** fileTabBar 容器引用，用于直接操作 scrollLeft */
    const fileTabBarRef = useRef<HTMLDivElement>(null);
    /** 滚轮节流时间戳，防止快速连续切换 */
    const lastWheelTimeRef = useRef(0);
    /** 节流最小间隔（ms） */
    const WHEEL_THROTTLE_MS = 150;

    /**
     * fileTabBar 鼠标滚轮事件处理
     *
     * 使用原生 WheelEvent（非 React 合成事件），因为需要通过
     * addEventListener({ passive: false }) 注册才能正确调用 preventDefault()。
     * React 的 onWheel 默认注册为 passive，调用 preventDefault 会触发浏览器警告。
     */
    const handleFileTabWheel = useCallback((e: globalThis.WheelEvent) => {
        // 阻止默认的页面/容器滚动
        e.preventDefault();

        if (!contextId || fileList.length <= 1) return;

        // 节流：避免快速连续切换
        const now = Date.now();
        if (now - lastWheelTimeRef.current < WHEEL_THROTTLE_MS) return;
        lastWheelTimeRef.current = now;

        // 判断滚动方向：deltaY > 0 向下/向右 → 下一个文件
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta === 0) return;

        const currentIndex = fileList.findIndex(f => f.documentId === diffState.activeFileId);
        if (currentIndex === -1) return;

        const nextIndex = delta > 0
            ? Math.min(currentIndex + 1, fileList.length - 1)
            : Math.max(currentIndex - 1, 0);

        // 已在边界则不重复切换
        if (nextIndex === currentIndex) return;

        const nextFile = fileList[nextIndex];
        if (nextFile) {
            selectFile(contextId, nextFile.documentId);
        }
    }, [contextId, fileList, diffState.activeFileId, selectFile]);

    // 注册非 passive 的 wheel 事件监听器（React onWheel 默认 passive，无法 preventDefault）
    useEffect(() => {
        const el = fileTabBarRef.current;
        if (!el) return;

        el.addEventListener('wheel', handleFileTabWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleFileTabWheel);
    }, [handleFileTabWheel]);

    /**
     * 监听 activeFileId 变化，自动将对应 Tab 滚入容器可视区域（居中）
     *
     * 与 wheel handler 解耦：无论文件通过何种方式切换（滚轮/点击/外部触发），
     * Tab 栏都会自动对齐到当前活跃文件。
     */
    useEffect(() => {
        const container = fileTabBarRef.current;
        const activeId = diffState.activeFileId;
        if (!container || !activeId) return;

        // 延迟一帧，确保 React 已完成 DOM 更新
        requestAnimationFrame(() => {
            // 通过 DOM 遍历查找目标 Tab（避免 querySelector 的 CSS 转义问题——
            // Windows 路径含反斜杠 \，在 CSS 属性选择器中会被解析为转义符）
            const tabEl = Array.from(container.children).find(
                (el) => (el as HTMLElement).dataset.diffDocId === activeId
            ) as HTMLElement | undefined;
            if (!tabEl) return;

            // 将目标 Tab 居中显示
            const tabCenter = tabEl.offsetLeft + tabEl.offsetWidth / 2;
            const containerCenter = container.clientWidth / 2;
            container.scrollLeft = Math.max(0, tabCenter - containerCenter);
        });
    }, [diffState.activeFileId]);

    // 渲染 Diff 模式（Cursor 风格全文档滚动视图）
    const renderDiffMode = () => (
        <div className={styles.diffContainer}>
            {/* 工具栏 */}
            <div className={styles.diffToolbar}>
                {/* Undo/Redo 按钮 */}
                <Tooltip content={t('layout.undo')}>
                    <button
                        className={styles.toolbarBtn}
                        onClick={() => contextId && undo(contextId)}
                        disabled={!contextId || !canUndo(contextId)}
                        aria-label={t('layout.undo')}
                    >
                        <Undo2 size={16} />
                    </button>
                </Tooltip>
                <Tooltip content={t('layout.redo')}>
                    <button
                        className={styles.toolbarBtn}
                        onClick={() => contextId && redo(contextId)}
                        disabled={!contextId || !canRedo(contextId)}
                        aria-label={t('layout.redo')}
                    >
                        <Redo2 size={16} />
                    </button>
                </Tooltip>

                <div className={styles.toolbarDivider} />

                {/* 历史版本按钮 */}
                <Tooltip content={t('layout.viewHistory')}>
                    <button
                        className={styles.historyBtn}
                        onClick={toggleSnapshotPanel}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="8" cy="8" r="6" />
                            <path d="M8 5v3l2 2" />
                        </svg>
                        {t('layout.historyVersions')}
                    </button>
                </Tooltip>
            </div>

            {/* 多文件标签页（仅在文件数 > 1 时显示） */}
            {/* 支持鼠标滚轮切换文件，解决文件过多时 Tab 溢出无法点击的问题 */}
            {fileList.length > 1 && (
                <div
                    ref={fileTabBarRef}
                    className={styles.fileTabBar}
                >
                    {fileList.map((file) => (
                        <Tooltip key={file.documentId} content={file.documentId}>
                            <button
                                data-diff-doc-id={file.documentId}
                                className={cx(styles.fileTab, file.documentId === diffState.activeFileId && styles.fileTabActive)}
                                onClick={() => contextId && selectFile(contextId, file.documentId)}
                            >
                                <span className={styles.fileTabName}>{file.fileName}</span>
                                {file.pendingCount > 0 && (
                                    <span className={styles.fileTabBadge}>{file.pendingCount}</span>
                                )}
                            </button>
                        </Tooltip>
                    ))}
                </div>
            )}

            {/* 全文 Diff 查看器（带上下文折叠） */}
            <FullFileDiffViewer
                originalContent={originalContent}
                modifications={pendingModifications}
                fileName={fileName}
                documentId={diffState.documentId ?? undefined}
                onAccept={async (id) => { if (contextId) await acceptModification(contextId, id); }}
                onReject={async (id) => { if (contextId) await rejectModification(contextId, id); }}
                onAcceptAll={async () => { if (contextId) await acceptAll(contextId); }}
                onRejectAll={async () => { if (contextId) await rejectAll(contextId); }}
                isLoading={isLoading}
            />
        </div>
    );

    // 渲染快照历史面板
    const renderSnapshotPanel = () => (
        <SnapshotHistory
            key={`${contextId}:${diffState.documentId ?? ''}`}
            snapshots={snapshots}
            currentContent={currentContent}
            fileName={fileName}
            activeSnapshotId={diffState.activeSnapshotId}
            onRollback={async (snapshotId) => {
                if (contextId) {
                    await rollback(contextId, snapshotId);
                }
            }}
            onDelete={async (snapshotId) => {
                if (contextId) {
                    await deleteSnapshot(contextId, snapshotId);
                }
            }}
            onClose={toggleSnapshotPanel}
        />
    );

    const isDiffModePanel = mode === 'diff' && !isPreviewActive && !isSnapshotPanelOpen;

    return (
        <div className={cx(styles.rightPanel, isDiffModePanel && styles.diffModePanel, isResizing && styles.resizing)}>
            {/* 头部 */}
            <header className={styles.header}>
                <h2 className={styles.title}>
                    {isPreviewActive ? t('layout.panelPreview') : mode === 'diff' ? t('layout.diffPreview') : t('layout.files')}
                </h2>
                <div className={styles.headerActions}>
                    {renderModeSwitch()}
                    <button
                        className={styles.closeBtn}
                        onClick={toggleRightPanel}
                        aria-label={t('layout.closePanel')}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                </div>
            </header>

            {/* 内容区域 */}
            {isPreviewActive ? (
                <LivePreviewPanel />
            ) : isSnapshotPanelOpen ? renderSnapshotPanel() : (
                mode === 'diff' ? renderDiffMode() : renderNormalMode()
            )}
        </div>
    );
}
