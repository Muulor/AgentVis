import React, { useRef, useCallback } from 'react';
import { cx } from '@utils/classNames';
import styles from './ResizeHandle.module.css';

/**
 * ResizeHandle 属性
 */
interface ResizeHandleProps {
    /** 拖拽方向 */
    direction: 'horizontal' | 'vertical';
    /** 尺寸变化回调 */
    onResize: (delta: number) => void;
    /** 拖拽开始回调 - 用于禁用CSS过渡效果 */
    onResizeStart?: () => void;
    /** 拖拽结束回调 */
    onResizeEnd?: () => void;
    /** 额外 className，用于从外部覆盖背景色等样式 */
    className?: string;
}

/**
 * ResizeHandle 拖拽手柄组件
 *
 * 用于调整面板宽度/高度
 */
export function ResizeHandle({ direction, onResize, onResizeStart, onResizeEnd, className }: ResizeHandleProps) {
    const isDragging = useRef(false);
    const lastPosition = useRef(0);

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            isDragging.current = true;
            lastPosition.current = direction === 'horizontal' ? e.clientX : e.clientY;

            // 通知父组件拖拽开始
            onResizeStart?.();

            // 添加全局监听器
            const handleMouseMove = (moveEvent: MouseEvent) => {
                if (!isDragging.current) return;

                const currentPosition =
                    direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
                const delta = currentPosition - lastPosition.current;
                lastPosition.current = currentPosition;

                onResize(delta);
            };

            const handleMouseUp = () => {
                isDragging.current = false;
                onResizeEnd?.();
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
            document.body.style.userSelect = 'none';
        },
        [direction, onResize, onResizeStart, onResizeEnd]
    );

    return (
        <div
            className={cx(styles.handle, styles[direction], className)}
            onMouseDown={handleMouseDown}
            role="separator"
            aria-orientation={direction}
        />
    );
}

