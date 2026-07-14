/**
 * Project Preview dependency policy.
 *
 * Preview installs are limited to registry package names and version/range selectors.
 * Local paths, Git URLs, HTTP tarballs, aliases and workspace links are rejected before
 * npm is invoked. Lifecycle scripts are disabled separately by the installer command.
 */

import type { TemplateConfig } from './types';
import { PreviewServiceError } from './previewErrors';

export interface PreviewDependencies {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  packageType?: 'commonjs' | 'module';
}

export const MAX_PREVIEW_PACKAGE_JSON_BYTES = 256 * 1024;
export const MAX_PREVIEW_DEPENDENCY_COUNT = 128;
export const MAX_PREVIEW_PACKAGE_NAME_LENGTH = 214;
export const MAX_PREVIEW_VERSION_SPECIFIER_LENGTH = 256;

const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const REGISTRY_VERSION_PATTERN = /^(?:latest|next|beta|alpha|canary|\*|[~^<>=*|\s\dA-Za-z.+-]+)$/;
const FORBIDDEN_VERSION_PREFIX =
  /^(?:file:|link:|workspace:|git(?:\+|:)|https?:|github:|npm:|\.{0,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/i;
const UNSUPPORTED_BUILD_TOOL_PACKAGES = [
  '@angular/core',
  '@sveltejs/kit',
  'astro',
  'next',
  'nuxt',
  'parcel',
  'react-scripts',
] as const;

function exceedsPackageJsonByteBudget(value: string): boolean {
  const output = new Uint8Array(MAX_PREVIEW_PACKAGE_JSON_BYTES + 1);
  const encoded = new TextEncoder().encodeInto(value, output);
  return encoded.read < value.length || encoded.written > MAX_PREVIEW_PACKAGE_JSON_BYTES;
}

function validateDependencyRecord(record: unknown, field: string): Record<string, string> {
  if (record === undefined) return {};
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PreviewServiceError('invalid-package', field);
  }

  const validated: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(record)) {
    if (
      name.length > MAX_PREVIEW_PACKAGE_NAME_LENGTH ||
      !PACKAGE_NAME_PATTERN.test(name) ||
      typeof specifier !== 'string' ||
      specifier.length > MAX_PREVIEW_VERSION_SPECIFIER_LENGTH
    ) {
      throw new PreviewServiceError('invalid-package', name);
    }

    const normalizedSpecifier = specifier.trim();
    if (!normalizedSpecifier) {
      throw new PreviewServiceError('invalid-package', `${name}@${normalizedSpecifier}`);
    }
    if (FORBIDDEN_VERSION_PREFIX.test(normalizedSpecifier)) {
      throw new PreviewServiceError(
        'unsupported-project',
        `non-registry-dependency: ${name}@${normalizedSpecifier}`
      );
    }
    if (!REGISTRY_VERSION_PATTERN.test(normalizedSpecifier)) {
      throw new PreviewServiceError('invalid-package', `${name}@${normalizedSpecifier}`);
    }
    Object.defineProperty(validated, name, {
      configurable: true,
      enumerable: true,
      value: normalizedSpecifier,
      writable: true,
    });
  }
  return validated;
}

export function parsePreviewDependencies(projectPackageJson?: string): PreviewDependencies {
  if (projectPackageJson === undefined) {
    return { dependencies: {}, devDependencies: {} };
  }

  if (exceedsPackageJsonByteBudget(projectPackageJson)) {
    throw new PreviewServiceError('invalid-package', 'package.json');
  }

  try {
    const manifest: unknown = JSON.parse(projectPackageJson);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new PreviewServiceError('invalid-package', 'package.json');
    }
    const packageManifest = manifest as {
      dependencies?: unknown;
      devDependencies?: unknown;
      type?: unknown;
    };
    const dependencies = validateDependencyRecord(packageManifest.dependencies, 'dependencies');
    const devDependencies = validateDependencyRecord(
      packageManifest.devDependencies,
      'devDependencies'
    );
    if (
      Object.keys(dependencies).length + Object.keys(devDependencies).length >
      MAX_PREVIEW_DEPENDENCY_COUNT
    ) {
      throw new PreviewServiceError('invalid-package', 'dependencies');
    }
    const packageType =
      packageManifest.type === 'commonjs' || packageManifest.type === 'module'
        ? packageManifest.type
        : undefined;
    return {
      dependencies,
      devDependencies,
      ...(packageType ? { packageType } : {}),
    };
  } catch (error) {
    if (error instanceof PreviewServiceError) throw error;
    throw new PreviewServiceError('invalid-package', 'package.json', { cause: error });
  }
}

export function getTemplatePackageNames(template: TemplateConfig): Set<string> {
  return new Set([...Object.keys(template.dependencies), ...Object.keys(template.devDependencies)]);
}

export function getDeclaredPackageNames(dependencies: PreviewDependencies): Set<string> {
  return new Set([
    ...Object.keys(dependencies.dependencies),
    ...Object.keys(dependencies.devDependencies),
  ]);
}

/** Identify package contracts that require a non-Vite project runner. */
export function getUnsupportedPreviewBuildTool(dependencies: PreviewDependencies): string | null {
  const declared = getDeclaredPackageNames(dependencies);
  return UNSUPPORTED_BUILD_TOOL_PACKAGES.find((name) => declared.has(name)) ?? null;
}

export function getExtraDependencies(
  dependencies: PreviewDependencies,
  template: TemplateConfig
): PreviewDependencies {
  const templatePackages = getTemplatePackageNames(template);
  return {
    dependencies: Object.fromEntries(
      Object.entries(dependencies.dependencies).filter(([name]) => !templatePackages.has(name))
    ),
    devDependencies: Object.fromEntries(
      Object.entries(dependencies.devDependencies).filter(([name]) => !templatePackages.has(name))
    ),
  };
}

export function buildPreviewPackageJson(
  template: TemplateConfig,
  extras: PreviewDependencies,
  packageType: 'commonjs' | 'module' = 'module'
): string {
  const dependencyOverrides = new Set(Object.keys(extras.dependencies));
  const devDependencyOverrides = new Set(Object.keys(extras.devDependencies));
  const dependencies = Object.fromEntries(
    Object.entries({ ...template.dependencies, ...extras.dependencies }).filter(
      ([name]) => dependencyOverrides.has(name) || !devDependencyOverrides.has(name)
    )
  );
  const devDependencies = Object.fromEntries(
    Object.entries({ ...template.devDependencies, ...extras.devDependencies }).filter(
      ([name]) => !dependencyOverrides.has(name)
    )
  );

  return JSON.stringify(
    {
      name: `agentvis-preview-${template.id}`,
      version: '1.0.0',
      private: true,
      type: packageType,
      dependencies,
      devDependencies,
    },
    null,
    2
  );
}
