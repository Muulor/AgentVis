/**
 * UpdateSettings - 应用版本检测设置区
 *
 * 读取发布清单，展示当前版本、新版本状态和手动下载入口。
 */

import { useCallback } from 'react';
import { AlertCircle, CheckCircle2, Download, RefreshCw, RotateCcw, SkipForward } from 'lucide-react';
import { openExternalUrl } from '@services/navigation/externalUrl';
import { formatReleaseSize, getLocalizedReleaseNotes } from '@services/update';
import { useUpdateStore } from '@stores/updateStore';
import { useToast } from '../ui/Toast';
import { useI18n } from '@/i18n';
import styles from './GeneralSettings.module.css';

function formatCheckedAt(value: string | null, locale: string): string {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'short',
        timeStyle: 'short',
    }).format(timestamp);
}

export function UpdateSettings() {
    const { language, t } = useI18n();
    const { toast } = useToast();
    const autoCheckEnabled = useUpdateStore((state) => state.autoCheckEnabled);
    const setAutoCheckEnabled = useUpdateStore((state) => state.setAutoCheckEnabled);
    const status = useUpdateStore((state) => state.status);
    const currentVersion = useUpdateStore((state) => state.currentVersion);
    const latest = useUpdateStore((state) => state.latest);
    const downloadUrl = useUpdateStore((state) => state.downloadUrl);
    const fallbackUrl = useUpdateStore((state) => state.fallbackUrl);
    const sizeBytes = useUpdateStore((state) => state.sizeBytes);
    const sha256 = useUpdateStore((state) => state.sha256);
    const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
    const error = useUpdateStore((state) => state.error);
    const skippedVersion = useUpdateStore((state) => state.skippedVersion);
    const checkNow = useUpdateStore((state) => state.checkNow);
    const skipVersion = useUpdateStore((state) => state.skipVersion);
    const clearSkippedVersion = useUpdateStore((state) => state.clearSkippedVersion);

    const latestVersion = latest?.version ?? '';
    const releaseNotes = getLocalizedReleaseNotes(latest, language);
    const releaseSize = formatReleaseSize(sizeBytes);
    const checkedAtText = formatCheckedAt(lastCheckedAt, language);
    const resolvedDownloadUrl = downloadUrl ?? fallbackUrl;
    const hasAvailableUpdate = status === 'available' && latest !== null && resolvedDownloadUrl !== null;
    const canSkip = status === 'available' && latestVersion.length > 0;
    const canClearSkipped = skippedVersion !== null;
    let statusTone = 'current';
    let statusIcon = <CheckCircle2 size={18} strokeWidth={1.6} />;
    let statusText = t('settings.general.updateCurrent');

    if (status === 'available') {
        statusTone = 'available';
        statusIcon = <Download size={18} strokeWidth={1.6} />;
        statusText = t('settings.general.updateAvailable', { version: latestVersion });
    } else if (status === 'checking') {
        statusTone = 'checking';
        statusIcon = <RefreshCw size={18} strokeWidth={1.6} />;
        statusText = t('settings.general.updateChecking');
    } else if (status === 'error') {
        statusTone = 'error';
        statusIcon = <AlertCircle size={18} strokeWidth={1.6} />;
        statusText = t('settings.general.updateCheckFailed');
    }

    const handleCheckNow = useCallback(async () => {
        try {
            const result = await checkNow();
            const latestResultVersion = result.latest?.version ?? '';
            const effectiveStatus = useUpdateStore.getState().status;
            if (effectiveStatus === 'available' && latestResultVersion) {
                toast({
                    type: 'success',
                    title: t('settings.general.updateAvailableToast', { version: latestResultVersion }),
                });
            } else {
                toast({ type: 'success', title: t('settings.general.updateCurrentToast') });
            }
        } catch (checkError) {
            toast({
                type: 'error',
                title: t('settings.general.updateCheckFailedToast'),
                description: String(checkError),
            });
        }
    }, [checkNow, t, toast]);

    const handleDownload = useCallback(async () => {
        const targetUrl = downloadUrl ?? fallbackUrl;
        if (!targetUrl) return;

        try {
            const opened = await openExternalUrl(targetUrl);
            if (!opened) {
                toast({
                    type: 'error',
                    title: t('settings.general.updateOpenDownloadFailed'),
                });
            }
        } catch (openError) {
            toast({
                type: 'error',
                title: t('settings.general.updateOpenDownloadFailed'),
                description: String(openError),
            });
        }
    }, [downloadUrl, fallbackUrl, t, toast]);

    const handleSkip = useCallback(() => {
        if (!latestVersion) return;
        skipVersion(latestVersion);
        toast({
            type: 'info',
            title: t('settings.general.updateSkippedToast', { version: latestVersion }),
        });
    }, [latestVersion, skipVersion, t, toast]);

    const handleClearSkipped = useCallback(() => {
        clearSkippedVersion();
        toast({ type: 'success', title: t('settings.general.updateSkipClearedToast') });
    }, [clearSkippedVersion, t, toast]);

    return (
        <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
                <RefreshCw size={16} strokeWidth={1.5} className={styles.sectionIcon} />
                {t('settings.general.updates')}
            </h3>

            <label className={styles.toggleRow}>
                <span className={styles.toggleTextGroup}>
                    <span className={styles.toggleLabel}>{t('settings.general.updateAutoCheck')}</span>
                    <span className={styles.hint}>{t('settings.general.updateAutoCheckHint')}</span>
                </span>
                <span className={styles.switchControl}>
                    <input
                        className={styles.toggleInput}
                        type="checkbox"
                        checked={autoCheckEnabled}
                        onChange={(event) => setAutoCheckEnabled(event.target.checked)}
                    />
                    <span className={styles.toggleSwitch} />
                </span>
            </label>

            <div className={styles.updateCard} data-status={status}>
                <div className={styles.updateHeader}>
                    <div className={styles.updateStatusBlock}>
                        <span className={styles.updateStatusIcon} data-tone={statusTone}>
                            {statusIcon}
                        </span>
                        <span className={styles.updateStatusText}>
                            {statusText}
                        </span>
                    </div>
                    <button
                        className={styles.openButton}
                        type="button"
                        onClick={() => void handleCheckNow()}
                        disabled={status === 'checking'}
                    >
                        {status === 'checking' ? <span className={styles.spinner} /> : <RefreshCw size={14} strokeWidth={1.6} />}
                        {status === 'checking' ? t('common.checking') : t('settings.general.updateCheckNow')}
                    </button>
                </div>

                <div className={styles.updateMetaGrid}>
                    <span className={styles.updateMetaLabel}>{t('settings.data.version')}</span>
                    <span className={styles.updateMetaValue}>{currentVersion ?? t('common.loading')}</span>
                    <span className={styles.updateMetaLabel}>{t('settings.general.updateLatestVersion')}</span>
                    <span className={styles.updateMetaValue}>{latestVersion || '-'}</span>
                    <span className={styles.updateMetaLabel}>{t('settings.general.updateLastChecked')}</span>
                    <span className={styles.updateMetaValue}>{checkedAtText || t('settings.general.updateNeverChecked')}</span>
                </div>

                {releaseSize && (
                    <p className={styles.hint}>
                        {t('settings.general.updatePackageSize', { size: releaseSize })}
                    </p>
                )}
                {sha256 && (
                    <p className={styles.updateHash} title={sha256}>
                        SHA-256: {sha256}
                    </p>
                )}
                {latest && (
                    <div className={styles.updateNotesBlock}>
                        <span className={styles.updateNotesTitle}>{t('settings.general.updateNotesTitle')}</span>
                        <p className={styles.updateNotes}>{releaseNotes || t('settings.general.updateNotesEmpty')}</p>
                    </div>
                )}
                {error && (
                    <p className={styles.updateError}>{t('settings.general.updateError', { error })}</p>
                )}
                {skippedVersion && (
                    <p className={styles.hint}>{t('settings.general.updateSkippedVersion', { version: skippedVersion })}</p>
                )}

                <div className={styles.updateActions}>
                    <button
                        className={styles.actionButton}
                        type="button"
                        onClick={() => void handleDownload()}
                        disabled={!hasAvailableUpdate}
                    >
                        <Download size={14} strokeWidth={1.6} />
                        {t('settings.general.updateDownload')}
                    </button>
                    <button
                        className={styles.actionButton}
                        type="button"
                        onClick={handleSkip}
                        disabled={!canSkip}
                    >
                        <SkipForward size={14} strokeWidth={1.6} />
                        {t('settings.general.updateSkipVersion')}
                    </button>
                    <button
                        className={styles.actionButton}
                        type="button"
                        onClick={handleClearSkipped}
                        disabled={!canClearSkipped}
                    >
                        <RotateCcw size={14} strokeWidth={1.6} />
                        {t('settings.general.updateClearSkipped')}
                    </button>
                </div>
            </div>
        </section>
    );
}
