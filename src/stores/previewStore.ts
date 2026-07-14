/**
 * PreviewStore - 实时代码预览状态管理
 *
 * 管理右栏 LivePreviewPanel 的状态，支持两种预览模式：
 * 1. HTML 模式（现有）：单文件 HTML 的 srcdoc 渲染
 * 2. Project 模式（新增）：多文件项目通过 Vite Dev Server 渲染
 *
 * 独立于 diffStore，遵循 Single Responsibility 原则。
 * 不做持久化（预览为临时交互状态）。
 */

import { create } from 'zustand';
import { getLogger } from '@services/logger';
import { isManagedPreviewUrl } from '@services/preview/previewUrlPolicy';
import type { ViteServerStatus, TemplateId } from '@services/preview/types';
import { translate } from '@/i18n';

const logger = getLogger('previewStore');

/**
 * Stop the managed project preview without making store actions asynchronous.
 *
 * VitePreviewService synchronizes its state back into this store, so importing it
 * statically would create a module cycle. The deferred import also keeps HTML-only
 * preview paths from eagerly loading the project-preview runtime.
 */
function stopProjectPreviewInBackground(projectRequestId: number): void {
  void import('@services/preview/VitePreviewService')
    .then(({ vitePreviewService }) => vitePreviewService.stopProject(projectRequestId))
    .catch((error: unknown) => {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error';
      logger.warn(
        '[previewStore] Failed to stop the managed project preview:',
        detail.slice(0, 600)
      );
    });
}

/** 预览模式：单文件 HTML 或 Vite 项目 */
export type PreviewMode = 'html' | 'project';

interface PreviewState {
  // --- 通用状态 ---
  /** 预览面板是否激活（控制右栏渲染切换） */
  isPreviewActive: boolean;
  /** 当前预览模式 */
  previewMode: PreviewMode;

  // --- HTML 模式（现有） ---
  /** 当前预览的 HTML 代码内容 */
  previewCode: string | null;
  /** 代码来源标识（用于 UI 显示，如文件名或语言类型） */
  previewTitle: string | null;
  /** HTML 文件所在目录路径，用于解析相对路径资源（图片等） */
  previewBaseDir: string | null;

  // --- Project 模式（新增） ---
  /** Vite Dev Server 预览 URL */
  projectUrl: string | null;
  /** 项目预览状态 */
  projectStatus: ViteServerStatus;
  /** 单调递增的 UI 请求代次，用于使关闭/切换后的异步启动结果失效。 */
  projectRequestId: number;
  /** Whether retrying the current request is safe after it reached the preview service. */
  projectCanRetry: boolean;
  /** 使用的模板 ID */
  projectTemplate: TemplateId | null;
  /** 错误信息 */
  projectError: string | null;
}

interface PreviewActions {
  // --- HTML 模式 ---
  /** 打开 HTML 预览（从代码块或交付物触发） */
  openPreview: (code: string, title?: string, baseDir?: string) => void;

  // --- Project 模式 ---
  /** 设置项目预览状态（由 VitePreviewService 回调驱动） */
  setProjectStatus: (status: ViteServerStatus, error?: string) => void;
  /** 在同一 UI 请求内更新源扫描推断出的模板。 */
  setProjectTemplate: (template: TemplateId) => void;
  /** 设置项目预览 URL（running 状态时调用） */
  setProjectUrl: (url: string, template: TemplateId) => void;
  /** 开始项目预览流程（激活面板 + 设置模式） */
  startProjectPreview: (template: TemplateId) => number;
  /** 判断异步启动流程是否仍对应当前可见的项目预览。 */
  isProjectRequestCurrent: (requestId: number) => boolean;
  /** Mark the current request as eligible for service-backed retry. */
  markProjectRequestSubmitted: (requestId: number) => boolean;
  /** 仅使当前异步项目请求失效；窗口关闭会在等待 service cleanup 前同步调用。 */
  invalidateProjectRequest: () => void;

  // --- 通用 ---
  /** 关闭预览（回到普通/Diff 模式） */
  closePreview: () => void;
}

