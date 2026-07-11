/**
 * ImageCompressionService - 图片压缩服务
 *
 * 功能：
 * - 长边缩放（>2048px → 2048px，<512px 保持原样）
 * - WebP 格式转换 + 80% 质量压缩
 * - 5MB 文件大小限制检测
 *
 * 使用 browser-image-compression 库基于 Canvas API 实现
 */

import imageCompression from 'browser-image-compression';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('ImageCompressionService');

// ==================== 常量定义 ====================

/** 长边最大尺寸限制 */
const MAX_DIMENSION = 2048;

/** 长边最小尺寸阈值（低于此值不缩放） */
const MIN_DIMENSION = 512;

/** WebP 输出质量（0-1） */
const WEBP_QUALITY = 0.9;

/** 文件大小上限（5MB，单位：字节） */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** 压缩错误码 */
export const CompressionErrorCode = {
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  COMPRESSION_FAILED: 'COMPRESSION_FAILED',
} as const;

// ==================== 类型定义 ====================

/** 压缩结果 */
export interface CompressedImageResult {
  /** 压缩后的 Blob 数据 */
  blob: Blob;
  /** 压缩后的文件名（可能后缀改为 .webp） */
  fileName: string;
  /** 压缩后的 MIME 类型 */
  mimeType: string;
  /** 原始文件大小（字节） */
  originalSize: number;
  /** 压缩后大小（字节） */
  compressedSize: number;
  /** 是否进行了缩放 */
  wasResized: boolean;
  /** 是否进行了格式转换 */
  wasConverted: boolean;
}

/** 压缩选项 */
export interface ImageCompressionOptions {
  /**
   * 是否允许原始图片超过上传限制后继续压缩。
   *
   * 用户上传路径保持默认 false，用于阻止过大的外部文件；系统生成图片写入
   * 多模态历史时可设为 true，把大图压缩为适合 LLM 注入的版本。
   */
  allowOversizeInput?: boolean;
  /**
   * 保留原始像素尺寸，仅通过格式转换/质量参数压缩容量。
   *
   * 桌面/浏览器自动化截图需要让视觉坐标与真实屏幕坐标尽量一致，
   * 因此不能为了降体积缩放宽高。
   */
  preserveDimensions?: boolean;
  /**
   * 输出质量（0-1）。默认使用全局 WebP 质量。
   */
  quality?: number;
}

/** 压缩错误 */
export class ImageCompressionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImageCompressionError';
    this.code = code;
  }
}

// ==================== 工具函数 ====================

/**
 * 从文件路径中获取图片的 Blob 数据
 * 需要通过 Tauri 后端读取文件
 */
async function readFileAsBlob(filePath: string): Promise<{ blob: Blob; mimeType: string }> {
  const { invoke } = await import('@tauri-apps/api/core');

  // 读取文件的 base64 数据
  const base64Data = await invoke<string>('file_read_as_base64', { path: filePath });

  // 从文件扩展名推断 MIME 类型
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeTypeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heif: 'image/heif',
    heic: 'image/heic',
  };
  const mimeType = mimeTypeMap[ext] ?? 'image/jpeg';

  // base64 转 Blob
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  return { blob, mimeType };
}

/**
 * 获取图片的实际尺寸
 */
async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * 将 Blob 转换为 File 对象
 */
function blobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type });
}

/**
 * 更新文件扩展名
 */
function updateFileExtension(fileName: string, newExt: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1) {
    return `${fileName}.${newExt}`;
  }
  return `${fileName.substring(0, lastDot)}.${newExt}`;
}

// ==================== 主服务类 ====================

/**
 * ImageCompressionService 图片压缩服务
 */
