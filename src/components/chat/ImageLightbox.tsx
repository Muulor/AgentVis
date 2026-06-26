/**
 * ImageLightbox - 图片灯箱预览组件
 * 
 * 功能：
 * - 全屏半透明遮罩 + 居中图片
 * - 支持鼠标滚轮缩放（1x - 5x）
 * - 支持拖拽平移（缩放 > 1x 时）
 * - ESC 或点击遮罩关闭
 * - 支持多图片轮播（左右箭头切换）
 * - 底部显示文件名和图片计数
 */

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ImageLightbox.module.css';

// ==================== 类型定义 ====================

interface ImageLightboxProps {
    /** 图片源（可以是 base64 或文件路径） */
    src: string;
    /** 文件名 */
    fileName: string;
    /** 关闭回调 */
    onClose: () => void;
    /** 是否有上一张图片 */
    hasPrev?: boolean;
    /** 是否有下一张图片 */
    hasNext?: boolean;
    /** 切换到上一张 */
    onPrev?: () => void;
    /** 切换到下一张 */
    onNext?: () => void;
    /** 当前图片索引（用于显示计数） */
    currentIndex?: number;
    /** 总图片数量 */
    totalCount?: number;
}

// ==================== 常量 ====================

/** 最小缩放倍数 */
const MIN_SCALE = 1;
/** 最大缩放倍数 */
const MAX_SCALE = 5;
/** 缩放步进 */
const SCALE_STEP = 0.25;

// ==================== 组件实现 ====================

export const ImageLightbox = memo(function ImageLightbox({
    src,
    fileName,
    onClose,
    hasPrev = false,
    hasNext = false,
    onPrev,
    onNext,
    currentIndex,
    totalCount,
}: ImageLightboxProps) {
    const { t } = useI18n();
    // 缩放和平移状态
    const [scale, setScale] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef({ x: 0, y: 0 });
    const positionStartRef = useRef({ x: 0, y: 0 });

    // 切换图片时重置状态
    useEffect(() => {
        setScale(1);
        setRotation(0);
        setPosition({ x: 0, y: 0 });
    }, [src]);


    // ESC 关闭
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    // 鼠标滚轮缩放 - 使用 useEffect 添加非 passive 事件监听器
    // React 的 onWheel 默认是 passive 的，无法调用 preventDefault
    const imageContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = imageContainerRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
            setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta)));
        };

        // 添加非 passive 的事件监听器
        container.addEventListener('wheel', handleWheel, { passive: false });

        return () => {
            container.removeEventListener('wheel', handleWheel);
        };
    }, []);

    // 缩放按钮
    const handleZoomIn = useCallback(() => {
        setScale(prev => Math.min(MAX_SCALE, prev + SCALE_STEP));
    }, []);

    const handleZoomOut = useCallback(() => {
        setScale(prev => Math.max(MIN_SCALE, prev - SCALE_STEP));
    }, []);

    // 旋转
    const handleRotate = useCallback(() => {
        setRotation(prev => (prev + 90) % 360);
    }, []);

    // 重置
    const handleReset = useCallback(() => {
        setScale(1);
        setRotation(0);
        setPosition({ x: 0, y: 0 });
    }, []);

    // 拖拽开始
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (scale <= 1) return; // 未缩放时不支持拖拽
        e.preventDefault();
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        positionStartRef.current = { ...position };
    }, [scale, position]);

    // 拖拽移动
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        setPosition({
            x: positionStartRef.current.x + dx,
            y: positionStartRef.current.y + dy,
        });
    }, [isDragging]);

    // 拖拽结束
    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    // 点击遮罩关闭（但不包括图片区域）
    const handleOverlayClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }, [onClose]);

    // 键盘左右箭头切换图片
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft' && hasPrev && onPrev) {
                e.preventDefault();
                onPrev();
            } else if (e.key === 'ArrowRight' && hasNext && onNext) {
                e.preventDefault();
                onNext();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [hasPrev, hasNext, onPrev, onNext]);

    // 是否显示导航箭头（多图模式）
    const showNavigation = hasPrev || hasNext;

    return (
        <div
            className={styles.overlay}
            onClick={handleOverlayClick}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
            {/* 关闭按钮 */}
            <button
                className={styles.closeButton}
                onClick={onClose}
                aria-label={t('common.close')}
                title={t('chat.imageCloseTitle')}
            >
                <X size={24} />
            </button>

            {/* 左侧导航箭头 */}
            {showNavigation && (
                <button
                    className={cx(styles.navButton, styles.navPrev)}
                    onClick={(e) => { e.stopPropagation(); onPrev?.(); }}
                    disabled={!hasPrev}
                    aria-label={t('chat.imagePrev')}
                    title={t('chat.imagePrevTitle')}
                >
                    <ChevronLeft size={40} />
                </button>
            )}

            {/* 右侧导航箭头 */}
            {showNavigation && (
                <button
                    className={cx(styles.navButton, styles.navNext)}
                    onClick={(e) => { e.stopPropagation(); onNext?.(); }}
                    disabled={!hasNext}
                    aria-label={t('chat.imageNext')}
                    title={t('chat.imageNextTitle')}
                >
                    <ChevronRight size={40} />
                </button>
            )}

            {/* 工具栏 */}
            <div className={styles.toolbar} onClick={(e) => e.stopPropagation()}>
                <button
                    className={styles.toolButton}
                    onClick={handleZoomOut}
                    disabled={scale <= MIN_SCALE}
                    title={t('chat.zoomOut')}
                >
                    <ZoomOut size={18} />
                </button>
                <span className={styles.scaleLabel}>{Math.round(scale * 100)}%</span>
                <button
                    className={styles.toolButton}
                    onClick={handleZoomIn}
                    disabled={scale >= MAX_SCALE}
                    title={t('chat.zoomIn')}
                >
                    <ZoomIn size={18} />
                </button>
                <div className={styles.divider} />
                <button
                    className={styles.toolButton}
                    onClick={handleRotate}
                    title={t('chat.rotate90')}
                >
                    <RotateCw size={18} />
                </button>
                <button
                    className={styles.toolButton}
                    onClick={handleReset}
                    title={t('chat.reset')}
                >
                    {t('chat.reset')}
                </button>
            </div>

            {/* 图片容器 */}
            <div
                ref={imageContainerRef}
                className={styles.imageContainer}
                onMouseDown={handleMouseDown}
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
            >
                <img
                    src={src}
                    alt={fileName}
                    className={styles.image}
                    style={{
                        transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
                    }}
                    draggable={false}
                />
            </div>

            {/* 底部文件名和计数 */}
            <div className={styles.footer} onClick={(e) => e.stopPropagation()}>
                <span className={styles.fileName}>{fileName}</span>
                {totalCount !== undefined && totalCount > 1 && currentIndex !== undefined && (
                    <span className={styles.counter}>
                        {currentIndex + 1} / {totalCount}
                    </span>
                )}
            </div>
        </div>
    );
});

