/** Project Preview dependency-policy regression tests. */

import { describe, expect, it } from 'vitest';

import { PreviewServiceError } from './previewErrors';
import {
  buildPreviewPackageJson,
  getDeclaredPackageNames,
  getExtraDependencies,
  getUnsupportedPreviewBuildTool,
  MAX_PREVIEW_DEPENDENCY_COUNT,
  MAX_PREVIEW_PACKAGE_JSON_BYTES,
  MAX_PREVIEW_PACKAGE_NAME_LENGTH,
  MAX_PREVIEW_VERSION_SPECIFIER_LENGTH,
  parsePreviewDependencies,
  type PreviewDependencies,
} from './previewDependencyPolicy';
import type { TemplateConfig } from './types';

const template: TemplateConfig = {
  id: 'react-tailwind',
  displayName: 'React + Tailwind',
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
  },
  devDependencies: {
    vite: '^6.0.0',
  },
  configFiles: {},
  entryFiles: {},
};

function expectInvalidPackageSource(source: string): void {
  try {
    parsePreviewDependencies(source);
    expect.fail('expected dependency validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewServiceError);
    expect((error as PreviewServiceError).code).toBe('invalid-package');
  }
}

function expectInvalidManifest(manifest: unknown): void {
  expectInvalidPackageSource(JSON.stringify(manifest));
}

describe('parsePreviewDependencies', () => {
  it('accepts registry versions, ranges, tags, and scoped package names', () => {
    const parsed = parsePreviewDependencies(
      JSON.stringify({
        dependencies: {
          '@scope/orbit-kit': '^2.1.0 || ^3.0.0',
          three: '~0.180.0',
          zustand: 'latest',
        },
        devDependencies: {
          vite: '>=6.0.0 <7.0.0',
          vitest: 'beta',
        },
      })
    );

    expect(parsed).toEqual({
      dependencies: {
        '@scope/orbit-kit': '^2.1.0 || ^3.0.0',
        three: '~0.180.0',
        zustand: 'latest',
      },
      devDependencies: {
        vite: '>=6.0.0 <7.0.0',
        vitest: 'beta',
      },
    });
    expect(getDeclaredPackageNames(parsed)).toEqual(
      new Set(['@scope/orbit-kit', 'three', 'zustand', 'vite', 'vitest'])
    );
  });

  it('returns independent empty records when no manifest is present', () => {
    const parsed = parsePreviewDependencies();

    expect(parsed).toEqual({ dependencies: {}, devDependencies: {} });
    expect(parsed.dependencies).not.toBe(parsed.devDependencies);
  });

  it.each(['module', 'commonjs'] as const)('preserves the project package type %s', (type) => {
    expect(parsePreviewDependencies(JSON.stringify({ type }))).toEqual({
      dependencies: {},
      devDependencies: {},
      packageType: type,
    });
  });

  it.each([
    'file:../payload',
    'link:../payload',
    'workspace:*',
    'git+https://example.test/repository.git',
    'git:example/repository',
    'https://example.test/package.tgz',
    'http://example.test/package.tgz',
    'github:owner/repository',
    'npm:aliased-package@1.0.0',
    '../payload',
    './payload',
    '/absolute/payload',
    'C:\\payload',
    '\\\\server\\share\\payload',
  ])('rejects non-registry dependency specifier %j', (specifier) => {
    try {
      parsePreviewDependencies(JSON.stringify({ dependencies: { unsafe: specifier } }));
      expect.fail('expected non-registry dependency validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewServiceError);
      expect((error as PreviewServiceError).code).toBe('unsupported-project');
    }
  });

  it.each([
    'owner/repository',
    '@scope',
    '@scope/pkg/subpath',
    '.hidden',
    'contains space',
    'https://example.test/name',
  ])('rejects invalid dependency name %j', (name) => {
    expectInvalidManifest({ dependencies: { [name]: '1.0.0' } });
  });

  it.each([
    '{',
    '[]',
    'null',
    '{"dependencies":[]}',
    '{"devDependencies":"vite"}',
    '{"dependencies":{"react":7}}',
  ])('rejects malformed manifest content %j', (manifest) => {
    expect(() => parsePreviewDependencies(manifest)).toThrow(PreviewServiceError);
  });

  it('enforces the package.json UTF-8 byte budget', () => {
    const atLimit = '{}'.padEnd(MAX_PREVIEW_PACKAGE_JSON_BYTES, ' ');
    expect(parsePreviewDependencies(atLimit)).toEqual({ dependencies: {}, devDependencies: {} });

    expectInvalidPackageSource(`${atLimit} `);

    const multibyteManifest = JSON.stringify({
      description: '界'.repeat(Math.ceil(MAX_PREVIEW_PACKAGE_JSON_BYTES / 3)),
    });
    expect(multibyteManifest.length).toBeLessThan(MAX_PREVIEW_PACKAGE_JSON_BYTES);
    expectInvalidPackageSource(multibyteManifest);
  });

  it('accepts the combined dependency-count boundary', () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: MAX_PREVIEW_DEPENDENCY_COUNT / 2 }, (_, index) => [
        `package-${index}`,
        '1.0.0',
      ])
    );
    const devDependencies = Object.fromEntries(
      Array.from({ length: MAX_PREVIEW_DEPENDENCY_COUNT / 2 }, (_, index) => [
        `dev-package-${index}`,
        '1.0.0',
      ])
    );

    const parsed = parsePreviewDependencies(JSON.stringify({ dependencies, devDependencies }));
    expect(getDeclaredPackageNames(parsed).size).toBe(MAX_PREVIEW_DEPENDENCY_COUNT);
  });

  it('rejects more than the combined dependency-count budget', () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: MAX_PREVIEW_DEPENDENCY_COUNT }, (_, index) => [
        `package-${index}`,
        '1.0.0',
      ])
    );

    expectInvalidManifest({
      dependencies,
      devDependencies: { overflow: '1.0.0' },
    });
  });

  it('enforces package-name and version-specifier length boundaries', () => {
    const maximumName = `p${'a'.repeat(MAX_PREVIEW_PACKAGE_NAME_LENGTH - 1)}`;
    const maximumSpecifier = '1'.repeat(MAX_PREVIEW_VERSION_SPECIFIER_LENGTH);

    expectInvalidManifest({
      dependencies: { [`${maximumName}a`]: '1.0.0' },
    });
    expectInvalidManifest({
      dependencies: { valid: `${maximumSpecifier}1` },
    });
    expect(
      parsePreviewDependencies(
        JSON.stringify({ dependencies: { [maximumName]: maximumSpecifier } })
      )
    ).toEqual({
      dependencies: { [maximumName]: maximumSpecifier },
      devDependencies: {},
    });
  });

  it('identifies build tools that require a non-Vite project runner', () => {
    expect(
      getUnsupportedPreviewBuildTool(
        parsePreviewDependencies('{"dependencies":{"next":"15.0.0","react":"19.0.0"}}')
      )
    ).toBe('next');
    expect(
      getUnsupportedPreviewBuildTool(
        parsePreviewDependencies('{"devDependencies":{"vite":"7.0.0"}}')
      )
    ).toBeNull();
  });
});

