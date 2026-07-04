import { create } from 'zustand';
import { getLogger } from '@services/logger';

const logger = getLogger('uiStore');

/**
 * 主题偏好类型
 */
type ThemePreference = 'light' | 'dark' | 'system';

/**
 * UI 状态类型定义
 */
interface UIState {
    // 主题偏好（用户选择）
    themePreference: ThemePreference;
    // 实际渲染主题
    theme: 'light' | 'dark';

    // 布局状态
    leftPanelWidth: number;
    rightPanelWidth: number;
    isLeftPanelCollapsed: boolean;
    isRightPanelVisible: boolean;

    // 拖拽状态 - 拖拽时禁用过渡效果防止回弹
    isResizing: boolean;

    // 模态框状态
    activeModal: string | null;

    // Actions
    setThemePreference: (preference: ThemePreference) => void;
    setTheme: (theme: 'light' | 'dark') => void;
    toggleTheme: () => void;
    setLeftPanelWidth: (width: number) => void;
    setRightPanelWidth: (width: number) => void;
    toggleLeftPanel: () => void;
    toggleRightPanel: () => void;
    setIsResizing: (isResizing: boolean) => void;
    openModal: (modalId: string) => void;
    closeModal: () => void;
}

/**
 * 获取系统当前主题
 */
function getSystemTheme(): 'light' | 'dark' {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 获取初始主题偏好（从 localStorage）
 */
function getInitialThemePreference(): ThemePreference {
    if (typeof window === 'undefined') return 'system';
    const saved = localStorage.getItem('agentvis-theme-preference') as ThemePreference | null;
    return saved ?? 'system';
}

/**
 * 根据偏好计算实际主题
 */
function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
    if (preference === 'system') {
        return getSystemTheme();
    }
    return preference;
}

/**
 * UI Store - 管理布局、主题、模态框等 UI 状态
 */
export const useUIStore = create<UIState>((set, get) => {
    const initialPreference = getInitialThemePreference();
    const initialTheme = resolveTheme(initialPreference);

    // 监听系统主题变化（仅在 system 模式下响应）
    if (typeof window !== 'undefined') {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

        const handleSystemThemeChange = (e: MediaQueryListEvent) => {
            const state = get();
            if (state.themePreference === 'system') {
                const newTheme = e.matches ? 'dark' : 'light';
                set({ theme: newTheme });
                // 更新 DOM
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('agentvis-theme', newTheme);
                logger.trace('[uiStore] 系统主题变化，切换到:', newTheme);
            }
        };

        // 使用 addEventListener 而非 addListener（后者已废弃）
        mediaQuery.addEventListener('change', handleSystemThemeChange);
    }

    return {
        // 初始状态
        themePreference: initialPreference,
        theme: initialTheme,
        leftPanelWidth: 200,
        rightPanelWidth: 400,
        isLeftPanelCollapsed: false,
        isRightPanelVisible: true,
        isResizing: false,
        activeModal: null,

        // 设置主题偏好（主入口）
        setThemePreference: (preference) => {
            const newTheme = resolveTheme(preference);
            set({ themePreference: preference, theme: newTheme });

            // 持久化
            localStorage.setItem('agentvis-theme-preference', preference);
            localStorage.setItem('agentvis-theme', newTheme);

            // 更新 DOM
            document.documentElement.setAttribute('data-theme', newTheme);
            logger.trace('[uiStore] 主题偏好设置为:', preference, '实际主题:', newTheme);
        },

        // 直接设置主题（用于兼容）
        setTheme: (theme) => set({ theme }),

        // 切换主题（在 light/dark 之间切换，同时更新偏好）
        toggleTheme: () =>
            set((state) => {
                const newTheme = state.theme === 'light' ? 'dark' : 'light';
                localStorage.setItem('agentvis-theme-preference', newTheme);
                localStorage.setItem('agentvis-theme', newTheme);
                document.documentElement.setAttribute('data-theme', newTheme);
                return { theme: newTheme, themePreference: newTheme };
            }),

        // 左栏操作
        setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
        toggleLeftPanel: () =>
            set((state) => ({
                isLeftPanelCollapsed: !state.isLeftPanelCollapsed,
            })),

        // 右栏操作
        setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
        toggleRightPanel: () =>
            set((state) => ({
                isRightPanelVisible: !state.isRightPanelVisible,
            })),

        // 拖拽状态操作
        setIsResizing: (isResizing) => set({ isResizing }),

        // 模态框操作
        openModal: (modalId) => set({ activeModal: modalId }),
        closeModal: () => set({ activeModal: null }),
    };
});

