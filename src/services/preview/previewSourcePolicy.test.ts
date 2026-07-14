/** Project Preview source-budget regression tests. */

import { describe, expect, it } from 'vitest';

import {
  enforcePreviewSourceBudgets,
  getPreviewSourceByteLength,
  isSafePreviewSourcePath,
  MAX_PREVIEW_SOURCE_FILES,
  MAX_PREVIEW_SOURCE_FILE_BYTES,
  MAX_PREVIEW_SOURCE_TOTAL_BYTES,
} from './previewSourcePolicy';

function expectBudgetFailure(action: () => void, detail: string): void {
  try {
    action();
    throw new Error('Expected source budget enforcement to fail');
  } catch (error) {
    expect(error).toMatchObject({ code: 'asset-budget-exceeded', detail });
  }
}

describe('previewSourcePolicy', () => {
  it.each([
    'eslint.config.js',
    '.eslintrc.cjs',
    'tailwind.config.js',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'package-lock.json',
    'dist/main.js',
  ])('keeps toolchain or reserved input out of staged runtime source: %s', (path) => {
    expect(isSafePreviewSourcePath(path)).toBe(false);
  });

  it.each([
    'vite.config.ts',
    'postcss.config.mjs',
    'tailwind.config.cjs',
    'tsconfig.json',
    'tsconfig.node.json',
    'jsconfig.json',
  ])('retains a complete project preview toolchain file: %s', (path) => {
    expect(isSafePreviewSourcePath(path, { allowProjectToolchainConfig: true })).toBe(true);
  });

  it.each(['eslint.config.js', 'playwright.config.ts', 'package.json', 'package-lock.json'])(
    'still rejects unrelated or separately parsed metadata in complete-project mode: %s',
    (path) => {
      expect(isSafePreviewSourcePath(path, { allowProjectToolchainConfig: true })).toBe(false);
    }
  );

  it.each([
    'index.html',
    'src/main.tsx',
    'src/config.ts',
    'src/eslint.config.js',
    'src/vite.config.ts',
  ])('keeps ordinary project source: %s', (path) => {
    expect(isSafePreviewSourcePath(path)).toBe(true);
  });

  it('measures UTF-8 bytes rather than UTF-16 code units', () => {
    expect(getPreviewSourceByteLength('地球')).toBe(6);
  });

  it('rejects source collections above the file-count budget', () => {
    const files = Array.from({ length: MAX_PREVIEW_SOURCE_FILES + 1 }, (_, index) => ({
      path: `${index}.js`,
      content: '',
    }));

    expectBudgetFailure(() => enforcePreviewSourceBudgets(files), 'source-file-count');
  });

  it('rejects one oversized source file', () => {
    expectBudgetFailure(
      () =>
        enforcePreviewSourceBudgets([
          { path: 'large.js', content: 'a'.repeat(MAX_PREVIEW_SOURCE_FILE_BYTES + 1) },
        ]),
      'source-file: large.js'
    );
  });

  it('rejects source collections above the aggregate byte budget', () => {
    const content = 'a'.repeat(MAX_PREVIEW_SOURCE_FILE_BYTES);
    const files = Array.from(
      { length: MAX_PREVIEW_SOURCE_TOTAL_BYTES / MAX_PREVIEW_SOURCE_FILE_BYTES + 1 },
      (_, index) => ({ path: `${index}.js`, content })
    );

    expectBudgetFailure(() => enforcePreviewSourceBudgets(files), 'source-total');
  });
});
