import { useEffect, useLayoutEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUIStore } from '@stores/uiStore';
import { getLogger } from '@services/logger';

const logger = getLogger('useTheme');

/**
 * 主题管理 Hook
 *
 * 负责初始化主题并同步到 DOM 属性和 Tauri 窗口标题栏
 */
export function useTheme() {
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);

  // 使用 useLayoutEffect 避免主题闪烁
  useLayoutEffect(() => {
    // 读取本地存储的主题偏好，如果没有则检测系统偏好
    const savedTheme = localStorage.getItem('agentvis-theme') as 'light' | 'dark' | null;
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = savedTheme ?? (systemPrefersDark ? 'dark' : 'light');

    // 立即应用到 DOM，避免白闪
    document.documentElement.setAttribute('data-theme', initialTheme);

    setTheme(initialTheme);
  }, [setTheme]);

  // 同步主题到 DOM 和 Tauri 窗口标题栏
  useEffect(() => {
    // 同步到 DOM
    document.documentElement.setAttribute('data-theme', theme);
    // 持久化到 localStorage
    localStorage.setItem('agentvis-theme', theme);

    // 同步到 Tauri 窗口标题栏（异步操作）
    const syncWindowTheme = async () => {
      try {
        const appWindow = getCurrentWindow();
        // Tauri setTheme 接受 'dark' | 'light' | null (null 表示跟随系统)
        await appWindow.setTheme(theme);
        logger.trace('[useTheme] 窗口标题栏主题已同步:', theme);
      } catch (error) {
        logger.error('[useTheme] 同步窗口主题失败:', error);
      }
    };

    void syncWindowTheme();
  }, [theme]);

  return { theme, setTheme };
}
