import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RendererCrashFallback } from './RendererErrorBoundary';
import { isDynamicModuleLoadError } from './rendererRecovery';

describe('RendererErrorBoundary recovery UI', () => {
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
});
