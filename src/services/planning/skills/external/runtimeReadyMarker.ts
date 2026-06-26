/**
 * runtimeReadyMarker - Python Runtime 就绪标记管理
 *
 * 只有共享 Python 环境完成基础依赖安装后才写入该标记，避免残留的半成品 venv
 * 在下次启动或重新打开设置面板时被误判为可用环境。
 */

import { getLogger } from '@services/logger';

const logger = getLogger('runtimeReadyMarker');

export const RUNTIME_READY_MARKER_FILENAME = '.agentvis-runtime-ready-v1.json';

export interface RuntimeReadyMarkerMetadata {
    pythonVersion?: string;
    source?: 'fresh-install' | 'health-check';
}

export async function hasRuntimeReadyMarker(venvPath: string): Promise<boolean> {
    try {
        const { join } = await import('@tauri-apps/api/path');
        const { exists } = await import('@tauri-apps/plugin-fs');
        const markerPath = await join(venvPath, RUNTIME_READY_MARKER_FILENAME);
        return await exists(markerPath);
    } catch (error) {
        logger.warn(
            '[runtimeReadyMarker] 检查 runtime 就绪标记失败:',
            error instanceof Error ? error.message : String(error)
        );
        return false;
    }
}

export async function writeRuntimeReadyMarker(
    venvPath: string,
    metadata: RuntimeReadyMarkerMetadata = {}
): Promise<void> {
    const { join } = await import('@tauri-apps/api/path');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const markerPath = await join(venvPath, RUNTIME_READY_MARKER_FILENAME);

    await writeTextFile(
        markerPath,
        JSON.stringify(
            {
                schemaVersion: 1,
                createdAt: new Date().toISOString(),
                ...metadata,
            },
            null,
            2
        )
    );
}
