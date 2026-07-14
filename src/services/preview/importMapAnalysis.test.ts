/** Project preview import-map and JavaScript import-analysis regression tests. */

import { describe, expect, it } from 'vitest';

import {
  analyzeHtmlImports,
  collectBareImportPackageRoots,
  collectBareImportSpecifiers,
  collectModuleSpecifiers,
  getBarePackageRoot,
  isImportMapSpecifierMapped,
  normalizeImportMapImports,
  normalizeImportMapScopes,
  parseImportMapImports,
  resolveImportMapSpecifier,
  resolveImportMapSpecifierForReferrer,
  shouldUseStaticImportMapPreview,
} from './importMapAnalysis';
import { ProjectPathValidationError } from './projectPathPolicy';

describe('parseImportMapImports', () => {
  it('preserves exact and package-prefix mappings', () => {
    const imports = parseImportMapImports(`{
      "imports": {
        "three": "https://cdn.example/three.module.js",
        "three/": "https://cdn.example/examples/jsm/",
        "@scope/pkg/": "./vendor/pkg/"
      }
    }`);

    expect(imports).toEqual({
      three: 'https://cdn.example/three.module.js',
      'three/': 'https://cdn.example/examples/jsm/',
      '@scope/pkg/': './vendor/pkg/',
    });
  });

  it('does not allow special object keys to mutate the result prototype', () => {
    const imports = parseImportMapImports(
      '{"imports":{"__proto__":"./safe.js","constructor":"./constructor.js"}}'
    );

    expect(imports?.['__proto__']).toBe('./safe.js');
    expect(imports?.['constructor']).toBe('./constructor.js');
    expect(Object.getPrototypeOf(imports)).toBe(Object.prototype);
  });

  it.each(['not json', '[]', '{"imports": []}', '{"imports": "react"}'])(
    'returns null for an invalid import map: %s',
    (source) => {
      expect(parseImportMapImports(source)).toBeNull();
    }
  );

  it('ignores non-string mapping values', () => {
    expect(parseImportMapImports('{"imports":{"valid":"./ok.js","blocked":null}}')).toEqual({
      valid: './ok.js',
    });
  });
});

