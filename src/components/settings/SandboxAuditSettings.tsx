/**
 * 沙箱审计事件诊断面板。
 *
 * 展示 Rust 端持久化的 SandboxAuditEvent，并订阅实时审计事件；
 * 用于确认 broker/proxy、WFP 诊断和进程沙箱决策是否按预期记录。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Ban, CheckCircle2, RefreshCw, SearchCheck, X } from 'lucide-react';
import type {
    SandboxAuditBackend,
    SandboxAuditDecision,
    SandboxAuditEvent,
    SandboxAuditGuardMode,
    SandboxAuditSource,
} from '@/types';
import { Tooltip } from '@components/ui/Tooltip';
import { Select } from '@components/ui';
import { useI18n, type TranslationKey } from '@/i18n';
import { cx } from '@utils/classNames';
import styles from './SandboxAuditSettings.module.css';

const AUDIT_EVENT_PAGE_SIZE = 200;
const AUDIT_EVENT_NAME = 'agentvis://sandbox-audit-event';
const DECISION_LABEL_KEYS: Record<SandboxAuditDecision, TranslationKey> = {
    allow: 'settings.audit.decisions.allow',
    audit: 'settings.audit.decisions.audit',
    block: 'settings.audit.decisions.block',
    diagnostic: 'settings.audit.decisions.diagnostic',
};
const BACKEND_LABEL_KEYS: Record<SandboxAuditBackend, TranslationKey> = {
    none: 'settings.audit.backends.none',
    jobObject: 'settings.audit.backends.jobObject',
    restrictedToken: 'settings.audit.backends.restrictedToken',
    appContainer: 'settings.audit.backends.appContainer',
    mainProcess: 'settings.audit.backends.mainProcess',
    broker: 'settings.audit.backends.broker',
    wfpEnhanced: 'settings.audit.backends.wfpEnhanced',
};
const SOURCE_LABEL_KEYS: Record<SandboxAuditSource, TranslationKey> = {
    exec: 'settings.audit.sources.exec',
    externalSkill: 'settings.audit.sources.externalSkill',
    installer: 'settings.audit.sources.installer',
    preview: 'settings.audit.sources.preview',
    nativeTool: 'settings.audit.sources.nativeTool',
};
const DECISION_FILTER_OPTIONS: Array<SandboxAuditDecision | 'all'> = [
    'all',
    'allow',
    'audit',
    'block',
    'diagnostic',
];
const BACKEND_FILTER_OPTIONS: Array<SandboxAuditBackend | 'all'> = [
    'all',
    'none',
    'jobObject',
    'restrictedToken',
    'appContainer',
    'mainProcess',
    'broker',
    'wfpEnhanced',
];
const SOURCE_FILTER_OPTIONS: Array<SandboxAuditSource | 'all'> = [
    'all',
    'exec',
    'externalSkill',
    'installer',
    'preview',
    'nativeTool',
];
const REASON_FILTER_OPTIONS = [
    'all',
    'proxy_bypass_signal_blocked',
    'broker_proxy_required_unavailable',
    'broker_helper_unavailable',
    'broker_proxy_session_started',
    'broker_proxy_expected_but_unused',
    'network_direct_audit_allowed',
    'broker_network_block',
    'broker_network_request',
    'network_upload_confirmation_required',
    'network_upload_risk_confirmed',
    'network_sensitive_egress_confirmation_required',
    'network_sensitive_egress_confirmed',
    'network_remote_destructive_confirmation_required',
    'network_remote_destructive_confirmed',
    'wfp_canary_direct_egress_observed',
    'wfp_canary_no_direct_egress',
    'wfp_canary_unavailable',
    'wfp_canary_session_start_would_block',
    'wfp_canary_ineligible_would_block',
    'wfp_canary_actual_result',
] as const;
const GUARD_MODE_FILTER_OPTIONS: Array<SandboxAuditGuardMode | 'all'> = [
    'all',
    'auditOnly',
    'wouldBlock',
    'hardBlock',
    'directAuditAllowed',
];

type DecisionFilter = SandboxAuditDecision | 'all';
type BackendFilter = SandboxAuditBackend | 'all';
type SourceFilter = SandboxAuditSource | 'all';
type ReasonFilter = typeof REASON_FILTER_OPTIONS[number];
type GuardModeFilter = SandboxAuditGuardMode | 'all';

interface AuditFilters {
    decision: DecisionFilter;
    backend: BackendFilter;
    source: SourceFilter;
    reason: ReasonFilter;
    guardMode: GuardModeFilter;
    targetHost: string;
    subjectId: string;
}

function decisionClass(decision: SandboxAuditDecision): string {
    switch (decision) {
        case 'allow':
            return styles.decisionAllow ?? '';
        case 'audit':
            return styles.decisionAudit ?? '';
        case 'block':
            return styles.decisionBlock ?? '';
        case 'diagnostic':
            return styles.decisionDiagnostic ?? '';
        default:
            return styles.decisionAudit ?? '';
    }
}

function decisionIcon(decision: SandboxAuditDecision) {
    switch (decision) {
        case 'allow':
            return <CheckCircle2 size={14} strokeWidth={2} />;
        case 'block':
            return <Ban size={14} strokeWidth={2} />;
        case 'diagnostic':
            return <SearchCheck size={14} strokeWidth={2} />;
        case 'audit':
        default:
            return <Activity size={14} strokeWidth={2} />;
    }
}

function eventTarget(event: SandboxAuditEvent): string {
    const method = event.requestMethod ? `${event.requestMethod} ` : '';
    const port = event.targetPort ? `:${event.targetPort}` : '';
    if (event.targetScheme && event.targetHost) {
        return `${method}${event.targetScheme}://${event.targetHost}${port}`;
    }
    if (event.targetHost) {
        return `${method}${event.targetHost}${port}`;
    }
    return event.matchedPattern ?? event.reason;
}

function formatTime(timestamp: number, timestampIso: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return timestampIso;
    }
    return date.toLocaleString();
}

function commandFilterValue(value: string): string | null {
    const trimmed = value.trim();
    return trimmed && trimmed !== 'all' ? trimmed : null;
}

function compactSignalValue(value: string | null | undefined, maxLength = 96): string | null {
    if (!value) return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function extractAuditDetailValue(event: SandboxAuditEvent, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return event.matchedPattern?.match(new RegExp(`\\b${escapedKey}=([^;]+)`))?.[1]?.trim() ?? null;
}

function buildAuditSignals(event: SandboxAuditEvent): Array<{ label: TranslationKey; value: string }> {
    const signals: Array<{ label: TranslationKey; value: string }> = [];
    const pushSignal = (label: TranslationKey, value: string | null | undefined, maxLength?: number) => {
        const compact = compactSignalValue(value, maxLength);
        if (compact && !signals.some((signal) => signal.label === label && signal.value === compact)) {
            signals.push({ label, value: compact });
        }
    };

    pushSignal('settings.audit.signals.riskClass', event.riskClass);
    pushSignal('settings.audit.signals.riskKind', event.riskKind);
    pushSignal('settings.audit.signals.credentialContext', event.credentialContext);
    pushSignal('settings.audit.signals.reasonClass', extractAuditDetailValue(event, 'reasonClass'));
    pushSignal('settings.audit.signals.taskCategory', extractAuditDetailValue(event, 'taskCategory'));
    pushSignal('settings.audit.signals.resolvedRisk', extractAuditDetailValue(event, 'resolvedRisk'));

    const resolvedRiskReason = extractAuditDetailValue(event, 'resolvedRiskReason')
        ?? (extractAuditDetailValue(event, 'resolvedRisk') ? extractAuditDetailValue(event, 'reason') : null);
    pushSignal('settings.audit.signals.resolvedRiskReason', resolvedRiskReason);

    if (
        event.reason === 'proxy_bypass_signal_blocked' ||
        event.reason.startsWith('network_upload_') ||
        event.reason.startsWith('network_sensitive_egress_') ||
        event.reason.startsWith('network_remote_destructive_')
    ) {
        pushSignal('settings.audit.signals.matchedPattern', event.matchedPattern, 120);
    }

    return signals.slice(0, 5);
}

function eventMatchesFilters(event: SandboxAuditEvent, filters: AuditFilters): boolean {
    if (filters.decision !== 'all' && event.decision !== filters.decision) {
        return false;
    }
    if (filters.backend !== 'all' && event.backend !== filters.backend) {
        return false;
    }
    if (filters.source !== 'all' && event.source !== filters.source) {
        return false;
    }
    if (filters.reason !== 'all' && event.reason !== filters.reason) {
        return false;
    }
    if (filters.guardMode !== 'all' && event.guardMode !== filters.guardMode) {
        return false;
    }

    const targetHost = commandFilterValue(filters.targetHost)?.toLowerCase();
    if (
        targetHost &&
        !event.targetHost?.toLowerCase().includes(targetHost)
    ) {
        return false;
    }

    const subjectId = commandFilterValue(filters.subjectId);
    if (subjectId && event.subjectId !== subjectId) {
        return false;
    }
    return true;
}

export function SandboxAuditSettings() {
    const { t } = useI18n();
    const [events, setEvents] = useState<SandboxAuditEvent[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextOffset, setNextOffset] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
    const [backendFilter, setBackendFilter] = useState<BackendFilter>('all');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all');
    const [guardModeFilter, setGuardModeFilter] = useState<GuardModeFilter>('all');
    const [targetHostFilter, setTargetHostFilter] = useState('');
    const [subjectIdFilter, setSubjectIdFilter] = useState('');

    const filters = useMemo<AuditFilters>(() => ({
        decision: decisionFilter,
        backend: backendFilter,
        source: sourceFilter,
        reason: reasonFilter,
        guardMode: guardModeFilter,
        targetHost: targetHostFilter,
        subjectId: subjectIdFilter,
    }), [backendFilter, decisionFilter, guardModeFilter, reasonFilter, sourceFilter, subjectIdFilter, targetHostFilter]);

    const hasActiveFilters = useMemo(() => (
        filters.decision !== 'all' ||
        filters.backend !== 'all' ||
        filters.source !== 'all' ||
        filters.reason !== 'all' ||
        filters.guardMode !== 'all' ||
        commandFilterValue(filters.targetHost) !== null ||
        commandFilterValue(filters.subjectId) !== null
    ), [filters]);

    const fetchEvents = useCallback(async (offset: number) => invoke<SandboxAuditEvent[]>(
        'sandbox_audit_events',
        {
            limit: AUDIT_EVENT_PAGE_SIZE,
            offset,
            decision: filters.decision === 'all' ? null : filters.decision,
            backend: filters.backend === 'all' ? null : filters.backend,
            source: filters.source === 'all' ? null : filters.source,
            reason: filters.reason === 'all' ? null : filters.reason,
            guardMode: filters.guardMode === 'all' ? null : filters.guardMode,
            targetHost: commandFilterValue(filters.targetHost),
            subjectId: commandFilterValue(filters.subjectId),
        },
    ), [filters]);

    const loadEvents = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const loaded = await fetchEvents(0);
            setEvents(loaded);
            setNextOffset(loaded.length);
            setHasMore(loaded.length === AUDIT_EVENT_PAGE_SIZE);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    }, [fetchEvents]);

    const loadMore = useCallback(async () => {
        if (isLoadingMore || !hasMore) {
            return;
        }
        setIsLoadingMore(true);
        setError(null);
        const offset = nextOffset;
        try {
            const loaded = await fetchEvents(offset);
            setEvents((current) => {
                const seen = new Set(current.map((event) => event.id));
                return [
                    ...current,
                    ...loaded.filter((event) => !seen.has(event.id)),
                ];
            });
            setNextOffset(offset + loaded.length);
            setHasMore(loaded.length === AUDIT_EVENT_PAGE_SIZE);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoadingMore(false);
        }
    }, [fetchEvents, hasMore, isLoadingMore, nextOffset]);

    const clearFilters = useCallback(() => {
        setDecisionFilter('all');
        setBackendFilter('all');
        setSourceFilter('all');
        setReasonFilter('all');
        setGuardModeFilter('all');
        setTargetHostFilter('');
        setSubjectIdFilter('');
    }, []);

    useEffect(() => {
        void loadEvents();
    }, [loadEvents]);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        void import('@tauri-apps/api/event')
            .then(({ listen }) => listen<SandboxAuditEvent>(AUDIT_EVENT_NAME, (event) => {
                const incoming = event.payload;
                if (!eventMatchesFilters(incoming, filters)) {
                    return;
                }
                setEvents((current) => [
                    incoming,
                    ...current.filter((item) => item.id !== incoming.id),
                ].slice(0, Math.max(nextOffset, AUDIT_EVENT_PAGE_SIZE)));
            }))
            .then((cleanup) => {
                if (disposed) {
                    cleanup();
                } else {
                    unlisten = cleanup;
                }
            })
            .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
            });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [filters, nextOffset]);

    const visibleEvents = useMemo(
        () => events.filter((event) => eventMatchesFilters(event, filters)),
        [events, filters]
    );

    const summary = useMemo(() => ({
        total: visibleEvents.length,
        audit: visibleEvents.filter((event) => event.decision === 'audit').length,
        block: visibleEvents.filter((event) => event.decision === 'block').length,
        diagnostic: visibleEvents.filter((event) => event.decision === 'diagnostic').length,
    }), [visibleEvents]);

    const signalSummary = useMemo(() => ([
        {
            key: 'proxyBypass',
            label: t('settings.audit.signals.proxyBypass'),
            count: visibleEvents.filter((event) => event.reason === 'proxy_bypass_signal_blocked').length,
        },
        {
            key: 'upload',
            label: t('settings.audit.signals.upload'),
            count: visibleEvents.filter((event) => event.reason.startsWith('network_upload_')).length,
        },
        {
            key: 'brokerUnused',
            label: t('settings.audit.signals.brokerUnused'),
            count: visibleEvents.filter((event) => event.reason === 'broker_proxy_expected_but_unused').length,
        },
        {
            key: 'dnsOrWfp',
            label: t('settings.audit.signals.dnsOrWfp'),
            count: visibleEvents.filter((event) => (
                event.backend === 'wfpEnhanced' ||
                Boolean(extractAuditDetailValue(event, 'resolvedRisk'))
            )).length,
        },
    ]), [t, visibleEvents]);

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h2 className={styles.title}>{t('settings.audit.title')}</h2>
                    <p className={styles.description}>{t('settings.audit.description')}</p>
                </div>
                <Tooltip content={t('settings.audit.refresh')}>
                    <span className={styles.tooltipButtonWrap}>
                        <button
                            type="button"
                            className={styles.refreshButton}
                            onClick={() => void loadEvents()}
                            disabled={isLoading}
                            aria-label={t('settings.audit.refresh')}
                        >
                            <RefreshCw size={16} strokeWidth={1.8} />
                        </button>
                    </span>
                </Tooltip>
            </div>

            <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                    <span className={styles.summaryValue}>{summary.total}</span>
                    <span className={styles.summaryLabel}>{t('settings.audit.total')}</span>
                </div>
                <div className={styles.summaryItem}>
                    <span className={styles.summaryValue}>{summary.audit}</span>
                    <span className={styles.summaryLabel}>{t('settings.audit.audit')}</span>
                </div>
                <div className={styles.summaryItem}>
                    <span className={styles.summaryValue}>{summary.block}</span>
                    <span className={styles.summaryLabel}>{t('settings.audit.block')}</span>
                </div>
                <div className={styles.summaryItem}>
                    <span className={styles.summaryValue}>{summary.diagnostic}</span>
                    <span className={styles.summaryLabel}>{t('settings.audit.diagnostic')}</span>
                </div>
            </div>

            <div className={styles.signalStrip} aria-label={t('settings.audit.signalSummary')}>
                {signalSummary.map((item) => (
                    <span key={item.key} className={styles.signalChip}>
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                    </span>
                ))}
            </div>

            <div className={styles.filterPanel}>
                <div className={styles.filterPrimaryRow}>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.decision')}</span>
                        <Select
                            className={styles.filterSelect}
                            value={decisionFilter}
                            onValueChange={(value) => setDecisionFilter(value as DecisionFilter)}
                            options={DECISION_FILTER_OPTIONS.map((option) => ({
                                value: option,
                                label: option === 'all' ? t('settings.audit.filters.all') : t(DECISION_LABEL_KEYS[option]),
                            }))}
                        />
                    </label>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.backend')}</span>
                        <Select
                            className={styles.filterSelect}
                            value={backendFilter}
                            onValueChange={(value) => setBackendFilter(value as BackendFilter)}
                            options={BACKEND_FILTER_OPTIONS.map((option) => ({
                                value: option,
                                label: option === 'all' ? t('settings.audit.filters.all') : t(BACKEND_LABEL_KEYS[option]),
                            }))}
                        />
                    </label>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.source')}</span>
                        <Select
                            className={styles.filterSelect}
                            value={sourceFilter}
                            onValueChange={(value) => setSourceFilter(value as SourceFilter)}
                            options={SOURCE_FILTER_OPTIONS.map((option) => ({
                                value: option,
                                label: option === 'all' ? t('settings.audit.filters.all') : t(SOURCE_LABEL_KEYS[option]),
                            }))}
                        />
                    </label>
                </div>
                <div className={styles.filterSecondaryRow}>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.reason')}</span>
                        <Tooltip content={reasonFilter === 'all' ? t('settings.audit.filters.all') : reasonFilter}>
                            <span className={styles.tooltipSelectWrap}>
                                <Select
                                    className={styles.filterSelect}
                                    value={reasonFilter}
                                    onValueChange={(value) => setReasonFilter(value as ReasonFilter)}
                                    options={REASON_FILTER_OPTIONS.map((option) => ({
                                        value: option,
                                        label: option === 'all' ? t('settings.audit.filters.all') : option,
                                    }))}
                                />
                            </span>
                        </Tooltip>
                    </label>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.guardMode')}</span>
                        <Tooltip content={guardModeFilter === 'all' ? t('settings.audit.filters.all') : guardModeFilter}>
                            <span className={styles.tooltipSelectWrap}>
                                <Select
                                    className={styles.filterSelect}
                                    value={guardModeFilter}
                                    onValueChange={(value) => setGuardModeFilter(value as GuardModeFilter)}
                                    options={GUARD_MODE_FILTER_OPTIONS.map((option) => ({
                                        value: option,
                                        label: option === 'all' ? t('settings.audit.filters.all') : option,
                                    }))}
                                />
                            </span>
                        </Tooltip>
                    </label>
                </div>
                <div className={styles.filterTertiaryRow}>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.targetHost')}</span>
                        <input
                            value={targetHostFilter}
                            onChange={(event) => setTargetHostFilter(event.target.value)}
                            placeholder={t('settings.audit.filters.targetHostPlaceholder')}
                        />
                    </label>
                    <label className={styles.filterField}>
                        <span>{t('settings.audit.filters.subjectId')}</span>
                        <input
                            value={subjectIdFilter}
                            onChange={(event) => setSubjectIdFilter(event.target.value)}
                            placeholder={t('settings.audit.filters.subjectIdPlaceholder')}
                        />
                    </label>
                    <Tooltip content={t('settings.audit.filters.clear')}>
                        <span className={styles.tooltipButtonWrap}>
                            <button
                                type="button"
                                className={styles.clearButton}
                                onClick={clearFilters}
                                disabled={!hasActiveFilters}
                                aria-label={t('settings.audit.filters.clear')}
                            >
                                <X size={15} strokeWidth={1.8} />
                            </button>
                        </span>
                    </Tooltip>
                </div>
            </div>

            {error && (
                <div className={styles.errorState}>
                    {t('settings.audit.loadFailed', { error })}
                </div>
            )}

            {!error && events.length === 0 && (
                <div className={styles.emptyState}>
                    {isLoading ? t('settings.audit.loading') : t('settings.audit.empty')}
                </div>
            )}

            {!error && events.length > 0 && visibleEvents.length === 0 && (
                <div className={styles.emptyState}>
                    {t('settings.audit.empty')}
                </div>
            )}

            {visibleEvents.length > 0 && (
                <>
                    <div className={styles.eventList}>
                        {visibleEvents.map((event) => (
                            <article key={event.id} className={styles.eventItem}>
                                <div className={styles.eventMeta}>
                                    <span className={cx(styles.decisionBadge, decisionClass(event.decision))}>
                                        {decisionIcon(event.decision)}
                                        {t(DECISION_LABEL_KEYS[event.decision])}
                                    </span>
                                    <span className={styles.time}>
                                        {formatTime(event.timestamp, event.timestampIso)}
                                    </span>
                                </div>
                                <div className={styles.eventBody}>
                                    <div className={styles.eventTitle}>
                                        <Tooltip content={eventTarget(event)}>
                                            <span className={styles.eventTarget}>
                                                {eventTarget(event)}
                                            </span>
                                        </Tooltip>
                                    </div>
                                    <Tooltip content={event.blockedReason ?? event.reason}>
                                        <div className={styles.eventReason}>
                                            {event.blockedReason ?? event.reason}
                                        </div>
                                    </Tooltip>
                                    {(() => {
                                        const auditSignals = buildAuditSignals(event);
                                        return auditSignals.length > 0 ? (
                                            <div className={styles.eventSignals}>
                                                {auditSignals.map((signal) => (
                                                    <Tooltip key={`${signal.label}:${signal.value}`} content={`${t(signal.label)}: ${signal.value}`}>
                                                        <span className={styles.eventSignal}>
                                                            {t(signal.label)}: {signal.value}
                                                        </span>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                    <div className={styles.detailGrid}>
                                        <span>
                                            {t('settings.audit.source')}: <span className={styles.detailValue}>{t(SOURCE_LABEL_KEYS[event.source])}</span>
                                        </span>
                                        <span>
                                            {t('settings.audit.backend')}: <span className={styles.detailValue}>{t(BACKEND_LABEL_KEYS[event.backend])}</span>
                                        </span>
                                        <span>
                                            {t('settings.audit.mode')}: <span className={styles.detailValue}>{event.sandboxMode}</span>
                                        </span>
                                        <span>
                                            {t('settings.audit.status')}: <span className={styles.detailValue}>{event.statusCode ?? '-'}</span>
                                        </span>
                                        {event.targetHost && (
                                            <span className={styles.detailWide}>
                                                {t('settings.audit.targetHost')}: <span className={styles.detailValue}>{event.targetHost}</span>
                                            </span>
                                        )}
                                        {event.networkProtocol && (
                                            <span>
                                                {t('settings.audit.networkProtocol')}: <span className={styles.detailValue}>{event.networkProtocol}</span>
                                            </span>
                                        )}
                                        {event.targetPort && (
                                            <span>
                                                {t('settings.audit.targetPort')}: <span className={styles.detailValue}>{event.targetPort}</span>
                                            </span>
                                        )}
                                        {event.guardMode && (
                                            <span>
                                                {t('settings.audit.guardMode')}: <span className={styles.detailValue}>{event.guardMode}</span>
                                            </span>
                                        )}
                                        {event.subjectId && (
                                            <span className={styles.detailWide}>
                                                {t('settings.audit.subjectId')}: <span className={styles.detailValue}>{event.subjectId}</span>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                    <div className={styles.loadMoreRow}>
                        {hasMore ? (
                            <button
                                type="button"
                                className={styles.loadMoreButton}
                                onClick={() => void loadMore()}
                                disabled={isLoadingMore}
                            >
                                {isLoadingMore ? t('settings.audit.loadingMore') : t('settings.audit.loadMore')}
                            </button>
                        ) : (
                            <span className={styles.endHint}>{t('settings.audit.end')}</span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
