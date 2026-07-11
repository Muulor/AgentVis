import { describe, expect, it } from 'vitest';
import { buildExecSandboxAuditSummary } from '../tool';
import type { SandboxAuditEvent } from '@/types';

function auditEvent(overrides: Partial<SandboxAuditEvent>): SandboxAuditEvent {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 'audit-1',
    timestamp: overrides.timestamp ?? 1000,
    timestampIso: overrides.timestampIso ?? '2026-05-26T00:00:00.000Z',
    executionId: overrides.executionId ?? 'exec-1',
    source: overrides.source ?? 'exec',
    subjectType: overrides.subjectType ?? 'command',
    subjectId: overrides.subjectId ?? 'agent-1',
    commandHash: overrides.commandHash ?? 'hash',
    profile: overrides.profile ?? 'standard',
    sandboxMode: overrides.sandboxMode ?? 'ControlledNetwork',
    processLifecycle: overrides.processLifecycle ?? 'managed',
    networkPolicy: overrides.networkPolicy ?? 'audit',
    networkScope: overrides.networkScope ?? 'internetAudit',
    backend: overrides.backend ?? 'broker',
    decision: overrides.decision ?? 'audit',
    reason: overrides.reason ?? 'broker_network_request',
    matchedPattern: overrides.matchedPattern ?? null,
    riskClass: overrides.riskClass ?? null,
    riskKind: overrides.riskKind ?? null,
    credentialContext: overrides.credentialContext ?? null,
    workdir: overrides.workdir ?? null,
    cleanup: overrides.cleanup ?? 'notApplicable',
    targetHost: overrides.targetHost ?? null,
    targetScheme: overrides.targetScheme ?? null,
    targetPort: overrides.targetPort ?? null,
    networkProtocol: overrides.networkProtocol ?? null,
    guardMode: overrides.guardMode ?? null,
    requestMethod: overrides.requestMethod ?? null,
    urlHash: overrides.urlHash ?? null,
    statusCode: overrides.statusCode ?? null,
    bytesIn: overrides.bytesIn ?? null,
    bytesOut: overrides.bytesOut ?? null,
    durationMs: overrides.durationMs ?? null,
    blockedReason: overrides.blockedReason ?? null,
  };
}

describe('buildExecSandboxAuditSummary', () => {
  it('summarizes broker requests without listing every audit event', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'request-1',
        backend: 'broker',
        decision: 'audit',
        reason: 'broker_network_request',
        targetHost: 'example.com',
        targetScheme: 'https',
        statusCode: 200,
      }),
    ]);

    expect(summary).toContain('broker');
    expect(summary).toContain('example.com');
    expect(summary).toContain('1');
  });

  it('surfaces block reasons and proxy bypass guidance', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'block-1',
        backend: 'broker',
        decision: 'block',
        reason: 'proxy_bypass_signal_blocked',
        guardMode: 'hardBlock',
        matchedPattern: '--proxy-bypass-list=*',
        targetHost: 'metadata.google.internal',
        blockedReason: 'proxy_bypass_signal_blocked',
      }),
    ]);

    expect(summary).toContain('proxy_bypass_signal_blocked');
    expect(summary).toContain('hardBlock');
    expect(summary).toContain('metadata.google.internal');
    expect(summary).toContain('broker/proxy-aware');
  });

  it('summarizes WFP canary diagnostics with guard and task category context', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'wfp-1',
        backend: 'wfpEnhanced',
        decision: 'diagnostic',
        reason: 'wfp_canary_direct_egress_observed',
        guardMode: 'wouldBlock',
        matchedPattern: 'networkIntent=curl; taskCategory=curl; backend=wfpCanary',
      }),
    ]);

    expect(summary).toContain('wfpCanary');
    expect(summary).toContain('wouldBlock');
    expect(summary).toContain('curl');
  });

  it('surfaces broker unused and upload confirmation diagnostics', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'unused-1',
        backend: 'broker',
        decision: 'diagnostic',
        reason: 'broker_proxy_expected_but_unused',
        guardMode: 'auditOnly',
        matchedPattern:
          'reasonCode=broker_proxy_expected_but_unused; reasonClass=potential_direct_egress',
      }),
      auditEvent({
        id: 'upload-1',
        backend: 'broker',
        decision: 'audit',
        reason: 'network_upload_risk_confirmed',
        guardMode: 'auditOnly',
        matchedPattern: 'curlFileBody=command:--data-binary',
      }),
    ]);

    expect(summary).toContain('broker_proxy_expected_but_unused');
    expect(summary).toContain('potential_direct_egress');
    expect(summary).toContain('network_upload_risk_confirmed');
  });

  it('surfaces structured network risk details before legacy matched pattern text', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'sensitive-egress-1',
        backend: 'broker',
        decision: 'audit',
        reason: 'network_sensitive_egress_confirmed',
        guardMode: 'auditOnly',
        matchedPattern:
          'riskClass=sensitiveEgress; riskKind=curlSensitiveBody; pattern=command:curl-sensitive-body',
        riskClass: 'sensitiveEgress',
        riskKind: 'curlSensitiveBody',
        credentialContext: 'brokerCredentialRef',
      }),
    ]);

    expect(summary).toContain('riskClass=sensitiveEgress');
    expect(summary).toContain('riskKind=curlSensitiveBody');
    expect(summary).toContain('credentialContext=brokerCredentialRef');
    expect(summary).toContain('pattern=command:curl-sensitive-body');
  });

  it('surfaces direct-audit DNS risk details for aggregation', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'direct-1',
        backend: 'broker',
        decision: 'audit',
        reason: 'network_direct_audit_allowed',
        guardMode: 'directAuditAllowed',
        networkProtocol: 'postgres',
        targetHost: '127.0.0.1.sslip.io',
        targetPort: 5432,
        matchedPattern:
          'nonHttpOrRawSocket=postgres; target=postgres://127.0.0.1.sslip.io:5432; resolvedRisk=private; reason=hostnameEncodedPrivateOrLocalIp; ips=127.0.0.1',
      }),
    ]);

    expect(summary).toContain('network_direct_audit_allowed');
    expect(summary).toContain('hostnameEncodedPrivateOrLocalIp');
    expect(summary).toContain('127.0.0.1.sslip.io');
  });

  it('surfaces broker encoded-hostname risk details for aggregation', () => {
    const summary = buildExecSandboxAuditSummary([
      auditEvent({
        id: 'broker-encoded-1',
        backend: 'broker',
        decision: 'block',
        reason: 'broker_network_block',
        guardMode: 'hardBlock',
        targetHost: '169-254-169-254.sslip.io',
        targetScheme: 'http',
        matchedPattern:
          'targetHost=169-254-169-254.sslip.io; resolvedRisk=metadata; resolvedRiskReason=hostnameEncodedMetadataIp; resolvedIpSamples=169.254.169.254',
        blockedReason: 'Network broker rejected encoded hostname target',
      }),
    ]);

    expect(summary).toContain('broker_network_block');
    expect(summary).toContain('169-254-169-254.sslip.io');
    expect(summary).toContain('hostnameEncodedMetadataIp');
    expect(summary).toContain('resolvedIpSamples=169.254.169.254');
  });
});