describe('analyzeHtmlImports', () => {
  it('recognizes case-insensitive script attributes and relative module entries', () => {
    const analysis = analyzeHtmlImports(`<!doctype html>
      <!-- <script type="importmap">{"imports":{"fake":"./fake.js"}}</script> -->
      <SCRIPT data-label="a > b" TYPE = 'IMPORTMAP'>
        {"imports":{"react":"https://esm.example/react.js","react/":"./vendor/react/"}}
      </SCRIPT>
      <script SRC=./src/main.js TYPE=module></script>
      <script type="module" src="src/app&#46;ts?mode=preview"></script>
      <script type="module" src="../shared.js"></script>
      <script type="module" src="https://example.com/remote.js"></script>
      <script type="module" src="//example.com/remote.js"></script>
      <script type="module" src="/src/root.js"></script>
      <script type="module" src="\\windows\\root.js"></script>
      <script type="module" src="#fragment"></script>
      <script type="module" src="data:text/javascript,export{}"></script>
    `);

    expect(analysis).toEqual({
      hasImportMap: true,
      validImportMapCount: 1,
      invalidImportMapCount: 0,
      imports: {
        react: 'https://esm.example/react.js',
        'react/': './vendor/react/',
      },
      scopes: {},
      moduleEntries: ['./src/main.js', 'src/app.ts?mode=preview', '../shared.js', '/src/root.js'],
      inlineModuleSources: [],
      baseHref: null,
    });
  });

  it('merges valid maps and reports malformed maps separately', () => {
    const analysis = analyzeHtmlImports(`
      <script type="importmap">{"imports":{"first":"./first.js"}}</script>
      <script type="IMPORTMAP">not json</script>
      <script type="importmap">{"imports":{"second/":"./second/"}}</script>
      <script type="module" src="main.js"></script>
      <script type="module" src="main.js"></script>
    `);

    expect(analysis.hasImportMap).toBe(true);
    expect(analysis.validImportMapCount).toBe(2);
    expect(analysis.invalidImportMapCount).toBe(1);
    expect(analysis.imports).toEqual({ first: './first.js', 'second/': './second/' });
    expect(analysis.scopes).toEqual({});
    expect(analysis.moduleEntries).toEqual(['main.js']);
  });

  it('collects scoped mappings without treating them as global imports', () => {
    const analysis = analyzeHtmlImports(`
      <script type="importmap">{
        "imports": { "react": "./global-react.js" },
        "scopes": {
          "./feature/": { "react": "./feature-react.js", "feature/": "./feature/" }
        }
      }</script>
    `);

    expect(analysis.imports).toEqual({ react: './global-react.js' });
    expect(analysis.scopes).toEqual({
      './feature/': { react: './feature-react.js', 'feature/': './feature/' },
    });
  });

  it('does not allow special scope keys to mutate object prototypes', () => {
    const analysis = analyzeHtmlImports(
      '<script type="importmap">{"scopes":{"__proto__":{"safe":"./safe.js"}}}</script>'
    );

    expect(analysis.scopes['__proto__']).toEqual({ safe: './safe.js' });
    expect(Object.getPrototypeOf(analysis.scopes)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('safe');
  });

  it('does not treat ordinary or commented scripts as import maps', () => {
    const analysis = analyzeHtmlImports(`
      <!-- <script type="importmap">{"imports":{"fake":"./fake.js"}}</script> -->
      <script type="application/json">{"imports":{"alsoFake":"./fake.js"}}</script>
      <script type="module">import './inline.js';</script>
    `);

    expect(analysis.hasImportMap).toBe(false);
    expect(analysis.imports).toEqual({});
    expect(analysis.moduleEntries).toEqual([]);
    expect(analysis.inlineModuleSources).toEqual(["import './inline.js';"]);
  });

  it('ignores scripts inside inert HTML containers', () => {
    const analysis = analyzeHtmlImports(`
      <template><script type="importmap">{"imports":{"template":"./fake.js"}}</script></template>
      <textarea><script type="importmap">{"imports":{"textarea":"./fake.js"}}</script></textarea>
      <noscript><script type="module" src="fake.js"></script></noscript>
      <script type="importmap">{"imports":{"real":"./real.js"}}</script>
    `);

    expect(analysis.imports).toEqual({ real: './real.js' });
    expect(analysis.moduleEntries).toEqual([]);
  });

  it('captures the first active base href and ignores inert or commented lookalikes', () => {
    const analysis = analyzeHtmlImports(`
      <!-- <base href="/commented/"> -->
      <template><base href="/inert/"></template>
      <base href="/modules/">
      <base href="/ignored/">
    `);

    expect(analysis.baseHref).toBe('/modules/');
  });

  it('ignores script-like text in raw-text elements and base-like text in scripts', () => {
    const analysis = analyzeHtmlImports(`
      <style><script type="importmap">{"imports":{"fake":"./fake.js"}}</script></style>
      <title><script type="module" src="fake.js"></script></title>
      <script>const markup = '<base href="/fake/">';</script>
      <base href="/real/">
      <script type="importmap">{"imports":{"real":"./real.js"}}</script>
    `);

    expect(analysis.baseHref).toBe('/real/');
    expect(analysis.imports).toEqual({ real: './real.js' });
    expect(analysis.moduleEntries).toEqual([]);
  });

  it('does not treat a slash as self-closing an HTML script element', () => {
    const analysis = analyzeHtmlImports(`
      <script type="module" src="main.js"/>
      <script type="importmap">{"imports":{"fake":"./fake.js"}}</script>
    `);

    expect(analysis.hasImportMap).toBe(false);
    expect(analysis.moduleEntries).toEqual(['main.js']);
  });
});

describe('shouldUseStaticImportMapPreview', () => {
  const indexHtml = `
    <script type="importmap">{"imports":{"three":"https://cdn.example/three.js"}}</script>
    <script type="module" src="./main.js"></script>
  `;

  it('selects static serving for a root import-map app without a package manifest', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: './index.html', content: indexHtml },
        { path: 'main.js', content: "import 'three';" },
      ])
    ).toBe(true);
  });

  it('keeps explicit package projects on the package-aware route', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: 'index.html', content: indexHtml },
        { path: '.\\package.json', content: '{"dependencies":{"three":"1.0.0"}}' },
      ])
    ).toBe(false);
  });

  it('does not select static routing when the root HTML has no import-map element', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: 'index.html', content: '<script type="module" src="main.js"></script>' },
      ])
    ).toBe(false);
  });

  it('rejects malformed import maps before static routing', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: 'index.html', content: '<script type="importmap">not json</script>' },
      ])
    ).toBe(false);
  });

  it('allows a valid empty map when the project only uses relative modules', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: 'index.html', content: '<script type="importmap">{"imports":{}}</script>' },
      ])
    ).toBe(true);
  });

  it('selects static routing for a uniquely named root HTML import-map app', () => {
    expect(
      shouldUseStaticImportMapPreview([
        { path: 'iss-tracker.html', content: indexHtml },
        { path: 'main.js', content: "import 'three';" },
      ])
    ).toBe(true);
  });

  it('validates paths while making the route decision', () => {
    expect(() =>
      shouldUseStaticImportMapPreview([
        { path: 'package.json', content: '{}' },
        { path: 'index.html', content: indexHtml },
        { path: '..\\outside.js', content: '' },
      ])
    ).toThrow(ProjectPathValidationError);
  });
});

