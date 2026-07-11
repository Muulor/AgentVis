import { describe, expect, it } from 'vitest';
import {
  getMissingDirectoryRecoveryPath,
  getParentDirectoryPath,
  isPathMissingError,
} from '../FileListPathRecovery';

describe('FileListPathRecovery', () => {
  it.each([
    ['scraped_content', ''],
    ['scraped_content/images', 'scraped_content'],
    ['scraped_content\\images\\raw', 'scraped_content/images'],
    [' /scraped_content/images/ ', 'scraped_content'],
  ])('returns parent path for %s', (input, expected) => {
    expect(getParentDirectoryPath(input)).toBe(expected);
  });

  it.each([
    new Error('Path does not exist: The system cannot find the file specified. (os error 2)'),
    'Path does not exist: 系统找不到指定的文件。 (os error 2)',
    'failed to read directory: 系统找不到指定的路径。 (os error 3)',
    'Project directory does not exist: C:\\missing',
  ])('detects missing path errors', (error) => {
    expect(isPathMissingError(error)).toBe(true);
  });

  it('does not treat unrelated errors as missing path errors', () => {
    expect(
      isPathMissingError(
        new Error('Invalid path: access outside the deliverables root is not allowed')
      )
    ).toBe(false);
  });

  it('recovers non-root missing paths to their parent directory', () => {
    const error = new Error('Path does not exist: os error 2');

    expect(getMissingDirectoryRecoveryPath('scraped_content/images', error)).toBe(
      'scraped_content'
    );
    expect(getMissingDirectoryRecoveryPath('scraped_content', error)).toBe('');
  });

  it('does not recover root or non-missing errors', () => {
    expect(
      getMissingDirectoryRecoveryPath('', new Error('Path does not exist: os error 2'))
    ).toBeNull();
    expect(
      getMissingDirectoryRecoveryPath('scraped_content', new Error('Permission denied'))
    ).toBeNull();
  });
});
