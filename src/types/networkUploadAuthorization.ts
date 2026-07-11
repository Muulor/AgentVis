export type NetworkUploadSubjectType = 'command' | 'skill' | 'preview' | 'installer';
export type NetworkRiskAuthorizationKind = 'fileUpload' | 'sensitiveEgress' | 'remoteDestructive';

export interface NetworkUploadAuthorizationRequest {
  command: string;
  workdir?: string;
  subjectType: NetworkUploadSubjectType;
  subjectId?: string;
  reasonCode: string;
  reason: string;
  riskKind?: NetworkRiskAuthorizationKind;
}