describe('dependency merging', () => {
  it('removes packages supplied by either template dependency section', () => {
    const requested: PreviewDependencies = {
      dependencies: {
        react: '^19.0.0',
        three: '^0.180.0',
        '@scope/orbit-kit': '^2.0.0',
      },
      devDependencies: {
        vite: '^7.0.0',
        '@types/three': '^0.180.0',
      },
    };

    expect(getExtraDependencies(requested, template)).toEqual({
      dependencies: {
        three: '^0.180.0',
        '@scope/orbit-kit': '^2.0.0',
      },
      devDependencies: {
        '@types/three': '^0.180.0',
      },
    });
  });

  it('builds a private module package with template and validated extras', () => {
    const packageJson = JSON.parse(
      buildPreviewPackageJson(template, {
        dependencies: { three: '^0.180.0', '@scope/orbit-kit': '^2.0.0' },
        devDependencies: { '@types/three': '^0.180.0' },
      })
    ) as Record<string, unknown>;

    expect(packageJson).toMatchObject({
      name: 'agentvis-preview-react-tailwind',
      private: true,
      type: 'module',
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        three: '^0.180.0',
        '@scope/orbit-kit': '^2.0.0',
      },
      devDependencies: {
        vite: '^6.0.0',
        '@types/three': '^0.180.0',
      },
    });
  });

  it('lets complete-project versions and package type override template defaults', () => {
    const packageJson = JSON.parse(
      buildPreviewPackageJson(
        template,
        {
          dependencies: { react: '^19.0.0', vite: '^7.0.0' },
          devDependencies: { 'react-dom': '^19.0.0' },
        },
        'commonjs'
      )
    ) as {
      type: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.type).toBe('commonjs');
    expect(packageJson.dependencies).toMatchObject({ react: '^19.0.0', vite: '^7.0.0' });
    expect(packageJson.devDependencies).toMatchObject({ 'react-dom': '^19.0.0' });
    expect(packageJson.dependencies).not.toHaveProperty('react-dom');
    expect(packageJson.devDependencies).not.toHaveProperty('vite');
  });
});
