/**
 * Project Preview staging plan.
 *
 * Complete projects keep their own entry graph and supported toolchain
 * configuration. Small code snippets may borrow the selected template's entry
 * scaffold, but never a template sibling that would shadow a supplied module.
 */

import type { ProjectFile, TemplateConfig, TemplateId } from './types';
import { analyzeHtmlImports } from './importMapAnalysis';
import { normalizeProjectRelativePath } from './projectPathPolicy';

const ENTRY_FILE_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/main.ts',
  'src/main.js',
  'main.tsx',
  'main.jsx',
  'main.ts',
  'main.js',
] as const;

const PROJECT_VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const;

const PROJECT_POSTCSS_CONFIG_CANDIDATES = [
  'postcss.config.ts',
  'postcss.config.mts',
  'postcss.config.cts',
  'postcss.config.js',
  'postcss.config.mjs',
  'postcss.config.cjs',
] as const;

export interface PreviewProjectPlan {
  stagedFiles: Map<string, string>;
  indexHtmlPath: string | null;
  validationPaths: string[];
  projectViteConfigPath: string | null;
  usesProjectCssConfig: boolean;
}

export interface PreviewProjectEntryAnalysis {
  providedEntryPath: string | null;
  providedIndex: ProjectFile | null;
  projectViteConfigPath: string | null;
  rootHtmlFiles: readonly ProjectFile[];
  standaloneHtmlEntry: ProjectFile | null;
  nestedProjectRoots: readonly string[];
}

const MODULE_RESOLUTION_SUFFIXES = [
  '',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '/index.js',
  '/index.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.vue',
] as const;
const VALIDATION_ORIGIN = 'https://agentvis-preview.invalid';

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function detectFile(
  filesByLowerPath: ReadonlyMap<string, ProjectFile>,
  candidates: readonly string[]
): string | null {
  for (const candidate of candidates) {
    const file = filesByLowerPath.get(candidate);
    if (file) return file.path;
  }
  return null;
}

function extensionlessPath(path: string): string {
  return path.replace(/\.[^./]+$/u, '').toLowerCase();
}

function getParentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function findNestedProjectRoots(files: readonly ProjectFile[]): string[] {
  const packageRoots = files
    .filter((file) => /(?:^|\/)package\.json$/i.test(file.path) && file.path.includes('/'))
    .map((file) => getParentPath(file.path));
  const roots = new Set<string>();

  for (const file of files) {
    if (!/(?:^|\/)index\.html$/i.test(file.path) || !file.path.includes('/')) continue;
    const htmlRoot = getParentPath(file.path);
    const packageRoot = packageRoots
      .filter((candidate) => htmlRoot === candidate || htmlRoot.startsWith(`${candidate}/`))
      .sort((left, right) => right.length - left.length)[0];
    roots.add(packageRoot ?? htmlRoot);
  }

  for (const file of files) {
    if (!/(?:^|\/)vite\.config\.(?:[cm]?[jt]s)$/i.test(file.path) || !file.path.includes('/')) {
      continue;
    }
    roots.add(getParentPath(file.path));
  }

  return [...roots].sort();
}

/** Resolve entry facts once so preflight routing and workspace materialization agree. */
export function analyzePreviewProjectEntry(
  files: readonly ProjectFile[]
): PreviewProjectEntryAnalysis {
  const filesByLowerPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const providedIndex = filesByLowerPath.get('index.html') ?? null;
  const rootHtmlFiles = files.filter(
    (file) => !file.path.includes('/') && file.path.toLowerCase().endsWith('.html')
  );

  return {
    providedEntryPath: detectFile(filesByLowerPath, ENTRY_FILE_CANDIDATES),
    providedIndex,
    projectViteConfigPath: detectFile(filesByLowerPath, PROJECT_VITE_CONFIG_CANDIDATES),
    rootHtmlFiles,
    standaloneHtmlEntry:
      providedIndex === null && rootHtmlFiles.length === 1 ? (rootHtmlFiles[0] ?? null) : null,
    nestedProjectRoots: findNestedProjectRoots(files),
  };
}

