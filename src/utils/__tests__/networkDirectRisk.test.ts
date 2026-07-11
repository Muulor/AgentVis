import { describe, expect, it } from 'vitest';
import { classifyNetworkDirectTarget } from '../networkDirectRisk';

describe('classifyNetworkDirectTarget', () => {
  it('classifies public targets as public', () => {
    expect(classifyNetworkDirectTarget({ protocol: 'ssh', host: 'example.com', port: 22 })).toBe(
      'public'
    );
  });

  it('classifies localhost, private, link-local, and CGNAT targets as private', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '192.168.1.10',
      '169.254.1.1',
      '100.64.1.10',
      '::1',
    ]) {
      expect(classifyNetworkDirectTarget({ protocol: 'ssh', host, port: 22 })).toBe('private');
    }
  });

  it('classifies cloud metadata targets as metadata', () => {
    for (const host of [
      '169.254.169.254',
      '169.254.170.2',
      '100.100.100.200',
      'metadata.google.internal',
    ]) {
      expect(classifyNetworkDirectTarget({ protocol: 'ssh', host, port: 22 })).toBe('metadata');
    }
  });

  it('prefers backend resolved DNS risk when present', () => {
    expect(
      classifyNetworkDirectTarget({
        protocol: 'ssh',
        host: 'db.example.com',
        port: 22,
        resolvedRisk: 'private',
        resolvedIpSamples: ['10.0.0.4'],
      })
    ).toBe('private');
  });
});
