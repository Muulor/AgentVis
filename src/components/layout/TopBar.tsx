import { useState, useEffect, useCallback } from 'react';
import { MoonStar, PanelLeft, PanelRight, Settings, Sun } from 'lucide-react';
import { useUIStore } from '@stores/uiStore';
import { HubTabs } from '@components/hub';
import { SettingsModal } from '@components/settings';
import { Tooltip } from '@components/ui/Tooltip';
import type { SettingsTab } from '@components/settings/SettingsModal';
import { OPEN_SETTINGS_EVENT } from '@components/onboarding/onboardingEvents';
import { useI18n } from '@/i18n';
import styles from './TopBar.module.css';

const ONBOARDING_SETTINGS_TABS: SettingsTab[] = ['apiKeys', 'cloudService'];

/**
 * TopBar 顶部标签栏
 *
 * 显示 Hub 标签页和设置入口
 */
export function TopBar() {
    const { t } = useI18n();
    const theme = useUIStore((state) => state.theme);
    const toggleTheme = useUIStore((state) => state.toggleTheme);
    const isLeftPanelCollapsed = useUIStore((state) => state.isLeftPanelCollapsed);
    const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel);
    const isRightPanelVisible = useUIStore((state) => state.isRightPanelVisible);
    const toggleRightPanel = useUIStore((state) => state.toggleRightPanel);
    const leftPanelLabel = isLeftPanelCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar');
    const rightPanelLabel = isRightPanelVisible ? t('layout.hideFilePanel') : t('layout.showFilePanel');
    const themeLabel = theme === 'light' ? t('layout.switchDark') : t('layout.switchLight');

    // 设置面板状态
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');

    // 快捷键 Ctrl+, 或 Cmd+, 打开设置
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === ',') {
            e.preventDefault();
            setSettingsInitialTab('general');
            setIsSettingsOpen(true);
        }
    }, []);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    useEffect(() => {
        const handleOpenSettings = (event: Event) => {
            const tab = (event as CustomEvent<{ tab?: SettingsTab }>).detail.tab;
            setSettingsInitialTab(
                tab && ONBOARDING_SETTINGS_TABS.includes(tab) ? tab : 'general'
            );
            setIsSettingsOpen(true);
        };

        window.addEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
        return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
    }, []);

    return (
        <>
            <header className={styles.topBar}>
                {/* Hub 标签区 - 使用 HubTabs 组件 */}
                <div className={styles.tabs}>
                    <Tooltip content={leftPanelLabel}>
                        <button
                            className={styles.leftPanelToggle}
                            data-collapsed={isLeftPanelCollapsed}
                            onClick={toggleLeftPanel}
                            aria-label={leftPanelLabel}
                        >
                            <PanelLeft size={16} strokeWidth={1.5} />
                        </button>
                    </Tooltip>
                    <HubTabs />
                </div>

                {/* 右侧操作区 */}
                <div className={styles.actions}>
                    {/* 右栏显示/隐藏按钮 */}
                    <Tooltip content={rightPanelLabel}>
                        <button
                            className={styles.iconButton}
                            onClick={toggleRightPanel}
                            aria-label={rightPanelLabel}
                        >
                            <PanelRight size={16} strokeWidth={1.5} />
                        </button>
                    </Tooltip>

                    {/* 主题切换按钮 */}
                    <Tooltip content={themeLabel}>
                        <button
                            className={styles.iconButton}
                            onClick={toggleTheme}
                            aria-label={themeLabel}
                        >
                            {theme === 'light' ? (
                                <Sun size={16} strokeWidth={1.5} />
                            ) : (
                                <MoonStar size={16} strokeWidth={1.5} />
                            )}
                        </button>
                    </Tooltip>

                    {/* 设置按钮 */}
                    <Tooltip content={t('settings.title')} shortcut="Ctrl+,">
                        <button
                            className={styles.iconButton}
                            aria-label={t('settings.title')}
                            onClick={() => {
                                setSettingsInitialTab('general');
                                setIsSettingsOpen(true);
                            }}
                        >
                            <Settings size={16} strokeWidth={1.5} />
                        </button>
                    </Tooltip>
                </div>
            </header>

            {/* 设置面板 */}
            <SettingsModal
                isOpen={isSettingsOpen}
                initialTab={settingsInitialTab}
                onClose={() => setIsSettingsOpen(false)}
            />
        </>
    );
}
