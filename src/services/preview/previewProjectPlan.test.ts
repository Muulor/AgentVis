/** Project Preview complete-project and snippet staging-plan regressions. */

import { describe, expect, it } from 'vitest';

import { analyzePreviewProjectEntry, buildPreviewProjectPlan } from './previewProjectPlan';
import type { TemplateConfig } from './types';

const reactTemplate: TemplateConfig = {
  id: 'react-tailwind',
  displayName: 'React test template',
  dependencies: {},
  devDependencies: {},
  configFiles: {},
  entryFiles: {
    'index.html': '<script type="module" src="/src/main.jsx"></script>',
    'src/main.jsx': "import App from './App';",
    'src/App.jsx': 'export default function App() { return <h1>Hello Preview</h1>; }',
    'src/index.css': '@tailwind utilities;',
  },
};

describe('buildPreviewProjectPlan', () => {
  it('keeps a complete project entry graph free of template modules', () => {
    const plan = buildPreviewProjectPlan(
      [
        {
          path: 'index.html',
          content: '<script type="module" src="/src/main.tsx"></script>',
        },
        { path: 'src/main.tsx', content: "import App from './App';" },
        { path: 'src/App.tsx', content: 'export default function App() { return null; }' },
        {
          path: 'vite.config.ts',
          content: "export default { resolve: { alias: { '@': '/src' } } };",
        },
        { path: 'postcss.config.js', content: 'export default { plugins: {} };' },
      ],
      reactTemplate,
      'vite',
      true
    );

    expect([...plan.stagedFiles.keys()]).toEqual([
      'index.html',
      'src/main.tsx',
      'src/App.tsx',
      'vite.config.ts',
      'postcss.config.js',
    ]);
    expect(plan.stagedFiles.has('src/main.jsx')).toBe(false);
    expect(plan.stagedFiles.has('src/App.jsx')).toBe(false);
    expect(plan.projectViteConfigPath).toBe('vite.config.ts');
    expect(plan.usesProjectCssConfig).toBe(true);
    expect(plan.validationPaths).toEqual(['src/main.tsx']);
  });

  it('generates only a missing HTML shell for a complete project entry', () => {
    const plan = buildPreviewProjectPlan(
      [{ path: 'src/main.tsx', content: 'document.body.textContent = "ready";' }],
      reactTemplate,
      'vite',
      true
    );

    expect([...plan.stagedFiles.keys()]).toEqual(['index.html', 'src/main.tsx']);
    expect(plan.stagedFiles.get('index.html')).toContain('src="/src/main.tsx"');
  });

  it('lets a component snippet borrow the template entry without shadowing its extension', () => {
    const plan = buildPreviewProjectPlan(
      [{ path: 'src/App.tsx', content: 'export default function App() { return null; }' }],
      reactTemplate,
      'vite',
      false
    );

    expect([...plan.stagedFiles.keys()]).toEqual([
      'index.html',
      'src/main.jsx',
      'src/index.css',
      'src/App.tsx',
    ]);
    expect(plan.stagedFiles.has('src/App.jsx')).toBe(false);
  });

  it('does not disguise an incomplete complete project with the Hello Preview scaffold', () => {
    const plan = buildPreviewProjectPlan(
      [{ path: 'src/feature.ts', content: 'export const feature = true;' }],
      reactTemplate,
      'vite',
      true
    );

    expect([...plan.stagedFiles.keys()]).toEqual(['src/feature.ts']);
    expect(plan.stagedFiles.has('index.html')).toBe(false);
  });

  it('leaves a configured nested Vite root intact instead of generating a competing root page', () => {
    const plan = buildPreviewProjectPlan(
      [
        { path: 'vite.config.ts', content: "export default { root: 'web' };" },
        {
          path: 'web/index.html',
          content: '<script type="module" src="/src/main.ts"></script>',
        },
        { path: 'web/src/main.ts', content: 'document.body.textContent = "ready";' },
      ],
      reactTemplate,
      'vite',
      true
    );

    expect(plan.projectViteConfigPath).toBe('vite.config.ts');
    expect(plan.indexHtmlPath).toBeNull();
    expect(plan.stagedFiles.has('index.html')).toBe(false);
    expect(plan.validationPaths).toEqual([]);
  });

  it('uses the only root HTML file as the complete-project entry', () => {
    const html = '<!doctype html><link rel="stylesheet" href="./styles.css"><h1>Map</h1>';
    const plan = buildPreviewProjectPlan(
      [
        { path: 'unicorn_map.html', content: html },
        { path: 'main.js', content: 'document.body.dataset.ready = "true";' },
        { path: 'styles.css', content: 'h1 { color: rebeccapurple; }' },
      ],
      reactTemplate,
      'vite',
      true
    );

    expect(plan.stagedFiles.get('index.html')).toBe(html);
    expect(plan.stagedFiles.get('unicorn_map.html')).toBe(html);
    expect(plan.stagedFiles.get('main.js')).toContain('dataset.ready');
    expect(plan.indexHtmlPath).toBe('index.html');
  });

  it('mirrors a uniquely named import-map HTML entry in static mode', () => {
    const html = `<script type="importmap">{"imports":{"three":"https://cdn.example/three.js"}}</script>
      <script type="module">import 'three';</script>`;
    const plan = buildPreviewProjectPlan(
      [{ path: 'iss-tracker.html', content: html }],
      reactTemplate,
      'static',
      true
    );

    expect(plan.stagedFiles.get('index.html')).toBe(html);
    expect(plan.stagedFiles.get('iss-tracker.html')).toBe(html);
  });

  it('reports ambiguous roots and likely nested project directories without choosing one', () => {
    const ambiguous = analyzePreviewProjectEntry([
      { path: 'first.html', content: '<h1>First</h1>' },
      { path: 'second.html', content: '<h1>Second</h1>' },
    ]);
    const nested = analyzePreviewProjectEntry([
      { path: 'web/package.json', content: '{}' },
      { path: 'web/index.html', content: '<h1>Web</h1>' },
      { path: 'docs/index.html', content: '<h1>Docs</h1>' },
    ]);

    expect(ambiguous.rootHtmlFiles.map((file) => file.path)).toEqual(['first.html', 'second.html']);
    expect(ambiguous.standaloneHtmlEntry).toBeNull();
    expect(nested.nestedProjectRoots).toEqual(['docs', 'web']);
  });
});
