/**
 * InlineGeneratedImages - 内联生成图片画廊组件
 *
 * 在 Planning 模式的消息气泡中展示 SA 通过 generate_image 工具生成的图片。
 * 通过 Rust `file_read_as_base64` 命令读取本地文件，并将所有可用图片收敛到
 * 一个固定高度的主预览区中，支持左右翻页与 Lightbox 大图查看。
 *
 * 设计说明：
 * - 不使用 convertFileSrc()，因为 Tauri 未配置 asset 协议 scope
 * - 所有图片仍会并行读取和解码，失败项会从画廊、计数及 Lightbox 导航中移除
 * - 消息内只渲染一张主预览，避免生成图片较多时线性撑高聊天记录
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, Loader2, ZoomIn } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n } from '@/i18n';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { ImageLightbox } from './ImageLightbox';
import {
  addUnavailableImagePath,
  getAdjacentImagePath,
  getDisplayableImagePaths,
  getImageGalleryNavigationState,
  resolveActiveImagePath,
} from './inlineGeneratedImageVisibility';
import styles from './InlineGeneratedImages.module.css';

const logger = getLogger('InlineGeneratedImages');

interface InlineGeneratedImagesProps {
  /** SA 生成的图片本地文件路径列表 */
  imagePaths: string[];
}

interface LoadedImage {
  filePath: string;
  fileName: string;
  src: string;
}

interface ImageResourceLoaderProps {
  filePath: string;
  onLoaded: (image: LoadedImage) => void;
  onUnavailable: (filePath: string) => void;
}

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

/**
 * 仅负责读取和解码图片资源，不产生可见 DOM。
 * 保持所有路径并行验证，确保失效图片能在用户翻页前被移出画廊。
 */
