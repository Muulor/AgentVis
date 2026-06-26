/**
 * ApiKeySettings - API 密钥配置标签页
 *
 * 配置 OpenAI、Anthropic、Gemini 等主对话模型的 API Key
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@components/ui/Toast';
import { notifySetupStatusChanged } from '@components/onboarding/onboardingEvents';
import { useSettingsStore } from '@stores/settingsStore';
import { getProviders } from '@/config/modelRegistry';
import { ExternalLink } from 'lucide-react';
import styles from './ApiKeySettings.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

const logger = getLogger('ApiKeySettings');

/** 在系统浏览器中打开外部 URL */
const openExternalUrl = async (url: string) => {
    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
    } catch {
        window.open(url, '_blank');
    }
};

/** API Key 状态 */
interface ApiKeyStatus {
    provider: string;
    configured: boolean;
}

export function ApiKeySettings() {
    const { toast } = useToast();
    const { t } = useI18n();
    const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [visibility, setVisibility] = useState<Record<string, boolean>>({});
    const [testing, setTesting] = useState<Record<string, boolean>>({});
    const [testResult, setTestResult] = useState<Record<string, 'success' | 'error' | null>>({});

    // Local provider URL 配置
    const localApiUrl = useSettingsStore((s) => s.localApiUrl);
    const setLocalApiUrl = useSettingsStore((s) => s.setLocalApiUrl);
    const [localUrlInput, setLocalUrlInput] = useState('');
    const [localUrlDirty, setLocalUrlDirty] = useState(false);

    // 加载 API Key 配置状态
    useEffect(() => {
        void loadApiKeyStatus();
    }, []);

    // 初始化 Local URL 输入框
    useEffect(() => {
        if (localApiUrl && !localUrlDirty) {
            setLocalUrlInput(localApiUrl);
        }
    }, [localApiUrl, localUrlDirty]);

    const loadApiKeyStatus = async () => {
        try {
            const status = await invoke<ApiKeyStatus[]>('settings_get_api_key_status');
            const statusMap: Record<string, boolean> = {};
            status.forEach((s) => {
                statusMap[s.provider] = s.configured;
            });
            setApiKeyStatus(statusMap);
        } catch (error) {
            logger.error('[ApiKeySettings] 加载 API Key 状态失败:', error);
        }
    };

    // 切换密码可见性
    const toggleVisibility = (provider: string) => {
        setVisibility((prev) => ({ ...prev, [provider]: !prev[provider] }));
    };

    // 保存 API Key
    const handleSave = async (provider: string) => {
        const apiKey = apiKeys[provider];
        if (!apiKey?.trim()) {
            toast({ title: t('settings.apiKeys.enterApiKey'), type: 'warning' });
            return;
        }

        try {
            await invoke('settings_set_api_key', {
                request: { provider, api_key: apiKey.trim() },
            });
            setApiKeyStatus((prev) => ({ ...prev, [provider]: true }));
            setApiKeys((prev) => ({ ...prev, [provider]: '' })); // 清空输入
            notifySetupStatusChanged();
            toast({ title: t('settings.apiKeys.apiKeySaved'), type: 'success' });
        } catch (error) {
            logger.error('[ApiKeySettings] 保存 API Key 失败:', error);
            toast({ title: t('settings.apiKeys.saveFailed'), description: String(error), type: 'error' });
        }
    };

    // 测试 API Key
    const handleTest = async (provider: string) => {
        setTesting((prev) => ({ ...prev, [provider]: true }));
        setTestResult((prev) => ({ ...prev, [provider]: null }));

        try {
            const success = await invoke<boolean>('settings_test_api_key', { provider });
            setTestResult((prev) => ({ ...prev, [provider]: success ? 'success' : 'error' }));
            toast({
                title: success ? t('settings.apiKeys.connectionSuccess') : t('settings.apiKeys.connectionFailed'),
                type: success ? 'success' : 'error',
            });
        } catch (error) {
            logger.error('[ApiKeySettings] 测试 API Key 失败:', error);
            setTestResult((prev) => ({ ...prev, [provider]: 'error' }));
            toast({ title: t('settings.apiKeys.testFailed'), description: String(error), type: 'error' });
        } finally {
            setTesting((prev) => ({ ...prev, [provider]: false }));
        }
    };

    // 删除 API Key
    const handleDelete = async (provider: string) => {
        try {
            await invoke('settings_delete_api_key', { provider });
            setApiKeyStatus((prev) => ({ ...prev, [provider]: false }));
            setTestResult((prev) => ({ ...prev, [provider]: null }));
            notifySetupStatusChanged();
            toast({ title: t('settings.apiKeys.apiKeyDeleted'), type: 'success' });
        } catch (error) {
            logger.error('[ApiKeySettings] 删除 API Key 失败:', error);
            toast({ title: t('settings.apiKeys.deleteFailed'), description: String(error), type: 'error' });
        }
    };

    // 保存 Local URL
    const handleSaveLocalUrl = () => {
        if (!localUrlInput.trim()) {
            toast({ title: t('settings.apiKeys.enterEndpointUrl'), type: 'warning' });
            return;
        }
        setLocalApiUrl(localUrlInput.trim());
        setLocalUrlDirty(false);
        toast({ title: t('settings.apiKeys.endpointSaved'), type: 'success' });
    };

    return (
        <div className={styles.container}>
            <p className={styles.description}>
                {t('settings.apiKeys.description')}
            </p>

            {getProviders().map((provider) => (
                <section key={provider.id} className={styles.providerSection}>
                    <div className={styles.providerHeader}>
                        <h3 className={styles.providerName}>{provider.name}</h3>
                        {provider.apiKeyUrl && (
                            <button
                                className={styles.externalLinkButton}
                                onClick={() => {
                                    if (provider.apiKeyUrl) void openExternalUrl(provider.apiKeyUrl);
                                }}
                                title={t('settings.apiKeys.getApiKeyTitle')}
                                aria-label={t('settings.apiKeys.getProviderApiKeyAria', { provider: provider.name })}
                            >
                                <ExternalLink size={14} />
                            </button>
                        )}
                        {apiKeyStatus[provider.id] && (
                            <span className={styles.configuredBadge}>{t('common.configured')}</span>
                        )}
                    </div>

                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={visibility[provider.id] ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={apiKeyStatus[provider.id] ? '••••••••••••' : provider.apiKeyPlaceholder}
                                value={apiKeys[provider.id] ?? ''}
                                onChange={(e) =>
                                    setApiKeys((prev) => ({ ...prev, [provider.id]: e.target.value }))
                                }
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => toggleVisibility(provider.id)}
                                aria-label={visibility[provider.id] ? t('common.hide') : t('common.show')}
                            >
                                {visibility[provider.id] ? (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
                                        <circle cx="8" cy="8" r="2" />
                                    </svg>
                                ) : (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
                                        <path d="M3 13L13 3" />
                                    </svg>
                                )}
                            </button>
                        </div>

                        {/* 保存按钮 - 仅在输入有值时显示 */}
                        {apiKeys[provider.id]?.trim() && (
                            <button
                                className={styles.saveButton}
                                onClick={() => handleSave(provider.id)}
                            >
                                {t('common.save')}
                            </button>
                        )}

                        {/* 测试按钮：Local 供应商为中转服务，测试模型不稳定，隐藏避免误导 */}
                        {provider.id !== 'local' && (
                            <button
                                className={cx(styles.testButton, testResult[provider.id] === 'success' && styles.testSuccess, testResult[provider.id] === 'error' && styles.testError)}
                                onClick={() => handleTest(provider.id)}
                                disabled={!apiKeyStatus[provider.id] || testing[provider.id]}
                            >
                                {testing[provider.id] ? (
                                    t('common.testing')
                                ) : testResult[provider.id] === 'success' ? (
                                    <>
                                        <span className={styles.successIcon}>✓</span>
                                        {t('common.test')}
                                    </>
                                ) : testResult[provider.id] === 'error' ? (
                                    <>
                                        <span className={styles.errorIcon}>✗</span>
                                        {t('common.test')}
                                    </>
                                ) : (
                                    t('common.test')
                                )}
                            </button>
                        )}

                        {/* 删除按钮 */}
                        {apiKeyStatus[provider.id] && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDelete(provider.id)}
                                aria-label={t('common.delete')}
                            >
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Local provider 专属 URL 配置 */}
                    {provider.id === 'local' && (
                        <div className={styles.localUrlSection}>
                            <label className={styles.urlLabel}>{t('settings.apiKeys.endpointUrl')}</label>
                            <p className={styles.localUrlHint}>{t('settings.apiKeys.localEndpointHint')}</p>
                            <div className={styles.inputRow}>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="http://127.0.0.1:8050/v1"
                                    value={localUrlInput}
                                    onChange={(e) => {
                                        setLocalUrlInput(e.target.value);
                                        setLocalUrlDirty(true);
                                    }}
                                    autoComplete="off"
                                />
                                {localUrlInput !== localApiUrl && localUrlInput.trim() && (
                                    <button
                                        className={styles.saveButton}
                                        onClick={handleSaveLocalUrl}
                                    >
                                        {t('common.save')}
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </section>
            ))}
        </div>
    );
}
