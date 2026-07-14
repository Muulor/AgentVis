/**
 * LivePreviewPanel - 实时代码预览面板
 *
 * 支持两种预览模式：
 *
 * 1. HTML 模式：通过 sandbox iframe srcdoc 渲染单文件 HTML
 *    安全策略：sandbox="allow-scripts allow-modals"（不加 allow-same-origin）
 *
 *    不含 allow-same-origin 的 sandbox 会把 srcdoc iframe 放入 opaque origin，
 *    避免预览页 JS 以主应用 origin 访问 window.parent 或应用存储。
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

/* eslint-disable react-refresh/only-export-components -- exported protocol guards are covered by unit tests */

import { useState, useCallback, useEffect, useRef, type RefCallback } from 'react';
import {
  Code2,
  Play,
  RefreshCw,
  X,
  Loader2,
  AlertTriangle,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { CodeHighlight } from './CodeHighlight';
import { usePreviewStore } from '@stores/previewStore';
import { useUIStore } from '@stores/uiStore';
import {
  vitePreviewService,
  inlineHtmlResources,
  injectSrcdocHashNavFix,
  isManagedPreviewUrl,
  MAX_PREVIEW_ASSET_BYTES,
  MAX_PREVIEW_ASSET_FILES,
  MAX_PREVIEW_SINGLE_ASSET_BYTES,
  MAX_PREVIEW_SOURCE_FILE_BYTES,
  MAX_PREVIEW_SOURCE_FILES,
  MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
  MAX_PREVIEW_SOURCE_TOTAL_BYTES,
  MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
} from '@services/preview';
import type { ViteServerStatus } from '@services/preview/types';
import { parsePreviewError, type PreviewErrorCode } from '@services/preview/previewErrors';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './LivePreviewPanel.module.css';

const logger = getLogger('LivePreviewPanel');
const PROJECT_PREVIEW_MESSAGE_NAMESPACE = 'agentvis:preview';
const PROJECT_PREVIEW_READY_TIMEOUT_MS = 8_000;
const PROJECT_PREVIEW_MESSAGE_LIMIT = 2_000;
const PROJECT_PREVIEW_ERROR_DETAIL_LIMIT = 600;

type PreviewViewMode = 'code' | 'preview';
type ProjectFrameLoadState = 'loading' | 'awaiting-ready' | 'ready';
export type ProjectPreviewMessageType =
  | 'booting'
  | 'ready'
  | 'runtime-error'
  | 'unhandled-rejection'
  | 'resource-error';
type ProjectPreviewDiagnosticKind =
  | 'runtime-error'
  | 'unhandled-rejection'
  | 'resource-error'
  | 'handshake-timeout'
  | 'retry-error';

export interface ProjectPreviewMessage {
  type: ProjectPreviewMessageType;
  message: string | null;
}

/**
 * Replace the current handshake deadline. Starting the deadline does not depend
 * on the iframe load event, so an iframe that never loads cannot leave the
 * loading mask visible forever.
 */
export function armProjectPreviewReadyTimeout(
  currentTimeout: ReturnType<typeof setTimeout> | null,
  isBridgeConnected: () => boolean,
  onTimeout: () => void,
  timeoutMs = PROJECT_PREVIEW_READY_TIMEOUT_MS
): ReturnType<typeof setTimeout> {
  if (currentTimeout !== null) {
    clearTimeout(currentTimeout);
  }

  return setTimeout(() => {
    if (!isBridgeConnected()) {
      onTimeout();
    }
  }, timeoutMs);
}

interface ProjectPreviewMessageEvent {
  source: MessageEventSource | null;
  origin: string;
  data: unknown;
}

interface ProjectPreviewPingTarget {
  postMessage: (message: unknown, targetOrigin: string) => void;
  readonly location?: {
    readonly href: string;
  };
}

export interface ProjectPreviewDiagnostic {
  kind: ProjectPreviewDiagnosticKind;
  message: string | null;
}

/** A late trusted lifecycle signal recovers only a prior handshake warning. */
export function clearProjectPreviewHandshakeTimeout(
  diagnostic: ProjectPreviewDiagnostic | null
): ProjectPreviewDiagnostic | null {
  return diagnostic?.kind === 'handshake-timeout' ? null : diagnostic;
}

interface PreviewErrorPresentation {
  summary: string | null;
  detail: string | null;
  cancelled: boolean;
}

function normalizePreviewMessage(
  value: unknown,
  limit = PROJECT_PREVIEW_MESSAGE_LIMIT
): string | null {
  if (typeof value !== 'string') return null;
  const boundedInput = value.slice(0, limit + 1);
  const message = boundedInput.trim();
  if (!message) return null;
  return value.length > limit || message.length > limit
    ? `${message.slice(0, Math.max(0, limit - 1))}…`
    : message;
}

function getPreviewErrorSummary(
  code: Exclude<PreviewErrorCode, 'cancelled'>,
  t: ReturnType<typeof useI18n>['t']
): string {
  switch (code) {
    case 'missing-dependencies':
      return t('file.previewErrorMissingDependencies');
    case 'invalid-package':
      return t('file.previewErrorInvalidPackage');
    case 'ambiguous-entry':
      return t('file.previewErrorAmbiguousEntry');
    case 'entry-not-found':
      return t('file.previewErrorEntryNotFound');
    case 'nested-project':
      return t('file.previewErrorNestedProject');
    case 'unsupported-project':
      return t('file.previewErrorUnsupportedProject');
    case 'unsafe-path':
      return t('file.previewErrorUnsafePath');
    case 'node-missing':
      return t('file.previewErrorNodeMissing');
    case 'install-failed':
      return t('file.previewErrorInstallFailed');
    case 'install-auth-failed':
      return t('file.previewErrorInstallAuthFailed');
    case 'install-network-failed':
      return t('file.previewErrorInstallNetworkFailed');
    case 'server-start-failed':
      return t('file.previewErrorServerStartFailed');
    case 'compile-failed':
      return t('file.previewErrorCompileFailed');
    case 'process-exited':
      return t('file.previewErrorProcessExited');
    case 'retry-unavailable':
      return t('file.previewErrorRetryUnavailable');
    case 'asset-budget-exceeded':
      return t('file.previewErrorAssetBudgetExceeded');
    default:
      return t('file.previewStartFailed');
  }
}

function getPreviewErrorDetail(
  code: Exclude<PreviewErrorCode, 'cancelled'>,
  detail: string | undefined,
  t: ReturnType<typeof useI18n>['t']
): string | null {
  if (!detail) return null;

  if (code === 'unsafe-path' && /(?:hard-link|reparse|link|junction|symlink)/iu.test(detail)) {
    return t('file.previewErrorUnsafeLinkDetail');
  }
  if (code === 'asset-budget-exceeded') {
    if (/(?:copiedFiles|asset-file-count)/iu.test(detail)) {
      return t('file.previewErrorAssetFileCountDetail', { count: MAX_PREVIEW_ASSET_FILES });
    }
    if (/(?:copiedBytes|asset-total)/iu.test(detail)) {
      return t('file.previewErrorAssetTotalSizeDetail', {
        size: MAX_PREVIEW_ASSET_BYTES / (1024 * 1024),
      });
    }
    if (/(?:asset-file|file-bytes)/iu.test(detail)) {
      return t('file.previewErrorAssetFileSizeDetail', {
        size: MAX_PREVIEW_SINGLE_ASSET_BYTES / (1024 * 1024),
      });
    }
    if (/(?:file-count|max-files)/iu.test(detail)) {
      return t('file.previewErrorSourceFileCountDetail', { count: MAX_PREVIEW_SOURCE_FILES });
    }
    if (/(?:scanned-entry|max-entries)/iu.test(detail)) {
      return t('file.previewErrorScannedEntryCountDetail', {
        count: MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
      });
    }
    if (/(?:directory-depth|max-depth)/iu.test(detail)) {
      return t('file.previewErrorDirectoryDepthDetail', {
        count: MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
      });
    }
    if (/(?:source-file|file-bytes|max-file-bytes)/iu.test(detail)) {
      return t('file.previewErrorSourceFileSizeDetail', {
        size: MAX_PREVIEW_SOURCE_FILE_BYTES / (1024 * 1024),
      });
    }
    if (/(?:source-total|max-total-bytes)/iu.test(detail)) {
      return t('file.previewErrorSourceTotalSizeDetail', {
        size: MAX_PREVIEW_SOURCE_TOTAL_BYTES / (1024 * 1024),
      });
    }
  }
  if (code === 'ambiguous-entry') {
    return t('file.previewErrorDetectedEntries', { entries: detail });
  }
  if (code === 'nested-project') {
    return t('file.previewErrorDetectedProjectRoots', { roots: detail });
  }
  if (code === 'unsupported-project' && detail.startsWith('non-registry-dependency:')) {
    return t('file.previewErrorNonRegistryDependency', {
      dependency: detail.slice('non-registry-dependency:'.length).trim(),
    });
  }

  return normalizePreviewMessage(detail, PROJECT_PREVIEW_ERROR_DETAIL_LIMIT);
}

export function getPreviewErrorPresentation(
  error: string | null | undefined,
  t: ReturnType<typeof useI18n>['t']
): PreviewErrorPresentation {
  const structuredError = parsePreviewError(error);
  if (!structuredError) {
    return {
      summary: null,
      detail: normalizePreviewMessage(error, PROJECT_PREVIEW_ERROR_DETAIL_LIMIT),
      cancelled: false,
    };
  }

  if (structuredError.code === 'cancelled') {
    return { summary: null, detail: null, cancelled: true };
  }

  const detail = getPreviewErrorDetail(structuredError.code, structuredError.detail, t);
  const environmentHint = structuredError.hints?.[0];
  const hint = environmentHint
    ? t('file.previewErrorEnvironmentFilesOmitted', { count: environmentHint.count })
    : null;

  return {
    summary: getPreviewErrorSummary(structuredError.code, t),
    detail: [detail, hint].filter((value): value is string => value !== null).join(' ') || null,
    cancelled: false,
  };
}

/** Parse the deliberately small host/preview bridge protocol. */
export function parseProjectPreviewMessage(data: unknown): ProjectPreviewMessage | null {
  if (!data || typeof data !== 'object') return null;

  const payload = data as Record<string, unknown>;
  if (payload.namespace !== PROJECT_PREVIEW_MESSAGE_NAMESPACE) return null;

  const type = payload.type;
  if (
    type !== 'booting' &&
    type !== 'ready' &&
    type !== 'runtime-error' &&
    type !== 'unhandled-rejection' &&
    type !== 'resource-error'
  ) {
    return null;
  }

  return {
    type,
    message:
      normalizePreviewMessage(payload.message) ??
      normalizePreviewMessage(payload.detail) ??
      normalizePreviewMessage(payload.error),
  };
}

/**
 * Accept messages only from the currently rendered iframe and the exact origin
 * represented by the managed preview URL. Other localhost frames cannot spoof
 * a preview error or ready signal.
 */
export function getTrustedProjectPreviewMessage(
  event: ProjectPreviewMessageEvent,
  iframeWindow: MessageEventSource | null,
  projectUrl: string | null
): ProjectPreviewMessage | null {
  if (!iframeWindow || event.source !== iframeWindow || !isManagedPreviewUrl(projectUrl)) {
    return null;
  }

  try {
    if (event.origin !== new URL(projectUrl).origin) return null;
  } catch {
    return null;
  }

  return parseProjectPreviewMessage(event.data);
}

/** Ask the trusted iframe bridge to replay state without broadening its origin boundary. */
export function sendProjectPreviewPing(
  target: ProjectPreviewPingTarget | null,
  projectUrl: string | null
): boolean {
  if (!target || !isManagedPreviewUrl(projectUrl)) return false;

  // A newly mounted iframe initially inherits the host origin through its
  // about:blank document. Posting to the future preview origin at that point
  // is guaranteed to fail and produces a misleading DOMWindow warning.
  try {
    if (target.location?.href === 'about:blank') return false;
  } catch {
    // Cross-origin location access means navigation has committed. The exact
    // target origin below remains the security boundary for the ping itself.
  }

  try {
    target.postMessage(
      { namespace: PROJECT_PREVIEW_MESSAGE_NAMESPACE, type: 'ping' },
      new URL(projectUrl).origin
    );
    return true;
  } catch {
    return false;
  }
}

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
    projectRequestId,
    projectCanRetry,
    closePreview,
  } = usePreviewStore();

  const isHtmlMode = previewMode === 'html';
  const isProjectMode = previewMode === 'project';
  const [viewMode, setViewMode] = useState<PreviewViewMode>('preview');
  // 通过变化的 key 强制 iframe 重新加载
  const [refreshKey, setRefreshKey] = useState(0);
  // 全屏状态
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [projectFrameLoadState, setProjectFrameLoadState] =
    useState<ProjectFrameLoadState>('loading');
  const [projectDiagnostic, setProjectDiagnostic] = useState<ProjectPreviewDiagnostic | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  // iframe DOM 引用，用于卸载前主动终止其 JS 上下文
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastIframeRef = useRef<HTMLIFrameElement | null>(null);
  const hasPreviewBridgeSignalRef = useRef(false);
  const previewReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 拖拽面板时禁用 iframe 指针事件，避免 WebGL 重绘造成卡顿
  const isResizing = useUIStore((state) => state.isResizing);

  const clearPreviewReadyTimeout = useCallback(() => {
    if (previewReadyTimeoutRef.current !== null) {
      clearTimeout(previewReadyTimeoutRef.current);
      previewReadyTimeoutRef.current = null;
    }
  }, []);

  const resetProjectFrameState = useCallback(() => {
    clearPreviewReadyTimeout();
    hasPreviewBridgeSignalRef.current = false;
    setProjectFrameLoadState('loading');
    setProjectDiagnostic(null);
    setRetryError(null);
  }, [clearPreviewReadyTimeout]);

  const armPreviewReadyTimeout = useCallback(() => {
    previewReadyTimeoutRef.current = armProjectPreviewReadyTimeout(
      previewReadyTimeoutRef.current,
      () => hasPreviewBridgeSignalRef.current,
      () => {
        previewReadyTimeoutRef.current = null;
        setProjectFrameLoadState('ready');
        setProjectDiagnostic((current) => current ?? { kind: 'handshake-timeout', message: null });
      }
    );
  }, []);

  const beginProjectFrameHandshake = useCallback(() => {
    resetProjectFrameState();
    armPreviewReadyTimeout();
  }, [armPreviewReadyTimeout, resetProjectFrameState]);

  useEffect(() => {
    setIsRetrying(false);
    resetProjectFrameState();
  }, [projectRequestId, resetProjectFrameState]);

  // 刷新预览（强制重新加载 iframe）
  const handleRefresh = useCallback(() => {
    if (isProjectMode) {
      if (projectStatus === 'running' && projectUrl) {
        beginProjectFrameHandshake();
      } else {
        resetProjectFrameState();
      }
    }
    setRefreshKey((prev) => prev + 1);
  }, [
    beginProjectFrameHandshake,
    isProjectMode,
    projectStatus,
    projectUrl,
    resetProjectFrameState,
  ]);

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

  // React 会在 passive effect cleanup 前清空 object ref。使用 callback ref 保留并
  // 主动释放前一个 iframe，确保刷新 key 或卸载面板时都能立即终止其 JS/WebGL 上下文。
  const setIframeElement = useCallback<RefCallback<HTMLIFrameElement>>((iframe) => {
    const previousIframe = iframeRef.current;
    if (previousIframe && previousIframe !== iframe) {
      previousIframe.src = 'about:blank';
    }

    iframeRef.current = iframe;
    if (iframe) {
      lastIframeRef.current = iframe;
    }
  }, []);

  // 组件卸载时强制将 iframe 导航到 about:blank，立即终止其内部的 JS 执行上下文。
  // 原因：Chromium/Webview2 对含有 rAF 死循环或 WebGL 上下文的 iframe，
  // 在 DOM 移除后不会立即同步回收，会进入异步 GC 队列（数秒后才释放显存）。
  // 对 Three.js 等重度 GPU 渲染的 HTML，这会导致显存在关闭后仍被占用，
  // 在显存较小的笔记本上叠加 Agent 任务内存压力后引发 Webview2 进程 OOM 崩溃。
  // 设置 src = 'about:blank' 会触发 iframe 内部的页面卸载流程，
  // 立即中断脚本执行并释放 WebGL 上下文，无需等待 GC。
  useEffect(
    () => () => {
      clearPreviewReadyTimeout();
      const iframe = iframeRef.current ?? lastIframeRef.current;
      if (iframe) {
        iframe.src = 'about:blank';
      }
      iframeRef.current = null;
      lastIframeRef.current = null;
    },
    [clearPreviewReadyTimeout]
  );

  // 关闭预览；store 会统一以 fire-and-forget 方式停止项目服务。
  const handleClose = useCallback(() => {
    closePreview();
  }, [closePreview]);

  // 重试（Project 模式 error 状态时使用）
  const handleRetry = useCallback(async () => {
    if (isRetrying || !projectCanRetry) return;

    const retryRequestId = projectRequestId;
    setIsRetrying(true);
    resetProjectFrameState();
    try {
      await vitePreviewService.retryLastProject(retryRequestId);
      if (!usePreviewStore.getState().isProjectRequestCurrent(retryRequestId)) return;
      beginProjectFrameHandshake();
      setRefreshKey((current) => current + 1);
    } catch (error: unknown) {
      if (!usePreviewStore.getState().isProjectRequestCurrent(retryRequestId)) return;
      const presentation = getPreviewErrorPresentation(
        error instanceof Error
          ? error.message
          : normalizePreviewMessage(error, PROJECT_PREVIEW_ERROR_DETAIL_LIMIT),
        t
      );
      if (presentation.cancelled) return;

      const message =
        [presentation.summary, presentation.detail].filter(Boolean).join('\n') ||
        t('file.previewRetryFailed');
      setRetryError(message);
      setProjectDiagnostic({ kind: 'retry-error', message });
      logger.warn('[LivePreviewPanel] Project preview retry failed:', message);
    } finally {
      if (usePreviewStore.getState().isProjectRequestCurrent(retryRequestId)) {
        setIsRetrying(false);
      }
    }
  }, [
    beginProjectFrameHandshake,
    isRetrying,
    projectCanRetry,
    projectRequestId,
    resetProjectFrameState,
    t,
  ]);

  const handleProjectFrameLoad = useCallback(() => {
    sendProjectPreviewPing(iframeRef.current?.contentWindow ?? null, projectUrl);

    if (hasPreviewBridgeSignalRef.current) {
      setProjectFrameLoadState('ready');
      return;
    }

    setProjectFrameLoadState('awaiting-ready');
  }, [projectUrl]);

  useEffect(() => {
    if (!isProjectMode || projectStatus !== 'running' || !projectUrl) {
      clearPreviewReadyTimeout();
      return;
    }

    beginProjectFrameHandshake();
    return clearPreviewReadyTimeout;
  }, [
    beginProjectFrameHandshake,
    clearPreviewReadyTimeout,
    isProjectMode,
    projectStatus,
    projectUrl,
  ]);

  useEffect(() => {
    if (!isProjectMode || projectStatus !== 'running' || !projectUrl) return;

    const handlePreviewMessage = (event: MessageEvent<unknown>) => {
      const message = getTrustedProjectPreviewMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        projectUrl
      );
      if (!message) return;

      // Any trusted bridge message proves that diagnostics are connected.
      // In particular, `booting` must not restart a deadline that measures a
      // later window.load event, because slow assets can legitimately delay it.
      hasPreviewBridgeSignalRef.current = true;
      clearPreviewReadyTimeout();
      setProjectFrameLoadState('ready');

      if (message.type === 'booting' || message.type === 'ready') {
        setProjectDiagnostic(clearProjectPreviewHandshakeTimeout);
        return;
      }

      setProjectDiagnostic({ kind: message.type, message: message.message });
      logger.warn(
        `[LivePreviewPanel] Project preview reported ${message.type}:`,
        message.message?.slice(0, PROJECT_PREVIEW_ERROR_DETAIL_LIMIT) ?? ''
      );
    };

    window.addEventListener('message', handlePreviewMessage);
    sendProjectPreviewPing(iframeRef.current?.contentWindow ?? null, projectUrl);
    return () => window.removeEventListener('message', handlePreviewMessage);
  }, [clearPreviewReadyTimeout, isProjectMode, projectStatus, projectUrl]);

  useEffect(() => {
    if (
      isProjectMode &&
      projectStatus === 'error' &&
      parsePreviewError(projectError)?.code === 'cancelled'
    ) {
      closePreview();
    }
  }, [closePreview, isProjectMode, projectError, projectStatus]);

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
    const hasExternalRelativeCss = /<link\b[^>]*\bhref\s*=\s*['"][^'"]+\.css['"]/i.test(
      previewCode
    );
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

  if (isHtmlMode && !previewCode) {
    return null;
  }

  const projectErrorPresentation = getPreviewErrorPresentation(projectError ?? retryError, t);
  if (isProjectMode && projectErrorPresentation.cancelled) {
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
      return statusLabel[projectStatus] ?? t('file.projectPreview');
    }
    return previewTitle ?? t('file.livePreview');
  };

  const visibleProjectDiagnostic =
    projectDiagnostic ??
    (retryError ? { kind: 'retry-error' as const, message: retryError } : null);

  return (
    <div className={cx(styles.panel, isFullscreen && styles.fullscreen)}>
      {/* 工具栏 */}
      <div className={styles.toolbar}>
        <div className={styles.titleArea}>
          {/* Project 模式状态指示器 */}
          {isProjectMode &&
            projectStatus === 'running' &&
            projectFrameLoadState === 'ready' &&
            !visibleProjectDiagnostic && (
              <span className={styles.statusDot} title={t('file.viteRunning')} />
            )}
          {isProjectMode &&
            (projectStatus === 'installing' ||
              projectStatus === 'starting' ||
              (projectStatus === 'running' &&
                projectFrameLoadState !== 'ready' &&
                !visibleProjectDiagnostic)) && (
              <Loader2 size={12} className={styles.statusSpinner} />
            )}
          {isProjectMode && (projectStatus === 'error' || visibleProjectDiagnostic) && (
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
                  <span>{t('file.previewCodeLabel')}</span>
                </button>
              )}
              <button
                className={cx(
                  styles.toggleBtn,
                  (viewMode === 'preview' || isProjectMode) && styles.toggleActive
                )}
                onClick={() => handleToggleView('preview')}
                title={t('file.livePreview')}
              >
                <Play size={14} />
                <span>{t('file.previewLabel')}</span>
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
          <button className={styles.iconBtn} onClick={handleClose} title={t('file.closePreview')}>
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
              <CodeHighlight code={previewCode ?? ''} language="html" showLineNumbers={true} />
            </div>
          ) : isInlining ? (
            // 资源内嵌中显示加载状态
            <div className={styles.projectLoading}>
              <Loader2 size={24} className={styles.projectSpinner} />
              <span className={styles.projectLoadingText}>{t('file.loadingResources')}</span>
            </div>
          ) : (
            <iframe
              ref={setIframeElement}
              key={refreshKey}
              className={styles.previewFrame}
              sandbox="allow-scripts allow-modals"
              srcDoc={processedHtml}
              referrerPolicy="no-referrer"
              title={t('file.livePreview')}
              style={isResizing ? { pointerEvents: 'none' } : undefined}
            />
          )
        ) : (
          // ========== Project 模式 ==========
          renderProjectContent({
            status: projectStatus,
            url: projectUrl,
            error: projectErrorPresentation,
            refreshKey,
            isResizing,
            frameLoadState: projectFrameLoadState,
            diagnostic: visibleProjectDiagnostic,
            isRetrying,
            canRetry: projectCanRetry,
            onLoad: handleProjectFrameLoad,
            onRetry: () => {
              void handleRetry();
            },
            t,
            iframeRef: setIframeElement,
          })
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
interface ProjectContentOptions {
  status: ViteServerStatus;
  url: string | null;
  error: PreviewErrorPresentation;
  refreshKey: number;
  isResizing: boolean;
  frameLoadState: ProjectFrameLoadState;
  diagnostic: ProjectPreviewDiagnostic | null;
  isRetrying: boolean;
  canRetry: boolean;
  onLoad: () => void;
  onRetry: () => void;
  t: ReturnType<typeof useI18n>['t'];
  iframeRef: RefCallback<HTMLIFrameElement>;
}

export type ProjectPreviewDiagnosticCategory =
  | 'browser-capability'
  | 'cross-origin'
  | 'external-resource'
  | null;

export function classifyProjectPreviewDiagnostic(
  kind: ProjectPreviewDiagnosticKind,
  message: string | null
): ProjectPreviewDiagnosticCategory {
  if (
    message &&
    /(?:\bWebGL\b|\bWebGPU\b|SharedArrayBuffer|crossOriginIsolated|OffscreenCanvas)/iu.test(message)
  ) {
    return 'browser-capability';
  }
  if (
    message &&
    /(?:\bCORS\b|cross[ -]origin|mixed content|content security policy)/iu.test(message)
  ) {
    return 'cross-origin';
  }
  if (kind === 'resource-error' && message && /https?:\/\//iu.test(message)) {
    return 'external-resource';
  }
  return null;
}

function getProjectDiagnosticTitle(
  kind: ProjectPreviewDiagnosticKind,
  message: string | null,
  t: ReturnType<typeof useI18n>['t']
): string {
  const category = classifyProjectPreviewDiagnostic(kind, message);
  if (category === 'browser-capability') return t('file.previewBrowserCapabilityError');
  if (category === 'cross-origin') return t('file.previewCrossOriginError');
  if (category === 'external-resource') return t('file.previewExternalResourceError');

  switch (kind) {
    case 'runtime-error':
      return t('file.previewRuntimeError');
    case 'unhandled-rejection':
      return t('file.previewUnhandledRejection');
    case 'resource-error':
      return t('file.previewResourceError');
    case 'handshake-timeout':
      return t('file.previewDiagnosticsUnavailable');
    case 'retry-error':
      return t('file.previewRetryFailed');
  }
}

export function renderProjectContent({
  status,
  url,
  error,
  refreshKey,
  isResizing,
  frameLoadState,
  diagnostic,
  isRetrying,
  canRetry,
  onLoad,
  onRetry,
  t,
  iframeRef,
}: ProjectContentOptions): React.ReactElement {
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
      if (!isManagedPreviewUrl(url)) {
        logger.warn('[LivePreviewPanel] Blocked unmanaged project preview URL:', url);
        return (
          <div className={styles.projectError}>
            <AlertTriangle size={32} className={styles.projectErrorIcon} />
            <span className={styles.projectErrorText}>{t('file.previewStartFailed')}</span>
            {canRetry ? (
              <button className={styles.retryBtn} onClick={onRetry} disabled={isRetrying}>
                <RefreshCw size={14} className={isRetrying ? styles.retrySpinner : undefined} />
                <span>{isRetrying ? t('file.previewRetrying') : t('common.retry')}</span>
              </button>
            ) : (
              <span className={styles.projectRestartHint}>
                {t('file.previewRestartFromFileList')}
              </span>
            )}
          </div>
        );
      }
      return (
        <div className={styles.projectFrameContainer}>
          <iframe
            ref={iframeRef}
            key={refreshKey}
            className={styles.previewFrame}
            sandbox="allow-scripts allow-modals allow-same-origin"
            src={url}
            referrerPolicy="no-referrer"
            title={t('file.projectPreview')}
            onLoad={onLoad}
            style={isResizing ? { pointerEvents: 'none' } : undefined}
          />

          {frameLoadState !== 'ready' && !diagnostic && (
            <div className={styles.frameLoadingOverlay} role="status" aria-live="polite">
              <Loader2 size={28} className={styles.projectSpinner} />
              <span className={styles.projectLoadingText}>
                {frameLoadState === 'loading'
                  ? t('file.loadingProjectPreview')
                  : t('file.checkingPreviewRuntime')}
              </span>
            </div>
          )}

          {diagnostic && (
            <div
              className={cx(
                styles.projectDiagnostic,
                diagnostic.kind === 'handshake-timeout' && styles.projectDiagnosticWarning
              )}
              role={diagnostic.kind === 'handshake-timeout' ? 'status' : 'alert'}
            >
              <AlertTriangle size={18} className={styles.projectDiagnosticIcon} />
              <div className={styles.projectDiagnosticContent}>
                <span className={styles.projectDiagnosticTitle}>
                  {getProjectDiagnosticTitle(diagnostic.kind, diagnostic.message, t)}
                </span>
                <span className={styles.projectDiagnosticDetail}>
                  {diagnostic.message ??
                    (diagnostic.kind === 'handshake-timeout'
                      ? t('file.previewDiagnosticsUnavailableDetail')
                      : t('file.previewRuntimeErrorUnknown'))}
                </span>
              </div>
              {canRetry ? (
                <button
                  className={styles.diagnosticRetryBtn}
                  onClick={onRetry}
                  disabled={isRetrying}
                >
                  <RefreshCw size={14} className={isRetrying ? styles.retrySpinner : undefined} />
                  <span>{isRetrying ? t('file.previewRetrying') : t('common.retry')}</span>
                </button>
              ) : (
                <span className={styles.projectRestartHint}>
                  {t('file.previewRestartFromFileList')}
                </span>
              )}
            </div>
          )}
        </div>
      );

    case 'error':
      if (error.cancelled) return <div />;
      return (
        <div className={styles.projectError}>
          <AlertTriangle size={32} className={styles.projectErrorIcon} />
          <span className={styles.projectErrorText}>
            {error.summary ?? t('file.previewStartFailed')}
          </span>
          {error.detail && <span className={styles.projectErrorDetail}>{error.detail}</span>}
          {canRetry ? (
            <button className={styles.retryBtn} onClick={onRetry} disabled={isRetrying}>
              <RefreshCw size={14} className={isRetrying ? styles.retrySpinner : undefined} />
              <span>{isRetrying ? t('file.previewRetrying') : t('common.retry')}</span>
            </button>
          ) : (
            <span className={styles.projectRestartHint}>
              {t('file.previewRestartFromFileList')}
            </span>
          )}
        </div>
      );

    default:
      return <div />;
  }
}
