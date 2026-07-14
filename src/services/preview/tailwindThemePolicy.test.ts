/** Safe Tailwind theme extraction regression tests. */

import { describe, expect, it } from 'vitest';

import { extractSafeTailwindTheme } from './tailwindThemePolicy';

describe('tailwindThemePolicy', () => {
  it('extracts literal custom theme values used by legacy Agent projects', async () => {
    const theme = await extractSafeTailwindTheme([
      {
        path: 'tailwind.config.js',
        content: `export default {
          content: ['./index.html', './src/**/*.{ts,tsx}'],
          theme: {
            extend: {
              colors: { bone: '#F5F1EA', charcoal: '#3A3A38' },
              fontFamily: { display: ['"Fraunces"', 'serif'], body: ['"Inter Tight"', 'sans-serif'] },
              fontSize: { 'display-xl': ['clamp(3rem, 7vw, 6rem)', { lineHeight: '0.95' }] },
              keyframes: { breathe: { '0%, 100%': { opacity: '0.55' }, '50%': { opacity: '0.95' } } },
              animation: { breathe: 'breathe 6s ease-in-out infinite' },
            },
          },
          plugins: [],
        };`,
      },
    ]);

    expect(JSON.parse(JSON.stringify(theme))).toEqual({
      extend: {
        colors: { bone: '#F5F1EA', charcoal: '#3A3A38' },
        fontFamily: {
          display: ['"Fraunces"', 'serif'],
          body: ['"Inter Tight"', 'sans-serif'],
        },
        fontSize: { 'display-xl': ['clamp(3rem, 7vw, 6rem)', { lineHeight: '0.95' }] },
        keyframes: {
          breathe: {
            '0%, 100%': { opacity: '0.55' },
            '50%': { opacity: '0.95' },
          },
        },
        animation: { breathe: 'breathe 6s ease-in-out infinite' },
      },
    });
  });

  it('never evaluates calls and omits dynamic or prototype-sensitive values', async () => {
    const theme = await extractSafeTailwindTheme([
      {
        path: 'tailwind.config.mjs',
        content: `
          const explode = () => { throw new Error('must not execute'); };
          export default {
            theme: {
              extend: {
                colors: {
                  safe: '#fff',
                  dynamic: explode(),
                  __proto__: { polluted: true },
                },
                fontFamily: { sans: ['Inter', ...defaultTheme.fontFamily.sans] },
              },
            },
          };
        `,
      },
    ]);

    expect(JSON.parse(JSON.stringify(theme))).toEqual({
      extend: { colors: { safe: '#fff' } },
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('supports CommonJS and TypeScript satisfies wrappers without executing either', async () => {
    const commonJs = await extractSafeTailwindTheme([
      {
        path: 'tailwind.config.cjs',
        content: `module.exports = { theme: { extend: { spacing: { 18: '4.5rem' } } } };`,
      },
    ]);
    const typescript = await extractSafeTailwindTheme([
      {
        path: 'tailwind.config.ts',
        content: `export default { theme: { extend: { colors: { clay: '#B89B7A' } } } } satisfies Config;`,
      },
    ]);

    expect(JSON.parse(JSON.stringify(commonJs))).toEqual({
      extend: { spacing: { 18: '4.5rem' } },
    });
    expect(JSON.parse(JSON.stringify(typescript))).toEqual({
      extend: { colors: { clay: '#B89B7A' } },
    });
  });

  it('rejects oversized configuration before parsing', async () => {
    await expect(
      extractSafeTailwindTheme([
        {
          path: 'tailwind.config.js',
          content: `export default { theme: {} };/*${'x'.repeat(256 * 1024)}*/`,
        },
      ])
    ).resolves.toBeNull();
  });
});
