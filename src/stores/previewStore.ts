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

const logger = getLogger('previewStore');

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
    /** 设置项目预览 URL（running 状态时调用） */
    setProjectUrl: (url: string, template: TemplateId) => void;
    /** 开始项目预览流程（激活面板 + 设置模式） */
    startProjectPreview: (template: TemplateId) => void;

    // --- 通用 ---
    /** 关闭预览（回到普通/Diff 模式） */
    closePreview: () => void;
}

export const usePreviewStore = create<PreviewState & PreviewActions>((set) => ({
    // --- 初始状态 ---
    isPreviewActive: false,
    previewMode: 'html',
    previewCode: null,
    previewTitle: null,
    previewBaseDir: null,
    projectUrl: null,
    projectStatus: 'idle',
    projectTemplate: null,
    projectError: null,

    // --- HTML 模式 Actions ---
    openPreview: (code, title = 'HTML Preview', baseDir) => {
        set({
            previewCode: code,
            previewTitle: title,
            previewBaseDir: baseDir ?? null,
            previewMode: 'html',
            isPreviewActive: true,
            // 清理 project 状态，避免混淆
            projectUrl: null,
            projectStatus: 'idle',
            projectTemplate: null,
            projectError: null,
        });
        logger.trace('[previewStore] 打开 HTML 预览:', title, baseDir ? `baseDir=${baseDir}` : '');
    },

    // --- Project 模式 Actions ---
    startProjectPreview: (template) => {
        set({
            previewMode: 'project',
            isPreviewActive: true,
            projectTemplate: template,
            projectStatus: 'idle',
            projectUrl: null,
            projectError: null,
            // 清理 HTML 状态
            previewCode: null,
            previewTitle: null,
            previewBaseDir: null,
        });
        logger.trace('[previewStore] 开始项目预览, 模板:', template);
    },

    setProjectStatus: (status, error) => {
        set({
            projectStatus: status,
            projectError: error ?? null,
        });
        logger.trace('[previewStore] 项目状态更新:', status, error ?? '');
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
    // 纯状态重置，不负责停止 Vite 进程。
    // 停止进程的职责统一在 LivePreviewPanel.handleClose 中，
    // 避免与 UI 层的 stopProject 调用产生重复清理。
    closePreview: () => {
        set({
            previewCode: null,
            previewTitle: null,
            previewBaseDir: null,
            previewMode: 'html',
            isPreviewActive: false,
            projectUrl: null,
            projectStatus: 'idle',
            projectTemplate: null,
            projectError: null,
        });
        logger.trace('[previewStore] 关闭预览');
    },
}));
