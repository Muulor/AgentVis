/**
 * InlineGeneratedImages - 内联生成图片展示组件
 *
 * 在 Planning 模式的消息气泡中展示 SA 通过 generate_image 工具生成的图片缩略图。
 * 通过 Rust `file_read_as_base64` 命令读取本地图片文件并构建 data URL 渲染。
 *
 * 设计说明：
 * - 不使用 convertFileSrc()，因为 Tauri 未配置 asset 协议 scope
 * - 采用与 FilePreview.ImagePreview 相同的方式读取图片
 *
 * 功能：
 * - 缩略图网格布局（最多 3 列）
 * - 悬停显示放大提示
 * - 点击触发 Lightbox 大图预览
 * - 图片读取或解码失败时从消息布局中移除
 */

import { useState, useCallback, useMemo, useEffect, memo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ZoomIn, Loader2 } from 'lucide-react';
import { ImageLightbox } from './ImageLightbox';
import {
  addUnavailableImagePath,
  getDisplayableImagePaths,
} from './inlineGeneratedImageVisibility';
import { useI18n } from '@/i18n';
import styles from './InlineGeneratedImages.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('InlineGeneratedImages');

// ==================== 类型定义 ====================

interface InlineGeneratedImagesProps {
  /** SA 生成的图片本地文件路径列表 */
  imagePaths: string[];
}

// ==================== MIME 类型推断 ====================

/**
 * 根据文件扩展名推断 MIME 类型
 *
 * 与 FilePreview.ImagePreview 使用相同的映射表
 */
const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
  return MIME_MAP[ext] ?? 'image/png';
}

/** 缩略图最短边固定尺寸（px） */
const THUMB_MIN_SIDE = 250;
/** 缩略图最大宽度限制（避免极端横图撑破布局） */
const THUMB_MAX_WIDTH = 400;

/** 单张缩略图卡片：通过 Rust 命令读取图片为 base64，根据宽高比智能调整尺寸 */
const ThumbnailCard = memo(function ThumbnailCard({
  filePath,
  onImageClick,
  onUnavailable,
}: {
  filePath: string;
  onImageClick: (src: string, name: string) => void;
  onUnavailable: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  // 动态计算的容器尺寸（根据图片原始宽高比）
  const [cardSize, setCardSize] = useState<{ width: number; height: number }>({
    width: THUMB_MIN_SIDE,
    height: THUMB_MIN_SIDE,
  });

  // 从文件路径中提取文件名
  const fileName = useMemo(
    () => filePath.split(/[\\/]/).pop() ?? t('chat.imageGenerated'),
    [filePath, t]
  );

  // 通过 Rust 命令读取图片文件为 base64 data URL，并检测原始宽高比
  useEffect(() => {
    let cancelled = false;
    let imageProbe: HTMLImageElement | null = null;

    setImageSrc(null);
    setCardSize({ width: THUMB_MIN_SIDE, height: THUMB_MIN_SIDE });

    const mimeType = getMimeType(filePath);

    void invoke<string>('file_read_as_base64', { path: filePath })
      .then((base64) => {
        if (cancelled) return;

        const dataUrl = `data:${mimeType};base64,${base64}`;
        // 使用 Image 对象检测原始宽高比，动态计算缩略图尺寸
        const img = new Image();
        imageProbe = img;
        img.onload = () => {
          if (cancelled) return;

          const { naturalWidth, naturalHeight } = img;
          const aspectRatio = naturalWidth / naturalHeight;

          let width: number;
          let height: number;

          if (aspectRatio > 1) {
            // 横图：高度固定，宽度按比例
            height = THUMB_MIN_SIDE;
            width = Math.min(Math.round(height * aspectRatio), THUMB_MAX_WIDTH);
          } else if (aspectRatio < 1) {
            // 竖图：宽度固定，高度按比例
            width = THUMB_MIN_SIDE;
            height = Math.round(width / aspectRatio);
          } else {
            // 正方形
            width = THUMB_MIN_SIDE;
            height = THUMB_MIN_SIDE;
          }

          setCardSize({ width, height });
          setImageSrc(dataUrl);
        };
        img.onerror = () => {
          if (!cancelled) onUnavailable(filePath);
        };
        img.src = dataUrl;
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        logger.warn('[InlineGeneratedImages] 读取图片失败:', filePath, error);
        onUnavailable(filePath);
      });

    return () => {
      cancelled = true;
      if (imageProbe) {
        imageProbe.onload = null;
        imageProbe.onerror = null;
      }
    };
  }, [filePath, onUnavailable]);

  // 加载中
  if (!imageSrc) {
    return (
      <div className={styles.thumbnailLoading}>
        <Loader2 size={18} className={styles.spinner} />
      </div>
    );
  }

  return (
    <div
      className={styles.thumbnailCard}
      style={{ width: cardSize.width, height: cardSize.height }}
      onClick={() => onImageClick(imageSrc, fileName)}
      title={t('chat.openImageLarge')}
    >
      <img
        src={imageSrc}
        alt={fileName}
        className={styles.thumbnailImage}
        loading="lazy"
        onError={() => onUnavailable(filePath)}
      />
      <div className={styles.thumbnailOverlay}>
        <ZoomIn size={16} />
      </div>
    </div>
  );
});

// ==================== 主组件 ====================

export const InlineGeneratedImages = memo(function InlineGeneratedImages({
  imagePaths,
}: InlineGeneratedImagesProps) {
  const { t } = useI18n();
  const [unavailablePaths, setUnavailablePaths] = useState<ReadonlySet<string>>(() => new Set());
  // Lightbox 状态
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxName, setLightboxName] = useState(t('chat.imageGenerated'));

  const handleImageClick = useCallback((src: string, name: string) => {
    setLightboxSrc(src);
    setLightboxName(name);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxSrc(null);
  }, []);

  const handleImageUnavailable = useCallback((filePath: string) => {
    setUnavailablePaths((current) => addUnavailableImagePath(current, filePath));
  }, []);

  const displayableImagePaths = useMemo(
    () => getDisplayableImagePaths(imagePaths, unavailablePaths),
    [imagePaths, unavailablePaths]
  );

  if (displayableImagePaths.length === 0) return null;

  return (
    <>
      <div className={styles.container}>
        <div className={styles.grid}>
          {displayableImagePaths.map((path) => (
            <ThumbnailCard
              key={path}
              filePath={path}
              onImageClick={handleImageClick}
              onUnavailable={handleImageUnavailable}
            />
          ))}
        </div>
      </div>

      {/* Lightbox 全屏预览 */}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} fileName={lightboxName} onClose={closeLightbox} />
      )}
    </>
  );
});
