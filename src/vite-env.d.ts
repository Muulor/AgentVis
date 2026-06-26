/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_AGENTVIS_RELEASE_MANIFEST_URL?: string;
    readonly VITE_AGENTVIS_RELEASE_CHANNEL?: string;
    readonly VITE_AGENTVIS_LOG_LEVEL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// Tauri API 类型声明
interface Window {
    __TAURI__?: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
}
