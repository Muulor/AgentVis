/**
 * CloudServiceSettings - 云端服务配置标签页
 *
 * 配置记忆系统 LLM、Embedding 向量化、网络搜索使用的云端服务
 * 包括记忆系统 LLM（通用 Provider/Model）、SiliconFlow Embedding、Tavily
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@components/ui/Toast';
import { notifySetupStatusChanged } from '@components/onboarding/onboardingEvents';
import { useSettingsStore } from '@stores/settingsStore';
import { getProviders, getModelsByProvider } from '@/config/modelRegistry';
import { ExternalLink, Trash2 } from 'lucide-react';
import styles from './CloudServiceSettings.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

const logger = getLogger('CloudServiceSettings');

/** SiliconFlow Embedding 固定模型（免费，1024 维，8K 上下文） */
const SILICONFLOW_EMBEDDING_MODEL = 'BAAI/bge-m3';

/** SiliconFlow Reranker 固定模型（免费，8K 上下文） */
const SILICONFLOW_RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';

/** Gitee AI Embedding 模型（同一 bge-m3，免费，作为 SiliconFlow 的 fallback） */
const GITEEAI_EMBEDDING_MODEL = 'bge-m3';

/** 各服务商 API Key 获取页面 */
const PROVIDER_URLS = {
    siliconflow: 'https://cloud.siliconflow.cn/account/ak',
    giteeai: 'https://ai.gitee.com/dashboard/settings/tokens',
    tavily: 'https://app.tavily.com/home',
    github: 'https://github.com/settings/tokens',
    context7: 'https://context7.com/dashboard',
} as const;

/** 在系统浏览器中打开外部 URL */
const openExternalUrl = async (url: string) => {
    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
    } catch {
        // 回退：尝试用 window.open
        window.open(url, '_blank');
    }
};

/** 可见性切换 SVG 图标 - 可见状态（眼睛） */
function EyeOpenIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
            <circle cx="8" cy="8" r="2" />
        </svg>
    );
}

/** 可见性切换 SVG 图标 - 隐藏状态（划线眼睛） */
function EyeClosedIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
            <path d="M3 13L13 3" />
        </svg>
    );
}

