/**
 * Trusted runtime generators for Project Preview.
 *
 * Agent-generated projects are staged in an isolated cache workspace. AgentVis
 * owns the static server and the Vite wrapper; complete projects may contribute
 * a staged Vite configuration while the wrapper retains lifecycle and serving
 * boundaries.
 */

import type { TemplateId } from './types';
import type { SafeTailwindTheme } from './tailwindThemePolicy';

const DIAGNOSTIC_NAMESPACE = 'agentvis:preview';

function serializeInlineScript(source: string): string {
  return source.replaceAll('</script', '<\\/script');
}

/** Browser-side bridge shared by the trusted Vite and static preview servers. */
export function buildPreviewDiagnosticBridgeScript(): string {
  return serializeInlineScript(`(() => {
  const namespace = ${JSON.stringify(DIAGNOSTIC_NAMESPACE)};
  const limit = 2000;
  const hostOrigins = new Set([
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:1420',
    'http://127.0.0.1:1420',
  ]);
  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === 'string') return value;
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? serialized : String(value);
    } catch { return String(value); }
  };
  const createMessage = (type, value) => {
    const message = value == null ? null : text(value).slice(0, limit);
    return { namespace, type, message };
  };
  let targetOrigin = null;
  let lifecycle = createMessage('booting');
  let recentDiagnostic = null;
  const post = (message, origin) => {
    window.parent.postMessage(message, origin);
  };
  const postLifecycle = (message) => post(message, targetOrigin || '*');
  const sendLifecycle = (type) => {
    lifecycle = createMessage(type);
    postLifecycle(lifecycle);
  };
  const sendDiagnostic = (type, value) => {
    recentDiagnostic = createMessage(type, value);
    if (targetOrigin) post(recentDiagnostic, targetOrigin);
  };

  const replayLifecycle = () => postLifecycle(lifecycle);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', replayLifecycle, { once: true });
  } else {
    replayLifecycle();
  }

  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (
      event.source !== window.parent ||
      !hostOrigins.has(event.origin) ||
      !payload ||
      payload.namespace !== namespace ||
      payload.type !== 'ping'
    ) return;

    targetOrigin = event.origin;
    post(lifecycle, targetOrigin);
    if (recentDiagnostic) post(recentDiagnostic, targetOrigin);
  });

  sendLifecycle('booting');
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window) {
      const address = target.currentSrc || target.src || target.href || target.tagName;
      sendDiagnostic('resource-error', address ? 'Failed to load resource: ' + address : 'Resource failed to load');
      return;
    }
    sendDiagnostic('runtime-error', event.error || event.message || 'Unknown runtime error');
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    sendDiagnostic('unhandled-rejection', event.reason || 'Unhandled promise rejection');
  });
  window.addEventListener('load', () => sendLifecycle('ready'), { once: true });
})();`);
}

function buildPostCssImports(templateId: TemplateId): string[] {
  if (templateId === 'vanilla') return [];
  return [
    "import postcssImport from 'postcss-import';",
    "import tailwindcss from 'tailwindcss';",
    "import autoprefixer from 'autoprefixer';",
  ];
}

function buildFrameworkPlugin(templateId: TemplateId): {
  importLine: string | null;
  pluginExpression: string | null;
} {
  if (templateId === 'react-tailwind') {
    return {
      importLine: "import react from '@vitejs/plugin-react';",
      pluginExpression: 'react()',
    };
  }
  if (templateId === 'vue-tailwind') {
    return {
      importLine: "import vue from '@vitejs/plugin-vue';",
      pluginExpression: 'vue()',
    };
  }
  return { importLine: null, pluginExpression: null };
}

export interface TrustedViteConfigOptions {
  /** A validated root-level config staged for a complete project preview. */
  projectConfigPath?: string | null;
  /** Let the staged project drive PostCSS/Tailwind instead of the snippet fallback. */
  usesProjectCssConfig?: boolean;
}

