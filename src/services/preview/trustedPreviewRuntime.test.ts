/** Trusted Project Preview runtime generator and static-server regression tests. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createProbeServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPreviewDiagnosticBridgeScript,
  buildStaticPreviewServerScript,
  buildTrustedViteConfig,
} from './trustedPreviewRuntime';

interface HttpResponse {
  status: number;
  body: string;
  contentType: string | undefined;
  allowOrigin: string | undefined;
}

interface BridgeMessage {
  namespace: string;
  type: string;
  message: string | null;
}

interface BridgePost {
  message: BridgeMessage;
  targetOrigin: string;
}

interface BridgeHarness {
  posts: BridgePost[];
  parent: object;
  window: object;
  dispatch: (type: string, event: Record<string, unknown>) => void;
  dispatchDocument: (type: string, event: Record<string, unknown>) => void;
}

function createBridgeHarness(): BridgeHarness {
  const posts: BridgePost[] = [];
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const parent = {
    postMessage(message: BridgeMessage, targetOrigin: string) {
      posts.push({ message, targetOrigin });
    },
  };
  const previewWindow = {
    parent,
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
  };
  const previewDocument = {
    readyState: 'loading',
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const registered = documentListeners.get(type) ?? [];
      registered.push(listener);
      documentListeners.set(type, registered);
    },
  };

  runInNewContext(buildPreviewDiagnosticBridgeScript(), {
    document: previewDocument,
    window: previewWindow,
  });

  return {
    posts,
    parent,
    window: previewWindow,
    dispatch(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    dispatchDocument(type, event) {
      for (const listener of documentListeners.get(type) ?? []) listener(event);
    },
  };
}

interface FileSystemError extends Error {
  code?: string;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function signalChildAndWait(
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL',
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.once('exit', onExit);
    try {
      child.kill(signal);
    } catch {
      if (hasExited(child)) finish(true);
    }
    if (hasExited(child)) finish(true);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (hasExited(child)) return;
  child.stdin.destroy();
  if (await signalChildAndWait(child, 'SIGTERM', 1500)) return;
  if (await signalChildAndWait(child, 'SIGKILL', 1500)) return;
  throw new Error(`Preview test child process ${child.pid ?? 'unknown'} did not exit`);
}

async function retryDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, milliseconds);
  });
}

async function removeOwnedTestDirectory(
  target: string,
  expectedParent: string,
  expectedPrefix: string
): Promise<void> {
  const resolvedTarget = resolvePath(target);
  const resolvedParent = resolvePath(expectedParent);
  if (
    dirname(resolvedTarget) !== resolvedParent ||
    !basename(resolvedTarget).startsWith(expectedPrefix)
  ) {
    throw new Error(`Refusing to remove an unexpected preview test path: ${resolvedTarget}`);
  }

  const retryableCodes = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
  const maxAttempts = 7;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(resolvedTarget, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as FileSystemError).code;
      if (!code || !retryableCodes.has(code) || attempt === maxAttempts - 1) throw error;
      await retryDelay(25 * 2 ** attempt);
    }
  }
}

async function reservePort(): Promise<number> {
  const server = createProbeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve a TCP port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function requestPath(
  port: number,
  path: string,
  accept = '*/*',
  origin?: string
): Promise<HttpResponse> {
  return await new Promise<HttpResponse>((resolve, reject) => {
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path, headers: { accept, ...(origin ? { origin } : {}) } },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body,
            contentType: response.headers['content-type'],
            allowOrigin: response.headers['access-control-allow-origin'],
          });
        });
      }
    );
    request.once('error', reject);
    request.end();
  });
}

async function waitUntilHealthy(
  port: number,
  process: ChildProcessWithoutNullStreams
): Promise<void> {
  let processError = '';
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk: string) => {
    processError += chunk;
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Static preview server exited early: ${processError}`);
    }
    try {
      const response = await requestPath(port, '/.agentvis/health');
      if (response.status === 200) return;
    } catch {
      // The child may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Static preview server did not become healthy: ${processError}`);
}

