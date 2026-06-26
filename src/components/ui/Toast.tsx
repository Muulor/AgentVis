import React, { createContext, useContext, useCallback, useState } from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './Toast.module.css';

/**
 * Toast 类型
 */
type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast 数据结构
 */
interface ToastData {
    id: string;
    type: ToastType;
    title: string;
    description?: string;
    duration?: number;
}

/**
 * Toast Context 类型
 */
interface ToastContextType {
    toast: (data: Omit<ToastData, 'id'>) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

/**
 * 使用 Toast Context
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within ToastProvider');
    }
    return context;
}

/**
 * Toast Provider
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
    const { t } = useI18n();
    const [toasts, setToasts] = useState<ToastData[]>([]);

    const addToast = useCallback((data: Omit<ToastData, 'id'>) => {
        const id = crypto.randomUUID();
        setToasts((prev) => [...prev, { ...data, id }]);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ toast: addToast }}>
            <ToastPrimitive.Provider swipeDirection="right">
                {children}
                {toasts.map((toast) => (
                    <ToastPrimitive.Root
                        key={toast.id}
                        className={cx(styles.root, styles[toast.type])}
                        duration={toast.duration ?? 5000}
                        onOpenChange={(open) => {
                            if (!open) removeToast(toast.id);
                        }}
                    >
                        <ToastPrimitive.Title className={styles.title}>
                            {toast.title}
                        </ToastPrimitive.Title>
                        {toast.description && (
                            <ToastPrimitive.Description className={styles.description}>
                                {toast.description}
                            </ToastPrimitive.Description>
                        )}
                        <ToastPrimitive.Close className={styles.close} aria-label={t('common.close')}>
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 14 14"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M3 3l8 8M11 3l-8 8" />
                            </svg>
                        </ToastPrimitive.Close>
                    </ToastPrimitive.Root>
                ))}
                <ToastPrimitive.Viewport className={styles.viewport} />
            </ToastPrimitive.Provider>
        </ToastContext.Provider>
    );
}
