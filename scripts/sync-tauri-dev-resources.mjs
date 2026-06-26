// Keep Tauri dev resource staging in sync with source resources.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const defaultRepoRoot = resolve(scriptDir, '..')

function copyEntrySync(sourcePath, destPath) {
  const stats = lstatSync(sourcePath)

  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), destPath)
    return
  }

  if (stats.isDirectory()) {
    mkdirSync(destPath, { recursive: true })
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      copyEntrySync(join(sourcePath, entry.name), join(destPath, entry.name))
    }
    return
  }

  if (stats.isFile()) {
    copyFileSync(sourcePath, destPath)
    chmodSync(destPath, stats.mode)
    return
  }

  throw new Error(`Unsupported Tauri dev resource entry type: ${sourcePath}`)
}

export function copyDirectorySync(sourceDir, destDir) {
  copyEntrySync(sourceDir, destDir)
}

export function syncTauriDevResources({ repoRoot = defaultRepoRoot } = {}) {
  const sourceDir = join(repoRoot, 'src-tauri', 'skills-bundle')
  const targetRoot = join(repoRoot, 'src-tauri', 'target', 'debug')
  const destDir = join(targetRoot, 'skills-bundle')

  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`Source skills bundle was not found: ${sourceDir}`)
  }

  const resolvedTargetRoot = resolve(targetRoot)
  const resolvedDestDir = resolve(destDir)
  const relativeDest = relative(resolvedTargetRoot, resolvedDestDir)

  if (
    basename(resolvedDestDir) !== 'skills-bundle' ||
    relativeDest === '' ||
    relativeDest.startsWith('..') ||
    isAbsolute(relativeDest)
  ) {
    throw new Error(`Refusing to replace unexpected Tauri dev resource path: ${resolvedDestDir}`)
  }

  mkdirSync(resolvedTargetRoot, { recursive: true })
  rmSync(resolvedDestDir, { recursive: true, force: true })
  copyDirectorySync(sourceDir, resolvedDestDir)

  return {
    sourceDir,
    targetRoot: resolvedTargetRoot,
    destDir: resolvedDestDir,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { sourceDir, destDir } = syncTauriDevResources()

  console.log(`Synced Tauri dev resource: ${sourceDir} -> ${destDir}`)
}
