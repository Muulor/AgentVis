/**
 * LivePreviewPanel - 实时代码预览面板
 *
 * 支持两种预览模式：
 *
 * 1. HTML 模式：通过 sandbox iframe srcdoc 渲染单文件 HTML
 *    安全策略：sandbox="allow-scripts allow-modals"（不加 allow-same-origin）
 *
 *    srcdoc iframe 的 origin 继承自父页面（tauri://localhost），与主应用完全同源。
 *    若加上 allow-scripts，预览页 JS 就能通过 window.parent 控制主应用（如触发刷新）。
 *    CDN 资源通过绝对 HTTPS URL 加载，不依赖同源策略；
 *    本地相对路径资源由 htmlResourceInliner 内联为 base64 data URL；
 *    hash 锚点跳转由注入的兼容脚本修复。
 *
 * 2. Project 模式：通过 iframe src 指向本地 Vite Dev Server
 *    安全策略：sandbox="allow-scripts allow-modals allow-same-origin"
 *
 *    iframe src = http://localhost:PORT，不加时 iframe 变为 null origin，
 *    导致 /src/main.js、/@vite/client 等子资源被 CORS 全量拦截白屏。
 *    iframe origin = http://localhost:PORT，父页 origin = tauri://localhost（或 localhost:1420），
 *    两者天然跨域，浏览器的跨域限制已阻止 window.parent 的敏感访问，
 *    沙箱逃逸风险可控。
 */

import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import { Code2, Play, RefreshCw, X, Loader2, AlertTriangle, Maximize2, Minimize2 } from 'lucide-react';
import { CodeHighlight } from './CodeHighlight';
import { usePreviewStore } from '@stores/previewStore';
import { useUIStore } from '@stores/uiStore';
import { vitePreviewService, inlineHtmlResources, injectSrcdocHashNavFix } from '@services/preview';
import type { ViteServerStatus } from '@services/preview/types';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './LivePreviewPanel.module.css';

const logger = getLogger('LivePreviewPanel');

type PreviewViewMode = 'code' | 'preview';

