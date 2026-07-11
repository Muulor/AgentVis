// Prepare helper binary resources for Tauri packaging.
// The historical script name is kept because package.json and docs already refer to it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const profile = process.argv[2] === 'debug' ? 'debug' : 'release';
const destDir = join(repoRoot, 'src-tauri', 'broker-bin');
const helperSpecs = [
  {
    label: 'broker helper',
    name: process.platform === 'win32' ? 'agentvis-broker-fetch.exe' : 'agentvis-broker-fetch',
    staleNames: ['agentvis-broker-fetch', 'agentvis-broker-fetch.exe'],
  },
  {
    label: 'WFP helper',
    name: process.platform === 'win32' ? 'agentvis_wfp_helper.exe' : 'agentvis_wfp_helper',
    staleNames: ['agentvis_wfp_helper', 'agentvis_wfp_helper.exe'],
  },
];

mkdirSync(destDir, { recursive: true });

for (const helper of helperSpecs) {
  const source = join(repoRoot, 'src-tauri', 'target', profile, helper.name);
  const dest = join(destDir, helper.name);

  if (!existsSync(source)) {
    throw new Error(`${helper.label} build artifact was not found: ${source}`);
  }

  for (const staleName of helper.staleNames) {
    const stalePath = join(destDir, staleName);
    if (stalePath !== dest && existsSync(stalePath)) {
      rmSync(stalePath);
    }
  }

  const mode = statSync(source).mode;
  try {
    copyFileSync(source, dest);
    if (process.platform !== 'win32') {
      // Preserve executable bits on Unix-like platforms; harmless if the filesystem ignores it.
      chmodSync(dest, mode);
    }
  } catch (error) {
    throw new Error(`Failed to prepare ${helper.label} resource: ${error.message}`);
  }

  console.log(`Prepared ${helper.label} resource: ${dest}`);
}
