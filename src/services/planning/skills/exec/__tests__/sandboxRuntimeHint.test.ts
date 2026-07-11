/**
 * Unit tests for sandbox runtime and preflight hints.
 */

import { describe, expect, it } from 'vitest';
import { generateSandboxPreflightCommandBlock, generateSandboxRuntimeCommandHint } from '../tool';

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
});
