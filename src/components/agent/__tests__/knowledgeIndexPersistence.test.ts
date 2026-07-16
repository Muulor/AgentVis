import { describe, expect, it } from 'vitest';

import {
  getPersistedKnowledgeIndexStatuses,
  getPersistedKnowledgePaths,
} from '../knowledgeIndexPersistence';

describe('getPersistedKnowledgePaths', () => {
  it('keeps existing and newly successful files while excluding failed files', () => {
    const failedPaths = new Set(['C:\\docs\\large.md']);

    expect(
      getPersistedKnowledgePaths(
        ['C:\\docs\\existing.md', 'C:\\docs\\large.md', 'C:\\docs\\small.md'],
        failedPaths
      )
    ).toEqual(['C:\\docs\\existing.md', 'C:\\docs\\small.md']);
  });

  it('allows a previously failed file to be persisted after a successful retry', () => {
    expect(getPersistedKnowledgePaths(['C:\\docs\\large.md'], new Set())).toEqual([
      'C:\\docs\\large.md',
    ]);
  });

  it('does not persist duplicate paths', () => {
    expect(
      getPersistedKnowledgePaths(['C:\\docs\\same.md', 'C:\\docs\\same.md'], new Set())
    ).toEqual(['C:\\docs\\same.md']);
  });
});

describe('getPersistedKnowledgeIndexStatuses', () => {
  it('does not treat a persisted path without vectors as successfully indexed', () => {
    expect(
      getPersistedKnowledgeIndexStatuses(
        ['C:\\docs\\missing.md', 'C:\\docs\\indexed.md'],
        new Set(['C:\\docs\\indexed.md'])
      )
    ).toEqual({
      'C:\\docs\\missing.md': 'error',
      'C:\\docs\\indexed.md': 'indexed',
    });
  });
});
