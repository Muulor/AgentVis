import { describe, expect, it } from 'vitest';
import { getSandboxPathViolation } from '../sandboxPath';
import type { ToolExecutionContext } from '../../../tools/types';

const isolatedContext: ToolExecutionContext = {
  sandboxMode: 'OfflineIsolated',
  workdir: 'C:/Users/Test/AgentWork',
};

describe('sandboxPath', () => {
  it('allows paths inside workdir in OfflineIsolated mode', () => {
    expect(
      getSandboxPathViolation('C:/Users/Test/AgentWork/report.md', isolatedContext)
    ).toBeNull();
    expect(
      getSandboxPathViolation('C:\\Users\\Test\\AgentWork\\nested\\file.txt', isolatedContext)
    ).toBeNull();
  });

  it('blocks sibling paths outside workdir in OfflineIsolated mode', () => {
    const violation = getSandboxPathViolation('C:/Users/Test/Other/file.txt', isolatedContext);
    expect(violation?.reason).toBe('outsideWorkdir');
    expect(violation?.mode).toBe('OfflineIsolated');
  });

  it('allows linked project roots in OfflineIsolated mode', () => {
    const context: ToolExecutionContext = {
      sandboxMode: 'OfflineIsolated',
      workdir: 'C:/Users/Test/AgentDeliverables',
      sandboxRoots: ['E:/docs', 'C:/Users/Test/AgentDeliverables'],
    };

    expect(getSandboxPathViolation('E:/docs/analysis_results.md', context)).toBeNull();
    expect(
      getSandboxPathViolation('C:/Users/Test/AgentDeliverables/report.md', context)
    ).toBeNull();
  });

  it('blocks paths outside all sandbox roots', () => {
    const violation = getSandboxPathViolation('E:/private/notes.md', {
      sandboxMode: 'ControlledNetwork',
      workdir: 'C:/Users/Test/AgentDeliverables',
      sandboxRoots: ['E:/docs', 'C:/Users/Test/AgentDeliverables'],
    });

    expect(violation?.reason).toBe('outsideWorkdir');
    expect(violation?.root).toBe('E:/docs');
  });

  it('allows host filesystem paths when controlled-network mode uses local filesystem scope', () => {
    expect(
      getSandboxPathViolation('C:/Users/Test/.github_token.json', {
        sandboxMode: 'ControlledNetwork',
        sandboxFilesystemScope: 'local',
        workdir: 'C:/Users/Test/AgentDeliverables',
      })
    ).toBeNull();
  });

  it('keeps OfflineIsolated mode workspace-bounded even if a local scope is provided', () => {
    const violation = getSandboxPathViolation('C:/Users/Test/.github_token.json', {
      sandboxMode: 'OfflineIsolated',
      sandboxFilesystemScope: 'local',
      workdir: 'C:/Users/Test/AgentDeliverables',
    });

    expect(violation?.reason).toBe('outsideWorkdir');
  });

  it('normalizes traversal before comparing paths', () => {
    const violation = getSandboxPathViolation(
      'C:/Users/Test/AgentWork/../Other/file.txt',
      isolatedContext
    );
    expect(violation?.reason).toBe('outsideWorkdir');
  });

  it('does not restrict LocalAudit mode', () => {
    expect(
      getSandboxPathViolation('C:/Users/Test/Other/file.txt', {
        sandboxMode: 'LocalAudit',
        workdir: 'C:/Users/Test/AgentWork',
      })
    ).toBeNull();
  });
});
