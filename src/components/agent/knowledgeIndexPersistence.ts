/**
 * Knowledge index persistence helpers.
 *
 * Keep the Agent's persisted knowledge path list aligned with files whose
 * vector indexing actually completed. Failed paths stay in the modal state so
 * they can be retried, but must not be restored as successfully indexed later.
 */

export function getPersistedKnowledgePaths(
  selectedPaths: readonly string[],
  failedPaths: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();

  return selectedPaths.filter((path) => {
    if (failedPaths.has(path) || seen.has(path)) {
      return false;
    }

    seen.add(path);
    return true;
  });
}

export function getPersistedKnowledgeIndexStatuses(
  persistedPaths: readonly string[],
  indexedDocumentIds: ReadonlySet<string>
): Record<string, 'indexed' | 'error'> {
  return Object.fromEntries(
    persistedPaths.map((path) => [path, indexedDocumentIds.has(path) ? 'indexed' : 'error'])
  );
}
