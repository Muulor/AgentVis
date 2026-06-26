import React from 'react';
import ReactDOM from 'react-dom/client';
import { initializeLogger } from '@services/logger';
import { registerRendererCrashReporter } from '@services/logger/crashReporter';
import { registerRendererHealthMonitor } from '@services/diagnostics/rendererHealth';
import { I18nProvider } from '@/i18n';
import App from './App';
import '@styles/globals.css';

// 初始化统一日志系统（必须在所有模块加载之前）
initializeLogger();
registerRendererCrashReporter();
registerRendererHealthMonitor();

// 确保 root 元素存在
const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Failed to find root element');
}

ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
        <I18nProvider>
            <App />
        </I18nProvider>
    </React.StrictMode>
);