export function CloudServiceSettings() {
    const { toast } = useToast();
    const { t } = useI18n();

    // 记忆系统 LLM 配置
    const memoryProvider = useSettingsStore((s) => s.memoryProvider);
    const setMemoryProvider = useSettingsStore((s) => s.setMemoryProvider);
    const memoryModel = useSettingsStore((s) => s.memoryModel);
    const setMemoryModel = useSettingsStore((s) => s.setMemoryModel);
    const defaultProvider = useSettingsStore((s) => s.defaultProvider);
    const defaultModel = useSettingsStore((s) => s.defaultModel);
    const imageGenerationModel = useSettingsStore((s) => s.imageGenerationModel);
    const imageGenerationApiUrl = useSettingsStore((s) => s.imageGenerationApiUrl);
    const imageGenerationUseStreaming = useSettingsStore((s) => s.imageGenerationUseStreaming);
    const setImageGenerationApiUrl = useSettingsStore((s) => s.setImageGenerationApiUrl);
    const setImageGenerationUseStreaming = useSettingsStore((s) => s.setImageGenerationUseStreaming);

    // 图像生成服务配置
    const [imageGenerationApiKey, setImageGenerationApiKey] = useState('');
    const [imageGenerationConfigured, setImageGenerationConfigured] = useState(false);
    const [imageGenerationVisible, setImageGenerationVisible] = useState(false);
    const [imageGenerationUrlInput, setImageGenerationUrlInput] = useState('');
    const [imageGenerationUrlDirty, setImageGenerationUrlDirty] = useState(false);

    // SiliconFlow Embedding 配置
    const [siliconflowApiKey, setSiliconflowApiKey] = useState('');
    const [siliconflowConfigured, setSiliconflowConfigured] = useState(false);
    const [siliconflowTesting, setSiliconflowTesting] = useState(false);
    const [siliconflowTestResult, setSiliconflowTestResult] = useState<'success' | 'error' | null>(null);
    const [siliconflowVisible, setSiliconflowVisible] = useState(false);

    // Gitee AI Embedding 配置（SiliconFlow 的 fallback）
    const [giteeaiApiKey, setGiteeaiApiKey] = useState('');
    const [giteeaiConfigured, setGiteeaiConfigured] = useState(false);
    const [giteeaiTesting, setGiteeaiTesting] = useState(false);
    const [giteeaiTestResult, setGiteeaiTestResult] = useState<'success' | 'error' | null>(null);
    const [giteeaiVisible, setGiteeaiVisible] = useState(false);

    // Tavily 配置
    const [tavilyApiKey, setTavilyApiKey] = useState('');
    const [tavilyConfigured, setTavilyConfigured] = useState(false);
    const [tavilyTesting, setTavilyTesting] = useState(false);
    const [tavilyTestResult, setTavilyTestResult] = useState<'success' | 'error' | null>(null);
    const [tavilyVisible, setTavilyVisible] = useState(false);

    // GitHub API Token
    const [githubToken, setGithubToken] = useState('');
    const [githubConfigured, setGithubConfigured] = useState(false);
    const [githubTesting, setGithubTesting] = useState(false);
    const [githubTestResult, setGithubTestResult] = useState<'success' | 'error' | null>(null);
    const [githubVisible, setGithubVisible] = useState(false);

    // Context7 API Key
    const [context7ApiKey, setContext7ApiKey] = useState('');
    const [context7Configured, setContext7Configured] = useState(false);
    const [context7Testing, setContext7Testing] = useState(false);
    const [context7TestResult, setContext7TestResult] = useState<'success' | 'error' | null>(null);
    const [context7Visible, setContext7Visible] = useState(false);

    // 加载配置状态
    useEffect(() => {
        void loadStatus();
    }, []);

    useEffect(() => {
        if (!imageGenerationUrlDirty) {
            setImageGenerationUrlInput(imageGenerationApiUrl);
        }
    }, [imageGenerationApiUrl, imageGenerationUrlDirty]);

    const loadStatus = async () => {
        try {
            // 加载图像生成服务状态
            const imageGenerationStatus = await invoke<boolean>('get_image_generation_api_key_status');
            setImageGenerationConfigured(imageGenerationStatus);

            // 加载 SiliconFlow 状态
            const siliconflowStatus = await invoke<boolean>('get_siliconflow_api_key_status');
            setSiliconflowConfigured(siliconflowStatus);

            // 加载 Gitee AI 状态
            const giteeaiStatus = await invoke<boolean>('get_giteeai_api_key_status');
            setGiteeaiConfigured(giteeaiStatus);

            // 加载 Tavily 状态
            const tavilyStatus = await invoke<boolean>('get_tavily_api_key_status');
            setTavilyConfigured(tavilyStatus);

            const githubStatus = await invoke<boolean>('get_github_token_status');
            setGithubConfigured(githubStatus);

            const context7Status = await invoke<boolean>('get_context7_api_key_status');
            setContext7Configured(context7Status);
        } catch (error) {
            logger.error('[CloudServiceSettings] 加载状态失败:', error);
        }
    };

    // ============================================================================
    // 记忆系统 LLM - Provider/Model 逻辑
    // ============================================================================

    // 当前生效的 provider（空值跟随全局默认）
    const effectiveProvider = memoryProvider || defaultProvider;
    const effectiveModel = memoryModel || defaultModel;

    // 从 modelRegistry 动态获取可选列表
    const providerList = getProviders();
    const modelList = getModelsByProvider(effectiveProvider);

    /**
     * Provider 切换时重置 Model 为该 Provider 的第一个模型
     * 避免切换后 Model 仍指向上一个 Provider 的不兼容模型
     */
    const handleProviderChange = (newProvider: string) => {
        setMemoryProvider(newProvider);
        const models = getModelsByProvider(newProvider);
        const firstModelId = models[0]?.id ?? '';
        setMemoryModel(firstModelId);
    };

    // ============================================================================
    // 图像生成服务 API Key 管理
    // ============================================================================

    const handleSaveImageGeneration = async () => {
        if (!imageGenerationApiKey.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_image_generation_api_key', { apiKey: imageGenerationApiKey.trim() });
            setImageGenerationConfigured(true);
            setImageGenerationApiKey('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.imageKeySaved'), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleSaveImageGenerationUrl = () => {
        const url = imageGenerationUrlInput.trim();
        setImageGenerationApiUrl(url);
        setImageGenerationUrlDirty(false);
        toast({
            title: url ? t('settings.cloud.imageEndpointSaved') : t('settings.cloud.imageEndpointCleared'),
            type: 'success',
        });
    };

    // ============================================================================
    // SiliconFlow API Key 管理
    // ============================================================================

    const handleSaveSiliconflow = async () => {
        if (!siliconflowApiKey.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_siliconflow_api_key', { apiKey: siliconflowApiKey.trim() });
            setSiliconflowConfigured(true);
            setSiliconflowApiKey('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeySaved', { provider: 'SiliconFlow' }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleTestSiliconflow = async () => {
        setSiliconflowTesting(true);
        setSiliconflowTestResult(null);
        try {
            // 通过实际调用 Embedding API 验证 Key 有效性
            await invoke('cloud_embedding_encode', {
                request: { texts: ['test'], provider: 'siliconflow', model: SILICONFLOW_EMBEDDING_MODEL },
            });
            await invoke('cloud_rerank_documents', {
                request: {
                    provider: 'siliconflow',
                    model: SILICONFLOW_RERANK_MODEL,
                    query: 'test',
                    documents: ['test document', 'other document'],
                    topN: 2,
                },
            });
            setSiliconflowTestResult('success');
            toast({ title: t('settings.cloud.providerConnectSuccess', { provider: 'SiliconFlow' }), type: 'success' });
        } catch (error) {
            logger.error('[CloudServiceSettings] SiliconFlow 测试失败:', error);
            setSiliconflowTestResult('error');
            toast({ title: t('settings.cloud.connectionFailed'), description: String(error), type: 'error' });
        } finally {
            setSiliconflowTesting(false);
        }
    };

    // ============================================================================
    // Gitee AI API Key 管理（Embedding Fallback）
    // ============================================================================

    const handleSaveGiteeai = async () => {
        if (!giteeaiApiKey.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_giteeai_api_key', { apiKey: giteeaiApiKey.trim() });
            setGiteeaiConfigured(true);
            setGiteeaiApiKey('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeySaved', { provider: 'Gitee AI' }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleTestGiteeai = async () => {
        setGiteeaiTesting(true);
        setGiteeaiTestResult(null);
        try {
            await invoke('cloud_embedding_encode', {
                request: { texts: ['test'], provider: 'giteeai', model: GITEEAI_EMBEDDING_MODEL },
            });
            setGiteeaiTestResult('success');
            toast({ title: t('settings.cloud.providerConnectSuccess', { provider: 'Gitee AI' }), type: 'success' });
        } catch (error) {
            logger.error('[CloudServiceSettings] Gitee AI 测试失败:', error);
            setGiteeaiTestResult('error');
            toast({ title: t('settings.cloud.connectionFailed'), description: String(error), type: 'error' });
        } finally {
            setGiteeaiTesting(false);
        }
    };

    // ============================================================================
    // Tavily API Key 管理
    // ============================================================================

    const handleSaveTavily = async () => {
        if (!tavilyApiKey.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_tavily_api_key', { apiKey: tavilyApiKey.trim() });
            setTavilyConfigured(true);
            setTavilyApiKey('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeySaved', { provider: 'Tavily' }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleTestTavily = async () => {
        setTavilyTesting(true);
        setTavilyTestResult(null);
        try {
            await invoke('web_search', { query: 'test', maxResults: 1 });
            setTavilyTestResult('success');
            toast({ title: t('settings.cloud.providerConnectSuccess', { provider: 'Tavily' }), type: 'success' });
        } catch (error) {
            logger.error('[CloudServiceSettings] Tavily 测试失败:', error);
            setTavilyTestResult('error');
            toast({ title: t('settings.cloud.connectionFailed'), description: String(error), type: 'error' });
        } finally {
            setTavilyTesting(false);
        }
    };

    // ============================================================================
    // 通用：删除 API Key
    // ============================================================================

    /**
     * 删除指定提供商的 API Key
     *
     * 复用 settings_delete_api_key 命令，该命令支持任意 provider 名称，
     * 因为 SiliconFlow / Gitee AI / Tavily 都存储在同一个 WindowsKeystore 中。
     */
    // ============================================================================
    // GitHub Token
    // ============================================================================

    const handleSaveGithub = async () => {
        if (!githubToken.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_github_token', { apiKey: githubToken.trim() });
            setGithubConfigured(true);
            setGithubTestResult(null);
            setGithubToken('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeySaved', { provider: 'GitHub' }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleTestGithub = async () => {
        setGithubTesting(true);
        setGithubTestResult(null);
        try {
            const success = await invoke<boolean>('test_github_token');
            setGithubTestResult(success ? 'success' : 'error');
            toast({
                title: success
                    ? t('settings.cloud.providerConnectSuccess', { provider: 'GitHub' })
                    : t('settings.cloud.connectionFailed'),
                type: success ? 'success' : 'error',
            });
        } catch (error) {
            logger.error('[CloudServiceSettings] GitHub token test failed:', error);
            setGithubTestResult('error');
            toast({ title: t('settings.cloud.connectionFailed'), description: String(error), type: 'error' });
        } finally {
            setGithubTesting(false);
        }
    };

    // ============================================================================
    // Context7 API Key
    // ============================================================================

    const handleSaveContext7 = async () => {
        if (!context7ApiKey.trim()) {
            toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
            return;
        }
        try {
            await invoke('set_context7_api_key', { apiKey: context7ApiKey.trim() });
            setContext7Configured(true);
            setContext7TestResult(null);
            setContext7ApiKey('');
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeySaved', { provider: 'Context7' }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
        }
    };

    const handleTestContext7 = async () => {
        setContext7Testing(true);
        setContext7TestResult(null);
        try {
            const success = await invoke<boolean>('test_context7_api_key');
            setContext7TestResult(success ? 'success' : 'error');
            toast({
                title: success
                    ? t('settings.cloud.providerConnectSuccess', { provider: 'Context7' })
                    : t('settings.cloud.connectionFailed'),
                type: success ? 'success' : 'error',
            });
        } catch (error) {
            logger.error('[CloudServiceSettings] Context7 API key test failed:', error);
            setContext7TestResult('error');
            toast({ title: t('settings.cloud.connectionFailed'), description: String(error), type: 'error' });
        } finally {
            setContext7Testing(false);
        }
    };

    const handleDeleteApiKey = async (
        provider: string,
        displayName: string,
        setConfigured: (v: boolean) => void,
        setTestResult: (v: 'success' | 'error' | null) => void
    ) => {
        try {
            await invoke('settings_delete_api_key', { provider });
            setConfigured(false);
            setTestResult(null);
            notifySetupStatusChanged();
            toast({ title: t('settings.cloud.providerKeyDeleted', { provider: displayName }), type: 'success' });
        } catch (error) {
            toast({ title: t('settings.cloud.deleteFailed'), description: String(error), type: 'error' });
        }
    };

    // ============================================================================
    // 渲染
    // ============================================================================

    return (
        <div className={styles.container}>
            {/* 记忆系统 LLM 配置 */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.memoryLlm')}</h3>
                    <span className={styles.requiredBadge}>{t('common.required')}</span>
                </div>

                <p className={styles.serviceDesc}>
                    {t('settings.cloud.memoryDesc')}
                </p>

                <div className={styles.providerModelRow}>
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.cloud.provider')}</label>
                        <select
                            className={styles.select}
                            value={effectiveProvider}
                            onChange={(e) => handleProviderChange(e.target.value)}
                        >
                            {providerList.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.cloud.model')}</label>
                        <select
                            className={styles.select}
                            value={effectiveModel}
                            onChange={(e) => setMemoryModel(e.target.value)}
                        >
                            {modelList.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            </section>

            {/* SiliconFlow Embedding 配置 */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.siliconflowTitle')}</h3>
                    <button
                        className={styles.externalLinkButton}
                        onClick={() => openExternalUrl(PROVIDER_URLS.siliconflow)}
                        title={t('settings.cloud.getApiKeyTitle')}
                    >
                        <ExternalLink size={14} />
                    </button>
                    <span className={styles.requiredBadge}>{t('common.required')}</span>
                    {siliconflowConfigured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>
                    {t('settings.cloud.siliconflowDesc', {
                        embeddingModel: SILICONFLOW_EMBEDDING_MODEL,
                        rerankerModel: SILICONFLOW_RERANK_MODEL,
                    })}
                </p>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.apiKey')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={siliconflowVisible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={siliconflowConfigured ? '••••••••••••' : t('settings.cloud.inputProviderApiKey', { provider: 'SiliconFlow' })}
                                value={siliconflowApiKey}
                                onChange={(e) => setSiliconflowApiKey(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setSiliconflowVisible(!siliconflowVisible)}
                            >
                                {siliconflowVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {siliconflowApiKey.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveSiliconflow}>
                                {t('common.save')}
                            </button>
                        )}
                        <button
                            className={cx(styles.testButton, siliconflowTestResult === 'success' && styles.testSuccess, siliconflowTestResult === 'error' && styles.testError)}
                            onClick={handleTestSiliconflow}
                            disabled={!siliconflowConfigured || siliconflowTesting}
                        >
                            {siliconflowTesting ? t('common.testing') : siliconflowTestResult === 'success' ? `✓ ${t('common.test')}` : siliconflowTestResult === 'error' ? `✗ ${t('common.test')}` : t('common.test')}
                        </button>
                        {siliconflowConfigured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('siliconflow', 'SiliconFlow', setSiliconflowConfigured, setSiliconflowTestResult)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.embeddingModel')}</label>
                    <input
                        type="text"
                        className={styles.input}
                        value={SILICONFLOW_EMBEDDING_MODEL}
                        disabled
                    />
                </div>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.rerankerModel')}</label>
                    <input
                        type="text"
                        className={styles.input}
                        value={SILICONFLOW_RERANK_MODEL}
                        disabled
                    />
                </div>
            </section>

            {/* Gitee AI Embedding 配置（Fallback） */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>Gitee AI (Embedding Fallback)</h3>
                    <button
                        className={styles.externalLinkButton}
                        onClick={() => openExternalUrl(PROVIDER_URLS.giteeai)}
                        title={t('settings.cloud.getApiKeyTitle')}
                    >
                        <ExternalLink size={14} />
                    </button>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {giteeaiConfigured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>
                    {t('settings.cloud.giteeaiDesc', { model: GITEEAI_EMBEDDING_MODEL })}
                </p>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.apiKey')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={giteeaiVisible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={giteeaiConfigured ? '••••••••••••' : t('settings.cloud.inputProviderApiKey', { provider: 'Gitee AI' })}
                                value={giteeaiApiKey}
                                onChange={(e) => setGiteeaiApiKey(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setGiteeaiVisible(!giteeaiVisible)}
                            >
                                {giteeaiVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {giteeaiApiKey.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveGiteeai}>
                                {t('common.save')}
                            </button>
                        )}
                        <button
                            className={cx(styles.testButton, giteeaiTestResult === 'success' && styles.testSuccess, giteeaiTestResult === 'error' && styles.testError)}
                            onClick={handleTestGiteeai}
                            disabled={!giteeaiConfigured || giteeaiTesting}
                        >
                            {giteeaiTesting ? t('common.testing') : giteeaiTestResult === 'success' ? `✓ ${t('common.test')}` : giteeaiTestResult === 'error' ? `✗ ${t('common.test')}` : t('common.test')}
                        </button>
                        {giteeaiConfigured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('giteeai', 'Gitee AI', setGiteeaiConfigured, setGiteeaiTestResult)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </section>

            {/* Tavily 配置 */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.tavilyTitle')}</h3>
                    <button
                        className={styles.externalLinkButton}
                        onClick={() => openExternalUrl(PROVIDER_URLS.tavily)}
                        title={t('settings.cloud.getApiKeyTitle')}
                    >
                        <ExternalLink size={14} />
                    </button>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {tavilyConfigured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>{t('settings.cloud.tavilyDesc')}</p>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.apiKey')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={tavilyVisible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={tavilyConfigured ? '••••••••••••' : t('settings.cloud.inputProviderApiKey', { provider: 'Tavily' })}
                                value={tavilyApiKey}
                                onChange={(e) => setTavilyApiKey(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setTavilyVisible(!tavilyVisible)}
                            >
                                {tavilyVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {tavilyApiKey.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveTavily}>
                                {t('common.save')}
                            </button>
                        )}
                        <button
                            className={cx(styles.testButton, tavilyTestResult === 'success' && styles.testSuccess, tavilyTestResult === 'error' && styles.testError)}
                            onClick={handleTestTavily}
                            disabled={!tavilyConfigured || tavilyTesting}
                        >
                            {tavilyTesting ? t('common.testing') : tavilyTestResult === 'success' ? `✓ ${t('common.test')}` : tavilyTestResult === 'error' ? `✗ ${t('common.test')}` : t('common.test')}
                        </button>
                        {tavilyConfigured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('tavily', 'Tavily', setTavilyConfigured, setTavilyTestResult)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </section>

            {/* 图像生成服务配置 */}
            {/* GitHub API Token */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.githubTitle')}</h3>
                    <button
                        className={styles.externalLinkButton}
                        onClick={() => openExternalUrl(PROVIDER_URLS.github)}
                        title={t('settings.cloud.getApiKeyTitle')}
                    >
                        <ExternalLink size={14} />
                    </button>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {githubConfigured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>{t('settings.cloud.githubDesc')}</p>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.githubToken')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={githubVisible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={githubConfigured ? '••••••••••••' : t('settings.cloud.inputGithubToken')}
                                value={githubToken}
                                onChange={(e) => setGithubToken(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setGithubVisible(!githubVisible)}
                            >
                                {githubVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {githubToken.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveGithub}>
                                {t('common.save')}
                            </button>
                        )}
                        <button
                            className={cx(styles.testButton, githubTestResult === 'success' && styles.testSuccess, githubTestResult === 'error' && styles.testError)}
                            onClick={handleTestGithub}
                            disabled={!githubConfigured || githubTesting}
                        >
                            {githubTesting ? t('common.testing') : githubTestResult === 'success' ? `✓ ${t('common.test')}` : githubTestResult === 'error' ? `✕ ${t('common.test')}` : t('common.test')}
                        </button>
                        {githubConfigured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('github', 'GitHub', setGithubConfigured, setGithubTestResult)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </section>

            {/* Context7 API Key */}
            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.context7Title')}</h3>
                    <button
                        className={styles.externalLinkButton}
                        onClick={() => openExternalUrl(PROVIDER_URLS.context7)}
                        title={t('settings.cloud.getApiKeyTitle')}
                    >
                        <ExternalLink size={14} />
                    </button>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {context7Configured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>{t('settings.cloud.context7Desc')}</p>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.context7ApiKey')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={context7Visible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={context7Configured ? '••••••••••••' : t('settings.cloud.inputContext7ApiKey')}
                                value={context7ApiKey}
                                onChange={(e) => setContext7ApiKey(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setContext7Visible(!context7Visible)}
                            >
                                {context7Visible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {context7ApiKey.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveContext7}>
                                {t('common.save')}
                            </button>
                        )}
                        <button
                            className={cx(styles.testButton, context7TestResult === 'success' && styles.testSuccess, context7TestResult === 'error' && styles.testError)}
                            onClick={handleTestContext7}
                            disabled={!context7Configured || context7Testing}
                        >
                            {context7Testing ? t('common.testing') : context7TestResult === 'success' ? `✓ ${t('common.test')}` : context7TestResult === 'error' ? `✕ ${t('common.test')}` : t('common.test')}
                        </button>
                        {context7Configured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('context7', 'Context7', setContext7Configured, setContext7TestResult)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </section>

            <section className={styles.serviceSection}>
                <div className={styles.serviceHeader}>
                    <h3 className={styles.serviceName}>{t('settings.cloud.imageTitle')}</h3>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {imageGenerationConfigured && <span className={styles.configuredBadge}>{t('common.configured')}</span>}
                </div>

                <p className={styles.serviceDesc}>
                    {t('settings.cloud.imageDesc')}
                </p>

                <div className={styles.providerModelRow}>
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.cloud.model')}</label>
                        <input
                            type="text"
                            className={styles.input}
                            value={imageGenerationModel}
                            disabled
                        />
                    </div>
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.cloud.endpointUrl')}</label>
                        <div className={styles.inputRow}>
                            <input
                                type="text"
                                className={styles.input}
                                placeholder="https://api.example.com/v1"
                                value={imageGenerationUrlInput}
                                onChange={(e) => {
                                    setImageGenerationUrlInput(e.target.value);
                                    setImageGenerationUrlDirty(true);
                                }}
                                autoComplete="off"
                            />
                            {imageGenerationUrlDirty && (
                                <button className={styles.saveButton} onClick={handleSaveImageGenerationUrl}>
                                    {t('common.save')}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t('settings.cloud.apiKey')}</label>
                    <div className={styles.inputRow}>
                        <div className={styles.inputWrapper}>
                            <input
                                type={imageGenerationVisible ? 'text' : 'password'}
                                className={styles.input}
                                placeholder={imageGenerationConfigured ? '••••••••••••' : t('settings.cloud.inputImageApiKey')}
                                value={imageGenerationApiKey}
                                onChange={(e) => setImageGenerationApiKey(e.target.value)}
                                autoComplete="off"
                            />
                            <button
                                className={styles.visibilityButton}
                                onClick={() => setImageGenerationVisible(!imageGenerationVisible)}
                            >
                                {imageGenerationVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </button>
                        </div>
                        {imageGenerationApiKey.trim() && (
                            <button className={styles.saveButton} onClick={handleSaveImageGeneration}>
                                {t('common.save')}
                            </button>
                        )}
                        {imageGenerationConfigured && (
                            <button
                                className={styles.deleteButton}
                                onClick={() => handleDeleteApiKey('image-generation', t('settings.cloud.imageGeneration'), setImageGenerationConfigured, (_v) => undefined)}
                                title={t('settings.cloud.deleteApiKeyTitle')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>

                <div className={styles.toggleRow}>
                    <label className={styles.toggleLabel}>
                        <input
                            type="checkbox"
                            className={styles.toggleInput}
                            checked={imageGenerationUseStreaming}
                            onChange={(e) => setImageGenerationUseStreaming(e.target.checked)}
                        />
                        <span className={styles.toggleSwitch} />
                        <span className={styles.toggleText}>
                            {t('settings.cloud.imageStreamingLabel')}
                        </span>
                    </label>
                    <p className={styles.toggleHint}>
                        {t('settings.cloud.imageStreamingHint')}
                    </p>
                </div>
            </section>
        </div>
    );
}
