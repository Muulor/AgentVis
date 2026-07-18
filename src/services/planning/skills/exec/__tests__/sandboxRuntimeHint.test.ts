/**
 * Unit tests for sandbox runtime and preflight hints.
 */

import { describe, expect, it } from 'vitest';
import {
  extractCommandGuardReason,
  formatExecGuardErrorForObservation,
  generateCommandGuardRecoveryHint,
  generateSandboxPreflightCommandBlock,
  generateSandboxRuntimeCommandHint,
} from '../tool';

describe('command guard reasons', () => {
  it('extracts structured reasons from sandbox and safety blocks', () => {
    expect(
      extractCommandGuardReason('Sandbox block [proxy_bypass_signal_blocked]: denied')
    ).toEqual({ source: 'sandbox', reasonCode: 'proxy_bypass_signal_blocked' });
    expect(
      extractCommandGuardReason(
        'Safety block [recoverable_delete_required]: could not move D:\\Agent_Trash_Bin\\item'
      )
    ).toEqual({ source: 'safety', reasonCode: 'recoverable_delete_required' });
    expect(
      extractCommandGuardReason(
        'Operation forbidden: SAFETY block [SCRIPT_SCAN_UNAVAILABLE]: unreadable path'
      )
    ).toEqual({ source: 'safety', reasonCode: 'script_scan_unavailable' });
    expect(
      extractCommandGuardReason(
        'command stderr mentioned Safety block [recoverable_delete_required], but was not a guard'
      )
    ).toBeUndefined();
  });

  it('returns a neutral delete retry hint without exposing the recovery mechanism', () => {
    const hint = generateCommandGuardRecoveryHint(
      'Safety block [recoverable_delete_required]: D:\\Agent_Trash_Bin\\items\\secret'
    );

    expect(hint).toContain('[DELETE_RETRY_REQUIRED]');
    expect(hint).toContain('-NoProfile');
    expect(hint).toContain('Remove-Item -LiteralPath');
    expect(hint).toContain('del');
    expect(hint).toContain('rmdir');
    expect(hint).toContain('/f /q');
    expect(hint).toContain('/s /q');
    expect(hint).not.toContain('Agent_Trash_Bin');
    expect(hint).not.toMatch(/recoverable|soft delet|trash bin|scan|软删除|回收站|扫描/i);
  });

  it('does not add delete recovery guidance for unrelated guard reasons', () => {
    expect(
      generateCommandGuardRecoveryHint('Sandbox block [proxy_bypass_signal_blocked]: denied')
    ).toBeNull();
  });

  it('formats a neutral delete-unavailable observation without leaking internal details', () => {
    const message = formatExecGuardErrorForObservation(
      'Operation forbidden: Safety block [recoverable_delete_unavailable]: ' +
        'D:\\Agent_Trash_Bin\\items\\secret\\payload'
    );

    expect(message).toContain('[DELETE_UNAVAILABLE]');
    expect(message).toMatch(/another command, script, or tool|其他命令、脚本或工具/);
    expect(message).not.toContain('Agent_Trash_Bin');
    expect(message).not.toContain('secret');
    expect(message).not.toMatch(
      /recoverable|soft delet|trash bin|cross-volume|scan|软删除|回收站|跨卷|扫描/i
    );
  });

  it('keeps the legacy cross-volume reason mapped to the same terminal observation', () => {
    const message = formatExecGuardErrorForObservation(
      'Operation forbidden: Safety block [recoverable_delete_cross_volume]: legacy backend'
    );

    expect(message).toContain('[DELETE_UNAVAILABLE]');
    expect(message).toMatch(/another command, script, or tool|其他命令、脚本或工具/);
    expect(message).not.toMatch(/cross-volume|跨卷/i);
  });

  it('formats legacy script guard failures without exposing the inspection mechanism', () => {
    const message = formatExecGuardErrorForObservation(
      'Operation forbidden: Safety block [script_scan_unavailable]: ' +
        "script file 'D:\\private\\cleanup.py' could not be read"
    );

    expect(message).toContain('[EXECUTION_INPUT_UNAVAILABLE]');
    expect(message).not.toContain('D:\\private');
    expect(message).not.toContain('cleanup.py');
    expect(message).not.toMatch(/script.scan|scann|扫描/i);
  });

  it.each([
    ['script_scan_unreadable', '[EXECUTION_INPUT_UNREADABLE]', /already exists|已(?:经)?存在/],
    ['script_scan_too_large', '[EXECUTION_INPUT_TOO_LARGE]', /8 MiB/i],
    [
      'script_scan_ambiguous_launcher',
      '[EXECUTION_ENTRY_AMBIGUOUS]',
      /command or script will launch|命令或脚本将启动/i,
    ],
    ['script_scan_depth_exceeded', '[EXECUTION_CHAIN_TOO_DEEP]', /eight|8 层/i],
  ])('formats the specific %s observation without leaking paths', (reason, label, guidance) => {
    const message = formatExecGuardErrorForObservation(
      'Operation forbidden: Safety block [' +
        reason +
        "]: script file 'D:\\private\\cleanup.py' failed"
    );

    expect(message).toContain(label);
    expect(message).toMatch(guidance);
    expect(message).not.toContain('D:\\private');
    expect(message).not.toContain('cleanup.py');
    expect(message).not.toMatch(/script.scan|scann|扫描/i);
  });
});

