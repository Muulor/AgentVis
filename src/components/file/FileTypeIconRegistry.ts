/**
 * FileTypeIconRegistry - 文件类型图标映射表
 *
 * 精确文件名优先于扩展名，未命中时复用中央 FileTypeRegistry 的文件家族降级。
 */

import { getFileExtension, getFileFamily, getFileName } from '@services/file-types';

export type FileIconTone =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'neutral'
  | 'orange'
  | 'purple'
  | 'red'
  | 'yellow';
export type FileIconVisual =
  | 'atom'
  | 'braces'
  | 'codeXml'
  | 'cog'
  | 'database'
  | 'file'
  | 'fileText'
  | 'folder'
  | 'hash'
  | 'image'
  | 'settings'
  | 'terminal'
  | 'vite'
  | 'vue'
  | 'badge';

export interface FileTypeIconDescriptor {
  visual: FileIconVisual;
  tone: FileIconTone;
  label?: string;
}

const badge = (label: string, tone: FileIconTone): FileTypeIconDescriptor => ({
  visual: 'badge',
  tone,
  label,
});

const EXTENSION_ICON_MAP: Record<string, FileTypeIconDescriptor> = {
  ts: badge('TS', 'blue'),
  mts: badge('TS', 'blue'),
  cts: badge('TS', 'blue'),
  js: badge('JS', 'yellow'),
  mjs: badge('JS', 'yellow'),
  cjs: badge('JS', 'yellow'),
  tsx: { visual: 'atom', tone: 'cyan' },
  jsx: { visual: 'atom', tone: 'cyan' },
  py: badge('PY', 'blue'),
  pyw: badge('PY', 'blue'),
  rs: { visual: 'cog', tone: 'orange' },
  go: badge('GO', 'cyan'),
  java: badge('JV', 'red'),
  kt: badge('KT', 'purple'),
  kts: badge('KT', 'purple'),
  c: badge('C', 'blue'),
  h: badge('H', 'purple'),
  cc: badge('C++', 'blue'),
  cpp: badge('C++', 'blue'),
  cxx: badge('C++', 'blue'),
  hpp: badge('H++', 'purple'),
  hxx: badge('H++', 'purple'),
  cs: badge('C#', 'purple'),
  fs: badge('FS', 'blue'),
  fsx: badge('FS', 'blue'),
  vb: badge('VB', 'blue'),
  php: badge('PHP', 'purple'),
  rb: badge('RB', 'red'),
  swift: badge('SW', 'orange'),
  dart: badge('DT', 'cyan'),
  scala: badge('SC', 'red'),
  r: badge('R', 'blue'),
  lua: badge('LUA', 'blue'),
  clj: badge('CLJ', 'green'),
  cljs: badge('CLJ', 'green'),
  ex: badge('EX', 'purple'),
  exs: badge('EX', 'purple'),
  erl: badge('ERL', 'red'),
  hrl: badge('ERL', 'red'),
  sol: badge('SOL', 'purple'),
  html: { visual: 'codeXml', tone: 'red' },
  htm: { visual: 'codeXml', tone: 'red' },
  xml: { visual: 'codeXml', tone: 'orange' },
  vue: { visual: 'vue', tone: 'green' },
  svelte: badge('S', 'orange'),
  astro: badge('A', 'purple'),
  css: { visual: 'hash', tone: 'blue' },
  scss: { visual: 'hash', tone: 'red' },
  sass: { visual: 'hash', tone: 'red' },
  less: { visual: 'hash', tone: 'blue' },
  json: { visual: 'braces', tone: 'yellow' },
  json5: { visual: 'braces', tone: 'yellow' },
  jsonc: { visual: 'braces', tone: 'yellow' },
  jsonl: { visual: 'braces', tone: 'yellow' },
  yaml: badge('YML', 'red'),
  yml: badge('YML', 'red'),
  toml: badge('TOML', 'orange'),
  sql: { visual: 'database', tone: 'cyan' },
  graphql: { visual: 'braces', tone: 'purple' },
  gql: { visual: 'braces', tone: 'purple' },
  prisma: { visual: 'database', tone: 'purple' },
  proto: badge('PB', 'green'),
  sh: { visual: 'terminal', tone: 'green' },
  bash: { visual: 'terminal', tone: 'green' },
  zsh: { visual: 'terminal', tone: 'green' },
  fish: { visual: 'terminal', tone: 'green' },
  ps1: { visual: 'terminal', tone: 'blue' },
  bat: { visual: 'terminal', tone: 'neutral' },
  cmd: { visual: 'terminal', tone: 'neutral' },
  tf: badge('TF', 'purple'),
  tfvars: badge('TF', 'purple'),
  hcl: badge('HCL', 'purple'),
  md: { visual: 'fileText', tone: 'blue' },
  markdown: { visual: 'fileText', tone: 'blue' },
  mdx: { visual: 'fileText', tone: 'cyan' },
};

const EXACT_FILE_ICON_MAP: Record<string, FileTypeIconDescriptor> = {
  'package.json': badge('NPM', 'red'),
  'package-lock.json': badge('NPM', 'red'),
  'cargo.toml': { visual: 'cog', tone: 'orange' },
  'cargo.lock': { visual: 'cog', tone: 'orange' },
  'go.mod': badge('GO', 'cyan'),
  'go.sum': badge('GO', 'cyan'),
  'pyproject.toml': badge('PY', 'blue'),
  pipfile: badge('PY', 'blue'),
  dockerfile: badge('DK', 'blue'),
  makefile: badge('MK', 'orange'),
  gnumakefile: badge('MK', 'orange'),
  'cmakelists.txt': badge('CM', 'blue'),
};

function getExactFileIcon(fileName: string): FileTypeIconDescriptor | undefined {
  const normalized = getFileName(fileName).toLowerCase();
  const exact = EXACT_FILE_ICON_MAP[normalized];
  if (exact) return exact;

  if (/^tsconfig(?:\..+)?\.json$/.test(normalized)) return badge('TS', 'blue');
  if (/^(?:vite|vitest)\.config\./.test(normalized)) return { visual: 'vite', tone: 'yellow' };
  if (/^requirements(?:-.+)?\.txt$/.test(normalized)) return badge('PY', 'blue');
  if (/^\.env(?:\..+)?$/.test(normalized)) return { visual: 'settings', tone: 'yellow' };
  if (/^\.git(?:ignore|attributes|modules)$/.test(normalized)) return badge('GIT', 'orange');

  return undefined;
}

export function resolveFileTypeIcon(fileName: string, isDirectory = false): FileTypeIconDescriptor {
  if (isDirectory) return { visual: 'folder', tone: 'yellow' };

  const exact = getExactFileIcon(fileName);
  if (exact) return exact;

  const extensionIcon = EXTENSION_ICON_MAP[getFileExtension(fileName)];
  if (extensionIcon) return extensionIcon;

  switch (getFileFamily(fileName)) {
    case 'code':
      return { visual: 'codeXml', tone: 'green' };
    case 'config':
      return { visual: 'settings', tone: 'yellow' };
    case 'image':
      return { visual: 'image', tone: 'purple' };
    case 'markdown':
    case 'office':
    case 'pdf':
    case 'text':
      return { visual: 'fileText', tone: 'blue' };
    case 'data':
      return { visual: 'database', tone: 'cyan' };
    default:
      return { visual: 'file', tone: 'neutral' };
  }
}
