import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, CheckCircle2, Circle, Cloud, FolderPlus, KeyRound, Loader2 } from 'lucide-react';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useI18n, type TranslationKey } from '@/i18n';
import { cx } from '@utils/classNames';
import {
    openAgentCreate,
    openHubCreate,
    openSettingsTab,
    SETUP_STATUS_CHANGED_EVENT,
} from './onboardingEvents';
import styles from './SetupChecklist.module.css';

type SetupStepId = 'llmKey' | 'embeddingKey' | 'hub' | 'agent';
type SetupStepStatus = 'complete' | 'pending' | 'checking';

interface ApiKeyStatus {
    provider: string;
    configured: boolean;
}

interface CredentialState {
    hasLlmApiKey: boolean | null;
    hasEmbeddingApiKey: boolean | null;
}

interface SetupStep {
    id: SetupStepId;
    icon: React.ReactNode;
    titleKey: TranslationKey;
    descriptionKey: TranslationKey;
    actionLabelKey: TranslationKey;
    status: SetupStepStatus;
    disabled?: boolean;
    onAction: () => void;
}

export interface SetupChecklistState {
    steps: SetupStep[];
    completedCount: number;
    totalCount: number;
    isComplete: boolean;
    shouldRender: boolean;
}

const LOCAL_DATA_EVALUATION_DELAY_MS = 500;
const SETUP_COMPLETED_STORAGE_KEY = 'agentvis-setup-checklist-completed-v1';

function isStatusComplete(value: boolean | null): SetupStepStatus {
    if (value === null) return 'checking';
    return value ? 'complete' : 'pending';
}

function getStoredSetupCompleted(): boolean {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SETUP_COMPLETED_STORAGE_KEY) === 'true';
}

