/**
 * 共享图片附件加载器
 *
 * 为所有 skill（desktop-control、agent-browser、save_browser_image 等）提供统一的
 * 图片文件 → base64 LLM 注入数据的转换管道。
 *
 * 核心能力：
 * - 路径解析：file:// URI、相对路径、Windows/Unix 绝对路径的统一规范化
 * - 格式识别：基于扩展名自动判断 MIME 类型
 * - 智能缩放：高 DPI 截图（如 2880×1800）自动缩放至 ≤MAX_VISION_WIDTH，
 *   让多模态模型在最接近训练分布的分辨率下工作，提升视觉坐标估算精度
 * - 压缩降级：非截图场景（preserveDimensions=false）使用 WebP 有损压缩节省 token
 *
 * 数据流：
 *   磁盘图片 → Rust file_read_image_downscaled_as_base64（可选缩放）→ base64 → LLM content part
 */
import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('imageAttachment');

export interface ToolImageAttachment {
  mimeType: string;
  data: string;
}

export interface LoadedImageAttachment {
  image: ToolImageAttachment;
  path: string;
  compressed: boolean;
}

export interface LoadImageAttachmentOptions {
  /**
   * 保留原始像素尺寸。
   *
   * 桌面/浏览器自动化截图需要让图片像素坐标与屏幕坐标一致，
   * 否则模型按缩放图估算的坐标会直接传给 click，造成偏移。
   */
  preserveDimensions?: boolean;
  /**
   * 保留像素尺寸，仅通过 WebP 有损重编码降低图片体积。
   *
   * 用于桌面/浏览器自动化截图：避免坐标系偏移，同时降低大图触发
   * provider 400 / payload 过大的概率。
   */
  compressPreservingDimensions?: boolean;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const COMPRESSIBLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function getImageExtension(path: string): string {
  const cleanPath = path.split(/[?#]/)[0] ?? path;
  const match = cleanPath.toLowerCase().match(/(\.[^.\\/]+)$/);
  return match?.[1] ?? '';
}

export function isSupportedImagePath(path: string): boolean {
  return getImageExtension(path) in IMAGE_MIME_BY_EXTENSION;
}

export function resolveExternalImagePath(inputPath: string, workdir?: string): string {
  let path = inputPath.trim().replace(/^["']|["']$/g, '');

  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
      if (/^\/[a-zA-Z]:\//.test(path)) {
        path = path.slice(1);
      }
    } catch {
      path = path.replace(/^file:\/+/, '');
    }
  }

  const isWindowsAbsolute = /^[a-zA-Z]:[/\\]/.test(path);
  const isUnixAbsolute = path.startsWith('/');
  if (isWindowsAbsolute || isUnixAbsolute || !workdir) {
    return path;
  }

  const separator = workdir.includes('\\') ? '\\' : '/';
  const normalizedWorkdir =
    workdir.endsWith('\\') || workdir.endsWith('/') ? workdir.slice(0, -1) : workdir;
  const relativePath = path.startsWith('./') || path.startsWith('.\\') ? path.slice(2) : path;

  return `${normalizedWorkdir}${separator}${relativePath}`;
}

export async function loadImageAttachmentFromPath(
  inputPath: string,
  workdir?: string,
  _mimeTypeHint?: string,
  options: LoadImageAttachmentOptions = {}
): Promise<LoadedImageAttachment> {
  const path = resolveExternalImagePath(inputPath, workdir);
  const ext = getImageExtension(path);

  if (!isSupportedImagePath(path)) {
    throw new Error(`Unsupported image format: ${path}`);
  }

  if (
    (options.compressPreservingDimensions || !options.preserveDimensions) &&
    COMPRESSIBLE_IMAGE_EXTENSIONS.has(ext)
  ) {
    const { imageCompressionService } =
      await import('@services/attachment/ImageCompressionService');
    const fileName = path.split(/[\\/]/).pop() ?? 'image.png';
    try {
      const compressed = await imageCompressionService.compressImage(path, fileName, {
        allowOversizeInput: options.compressPreservingDimensions,
        preserveDimensions: options.compressPreservingDimensions,
        quality: options.compressPreservingDimensions ? 0.82 : undefined,
      });
      const base64Data = await imageCompressionService.toBase64(compressed);

      return {
        path,
        compressed: true,
        image: {
          mimeType: 'image/webp',
          data: base64Data,
        },
      };
    } catch (error) {
      if (!options.compressPreservingDimensions) {
        throw error;
      }
      logger.warn('[imageAttachment] 保留尺寸压缩失败，回退到截图读取流程:', error);
    }
  }

  // 桌面/浏览器自动化截图路径：
  // 高 DPI 环境（如 200% 缩放 2880×1800）的原始截图远超多模态模型的训练分布（~1080p），
  // 模型 API 内部会进一步缩放/切片处理，导致视觉坐标估算误差显著增大。
  // 此处主动缩放到 ≤MAX_VISION_WIDTH 宽度，让模型在最优分辨率下工作，
  // 同时 OCR 和坐标输出仍在 Python 侧使用原始物理分辨率运行，互不影响。
  const MAX_VISION_WIDTH = 1920;
  const [base64Data, mimeType, wasDownscaled] = await invoke<[string, string, boolean]>(
    'file_read_image_downscaled_as_base64',
    { path, maxWidth: MAX_VISION_WIDTH }
  );

  if (wasDownscaled) {
    logger.trace(`[imageAttachment] 📐 截图已缩放至 ≤${MAX_VISION_WIDTH}px 宽度: ${path}`);
  }

  return {
    path,
    compressed: wasDownscaled,
    image: {
      mimeType,
      data: base64Data,
    },
  };
}
