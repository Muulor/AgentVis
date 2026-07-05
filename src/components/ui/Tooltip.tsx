/**
 * Tooltip - 统一悬浮提示组件
 *
 * 功能：
 * - 使用 Radix Tooltip 提供稳定的悬浮与键盘聚焦提示
 * - 统一应用内提示的圆角、实底与快速显示体验
 * - 支持可选快捷键展示，避免继续依赖浏览器原生 title
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';
import styles from './Tooltip.module.css';

interface TooltipProviderProps {
    children: ReactNode;
}

interface TooltipProps {
    /** 触发提示的单个元素 */
    children: ReactElement;
    /** 提示内容 */
    content?: ReactNode;
    /** 快捷键文本 */
    shortcut?: string;
    /** 显示方位 */
    side?: TooltipPrimitive.TooltipContentProps['side'];
    /** 对齐方式 */
    align?: TooltipPrimitive.TooltipContentProps['align'];
    /** 与触发元素的间距 */
    sideOffset?: number;
    /** 禁用提示 */
    disabled?: boolean;
    /** 长文本提示允许换行显示完整内容 */
    multiline?: boolean;
}

export function TooltipProvider({ children }: TooltipProviderProps) {
    return (
        <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={80}>
            {children}
        </TooltipPrimitive.Provider>
    );
}

export function Tooltip({
    children,
    content,
    shortcut,
    side = 'top',
    align = 'center',
    sideOffset = 8,
    disabled = false,
    multiline = false,
}: TooltipProps) {
    if (disabled || !content) {
        return children;
    }

    return (
        <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger asChild>
                {children}
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                    className={[styles.content, multiline && styles.multiline].filter(Boolean).join(' ')}
                    side={side}
                    align={align}
                    sideOffset={sideOffset}
                    collisionPadding={10}
                >
                    <span className={styles.label}>{content}</span>
                    {shortcut && <kbd className={styles.shortcut}>{shortcut}</kbd>}
                </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
}
