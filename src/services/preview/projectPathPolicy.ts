/**
 * Project preview path policy.
 *
 * Normalizes untrusted Agent-generated file paths before they are joined to a
 * preview workspace. This is a lexical boundary; filesystem callers must still
 * perform a canonical containment check after resolving links on disk.
 */

import type { ProjectFile } from './types';

export type ProjectPathValidationErrorCode =
  | 'empty'
  | 'nul-byte'
  | 'absolute'
  | 'drive-qualified'
  | 'url'
  | 'parent-segment'
  | 'windows-ambiguous';

/** Stable validation error that callers can translate at the UI boundary. */
export class ProjectPathValidationError extends Error {
  constructor(
    public readonly code: ProjectPathValidationErrorCode,
    public readonly input: string
  ) {
    super(`Invalid project path (${code})`);
    this.name = 'ProjectPathValidationError';
  }
}

const DRIVE_QUALIFIED_PATH = /^[a-z]:/i;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Return a canonical, slash-separated project-relative file path.
 *
 * Empty paths, URLs, rooted paths, drive-qualified paths, NUL bytes, and every
 * explicit parent (`..`) segment are rejected instead of being normalized away.
 */
export function normalizeProjectRelativePath(input: string): string {
  if (input.trim().length === 0) {
    throw new ProjectPathValidationError('empty', input);
  }

  if (input.includes('\0')) {
    throw new ProjectPathValidationError('nul-byte', input);
  }

  const pathForClassification = input.trim();
  if (DRIVE_QUALIFIED_PATH.test(pathForClassification)) {
    throw new ProjectPathValidationError('drive-qualified', input);
  }
  if (URL_SCHEME.test(pathForClassification)) {
    throw new ProjectPathValidationError('url', input);
  }

  const slashSeparated = input.replaceAll('\\', '/');
  if (slashSeparated.startsWith('/')) {
    throw new ProjectPathValidationError('absolute', input);
  }

  const segments = slashSeparated.split('/');
  if (segments.some((segment) => segment.trimEnd() === '..')) {
    throw new ProjectPathValidationError('parent-segment', input);
  }

  if (
    segments.some(
      (segment) =>
        segment !== '.' &&
        (segment.includes(':') ||
          /[. ]$/u.test(segment) ||
          WINDOWS_RESERVED_FILE_NAME.test(segment))
    )
  ) {
    throw new ProjectPathValidationError('windows-ambiguous', input);
  }

  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (normalized.length === 0) {
    throw new ProjectPathValidationError('empty', input);
  }

  return normalized;
}

/** Return a normalized copy without mutating the caller's file object. */
export function normalizeProjectFile(file: ProjectFile): ProjectFile {
  return {
    ...file,
    path: normalizeProjectRelativePath(file.path),
  };
}

/** Normalize a collection of untrusted project files. */
export function normalizeProjectFiles(files: readonly ProjectFile[]): ProjectFile[] {
  return files.map(normalizeProjectFile);
}
