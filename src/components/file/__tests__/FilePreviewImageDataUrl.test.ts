import { describe, expect, it } from 'vitest';
import { createImageDataUrl } from '../FilePreviewImageDataUrl';

describe('FilePreviewImageDataUrl', () => {
    it('creates a data URL when base64 data is present', () => {
        expect(createImageDataUrl('image/png', 'aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=');
    });

    it.each(['', '   ', '\n\t'])('returns null for empty base64 data', (base64) => {
        expect(createImageDataUrl('image/png', base64)).toBeNull();
    });
});
