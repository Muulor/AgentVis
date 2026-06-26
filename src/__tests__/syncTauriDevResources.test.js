import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { syncTauriDevResources } from '../../scripts/sync-tauri-dev-resources.mjs'

const tempRoots = []

function createRepoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'AgentVis-中文路径-'))
  tempRoots.push(repoRoot)

  const sourceDir = join(repoRoot, 'src-tauri', 'skills-bundle')
  mkdirSync(join(sourceDir, 'skill-one', 'nested'), { recursive: true })
  writeFileSync(join(sourceDir, 'skill-one', 'SKILL.md'), 'name: skill-one')
  writeFileSync(join(sourceDir, 'skill-one', 'nested', '说明.txt'), 'unicode path content')

  const staleDestDir = join(repoRoot, 'src-tauri', 'target', 'debug', 'skills-bundle')
  mkdirSync(staleDestDir, { recursive: true })
  writeFileSync(join(staleDestDir, 'stale.txt'), 'old content')

  return repoRoot
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('syncTauriDevResources', () => {
  it('syncs the skills bundle from a Unicode project path and replaces stale output', () => {
    const repoRoot = createRepoFixture()

    const result = syncTauriDevResources({ repoRoot })

    const syncedFile = join(
      repoRoot,
      'src-tauri',
      'target',
      'debug',
      'skills-bundle',
      'skill-one',
      'nested',
      '说明.txt',
    )
    expect(result.destDir).toBe(join(repoRoot, 'src-tauri', 'target', 'debug', 'skills-bundle'))
    expect(readFileSync(syncedFile, 'utf8')).toBe('unicode path content')
    expect(existsSync(join(result.destDir, 'stale.txt'))).toBe(false)
  })
})
