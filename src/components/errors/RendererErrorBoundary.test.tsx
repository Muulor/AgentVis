import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ destroy: tauri.destroy }),
}));

import { RendererCrashFallback } from './RendererErrorBoundary';
import { exitAfterRendererCrash } from './rendererCrashExit';
import { isDynamicModuleLoadError } from './rendererRecovery';

describe('RendererErrorBoundary recovery UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.invoke.mockResolvedValue(undefined);
    tauri.destroy.mockResolvedValue(undefined);
  });

  it.each([
    'Failed to fetch dynamically imported module: http://localhost:1420/chunk.tsx',
    'ChunkLoadError: Loading chunk 42 failed',
    'Importing a module script failed.',
  ])('recognizes recoverable module load failures: %s', (message) => {
    expect(isDynamicModuleLoadError(new TypeError(message))).toBe(true);
  });

  it('does not classify ordinary render errors as module load failures', () => {
    expect(isDynamicModuleLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('renders localized reload and close actions without App providers', () => {
    const html = renderToStaticMarkup(
      <RendererCrashFallback
        error={new TypeError('Failed to fetch dynamically imported module')}
        language="en-US"
      />
    );

    expect(html).toContain('AgentVis needs to recover its interface');
    expect(html).toContain('Reload AgentVis');
    expect(html).toContain('Close AgentVis');
  });

  it('uses true application exit so a tray process is not left behind', async () => {
    await exitAfterRendererCrash();

    expect(tauri.invoke).toHaveBeenCalledWith('exit_application');
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('retains native window destruction as a compatibility fallback', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('command unavailable'));

    await exitAfterRendererCrash();

    expect(tauri.destroy).toHaveBeenCalledOnce();
  });
});