describe('buildPreviewDiagnosticBridgeScript', () => {
  it('reports each supported lifecycle and browser failure signal', () => {
    const bridge = buildPreviewDiagnosticBridgeScript();

    expect(bridge).toContain("sendLifecycle('booting')");
    expect(bridge).toContain("sendLifecycle('ready')");
    expect(bridge).toContain("document.addEventListener('DOMContentLoaded', replayLifecycle");
    expect(bridge).toContain("sendDiagnostic('resource-error'");
    expect(bridge).toContain("sendDiagnostic('runtime-error'");
    expect(bridge).toContain("sendDiagnostic('unhandled-rejection'");
    expect(bridge).toContain('const namespace = "agentvis:preview"');
    expect(bridge).toContain('.slice(0, limit)');
    expect(bridge.toLowerCase()).not.toContain('</script');
  });

  it('replays the current lifecycle and most recent diagnostic to a trusted host ping', () => {
    const harness = createBridgeHarness();

    expect(harness.posts).toEqual([
      {
        message: { namespace: 'agentvis:preview', type: 'booting', message: null },
        targetOrigin: '*',
      },
    ]);

    harness.dispatchDocument('DOMContentLoaded', {});
    expect(harness.posts.at(-1)).toEqual({
      message: { namespace: 'agentvis:preview', type: 'booting', message: null },
      targetOrigin: '*',
    });

    const postCountBeforeDiagnostic = harness.posts.length;
    harness.dispatch('error', {
      target: harness.window,
      error: null,
      message: 'module evaluation failed',
    });
    expect(harness.posts).toHaveLength(postCountBeforeDiagnostic);
    expect(harness.posts.some(({ message }) => message.type === 'runtime-error')).toBe(false);

    harness.dispatch('load', {});
    expect(harness.posts.at(-1)).toEqual({
      message: { namespace: 'agentvis:preview', type: 'ready', message: null },
      targetOrigin: '*',
    });
    const postCountBeforePing = harness.posts.length;

    harness.dispatch('message', {
      source: harness.parent,
      origin: 'tauri://localhost',
      data: { namespace: 'agentvis:preview', type: 'ping' },
    });

    expect(harness.posts.slice(postCountBeforePing)).toEqual([
      {
        message: { namespace: 'agentvis:preview', type: 'ready', message: null },
        targetOrigin: 'tauri://localhost',
      },
      {
        message: {
          namespace: 'agentvis:preview',
          type: 'runtime-error',
          message: 'module evaluation failed',
        },
        targetOrigin: 'tauri://localhost',
      },
    ]);

    harness.dispatch('unhandledrejection', { reason: 'late async failure' });
    expect(harness.posts.at(-1)).toEqual({
      message: {
        namespace: 'agentvis:preview',
        type: 'unhandled-rejection',
        message: 'late async failure',
      },
      targetOrigin: 'tauri://localhost',
    });
  });

  it('ignores pings from another window, origin, or namespace', () => {
    const harness = createBridgeHarness();
    const postCount = harness.posts.length;

    harness.dispatch('message', {
      source: {},
      origin: 'tauri://localhost',
      data: { namespace: 'agentvis:preview', type: 'ping' },
    });
    harness.dispatch('message', {
      source: harness.parent,
      origin: 'https://attacker.example',
      data: { namespace: 'agentvis:preview', type: 'ping' },
    });
    harness.dispatch('message', {
      source: harness.parent,
      origin: 'tauri://localhost',
      data: { namespace: 'another:namespace', type: 'ping' },
    });

    expect(harness.posts).toHaveLength(postCount);
  });
});

