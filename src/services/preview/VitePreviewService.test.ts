/** Project Preview preflight and retry regression tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectFile } from './types';
import { analyzeHtmlImports } from './importMapAnalysis';
import { extractPreviewHttpErrorDetail } from './previewErrors';

const previewStore = vi.hoisted(() => ({
  currentRequestId: 0,
  isProjectRequestCurrent: vi.fn((requestId: number) => requestId === 0),
  setProjectStatus: vi.fn(),
  setProjectUrl: vi.fn(),
}));

vi.mock('@stores/previewStore', () => ({
  usePreviewStore: {
    getState: () => previewStore,
  },
}));

async function loadFreshService() {
  vi.resetModules();
  return (await import('./VitePreviewService')).vitePreviewService;
}

describe('VitePreviewService preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewStore.currentRequestId = 0;
    previewStore.isProjectRequestCurrent.mockImplementation(
      (requestId: number) => requestId === previewStore.currentRequestId
    );
  });

  it('extracts the actionable Vite error instead of the generated overlay source tail', () => {
    const error = {
      message: '[postcss] index.html?html-proxy&index=0.css:344:5: Unexpected }',
      stack: 'internal stack',
      frame: '343| background: red;\n344| }\n   | ^',
      pluginCode: '.slide { color: white; }'.repeat(1_000),
    };
    const responseBody = `<!doctype html><title>Error</title><script>const error = ${JSON.stringify(error)}; try { document.body.textContent = error.message; } catch {}</script>`;

    expect(extractPreviewHttpErrorDetail(responseBody)).toBe(`${error.message}\n${error.frame}`);
  });

  it('publishes state only to the matching UI project request', async () => {
    const service = await loadFreshService();
    const internals = service as unknown as {
      updateState(
        partial: {
          status: 'idle' | 'running' | 'error';
          url?: string | null;
          templateId?: 'vanilla' | null;
          error?: string | null;
        },
        projectRequestId: number | null
      ): void;
    };
    previewStore.currentRequestId = 12;

    internals.updateState(
      { status: 'running', url: 'http://localhost:3100', templateId: 'vanilla' },
      11
    );
    await vi.waitFor(() => expect(previewStore.isProjectRequestCurrent).toHaveBeenCalledTimes(1));
    internals.updateState({ status: 'error', error: 'stale failure' }, 11);
    await vi.waitFor(() => expect(previewStore.isProjectRequestCurrent).toHaveBeenCalledTimes(2));
    await service.stopProject();

    expect(previewStore.setProjectStatus).not.toHaveBeenCalled();
    expect(previewStore.setProjectUrl).not.toHaveBeenCalled();

    internals.updateState(
      { status: 'running', url: 'http://localhost:3200', templateId: 'vanilla' },
      12
    );
    await vi.waitFor(() =>
      expect(previewStore.setProjectUrl).toHaveBeenCalledWith('http://localhost:3200', 'vanilla')
    );
    expect(previewStore.setProjectStatus).toHaveBeenLastCalledWith('running');
  });

  it('ignores a deferred stop that belongs to an older UI project request', async () => {
    const service = await loadFreshService();
    const internals = service as unknown as {
      generation: number;
      currentProjectRequestId: number | null;
    };
    internals.generation = 7;
    internals.currentProjectRequestId = 12;

    await service.stopProject(11);

    expect(internals.generation).toBe(7);
    expect(internals.currentProjectRequestId).toBe(12);

    await service.stopProject(12);
    expect(internals.generation).toBe(8);
    expect(internals.currentProjectRequestId).toBeNull();
  });

  it('rejects retry from a stale UI project request before changing service generation', async () => {
    const service = await loadFreshService();
    const internals = service as unknown as {
      generation: number;
      currentProjectRequestId: number | null;
    };
    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        [{ path: '../outside.js', content: 'export {}' }],
        undefined,
        '',
        12
      )
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    const generation = internals.generation;

    await expect(service.retryLastProject(11)).rejects.toMatchObject({ code: 'cancelled' });
    expect(internals.generation).toBe(generation);
    expect(internals.currentProjectRequestId).toBe(12);
  });

  it('rejects retry before any project request has been captured', async () => {
    const service = await loadFreshService();

    await expect(service.retryLastProject()).rejects.toMatchObject({
      code: 'retry-unavailable',
    });
  });

  it('rejects an unsafe path before invoking Node or touching a staging directory', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [{ path: '../outside.js', content: 'export {}' }];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(service.getState()).toMatchObject({ status: 'error', pid: null, projectDir: null });
  });

  it('reports bare packages that are absent from both the template and manifest', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'main.js',
        content: 'import * as THREE from "three";\nconsole.log(THREE.REVISION);',
      },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'missing-dependencies',
      detail: 'three',
    });
  });

  it('does not treat unprefixed Node built-ins in project configuration as npm packages', async () => {
    const service = await loadFreshService();
    const preflight = service as unknown as {
      assertImportsDeclared(
        files: readonly ProjectFile[],
        dependencies: {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        },
        template: { dependencies: Record<string, string>; devDependencies: Record<string, string> }
      ): void;
    };

    expect(() =>
      preflight.assertImportsDeclared(
        [
          {
            path: 'vite.config.ts',
            content: "import path from 'path'; export default { root: path.resolve('src') };",
          },
        ],
        { dependencies: {}, devDependencies: {} },
        { dependencies: {}, devDependencies: {} }
      )
    ).not.toThrow();
  });

  it('leaves JSX and Vue dependency discovery to the trusted Vite transform', async () => {
    const service = await loadFreshService();
    const preflight = service as unknown as {
      assertImportsDeclared(
        files: readonly ProjectFile[],
        dependencies: {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        },
        template: { dependencies: Record<string, string>; devDependencies: Record<string, string> }
      ): void;
    };

    expect(() =>
      preflight.assertImportsDeclared(
        [
          { path: 'App.jsx', content: 'export default () => <p>from "home"</p>;' },
          { path: 'App.vue', content: '<template><p>from "settings"</p></template>' },
        ],
        { dependencies: {}, devDependencies: {} },
        { dependencies: {}, devDependencies: {} }
      )
    ).not.toThrow();
  });

  it('rejects malformed import maps instead of falling through to Vite', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">not json</script><script type="module" src="main.js"></script>',
      },
      { path: 'main.js', content: 'export {};' },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({ code: 'compile-failed', detail: 'invalid-import-map' });
  });

  it('preserves omitted-environment context across service-backed retry', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content: '<script type="importmap">not json</script>',
      },
    ];
    const expectedHint = { code: 'environment-files-omitted', count: 2 };

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        files,
        undefined,
        '',
        null,
        true,
        2
      )
    ).rejects.toMatchObject({ code: 'compile-failed', hints: [expectedHint] });
    await expect(service.retryLastProject()).rejects.toMatchObject({
      code: 'compile-failed',
      hints: [expectedHint],
    });
  });

  it('distinguishes ambiguous HTML entries before creating a preview workspace', async () => {
    const service = await loadFreshService();

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        [
          { path: 'first.html', content: '<h1>First</h1>' },
          { path: 'second.html', content: '<h1>Second</h1>' },
        ],
        undefined,
        '',
        null,
        true
      )
    ).rejects.toMatchObject({ code: 'ambiguous-entry', detail: 'first.html, second.html' });
  });

  it('reports a nested project root instead of a generic missing index error', async () => {
    const service = await loadFreshService();

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        [
          { path: 'web/package.json', content: '{}' },
          { path: 'web/index.html', content: '<h1>Nested</h1>' },
        ],
        undefined,
        '',
        null,
        true
      )
    ).rejects.toMatchObject({ code: 'nested-project', detail: 'web' });
  });

  it('reports an unsupported framework contract when no Vite entry exists', async () => {
    const service = await loadFreshService();

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'react-tailwind',
        [{ path: 'src/app/page.tsx', content: 'export default function Page() { return null; }' }],
        '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}',
        '',
        null,
        true
      )
    ).rejects.toMatchObject({ code: 'unsupported-project', detail: 'build-tool: next' });
  });

  it('reports a missing complete-project entry explicitly', async () => {
    const service = await loadFreshService();

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        [{ path: 'data.json', content: '{}' }],
        undefined,
        '',
        null,
        true
      )
    ).rejects.toMatchObject({ code: 'entry-not-found' });
  });

  it('rejects bare imports that the static import map does not cover', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">{"imports":{"react":"https://esm.example/react.js"}}</script><script type="module" src="main.js"></script>',
      },
      { path: 'main.js', content: "import 'three';" },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'compile-failed',
      detail: 'unmapped-import-map-specifiers: three',
    });
  });

  it('accepts a bare import covered by the most specific import-map scope', async () => {
    const service = await loadFreshService();
    const html = `<script type="importmap">{
      "imports": { "three": "https://cdn.example/global-three.js" },
      "scopes": { "/": { "three": "https://cdn.example/scoped-three.js" } }
    }</script><script type="module">import 'three';</script>`;
    const preflight = service as unknown as {
      assertStaticImportMapCompatible(
        files: readonly ProjectFile[],
        analysis: ReturnType<typeof analyzeHtmlImports>
      ): void;
    };

    expect(() =>
      preflight.assertStaticImportMapCompatible(
        [{ path: 'iss-tracker.html', content: html }],
        analyzeHtmlImports(html)
      )
    ).not.toThrow();
  });

  it('rejects a missing local module entry before starting the static server', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">{"imports":{}}</script><script type="module" src="/missing.js"></script>',
      },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'compile-failed',
      detail: 'missing-local-module: index.html -> missing.js',
    });
  });

  it('walks mapped and relative local modules and rejects a missing second-level import', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">{"imports":{"app":"./src/main.js"}}</script><script type="module">import "app";</script>',
      },
      { path: 'src/main.js', content: 'export { value } from "./missing.js";' },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'compile-failed',
      detail: 'missing-local-module: src/main.js -> src/missing.js',
    });
  });

  it('matches URL-like import-map keys after resolving them against each referrer', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">{"imports":{"./shared.js":"./mapped.js"}}</script><script type="module" src="src/main.js"></script>',
      },
      { path: 'src/main.js', content: 'import "./shared.js";' },
      { path: 'mapped.js', content: 'export {};' },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'compile-failed',
      detail: 'missing-local-module: src/main.js -> src/shared.js',
    });
  });

  it('resolves HTML module entries against the active base href', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<base href="/modules/"><script type="importmap">{"imports":{}}</script><script type="module" src="missing.js"></script>',
      },
      { path: 'missing.js', content: 'export {};' },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({
      code: 'compile-failed',
      detail: 'missing-local-module: index.html -> modules/missing.js',
    });
  });

  it.each([
    ['main.tsx', "import React from 'react';"],
    ['main.js', "import './styles.css';"],
  ])('rejects transform-dependent static import-map source %s', async (path, content) => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content:
          '<script type="importmap">{"imports":{"react":"https://esm.example/react.js"}}</script><script type="module" src="main.js"></script>',
      },
      { path, content },
    ];

    await expect(
      service.startProject('C:\\deliverables\\agent', 'vite_preview', 'vanilla', files)
    ).rejects.toMatchObject({ code: 'compile-failed' });
  });

  it('retains the last request so retry repeats the real preflight instead of refreshing a URL', async () => {
    const service = await loadFreshService();
    const files: ProjectFile[] = [{ path: 'src/.. /outside.js', content: 'export {}' }];
    const internals = service as unknown as {
      lastRequest: { assetDestinationPrefix: string; projectRequestId: number | null } | null;
    };

    await expect(
      service.startProject(
        'C:\\deliverables\\agent',
        'vite_preview',
        'vanilla',
        files,
        undefined,
        'src/',
        41
      )
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(internals.lastRequest?.assetDestinationPrefix).toBe('src/');
    expect(internals.lastRequest?.projectRequestId).toBe(41);
    await expect(service.retryLastProject()).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(internals.lastRequest?.assetDestinationPrefix).toBe('src/');
    expect(internals.lastRequest?.projectRequestId).toBe(41);
  });
});
