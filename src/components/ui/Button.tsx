import React, { forwardRef } from 'react';
import styles from './Button.module.css';

/**
 * Button 组件属性
 */
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    /** 按钮变体 */
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    /** 按钮尺寸 */
    size?: 'sm' | 'md' | 'lg';
    /** 是否加载中 */
    loading?: boolean;
    /** 左侧图标 */
    leftIcon?: React.ReactNode;
    /** 右侧图标 */
    rightIcon?: React.ReactNode;
}

/**
 * Button 基础按钮组件
 *
 * 支持多种变体和尺寸，遵循 Design System 规范
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    (
        {
            variant = 'primary',
            size = 'md',
            loading = false,
            disabled = false,
            leftIcon,
            rightIcon,
            children,
            className = '',
            ...props
        },
        ref
    ) => {
        const classNames = [
            styles.button,
            styles[variant],
            styles[size],
            loading ? styles.loading : '',
            className,
        ]
            .filter(Boolean)
            .join(' ');

        return (
            <button ref={ref} className={classNames} disabled={disabled || loading} {...props}>
                {loading && <span className={styles.spinner} />}
                {!loading && leftIcon && <span className={styles.icon}>{leftIcon}</span>}
                <span className={styles.text}>{children}</span>
                {!loading && rightIcon && <span className={styles.icon}>{rightIcon}</span>}
            </button>
        );
    }
);

Button.displayName = 'Button';