describe('buildTrustedViteConfig', () => {
  it('pins the health token and strict filesystem boundary in an AgentVis-owned config', () => {
    const config = buildTrustedViteConfig(
      'react-tailwind',
      'health-token-with-"quotes"',
      'C:\\controlled\\react-template'
    );

    expect(config).toContain('const HEALTH_TOKEN = "health-token-with-\\"quotes\\""');
    expect(config).toContain("const HEALTH_PATH = '/.agentvis/health'");
    expect(config).toContain('strict: true');
    expect(config).toContain('allow: [process.cwd(), "C:\\\\controlled\\\\react-template"]');
    expect(config).toContain("host: '127.0.0.1'");
    expect(config).toContain('strictPort: true');
    expect(config).toContain("'tauri://localhost'");
    expect(config).toContain("'http://127.0.0.1:1420'");
    expect(config).toContain("response.setHeader('Access-Control-Allow-Origin', origin)");
    expect(config).not.toContain("origin: '*'");
    expect(config).not.toContain('origin: true');
    expect(config).toContain("import react from '@vitejs/plugin-react'");
    expect(config).toContain('tailwindcss({ content:');
    expect(config).toContain('agentvis-preview-diagnostics');
    expect(config).not.toContain('fs: { strict: false');
    expect(config).not.toContain('vite.config');
    expect(config).not.toContain('postcss.config');
    expect(config).not.toContain('tailwind.config');
    expect(config).not.toContain('loadConfigFromFile');
  });

  it('does not load framework or PostCSS plugins for a vanilla project', () => {
    const config = buildTrustedViteConfig('vanilla', 'token', 'C:\\controlled\\vanilla-template');

    expect(config).not.toContain('@vitejs/plugin-react');
    expect(config).not.toContain('@vitejs/plugin-vue');
    expect(config).not.toContain("from 'tailwindcss'");
    expect(config).not.toContain("from 'postcss-import'");
    expect(config).toContain('css: { postcss: { plugins: [] } }');
  });

  it('embeds only pre-parsed Tailwind theme data in the trusted config', () => {
    const config = buildTrustedViteConfig(
      'react-tailwind',
      'token',
      'C:\\controlled\\react-template',
      {
        extend: {
          colors: { bone: '#F5F1EA' },
          fontFamily: { body: ['Inter Tight', 'sans-serif'] },
        },
      }
    );

    expect(config).toContain(
      'theme: {"extend":{"colors":{"bone":"#F5F1EA"},"fontFamily":{"body":["Inter Tight","sans-serif"]}}}'
    );
    expect(config).not.toContain('tailwind.config');
    expect(config).not.toContain('loadConfigFromFile');
  });

  it('merges a complete project Vite config while retaining AgentVis server boundaries', () => {
    const config = buildTrustedViteConfig(
      'react-tailwind',
      'token',
      'C:\\controlled\\react-template',
      null,
      { projectConfigPath: 'vite.config.ts', usesProjectCssConfig: true }
    );

    expect(config).toContain(
      "import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite'"
    );
    expect(config).toContain('resolve(process.cwd(), "vite.config.ts")');
    expect(config).toContain('...projectConfig');
    expect(config).toContain('mergeConfig(projectConfig, agentvisConfig)');
    expect(config).toContain('const projectRoot = containedProjectDirectory(');
    expect(config).toContain('root: projectRoot');
    expect(config).toContain('publicDir: projectPublicDir');
    expect(config).toContain("relativePath.startsWith('..' + sep)");
    expect(config).toContain("cacheDir: resolve(process.cwd(), '.agentvis/vite-cache')");
    expect(config).toContain('server: ignoredServer');
    expect(config).toContain('strict: true');
    expect(config).not.toContain("import react from '@vitejs/plugin-react'");
    expect(config).not.toContain("from 'tailwindcss'");
    expect(config).not.toContain('css: { postcss:');
  });
});

describe('generated static preview server', () => {
  const healthToken = 'static-health-token';
  let root = '';
  let port = 0;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentvis-preview-runtime-'));
    await mkdir(join(root, '.agentvis'));
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body>ready</body></html>'
    );
    await writeFile(join(root, '.agentvis', 'secret.txt'), 'must not be served');
    const serverPath = join(root, 'static-preview-server.mjs');
    await writeFile(serverPath, buildStaticPreviewServerScript(healthToken));
    port = await reservePort();
    const spawned = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, AGENTVIS_PREVIEW_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;
    await waitUntilHealthy(port, spawned);
  });

  afterAll(async () => {
    if (child) await stopChild(child);
    if (root) await removeOwnedTestDirectory(root, tmpdir(), 'agentvis-preview-runtime-');
  });

  it('returns the exact health token without exposing project content', async () => {
    const response = await requestPath(port, '/.agentvis/health', '*/*', 'tauri://localhost');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(response.allowOrigin).toBe('tauri://localhost');
    expect(JSON.parse(response.body)).toEqual({ token: healthToken });
  });

  it('injects the diagnostics bridge into served HTML', async () => {
    const response = await requestPath(port, '/', 'text/html');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.body).toContain('<head><script data-agentvis-preview="diagnostics">');
    expect(response.body).toContain('agentvis:preview');
    expect(response.body).toContain("sendLifecycle('ready')");
    expect(response.body).toContain('<body>ready</body>');
  });

  it.each(['/%2e%2e%2foutside.txt', '/%2e%2e%5coutside.txt', '/%2eagentvis/secret.txt'])(
    'rejects a contained-path bypass attempt %s',
    async (path) => {
      const response = await requestPath(port, path);

      expect(response.status).toBe(403);
      expect(response.body).toBe('Forbidden');
      expect(response.body).not.toContain('must not be served');
    }
  );
});

