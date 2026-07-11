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
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const defaultRepoRoot = resolve(scriptDir, '..');

function copyEntrySync(sourcePath, destPath) {
  const stats = lstatSync(sourcePath);

  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), destPath);
    return;
  }

  if (stats.isDirectory()) {
    mkdirSync(destPath, { recursive: true });
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      copyEntrySync(join(sourcePath, entry.name), join(destPath, entry.name));
    }
    return;
  }

  if (stats.isFile()) {
    copyFileSync(sourcePath, destPath);
    chmodSync(destPath, stats.mode);
    return;
  }

  throw new Error(`Unsupported Tauri dev resource entry type: ${sourcePath}`);
}

export function copyDirectorySync(sourceDir, destDir) {
  copyEntrySync(sourceDir, destDir);
}

export function syncTauriDevResources({ repoRoot = defaultRepoRoot } = {}) {
  const resources = [
    {
      name: 'skills-bundle',
      sourceDir: join(repoRoot, 'src-tauri', 'skills-bundle'),
    },
    {
      name: 'native-scripts',
      sourceDir: join(repoRoot, 'src-tauri', 'native-scripts'),
    },
    {
      name: 'python-runtime',
      sourceDir: join(repoRoot, 'src-tauri', 'python-runtime'),
    },
  ];
  const targetRoot = join(repoRoot, 'src-tauri', 'target', 'debug');

  const syncedResources = [];

  for (const resource of resources) {
    const { name, sourceDir } = resource;
    const destDir = join(targetRoot, name);

    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      throw new Error(`Source Tauri dev resource was not found: ${sourceDir}`);
    }

    const resolvedTargetRoot = resolve(targetRoot);
    const resolvedDestDir = resolve(destDir);
    const relativeDest = relative(resolvedTargetRoot, resolvedDestDir);

    if (
      basename(resolvedDestDir) !== name ||
      relativeDest === '' ||
      relativeDest.startsWith('..') ||
      isAbsolute(relativeDest)
    ) {
      throw new Error(`Refusing to replace unexpected Tauri dev resource path: ${resolvedDestDir}`);
    }

    mkdirSync(resolvedTargetRoot, { recursive: true });
    rmSync(resolvedDestDir, { recursive: true, force: true });
    copyDirectorySync(sourceDir, resolvedDestDir);
    syncedResources.push({
      name,
      sourceDir,
      destDir: resolvedDestDir,
    });
  }

  return {
    sourceDir: syncedResources[0].sourceDir,
    targetRoot: resolve(targetRoot),
    destDir: syncedResources[0].destDir,
    resources: syncedResources,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { resources } = syncTauriDevResources();

  for (const { sourceDir, destDir } of resources) {
    console.log(`Synced Tauri dev resource: ${sourceDir} -> ${destDir}`);
  }
}
