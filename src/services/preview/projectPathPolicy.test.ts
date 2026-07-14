/** Project preview lexical path-policy regression tests. */

import { describe, expect, it } from 'vitest';

import {
  normalizeProjectFile,
  normalizeProjectFiles,
  normalizeProjectRelativePath,
  ProjectPathValidationError,
} from './projectPathPolicy';

describe('normalizeProjectRelativePath', () => {
  it.each([
    ['index.html', 'index.html'],
    ['src\\App.tsx', 'src/App.tsx'],
    ['./src//nested/./main.js', 'src/nested/main.js'],
    ['assets///earth map.webp', 'assets/earth map.webp'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeProjectRelativePath(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'empty'],
    ['././', 'empty'],
    ['main\0.js', 'nul-byte'],
    ['/etc/passwd', 'absolute'],
    ['\\Windows\\system.ini', 'absolute'],
    ['\\\\server\\share\\secret.txt', 'absolute'],
    ['//server/share/secret.txt', 'absolute'],
    ['C:\\Windows\\system.ini', 'drive-qualified'],
    ['d:relative.txt', 'drive-qualified'],
    ['https://example.com/app.js', 'url'],
    [' file:///C:/secret.txt', 'url'],
    ['data:text/javascript,alert(1)', 'url'],
    ['../secret.txt', 'parent-segment'],
    ['src/../secret.txt', 'parent-segment'],
    ['src\\..\\secret.txt', 'parent-segment'],
    ['src//../secret.txt', 'parent-segment'],
    ['src/.. /secret.txt', 'parent-segment'],
    ['src/... /secret.txt', 'windows-ambiguous'],
    ['src/.../secret.txt', 'windows-ambiguous'],
    ['src/file.js.', 'windows-ambiguous'],
    ['src/file.js ', 'windows-ambiguous'],
    ['src/file.js:stream', 'windows-ambiguous'],
    ['src/CON.txt', 'windows-ambiguous'],
  ] as const)('rejects malicious or invalid path %j', (input, expectedCode) => {
    try {
      normalizeProjectRelativePath(input);
      expect.fail('expected path validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectPathValidationError);
      expect((error as ProjectPathValidationError).code).toBe(expectedCode);
      expect((error as ProjectPathValidationError).input).toBe(input);
    }
  });

  it('normalizes file copies without mutating caller-owned objects', () => {
    const original = { path: '.\\src\\main.ts', content: 'export {}' };

    const normalized = normalizeProjectFile(original);

    expect(normalized).toEqual({ path: 'src/main.ts', content: 'export {}' });
    expect(normalized).not.toBe(original);
    expect(original.path).toBe('.\\src\\main.ts');
  });

  it('normalizes a readonly file collection', () => {
    const files = [
      { path: './index.html', content: '<main />' },
      { path: 'src\\main.js', content: '' },
    ] as const;

    expect(normalizeProjectFiles(files).map((file) => file.path)).toEqual([
      'index.html',
      'src/main.js',
    ]);
  });
});
