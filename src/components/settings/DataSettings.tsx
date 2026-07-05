/**
 * DataSettings - 数据管理标签页
 *
 * 显示数据统计、数据存储位置，提供导入/导出和数据重置功能
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { appDataDir } from '@tauri-apps/api/path';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../ui/Toast';
import { Tooltip } from '@components/ui/Tooltip';
import {
    getDataStats,
    exportData,
    importData,
    clearVectors,
    resetAllData,
    formatFileSize,
    getBackupStats,
    cleanBackups,
    type DataStats,
    type ImportMode,
    type BackupStats,
    type CleanPolicy,
    type CleanResult,
} from '../../services/data/dataManagementService';
import styles from './DataSettings.module.css';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

const logger = getLogger('DataSettings');

export function DataSettings() {
    const { t } = useI18n();
    const [dataDir, setDataDir] = useState<string>('');
    const [stats, setStats] = useState<DataStats | null>(null);
    const [appVersion, setAppVersion] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [isClearing, setIsClearing] = useState(false);
    const [showClearVectorConfirm, setShowClearVectorConfirm] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [resetPhrase, setResetPhrase] = useState('');
    const [isResetting, setIsResetting] = useState(false);
    const [showImportModeDialog, setShowImportModeDialog] = useState(false);
    const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
    const [isTauriEnv, setIsTauriEnv] = useState(true); // 默认假设是 Tauri 环境
    const { toast } = useToast();

    // ── 备份管理状态 ──
    const [backupStats, setBackupStats] = useState<BackupStats | null>(null);
    const [showCleanDropdown, setShowCleanDropdown] = useState(false);
    const [isCleaning, setIsCleaning] = useState(false);
    const [pendingCleanPolicy, setPendingCleanPolicy] = useState<CleanPolicy | null>(null);
    const [showCleanConfirm, setShowCleanConfirm] = useState(false);
    const cleanDropdownRef = useRef<HTMLDivElement>(null);

    const loadData = useCallback(async () => {
        // 检测是否在 Tauri 环境中
        const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
        setIsTauriEnv(hasTauri);

        if (!hasTauri) {
            // 非 Tauri 环境，不加载数据
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        try {
            const [appData, dataStats, bkStats, version] = await Promise.all([
                appDataDir(),
                getDataStats(),
                getBackupStats(),
                getVersion(),
            ]);
            setDataDir(appData);
            setStats(dataStats);
            setBackupStats(bkStats);
            setAppVersion(version);
        } catch (error) {
            logger.error('[DataSettings] 加载数据失败:', error);
            toast({ type: 'error', title: t('settings.data.loadStatsFailed') });
        } finally {
            setIsLoading(false);
        }
    }, [toast, t]);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    // 点击页面其他区域时收起下拉菜单
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                cleanDropdownRef.current &&
                !cleanDropdownRef.current.contains(e.target as Node)
            ) {
                setShowCleanDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // 打开 backups/ 目录
    const handleOpenBackupsDir = async () => {
        if (!backupStats?.dirPath) return;
        try {
            await invoke('file_reveal_in_explorer', { filePath: backupStats.dirPath });
        } catch (error) {
            logger.error('[DataSettings] 打开备份目录失败:', error);
            toast({ type: 'error', title: t('settings.data.cannotOpenDir', { error: String(error) }) });
        }
    };

    // 点击清理策略「执行」按钮：保存策略并弹确认框
    const handleCleanPolicyClick = (policy: CleanPolicy) => {
        setShowCleanDropdown(false);
        setPendingCleanPolicy(policy);
        setShowCleanConfirm(true);
    };

    // 执行备份清理
    const handleConfirmClean = async () => {
        if (!pendingCleanPolicy) return;
        setShowCleanConfirm(false);
        setIsCleaning(true);
        try {
            const result: CleanResult = await cleanBackups(pendingCleanPolicy);
            toast({
                type: 'success',
                title: t('settings.data.backupsCleaned', {
                    count: result.deletedCount,
                    size: formatFileSize(result.freedBytes),
                }),
            });
            // 清理后刷新备份统计
            const bkStats = await getBackupStats();
            setBackupStats(bkStats);
        } catch (error) {
            logger.error('[DataSettings] 清理备份失败:', error);
            toast({ type: 'error', title: t('settings.data.cleanFailed', { error: String(error) }) });
        } finally {
            setIsCleaning(false);
            setPendingCleanPolicy(null);
        }
    };

    // 根据 CleanPolicy 生成确认弹窗的描述文字
    const getCleanConfirmDescription = (policy: CleanPolicy | null): string => {
        if (!policy) return '';
        switch (policy.type) {
            case 'olderThanDays':
                return t('settings.data.cleanOlderThanDaysDescription', { days: policy.days });
            case 'keepLatestPerFile':
                return t('settings.data.cleanKeepLatestDescription', { count: policy.count });
            case 'deleteAll':
                return t('settings.data.cleanDeleteAllDescription', {
                    count: backupStats?.fileCount ?? 0,
                    size: formatFileSize(backupStats?.totalBytes ?? 0),
                });
            default:
                return '';
        }
    };

    // 导出数据
    const handleExport = async () => {
        try {
            const savePath = await save({
                defaultPath: `agentvis_export_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`,
                filters: [{ name: t('settings.data.zipFilterName'), extensions: ['zip'] }],
            });

            if (!savePath) return;

            setIsExporting(true);
            await exportData(savePath);
            toast({ type: 'success', title: t('settings.data.exportSuccess') });
        } catch (error) {
            logger.error('[DataSettings] 导出失败:', error);
            toast({ type: 'error', title: t('settings.data.exportFailed', { error: String(error) }) });
        } finally {
            setIsExporting(false);
        }
    };

    // 打开导入文件选择
    const handleImportClick = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: t('settings.data.zipFilterName'), extensions: ['zip'] }],
            });

            if (!selected) return;

            // 保存路径并显示模式选择对话框
            setPendingImportPath(selected);
            setShowImportModeDialog(true);
        } catch (error) {
            logger.error('[DataSettings] 选择导入文件失败:', error);
            toast({ type: 'error', title: t('settings.data.selectFileFailed', { error: String(error) }) });
        }
    };

    // 执行导入
    const handleImport = async (mode: ImportMode) => {
        if (!pendingImportPath) return;

        setShowImportModeDialog(false);
        setIsImporting(true);

        try {
            const result = await importData(pendingImportPath, mode);

            // 构建详细的导入统计信息
            const stats = [
                result.importedHubs > 0 ? `${result.importedHubs} Hub` : null,
                result.importedAgents > 0 ? `${result.importedAgents} Agent` : null,
                result.importedMessages > 0 ? `${result.importedMessages} ${t('settings.data.messages')}` : null,
                result.importedMemories > 0 ? `${result.importedMemories} ${t('settings.data.memories')}` : null,
                result.importedVectors > 0 ? `${result.importedVectors} ${t('settings.data.vectorChunks')}` : null,
            ].filter(Boolean).join(', ');

            // 如果有警告，显示警告信息
            if (result.warnings.length > 0) {
                logger.warn('[DataSettings] 导入警告:', result.warnings);
            }

            // 判断是否有实际导入的数据
            const hasImportedData = result.importedHubs > 0 ||
                result.importedAgents > 0 ||
                result.importedMessages > 0;

            if (hasImportedData) {
                // 有核心数据导入，需要刷新页面以更新应用全局状态
                toast({
                    type: 'success',
                    title: t('settings.data.importSuccessReload', { stats }),
                });

                // 延迟刷新页面，让用户看到成功提示
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } else {
                // 无核心数据导入，只刷新统计
                toast({
                    type: 'success',
                    title: t('settings.data.importSuccess', { stats: stats || t('settings.data.noNewData') }),
                });
                await loadData();
                setIsImporting(false);
                setPendingImportPath(null);
            }
        } catch (error) {
            logger.error('[DataSettings] 导入失败:', error);
            toast({ type: 'error', title: t('settings.data.importFailed', { error: String(error) }) });
            setIsImporting(false);
            setPendingImportPath(null);
        }
    };


    // 清除向量缓存 - 显示确认弹窗
    const handleClearVectorsClick = () => {
        setShowClearVectorConfirm(true);
    };

    // 执行清除向量缓存
    const handleClearVectors = async () => {
        setShowClearVectorConfirm(false);
        setIsClearing(true);
        try {
            const count = await clearVectors();
            toast({ type: 'success', title: t('settings.data.vectorsCleared', { count }) });
            await loadData();
        } catch (error) {
            logger.error('[DataSettings] 清除向量失败:', error);
            toast({ type: 'error', title: t('settings.data.clearFailed', { error: String(error) }) });
        } finally {
            setIsClearing(false);
        }
    };

    // 重置所有数据
    const handleReset = async () => {
        if (resetPhrase !== t('settings.data.resetPhrase')) {
            toast({ type: 'error', title: t('settings.data.resetPhraseInvalid') });
            return;
        }

        setIsResetting(true);
        try {
            await resetAllData(resetPhrase);
            toast({ type: 'success', title: t('settings.data.resetSuccessReload') });
            setShowResetConfirm(false);
            setResetPhrase('');

            // 延迟刷新页面，让用户看到成功提示，同时确保应用全局状态更新
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } catch (error) {
            logger.error('[DataSettings] 重置失败:', error);
            toast({ type: 'error', title: t('settings.data.resetFailed', { error: String(error) }) });
            setIsResetting(false);
        }
    };

    // 非 Tauri 环境显示提示
    if (!isTauriEnv) {
        return (
            <div className={styles.container}>
                <div className={styles.webWarning}>
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="24" cy="24" r="20" />
                        <path d="M24 14v12M24 30v4" />
                    </svg>
                    <h3 className={styles.webWarningTitle}>{t('settings.data.desktopOnlyTitle')}</h3>
                    <p className={styles.webWarningText}>
                        {t('settings.data.desktopOnlyText')}
                        <br />
                        {t('settings.data.desktopOnlyBrowserText')}
                    </p>
                    <p className={styles.webWarningHint}>
                        {t('settings.data.desktopOnlyHint')}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            {/* 数据统计 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.stats')}</h3>
                {isLoading ? (
                    <div className={styles.statsLoading}>{t('common.loading')}</div>
                ) : stats ? (
                    <div className={styles.statsGrid}>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{stats.hubCount}</span>
                            <span className={styles.statLabel}>Hub</span>
                        </div>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{stats.agentCount}</span>
                            <span className={styles.statLabel}>Agent</span>
                        </div>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{stats.messageCount}</span>
                            <span className={styles.statLabel}>{t('settings.data.messages')}</span>
                        </div>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{stats.memoryCount}</span>
                            <span className={styles.statLabel}>{t('settings.data.memories')}</span>
                        </div>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{stats.vectorChunkCount}</span>
                            <span className={styles.statLabel}>{t('settings.data.vectorChunks')}</span>
                        </div>
                        <div className={styles.statCard}>
                            <span className={styles.statValue}>{formatFileSize(stats.dbSizeBytes)}</span>
                            <span className={styles.statLabel}>{t('settings.data.databaseSize')}</span>
                        </div>
                    </div>
                ) : null}
            </section>

            {/* 数据存储位置 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.dataLocation')}</h3>
                <div className={styles.pathDisplay}>
                    <span className={styles.pathText}>{dataDir || t('common.loading')}</span>
                </div>
                <p className={styles.hint}>
                    {t('settings.data.dataLocationHint')}
                </p>
            </section>

            {/* 导入导出 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.dataManagement')}</h3>
                <div className={styles.buttonGroup}>
                    <button
                        className={styles.actionButton}
                        onClick={handleExport}
                        disabled={isExporting || isImporting}
                    >
                        {isExporting ? (
                            <span className={styles.spinner} />
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2M8 2v9M5 6l3-3 3 3" />
                            </svg>
                        )}
                        {t('settings.data.exportData')}
                    </button>
                    <button
                        className={styles.actionButton}
                        onClick={handleImportClick}
                        disabled={isExporting || isImporting}
                    >
                        {isImporting ? (
                            <span className={styles.spinner} />
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2M8 11V2M5 8l3 3 3-3" />
                            </svg>
                        )}
                        {t('settings.data.importData')}
                    </button>
                </div>
                <p className={styles.hint}>{t('settings.data.importExportHint')}</p>
            </section>

            {/* 文件备份管理 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.fileBackups')}</h3>

                {/* 备份目录路径 + 打开按钮 */}
                <div className={styles.pathRow}>
                    <span className={styles.pathText}>
                        {backupStats?.dirPath ?? t('common.loading')}
                    </span>
                    <Tooltip content={t('settings.data.openBackupsTitle')}>
                        <button
                            id="backup-open-dir-btn"
                            className={styles.openButton}
                            onClick={handleOpenBackupsDir}
                            aria-label={t('settings.data.openBackupsTitle')}
                        >
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M7 2h3v3M10 2L6 6M2 5.5V10h7V6" />
                            </svg>
                            {t('common.open')}
                        </button>
                    </Tooltip>
                </div>

                {/* 备份文件统计摘要 */}
                {backupStats !== null && (
                    <p className={styles.backupSummaryText}>
                        {t('settings.data.backupSummary', {
                            count: backupStats.fileCount,
                            size: formatFileSize(backupStats.totalBytes),
                        })}
                    </p>
                )}

                {/* 批量清理下拉触发按钮 */}
                <div className={styles.cleanDropdownWrapper} ref={cleanDropdownRef}>
                    <button
                        id="backup-clean-dropdown-btn"
                        className={styles.actionButton}
                        onClick={() => setShowCleanDropdown(prev => !prev)}
                        disabled={isCleaning}
                    >
                        {isCleaning ? (
                            <span className={styles.spinner} />
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M2 4h10M4 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M5 6v4M9 6v4M3 4v7a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4" />
                            </svg>
                        )}
                        {isCleaning ? t('settings.data.cleaning') : t('settings.data.batchClean')}
                    </button>

                    {/* 清理策略下拉面板 */}
                    {showCleanDropdown && (
                        <div className={styles.cleanDropdownPanel}>
                            <div className={styles.cleanOption}>
                                <span className={styles.cleanOptionLabel}>{t('settings.data.deleteOlder7Days')}</span>
                                <button
                                    id="backup-clean-older-7d-btn"
                                    className={styles.cleanExecButton}
                                    onClick={() => handleCleanPolicyClick({ type: 'olderThanDays', days: 7 })}
                                >
                                    {t('common.execute')}
                                </button>
                            </div>
                            <div className={styles.cleanOption}>
                                <span className={styles.cleanOptionLabel}>{t('settings.data.keepLatest3')}</span>
                                <button
                                    id="backup-clean-keep3-btn"
                                    className={styles.cleanExecButton}
                                    onClick={() => handleCleanPolicyClick({ type: 'keepLatestPerFile', count: 3 })}
                                >
                                    {t('common.execute')}
                                </button>
                            </div>
                            <div className={styles.cleanSeparator} />
                            <div className={cx(styles.cleanOption, styles.cleanOptionDanger)}>
                                <span className={styles.cleanOptionLabel}>{t('settings.data.deleteAllBackups')}</span>
                                <button
                                    id="backup-clean-all-btn"
                                    className={styles.cleanExecButton}
                                    onClick={() => handleCleanPolicyClick({ type: 'deleteAll' })}
                                >
                                    {t('common.execute')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <p className={styles.hint}>
                    {t('settings.data.backupHint')}
                </p>
            </section>

            {/* 缓存管理 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.cacheManagement')}</h3>
                <div className={styles.buttonGroup}>
                    <button
                        className={styles.actionButton}
                        onClick={handleClearVectorsClick}
                        disabled={isClearing}
                    >
                        {isClearing ? (
                            <span className={styles.spinner} />
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4" />
                            </svg>
                        )}
                        {t('settings.data.clearVectorCache')}
                    </button>
                    <button
                        className={cx(styles.actionButton, styles.dangerButton)}
                        onClick={() => setShowResetConfirm(true)}
                        disabled={isResetting}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4" />
                        </svg>
                        {t('settings.data.resetAllData')}
                    </button>
                </div>
                <p className={styles.hint}>{t('settings.data.resetDangerHint')}</p>
            </section>

            {/* 关于 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.data.about')}</h3>
                <div className={styles.aboutCard}>
                    <div className={styles.aboutRow}>
                        <span className={styles.aboutLabel}>{t('settings.data.version')}</span>
                        <span className={styles.aboutValue}>{appVersion || t('common.loading')}</span>
                    </div>
                </div>
            </section>

            {/* 备份清理确认弹窗 */}
            {showCleanConfirm && pendingCleanPolicy && (
                <div className={styles.dialogOverlay}>
                    <div className={styles.dialog}>
                        <h3 className={styles.dialogTitle}>{t('settings.data.confirmCleanBackups')}</h3>
                        <p className={styles.dialogText}>
                            {getCleanConfirmDescription(pendingCleanPolicy)}
                        </p>
                        <div className={styles.dialogActions}>
                            <button
                                id="backup-clean-cancel-btn"
                                className={styles.dialogCancelButton}
                                onClick={() => {
                                    setShowCleanConfirm(false);
                                    setPendingCleanPolicy(null);
                                }}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                id="backup-clean-confirm-btn"
                                className={
                                    pendingCleanPolicy.type === 'deleteAll'
                                        ? styles.dialogDangerButton
                                        : styles.actionButton
                                }
                                onClick={handleConfirmClean}
                            >
                                {t('settings.data.confirmClean')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 重置确认弹窗 */}
            {showResetConfirm && (
                <div className={styles.dialogOverlay}>
                    <div className={styles.dialog}>
                        <h3 className={styles.dialogTitle}>{t('settings.data.confirmResetAllData')}</h3>
                        <p className={styles.dialogText}>
                            {t('settings.data.resetWillDelete')}
                        </p>
                        <ul className={styles.dialogList}>
                            <li>{t('settings.data.hubItems', { count: stats?.hubCount ?? 0 })}</li>
                            <li>{t('settings.data.agentItems', { count: stats?.agentCount ?? 0 })}</li>
                            <li>{stats?.messageCount ?? 0} {t('settings.data.messages')}</li>
                            <li>{stats?.memoryCount ?? 0} {t('settings.data.memories')}</li>
                            <li>{stats?.vectorChunkCount ?? 0} {t('settings.data.vectorChunks')}</li>
                        </ul>
                        <p className={styles.dialogWarning}>
                            {t('settings.data.resetPhrasePrompt')} <strong>"{t('settings.data.resetPhrase')}"</strong> {t('settings.data.resetPhraseSuffix')}
                        </p>
                        <input
                            type="text"
                            className={styles.dialogInput}
                            value={resetPhrase}
                            onChange={(e) => setResetPhrase(e.target.value)}
                            placeholder={t('settings.data.resetPhrase')}
                            disabled={isResetting}
                        />
                        <div className={styles.dialogActions}>
                            <button
                                className={styles.dialogCancelButton}
                                onClick={() => {
                                    setShowResetConfirm(false);
                                    setResetPhrase('');
                                }}
                                disabled={isResetting}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                className={styles.dialogDangerButton}
                                onClick={handleReset}
                                disabled={resetPhrase !== t('settings.data.resetPhrase') || isResetting}
                            >
                                {isResetting ? t('settings.data.resetting') : t('settings.data.confirmReset')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 导入模式选择弹窗 */}
            {showImportModeDialog && (
                <div className={styles.dialogOverlay}>
                    <div className={styles.dialog}>
                        <h3 className={styles.dialogTitle}>{t('settings.data.chooseImportMode')}</h3>
                        <p className={styles.dialogText}>
                            {t('settings.data.chooseImportModeDesc')}
                        </p>
                        <div className={styles.importModeOptions}>
                            <button
                                className={styles.importModeButton}
                                onClick={() => handleImport('merge')}
                            >
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M10 4v12M4 10h12" />
                                </svg>
                                <span className={styles.importModeTitle}>{t('settings.data.mergeMode')}</span>
                                <span className={styles.importModeDesc}>{t('settings.data.mergeModeDesc')}</span>
                            </button>
                            <button
                                className={cx(styles.importModeButton, styles.importModeReplace)}
                                onClick={() => handleImport('replace')}
                            >
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M4 4l12 12M4 16L16 4" />
                                </svg>
                                <span className={styles.importModeTitle}>{t('settings.data.replaceMode')}</span>
                                <span className={styles.importModeDesc}>{t('settings.data.replaceModeDesc')}</span>
                            </button>
                        </div>
                        <button
                            className={styles.dialogCancelButton}
                            onClick={() => {
                                setShowImportModeDialog(false);
                                setPendingImportPath(null);
                            }}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}

            {/* 清除向量缓存确认弹窗 */}
            {showClearVectorConfirm && (
                <div className={styles.dialogOverlay}>
                    <div className={styles.dialog}>
                        <h3 className={styles.dialogTitle}>{t('settings.data.clearVectorCacheTitle')}</h3>
                        <p className={styles.dialogText}>
                            {t('settings.data.clearVectorCacheDesc')}
                        </p>
                        <p className={styles.dialogHint}>
                            {t('settings.data.clearVectorCacheHint', { count: stats?.vectorChunkCount ?? 0 })}
                        </p>
                        <div className={styles.dialogActions}>
                            <button
                                className={styles.dialogCancelButton}
                                onClick={() => setShowClearVectorConfirm(false)}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                className={styles.dialogDangerButton}
                                onClick={handleClearVectors}
                            >
                                {t('settings.data.confirmClear')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
