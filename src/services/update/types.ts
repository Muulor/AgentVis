export type ReleaseChannel = 'stable' | 'beta' | 'nightly';

export type ReleasePlatform =
  | 'windows-x86_64'
  | 'windows-aarch64'
  | 'darwin-x86_64'
  | 'darwin-aarch64'
  | 'linux-x86_64';

export interface ReleaseNotes {
  'zh-CN'?: string;
  'en-US'?: string;
  default?: string;
}

export interface ReleaseArtifact {
  url: string;
  fallbackUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  signature?: string;
}

export interface ReleaseInfo {
  version: string;
  releasedAt?: string;
  minimumSupportedVersion?: string;
  critical?: boolean;
  rolloutPercent?: number;
  notes?: string | ReleaseNotes;
  platforms: Partial<Record<ReleasePlatform, ReleaseArtifact>>;
}

export interface ReleaseManifest {
  schemaVersion: number;
  appId?: string;
  channel?: ReleaseChannel;
  latest: ReleaseInfo;
}

export interface UpdateCheckResult {
  currentVersion: string;
  manifestUrl: string;
  checkedAt: string;
  updateAvailable: boolean;
  latest?: ReleaseInfo;
  artifact?: ReleaseArtifact;
}
