/**
 * RagModelSettings - RAG Embedding 与 Reranker 连接设置。
 *
 * 推荐配置保持紧凑；自定义模式用互斥折叠面板分别配置两个可独立供应商的端点。
 * API Key 只写入 Rust 固定凭据槽，非敏感连接信息在确认后由 RAG 服务统一启用。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, ExternalLink, Eye, EyeOff, RotateCcw, Trash2 } from 'lucide-react';
import { ConfirmDialog, Select } from '@components/ui';
import { Tooltip } from '@components/ui/Tooltip';
import { useToast } from '@components/ui/Toast';
import { notifySetupStatusChanged } from '@components/onboarding/onboardingEvents';
import { useSettingsStore } from '@stores/settingsStore';
import type {
  CustomEmbeddingConfig,
  CustomGeminiEmbeddingConfig,
  CustomOpenAiEmbeddingConfig,
  CustomRagCredentialState,
  CustomRagCredentialStatus,
  CustomRerankerConfig,
} from '@/types/rag';
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
  GEMINI_EMBEDDING_ENDPOINT,
  GEMINI_EMBEDDING_MODELS,
  GEMINI_EMBEDDING_OUTPUT_DIMENSIONS,
  SILICONFLOW_EMBEDDING_MODEL,
  SILICONFLOW_RERANKER_MODEL,
  isCustomEmbeddingConfigValid,
  isCustomRerankerConfigValid,
  normalizeRagConnectionSettings,
  resolveRagEmbeddingRoute,
  resolveRagRerankerRoute,
  type RagConnectionSettingsInput,
} from '@services/rag/RagConnectionConfig';
import {
  RagConnectionActivationError,
  activateRagConnection,
  retryActiveRagIndexRebuild,
  testRagEmbeddingConnection,
  testRagRerankerConnection,
  type RagIndexRebuildProgress,
} from '@services/rag/RagConnectionService';
import { classifyEmbeddingError } from '@services/rag/EmbeddingService';
import { getLogger } from '@services/logger';
import { openExternalUrl } from '@services/navigation/externalUrl';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './RagModelSettings.module.css';

const logger = getLogger('RagModelSettings');
const SILICONFLOW_API_KEY_URL = 'https://cloud.siliconflow.cn/account/ak';
const GEMINI_API_KEY_URL = 'https://aistudio.google.com/apikey';
const GEMINI_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
const GEMINI_REGIONS_URL = 'https://ai.google.dev/gemini-api/docs/available-regions';
const GEMINI_TERMS_URL = 'https://ai.google.dev/gemini-api/terms';

type EmbeddingFailureHintKey =
  | 'settings.cloud.ragEmbeddingRateLimitConnectionHint'
  | 'settings.cloud.ragEmbeddingTimeoutConnectionHint'
  | 'settings.cloud.ragEmbeddingTransientConnectionHint'
  | 'settings.cloud.ragEmbeddingRateLimitRebuildHint'
  | 'settings.cloud.ragEmbeddingTimeoutRebuildHint'
  | 'settings.cloud.ragEmbeddingTransientRebuildHint';

type ConnectionKind = 'embedding' | 'reranker';
type CredentialKind = 'siliconflow' | 'embedding' | 'gemini_embedding' | 'reranker';
type TestState = 'idle' | 'testing' | 'success' | 'error';

interface TestFeedback {
  state: TestState;
  detail?: string;
}

const IDLE_TEST: TestFeedback = { state: 'idle' };

// eslint-disable-next-line react-refresh/only-export-components
export function getEmbeddingFailureHintKey(
  error: unknown,
  context: 'connection' | 'rebuild'
): EmbeddingFailureHintKey | null {
  const failure = classifyEmbeddingError(error);
  if (failure.category === 'rate_limit') {
    return context === 'connection'
      ? 'settings.cloud.ragEmbeddingRateLimitConnectionHint'
      : 'settings.cloud.ragEmbeddingRateLimitRebuildHint';
  }
  if (failure.category === 'timeout') {
    return context === 'connection'
      ? 'settings.cloud.ragEmbeddingTimeoutConnectionHint'
      : 'settings.cloud.ragEmbeddingTimeoutRebuildHint';
  }
  if (failure.category === 'transient') {
    return context === 'connection'
      ? 'settings.cloud.ragEmbeddingTransientConnectionHint'
      : 'settings.cloud.ragEmbeddingTransientRebuildHint';
  }
  return null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function shouldApplyRagTestResult(
  requestGeneration: number,
  latestGeneration: number
): boolean {
  return requestGeneration === latestGeneration;
}

// eslint-disable-next-line react-refresh/only-export-components
export function isRagCredentialActionLocked(
  kind: CredentialKind,
  embeddingTestState: TestState,
  rerankerTestState: TestState
): boolean {
  if (kind === 'siliconflow') {
    return embeddingTestState === 'testing' || rerankerTestState === 'testing';
  }
  if (kind === 'embedding' || kind === 'gemini_embedding') {
    return embeddingTestState === 'testing';
  }
  return rerankerTestState === 'testing';
}

// eslint-disable-next-line react-refresh/only-export-components
export function startRagApplyAfterConfirmation(
  closeConfirmation: () => void,
  startApply: () => void
): void {
  closeConfirmation();
  startApply();
}

export function createEmbeddingConfigForProtocol(protocol: 'openai'): CustomOpenAiEmbeddingConfig;
export function createEmbeddingConfigForProtocol(protocol: 'gemini'): CustomGeminiEmbeddingConfig;
export function createEmbeddingConfigForProtocol(
  protocol: CustomEmbeddingConfig['protocol']
): CustomEmbeddingConfig;
// eslint-disable-next-line react-refresh/only-export-components
export function createEmbeddingConfigForProtocol(
  protocol: CustomEmbeddingConfig['protocol']
): CustomEmbeddingConfig {
  if (protocol === 'gemini') {
    return {
      providerName: 'Google Gemini',
      protocol,
      endpointUrl: GEMINI_EMBEDDING_ENDPOINT,
      modelId: DEFAULT_GEMINI_EMBEDDING_MODEL,
      authMode: 'google_api_key',
      outputDimension: DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIMENSION,
    };
  }
  return {
    providerName: '',
    protocol,
    endpointUrl: '',
    modelId: '',
    authMode: 'bearer',
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export function selectEmbeddingProtocolDraft(
  protocol: CustomEmbeddingConfig['protocol'],
  openAiDraft: CustomOpenAiEmbeddingConfig,
  geminiDraft: CustomGeminiEmbeddingConfig
): CustomEmbeddingConfig {
  return protocol === 'gemini' ? geminiDraft : openAiDraft;
}

function embeddingTestSignature(settings: RagConnectionSettingsInput): string {
  const route = resolveRagEmbeddingRoute(settings);
  return JSON.stringify([
    route.provider,
    route.protocol,
    route.endpointUrl ?? '',
    route.modelId,
    route.authMode,
    route.outputDimension ?? '',
  ]);
}

function rerankerTestSignature(settings: RagConnectionSettingsInput): string {
  const route = resolveRagRerankerRoute(settings);
  return JSON.stringify([
    route.enabled,
    route.provider,
    route.protocol,
    route.endpointUrl ?? '',
    route.modelId,
    route.authMode,
  ]);
}

function configsEqual(
  left: RagConnectionSettingsInput,
  right: RagConnectionSettingsInput
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayConnectionSummary(
  providerName: string,
  endpointUrl: string,
  modelId: string,
  fallback: string
): string {
  let provider = providerName.trim();
  if (!provider && endpointUrl) {
    try {
      provider = new URL(endpointUrl).host;
    } catch {
      provider = '';
    }
  }
  return provider && modelId ? `${provider} · ${modelId}` : fallback;
}

interface RagIndexRebuildButtonProps {
  applying: boolean;
  hasUnsavedChanges: boolean;
  activeEmbeddingReady: boolean;
  needsRetry: boolean;
  onRebuild: () => void;
}

export function RagIndexRebuildButton({
  applying,
  hasUnsavedChanges,
  activeEmbeddingReady,
  needsRetry,
  onRebuild,
}: RagIndexRebuildButtonProps) {
  const { t } = useI18n();
  const disabledHint = applying
    ? t('settings.cloud.ragRebuildBusyHint')
    : hasUnsavedChanges
      ? t('settings.cloud.ragRebuildUnsavedHint')
      : !activeEmbeddingReady
        ? t('settings.cloud.ragRebuildUnavailableHint')
        : undefined;

  return (
    <Tooltip content={disabledHint} multiline>
      <span className={styles.retryWrapper}>
        <button
          type="button"
          className={cx(styles.retryButton, needsRetry && styles.retryAttention)}
          onClick={onRebuild}
          disabled={Boolean(disabledHint)}
        >
          <RotateCcw size={14} />
          {needsRetry ? t('settings.cloud.ragRetryRebuild') : t('settings.cloud.ragCheckRebuild')}
        </button>
      </span>
    </Tooltip>
  );
}

export function RagModelSettings() {
  const { t } = useI18n();
  const { toast } = useToast();

  const activeMode = useSettingsStore((state) => state.ragServiceMode);
  const activeEmbedding = useSettingsStore((state) => state.customEmbeddingConfig);
  const activeReranker = useSettingsStore((state) => state.customRerankerConfig);

  const [draftMode, setDraftMode] = useState(activeMode);
  const [draftEmbedding, setDraftEmbedding] = useState<CustomEmbeddingConfig>(activeEmbedding);
  const [openAiEmbeddingDraft, setOpenAiEmbeddingDraft] = useState<CustomOpenAiEmbeddingConfig>(
    activeEmbedding.protocol === 'openai'
      ? activeEmbedding
      : createEmbeddingConfigForProtocol('openai')
  );
  const [geminiEmbeddingDraft, setGeminiEmbeddingDraft] = useState<CustomGeminiEmbeddingConfig>(
    activeEmbedding.protocol === 'gemini'
      ? activeEmbedding
      : createEmbeddingConfigForProtocol('gemini')
  );
  const [draftReranker, setDraftReranker] = useState<CustomRerankerConfig>(activeReranker);
  const [expandedConnection, setExpandedConnection] = useState<ConnectionKind | null>('embedding');

  const [siliconflowKey, setSiliconflowKey] = useState('');
  const [embeddingKey, setEmbeddingKey] = useState('');
  const [geminiEmbeddingKey, setGeminiEmbeddingKey] = useState('');
  const [rerankerKey, setRerankerKey] = useState('');
  const [siliconflowKeyVisible, setSiliconflowKeyVisible] = useState(false);
  const [embeddingKeyVisible, setEmbeddingKeyVisible] = useState(false);
  const [geminiEmbeddingKeyVisible, setGeminiEmbeddingKeyVisible] = useState(false);
  const [rerankerKeyVisible, setRerankerKeyVisible] = useState(false);
  const [siliconflowConfigured, setSiliconflowConfigured] = useState(false);
  const [geminiEmbeddingConfigured, setGeminiEmbeddingConfigured] = useState(false);
  const [embeddingCredentialState, setEmbeddingCredentialState] =
    useState<CustomRagCredentialState>('missing');
  const [rerankerCredentialState, setRerankerCredentialState] =
    useState<CustomRagCredentialState>('missing');
  const embeddingConfigured = embeddingCredentialState === 'bound';
  const rerankerConfigured = rerankerCredentialState === 'bound';

  const [embeddingFeedback, setEmbeddingFeedback] = useState<TestFeedback>(IDLE_TEST);
  const [rerankerFeedback, setRerankerFeedback] = useState<TestFeedback>(IDLE_TEST);
  const [testedEmbeddingSignature, setTestedEmbeddingSignature] = useState<string | null>(null);
  const [testedEmbeddingDimension, setTestedEmbeddingDimension] = useState<number | null>(null);
  const [testedRerankerSignature, setTestedRerankerSignature] = useState<string | null>(null);
  const embeddingTestGenerationRef = useRef(0);
  const rerankerTestGenerationRef = useRef(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<RagIndexRebuildProgress | null>(null);
  const [rebuildNeedsRetry, setRebuildNeedsRetry] = useState(false);

  useEffect(() => {
    setDraftMode(activeMode);
    setDraftEmbedding(activeEmbedding);
    if (activeEmbedding.protocol === 'gemini') {
      setGeminiEmbeddingDraft(activeEmbedding);
    } else {
      setOpenAiEmbeddingDraft(activeEmbedding);
    }
    setDraftReranker(activeReranker);
  }, [activeEmbedding, activeMode, activeReranker]);

  useEffect(() => {
    let cancelled = false;
    const loadCredentialStatuses = async () => {
      const results = await Promise.allSettled([
        invoke<boolean>('get_siliconflow_api_key_status'),
        invoke<CustomRagCredentialStatus>('get_custom_rag_credential_status', {
          kind: 'gemini_embedding',
          endpointUrl: null,
        }),
      ]);
      if (cancelled) return;
      if (results[0].status === 'fulfilled') setSiliconflowConfigured(results[0].value);
      if (results[1].status === 'fulfilled') {
        setGeminiEmbeddingConfigured(results[1].value.state === 'bound');
      }
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn('[RagModelSettings] Failed to load a credential status');
        }
      }
    };
    void loadCredentialStatuses();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadEndpointCredentialStatuses = async () => {
      const results = await Promise.allSettled([
        invoke<CustomRagCredentialStatus>('get_custom_rag_credential_status', {
          kind: 'embedding',
          endpointUrl: openAiEmbeddingDraft.endpointUrl,
        }),
        invoke<CustomRagCredentialStatus>('get_custom_rag_credential_status', {
          kind: 'reranker',
          endpointUrl: draftReranker.endpointUrl,
        }),
      ]);
      if (cancelled) return;
      if (results[0].status === 'fulfilled') {
        setEmbeddingCredentialState(results[0].value.state);
      }
      if (results[1].status === 'fulfilled') {
        setRerankerCredentialState(results[1].value.state);
      }
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn('[RagModelSettings] Failed to load an endpoint credential status');
        }
      }
    };
    void loadEndpointCredentialStatuses();
    return () => {
      cancelled = true;
    };
  }, [draftReranker.endpointUrl, openAiEmbeddingDraft.endpointUrl]);

  const activeSettings = useMemo(
    () =>
      normalizeRagConnectionSettings({
        ragServiceMode: activeMode,
        customEmbeddingConfig: activeEmbedding,
        customRerankerConfig: activeReranker,
      }),
    [activeEmbedding, activeMode, activeReranker]
  );
  const nextSettings = useMemo(
    () =>
      normalizeRagConnectionSettings({
        ragServiceMode: draftMode,
        customEmbeddingConfig: draftEmbedding,
        customRerankerConfig: draftReranker,
      }),
    [draftEmbedding, draftMode, draftReranker]
  );

  const activeEmbeddingSignature = embeddingTestSignature(activeSettings);
  const nextEmbeddingSignature = embeddingTestSignature(nextSettings);
  const activeRerankerSignature = rerankerTestSignature(activeSettings);
  const nextRerankerSignature = rerankerTestSignature(nextSettings);
  const embeddingRouteChanged = activeEmbeddingSignature !== nextEmbeddingSignature;
  const rerankerRouteChanged = activeRerankerSignature !== nextRerankerSignature;
  const embeddingProfileChanged =
    resolveRagEmbeddingRoute(activeSettings).profileId !==
    resolveRagEmbeddingRoute(nextSettings).profileId;
  const nextRerankerRoute = resolveRagRerankerRoute(nextSettings);
  const isDirty = !configsEqual(activeSettings, nextSettings);
  const embeddingTestIsCurrent = testedEmbeddingSignature === nextEmbeddingSignature;
  const rerankerTestIsCurrent = testedRerankerSignature === nextRerankerSignature;
  const draftEmbeddingCredentialKind =
    draftEmbedding.protocol === 'gemini' ? 'gemini_embedding' : 'embedding';
  const activeEmbeddingConfigured =
    activeEmbedding.protocol === 'gemini' ? geminiEmbeddingConfigured : embeddingConfigured;
  const customConfigValid =
    isCustomEmbeddingConfigValid(nextSettings.customEmbeddingConfig) &&
    isCustomRerankerConfigValid(nextSettings.customRerankerConfig);
  const embeddingCredentialReady =
    draftMode === 'siliconflow'
      ? siliconflowConfigured
      : nextSettings.customEmbeddingConfig.authMode === 'none' ||
        (nextSettings.customEmbeddingConfig.protocol === 'gemini'
          ? geminiEmbeddingConfigured
          : embeddingConfigured);
  const rerankerCredentialReady =
    draftMode === 'siliconflow'
      ? siliconflowConfigured
      : !nextSettings.customRerankerConfig.enabled ||
        nextSettings.customRerankerConfig.authMode === 'none' ||
        rerankerConfigured;
  const activeEmbeddingCredentialReady =
    activeMode === 'siliconflow'
      ? siliconflowConfigured
      : isCustomEmbeddingConfigValid(activeEmbedding) &&
        (activeEmbedding.authMode === 'none' || activeEmbeddingConfigured);
  const requiredTestsReady =
    (!embeddingRouteChanged || embeddingTestIsCurrent) &&
    (!rerankerRouteChanged || !nextRerankerRoute.enabled || rerankerTestIsCurrent);
  const hasUnsavedCredential =
    draftMode === 'siliconflow'
      ? Boolean(siliconflowKey.trim())
      : Boolean(
          (draftEmbedding.authMode !== 'none' &&
            (draftEmbeddingCredentialKind === 'gemini_embedding'
              ? geminiEmbeddingKey.trim()
              : embeddingKey.trim())) ||
          (draftReranker.enabled && draftReranker.authMode === 'bearer' && rerankerKey.trim())
        );

  useEffect(() => {
    embeddingTestGenerationRef.current += 1;
    setTestedEmbeddingSignature(null);
    setTestedEmbeddingDimension(null);
    setEmbeddingFeedback(IDLE_TEST);
  }, [nextEmbeddingSignature]);

  useEffect(() => {
    rerankerTestGenerationRef.current += 1;
    setTestedRerankerSignature(null);
    setRerankerFeedback(IDLE_TEST);
  }, [nextRerankerSignature]);

  const updateOpenAiEmbedding = (patch: Partial<CustomOpenAiEmbeddingConfig>) => {
    if (draftEmbedding.protocol !== 'openai') return;
    const next = { ...draftEmbedding, ...patch };
    setOpenAiEmbeddingDraft(next);
    setDraftEmbedding(next);
  };

  const updateGeminiEmbedding = (patch: Partial<CustomGeminiEmbeddingConfig>) => {
    if (draftEmbedding.protocol !== 'gemini') return;
    const next = { ...draftEmbedding, ...patch };
    setGeminiEmbeddingDraft(next);
    setDraftEmbedding(next);
  };

  const updateOpenAiEmbeddingEndpoint = (endpointUrl: string) => {
    if (endpointUrl !== openAiEmbeddingDraft.endpointUrl) {
      setEmbeddingKey('');
      setEmbeddingKeyVisible(false);
    }
    updateOpenAiEmbedding({ endpointUrl });
  };

  const updateEmbeddingProtocol = (protocol: CustomEmbeddingConfig['protocol']) => {
    if (protocol === draftEmbedding.protocol) return;
    setDraftEmbedding(
      selectEmbeddingProtocolDraft(protocol, openAiEmbeddingDraft, geminiEmbeddingDraft)
    );
  };

  const updateReranker = (patch: Partial<CustomRerankerConfig>) => {
    setDraftReranker((current) => ({ ...current, ...patch }));
  };

  const updateRerankerEndpoint = (endpointUrl: string) => {
    if (endpointUrl !== draftReranker.endpointUrl) {
      setRerankerKey('');
      setRerankerKeyVisible(false);
    }
    updateReranker({ endpointUrl });
  };

  const credentialValue = (kind: CredentialKind): string => {
    if (kind === 'siliconflow') return siliconflowKey;
    if (kind === 'embedding') return embeddingKey;
    if (kind === 'gemini_embedding') return geminiEmbeddingKey;
    return rerankerKey;
  };

  const clearCredentialInput = (kind: CredentialKind) => {
    if (kind === 'siliconflow') setSiliconflowKey('');
    else if (kind === 'embedding') setEmbeddingKey('');
    else if (kind === 'gemini_embedding') setGeminiEmbeddingKey('');
    else setRerankerKey('');
  };

  const setCredentialConfigured = (kind: CredentialKind, configured: boolean) => {
    if (kind === 'siliconflow') setSiliconflowConfigured(configured);
    else if (kind === 'embedding') {
      setEmbeddingCredentialState(configured ? 'bound' : 'missing');
    } else if (kind === 'gemini_embedding') setGeminiEmbeddingConfigured(configured);
    else setRerankerCredentialState(configured ? 'bound' : 'missing');
  };

  const invalidateCredentialTest = (kind: CredentialKind) => {
    if (kind === 'siliconflow' || kind === 'embedding' || kind === 'gemini_embedding') {
      embeddingTestGenerationRef.current += 1;
      setTestedEmbeddingSignature(null);
      setTestedEmbeddingDimension(null);
      setEmbeddingFeedback(IDLE_TEST);
    }
    if (kind === 'siliconflow' || kind === 'reranker') {
      rerankerTestGenerationRef.current += 1;
      setTestedRerankerSignature(null);
      setRerankerFeedback(IDLE_TEST);
    }
  };

  const credentialDisplayName = (kind: CredentialKind): string => {
    if (kind === 'siliconflow') return 'SiliconFlow';
    if (kind === 'gemini_embedding') return t('settings.cloud.ragGeminiProvider');
    if (kind === 'embedding') return t('settings.cloud.ragEmbeddingPurpose');
    return t('settings.cloud.ragRerankerPurpose');
  };

  const handleSaveCredential = async (kind: CredentialKind) => {
    const apiKey = credentialValue(kind).trim();
    if (!apiKey) {
      toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
      return;
    }
    try {
      if (kind === 'siliconflow') {
        await invoke('set_siliconflow_api_key', { apiKey });
      } else {
        const endpointUrl =
          kind === 'embedding'
            ? openAiEmbeddingDraft.endpointUrl
            : kind === 'reranker'
              ? draftReranker.endpointUrl
              : undefined;
        await invoke('set_custom_rag_api_key', {
          kind,
          apiKey,
          endpointUrl: endpointUrl ?? null,
        });
      }
      setCredentialConfigured(kind, true);
      clearCredentialInput(kind);
      invalidateCredentialTest(kind);
      notifySetupStatusChanged();
      toast({
        title: t('settings.cloud.providerKeySaved', { provider: credentialDisplayName(kind) }),
        type: 'success',
      });
    } catch {
      logger.error(`[RagModelSettings] Failed to save ${kind} credential`);
      toast({
        title: t('settings.cloud.saveFailed'),
        description: t('settings.cloud.ragCredentialOperationFailedHint'),
        type: 'error',
      });
    }
  };

  const handleDeleteCredential = async (kind: CredentialKind) => {
    try {
      if (kind === 'siliconflow') {
        await invoke('settings_delete_api_key', { provider: 'siliconflow' });
      } else {
        await invoke('delete_custom_rag_api_key', { kind });
      }
      setCredentialConfigured(kind, false);
      invalidateCredentialTest(kind);
      notifySetupStatusChanged();
      toast({
        title: t('settings.cloud.providerKeyDeleted', { provider: credentialDisplayName(kind) }),
        type: 'success',
      });
    } catch {
      logger.error(`[RagModelSettings] Failed to delete ${kind} credential`);
      toast({
        title: t('settings.cloud.deleteFailed'),
        description: t('settings.cloud.ragCredentialOperationFailedHint'),
        type: 'error',
      });
    }
  };

  const handleTestEmbedding = async (includeRecommendedReranker: boolean) => {
    const embeddingRequestGeneration = ++embeddingTestGenerationRef.current;
    const rerankerRequestGeneration = includeRecommendedReranker
      ? ++rerankerTestGenerationRef.current
      : null;
    const requestIsCurrent = () =>
      shouldApplyRagTestResult(embeddingRequestGeneration, embeddingTestGenerationRef.current) &&
      (rerankerRequestGeneration === null ||
        shouldApplyRagTestResult(rerankerRequestGeneration, rerankerTestGenerationRef.current));
    setEmbeddingFeedback({ state: 'testing' });
    if (includeRecommendedReranker) setRerankerFeedback({ state: 'testing' });
    try {
      const result = await testRagEmbeddingConnection(nextSettings);
      if (!requestIsCurrent()) return;
      setTestedEmbeddingSignature(nextEmbeddingSignature);
      setTestedEmbeddingDimension(result.dimension);
      setEmbeddingFeedback({
        state: 'success',
        detail: t('settings.cloud.ragTestEmbeddingSuccess', {
          dimension: result.dimension,
          latency: result.latencyMs,
        }),
      });

      if (includeRecommendedReranker) {
        const rerankerResult = await testRagRerankerConnection(nextSettings);
        if (!requestIsCurrent()) return;
        setTestedRerankerSignature(nextRerankerSignature);
        setRerankerFeedback({
          state: 'success',
          detail: t('settings.cloud.ragTestRerankerSuccess', {
            latency: rerankerResult.latencyMs,
          }),
        });
      }

      if (!requestIsCurrent()) return;
      toast({
        title: t('settings.cloud.providerConnectSuccess', {
          provider: includeRecommendedReranker
            ? 'SiliconFlow'
            : draftEmbedding.providerName.trim() || t('settings.cloud.ragEmbeddingPurpose'),
        }),
        type: 'success',
      });
    } catch (error) {
      if (!requestIsCurrent()) return;
      const failureHintKey = getEmbeddingFailureHintKey(error, 'connection');
      logger.error('[RagModelSettings] Embedding connection test failed', {
        reason: failureHintKey ?? 'OTHER',
      });
      setTestedEmbeddingSignature(null);
      setTestedEmbeddingDimension(null);
      setEmbeddingFeedback({ state: 'error' });
      if (includeRecommendedReranker) {
        setTestedRerankerSignature(null);
        setRerankerFeedback({ state: 'error' });
      }
      toast({
        title: t('settings.cloud.connectionFailed'),
        description: t(failureHintKey ?? 'settings.cloud.ragConnectionTestFailedHint'),
        type: 'error',
      });
    }
  };

  const handleTestReranker = async () => {
    const requestGeneration = ++rerankerTestGenerationRef.current;
    setRerankerFeedback({ state: 'testing' });
    try {
      const result = await testRagRerankerConnection(nextSettings);
      if (!shouldApplyRagTestResult(requestGeneration, rerankerTestGenerationRef.current)) {
        return;
      }
      setTestedRerankerSignature(nextRerankerSignature);
      setRerankerFeedback({
        state: 'success',
        detail: t('settings.cloud.ragTestRerankerSuccess', { latency: result.latencyMs }),
      });
      toast({
        title: t('settings.cloud.providerConnectSuccess', {
          provider: draftReranker.providerName.trim() || t('settings.cloud.ragRerankerPurpose'),
        }),
        type: 'success',
      });
    } catch {
      if (!shouldApplyRagTestResult(requestGeneration, rerankerTestGenerationRef.current)) {
        return;
      }
      logger.error('[RagModelSettings] Reranker connection test failed');
      setTestedRerankerSignature(null);
      setRerankerFeedback({ state: 'error' });
      toast({
        title: t('settings.cloud.connectionFailed'),
        description: t('settings.cloud.ragConnectionTestFailedHint'),
        type: 'error',
      });
    }
  };

  const handleApplyRequest = () => {
    if (hasUnsavedCredential) {
      toast({ title: t('settings.cloud.ragSaveApiKeyFirst'), type: 'warning' });
      return;
    }
    if (draftMode === 'custom' && !customConfigValid) {
      toast({ title: t('settings.cloud.ragRequiredFieldsMissing'), type: 'warning' });
      return;
    }
    if (!embeddingCredentialReady || !rerankerCredentialReady) {
      toast({ title: t('settings.cloud.enterApiKey'), type: 'warning' });
      return;
    }
    if (!requiredTestsReady) {
      toast({ title: t('settings.cloud.ragConnectionTestRequired'), type: 'warning' });
      return;
    }
    if (embeddingProfileChanged) {
      setConfirmOpen(true);
      return;
    }
    void applyConnection();
  };

  const applyConnection = async () => {
    setApplying(true);
    setRebuildProgress(null);
    setRebuildNeedsRetry(false);
    try {
      await activateRagConnection(nextSettings, {
        testEmbedding: false,
        expectedEmbeddingDimension: testedEmbeddingDimension ?? undefined,
        onProgress: setRebuildProgress,
      });
      setRebuildProgress(null);
      notifySetupStatusChanged();
      toast({ title: t('settings.cloud.ragApplySuccess'), type: 'success' });
    } catch (error) {
      const failureHintKey = getEmbeddingFailureHintKey(error, 'rebuild');
      logger.error('[RagModelSettings] Failed to activate RAG connection', {
        reason: failureHintKey ?? 'OTHER',
      });
      const settingsApplied =
        error instanceof RagConnectionActivationError && error.settingsApplied;
      setRebuildNeedsRetry(settingsApplied);
      const guidance = failureHintKey
        ? t(failureHintKey)
        : settingsApplied
          ? t('settings.cloud.ragApplyFailedHint')
          : t('settings.cloud.ragApplyNotAppliedHint');
      toast({
        title: t('settings.cloud.ragApplyFailed'),
        description: guidance,
        type: 'error',
      });
    } finally {
      setApplying(false);
    }
  };

  const handleRetryRebuild = async () => {
    setApplying(true);
    setRebuildProgress(null);
    try {
      await retryActiveRagIndexRebuild({ onProgress: setRebuildProgress });
      setRebuildNeedsRetry(false);
      setRebuildProgress(null);
      toast({ title: t('settings.cloud.ragRetrySuccess'), type: 'success' });
    } catch (error) {
      const failureHintKey = getEmbeddingFailureHintKey(error, 'rebuild');
      logger.error('[RagModelSettings] Failed to retry RAG index rebuild', {
        reason: failureHintKey ?? 'OTHER',
      });
      setRebuildNeedsRetry(true);
      const guidance = t(failureHintKey ?? 'settings.cloud.ragApplyFailedHint');
      toast({
        title: t('settings.cloud.ragRetryFailed'),
        description: guidance,
        type: 'error',
      });
    } finally {
      setApplying(false);
    }
  };

  const renderCredentialField = (kind: CredentialKind) => {
    const bindingState: CustomRagCredentialState =
      kind === 'embedding'
        ? embeddingCredentialState
        : kind === 'reranker'
          ? rerankerCredentialState
          : kind === 'siliconflow'
            ? siliconflowConfigured
              ? 'bound'
              : 'missing'
            : geminiEmbeddingConfigured
              ? 'bound'
              : 'missing';
    const configured = bindingState === 'bound';
    const hasStoredCredential = bindingState !== 'missing';
    const value = credentialValue(kind);
    const visible =
      kind === 'siliconflow'
        ? siliconflowKeyVisible
        : kind === 'embedding'
          ? embeddingKeyVisible
          : kind === 'gemini_embedding'
            ? geminiEmbeddingKeyVisible
            : rerankerKeyVisible;
    const setValue =
      kind === 'siliconflow'
        ? setSiliconflowKey
        : kind === 'embedding'
          ? setEmbeddingKey
          : kind === 'gemini_embedding'
            ? setGeminiEmbeddingKey
            : setRerankerKey;
    const setVisible =
      kind === 'siliconflow'
        ? setSiliconflowKeyVisible
        : kind === 'embedding'
          ? setEmbeddingKeyVisible
          : kind === 'gemini_embedding'
            ? setGeminiEmbeddingKeyVisible
            : setRerankerKeyVisible;
    const purpose = credentialDisplayName(kind);
    const credentialActionLocked = isRagCredentialActionLocked(
      kind,
      embeddingFeedback.state,
      rerankerFeedback.state
    );

    return (
      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor={`rag-${kind}-api-key`}>
          {kind === 'siliconflow'
            ? t('settings.cloud.apiKey')
            : kind === 'gemini_embedding'
              ? t('settings.cloud.ragGeminiApiKey')
              : t('settings.cloud.ragEndpointApiKey', { purpose })}
        </label>
        <div className={styles.inputRow}>
          <div className={styles.secretInputWrapper}>
            <input
              id={`rag-${kind}-api-key`}
              type={visible ? 'text' : 'password'}
              className={styles.input}
              placeholder={
                configured
                  ? '••••••••••••'
                  : t('settings.cloud.inputProviderApiKey', { provider: purpose })
              }
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className={styles.visibilityButton}
              onClick={() => setVisible(!visible)}
              aria-label={visible ? t('common.hide') : t('common.show')}
            >
              {visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
          </div>
          {value.trim() && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void handleSaveCredential(kind)}
              disabled={credentialActionLocked}
            >
              {t('common.save')}
            </button>
          )}
          {hasStoredCredential && (
            <Tooltip content={t('settings.cloud.deleteApiKeyTitle')}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => void handleDeleteCredential(kind)}
                aria-label={t('settings.cloud.deleteApiKeyTitle')}
                disabled={credentialActionLocked}
              >
                <Trash2 size={15} />
              </button>
            </Tooltip>
          )}
        </div>
        {(kind === 'embedding' || kind === 'reranker') && (
          <span className={styles.fieldHint}>{t('settings.cloud.ragCredentialSaveHint')}</span>
        )}
        {bindingState === 'different_endpoint' && (
          <span className={styles.credentialWarning} role="status">
            {t('settings.cloud.ragCredentialDifferentEndpoint')}
          </span>
        )}
        {bindingState === 'legacy' && (
          <span className={styles.credentialWarning} role="status">
            {t('settings.cloud.ragCredentialLegacy')}
          </span>
        )}
      </div>
    );
  };

  const renderTestButton = (kind: ConnectionKind, includeRecommendedReranker = false) => {
    const feedback = kind === 'embedding' ? embeddingFeedback : rerankerFeedback;
    const isCurrent = kind === 'embedding' ? embeddingTestIsCurrent : rerankerTestIsCurrent;
    const ready =
      kind === 'embedding'
        ? embeddingCredentialReady &&
          !(draftMode === 'siliconflow'
            ? siliconflowKey.trim()
            : credentialValue(draftEmbeddingCredentialKind).trim()) &&
          (draftMode === 'siliconflow' || isCustomEmbeddingConfigValid(draftEmbedding))
        : rerankerCredentialReady &&
          !rerankerKey.trim() &&
          nextRerankerRoute.enabled &&
          isCustomRerankerConfigValid(draftReranker);
    const testing =
      feedback.state === 'testing' ||
      (includeRecommendedReranker && rerankerFeedback.state === 'testing');
    return (
      <button
        type="button"
        className={cx(
          styles.secondaryButton,
          isCurrent && styles.testSuccess,
          feedback.state === 'error' && styles.testError
        )}
        onClick={() =>
          kind === 'embedding'
            ? void handleTestEmbedding(includeRecommendedReranker)
            : void handleTestReranker()
        }
        disabled={!ready || testing || applying}
      >
        {testing
          ? t('common.testing')
          : isCurrent
            ? `✓ ${t('common.test')}`
            : feedback.state === 'error'
              ? `✗ ${t('common.test')}`
              : t('common.test')}
      </button>
    );
  };

  const hasChunkProgress = (rebuildProgress?.totalChunks ?? 0) > 0;
  const progressCurrent = hasChunkProgress
    ? (rebuildProgress?.completedChunks ?? 0)
    : (rebuildProgress?.completedAgents ?? 0);
  const progressTotal = hasChunkProgress
    ? (rebuildProgress?.totalChunks ?? 0)
    : (rebuildProgress?.totalAgents ?? 0);

  return (
    <>
      <section className={styles.card}>
        <div className={styles.header}>
          <div>
            <h3 className={styles.title}>{t('settings.cloud.ragConnectionTitle')}</h3>
            <p className={styles.description}>{t('settings.cloud.ragConnectionDesc')}</p>
          </div>
          <span className={styles.requiredBadge}>{t('common.required')}</span>
        </div>

        <fieldset className={styles.settingsFieldset} disabled={applying}>
          <label className={styles.modeSwitchRow}>
            <span>
              <span className={styles.modeLabel}>{t('settings.cloud.ragUseSiliconflow')}</span>
              <span className={styles.modeHint}>{t('settings.cloud.ragUseSiliconflowHint')}</span>
            </span>
            <input
              type="checkbox"
              className={styles.switchInput}
              checked={draftMode === 'siliconflow'}
              onChange={(event) => setDraftMode(event.target.checked ? 'siliconflow' : 'custom')}
              disabled={applying}
            />
            <span className={styles.switchTrack} aria-hidden="true" />
          </label>

          {draftMode === 'siliconflow' ? (
            <div className={styles.recommendedPanel}>
              <div className={styles.summaryRow}>
                <span className={styles.summaryText}>
                  {t('settings.cloud.ragSiliconflowSummary')}
                </span>
                <Tooltip content={t('settings.cloud.getApiKeyTitle')}>
                  <button
                    type="button"
                    className={styles.externalButton}
                    onClick={() => void openExternalUrl(SILICONFLOW_API_KEY_URL)}
                    aria-label={t('settings.cloud.getApiKeyTitle')}
                  >
                    <ExternalLink size={15} />
                  </button>
                </Tooltip>
                {siliconflowConfigured && (
                  <span className={styles.configuredBadge}>{t('common.configured')}</span>
                )}
              </div>
              <div className={styles.modelSummaryList}>
                <div className={styles.modelSummaryRow}>
                  <span className={styles.modelRole}>{t('settings.cloud.embeddingModel')}</span>
                  <code className={styles.modelId}>{SILICONFLOW_EMBEDDING_MODEL}</code>
                  <span className={styles.modelMeta}>
                    {t('settings.cloud.ragEmbeddingDimension')}
                  </span>
                </div>
                <div className={styles.modelSummaryRow}>
                  <span className={styles.modelRole}>{t('settings.cloud.rerankerModel')}</span>
                  <code className={styles.modelId}>{SILICONFLOW_RERANKER_MODEL}</code>
                </div>
              </div>
              <div className={styles.connectionActionRow}>
                <div className={styles.grow}>{renderCredentialField('siliconflow')}</div>
                {renderTestButton('embedding', true)}
              </div>
              {(embeddingFeedback.detail ?? rerankerFeedback.detail) && (
                <div className={styles.testDetails} role="status">
                  {embeddingFeedback.detail && <span>{embeddingFeedback.detail}</span>}
                  {rerankerFeedback.detail && <span>{rerankerFeedback.detail}</span>}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.customPanel}>
              <p className={styles.customSummary}>{t('settings.cloud.ragCustomSummary')}</p>

              <div className={styles.accordionItem}>
                <button
                  type="button"
                  className={styles.accordionHeader}
                  onClick={() =>
                    setExpandedConnection((current) =>
                      current === 'embedding' ? null : 'embedding'
                    )
                  }
                  aria-expanded={expandedConnection === 'embedding'}
                  aria-controls="rag-embedding-panel"
                >
                  <span className={styles.accordionTitleGroup}>
                    <span className={styles.accordionTitle}>
                      {t('settings.cloud.ragEmbeddingConnection')}
                    </span>
                    <span className={styles.requiredBadge}>{t('common.required')}</span>
                    {isCustomEmbeddingConfigValid(draftEmbedding) && embeddingCredentialReady && (
                      <span className={styles.configuredBadge}>{t('common.configured')}</span>
                    )}
                  </span>
                  <span className={styles.accordionSummary}>
                    {displayConnectionSummary(
                      draftEmbedding.providerName,
                      draftEmbedding.endpointUrl,
                      draftEmbedding.modelId,
                      t('settings.cloud.ragConnectionIncomplete')
                    )}
                  </span>
                  <ChevronDown
                    size={17}
                    className={cx(
                      styles.chevron,
                      expandedConnection === 'embedding' && styles.chevronExpanded
                    )}
                  />
                </button>
                {expandedConnection === 'embedding' && (
                  <div id="rag-embedding-panel" className={styles.accordionBody}>
                    <div className={styles.fieldGrid}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.label} htmlFor="rag-embedding-provider">
                          {t('settings.cloud.ragProviderName')}
                        </label>
                        <input
                          id="rag-embedding-provider"
                          className={cx(
                            styles.input,
                            draftEmbedding.protocol === 'gemini' && styles.readOnlyInput
                          )}
                          value={draftEmbedding.providerName}
                          placeholder={t('settings.cloud.ragProviderPlaceholder')}
                          onChange={(event) =>
                            updateOpenAiEmbedding({ providerName: event.target.value })
                          }
                          readOnly={draftEmbedding.protocol === 'gemini'}
                        />
                      </div>
                      <div className={styles.fieldGroup}>
                        <label className={styles.label} htmlFor="rag-embedding-protocol">
                          {t('settings.cloud.ragEmbeddingProtocol')}
                        </label>
                        <Select
                          id="rag-embedding-protocol"
                          className={styles.select}
                          value={draftEmbedding.protocol}
                          onValueChange={(value) =>
                            updateEmbeddingProtocol(value === 'gemini' ? 'gemini' : 'openai')
                          }
                          options={[
                            { value: 'openai', label: t('settings.cloud.ragProtocolOpenAi') },
                            { value: 'gemini', label: t('settings.cloud.ragProtocolGemini') },
                          ]}
                        />
                      </div>
                      {draftEmbedding.protocol === 'gemini' ? (
                        <>
                          <div className={cx(styles.fieldGroup, styles.fieldWide)}>
                            <label className={styles.label} htmlFor="rag-embedding-endpoint">
                              {t('settings.cloud.ragEndpointUrl')}
                            </label>
                            <input
                              id="rag-embedding-endpoint"
                              className={cx(styles.input, styles.readOnlyInput)}
                              value={GEMINI_EMBEDDING_ENDPOINT}
                              readOnly
                            />
                            <span className={styles.fieldHint}>
                              {t('settings.cloud.ragGeminiEndpointHint')}
                            </span>
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-embedding-model">
                              {t('settings.cloud.ragModelId')}
                            </label>
                            <Select
                              id="rag-embedding-model"
                              className={styles.select}
                              value={draftEmbedding.modelId}
                              onValueChange={(value) => {
                                const modelId = GEMINI_EMBEDDING_MODELS.find(
                                  (candidate) => candidate === value
                                );
                                if (modelId) updateGeminiEmbedding({ modelId });
                              }}
                              options={GEMINI_EMBEDDING_MODELS.map((modelId) => ({
                                value: modelId,
                                label: modelId,
                              }))}
                            />
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-embedding-dimension">
                              {t('settings.cloud.ragGeminiOutputDimension')}
                            </label>
                            <Select
                              id="rag-embedding-dimension"
                              className={styles.select}
                              value={String(draftEmbedding.outputDimension)}
                              onValueChange={(value) => {
                                const outputDimension = GEMINI_EMBEDDING_OUTPUT_DIMENSIONS.find(
                                  (candidate) => String(candidate) === value
                                );
                                if (outputDimension) {
                                  updateGeminiEmbedding({ outputDimension });
                                }
                              }}
                              options={GEMINI_EMBEDDING_OUTPUT_DIMENSIONS.map((dimension) => ({
                                value: String(dimension),
                                label: String(dimension),
                              }))}
                            />
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-embedding-auth">
                              {t('settings.cloud.ragAuthMode')}
                            </label>
                            <input
                              id="rag-embedding-auth"
                              className={cx(styles.input, styles.readOnlyInput)}
                              value={t('settings.cloud.ragGeminiApiKey')}
                              readOnly
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className={cx(styles.fieldGroup, styles.fieldWide)}>
                            <label className={styles.label} htmlFor="rag-embedding-endpoint">
                              {t('settings.cloud.ragEndpointUrl')}
                            </label>
                            <input
                              id="rag-embedding-endpoint"
                              className={styles.input}
                              value={draftEmbedding.endpointUrl}
                              placeholder={t('settings.cloud.ragEmbeddingEndpointPlaceholder')}
                              onChange={(event) =>
                                updateOpenAiEmbeddingEndpoint(event.target.value)
                              }
                              inputMode="url"
                            />
                            <span className={styles.fieldHint}>
                              {t('settings.cloud.ragEndpointHint')}
                            </span>
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-embedding-model">
                              {t('settings.cloud.ragModelId')}
                            </label>
                            <input
                              id="rag-embedding-model"
                              className={styles.input}
                              value={draftEmbedding.modelId}
                              placeholder={t('settings.cloud.ragModelPlaceholder')}
                              onChange={(event) =>
                                updateOpenAiEmbedding({ modelId: event.target.value })
                              }
                            />
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label}>
                              {t('settings.cloud.ragAuthMode')}
                            </label>
                            <Select
                              className={styles.select}
                              value={draftEmbedding.authMode}
                              onValueChange={(value) =>
                                updateOpenAiEmbedding({
                                  authMode: value === 'none' ? 'none' : 'bearer',
                                })
                              }
                              options={[
                                { value: 'bearer', label: t('settings.cloud.ragAuthBearer') },
                                { value: 'none', label: t('settings.cloud.ragAuthNone') },
                              ]}
                            />
                          </div>
                        </>
                      )}
                    </div>
                    {draftEmbedding.protocol === 'gemini' && (
                      <aside className={styles.providerNotice}>
                        <p>{t('settings.cloud.ragGeminiPrivacyWarning')}</p>
                        <div className={styles.providerNoticeLinks}>
                          <button
                            type="button"
                            className={styles.noticeLink}
                            onClick={() => void openExternalUrl(GEMINI_TERMS_URL)}
                          >
                            {t('settings.cloud.ragGeminiTermsLink')}
                          </button>
                          <button
                            type="button"
                            className={styles.noticeLink}
                            onClick={() => void openExternalUrl(GEMINI_PRICING_URL)}
                          >
                            {t('settings.cloud.ragGeminiPricingLink')}
                          </button>
                          <button
                            type="button"
                            className={styles.noticeLink}
                            onClick={() => void openExternalUrl(GEMINI_REGIONS_URL)}
                          >
                            {t('settings.cloud.ragGeminiRegionsLink')}
                          </button>
                          <button
                            type="button"
                            className={styles.noticeLink}
                            onClick={() => void openExternalUrl(GEMINI_API_KEY_URL)}
                          >
                            {t('settings.cloud.ragGeminiGetApiKeyLink')}
                          </button>
                        </div>
                      </aside>
                    )}
                    {draftEmbedding.authMode !== 'none' &&
                      renderCredentialField(draftEmbeddingCredentialKind)}
                    <div className={styles.panelActions}>
                      {embeddingFeedback.detail && (
                        <span className={styles.testDetail} role="status">
                          {embeddingFeedback.detail}
                        </span>
                      )}
                      {renderTestButton('embedding')}
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.accordionItem}>
                <button
                  type="button"
                  className={styles.accordionHeader}
                  onClick={() =>
                    setExpandedConnection((current) => (current === 'reranker' ? null : 'reranker'))
                  }
                  aria-expanded={expandedConnection === 'reranker'}
                  aria-controls="rag-reranker-panel"
                >
                  <span className={styles.accordionTitleGroup}>
                    <span className={styles.accordionTitle}>
                      {t('settings.cloud.ragRerankerConnection')}
                    </span>
                    <span className={styles.optionalBadge}>{t('common.optional')}</span>
                    {draftReranker.enabled &&
                      isCustomRerankerConfigValid(draftReranker) &&
                      rerankerCredentialReady && (
                        <span className={styles.configuredBadge}>{t('common.configured')}</span>
                      )}
                  </span>
                  <span className={styles.accordionSummary}>
                    {draftReranker.enabled
                      ? displayConnectionSummary(
                          draftReranker.providerName,
                          draftReranker.endpointUrl,
                          draftReranker.modelId,
                          t('settings.cloud.ragConnectionIncomplete')
                        )
                      : t('settings.cloud.ragRerankerDisabled')}
                  </span>
                  <ChevronDown
                    size={17}
                    className={cx(
                      styles.chevron,
                      expandedConnection === 'reranker' && styles.chevronExpanded
                    )}
                  />
                </button>
                {expandedConnection === 'reranker' && (
                  <div id="rag-reranker-panel" className={styles.accordionBody}>
                    <label className={styles.inlineSwitchRow}>
                      <input
                        type="checkbox"
                        className={styles.switchInput}
                        checked={draftReranker.enabled}
                        onChange={(event) => updateReranker({ enabled: event.target.checked })}
                      />
                      <span className={styles.switchTrack} aria-hidden="true" />
                      <span>
                        <span className={styles.modeLabel}>
                          {t('settings.cloud.ragEnableReranker')}
                        </span>
                        <span className={styles.modeHint}>
                          {t('settings.cloud.ragEnableRerankerHint')}
                        </span>
                      </span>
                    </label>
                    {draftReranker.enabled && (
                      <>
                        <div className={styles.fieldGrid}>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-reranker-provider">
                              {t('settings.cloud.ragProviderName')}
                            </label>
                            <input
                              id="rag-reranker-provider"
                              className={styles.input}
                              value={draftReranker.providerName}
                              placeholder={t('settings.cloud.ragProviderPlaceholder')}
                              onChange={(event) =>
                                updateReranker({ providerName: event.target.value })
                              }
                            />
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label}>
                              {t('settings.cloud.ragProtocol')}
                            </label>
                            <Select
                              className={styles.select}
                              value={draftReranker.protocol}
                              onValueChange={(value) =>
                                updateReranker({
                                  protocol: value === 'voyage' ? 'voyage' : 'jina_cohere',
                                })
                              }
                              options={[
                                {
                                  value: 'jina_cohere',
                                  label: t('settings.cloud.ragProtocolJinaCohere'),
                                },
                                { value: 'voyage', label: t('settings.cloud.ragProtocolVoyage') },
                              ]}
                            />
                          </div>
                          <div className={cx(styles.fieldGroup, styles.fieldWide)}>
                            <label className={styles.label} htmlFor="rag-reranker-endpoint">
                              {t('settings.cloud.ragEndpointUrl')}
                            </label>
                            <input
                              id="rag-reranker-endpoint"
                              className={styles.input}
                              value={draftReranker.endpointUrl}
                              placeholder={t('settings.cloud.ragRerankerEndpointPlaceholder')}
                              onChange={(event) => updateRerankerEndpoint(event.target.value)}
                              inputMode="url"
                            />
                            <span className={styles.fieldHint}>
                              {t('settings.cloud.ragEndpointHint')}
                            </span>
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label} htmlFor="rag-reranker-model">
                              {t('settings.cloud.ragModelId')}
                            </label>
                            <input
                              id="rag-reranker-model"
                              className={styles.input}
                              value={draftReranker.modelId}
                              placeholder={t('settings.cloud.ragModelPlaceholder')}
                              onChange={(event) => updateReranker({ modelId: event.target.value })}
                            />
                          </div>
                          <div className={styles.fieldGroup}>
                            <label className={styles.label}>
                              {t('settings.cloud.ragAuthMode')}
                            </label>
                            <Select
                              className={styles.select}
                              value={draftReranker.authMode}
                              onValueChange={(value) =>
                                updateReranker({ authMode: value === 'none' ? 'none' : 'bearer' })
                              }
                              options={[
                                { value: 'bearer', label: t('settings.cloud.ragAuthBearer') },
                                { value: 'none', label: t('settings.cloud.ragAuthNone') },
                              ]}
                            />
                          </div>
                        </div>
                        {draftReranker.authMode === 'bearer' && renderCredentialField('reranker')}
                        <div className={styles.panelActions}>
                          {rerankerFeedback.detail && (
                            <span className={styles.testDetail} role="status">
                              {rerankerFeedback.detail}
                            </span>
                          )}
                          {renderTestButton('reranker')}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className={styles.noticeStack}>
            <p className={styles.notice}>{t('settings.cloud.ragIndexChangeHint')}</p>
            <p className={styles.notice}>{t('settings.cloud.ragPrivacyHint')}</p>
          </div>

          <div className={styles.footer}>
            <div className={styles.progressArea} aria-live="polite">
              {rebuildProgress && (
                <span className={styles.progressText}>
                  {rebuildProgress.phase === 'discovering'
                    ? t('settings.cloud.ragRebuildPreparing')
                    : t('settings.cloud.ragRebuilding', {
                        current: progressCurrent,
                        total: progressTotal,
                      })}
                </span>
              )}
              <RagIndexRebuildButton
                applying={applying}
                hasUnsavedChanges={isDirty}
                activeEmbeddingReady={activeEmbeddingCredentialReady}
                needsRetry={rebuildNeedsRetry}
                onRebuild={() => void handleRetryRebuild()}
              />
            </div>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleApplyRequest}
              disabled={!isDirty || applying}
            >
              {applying ? t('settings.cloud.ragApplying') : t('settings.cloud.ragSaveAndApply')}
            </button>
          </div>
        </fieldset>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => !applying && setConfirmOpen(false)}
        onConfirm={() =>
          startRagApplyAfterConfirmation(
            () => setConfirmOpen(false),
            () => void applyConnection()
          )
        }
        title={t('settings.cloud.ragConfirmChangeTitle')}
        description={t('settings.cloud.ragConfirmChangeDesc')}
        confirmText={t('settings.cloud.ragConfirmChangeAction')}
        variant="warning"
      />
    </>
  );
}
