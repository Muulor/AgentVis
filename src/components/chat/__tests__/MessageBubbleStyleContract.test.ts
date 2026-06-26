import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readCss(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function cssBlock(css: string, selector: string): string {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) {
        throw new Error(`Missing selector: ${selector}`);
    }

    const end = css.indexOf('\n}', start);
    return end < 0 ? css.slice(start) : css.slice(start, end);
}

describe('chat visual style contracts', () => {
    it('keeps the explicit exec timeout countdown numerals stable', () => {
        const css = readCss('../fsm-visualization/components/HitlInterventionBar.module.css');

        expect(cssBlock(css, '.timeoutText')).toContain('font-variant-numeric: tabular-nums');
    });

    it('allows inline skill and file chips to wrap instead of truncating after one line', () => {
        const css = readCss('../MessageBubble.module.css');
        const chipBlock = cssBlock(css, '.inlineTokenChip');
        const labelBlock = cssBlock(css, '.inlineTokenChip span');

        expect(chipBlock).toMatch(/max-width:\s*min\(100%,\s*640px\)/);
        expect(labelBlock).toContain('-webkit-line-clamp: 3');
        expect(labelBlock).toContain('white-space: normal');
        expect(labelBlock).not.toContain('text-overflow: ellipsis');
    });

    it('keeps wide user messages from stretching into empty tails', () => {
        const css = readCss('../MessageBubble.module.css');

        expect(cssBlock(css, '.userBubble')).toContain('max-width: min(85%, 820px)');
        expect(cssBlock(css, '.userBubble .content')).toContain('overflow-wrap: anywhere');
        expect(cssBlock(css, '.userBubble .content')).toContain('text-wrap: pretty');
    });
});