describe('generateSandboxRuntimeCommandHint', () => {
  it('does not inject hints for LocalAudit mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'vercel --version',
      '',
      "'vercel' is not recognized as an internal or external command",
      'LocalAudit'
    );

    expect(hint).toBeNull();
  });

  it('does not inject offline-isolation hints when a command is missing in controlled-network mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'vercel --version',
      '',
      "'vercel' is not recognized as an internal or external command",
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('does not treat credential misses as sandbox filesystem misses in controlled-network mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'python github_lookup.py info NousResearch/hermes-agent',
      '',
      'No such file: C:\\Users\\User\\.github_token.json',
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('injects a sandbox hint for global install or login attempts in OfflineIsolated mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'npm install -g vercel',
      '',
      'install failed',
      'OfflineIsolated'
    );

    expect(hint).toContain('[SANDBOX_RUNTIME_CONTEXT]');
    expect(hint).toContain('OfflineIsolated');
  });

  it('preflight-blocks global installs in OfflineIsolated mode', () => {
    const block = generateSandboxPreflightCommandBlock('npm install -g vercel', 'OfflineIsolated');

    expect(block).toContain('OfflineIsolated');
  });

  it('does not preflight-block global installs in controlled-network mode', () => {
    const block = generateSandboxPreflightCommandBlock(
      'npm install -g vercel',
      'ControlledNetwork'
    );

    expect(block).toBeNull();
  });

  it('does not preflight-block global installs in LocalAudit mode', () => {
    const block = generateSandboxPreflightCommandBlock('npm install -g vercel', 'LocalAudit');

    expect(block).toBeNull();
  });

  it('does not inject socket permission hints in controlled-network mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'python fetch_title.py',
      '',
      'PermissionError: [WinError 10013] An attempt was made to access a socket in a way forbidden by its access permissions',
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('does not inject filesystem boundary hints in controlled-network mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'npx --yes vercel --version',
      '',
      "Error: EPERM: operation not permitted, lstat 'C:\\'",
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('does not treat Windows where misses as sandbox-visible PATH misses in controlled-network mode', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'where node',
      '',
      'INFO: Could not find files for the given pattern(s).',
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('does not inject a hint for unrelated command failures', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'npx tsc --noEmit',
      '',
      'src/app.ts(1,1): error TS1005: ; expected.',
      'ControlledNetwork'
    );

    expect(hint).toBeNull();
  });

  it('does not append sandbox runtime guidance to safety guard observations', () => {
    const hint = generateSandboxRuntimeCommandHint(
      'del .env',
      '',
      'Safety block [recoverable_delete_required]: could not move .env safely',
      'OfflineIsolated'
    );

    expect(hint).toBeNull();
  });
});
