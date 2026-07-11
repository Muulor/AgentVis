import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  checkForUpdates,
  getConfiguredReleaseChannel,
  getConfiguredManifestUrl,
  getCurrentAppVersion,
} from '@services/update';
import type { ReleaseChannel, ReleaseInfo, UpdateCheckResult } from '@services/update';

const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

type UpdateStatus = 'idle' | 'checking' | 'available' | 'current' | 'error';

interface UpdateState {
  autoCheckEnabled: boolean;
  channel: ReleaseChannel;
  skippedVersion: string | null;
  status: UpdateStatus;
  currentVersion: string | null;
  latest: ReleaseInfo | null;
  downloadUrl: string | null;
  fallbackUrl: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  manifestUrl: string;
  lastCheckedAt: string | null;
  error: string | null;
  setAutoCheckEnabled: (enabled: boolean) => void;
  skipVersion: (version: string) => void;
  clearSkippedVersion: () => void;
  checkNow: () => Promise<UpdateCheckResult>;
  autoCheckIfNeeded: () => Promise<void>;
}

function shouldAutoCheck(lastCheckedAt: string | null): boolean {
  if (!lastCheckedAt) return true;
  const checkedTime = Date.parse(lastCheckedAt);
  if (!Number.isFinite(checkedTime)) return true;
  return Date.now() - checkedTime >= AUTO_CHECK_INTERVAL_MS;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      autoCheckEnabled: true,
      channel: getConfiguredReleaseChannel(),
      skippedVersion: null,
      status: 'idle',
      currentVersion: null,
      latest: null,
      downloadUrl: null,
      fallbackUrl: null,
      sizeBytes: null,
      sha256: null,
      manifestUrl: getConfiguredManifestUrl(),
      lastCheckedAt: null,
      error: null,
      setAutoCheckEnabled: (enabled) => set({ autoCheckEnabled: enabled }),
      skipVersion: (version) => set({ skippedVersion: version }),
      clearSkippedVersion: () => set({ skippedVersion: null }),
      checkNow: async () => {
        const manifestUrl = getConfiguredManifestUrl();
        let currentVersion = get().currentVersion;
        set({ status: 'checking', error: null, manifestUrl });
        try {
          currentVersion = await getCurrentAppVersion();
          set({ currentVersion });

          const result = await checkForUpdates(manifestUrl);
          const latestVersion = result.latest?.version ?? null;
          const isSkipped = latestVersion !== null && latestVersion === get().skippedVersion;
          const hasAvailableUpdate = result.updateAvailable && !isSkipped;

          set({
            status: hasAvailableUpdate ? 'available' : 'current',
            currentVersion: result.currentVersion,
            latest: result.latest ?? null,
            downloadUrl: result.artifact?.url ?? null,
            fallbackUrl: result.artifact?.fallbackUrl ?? null,
            sizeBytes: result.artifact?.sizeBytes ?? null,
            sha256: result.artifact?.sha256 ?? null,
            manifestUrl: result.manifestUrl,
            lastCheckedAt: result.checkedAt,
            error: null,
          });
          return result;
        } catch (error) {
          set({
            status: 'error',
            currentVersion,
            error: getErrorMessage(error),
            lastCheckedAt: new Date().toISOString(),
            manifestUrl,
          });
          throw error;
        }
      },
      autoCheckIfNeeded: async () => {
        const state = get();
        if (
          !state.autoCheckEnabled ||
          state.status === 'checking' ||
          !shouldAutoCheck(state.lastCheckedAt)
        ) {
          return;
        }

        try {
          await get().checkNow();
        } catch {
          // 自动检查失败只记录在 store，避免启动时打扰用户。
        }
      },
    }),
    {
      name: 'agentvis-update-state',
      partialize: (state) => ({
        autoCheckEnabled: state.autoCheckEnabled,
        channel: state.channel,
        skippedVersion: state.skippedVersion,
        currentVersion: state.currentVersion,
        latest: state.latest,
        downloadUrl: state.downloadUrl,
        fallbackUrl: state.fallbackUrl,
        sizeBytes: state.sizeBytes,
        sha256: state.sha256,
        manifestUrl: state.manifestUrl,
        lastCheckedAt: state.lastCheckedAt,
      }),
    }
  )
);
