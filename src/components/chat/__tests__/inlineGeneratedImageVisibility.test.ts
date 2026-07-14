import { describe, expect, it } from 'vitest';
import {
  addUnavailableImagePath,
  getDisplayableImagePaths,
} from '../inlineGeneratedImageVisibility';

describe('inline generated image visibility', () => {
  it('removes a missing local image while preserving readable siblings', () => {
    const unavailablePaths = addUnavailableImagePath(new Set<string>(), 'D:\\project\\deleted.png');

    expect(
      getDisplayableImagePaths(
        ['D:\\project\\available.png', 'D:\\project\\deleted.png'],
        unavailablePaths
      )
    ).toEqual(['D:\\project\\available.png']);
  });

  it('returns an empty list when every generated image is unavailable', () => {
    const unavailablePaths = new Set(['D:\\project\\deleted-1.png', 'D:\\project\\deleted-2.png']);

    expect(getDisplayableImagePaths([...unavailablePaths], unavailablePaths)).toEqual([]);
  });

  it('keeps repeated failure reports idempotent and does not hide new paths', () => {
    const first = addUnavailableImagePath(new Set<string>(), 'D:\\project\\deleted.png');
    const repeated = addUnavailableImagePath(first, 'D:\\project\\deleted.png');

    expect(repeated).toBe(first);
    expect(getDisplayableImagePaths(['D:\\project\\new.png'], repeated)).toEqual([
      'D:\\project\\new.png',
    ]);
  });
});
