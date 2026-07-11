import React, { forwardRef } from 'react';
import styles from './Input.module.css';

/**
 * Input 组件属性
 */
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  /** 是否有错误 */
  error?: boolean;
  /** 左侧图标或前缀 */
  prefix?: React.ReactNode;
  /** 右侧图标或后缀 */
  suffix?: React.ReactNode;
}

/**
 * Input 文本输入组件
 *
 * 支持多种状态和装饰元素
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error = false, prefix, suffix, className = '', disabled, ...props }, ref) => {
    const wrapperClass = [
      styles.wrapper,
      error ? styles.error : '',
      disabled ? styles.disabled : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={wrapperClass}>
        {prefix && <span className={styles.prefix}>{prefix}</span>}
        <input ref={ref} className={styles.input} disabled={disabled} {...props} />
        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';
