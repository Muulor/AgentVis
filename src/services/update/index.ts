export {
  checkForUpdates,
  compareVersions,
  formatReleaseSize,
  getConfiguredManifestUrl,
  getConfiguredReleaseChannel,
  getCurrentAppVersion,
  getLocalizedReleaseNotes,
  getReleaseDownloadUrl,
} from './UpdateService';
export type {
  ReleaseArtifact,
  ReleaseChannel,
  ReleaseInfo,
  ReleaseManifest,
  ReleaseNotes,
  ReleasePlatform,
  UpdateCheckResult,
} from './types';