export function LivePreviewPanel() {
    const { t } = useI18n();
    const {
        previewCode,
        previewTitle,
        previewMode,
        previewBaseDir,
        projectUrl,
        projectStatus,
        projectError,
        closePreview,
    } = usePreviewStore();

    const [viewMode, setViewMode] = useState<PreviewViewMode>('preview');
    // 通过变化的 key 强制 iframe 重新加载
    const [refreshKey, setRefreshKey] = useState(0);
    // 全屏状态
    const [isFullscreen, setIsFullscreen] = useState(false);
    // iframe DOM 引用，用于卸载前主动终止其 JS 上下文
    const iframeRef = useRef<HTMLIFrameElement>(null);
    // 拖拽面板时禁用 iframe 指针事件，避免 WebGL 重绘造成卡顿
    const isResizing = useUIStore((state) => state.isResizing);

    // 刷新预览（强制重新加载 iframe）
    const handleRefresh = useCallback(() => {
        setRefreshKey((prev) => prev + 1);
    }, []);

    // 切换视图模式
    const handleToggleView = useCallback((mode: PreviewViewMode) => {
        setViewMode(mode);
    }, []);

    // 切换全屏
    const handleToggleFullscreen = useCallback(() => {
        setIsFullscreen((prev) => !prev);
    }, []);

    // Escape 键退出全屏
    useEffect(() => {
        if (!isFullscreen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsFullscreen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen]);

    // 组件卸载时强制将 iframe 导航到 about:blank，立即终止其内部的 JS 执行上下文。
    // 原因：Chromium/Webview2 对含有 rAF 死循环或 WebGL 上下文的 iframe，
    // 在 DOM 移除后不会立即同步回收，会进入异步 GC 队列（数秒后才释放显存）。
    // 对 Three.js 等重度 GPU 渲染的 HTML，这会导致显存在关闭后仍被占用，
    // 在显存较小的笔记本上叠加 Agent 任务内存压力后引发 Webview2 进程 OOM 崩溃。
    // 设置 src = 'about:blank' 会触发 iframe 内部的页面卸载流程，
    // 立即中断脚本执行并释放 WebGL 上下文，无需等待 GC。
    useEffect(() => {
        const iframe = iframeRef.current;
        return () => {
            if (iframe) {
                iframe.src = 'about:blank';
            }
        };
    }, []);

    // 关闭预览（同时停止 Vite 进程）
    const handleClose = useCallback(async () => {
        if (previewMode === 'project') {
            try {
                await vitePreviewService.stopProject();
            } catch (error) {
                console.error('[LivePreviewPanel] 停止 Vite 时出错:', error);
            }
        }
        closePreview();
    }, [previewMode, closePreview]);

    // 重试（Project 模式 error 状态时使用）
    const handleRetry = useCallback(async () => {
        // 重试通过重新启动实现，需要外部重新调用 startProject
        // 这里先停止再由用户重新触发
        try {
            await vitePreviewService.stopProject();
        } catch {
            // 忽略停止错误
        }
        closePreview();
    }, [closePreview]);

    // HTML 模式的 srcdoc：当有 baseDir 时，按需内嵌相对路径资源
    const [processedHtml, setProcessedHtml] = useState<string>('');
    const [isInlining, setIsInlining] = useState(false);

    // 当 previewCode 或 baseDir 变化时，处理资源内嵌
    useEffect(() => {
        if (!previewCode) {
            setProcessedHtml('');
            return;
        }

        // 没有 baseDir 时直接使用原始 HTML（聊天消息中的代码块场景），
        // 但仍需注入 hash 导航修复脚本以防止 srcdoc 锚点跳转白屏
        if (!previewBaseDir) {
            setProcessedHtml(injectSrcdocHashNavFix(previewCode));
            return;
        }

        /**
         * 自包含 HTML 快速路径检测
         *
         * Plotly Python 生成的 HTML 将完整 JS bundle 内联到 <script> 标签中，
         * 不存在任何外部 CSS/JS 相对引用。对这类文件跳过 inlineHtmlResources
         * 的正则扫描（会在主线程上处理 4~5MB 字符串），直接送入 iframe 渲染。
         *
         * 判断依据：
         * - 文件超过 500KB（避免对小文件误判）
         * - 不含 <link href="...css"> 或 <script src="...js"> 形式的相对路径引用
         */
        const SELF_CONTAINED_THRESHOLD = 500 * 1024;
        const hasExternalRelativeCss = /<link\b[^>]*\bhref\s*=\s*['"][^'"]+\.css['"]/i.test(previewCode);
        const hasExternalRelativeJs = /<script\b[^>]*\bsrc\s*=\s*['"][^'"]+\.js['"]/i.test(previewCode);
        const isSelfContained =
            previewCode.length > SELF_CONTAINED_THRESHOLD &&
            !hasExternalRelativeCss &&
            !hasExternalRelativeJs;

        if (isSelfContained) {
            // 自包含大文件，跳过资源内嵌，但仍注入 hash 导航修复脚本
            logger.debug('[LivePreviewPanel] 检测到自包含 HTML（无外部相对引用），跳过资源内嵌直接渲染');
            setProcessedHtml(injectSrcdocHashNavFix(previewCode));
            return;
        }

        // 有外部相对路径引用，走完整的异步内嵌流程
        let cancelled = false;
        setIsInlining(true);

        inlineHtmlResources(previewCode, previewBaseDir)
            .then((result) => {
                if (!cancelled) {
                    setProcessedHtml(result);
                }
            })
            .catch((error: unknown) => {
                // 内嵌失败时降级使用原始 HTML，但仍注入 hash 导航修复脚本
                logger.warn('[LivePreviewPanel] 资源内嵌失败，降级使用原始 HTML:', error);
                if (!cancelled) {
                    setProcessedHtml(injectSrcdocHashNavFix(previewCode));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsInlining(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [previewCode, previewBaseDir]);

    // 空状态检查
    const isHtmlMode = previewMode === 'html';
    const isProjectMode = previewMode === 'project';

    if (isHtmlMode && !previewCode) {
        return null;
    }

    // 渲染工具栏标题
    const renderTitle = () => {
        if (isProjectMode) {
            const statusLabel: Record<string, string> = {
                idle: t('file.previewPreparing'),
                installing: t('file.previewInstalling'),
                starting: t('file.previewStarting'),
                running: projectUrl ?? t('file.previewRunning'),
                error: t('file.previewFailed'),
            };
            return statusLabel[projectStatus] ?? 'Project Preview';
        }
        return previewTitle ?? 'Preview';
    };

    return (
        <div className={cx(styles.panel, isFullscreen && styles.fullscreen)}>
            {/* 工具栏 */}
            <div className={styles.toolbar}>
                <div className={styles.titleArea}>
                    {/* Project 模式状态指示器 */}
                    {isProjectMode && projectStatus === 'running' && (
                        <span className={styles.statusDot} title={t('file.viteRunning')} />
                    )}
                    {isProjectMode && (projectStatus === 'installing' || projectStatus === 'starting') && (
                        <Loader2 size={12} className={styles.statusSpinner} />
                    )}
                    {isProjectMode && projectStatus === 'error' && (
                        <AlertTriangle size={12} className={styles.statusError} />
                    )}
                    <span className={styles.title} title={renderTitle()}>
                        {renderTitle()}
                    </span>
                </div>

                <div className={styles.toolbarActions}>
                    {/* Code / Preview 切换（仅 HTML 模式或 project running 时显示） */}
                    {(isHtmlMode || (isProjectMode && projectStatus === 'running')) && (
                        <div className={styles.viewToggle}>
                            {/* HTML 模式才显示 Code 按钮（project 模式无单文件源码可看） */}
                            {isHtmlMode && (
                                <button
                                    className={cx(styles.toggleBtn, viewMode === 'code' && styles.toggleActive)}
                                    onClick={() => handleToggleView('code')}
                                    title={t('file.viewSource')}
                                >
                                    <Code2 size={14} />
                                    <span>Code</span>
                                </button>
                            )}
                            <button
                                className={cx(styles.toggleBtn, (viewMode === 'preview' || isProjectMode) && styles.toggleActive)}
                                onClick={() => handleToggleView('preview')}
                                title={t('file.livePreview')}
                            >
                                <Play size={14} />
                                <span>Preview</span>
                            </button>
                        </div>
                    )}

                    {/* 刷新按钮 */}
                    {(viewMode === 'preview' || isProjectMode) && projectStatus !== 'error' && (
                        <button
                            className={styles.iconBtn}
                            onClick={handleRefresh}
                            title={t('file.refreshPreview')}
                        >
                            <RefreshCw size={14} />
                        </button>
                    )}

                    {/* 全屏切换按钮 */}
                    {(viewMode === 'preview' || isProjectMode) && projectStatus !== 'error' && (
                        <button
                            className={styles.iconBtn}
                            onClick={handleToggleFullscreen}
                            title={isFullscreen ? t('layout.fullscreenExit') : t('layout.fullscreenPreview')}
                        >
                            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                    )}

                    {/* 关闭按钮 */}
                    <button
                        className={styles.iconBtn}
                        onClick={handleClose}
                        title={t('file.closePreview')}
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* 内容区域 */}
            <div className={styles.content}>
                {isHtmlMode ? (
                    // ========== HTML 模式 ==========
                    viewMode === 'code' ? (
                        <div className={styles.codeView}>
                            <CodeHighlight
                                code={previewCode ?? ''}
                                language="html"
                                showLineNumbers={true}
                            />
                        </div>
                    ) : isInlining ? (
                        // 资源内嵌中显示加载状态
                        <div className={styles.projectLoading}>
                            <Loader2 size={24} className={styles.projectSpinner} />
                            <span className={styles.projectLoadingText}>{t('file.loadingResources')}</span>
                        </div>
                    ) : (
                        <iframe
                            ref={iframeRef}
                            key={refreshKey}
                            className={styles.previewFrame}
                            sandbox="allow-scripts allow-modals"
                            srcDoc={processedHtml}
                            referrerPolicy="no-referrer"
                            title="Live Preview"
                            style={isResizing ? { pointerEvents: 'none' } : undefined}
                        />
                    )
                ) : (
                    // ========== Project 模式 ==========
                    renderProjectContent(
                        projectStatus,
                        projectUrl,
                        projectError,
                        refreshKey,
                        isResizing,
                        () => { void handleRetry(); },
                        t,
                        iframeRef,
                    )
                )}
            </div>
        </div>
    );
}

/**
 * Project 模式内容渲染
 *
 * 根据 Vite 服务器状态显示不同 UI：
 * - installing/starting: 加载动画
 * - running: iframe src 指向 Vite
 * - error: 错误信息 + 重试按钮
 */
function renderProjectContent(
    status: ViteServerStatus,
    url: string | null,
    error: string | null,
    refreshKey: number,
    isResizing: boolean,
    onRetry: () => void,
    t: ReturnType<typeof useI18n>['t'],
    iframeRef?: RefObject<HTMLIFrameElement>,
): React.ReactElement {
    switch (status) {
        case 'installing':
            return (
                <div className={styles.projectLoading}>
                    <Loader2 size={32} className={styles.projectSpinner} />
                    <span className={styles.projectLoadingText}>{t('file.installingTemplate')}</span>
                    <span className={styles.projectLoadingHint}>{t('file.installingTemplateHint')}</span>
                </div>
            );

        case 'starting':
        case 'idle':
            return (
                <div className={styles.projectLoading}>
                    <Loader2 size={32} className={styles.projectSpinner} />
                    <span className={styles.projectLoadingText}>{t('file.startingVite')}</span>
                </div>
            );

        case 'running':
            if (!url) return <div className={styles.projectLoading}>{t('file.waitingUrl')}</div>;
            return (
                <iframe
                    ref={iframeRef}
                    key={refreshKey}
                    className={styles.previewFrame}
                    sandbox="allow-scripts allow-modals allow-same-origin"
                    src={url}
                    referrerPolicy="no-referrer"
                    title="Project Preview"
                    style={isResizing ? { pointerEvents: 'none' } : undefined}
                />
            );

        case 'error':
            return (
                <div className={styles.projectError}>
                    <AlertTriangle size={32} className={styles.projectErrorIcon} />
                    <span className={styles.projectErrorText}>{t('file.previewStartFailed')}</span>
                    {error && (
                        <span className={styles.projectErrorDetail}>{error}</span>
                    )}
                    <button className={styles.retryBtn} onClick={onRetry}>
                        <RefreshCw size={14} />
                        <span>{t('common.retry')}</span>
                    </button>
                </div>
            );

        default:
            return <div />;
    }
}
