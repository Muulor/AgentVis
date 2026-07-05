/**
 * GeneralSettings - 常规设置标签页
 *
 * 包含外观主题、语言设置、桌面通知和版本更新。
 */

import { Bell, MoonStar, Sun } from 'lucide-react';
import { Select } from '@components/ui';
import { useSettingsStore, type TaskCompletionNotificationContentMode } from '@stores/settingsStore';
import { useUIStore } from '@stores/uiStore';
import { cx } from '@utils/classNames';
import { SUPPORTED_LANGUAGES, useI18n, type Language } from '@/i18n';
import styles from './GeneralSettings.module.css';
import { UpdateSettings } from './UpdateSettings';

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
                <Select
                    className={styles.select}
                    value={language}
                    onValueChange={(value) => setLanguage(value as Language)}
                    options={SUPPORTED_LANGUAGES.map((item) => ({
                        value: item.code,
                        label: item.label,
                    }))}
                />
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
                    <Select
                        id="task-completion-notification-content"
                        className={styles.select}
                        value={taskCompletionNotificationContentMode}
                        disabled={!taskCompletionNotificationsEnabled}
                        onValueChange={(value) => {
                            setTaskCompletionNotificationContentMode(value as TaskCompletionNotificationContentMode);
                        }}
                        options={[
                            {
                                value: 'summary',
                                label: t('settings.general.taskCompletionNotificationSummary'),
                            },
                            {
                                value: 'private',
                                label: t('settings.general.taskCompletionNotificationPrivate'),
                            },
                        ]}
                    />
                    <p className={styles.hint}>{t('settings.general.taskCompletionNotificationContentHint')}</p>
                </div>
            </section>

            <UpdateSettings />
        </div>
    );
}