export class ImageCompressionService {
  /**
   * 压缩图片
   *
   * @param filePath - 原始图片文件路径
   * @param fileName - 原始文件名
   * @returns 压缩结果
   * @throws ImageCompressionError - 文件过大或压缩失败
   */
  async compressImage(
    filePath: string,
    fileName: string,
    options: ImageCompressionOptions = {}
  ): Promise<CompressedImageResult> {
    // 1. 读取原始文件
    let { blob: originalBlob, mimeType: originalMimeType } = await readFileAsBlob(filePath);
    const originalSize = originalBlob.size;
    let currentFileName = fileName;

    // 2. 检查文件大小（5MB 限制）
    if (originalSize > MAX_FILE_SIZE && !options.allowOversizeInput) {
      throw new ImageCompressionError(
        CompressionErrorCode.FILE_TOO_LARGE,
        translate('chat.imageTooLargeError', { size: (originalSize / 1024 / 1024).toFixed(1) })
      );
    }

    // 3. HEIF/HEIC 格式转换（浏览器不原生支持，需要先转换为 JPEG）
    if (originalMimeType === 'image/heif' || originalMimeType === 'image/heic') {
      logger.trace(`[ImageCompression] 检测到 HEIF/HEIC 格式，正在转换为 JPEG...`);
      try {
        const heic2any = (await import('heic2any')).default;
        const convertedBlob = await heic2any({
          blob: originalBlob,
          toType: 'image/jpeg',
          quality: 0.9, // 高质量转换，后续还会压缩
        });

        // heic2any 可能返回单个 Blob 或 Blob 数组
        if (Array.isArray(convertedBlob)) {
          const firstBlob = convertedBlob[0];
          if (!firstBlob) {
            throw new ImageCompressionError('HEIC_CONVERSION_EMPTY', 'HEIC 转换结果为空');
          }
          originalBlob = firstBlob;
        } else {
          originalBlob = convertedBlob;
        }
        originalMimeType = 'image/jpeg';
        currentFileName = updateFileExtension(fileName, 'jpg');

        logger.trace(
          `[ImageCompression] HEIF→JPEG 转换完成: ${(originalBlob.size / 1024).toFixed(1)}KB`
        );
      } catch (error) {
        logger.error('[ImageCompression] HEIF 转换失败:', error);
        throw new ImageCompressionError(
          CompressionErrorCode.COMPRESSION_FAILED,
          translate('chat.heifConversionFailedDescription', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }

    // 4. 获取图片尺寸
    const { width, height } = await getImageDimensions(originalBlob);
    const longEdge = Math.max(width, height);

    logger.trace(
      `[ImageCompression] 原始图片: ${width}x${height}, 长边=${longEdge}px, 大小=${(originalSize / 1024).toFixed(1)}KB`
    );

    // 5. 判断是否需要缩放
    let maxWidthOrHeight: number | undefined;
    let wasResized = false;

    if (options.preserveDimensions) {
      maxWidthOrHeight = longEdge;
      logger.trace(`[ImageCompression] 保留原始尺寸，仅压缩质量: ${width}x${height}`);
    } else if (longEdge > MAX_DIMENSION) {
      // 长边 > 2048px：需要缩放
      maxWidthOrHeight = MAX_DIMENSION;
      wasResized = true;
      logger.trace(`[ImageCompression] 需要缩放: ${longEdge}px → ${MAX_DIMENSION}px`);
    } else if (longEdge < MIN_DIMENSION) {
      // 长边 < 512px：保持原样（不设置 maxWidthOrHeight）
      maxWidthOrHeight = longEdge; // 保持原尺寸
      logger.trace(`[ImageCompression] 小图保持原样: ${longEdge}px < ${MIN_DIMENSION}px`);
    } else {
      // 512px ≤ 长边 ≤ 2048px：不缩放
      maxWidthOrHeight = longEdge;
      logger.trace(`[ImageCompression] 尺寸在正常范围内，不缩放`);
    }

    // 6. 判断是否需要格式转换
    const isWebP = originalMimeType === 'image/webp';
    const wasConverted = !isWebP;
    const outputMimeType = 'image/webp';
    const outputFileName = isWebP ? currentFileName : updateFileExtension(currentFileName, 'webp');

    if (wasConverted) {
      logger.trace(`[ImageCompression] 格式转换: ${originalMimeType} → ${outputMimeType}`);
    }

    // 7. 执行压缩
    try {
      const file = blobToFile(originalBlob, currentFileName);

      const compressedBlob = await imageCompression(file, {
        maxWidthOrHeight,
        useWebWorker: true,
        fileType: outputMimeType,
        initialQuality: options.quality ?? WEBP_QUALITY,
      });

      const compressedSize = compressedBlob.size;
      const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);

      logger.trace(
        `[ImageCompression] 压缩完成: ${(compressedSize / 1024).toFixed(1)}KB (节省 ${compressionRatio}%)`
      );

      return {
        blob: compressedBlob,
        fileName: outputFileName,
        mimeType: outputMimeType,
        originalSize,
        compressedSize,
        wasResized,
        wasConverted,
      };
    } catch (error) {
      logger.error('[ImageCompression] 压缩失败:', error);
      throw new ImageCompressionError(
        CompressionErrorCode.COMPRESSION_FAILED,
        translate('chat.imageCompressionFailedDescription', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  /**
   * 将压缩结果转为 base64 字符串
   *
   * @param result - 压缩结果
   * @returns base64 编码字符串（不含 data: 前缀）
   */
  async toBase64(result: CompressedImageResult): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        // 移除 data:image/webp;base64, 前缀
        const base64Data = base64.split(',')[1] ?? base64;
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(result.blob);
    });
  }
}

// ==================== 导出单例 ====================

export const imageCompressionService = new ImageCompressionService();