const ImageResourceLoader = memo(function ImageResourceLoader({
  filePath,
  onLoaded,
  onUnavailable,
}: ImageResourceLoaderProps) {
  const { t } = useI18n();
  const fileName = useMemo(
    () => filePath.split(/[\\/]/).pop() ?? t('chat.imageGenerated'),
    [filePath, t]
  );

  useEffect(() => {
    let cancelled = false;
    let imageProbe: HTMLImageElement | null = null;

    void invoke<string>('file_read_as_base64', { path: filePath })
      .then((base64) => {
        if (cancelled) return;

        const src = `data:${getMimeType(filePath)};base64,${base64}`;
        const probe = new Image();
        imageProbe = probe;
        probe.onload = () => {
          if (!cancelled) {
            onLoaded({ filePath, fileName, src });
          }
        };
        probe.onerror = () => {
          if (!cancelled) onUnavailable(filePath);
        };
        probe.src = src;
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
  }, [fileName, filePath, onLoaded, onUnavailable]);

  return null;
});

export const InlineGeneratedImages = memo(function InlineGeneratedImages({
  imagePaths,
}: InlineGeneratedImagesProps) {
  const { t } = useI18n();
  const [unavailablePaths, setUnavailablePaths] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedImages, setLoadedImages] = useState<ReadonlyMap<string, LoadedImage>>(
    () => new Map()
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);

  const handleImageLoaded = useCallback((image: LoadedImage) => {
    setLoadedImages((current) => {
      const existing = current.get(image.filePath);
      if (existing?.src === image.src) return current;

      const next = new Map(current);
      next.set(image.filePath, image);
      return next;
    });
  }, []);

  const handleImageUnavailable = useCallback((filePath: string) => {
    setUnavailablePaths((current) => addUnavailableImagePath(current, filePath));
    setLoadedImages((current) => {
      if (!current.has(filePath)) return current;

      const next = new Map(current);
      next.delete(filePath);
      return next;
    });
  }, []);

  const displayableImagePaths = useMemo(
    () => getDisplayableImagePaths(imagePaths, unavailablePaths),
    [imagePaths, unavailablePaths]
  );
  const loadedImagePaths = useMemo(
    () => displayableImagePaths.filter((filePath) => loadedImages.has(filePath)),
    [displayableImagePaths, loadedImages]
  );
  const navigation = getImageGalleryNavigationState(loadedImagePaths, activePath);
  const resolvedActivePath = navigation.activePath;
  const activeIndex = navigation.currentIndex;
  const activeImage = resolvedActivePath ? loadedImages.get(resolvedActivePath) : undefined;
  const hasPrev = navigation.hasPrevious;
  const hasNext = navigation.hasNext;

  useEffect(() => {
    setActivePath((current) => resolveActiveImagePath(loadedImagePaths, current));
  }, [loadedImagePaths]);

  useEffect(() => {
    if (lightboxPath && !loadedImages.has(lightboxPath)) {
      setLightboxPath(null);
    }
  }, [lightboxPath, loadedImages]);

  const showPrevious = useCallback(() => {
    const previousPath = getAdjacentImagePath(loadedImagePaths, resolvedActivePath, -1);
    if (previousPath) setActivePath(previousPath);
  }, [loadedImagePaths, resolvedActivePath]);

  const showNext = useCallback(() => {
    const nextPath = getAdjacentImagePath(loadedImagePaths, resolvedActivePath, 1);
    if (nextPath) setActivePath(nextPath);
  }, [loadedImagePaths, resolvedActivePath]);

  const handleGalleryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft' && hasPrev) {
        event.preventDefault();
        showPrevious();
      } else if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        showNext();
      }
    },
    [hasNext, hasPrev, showNext, showPrevious]
  );

  const lightboxIndex = lightboxPath ? loadedImagePaths.indexOf(lightboxPath) : -1;
  const lightboxImage = lightboxPath ? loadedImages.get(lightboxPath) : undefined;
  const showPreviousInLightbox = useCallback(() => {
    const previousPath = getAdjacentImagePath(loadedImagePaths, lightboxPath, -1);
    if (previousPath) {
      setLightboxPath(previousPath);
      setActivePath(previousPath);
    }
  }, [lightboxPath, loadedImagePaths]);
  const showNextInLightbox = useCallback(() => {
    const nextPath = getAdjacentImagePath(loadedImagePaths, lightboxPath, 1);
    if (nextPath) {
      setLightboxPath(nextPath);
      setActivePath(nextPath);
    }
  }, [lightboxPath, loadedImagePaths]);

  if (displayableImagePaths.length === 0) return null;

  return (
    <>
      {displayableImagePaths.map((filePath) => (
        <ImageResourceLoader
          key={filePath}
          filePath={filePath}
          onLoaded={handleImageLoaded}
          onUnavailable={handleImageUnavailable}
        />
      ))}

      <div className={styles.container}>
        <div
          className={styles.gallery}
          role="region"
          aria-label={t('chat.imageGenerated')}
          tabIndex={0}
          onKeyDown={handleGalleryKeyDown}
        >
          {activeImage ? (
            <Tooltip content={t('chat.openImageLarge')}>
              <button
                type="button"
                className={styles.previewButton}
                onClick={() => setLightboxPath(activeImage.filePath)}
                aria-label={t('chat.openImageLarge')}
              >
                <img
                  key={activeImage.filePath}
                  src={activeImage.src}
                  alt={activeImage.fileName}
                  className={styles.previewImage}
                  draggable={false}
                  onError={() => handleImageUnavailable(activeImage.filePath)}
                />
                <span className={styles.previewOverlay} aria-hidden="true">
                  <ZoomIn size={20} />
                </span>
              </button>
            </Tooltip>
          ) : (
            <div className={styles.loading} role="status" aria-label={t('common.loading')}>
              <Loader2 size={22} className={styles.spinner} />
            </div>
          )}

          {loadedImagePaths.length > 1 && (
            <>
              <Tooltip content={t('chat.imagePrev')} side="right">
                <button
                  type="button"
                  className={cx(styles.navButton, styles.navPrevious)}
                  onClick={showPrevious}
                  disabled={!hasPrev}
                  aria-label={t('chat.imagePrev')}
                >
                  <ChevronLeft size={26} />
                </button>
              </Tooltip>
              <Tooltip content={t('chat.imageNext')} side="left">
                <button
                  type="button"
                  className={cx(styles.navButton, styles.navNext)}
                  onClick={showNext}
                  disabled={!hasNext}
                  aria-label={t('chat.imageNext')}
                >
                  <ChevronRight size={26} />
                </button>
              </Tooltip>
              <span className={styles.counter} aria-live="polite">
                {activeIndex + 1} / {loadedImagePaths.length}
              </span>
            </>
          )}
        </div>
      </div>

      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          fileName={lightboxImage.fileName}
          onClose={() => setLightboxPath(null)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex >= 0 && lightboxIndex < loadedImagePaths.length - 1}
          onPrev={showPreviousInLightbox}
          onNext={showNextInLightbox}
          currentIndex={lightboxIndex}
          totalCount={loadedImagePaths.length}
        />
      )}
    </>
  );
});