/** Generate the AgentVis Vite wrapper used by Project Preview. */
export function buildTrustedViteConfig(
  templateId: TemplateId,
  healthToken: string,
  templatePath: string,
  tailwindTheme: SafeTailwindTheme | null = null,
  options: TrustedViteConfigOptions = {}
): string {
  const bridge = buildPreviewDiagnosticBridgeScript();
  const projectConfigPath = options.projectConfigPath ?? null;
  const usesProjectCssConfig = options.usesProjectCssConfig ?? false;
  const framework = projectConfigPath
    ? { importLine: null, pluginExpression: null }
    : buildFrameworkPlugin(templateId);
  const imports = [
    projectConfigPath
      ? "import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite';"
      : "import { defineConfig } from 'vite';",
    "import { isAbsolute, relative, resolve, sep } from 'node:path';",
    framework.importLine,
    ...(usesProjectCssConfig ? [] : buildPostCssImports(templateId)),
  ].filter(Boolean);
  const plugins = [framework.pluginExpression, 'agentvisDiagnostics()'].filter(Boolean);
  const hasFallbackTailwind = templateId !== 'vanilla' && !usesProjectCssConfig;
  const serializedTailwindTheme = JSON.stringify(tailwindTheme ?? { extend: {} });
  const projectConfigBootstrap = projectConfigPath
    ? `const loadedProjectConfig = await loadConfigFromFile(
  { command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false },
  resolve(process.cwd(), ${JSON.stringify(projectConfigPath)}),
  process.cwd(),
  'silent'
);
if (!loadedProjectConfig) throw new Error('Project Vite configuration could not be loaded');
function containedProjectDirectory(value, base, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const candidate = resolve(base, value);
  const relativePath = relative(process.cwd(), candidate);
  if (relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith('..' + sep))) {
    return candidate;
  }
  return fallback;
}
const {
  root: configuredRoot,
  publicDir: configuredPublicDir,
  cacheDir: ignoredCacheDir,
  envDir: configuredEnvDir,
  server: ignoredServer,
  preview: ignoredPreview,
  ...projectConfig
} = loadedProjectConfig.config;
const projectRoot = containedProjectDirectory(configuredRoot, process.cwd(), process.cwd());
const projectPublicDir = configuredPublicDir === false
  ? false
  : containedProjectDirectory(configuredPublicDir, projectRoot, resolve(projectRoot, 'public'));
const projectEnvDir = containedProjectDirectory(configuredEnvDir, projectRoot, projectRoot);
void ignoredCacheDir;
void ignoredServer;
void ignoredPreview;
`
    : '';
  const cssConfig = usesProjectCssConfig
    ? ''
    : `  css: ${
        hasFallbackTailwind
          ? `{ postcss: { plugins: [postcssImport(), tailwindcss({ content: ['./index.html', './src/**/*.{js,ts,jsx,tsx,vue,html}'], theme: ${serializedTailwindTheme}, plugins: [] }), autoprefixer()] } }`
          : `{ postcss: { plugins: [] } }`
      },\n`;
  const exportExpression = projectConfigPath
    ? 'defineConfig(mergeConfig(projectConfig, agentvisConfig))'
    : 'defineConfig(agentvisConfig)';
  const rootExpression = projectConfigPath ? 'projectRoot' : 'process.cwd()';
  const publicDirExpression = projectConfigPath ? 'projectPublicDir' : "'public'";
  const envDirExpression = projectConfigPath ? 'projectEnvDir' : 'process.cwd()';
  const appTypeConfig = projectConfigPath ? '' : "  appType: 'spa',\n";

  return `${imports.join('\n')}

const HEALTH_PATH = '/.agentvis/health';
const HEALTH_TOKEN = ${JSON.stringify(healthToken)};
const diagnosticsBridge = ${JSON.stringify(bridge)};
const ALLOWED_APP_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
];

function agentvisDiagnostics() {
  return {
    name: 'agentvis-preview-diagnostics',
    enforce: 'pre',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { 'data-agentvis-preview': 'diagnostics' }, children: diagnosticsBridge, injectTo: 'head-prepend' }];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url || '').split('?')[0] !== HEALTH_PATH) return next();
        const origin = request.headers.origin || '';
        if (ALLOWED_APP_ORIGINS.includes(origin)) {
          response.setHeader('Access-Control-Allow-Origin', origin);
          response.setHeader('Vary', 'Origin');
        }
        if (request.method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ token: HEALTH_TOKEN }));
      });
    },
  };
}

${projectConfigBootstrap}const agentvisConfig = {
  root: ${rootExpression},
  publicDir: ${publicDirExpression},
  cacheDir: resolve(process.cwd(), '.agentvis/vite-cache'),
  envDir: ${envDirExpression},
${appTypeConfig}  clearScreen: false,
  plugins: [${plugins.join(', ')}],
  resolve: { preserveSymlinks: true },
${cssConfig}  optimizeDeps: { force: true },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    cors: {
      origin: ALLOWED_APP_ORIGINS,
    },
    fs: {
      strict: true,
      allow: [process.cwd(), ${JSON.stringify(templatePath)}],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.agentvis/**'],
    },
  },
};

export default ${exportExpression};
`;
}

/**
 * Generate a dependency-free Node static server for projects that intentionally
 * use a browser import map. Vite must not transform their bare imports first.
 */
export function buildStaticPreviewServerScript(healthToken: string): string {
  const bridge = buildPreviewDiagnosticBridgeScript();
  return `import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.AGENTVIS_PREVIEW_PORT);
const healthToken = ${JSON.stringify(healthToken)};
const bridge = ${JSON.stringify(bridge)};
const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ts': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveRequestPath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname); } catch { return null; }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.agentvis' || segment.includes('\\\\'))) return null;
  const candidate = resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function injectBridge(html) {
  const tag = '<script data-agentvis-preview="diagnostics">' + bridge + '</script>';
  const head = /<head(?:\\s[^>]*)?>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const origin = request.headers.origin || '';
  const allowedOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420', 'http://127.0.0.1:1420']);
  if (allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/.agentvis/health') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ token: healthToken }));
    return;
  }

  let filePath = resolveRequestPath(request.url || '/');
  if (!filePath) { response.statusCode = 403; response.end('Forbidden'); return; }
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) { filePath = resolve(filePath, 'index.html'); info = await stat(filePath); }
    if (!info.isFile()) throw new Error('not a file');

    const extension = extname(filePath).toLowerCase();
    response.setHeader('Content-Type', mimeTypes[extension] || 'application/octet-stream');
    if (extension === '.html') {
      response.end(injectBridge(await readFile(filePath, 'utf8')));
    } else {
      createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
    }
  } catch {
    const acceptsHtml = (request.headers.accept || '').includes('text/html');
    if (acceptsHtml && extname(pathname) === '') {
      const fallback = resolve(root, 'index.html');
      try {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(injectBridge(await readFile(fallback, 'utf8')));
        return;
      } catch { /* fall through to a real 404 */ }
    }
    response.statusCode = 404;
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1');
`;
}
