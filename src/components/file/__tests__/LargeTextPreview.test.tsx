import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@components/ui';
import { LargeTextPreview } from '../LargeTextPreview';
import {
  createInlineTextWindow,
  TEXT_PREVIEW_WINDOW_BYTES,
  type TextPreviewDecision,
} from '../TextPreviewPolicy';

function renderPreview(decision: TextPreviewDecision): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TooltipProvider>
        <LargeTextPreview
          fileName="large.md"
          filePath="C:\\workspace\\large.md"
          fileSize={decision.size}
          decision={decision}
        />
      </TooltipProvider>
    </I18nProvider>
  );
}

describe('LargeTextPreview', () => {
  it('paginates inline content by UTF-8 bytes without splitting a character', () => {
    const content = `${'a'.repeat(TEXT_PREVIEW_WINDOW_BYTES - 1)}😀tail`;
    const bytes = new TextEncoder().encode(content);
    const first = createInlineTextWindow(bytes, 0);
    const second = createInlineTextWindow(bytes, first.nextByte);

    expect(new TextEncoder().encode(first.content).length).toBeLessThanOrEqual(
      TEXT_PREVIEW_WINDOW_BYTES
    );
    expect(first.nextByte).toBe(TEXT_PREVIEW_WINDOW_BYTES - 1);
    expect(first.totalBytes).toBe(bytes.length);
    expect(`${first.content}${second.content}`).toBe(content);
    expect(second.eof).toBe(true);
  });

  it('keeps files over the hard limit external-first', () => {
    const html = renderPreview({
      kind: 'markdown',
      mode: 'external',
      reason: 'hardLimit',
      size: 9 * 1024 * 1024,
    });

    expect(html).toContain('large.md');
    expect(html).toContain('安全预览');
    expect(html).toContain('系统打开');
    expect(html).not.toContain('预览第 1 页');
  });

  it('opens bounded pagination immediately in safe mode', () => {
    const html = renderPreview({
      kind: 'markdown',
      mode: 'safe',
      reason: 'fileSize',
      size: 640 * 1024,
    });

    expect(html).toContain('预览第 1 页');
    expect(html).toContain('查看源码');
  });
});
