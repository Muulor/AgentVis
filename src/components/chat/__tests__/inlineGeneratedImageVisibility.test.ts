import { describe, expect, it } from 'vitest';
import {
  addUnavailableImagePath,
  getAdjacentImagePath,
  getDisplayableImagePaths,
  getImageGalleryNavigationState,
  resolveActiveImagePath,
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

  it('preserves the selected image or falls back after that image becomes unavailable', () => {
    const paths = ['first.png', 'second.png', 'third.png'];

    expect(resolveActiveImagePath(paths, 'second.png')).toBe('second.png');
    expect(resolveActiveImagePath(['first.png', 'third.png'], 'second.png')).toBe('first.png');
    expect(resolveActiveImagePath([], 'second.png')).toBeNull();
  });

  it('moves between adjacent images without crossing the gallery boundaries', () => {
    const paths = ['first.png', 'second.png', 'third.png'];

    expect(getAdjacentImagePath(paths, 'second.png', -1)).toBe('first.png');
    expect(getAdjacentImagePath(paths, 'second.png', 1)).toBe('third.png');
    expect(getAdjacentImagePath(paths, 'first.png', -1)).toBe('first.png');
    expect(getAdjacentImagePath(paths, 'third.png', 1)).toBe('third.png');
  });

  it('hides navigation for one image and reports the correct multi-image position', () => {
    expect(getImageGalleryNavigationState(['only.png'], 'only.png')).toEqual({
      activePath: 'only.png',
      currentIndex: 0,
      totalCount: 1,
      hasPrevious: false,
      hasNext: false,
    });
    expect(
      getImageGalleryNavigationState(['first.png', 'second.png', 'third.png'], 'second.png')
    ).toEqual({
      activePath: 'second.png',
      currentIndex: 1,
      totalCount: 3,
      hasPrevious: true,
      hasNext: true,
    });
  });
});
