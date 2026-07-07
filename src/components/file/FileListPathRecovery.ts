const MISSING_PATH_ERROR_PATTERNS = [
    'path does not exist',
    'does not exist',
    'not found',
    'no such file',
    'cannot find',
    'could not find',
    '系统找不到指定的文件',
    '系统找不到指定的路径',
    'os error 2',
    'os error 3',
];

function errorToMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function isPathMissingError(error: unknown): boolean {
    const message = errorToMessage(error).toLowerCase();
    return MISSING_PATH_ERROR_PATTERNS.some(pattern => message.includes(pattern.toLowerCase()));
}

export function getParentDirectoryPath(path: string): string {
    const normalizedPath = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) {
        return '';
    }

    const separatorIndex = normalizedPath.lastIndexOf('/');
    if (separatorIndex < 0) {
        return '';
    }

    return normalizedPath.slice(0, separatorIndex);
}

export function getMissingDirectoryRecoveryPath(path: string, error: unknown): string | null {
    const normalizedPath = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedPath || !isPathMissingError(error)) {
        return null;
    }

    return getParentDirectoryPath(normalizedPath);
}
