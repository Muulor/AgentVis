import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncTauriDevResources } from '../../scripts/sync-tauri-dev-resources.mjs';

const tempRoots = [];

function createRepoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'AgentVis-中文路径-'));
  tempRoots.push(repoRoot);

  const sourceDir = join(repoRoot, 'src-tauri', 'skills-bundle');
  mkdirSync(join(sourceDir, 'skill-one', 'nested'), { recursive: true });
  writeFileSync(join(sourceDir, 'skill-one', 'SKILL.md'), 'name: skill-one');
  writeFileSync(join(sourceDir, 'skill-one', 'nested', '说明.txt'), 'unicode path content');

  const nativeSourceDir = join(repoRoot, 'src-tauri', 'native-scripts');
  mkdirSync(join(nativeSourceDir, 'web-search'), { recursive: true });
  writeFileSync(join(nativeSourceDir, 'web-search', 'ddgs_search.py'), 'print("ok")');

  const pythonRuntimeSourceDir = join(repoRoot, 'src-tauri', 'python-runtime');
  mkdirSync(pythonRuntimeSourceDir, { recursive: true });
  writeFileSync(join(pythonRuntimeSourceDir, 'python-runtime-v1.signature'), 'new-signature');
  writeFileSync(join(pythonRuntimeSourceDir, 'python-runtime-v1.zip'), 'new-runtime');

  const staleDestDir = join(repoRoot, 'src-tauri', 'target', 'debug', 'skills-bundle');
  mkdirSync(staleDestDir, { recursive: true });
  writeFileSync(join(staleDestDir, 'stale.txt'), 'old content');

  const staleNativeDestDir = join(repoRoot, 'src-tauri', 'target', 'debug', 'native-scripts');
  mkdirSync(staleNativeDestDir, { recursive: true });
  writeFileSync(join(staleNativeDestDir, 'stale.txt'), 'old content');

  const staleRuntimeDestDir = join(repoRoot, 'src-tauri', 'target', 'debug', 'python-runtime');
  mkdirSync(staleRuntimeDestDir, { recursive: true });
  writeFileSync(join(staleRuntimeDestDir, 'stale.txt'), 'old content');

  return repoRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('syncTauriDevResources', () => {
  it('syncs the skills bundle from a Unicode project path and replaces stale output', () => {
    const repoRoot = createRepoFixture();

    const result = syncTauriDevResources({ repoRoot });

    const syncedFile = join(
      repoRoot,
      'src-tauri',
      'target',
      'debug',
      'skills-bundle',
      'skill-one',
      'nested',
      '说明.txt'
    );
    const syncedNativeFile = join(
      repoRoot,
      'src-tauri',
      'target',
      'debug',
      'native-scripts',
      'web-search',
      'ddgs_search.py'
    );
    const syncedRuntimeSignature = join(
      repoRoot,
      'src-tauri',
      'target',
      'debug',
      'python-runtime',
      'python-runtime-v1.signature'
    );
    expect(result.destDir).toBe(join(repoRoot, 'src-tauri', 'target', 'debug', 'skills-bundle'));
    expect(readFileSync(syncedFile, 'utf8')).toBe('unicode path content');
    expect(readFileSync(syncedNativeFile, 'utf8')).toBe('print("ok")');
    expect(readFileSync(syncedRuntimeSignature, 'utf8')).toBe('new-signature');
    expect(existsSync(join(result.destDir, 'stale.txt'))).toBe(false);
    expect(
      existsSync(join(repoRoot, 'src-tauri', 'target', 'debug', 'native-scripts', 'stale.txt'))
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, 'src-tauri', 'target', 'debug', 'python-runtime', 'stale.txt'))
    ).toBe(false);
    expect(result.resources.map((resource) => resource.name)).toEqual([
      'skills-bundle',
      'native-scripts',
      'python-runtime',
    ]);
  });
});
