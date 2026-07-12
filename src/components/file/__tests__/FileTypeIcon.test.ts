import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileTypeIcon } from '../FileTypeIcon';
import { resolveFileTypeIcon } from '../FileTypeIconRegistry';

describe('resolveFileTypeIcon', () => {
  it('maps mainstream language extensions to distinct icons', () => {
    expect(resolveFileTypeIcon('src/App.ts')).toMatchObject({ label: 'TS', tone: 'blue' });
    expect(resolveFileTypeIcon('src/App.tsx')).toEqual({ visual: 'atom', tone: 'cyan' });
    expect(resolveFileTypeIcon('server.py')).toMatchObject({ label: 'PY', tone: 'blue' });
    expect(resolveFileTypeIcon('main.rs')).toEqual({ visual: 'cog', tone: 'orange' });
    expect(resolveFileTypeIcon('main.go')).toMatchObject({ label: 'GO', tone: 'cyan' });
    expect(resolveFileTypeIcon('styles.css')).toEqual({ visual: 'hash', tone: 'blue' });
    expect(resolveFileTypeIcon('index.html')).toEqual({ visual: 'codeXml', tone: 'red' });
    expect(resolveFileTypeIcon('App.vue')).toEqual({ visual: 'vue', tone: 'green' });
    expect(resolveFileTypeIcon('schema.sql')).toEqual({ visual: 'database', tone: 'cyan' });
  });

  it('prioritizes exact and patterned file names over their generic extensions', () => {
    expect(resolveFileTypeIcon('tsconfig.json')).toMatchObject({ label: 'TS', tone: 'blue' });
    expect(resolveFileTypeIcon('package.json')).toMatchObject({ label: 'NPM', tone: 'red' });
    expect(resolveFileTypeIcon('src-tauri/Cargo.toml')).toEqual({
      visual: 'cog',
      tone: 'orange',
    });
    expect(resolveFileTypeIcon('vite.config.ts')).toEqual({ visual: 'vite', tone: 'yellow' });
    expect(resolveFileTypeIcon('.env.local')).toEqual({ visual: 'settings', tone: 'yellow' });
  });

  it('uses file-family and unknown fallbacks', () => {
    expect(resolveFileTypeIcon('photo.png')).toEqual({ visual: 'image', tone: 'purple' });
    expect(resolveFileTypeIcon('notes.txt')).toEqual({ visual: 'fileText', tone: 'blue' });
    expect(resolveFileTypeIcon('archive.bin')).toEqual({ visual: 'file', tone: 'neutral' });
    expect(resolveFileTypeIcon('src', true)).toEqual({ visual: 'folder', tone: 'yellow' });
  });

  it('exposes capped label lengths for optical badge sizing', () => {
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { fileName: 'main.c' }))).toContain(
      'data-label-length="1"'
    );
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { fileName: 'main.ts' }))).toContain(
      'data-label-length="2"'
    );
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { fileName: 'main.php' }))).toContain(
      'data-label-length="3"'
    );
    expect(
      renderToStaticMarkup(createElement(FileTypeIcon, { fileName: 'config.toml' }))
    ).toContain('data-label-length="4"');
  });

  it('renders Vue and Vite as dedicated SVG icons instead of text badges', () => {
    const vueMarkup = renderToStaticMarkup(createElement(FileTypeIcon, { fileName: 'App.vue' }));
    const viteMarkup = renderToStaticMarkup(
      createElement(FileTypeIcon, { fileName: 'vite.config.ts' })
    );

    expect(vueMarkup.startsWith('<svg')).toBe(true);
    expect(vueMarkup).toContain('<path');
    expect(vueMarkup).not.toContain('data-label-length');
    expect(viteMarkup.startsWith('<svg')).toBe(true);
    expect(viteMarkup).toContain('<path');
    expect(viteMarkup).not.toContain('data-label-length');
  });
});
