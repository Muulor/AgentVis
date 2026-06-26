/**
 * Python Runtime 沙箱兼容性检测工具
 *
 * 隔离模式要求 AgentVis 管理的 venv 不依赖用户主机 Python。
 * 仅检查 pyvenv.cfg 中可稳定归因的 base runtime 字段，避免在运行命令后才让
 * AppContainer 把错误暴露成含混的“Python 环境问题”。
 */

export type PythonVenvHermeticityStatus = 'hermetic' | 'nonHermetic' | 'unknown';

export interface PythonVenvHermeticity {
    status: PythonVenvHermeticityStatus;
    externalRoots: string[];
}

const PYVENV_BASE_KEYS = ['home', 'executable', 'base-executable', 'base_executable'] as const;

function normalizePathForCompare(path: string): string {
    return path
        .replace(/^["']|["']$/g, '')
        .replace(/\\/g, '/')
        .replace(/\/+$/g, '')
        .toLowerCase();
}

function parentPath(path: string): string | null {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    if (index <= 0) return null;
    return normalized.slice(0, index);
}

function isAbsolutePath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function isWithinPath(path: string, root: string): boolean {
    const normalizedPath = normalizePathForCompare(path);
    const normalizedRoot = normalizePathForCompare(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function parsePyvenvConfig(content: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 0) continue;

        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
        if (key && value) {
            values[key] = value;
        }
    }
    return values;
}

export function getManagedRuntimeRoot(runtimeDir: string): string {
    return parentPath(runtimeDir) ?? runtimeDir;
}

export function inspectPyvenvHermeticityFromConfig(
    pyvenvConfig: string,
    runtimeDir: string
): PythonVenvHermeticity {
    const values = parsePyvenvConfig(pyvenvConfig);
    const managedRuntimeRoot = getManagedRuntimeRoot(runtimeDir);
    const externalRoots = PYVENV_BASE_KEYS
        .map((key) => values[key])
        .filter((value): value is string => !!value && isAbsolutePath(value))
        .filter((value) => !isWithinPath(value, managedRuntimeRoot));

    if (externalRoots.length > 0) {
        return {
            status: 'nonHermetic',
            externalRoots: Array.from(new Set(externalRoots)),
        };
    }

    const checkedAnyPath = PYVENV_BASE_KEYS.some((key) => {
        const value = values[key];
        return !!value && isAbsolutePath(value);
    });

    return {
        status: checkedAnyPath ? 'hermetic' : 'unknown',
        externalRoots: [],
    };
}

export async function inspectPythonVenvHermeticity(
    runtimeDir: string,
    venvPath = `${runtimeDir}/.venv`
): Promise<PythonVenvHermeticity> {
    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const pyvenvConfig = await readTextFile(`${venvPath.replace(/\\/g, '/')}/pyvenv.cfg`);
        return inspectPyvenvHermeticityFromConfig(pyvenvConfig, runtimeDir);
    } catch {
        return {
            status: 'unknown',
            externalRoots: [],
        };
    }
}
