import { getVersion } from '@tauri-apps/api/app';
import { getCurrentLanguage, type Language } from '@/i18n';
import type {
    ReleaseArtifact,
    ReleaseChannel,
    ReleaseInfo,
    ReleaseManifest,
    ReleaseNotes,
    ReleasePlatform,
    UpdateCheckResult,
} from './types';

const DEFAULT_MANIFEST_URL = 'https://agentvis-download-1318040347.cos.ap-beijing.myqcloud.com/releases/latest.json';
const DEFAULT_CHANNEL: ReleaseChannel = 'stable';
const DEFAULT_PLATFORM: ReleasePlatform = 'windows-x86_64';
const REQUEST_TIMEOUT_MS = 8_000;

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

function getEnvString(key: string): string | undefined {
    const env = import.meta.env as Record<string, unknown>;
    const value = env[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
}

function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, '');
}

function parseVersion(version: string): ParsedVersion | null {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(normalizeVersion(version));
    if (!match) return null;

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4]?.split('.') ?? [],
    };
}

export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);

    if (!a || !b) {
        return normalizeVersion(left).localeCompare(normalizeVersion(right), undefined, { numeric: true });
    }

    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
    }

    if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
    if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;

    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = a.prerelease[index];
        const rightPart = b.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;

        const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
        const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

        if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
            return leftNumber > rightNumber ? 1 : -1;
        }
        if (leftNumber !== null && rightNumber === null) return -1;
        if (leftNumber === null && rightNumber !== null) return 1;
        if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
    }

    return 0;
}

function isReleaseNotes(value: unknown): value is ReleaseNotes {
    return typeof value === 'object' && value !== null;
}

function isReleaseArtifact(value: unknown): value is ReleaseArtifact {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<ReleaseArtifact>;
    return typeof candidate.url === 'string' && candidate.url.trim().length > 0;
}

function isReleaseInfo(value: unknown): value is ReleaseInfo {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.version === 'string'
        && typeof candidate.platforms === 'object'
        && candidate.platforms !== null;
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<ReleaseManifest>;
    return typeof candidate.schemaVersion === 'number' && isReleaseInfo(candidate.latest);
}

export function getConfiguredReleaseChannel(): ReleaseChannel {
    const channel = getEnvString('VITE_AGENTVIS_RELEASE_CHANNEL');
    if (channel === 'beta' || channel === 'nightly') return channel;
    return DEFAULT_CHANNEL;
}

export function getConfiguredManifestUrl(): string {
    return getEnvString('VITE_AGENTVIS_RELEASE_MANIFEST_URL') ?? DEFAULT_MANIFEST_URL;
}

export async function getCurrentAppVersion(): Promise<string> {
    if (!isTauriRuntime()) {
        return '0.0.0-dev';
    }

    return getVersion();
}

async function fetchManifest(manifestUrl: string): Promise<ReleaseManifest> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(manifestUrl, {
            headers: {
                Accept: 'application/json',
            },
            cache: 'no-cache',
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload: unknown = await response.json();
        if (!isReleaseManifest(payload)) {
            throw new Error('Invalid release manifest');
        }

        return payload;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export async function checkForUpdates(
    manifestUrl = getConfiguredManifestUrl(),
    platform: ReleasePlatform = DEFAULT_PLATFORM,
): Promise<UpdateCheckResult> {
    const [currentVersion, manifest] = await Promise.all([
        getCurrentAppVersion(),
        fetchManifest(manifestUrl),
    ]);
    const latest = manifest.latest;
    const artifact = latest.platforms[platform];
    const updateAvailable = Boolean(
        artifact
        && isReleaseArtifact(artifact)
        && compareVersions(latest.version, currentVersion) > 0
    );

    return {
        currentVersion,
        manifestUrl,
        checkedAt: new Date().toISOString(),
        updateAvailable,
        latest,
        artifact: isReleaseArtifact(artifact) ? artifact : undefined,
    };
}

export function getLocalizedReleaseNotes(release: ReleaseInfo | null | undefined, language: Language = getCurrentLanguage()): string {
    const notes = release?.notes;
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    if (!isReleaseNotes(notes)) return '';

    return notes[language] ?? notes.default ?? notes['zh-CN'] ?? notes['en-US'] ?? '';
}

export function getReleaseDownloadUrl(artifact: ReleaseArtifact | null | undefined): string | null {
    return artifact?.url ?? artifact?.fallbackUrl ?? null;
}

export function formatReleaseSize(sizeBytes: number | null | undefined): string {
    if (!sizeBytes || sizeBytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = sizeBytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    const value = unitIndex === 0 ? String(size) : size.toFixed(size >= 10 ? 1 : 2);
    const unit = units[unitIndex] ?? 'B';
    return `${value} ${unit}`;
}
