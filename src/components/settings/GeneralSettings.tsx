/**
 * GeneralSettings - 常规设置标签页
 *
 * 包含外观主题、语言设置、安全防护（Trash Bin 路径 + 路径保护名单）
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Bell, MoonStar, Sun, Trash } from 'lucide-react';
import { useSettingsStore, type TaskCompletionNotificationContentMode } from '@stores/settingsStore';
import { useUIStore } from '@stores/uiStore';
import { useToast } from '../ui/Toast';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { SUPPORTED_LANGUAGES, useI18n, type Language } from '@/i18n';
import styles from './GeneralSettings.module.css';
import { UpdateSettings } from './UpdateSettings';

const logger = getLogger('GeneralSettings');

export function GeneralSettings() {
    const themePreference = useUIStore((state) => state.themePreference);
    const setThemePreference = useUIStore((state) => state.setThemePreference);
    const taskCompletionNotificationsEnabled = useSettingsStore((state) => state.taskCompletionNotificationsEnabled);
    const taskCompletionNotificationsBackgroundOnly = useSettingsStore((state) => state.taskCompletionNotificationsBackgroundOnly);
    const taskCompletionNotificationContentMode = useSettingsStore((state) => state.taskCompletionNotificationContentMode);
    const setTaskCompletionNotificationsEnabled = useSettingsStore((state) => state.setTaskCompletionNotificationsEnabled);
    const setTaskCompletionNotificationsBackgroundOnly = useSettingsStore((state) => state.setTaskCompletionNotificationsBackgroundOnly);
    const setTaskCompletionNotificationContentMode = useSettingsStore((state) => state.setTaskCompletionNotificationContentMode);
    const { language, setLanguage, t } = useI18n();
    const { toast } = useToast();

    // 安全防护状态
    const [trashBinPath, setTrashBinPath] = useState<string>('');
    const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
    const [isLoadingSecurity, setIsLoadingSecurity] = useState(false);
    const [isSavingPaths, setIsSavingPaths] = useState(false);

    // 加载安全设置数据
    const loadSecurityData = useCallback(async () => {
        // 非 Tauri 环境跳过
        const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
        if (!hasTauri) return;

        setIsLoadingSecurity(true);
        try {
            const [trashPath, paths] = await Promise.all([
                invoke<string>('get_trash_bin_path'),
                invoke<string[]>('get_protected_paths'),
            ]);
            setTrashBinPath(trashPath);
            setProtectedPaths(paths);
        } catch (error) {
            logger.error('[GeneralSettings] 加载安全设置失败:', error);
        } finally {
            setIsLoadingSecurity(false);
        }
    }, []);

    useEffect(() => {
        void loadSecurityData();
    }, [loadSecurityData]);

    // 在资源管理器中打开 Trash Bin
    const handleOpenTrashBin = useCallback(async () => {
        if (!trashBinPath) return;
        try {
            await invoke('file_reveal_in_explorer', { filePath: trashBinPath });
        } catch (error) {
            logger.error('[GeneralSettings] 打开回收站目录失败:', error);
            toast({ type: 'error', title: t('settings.general.toastOpenDirectoryFailed') });
        }
    }, [trashBinPath, toast, t]);

    // 添加保护路径
    const handleAddPath = useCallback(async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: t('settings.general.selectProtectedPathTitle'),
            });

            if (!selected) return;

            const selectedPath = selected;

            // 检查是否已存在（大小写不敏感）
            const isDuplicate = protectedPaths.some(
                (existPath) => existPath.toLowerCase() === selectedPath.toLowerCase()
            );
            if (isDuplicate) {
                toast({ type: 'error', title: t('settings.general.toastPathDuplicate') });
                return;
            }

            const newPaths = [...protectedPaths, selectedPath];
            setIsSavingPaths(true);
            try {
                await invoke('set_protected_paths', { paths: newPaths });
                setProtectedPaths(newPaths);
                toast({ type: 'success', title: t('settings.general.toastPathAdded') });
            } catch (error) {
                logger.error('[GeneralSettings] 保存保护路径失败:', error);
                toast({ type: 'error', title: t('settings.general.toastSaveFailed', { error: String(error) }) });
            } finally {
                setIsSavingPaths(false);
            }
        } catch (error) {
            logger.error('[GeneralSettings] 选择目录失败:', error);
        }
    }, [protectedPaths, toast, t]);

    // 删除保护路径
    const handleRemovePath = useCallback(async (index: number) => {
        const newPaths = protectedPaths.filter((_, i) => i !== index);
        setIsSavingPaths(true);
        try {
            await invoke('set_protected_paths', { paths: newPaths });
            setProtectedPaths(newPaths);
            toast({ type: 'success', title: t('settings.general.toastPathRemoved') });
        } catch (error) {
            logger.error('[GeneralSettings] 移除保护路径失败:', error);
            toast({ type: 'error', title: t('settings.general.toastRemoveFailed', { error: String(error) }) });
        } finally {
            setIsSavingPaths(false);
        }
    }, [protectedPaths, toast, t]);

    return (
        <div className={styles.container}>
            {/* 外观主题 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.general.appearance')}</h3>
                <div className={styles.themeSelector}>
                    <button
                        className={cx(styles.themeOption, themePreference === 'light' && styles.themeOptionActive)}
                        onClick={() => setThemePreference('light')}
                    >
                        <Sun size={20} strokeWidth={1.5} />
                        <span>{t('settings.general.themeLight')}</span>
                    </button>
                    <button
                        className={cx(styles.themeOption, themePreference === 'dark' && styles.themeOptionActive)}
                        onClick={() => setThemePreference('dark')}
                    >
                        <MoonStar size={20} strokeWidth={1.5} />
                        <span>{t('settings.general.themeDark')}</span>
                    </button>
                    <button
                        className={cx(styles.themeOption, themePreference === 'system' && styles.themeOptionActive)}
                        onClick={() => setThemePreference('system')}
                    >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="3" y="4" width="14" height="10" rx="1" />
                            <path d="M7 17h6M10 14v3" />
                        </svg>
                        <span>{t('settings.general.themeSystem')}</span>
                    </button>
                </div>
            </section>

            {/* 语言设置 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>{t('settings.general.language')}</h3>
                <select
                    className={styles.select}
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as Language)}
                >
                    {SUPPORTED_LANGUAGES.map((item) => (
                        <option key={item.code} value={item.code}>
                            {item.label}
                        </option>
                    ))}
                </select>
                <p className={styles.hint}>{t('settings.general.languageHint')}</p>
            </section>

            {/* 桌面通知 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                    <Bell size={16} strokeWidth={1.5} className={styles.sectionIcon} />
                    {t('settings.general.notifications')}
                </h3>
                <label className={styles.toggleRow}>
                    <span className={styles.toggleTextGroup}>
                        <span className={styles.toggleLabel}>{t('settings.general.taskCompletionNotifications')}</span>
                        <span className={styles.hint}>{t('settings.general.taskCompletionNotificationsHint')}</span>
                    </span>
                    <span className={styles.switchControl}>
                        <input
                            className={styles.toggleInput}
                            type="checkbox"
                            checked={taskCompletionNotificationsEnabled}
                            onChange={(event) => setTaskCompletionNotificationsEnabled(event.target.checked)}
                        />
                        <span className={styles.toggleSwitch} />
                    </span>
                </label>

                <label className={styles.toggleRow} data-disabled={!taskCompletionNotificationsEnabled}>
                    <span className={styles.toggleTextGroup}>
                        <span className={styles.toggleLabel}>{t('settings.general.taskCompletionNotificationsBackgroundOnly')}</span>
                        <span className={styles.hint}>{t('settings.general.taskCompletionNotificationsBackgroundOnlyHint')}</span>
                    </span>
                    <span className={styles.switchControl}>
                        <input
                            className={styles.toggleInput}
                            type="checkbox"
                            checked={taskCompletionNotificationsBackgroundOnly}
                            disabled={!taskCompletionNotificationsEnabled}
                            onChange={(event) => setTaskCompletionNotificationsBackgroundOnly(event.target.checked)}
                        />
                        <span className={styles.toggleSwitch} />
                    </span>
                </label>

                <div className={styles.settingField} data-disabled={!taskCompletionNotificationsEnabled}>
                    <label className={styles.fieldLabel} htmlFor="task-completion-notification-content">
                        {t('settings.general.taskCompletionNotificationContent')}
                    </label>
                    <select
                        id="task-completion-notification-content"
                        className={styles.select}
                        value={taskCompletionNotificationContentMode}
                        disabled={!taskCompletionNotificationsEnabled}
                        onChange={(event) => {
                            setTaskCompletionNotificationContentMode(event.target.value as TaskCompletionNotificationContentMode);
                        }}
                    >
                        <option value="summary">{t('settings.general.taskCompletionNotificationSummary')}</option>
                        <option value="private">{t('settings.general.taskCompletionNotificationPrivate')}</option>
                    </select>
                    <p className={styles.hint}>{t('settings.general.taskCompletionNotificationContentHint')}</p>
                </div>
            </section>

            {/* Agent 回收站 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                    <Trash size={16} strokeWidth={1.5} className={styles.sectionIcon} />
                    {t('settings.general.trashBin')}
                </h3>
                {isLoadingSecurity ? (
                    <div className={styles.loadingHint}>{t('common.loading')}</div>
                ) : (
                    <>
                        <div className={styles.pathDisplay}>
                            <span className={styles.pathText}>
                                {trashBinPath || t('settings.general.trashBinMissingPath')}
                            </span>
                            <button
                                className={styles.openButton}
                                onClick={handleOpenTrashBin}
                                disabled={!trashBinPath}
                                title={t('settings.general.trashBinOpenTitle')}
                            >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
                                    <path d="M10 2h4v4M7 9l7-7" />
                                </svg>
                                {t('common.open')}
                            </button>
                        </div>
                        <p className={styles.hint}>
                            {t('settings.general.trashBinHint')}
                        </p>
                    </>
                )}
            </section>

            {/* 路径保护名单 */}
            <section className={styles.section}>
                <h3 className={styles.sectionTitle}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.sectionIcon}>
                        <path d="M8 1.5L2 4v4.5c0 3.5 2.6 6.2 6 7 3.4-.8 6-3.5 6-7V4L8 1.5Z" />
                        <path d="M6 8l2 2 3-3" />
                    </svg>
                    {t('settings.general.protectedPaths')}
                </h3>
                {isLoadingSecurity ? (
                    <div className={styles.loadingHint}>{t('common.loading')}</div>
                ) : (
                    <>
                        <div className={styles.pathList}>
                            {protectedPaths.length === 0 ? (
                                <div className={styles.emptyHint}>
                                    {t('settings.general.protectedPathsEmpty')}
                                </div>
                            ) : (
                                protectedPaths.map((path, index) => (
                                    <div key={`${path}-${index}`} className={styles.pathRow}>
                                        <span className={styles.pathRowText} title={path}>{path}</span>
                                        <button
                                            className={styles.removeButton}
                                            onClick={() => handleRemovePath(index)}
                                            disabled={isSavingPaths}
                                            title={t('settings.general.protectedPathRemoveTitle')}
                                            aria-label={t('settings.general.protectedPathRemoveAria', { path })}
                                        >
                                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                <path d="M4 4l8 8M12 4l-8 8" />
                                            </svg>
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                        <button
                            className={styles.addButton}
                            onClick={handleAddPath}
                            disabled={isSavingPaths}
                        >
                            {isSavingPaths ? (
                                <span className={styles.spinner} />
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M8 3v10M3 8h10" />
                                </svg>
                            )}
                            {t('settings.general.protectedPathsAdd')}
                        </button>
                        <p className={styles.hint}>
                            {t('settings.general.protectedPathsHint')}
                        </p>
                    </>
                )}
            </section>

            <UpdateSettings />
        </div>
    );
}
