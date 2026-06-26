/**
 * 沙箱安全审计事件结构定义。
 *
 * 与 Rust 端 SandboxAuditEvent 的 Tauri camelCase 序列化字段保持一致，
 * 用于后续安全概览、审计日志和权限恢复 UI。
 */

export type SandboxAuditSource = 'exec' | 'externalSkill' | 'installer' | 'preview' | 'nativeTool';

export type SandboxAuditNetworkPolicy = 'inherit' | 'audit' | 'blocked';

export type SandboxAuditMode = 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';

export type SandboxAuditProcessLifecycle = 'managed' | 'detachedLaunch' | 'backgroundManaged';

export type SandboxAuditNetworkScope = 'inherit' | 'blocked' | 'lan' | 'internetAudit';

export type SandboxAuditBackend =
    | 'none'
    | 'jobObject'
    | 'restrictedToken'
    | 'appContainer'
    | 'mainProcess'
    | 'broker'
    | 'wfpEnhanced';

export type SandboxAuditDecision = 'allow' | 'audit' | 'block' | 'diagnostic';

export type SandboxAuditGuardMode =
    | 'auditOnly'
    | 'wouldBlock'
    | 'hardBlock'
    | 'directAuditAllowed';

export type SandboxAuditCleanupState =
    | 'notApplicable'
    | 'clean'
    | 'residualDetected'
    | 'failed';

export interface SandboxAuditEvent {
    schemaVersion: 1;
    id: string;
    timestamp: number;
    timestampIso: string;
    executionId: string | null;
    source: SandboxAuditSource;
    subjectType: 'command' | 'skill' | 'tool' | 'preview' | 'installer' | 'process' | 'wfpSession';
    subjectId: string | null;
    commandHash: string;
    profile: 'standard' | 'externalSkill' | 'installer' | 'preview' | 'restricted';
    sandboxMode: SandboxAuditMode;
    processLifecycle: SandboxAuditProcessLifecycle;
    networkPolicy: SandboxAuditNetworkPolicy;
    networkScope: SandboxAuditNetworkScope;
    backend: SandboxAuditBackend;
    decision: SandboxAuditDecision;
    reason: string;
    matchedPattern: string | null;
    riskClass?: string | null;
    riskKind?: string | null;
    credentialContext?: string | null;
    workdir: string | null;
    cleanup: SandboxAuditCleanupState | null;
    targetHost?: string | null;
    targetScheme?: string | null;
    targetPort?: number | null;
    networkProtocol?: string | null;
    guardMode?: SandboxAuditGuardMode | null;
    requestMethod?: string | null;
    urlHash?: string | null;
    statusCode?: number | null;
    bytesIn?: number | null;
    bytesOut?: number | null;
    durationMs?: number | null;
    blockedReason?: string | null;
}