export const usePreviewStore = create<PreviewState & PreviewActions>((set, get) => ({
  // --- 初始状态 ---
  isPreviewActive: false,
  previewMode: 'html',
  previewCode: null,
  previewTitle: null,
  previewBaseDir: null,
  projectUrl: null,
  projectStatus: 'idle',
  projectRequestId: 0,
  projectCanRetry: false,
  projectTemplate: null,
  projectError: null,

  // --- HTML 模式 Actions ---
  openPreview: (code, title, baseDir) => {
    const resolvedTitle = title ?? translate('file.livePreview');

    // Switching directly from a project preview to an HTML preview must release
    // the managed server even though the preview panel itself stays mounted.
    if (get().previewMode === 'project') {
      get().closePreview();
    }

    set({
      previewCode: code,
      previewTitle: resolvedTitle,
      previewBaseDir: baseDir ?? null,
      previewMode: 'html',
      isPreviewActive: true,
      // 清理 project 状态，避免混淆
      projectUrl: null,
      projectStatus: 'idle',
      projectCanRetry: false,
      projectTemplate: null,
      projectError: null,
    });
    logger.trace(
      '[previewStore] 打开 HTML 预览:',
      resolvedTitle,
      baseDir ? `baseDir=${baseDir}` : ''
    );
  },

  // --- Project 模式 Actions ---
  startProjectPreview: (template) => {
    const currentState = get();
    if (currentState.previewMode === 'project' && currentState.isPreviewActive) {
      stopProjectPreviewInBackground(currentState.projectRequestId);
    }
    const projectRequestId = currentState.projectRequestId + 1;
    set({
      previewMode: 'project',
      isPreviewActive: true,
      projectTemplate: template,
      projectStatus: 'idle',
      projectRequestId,
      projectCanRetry: false,
      projectUrl: null,
      projectError: null,
      // 清理 HTML 状态
      previewCode: null,
      previewTitle: null,
      previewBaseDir: null,
    });
    logger.trace('[previewStore] 开始项目预览, 模板:', template);
    return projectRequestId;
  },

  isProjectRequestCurrent: (requestId) => {
    const state = get();
    return (
      state.isPreviewActive &&
      state.previewMode === 'project' &&
      state.projectRequestId === requestId
    );
  },

  markProjectRequestSubmitted: (requestId) => {
    if (!get().isProjectRequestCurrent(requestId)) {
      return false;
    }

    set({ projectCanRetry: true });
    return true;
  },

  setProjectStatus: (status, error) => {
    set({
      projectStatus: status,
      projectError: error ?? null,
    });
    logger.trace('[previewStore] 项目状态更新:', status, error ?? '');
  },

  invalidateProjectRequest: () => {
    const currentState = get();
    set({
      projectRequestId: currentState.projectRequestId + 1,
      projectUrl: null,
      projectStatus: 'idle',
      projectCanRetry: false,
      projectError: null,
    });
  },

  setProjectTemplate: (template) => {
    set({ projectTemplate: template });
    logger.trace('[previewStore] 项目模板更新:', template);
  },

  setProjectUrl: (url, template) => {
    if (!isManagedPreviewUrl(url)) {
      logger.warn('[previewStore] Blocked unmanaged project preview URL:', url);
      set({
        projectUrl: null,
        projectStatus: 'error',
        projectTemplate: template,
        projectError: null,
      });
      return;
    }

    set({
      projectUrl: url,
      projectStatus: 'running',
      projectTemplate: template,
    });
    logger.trace('[previewStore] 项目 URL:', url);
  },

  // --- 通用 Actions ---
  // 状态重置与服务停止统一从这里触发，确保按钮关闭、切换 Agent、切换
  // HTML 预览等所有调用路径都不会遗留 Vite 进程。
  closePreview: () => {
    const currentState = get();
    if (currentState.previewMode === 'project') {
      stopProjectPreviewInBackground(currentState.projectRequestId);
    }

    set({
      previewCode: null,
      previewTitle: null,
      previewBaseDir: null,
      previewMode: 'html',
      isPreviewActive: false,
      projectUrl: null,
      projectStatus: 'idle',
      projectRequestId: currentState.projectRequestId + 1,
      projectCanRetry: false,
      projectTemplate: null,
      projectError: null,
    });
    logger.trace('[previewStore] 关闭预览');
  },
}));