function generateIndexHtml(entryFilePath: string, templateId: TemplateId): string {
  const rootId = templateId === 'vue-tailwind' ? 'app' : 'root';
  const entry = escapeHtmlAttribute(entryFilePath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Preview</title>
</head>
<body>
  <div id="${rootId}"></div>
  <script type="module" src="/${entry}"></script>
</body>
</html>`;
}

function buildEntryValidationPaths(
  stagedFiles: ReadonlyMap<string, string>,
  indexHtmlPath: string | null
): string[] {
  if (!indexHtmlPath) return [];
  const indexHtml = stagedFiles.get(indexHtmlPath);
  if (!indexHtml) return [];

  const analysis = analyzeHtmlImports(indexHtml);
  const filesByLowerPath = new Map(
    [...stagedFiles.keys()].map((path) => [path.toLowerCase(), path])
  );
  let documentBase: URL;
  try {
    documentBase = new URL(analysis.baseHref ?? '/', VALIDATION_ORIGIN);
  } catch {
    return [];
  }

  const paths = new Set<string>();
  for (const entry of analysis.moduleEntries) {
    try {
      const url = new URL(entry, documentBase);
      if (url.origin !== VALIDATION_ORIGIN) continue;
      const normalized = normalizeProjectRelativePath(
        decodeURIComponent(url.pathname).replace(/^\/+/u, '')
      );
      for (const suffix of MODULE_RESOLUTION_SUFFIXES) {
        const resolved = filesByLowerPath.get(`${normalized}${suffix}`.toLowerCase());
        if (!resolved) continue;
        paths.add(resolved);
        break;
      }
    } catch {
      // Root HTML still goes through Vite/static validation and reports malformed URLs.
    }
  }
  return [...paths];
}

/** Build a deterministic file plan before any staging workspace is mutated. */
export function buildPreviewProjectPlan(
  files: readonly ProjectFile[],
  templateConfig: TemplateConfig,
  mode: 'static' | 'vite',
  completeProject: boolean
): PreviewProjectPlan {
  const filesByLowerPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const suppliedStems = new Set(files.map((file) => extensionlessPath(file.path)));
  const entryAnalysis = analyzePreviewProjectEntry(files);
  const providedEntry = entryAnalysis.providedEntryPath;
  const providedIndex = entryAnalysis.providedIndex !== null;
  const standaloneHtmlEntry = completeProject ? entryAnalysis.standaloneHtmlEntry : null;
  const stagedFiles = new Map<string, string>();

  const mayUseTemplateScaffold =
    mode === 'vite' && !completeProject && !providedIndex && !providedEntry;
  if (mayUseTemplateScaffold) {
    for (const [path, content] of Object.entries(templateConfig.entryFiles)) {
      if (filesByLowerPath.has(path.toLowerCase())) continue;
      if (suppliedStems.has(extensionlessPath(path))) continue;
      stagedFiles.set(path, content);
    }
  }

  if (standaloneHtmlEntry) {
    // Project Preview is directory-oriented, but a single named HTML deliverable is
    // still an unambiguous project entry. Keep the original file for its own links
    // and mirror it to the server root so the Preview action behaves like Live Preview.
    stagedFiles.set('index.html', standaloneHtmlEntry.content);
  } else if (mode === 'vite' && providedEntry && !providedIndex) {
    stagedFiles.set('index.html', generateIndexHtml(providedEntry, templateConfig.id));
  }

  for (const file of files) stagedFiles.set(file.path, file.content);

  const indexHtmlPath =
    [...stagedFiles.keys()].find((path) => path.toLowerCase() === 'index.html') ?? null;

  const projectViteConfigPath = completeProject ? entryAnalysis.projectViteConfigPath : null;
  const projectPostcssConfigPath = completeProject
    ? detectFile(filesByLowerPath, PROJECT_POSTCSS_CONFIG_CANDIDATES)
    : null;

  return {
    stagedFiles,
    indexHtmlPath,
    validationPaths: buildEntryValidationPaths(stagedFiles, indexHtmlPath),
    projectViteConfigPath,
    usesProjectCssConfig: projectViteConfigPath !== null || projectPostcssConfigPath !== null,
  };
}
