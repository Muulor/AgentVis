/**
 * ExternalUrl - centralized external link opening.
 *
 * Keeps HTTP(S) links out of the AgentVis main WebView by routing them through
 * the system browser. In a Tauri runtime, a failed shell-open does not fall back
 * to window.open because that can trigger WebView navigation/new-window paths.
 */

import { getLogger } from '@services/logger';

const logger = getLogger('ExternalUrl');

type TauriWindow = Window & {
    __TAURI_INTERNALS__?: unknown;
};

function isTauriRuntime(): boolean {
    if (typeof window === 'undefined') return false;
    const tauriWindow = window as TauriWindow;
    return Boolean(tauriWindow.__TAURI__ ?? tauriWindow.__TAURI_INTERNALS__);
}

export function isHttpUrl(url?: string | null): url is string {
    if (!url) return false;

    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

export async function openExternalUrl(url: string): Promise<boolean> {
    if (!isHttpUrl(url)) {
        logger.warn('[ExternalUrl] Blocked non-http external URL:', url);
        return false;
    }

    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
        return true;
    } catch (error) {
        logger.warn('[ExternalUrl] Failed to open URL through system shell:', url, error);

        if (!isTauriRuntime() && typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        }

        return false;
    }
}
