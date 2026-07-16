/**
 * CloudServiceSettings - 云端服务配置标签页
 *
 * 配置记忆系统 LLM、RAG 模型连接、网络搜索使用的云端服务。
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@components/ui/Toast';
import { Tooltip } from '@components/ui/Tooltip';
import { Select } from '@components/ui';
import { notifySetupStatusChanged } from '@components/onboarding/onboardingEvents';
import { useSettingsStore } from '@stores/settingsStore';
import { getProviders, getModelsByProvider } from '@/config/modelRegistry';
import { ExternalLink, Trash2 } from 'lucide-react';
import styles from './CloudServiceSettings.module.css';
import { getLogger } from '@services/logger';
import { openExternalUrl } from '@services/navigation/externalUrl';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { RagModelSettings } from './RagModelSettings';

const logger = getLogger('CloudServiceSettings');

/** 各服务商 API Key 获取页面 */
const PROVIDER_URLS = {
  tavily: 'https://app.tavily.com/home',
  github: 'https://github.com/settings/tokens',
  context7: 'https://context7.com/dashboard',
} as const;

/** 可见性切换 SVG 图标 - 可见状态（眼睛） */
function EyeOpenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** 可见性切换 SVG 图标 - 隐藏状态（划线眼睛） */
function EyeClosedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
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
      title: url
        ? t('settings.cloud.imageEndpointSaved')
        : t('settings.cloud.imageEndpointCleared'),
      type: 'success',
    });
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
      toast({
        title: t('settings.cloud.providerKeySaved', { provider: 'Tavily' }),
        type: 'success',
      });
    } catch (error) {
      toast({ title: t('settings.cloud.saveFailed'), description: String(error), type: 'error' });
    }
  };

  const handleTestTavily = async () => {
    setTavilyTesting(true);
    setTavilyTestResult(null);
    try {
      await invoke('web_search', { query: 'test', maxResults: 1, allowFallback: false });
      setTavilyTestResult('success');
      toast({
        title: t('settings.cloud.providerConnectSuccess', { provider: 'Tavily' }),
        type: 'success',
      });
    } catch (error) {
      logger.error('[CloudServiceSettings] Tavily 测试失败:', error);
      setTavilyTestResult('error');
      toast({
        title: t('settings.cloud.connectionFailed'),
        description: String(error),
        type: 'error',
      });
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
   * 复用 settings_delete_api_key 命令；当前调用方的云服务凭据均存储在同一 keystore 中。
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
      toast({
        title: t('settings.cloud.providerKeySaved', { provider: 'GitHub' }),
        type: 'success',
      });
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
      toast({
        title: t('settings.cloud.connectionFailed'),
        description: String(error),
        type: 'error',
      });
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
      toast({
        title: t('settings.cloud.providerKeySaved', { provider: 'Context7' }),
        type: 'success',
      });
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
      toast({
        title: t('settings.cloud.connectionFailed'),
        description: String(error),
        type: 'error',
      });
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
      toast({
        title: t('settings.cloud.providerKeyDeleted', { provider: displayName }),
        type: 'success',
      });
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

        <p className={styles.serviceDesc}>{t('settings.cloud.memoryDesc')}</p>

        <div className={styles.providerModelRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t('settings.cloud.provider')}</label>
            <Select
              className={styles.select}
              value={effectiveProvider}
              onValueChange={handleProviderChange}
              options={providerList.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t('settings.cloud.model')}</label>
            <Select
              className={styles.select}
              value={effectiveModel}
              onValueChange={setMemoryModel}
              options={modelList.map((m) => ({
                value: m.id,
                label: m.name,
              }))}
            />
          </div>
        </div>
      </section>

      <RagModelSettings />

      {/* Tavily 配置 */}
      <section className={styles.serviceSection}>
        <div className={styles.serviceHeader}>
          <h3 className={styles.serviceName}>{t('settings.cloud.tavilyTitle')}</h3>
          <Tooltip content={t('settings.cloud.getApiKeyTitle')}>
            <button
              className={styles.externalLinkButton}
              onClick={() => {
                void openExternalUrl(PROVIDER_URLS.tavily);
              }}
              aria-label={t('settings.cloud.getApiKeyTitle')}
            >
              <ExternalLink size={14} />
            </button>
          </Tooltip>
          <span className={styles.optionalBadge}>{t('common.optional')}</span>
          {tavilyConfigured && (
            <span className={styles.configuredBadge}>{t('common.configured')}</span>
          )}
        </div>

        <p className={styles.serviceDesc}>{t('settings.cloud.tavilyDesc')}</p>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t('settings.cloud.apiKey')}</label>
          <div className={styles.inputRow}>
            <div className={styles.inputWrapper}>
              <input
                type={tavilyVisible ? 'text' : 'password'}
                className={styles.input}
                placeholder={
                  tavilyConfigured
                    ? '••••••••••••'
                    : t('settings.cloud.inputProviderApiKey', { provider: 'Tavily' })
                }
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
              className={cx(
                styles.testButton,
                tavilyTestResult === 'success' && styles.testSuccess,
                tavilyTestResult === 'error' && styles.testError
              )}
              onClick={handleTestTavily}
              disabled={!tavilyConfigured || tavilyTesting}
            >
              {tavilyTesting
                ? t('common.testing')
                : tavilyTestResult === 'success'
                  ? `✓ ${t('common.test')}`
                  : tavilyTestResult === 'error'
                    ? `✗ ${t('common.test')}`
                    : t('common.test')}
            </button>
            {tavilyConfigured && (
              <Tooltip content={t('settings.cloud.deleteApiKeyTitle')}>
                <button
                  className={styles.deleteButton}
                  onClick={() =>
                    handleDeleteApiKey('tavily', 'Tavily', setTavilyConfigured, setTavilyTestResult)
                  }
                  aria-label={t('settings.cloud.deleteApiKeyTitle')}
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </section>

      {/* 图像生成服务配置 */}
      {/* GitHub API Token */}
      <section className={styles.serviceSection}>
        <div className={styles.serviceHeader}>
          <h3 className={styles.serviceName}>{t('settings.cloud.githubTitle')}</h3>
          <Tooltip content={t('settings.cloud.getApiKeyTitle')}>
            <button
              className={styles.externalLinkButton}
              onClick={() => {
                void openExternalUrl(PROVIDER_URLS.github);
              }}
              aria-label={t('settings.cloud.getApiKeyTitle')}
            >
              <ExternalLink size={14} />
            </button>
          </Tooltip>
          <span className={styles.optionalBadge}>{t('common.optional')}</span>
          {githubConfigured && (
            <span className={styles.configuredBadge}>{t('common.configured')}</span>
          )}
        </div>

        <p className={styles.serviceDesc}>{t('settings.cloud.githubDesc')}</p>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t('settings.cloud.githubToken')}</label>
          <div className={styles.inputRow}>
            <div className={styles.inputWrapper}>
              <input
                type={githubVisible ? 'text' : 'password'}
                className={styles.input}
                placeholder={
                  githubConfigured ? '••••••••••••' : t('settings.cloud.inputGithubToken')
                }
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
              className={cx(
                styles.testButton,
                githubTestResult === 'success' && styles.testSuccess,
                githubTestResult === 'error' && styles.testError
              )}
              onClick={handleTestGithub}
              disabled={!githubConfigured || githubTesting}
            >
              {githubTesting
                ? t('common.testing')
                : githubTestResult === 'success'
                  ? `✓ ${t('common.test')}`
                  : githubTestResult === 'error'
                    ? `✕ ${t('common.test')}`
                    : t('common.test')}
            </button>
            {githubConfigured && (
              <Tooltip content={t('settings.cloud.deleteApiKeyTitle')}>
                <button
                  className={styles.deleteButton}
                  onClick={() =>
                    handleDeleteApiKey('github', 'GitHub', setGithubConfigured, setGithubTestResult)
                  }
                  aria-label={t('settings.cloud.deleteApiKeyTitle')}
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </section>

      {/* Context7 API Key */}
      <section className={styles.serviceSection}>
        <div className={styles.serviceHeader}>
          <h3 className={styles.serviceName}>{t('settings.cloud.context7Title')}</h3>
          <Tooltip content={t('settings.cloud.getApiKeyTitle')}>
            <button
              className={styles.externalLinkButton}
              onClick={() => {
                void openExternalUrl(PROVIDER_URLS.context7);
              }}
              aria-label={t('settings.cloud.getApiKeyTitle')}
            >
              <ExternalLink size={14} />
            </button>
          </Tooltip>
          <span className={styles.optionalBadge}>{t('common.optional')}</span>
          {context7Configured && (
            <span className={styles.configuredBadge}>{t('common.configured')}</span>
          )}
        </div>

        <p className={styles.serviceDesc}>{t('settings.cloud.context7Desc')}</p>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t('settings.cloud.context7ApiKey')}</label>
          <div className={styles.inputRow}>
            <div className={styles.inputWrapper}>
              <input
                type={context7Visible ? 'text' : 'password'}
                className={styles.input}
                placeholder={
                  context7Configured ? '••••••••••••' : t('settings.cloud.inputContext7ApiKey')
                }
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
              className={cx(
                styles.testButton,
                context7TestResult === 'success' && styles.testSuccess,
                context7TestResult === 'error' && styles.testError
              )}
              onClick={handleTestContext7}
              disabled={!context7Configured || context7Testing}
            >
              {context7Testing
                ? t('common.testing')
                : context7TestResult === 'success'
                  ? `✓ ${t('common.test')}`
                  : context7TestResult === 'error'
                    ? `✕ ${t('common.test')}`
                    : t('common.test')}
            </button>
            {context7Configured && (
              <Tooltip content={t('settings.cloud.deleteApiKeyTitle')}>
                <button
                  className={styles.deleteButton}
                  onClick={() =>
                    handleDeleteApiKey(
                      'context7',
                      'Context7',
                      setContext7Configured,
                      setContext7TestResult
                    )
                  }
                  aria-label={t('settings.cloud.deleteApiKeyTitle')}
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </section>

      <section className={styles.serviceSection}>
        <div className={styles.serviceHeader}>
          <h3 className={styles.serviceName}>{t('settings.cloud.imageTitle')}</h3>
          <span className={styles.optionalBadge}>{t('common.optional')}</span>
          {imageGenerationConfigured && (
            <span className={styles.configuredBadge}>{t('common.configured')}</span>
          )}
        </div>

        <p className={styles.serviceDesc}>{t('settings.cloud.imageDesc')}</p>

        <div className={styles.providerModelRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t('settings.cloud.model')}</label>
            <input type="text" className={styles.input} value={imageGenerationModel} disabled />
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
                placeholder={
                  imageGenerationConfigured ? '••••••••••••' : t('settings.cloud.inputImageApiKey')
                }
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
              <Tooltip content={t('settings.cloud.deleteApiKeyTitle')}>
                <button
                  className={styles.deleteButton}
                  onClick={() =>
                    handleDeleteApiKey(
                      'image-generation',
                      t('settings.cloud.imageGeneration'),
                      setImageGenerationConfigured,
                      (_v) => undefined
                    )
                  }
                  aria-label={t('settings.cloud.deleteApiKeyTitle')}
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
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
            <span className={styles.toggleText}>{t('settings.cloud.imageStreamingLabel')}</span>
          </label>
          <p className={styles.toggleHint}>{t('settings.cloud.imageStreamingHint')}</p>
        </div>
      </section>
    </div>
  );
}