describe('getBarePackageRoot', () => {
  it.each([
    ['react', 'react'],
    ['three/addons/controls/OrbitControls.js', 'three'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/subpath', '@scope/pkg'],
    ['./local.js', null],
    ['../local.js', null],
    ['/absolute.js', null],
    ['C:\\absolute.js', null],
    ['https://example.com/mod.js', null],
    ['node:fs', null],
    ['path', null],
    ['fs/promises', null],
    ['data:text/javascript,export{}', null],
    ['#internal', null],
    ['@scope', null],
    [' react', null],
  ])('maps %s to %s', (specifier, expected) => {
    expect(getBarePackageRoot(specifier)).toBe(expected);
  });
});

describe('collectBareImportPackageRoots', () => {
  it('collects supported import forms in source order and deduplicates package roots', () => {
    const source = `
      import React from 'react';
      import 'side-effects';
      import type { Config } from '@scope/pkg/types';
      export { helper } from "lodash/fp";
      export * from 'three/addons/loaders.js';
      const controls = import(/* webpackChunkName: "controls" */ 'three/examples/controls.js');
      const escaped = import('rea\\u0063t');
    `;

    expect(collectBareImportPackageRoots(source)).toEqual([
      'react',
      'side-effects',
      '@scope/pkg',
      'lodash',
      'three',
    ]);
    expect(collectBareImportSpecifiers(source)).toEqual([
      'react',
      'side-effects',
      '@scope/pkg/types',
      'lodash/fp',
      'three/addons/loaders.js',
      'three/examples/controls.js',
    ]);
    expect(
      collectModuleSpecifiers("import './styles.css'; export * from 'three/addons.js';")
    ).toEqual(['./styles.css', 'three/addons.js']);
  });

  it('ignores local, absolute, URL, node, and non-code lookalikes', () => {
    const source =
      String.raw`
      import './local.js';
      export * from '../shared.js';
      import('/absolute.js');
      import('https://example.com/remote.js');
      import('node:fs/promises');
      import path from 'path';
      import('fs/promises');
      import('data:text/javascript,export{}');
      import.meta.resolve('not-an-import');
      object.import('not-a-keyword');
      // import 'fake-comment';
      /* export * from 'fake-block-comment'; */
      const text = "import('fake-string')";
      const template = ` +
      '`' +
      `import('fake-template')` +
      '`' +
      `;
      const matcher = /import\\(['"]fake-regex['"]\\)/;
    `;

    expect(collectBareImportPackageRoots(source)).toEqual([]);
  });

  it('allows comments and whitespace around literal dynamic imports', () => {
    expect(
      collectBareImportPackageRoots("const module = import /* hint */ ( 'pkg/subpath' );")
    ).toEqual(['pkg']);
  });

  it('scans many semicolon-free exports in one pass', () => {
    const source = Array.from(
      { length: 10_000 },
      (_, index) => `export const value${index} = ${index}`
    ).join('\n');

    expect(collectBareImportPackageRoots(source)).toEqual([]);
  });
});

describe('isImportMapSpecifierMapped', () => {
  const imports = {
    three: 'https://cdn.example/three.js',
    'three/': 'https://cdn.example/three/',
    'three/addons/': './vendor/addons/',
    'broken/': 'https://cdn.example/broken.js',
  };

  it.each([
    ['three', true],
    ['three/addons/controls.js', true],
    ['three-extra', false],
    ['broken/subpath.js', false],
    ['missing', false],
  ])('matches %s: %s', (specifier, expected) => {
    expect(isImportMapSpecifierMapped(specifier, imports)).toBe(expected);
  });

  it('resolves the longest matching prefix address', () => {
    expect(resolveImportMapSpecifier('three/addons/controls.js', imports)).toBe(
      './vendor/addons/controls.js'
    );
    expect(resolveImportMapSpecifier('missing', imports)).toBeNull();
  });

  it('normalizes URL-like keys and resolves them against each module referrer', () => {
    const normalized = normalizeImportMapImports(
      {
        './shared.js': './mapped.js',
        'pkg/': './vendor/',
      },
      'https://agentvis-preview.invalid/app/index.html'
    );

    expect(normalized).toEqual({
      'https://agentvis-preview.invalid/app/shared.js':
        'https://agentvis-preview.invalid/app/mapped.js',
      'pkg/': 'https://agentvis-preview.invalid/app/vendor/',
    });
    expect(
      resolveImportMapSpecifierForReferrer(
        './shared.js',
        normalized ?? {},
        'https://agentvis-preview.invalid/app/main.js'
      )
    ).toBe('https://agentvis-preview.invalid/app/mapped.js');
    expect(
      resolveImportMapSpecifierForReferrer(
        './shared.js',
        normalized ?? {},
        'https://agentvis-preview.invalid/app/nested/main.js'
      )
    ).toBeNull();
    expect(
      resolveImportMapSpecifierForReferrer(
        'pkg/tool.js',
        normalized ?? {},
        'https://agentvis-preview.invalid/app/nested/main.js'
      )
    ).toBe('https://agentvis-preview.invalid/app/vendor/tool.js');
  });

  it('rejects an invalid prefix address during normalization', () => {
    expect(
      normalizeImportMapImports(
        { 'pkg/': 'https://cdn.example/package.js' },
        'https://agentvis-preview.invalid/index.html'
      )
    ).toBeNull();
  });

  it('prefers the longest matching import-map scope before global imports', () => {
    const normalizedScopes = normalizeImportMapScopes(
      {
        './feature/': { react: './feature-react.js' },
        './feature/admin/': { react: './admin-react.js' },
      },
      'https://agentvis-preview.invalid/index.html'
    );

    expect(
      resolveImportMapSpecifierForReferrer(
        'react',
        { react: 'https://cdn.example/react.js' },
        'https://agentvis-preview.invalid/feature/admin/main.js',
        normalizedScopes ?? {}
      )
    ).toBe('https://agentvis-preview.invalid/admin-react.js');
    expect(
      resolveImportMapSpecifierForReferrer(
        'react',
        { react: 'https://cdn.example/react.js' },
        'https://agentvis-preview.invalid/other/main.js',
        normalizedScopes ?? {}
      )
    ).toBe('https://cdn.example/react.js');
  });
});
