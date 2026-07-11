export type NetworkDirectSubjectType = 'command' | 'skill' | 'preview' | 'installer';

export type NetworkDirectAllowanceScope = 'currentExecution' | 'session';

export interface NetworkDirectTarget {
  protocol: string;
  host: string;
  port: number;
  resolvedRisk?: 'public' | 'private' | 'metadata' | 'unknown';
  resolvedIpSamples?: string[];
  resolvedRiskReason?: string;
}

export interface NetworkDirectAllowance {
  id: string;
  subjectType: NetworkDirectSubjectType;
  subjectId?: string;
  protocol: string;
  host: string;
  port: number;
  scope: NetworkDirectAllowanceScope;
  expiresAt?: number;
  createdAt: number;
  reason: string;
}

export interface NetworkDirectAuthorizationGrant {
  allowances: NetworkDirectAllowance[];
  targets: NetworkDirectTarget[];
}

export interface NetworkDirectAuthorizationRequest {
  command: string;
  workdir?: string;
  subjectType: NetworkDirectSubjectType;
  subjectId?: string;
  targets: NetworkDirectTarget[];
  reasonCode: string;
  reason: string;
}
