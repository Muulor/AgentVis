/**
 * 三档沙箱文件边界校验。
 *
 * 离线隔离模式下，Agent 文件工具只能访问授权工作区根目录。
 * 受控联网模式可通过 context.sandboxFilesystemScope 切换为本机文件空间。
 */
import type { ToolExecutionContext } from '../../tools/types';

export interface SandboxPathViolation {
  path: string;
  root: string;
  mode: 'OfflineIsolated' | 'ControlledNetwork';
  reason: 'missingWorkdir' | 'outsideWorkdir';
}

export function getSandboxPathViolation(
  path: string,
  context: ToolExecutionContext
): SandboxPathViolation | null {
  const mode = getWorkspaceBoundedSandboxMode(context);
  if (!mode) {
    return null;
  }

  const roots = getSandboxRoots(context);
  if (roots.length === 0) {
    return {
      path,
      root: '',
      mode,
      reason: 'missingWorkdir',
    };
  }

  const normalizedPath = normalizePathForCompare(path);
  const normalizedRoots = roots.map((root) => normalizePathForCompare(root));
  if (
    normalizedRoots.some((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`))
  ) {
    return null;
  }

  return {
    path,
    root: roots[0] ?? '',
    mode,
    reason: 'outsideWorkdir',
  };
}

export function isSandboxPathAllowed(path: string, context: ToolExecutionContext): boolean {
  return getSandboxPathViolation(path, context) === null;
}

function getWorkspaceBoundedSandboxMode(
  context: ToolExecutionContext
): SandboxPathViolation['mode'] | null {
  const mode = context.sandboxMode;
  if (mode === 'OfflineIsolated') {
    return mode;
  }
  if (mode === 'ControlledNetwork' && context.sandboxFilesystemScope !== 'local') {
    return mode;
  }
  return null;
}

function normalizePathForCompare(path: string): string {
  const unified = path
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/');
  const hasDrive = /^[a-zA-Z]:\//.test(unified);
  const hasUnc = unified.startsWith('//');
  const prefix = hasDrive
    ? unified.slice(0, 2).toLowerCase()
    : hasUnc
      ? '//'
      : unified.startsWith('/')
        ? '/'
        : '';

  const rest = hasDrive
    ? unified.slice(3)
    : hasUnc
      ? unified.slice(2)
      : unified.replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const joined = parts.join('/');
  const normalized =
    prefix === '/' || prefix === '//'
      ? `${prefix}${joined}`.replace(/\/+$/, '')
      : prefix
        ? `${prefix}/${joined}`.replace(/\/+$/, '')
        : joined;
  return normalized.toLowerCase();
}

function getSandboxRoots(context: ToolExecutionContext): string[] {
  const roots = context.sandboxRoots?.length
    ? context.sandboxRoots
    : context.workdir
      ? [context.workdir]
      : [];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = normalizePathForCompare(root);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}
