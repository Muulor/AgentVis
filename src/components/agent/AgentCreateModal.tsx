import { useCallback, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useSettingsStore } from '@stores/settingsStore';
import { getProviders, getModelsByProvider } from '@/config/modelRegistry';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './AgentCreateModal.module.css';

interface AgentCreateModalProps {
    isOpen: boolean;
    onClose: () => void;
}

/** Agent接口 - 匹配Rust端AgentItem返回值 */
interface Agent {
    id: string;
    hubId: string;
    name: string;
    avatarColor: string | null;
    modelProvider: string | null;
    modelName: string | null;
    mbRulesFilePath: string | null;
    saRulesFilePath: string | null;
    mbRules: string | null;
    saRules: string | null;
    chatRules: string | null;
    knowledgePaths: string | null;
    createdAt: number;
    updatedAt: number;
}



/**
 * AgentCreateModal 组件
 *
 * 创建Agent弹窗，支持：
 * - 输入Agent名称（必填）
 * - 选择模型
 * - 调用Tauri命令创建Agent
 */
export function AgentCreateModal({ isOpen, onClose }: AgentCreateModalProps) {
    const { t } = useI18n();
    const currentHubId = useHubStore((state) => state.currentHubId);
    const addAgent = useAgentStore((state) => state.addAgent);
    const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);

    // 从设置面板读取默认 provider 和模型，创建 Agent 时自动选中
    const defaultProvider = useSettingsStore((s) => s.defaultProvider);
    const defaultModel = useSettingsStore((s) => s.defaultModel);

    const [name, setName] = useState('');
    const [providerId, setProviderId] = useState(defaultProvider || 'openai');
    const [modelId, setModelId] = useState(defaultModel || 'gpt-5.4');
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

    // 重置表单（使用设置面板的默认 provider/model）
    useEffect(() => {
        if (!isOpen) {
            setName('');
            setProviderId(defaultProvider || 'openai');
            setModelId(defaultModel || 'gpt-5.4');
            setError(null);
            setIsSubmitting(false);
        }
    }, [isOpen, defaultProvider, defaultModel]);

    // 键盘事件
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

    // 提交创建
    const handleSubmit = useCallback(async () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError(t('agent.create.needName'));
            return;
        }

        if (!currentHubId) {
            setError(t('agent.create.needHub'));
            return;
        }

        // 检查同 Hub 下是否有同名 Agent
        const existingAgents = useAgentStore.getState().agents.filter(a => a.hubId === currentHubId);
        const isDuplicate = existingAgents.some(a => a.name.toLowerCase() === trimmedName.toLowerCase());
        if (isDuplicate) {
            setError(t('agent.create.duplicateName'));
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            // 1. 创建 Agent（后端 create 只支持 hub_id 和 name）
            const newAgent = await invoke<Agent>('agent_create', {
                request: {
                    hub_id: currentHubId,
                    name: trimmedName,
                },
            });

            // 2. 立即更新模型配置（后端 update 支持 model_provider 和 model_name）
            const updatedAgent = await invoke<Agent>('agent_update', {
                id: newAgent.id,
                request: {
                    model_provider: providerId,
                    model_name: modelId,
                },
            });

            // 添加到 Store（使用更新后的 Agent 数据）
            addAgent(updatedAgent);

            // 切换到新创建的 Agent
            setCurrentAgentId(updatedAgent.id);

            // 关闭弹窗
            onClose();
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(t('agent.create.createFailed', { error: errorMessage }));
        } finally {
            setIsSubmitting(false);
        }
    }, [name, providerId, modelId, currentHubId, addAgent, setCurrentAgentId, onClose, t]);
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
            <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="agent-create-title">
                <div className={styles.header}>
                    <h2 id="agent-create-title" className={styles.title}>{t('agent.create.title')}</h2>
                    <button className={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 4l8 8M12 4L4 12" />
                        </svg>
                    </button>
                </div>

                <div className={styles.body}>
                    {/* 名称输入 */}
                    <div className={styles.formGroup}>
                        <label htmlFor="agent-name" className={styles.label}>{t('agent.create.name')}</label>
                        <input
                            ref={inputRef}
                            id="agent-name"
                            type="text"
                            className={styles.input}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('agent.create.namePlaceholder')}
                            maxLength={50}
                            disabled={isSubmitting}
                            autoComplete="off"
                        />
                    </div>

                    {/* Provider 选择 */}
                    <div className={styles.formGroup}>
                        <label className={styles.label}>Provider</label>
                        <div className={styles.providerSelector}>
                            {getProviders().map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={cx(styles.providerOption, providerId === p.id && styles.providerOptionActive)}
                                    onClick={() => {
                                        setProviderId(p.id);
                                        // 切换 Provider 时自动选择第一个模型
                                        const models = getModelsByProvider(p.id);
                                        if (models.length > 0 && models[0]) {
                                            setModelId(models[0].id);
                                        }
                                    }}
                                    disabled={isSubmitting}
                                >
                                    {p.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 模型选择 */}
                    <div className={styles.formGroup}>
                        <label htmlFor="agent-model" className={styles.label}>{t('agent.create.model')}</label>
                        <select
                            id="agent-model"
                            className={styles.select}
                            value={modelId}
                            onChange={(e) => setModelId(e.target.value)}
                            disabled={isSubmitting}
                        >
                            {getModelsByProvider(providerId).map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {error && <div className={styles.error}>{error}</div>}
                </div>

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
