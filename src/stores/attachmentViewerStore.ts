/**
 * attachmentViewerStore - 附件查看器状态管理
 *
 * 功能：
 * - 管理图片 Lightbox 的打开/关闭状态
 * - 支持多图片轮播（左右箭头切换）
 * - 管理右栏文档预览的触发
 */

import { create } from 'zustand';
import type { AttachmentInfo } from '@/types/message';

// ==================== 类型定义 ====================

interface AttachmentViewerState {
  /** 当前 Lightbox 中的所有图片列表 */
  lightboxImages: AttachmentInfo[];

  /** 当前显示的图片索引 */
  lightboxIndex: number;

  /** 当前预览的文档附件（用于右栏 FilePreview） */
  previewDocument: AttachmentInfo | null;

  /** 按上下文 ID（Agent/Hub）存储的附件列表 */
  attachmentsByContext: Record<string, AttachmentInfo[]>;

  /** 按上下文 ID 存储的当前预览附件 ID */
  previewByContext: Record<string, string>;

  /** 当前预览面板显示的上下文 ID */
  currentPreviewContextId: string | null;

  /** 清空预览信号（用于通知组件清空本地预览状态） */
  clearPreviewSignal: number;
}

interface AttachmentViewerActions {
  /** 打开图片 Lightbox（支持单图或多图） */
  openImageLightbox: (attachment: AttachmentInfo, allImages?: AttachmentInfo[]) => void;

  /** 关闭图片 Lightbox */
  closeImageLightbox: () => void;

  /** 切换到上一张图片 */
  goToPrevImage: () => void;

  /** 切换到下一张图片 */
  goToNextImage: () => void;

  /** 跳转到指定索引的图片 */
  goToImage: (index: number) => void;

  /** 设置文档预览（通知右栏打开） */
  setDocumentPreview: (attachment: AttachmentInfo) => void;

  /** 清除文档预览 */
  clearDocumentPreview: () => void;

  /** 设置指定上下文的附件列表 */
  setContextAttachments: (contextId: string, attachments: AttachmentInfo[]) => void;

  /** 清空指定上下文的附件 */
  clearContextAttachments: (contextId: string) => void;

  /** 设置当前预览的上下文 ID */
  setCurrentPreviewContext: (contextId: string | null) => void;

  /** 获取指定上下文的附件列表 */
  getContextAttachments: (contextId: string) => AttachmentInfo[];

  /** 触发清空预览信号（通知组件清空本地状态） */
  triggerClearPreview: () => void;
}

// ==================== Store 实现 ====================

export const useAttachmentViewerStore = create<AttachmentViewerState & AttachmentViewerActions>(
  (set, get) => ({
    // 初始状态
    lightboxImages: [],
    lightboxIndex: 0,
    previewDocument: null,
    attachmentsByContext: {},
    previewByContext: {},
    currentPreviewContextId: null,
    clearPreviewSignal: 0,

    // 打开图片 Lightbox
    // 如果提供了 allImages，则启用多图轮播模式
    openImageLightbox: (attachment, allImages) => {
      if (allImages && allImages.length > 0) {
        // 多图模式：找到当前图片在列表中的索引
        const index = allImages.findIndex((img) => img.id === attachment.id);
        set({
          lightboxImages: allImages,
          lightboxIndex: index >= 0 ? index : 0,
        });
      } else {
        // 单图模式
        set({
          lightboxImages: [attachment],
          lightboxIndex: 0,
        });
      }
    },

    // 关闭图片 Lightbox
    closeImageLightbox: () => {
      set({ lightboxImages: [], lightboxIndex: 0 });
    },

    // 切换到上一张图片
    goToPrevImage: () => {
      const { lightboxImages, lightboxIndex } = get();
      if (lightboxImages.length <= 1) return;
      const newIndex = lightboxIndex > 0 ? lightboxIndex - 1 : lightboxImages.length - 1;
      set({ lightboxIndex: newIndex });
    },

    // 切换到下一张图片
    goToNextImage: () => {
      const { lightboxImages, lightboxIndex } = get();
      if (lightboxImages.length <= 1) return;
      const newIndex = (lightboxIndex + 1) % lightboxImages.length;
      set({ lightboxIndex: newIndex });
    },

    // 跳转到指定索引
    goToImage: (index) => {
      const { lightboxImages } = get();
      if (index >= 0 && index < lightboxImages.length) {
        set({ lightboxIndex: index });
      }
    },

    // 设置文档预览
    setDocumentPreview: (attachment) => {
      set({ previewDocument: attachment });
    },

    // 清除文档预览
    clearDocumentPreview: () => {
      set({ previewDocument: null });
    },

    // 设置指定上下文的附件列表
    setContextAttachments: (contextId, attachments) => {
      set((state) => ({
        attachmentsByContext: {
          ...state.attachmentsByContext,
          [contextId]: attachments,
        },
      }));
    },

    // 清空指定上下文的附件
    clearContextAttachments: (contextId) => {
      set((state) => {
        const newAttachments = { ...state.attachmentsByContext };
        Reflect.deleteProperty(newAttachments, contextId);
        return { attachmentsByContext: newAttachments };
      });
    },

    // 设置当前预览的上下文 ID
    setCurrentPreviewContext: (contextId) => {
      set({ currentPreviewContextId: contextId });
    },

    // 获取指定上下文的附件列表
    getContextAttachments: (contextId) => {
      return get().attachmentsByContext[contextId] ?? [];
    },

    // 触发清空预览信号（增加计数器通知组件清空本地状态）
    triggerClearPreview: () => {
      set((state) => ({ clearPreviewSignal: state.clearPreviewSignal + 1 }));
    },
  })
);

// ==================== 便捷选择器 ====================

/** 获取当前 Lightbox 图片 */
export const selectLightboxImage = (state: AttachmentViewerState) =>
  state.lightboxImages[state.lightboxIndex] ?? null;

/** 获取 Lightbox 图片列表 */
export const selectLightboxImages = (state: AttachmentViewerState) => state.lightboxImages;

/** 获取当前图片索引 */
export const selectLightboxIndex = (state: AttachmentViewerState) => state.lightboxIndex;

/** 获取当前预览文档 */
export const selectPreviewDocument = (state: AttachmentViewerState) => state.previewDocument;