describe('generated trusted Vite server', () => {
  const healthToken = 'vite-health-token';
  let root = '';
  let port = 0;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(process.cwd(), '.agentvis-vite-runtime-'));
    await mkdir(join(root, '.agentvis'));
    await mkdir(join(root, 'web', 'src'), { recursive: true });
    await writeFile(
      join(root, 'web', 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'
    );
    await writeFile(
      join(root, 'web', 'src', 'main.tsx'),
      "import React from 'react'; import { createRoot } from 'react-dom/client'; import message from '@/message'; import './index.css'; createRoot(document.getElementById('root')!).render(<h1>{message}</h1>);"
    );
    await writeFile(join(root, 'web', 'src', 'message.ts'), "export default 'ready';");
    await writeFile(join(root, 'web', 'src', 'index.css'), '.fixture { color: fixture-brand; }');
    await writeFile(
      join(root, 'web', 'postcss.config.js'),
      "export default { plugins: [{ postcssPlugin: 'agentvis-fixture', Declaration(declaration) { if (declaration.value === 'fixture-brand') declaration.value = 'rgb(12 34 56)'; } }] };"
    );
    await writeFile(
      join(root, 'vite.config.js'),
      "import react from '@vitejs/plugin-react'; import path from 'path'; export default { root: 'web', plugins: [react()], resolve: { alias: { '@': path.resolve(process.cwd(), 'web/src') } } };"
    );
    await writeFile(
      join(root, '.agentvis', 'vite.config.mjs'),
      buildTrustedViteConfig('react-tailwind', healthToken, root, null, {
        projectConfigPath: 'vite.config.js',
        usesProjectCssConfig: true,
      })
    );
    port = await reservePort();
    const spawned = spawn(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'),
        '--config',
        '.agentvis/vite.config.mjs',
        '--port',
        String(port),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    child = spawned;
    await waitUntilHealthy(port, spawned);
  });

  afterAll(async () => {
    if (child) await stopChild(child);
    if (root) {
      await removeOwnedTestDirectory(root, process.cwd(), '.agentvis-vite-runtime-');
    }
  });

  it('serves a token-authenticated health response to the app origin', async () => {
    const response = await requestPath(port, '/.agentvis/health', '*/*', 'http://localhost:1420');

    expect(response.status).toBe(200);
    expect(response.allowOrigin).toBe('http://localhost:1420');
    expect(JSON.parse(response.body)).toEqual({ token: healthToken });
  });

  it('injects diagnostics and compiles the module entry before iframe navigation', async () => {
    const html = await requestPath(port, '/', 'text/html', 'http://localhost:1420');
    const module = await requestPath(port, '/src/main.tsx', '*/*', 'http://localhost:1420');
    const css = await requestPath(port, '/src/index.css', 'text/css', 'http://localhost:1420');

    expect(html.status).toBe(200);
    expect(html.body).toContain('data-agentvis-preview="diagnostics"');
    expect(html.body).toContain('agentvis:preview');
    expect(module.status).toBe(200);
    expect(module.contentType).toContain('text/javascript');
    expect(module.body).toContain('/src/message.ts');
    expect(css.status).toBe(200);
    expect(css.body).toContain('rgb(12 34 56)');
  });
});
