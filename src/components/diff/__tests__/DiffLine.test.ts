import { describe, expect, it } from 'vitest';
import {
  buildDiffLinePreview,
  buildExpandedDiffLinePreview,
  MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS,
  MAX_RENDERED_DIFF_LINE_CHARS,
} from '../DiffLinePreview';

describe('DiffLine long-line preview', () => {
  it('keeps regular lines intact', () => {
    expect(buildDiffLinePreview('const value = 1;')).toEqual({
      isTruncated: false,
      leading: 'const value = 1;',
      trailing: '',
      omittedChars: 0,
    });
  });

  it('bounds the initially rendered text for an extremely long line', () => {
    const content = `HEAD${'x'.repeat(MAX_RENDERED_DIFF_LINE_CHARS * 7)}TAIL`;
    const preview = buildDiffLinePreview(content);

    expect(preview.isTruncated).toBe(true);
    expect(preview.leading).toHaveLength(1024);
    expect(preview.trailing).toHaveLength(1024);
    expect(preview.leading.startsWith('HEAD')).toBe(true);
    expect(preview.trailing.endsWith('TAIL')).toBe(true);
    expect(preview.leading.length + preview.trailing.length).toBeLessThan(
      MAX_RENDERED_DIFF_LINE_CHARS
    );
    expect(preview.omittedChars).toBe(content.length - 2048);
  });

  it('does not split an emoji at either preview boundary', () => {
    const leadingBoundaryContent = `${'a'.repeat(1023)}😀${'x'.repeat(MAX_RENDERED_DIFF_LINE_CHARS)}`;
    const trailingBoundaryContent = `${'x'.repeat(MAX_RENDERED_DIFF_LINE_CHARS)}😀${'b'.repeat(1023)}`;

    const leadingBoundaryPreview = buildDiffLinePreview(leadingBoundaryContent);
    const trailingBoundaryPreview = buildDiffLinePreview(trailingBoundaryContent);

    expect(leadingBoundaryPreview.leading).toBe('a'.repeat(1023));
    expect(leadingBoundaryPreview.leading.at(-1)?.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xd800);
    expect(trailingBoundaryPreview.trailing).toBe('b'.repeat(1023));
    expect(trailingBoundaryPreview.trailing.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(
      leadingBoundaryPreview.leading.length +
        leadingBoundaryPreview.trailing.length +
        leadingBoundaryPreview.omittedChars
    ).toBe(leadingBoundaryContent.length);
    expect(
      trailingBoundaryPreview.leading.length +
        trailingBoundaryPreview.trailing.length +
        trailingBoundaryPreview.omittedChars
    ).toBe(trailingBoundaryContent.length);
  });

  it('keeps explicit expansion bounded for pathological lines', () => {
    const content = `HEAD${'x'.repeat(MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS * 3)}TAIL`;
    const preview = buildExpandedDiffLinePreview(content);

    expect(preview.isTruncated).toBe(true);
    expect(preview.leading.length + preview.trailing.length).toBeLessThanOrEqual(
      MAX_EXPANDED_RENDERED_DIFF_LINE_CHARS
    );
    expect(preview.leading.startsWith('HEAD')).toBe(true);
    expect(preview.trailing.endsWith('TAIL')).toBe(true);
    expect(preview.leading.length + preview.trailing.length + preview.omittedChars).toBe(
      content.length
    );
  });

  it('still expands the original 57 KiB scenario in full', () => {
    const content = 'x'.repeat(57 * 1024);

    expect(buildExpandedDiffLinePreview(content)).toEqual({
      isTruncated: false,
      leading: content,
      trailing: '',
      omittedChars: 0,
    });
  });
});
