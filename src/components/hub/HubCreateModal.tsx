import { useCallback, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useI18n } from '@/i18n';
import styles from './HubCreateModal.module.css';

interface HubCreateModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface Hub {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Hub 名称最大长度
 */
const MAX_NAME_LENGTH = 50;

/**
 * HubCreateModal 组件
 *
 * 创建Hub弹窗，支持：
 * - 输入Hub名称（必填，最大50字符）
 * - Enter快捷键提交
 * - Escape关闭
 * - 调用Tauri命令创建Hub
 */
export function HubCreateModal({ isOpen, onClose }: HubCreateModalProps) {
    const { t } = useI18n();
    const addHub = useHubStore((state) => state.addHub);
    const setCurrentHubId = useHubStore((state) => state.setCurrentHubId);
    const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);

    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const handleSubmitRef = useRef<(() => Promise<void>) | null>(null);

    // 聚焦输入框
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    // 重置表单
    useEffect(() => {
        if (!isOpen) {
            setName('');
            setError(null);
            setIsSubmitting(false);
        }
    }, [isOpen]);

    // 键盘事件处理
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isOpen) return;

            if (event.key === 'Escape') {
                onClose();
            } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmitRef.current?.();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // 验证输入
    const validateName = useCallback((value: string): string | null => {
        const trimmed = value.trim();
        if (!trimmed) {
            return t('hub.create.needName');
        }
        if (trimmed.length > MAX_NAME_LENGTH) {
            return t('hub.create.nameTooLong', { max: MAX_NAME_LENGTH });
        }
        return null;
    }, [t]);

    // 输入变更
    const handleNameChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setName(value);
        // 清除错误提示
        if (error) {
            setError(null);
        }
    }, [error]);

    // 提交创建
    const handleSubmit = useCallback(async () => {
        const validationError = validateName(name);
        if (validationError) {
            setError(validationError);
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            // 调用Tauri命令创建Hub
            // 注意：Rust端期望参数名为 request，包含 name 字段
            const newHub = await invoke<Hub>('hub_create', { request: { name: name.trim() } });

            // 添加到Store
            addHub(newHub);

            // Match normal hub switching: leave the previous agent view before activating the new hub.
            setCurrentAgentId(null);

            // 切换到新创建的Hub
            setCurrentHubId(newHub.id);

            // 关闭弹窗
            onClose();
        } catch (err) {
            // 处理错误
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(t('hub.create.createFailed', { error: errorMessage }));
        } finally {
            setIsSubmitting(false);
        }
    }, [name, validateName, addHub, setCurrentAgentId, setCurrentHubId, onClose, t]);
    handleSubmitRef.current = handleSubmit;

    // 点击遮罩关闭
    const handleOverlayClick = useCallback((event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }, [onClose]);

    if (!isOpen) {
        return null;
    }

    return (
        <div className={styles.overlay} onClick={handleOverlayClick}>
            <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="hub-create-title">
                {/* 头部 */}
                <div className={styles.header}>
                    <h2 id="hub-create-title" className={styles.title}>
                        {t('hub.create.title')}
                    </h2>
                    <button className={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 4l8 8M12 4L4 12" />
                        </svg>
                    </button>
                </div>

                {/* 内容 */}
                <div className={styles.body}>
                    <div className={styles.formGroup}>
                        <label htmlFor="hub-name" className={styles.label}>
                            {t('hub.create.name')}
                        </label>
                        <input
                            ref={inputRef}
                            id="hub-name"
                            type="text"
                            className={styles.input}
                            value={name}
                            onChange={handleNameChange}
                            placeholder={t('hub.create.namePlaceholder')}
                            maxLength={MAX_NAME_LENGTH}
                            disabled={isSubmitting}
                        />
                        {error && <div className={styles.error}>{error}</div>}
                    </div>
                </div>

                {/* 底部操作 */}
                <div className={styles.footer}>
                    <button className={styles.cancelBtn} onClick={onClose} disabled={isSubmitting}>
                        {t('common.cancel')}
                    </button>
                    <button className={styles.submitBtn} onClick={handleSubmit} disabled={isSubmitting || !name.trim()}>
                        {isSubmitting ? t('common.creating') : t('common.create')}
                    </button>
                </div>
            </div>
        </div>
    );
}
