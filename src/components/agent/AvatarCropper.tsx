import { useRef, useState, useCallback, useEffect } from 'react';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n } from '@/i18n';
import styles from './AvatarCropper.module.css';

interface AvatarCropperProps {
  /** 原图 base64 data URL */
  imageDataUrl: string;
  /** 导出尺寸（px），默认 128 */
  exportSize?: number;
  /** 裁剪完成回调，返回圆形 WebP base64（不含 data: 前缀） */
  onCrop: (base64: string) => void;
  /** 取消回调 */
  onCancel: () => void;
}

/** 裁剪器内部状态 */
interface CropState {
  /** 缩放倍率 */
  scale: number;
  /** 图片相对于裁剪区域中心的偏移 */
  offsetX: number;
  offsetY: number;
}

const SCALE_STEP = 0.05;

/**
 * AvatarCropper - 圆形头像裁剪器
 *
 * 零依赖 Canvas 组件，核心功能：
 * - 圆形遮罩预览
 * - 鼠标拖拽调整图片位置
 * - 滚轮/按钮缩放
 * - 导出指定尺寸的圆形 WebP
 */
export function AvatarCropper({
  imageDataUrl,
  exportSize = 512,
  onCrop,
  onCancel,
}: AvatarCropperProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [cropState, setCropState] = useState<CropState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  // 动态缩放范围：基于初始缩放值的相对范围
  const initialScaleRef = useRef(1);

  // 裁剪区域大小（Canvas 显示尺寸）
  const CANVAS_SIZE = 240;
  const CIRCLE_RADIUS = CANVAS_SIZE / 2 - 16; // 留出遮罩边距

  // 加载图片
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      // 初始缩放：让图片较短边适配裁剪圆
      const minDim = Math.min(img.width, img.height);
      const initialScale = (CIRCLE_RADIUS * 2) / minDim;
      initialScaleRef.current = initialScale;
      setCropState({ scale: initialScale, offsetX: 0, offsetY: 0 });
    };
    img.src = imageDataUrl;
  }, [imageDataUrl, CIRCLE_RADIUS]);

  // 渲染 Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { scale, offsetX, offsetY } = cropState;
    const centerX = CANVAS_SIZE / 2;
    const centerY = CANVAS_SIZE / 2;

    // 清空
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 绘制图片（居中 + 偏移 + 缩放）
    const drawWidth = img.width * scale;
    const drawHeight = img.height * scale;
    const drawX = centerX - drawWidth / 2 + offsetX;
    const drawY = centerY - drawHeight / 2 + offsetY;
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

    // 绘制半透明遮罩（裁剪圆外的区域）
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    // 用 destination-out 清除圆形区域，露出图片
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(centerX, centerY, CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 绘制圆形边框
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }, [cropState, CANVAS_SIZE, CIRCLE_RADIUS]);

  // 鼠标拖拽
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        offsetX: cropState.offsetX,
        offsetY: cropState.offsetY,
      };
    },
    [cropState.offsetX, cropState.offsetY]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setCropState((prev) => ({
        ...prev,
        offsetX: dragStartRef.current.offsetX + dx,
        offsetY: dragStartRef.current.offsetY + dy,
      }));
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
    const minScale = initialScaleRef.current * 0.5;
    const maxScale = initialScaleRef.current * 4.0;
    setCropState((prev) => ({
      ...prev,
      scale: Math.max(minScale, Math.min(maxScale, prev.scale + delta)),
    }));
  }, []);

  // 导出裁剪结果
  const handleCrop = useCallback(() => {
    const img = imageRef.current;
    if (!img) return;

    // 创建离屏 Canvas 导出圆形图片
    const offCanvas = document.createElement('canvas');
    offCanvas.width = exportSize;
    offCanvas.height = exportSize;
    const ctx = offCanvas.getContext('2d');
    if (!ctx) return;

    const { scale, offsetX, offsetY } = cropState;

    // 裁剪圆形区域的映射比例
    const exportScale = exportSize / (CIRCLE_RADIUS * 2);

    // 圆形裁剪路径
    ctx.beginPath();
    ctx.arc(exportSize / 2, exportSize / 2, exportSize / 2, 0, Math.PI * 2);
    ctx.clip();

    // 绘制图片（映射到导出尺寸）
    const drawWidth = img.width * scale * exportScale;
    const drawHeight = img.height * scale * exportScale;
    const centerX = exportSize / 2;
    const centerY = exportSize / 2;
    const drawX = centerX - drawWidth / 2 + offsetX * exportScale;
    const drawY = centerY - drawHeight / 2 + offsetY * exportScale;
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

    // 导出 WebP base64（512px 尺寸下 0.92 质量约 30-50KB，兼顾分辨率和 DB 存储）
    const dataUrl = offCanvas.toDataURL('image/webp', 0.92);
    // 去掉 data:image/webp;base64, 前缀
    const base64 = dataUrl.split(',')[1];
    if (base64) {
      onCrop(base64);
    }
  }, [cropState, exportSize, CIRCLE_RADIUS, onCrop]);

  // 缩放按钮
  const handleZoomIn = useCallback(() => {
    const maxScale = initialScaleRef.current * 4.0;
    setCropState((prev) => ({
      ...prev,
      scale: Math.min(maxScale, prev.scale + SCALE_STEP),
    }));
  }, []);

  const handleZoomOut = useCallback(() => {
    const minScale = initialScaleRef.current * 0.5;
    setCropState((prev) => ({
      ...prev,
      scale: Math.max(minScale, prev.scale - SCALE_STEP),
    }));
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.title}>{t('agent.settings.cropper.title')}</div>

      {/* 裁剪画布 */}
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className={styles.canvas}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      />

      {/* 缩放控制 */}
      <div className={styles.zoomControls}>
        <Tooltip content={t('chat.zoomOut')}>
          <button className={styles.zoomBtn} onClick={handleZoomOut} aria-label={t('chat.zoomOut')}>
            −
          </button>
        </Tooltip>
        <span className={styles.zoomLabel}>{Math.round(cropState.scale * 100)}%</span>
        <Tooltip content={t('chat.zoomIn')}>
          <button className={styles.zoomBtn} onClick={handleZoomIn} aria-label={t('chat.zoomIn')}>
            +
          </button>
        </Tooltip>
      </div>

      {/* 操作按钮 */}
      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className={styles.confirmBtn} onClick={handleCrop}>
          {t('common.confirm')}
        </button>
      </div>
    </div>
  );
}