function storeSetupCompleted(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SETUP_COMPLETED_STORAGE_KEY, 'true');
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSetupChecklistState(): SetupChecklistState {
    const hubs = useHubStore((state) => state.hubs);
    const agents = useAgentStore((state) => state.agents);
    const [credentialState, setCredentialState] = useState<CredentialState>({
        hasLlmApiKey: null,
        hasEmbeddingApiKey: null,
    });
    const [canEvaluateLocalData, setCanEvaluateLocalData] = useState(false);
    const [hasCompletedSetup, setHasCompletedSetup] = useState(getStoredSetupCompleted);

    const refreshCredentials = useCallback(async () => {
        try {
            const [apiKeyStatuses, embeddingConfigured] = await Promise.all([
                invoke<ApiKeyStatus[]>('settings_get_api_key_status'),
                invoke<boolean>('get_siliconflow_api_key_status'),
            ]);

            setCredentialState({
                hasLlmApiKey: apiKeyStatuses.some(
                    (status) => status.provider !== 'local' && status.configured
                ),
                hasEmbeddingApiKey: embeddingConfigured,
            });
        } catch {
            setCredentialState({
                hasLlmApiKey: false,
                hasEmbeddingApiKey: false,
            });
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(
            () => setCanEvaluateLocalData(true),
            LOCAL_DATA_EVALUATION_DELAY_MS
        );
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        void refreshCredentials();
        const handleRefreshCredentials = () => {
            void refreshCredentials();
        };

        window.addEventListener(SETUP_STATUS_CHANGED_EVENT, handleRefreshCredentials);
        window.addEventListener('focus', handleRefreshCredentials);
        return () => {
            window.removeEventListener(SETUP_STATUS_CHANGED_EVENT, handleRefreshCredentials);
            window.removeEventListener('focus', handleRefreshCredentials);
        };
    }, [refreshCredentials]);

    const hasHub = hubs.length > 0;
    const hasAgent = agents.length > 0;

    const steps = useMemo<SetupStep[]>(() => [
        {
            id: 'llmKey',
            icon: <KeyRound size={18} strokeWidth={1.7} />,
            titleKey: 'onboarding.setupLlmKeyTitle',
            descriptionKey: 'onboarding.setupLlmKeyDescription',
            actionLabelKey: 'onboarding.setupLlmKeyAction',
            status: isStatusComplete(credentialState.hasLlmApiKey),
            onAction: () => openSettingsTab('apiKeys'),
        },
        {
            id: 'embeddingKey',
            icon: <Cloud size={18} strokeWidth={1.7} />,
            titleKey: 'onboarding.setupEmbeddingTitle',
            descriptionKey: 'onboarding.setupEmbeddingDescription',
            actionLabelKey: 'onboarding.setupEmbeddingAction',
            status: isStatusComplete(credentialState.hasEmbeddingApiKey),
            onAction: () => openSettingsTab('cloudService'),
        },
        {
            id: 'hub',
            icon: <FolderPlus size={18} strokeWidth={1.7} />,
            titleKey: 'onboarding.setupHubTitle',
            descriptionKey: 'onboarding.setupHubDescription',
            actionLabelKey: 'onboarding.setupHubAction',
            status: hasHub ? 'complete' : 'pending',
            onAction: openHubCreate,
        },
        {
            id: 'agent',
            icon: <Bot size={18} strokeWidth={1.7} />,
            titleKey: 'onboarding.setupAgentTitle',
            descriptionKey: 'onboarding.setupAgentDescription',
            actionLabelKey: hasHub ? 'onboarding.setupAgentAction' : 'onboarding.setupAgentWaiting',
            status: hasAgent ? 'complete' : 'pending',
            disabled: !hasHub,
            onAction: openAgentCreate,
        },
    ], [credentialState.hasEmbeddingApiKey, credentialState.hasLlmApiKey, hasAgent, hasHub]);

    const completedCount = steps.filter((step) => step.status === 'complete').length;
    const totalCount = steps.length;
    const credentialsKnown =
        credentialState.hasLlmApiKey !== null && credentialState.hasEmbeddingApiKey !== null;
    const isComplete = completedCount === totalCount;
    const shouldRender = !hasCompletedSetup
        && canEvaluateLocalData
        && !isComplete
        && (!hasHub || !hasAgent || credentialsKnown);

    useEffect(() => {
        if (!hasCompletedSetup && isComplete) {
            storeSetupCompleted();
            setHasCompletedSetup(true);
        }
    }, [hasCompletedSetup, isComplete]);

    return {
        steps,
        completedCount,
        totalCount,
        isComplete,
        shouldRender,
    };
}

interface SetupChecklistProps {
    state: SetupChecklistState;
}

function StepStatusIcon({ status }: { status: SetupStepStatus }) {
    if (status === 'complete') {
        return <CheckCircle2 size={18} strokeWidth={1.8} />;
    }
    if (status === 'checking') {
        return <Loader2 className={styles.spinner} size={18} strokeWidth={1.8} />;
    }
    return <Circle size={18} strokeWidth={1.8} />;
}

export function SetupChecklist({ state }: SetupChecklistProps) {
    const { t } = useI18n();
    const primaryStep = state.steps.find(
        (step) => step.status === 'pending' && !step.disabled
    );

    if (!state.shouldRender) {
        return null;
    }

    return (
        <section className={styles.panel} aria-label={t('onboarding.setupTitle')}>
            <div className={styles.header}>
                <div>
                    <p className={styles.eyebrow}>{t('onboarding.setupEyebrow')}</p>
                    <h2 className={styles.title}>{t('onboarding.setupTitle')}</h2>
                    <p className={styles.description}>{t('onboarding.setupDescription')}</p>
                </div>
                <div className={styles.progressBadge}>
                    {t('onboarding.setupProgress', {
                        completed: state.completedCount,
                        total: state.totalCount,
                    })}
                </div>
            </div>

            <div className={styles.stepList}>
                {state.steps.map((step) => {
                    const isComplete = step.status === 'complete';
                    const isChecking = step.status === 'checking';

                    return (
                        <div
                            key={step.id}
                            className={cx(
                                styles.step,
                                isComplete && styles.stepComplete,
                                isChecking && styles.stepChecking
                            )}
                        >
                            <div className={styles.stepIcon}>{step.icon}</div>
                            <div className={styles.stepBody}>
                                <div className={styles.stepTitleRow}>
                                    <h3 className={styles.stepTitle}>{t(step.titleKey)}</h3>
                                    <span className={styles.statusPill}>
                                        <StepStatusIcon status={step.status} />
                                        {step.status === 'complete'
                                            ? t('onboarding.setupDone')
                                            : step.status === 'checking'
                                                ? t('onboarding.setupChecking')
                                                : t('onboarding.setupRequired')}
                                    </span>
                                </div>
                                <p className={styles.stepDescription}>{t(step.descriptionKey)}</p>
                            </div>
                            {!isComplete && (
                                <button
                                    className={styles.stepAction}
                                    type="button"
                                    onClick={step.onAction}
                                    disabled={(step.disabled ?? false) || isChecking}
                                >
                                    {t(step.actionLabelKey)}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            {primaryStep && (
                <button
                    className={styles.primaryButton}
                    type="button"
                    onClick={primaryStep.onAction}
                >
                    <span>{t('onboarding.setupContinue')}</span>
                    {primaryStep.icon}
                </button>
            )}
        </section>
    );
}
