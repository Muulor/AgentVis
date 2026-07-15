/** Hub selection hydration and stale Agent-list response regressions. */

import { describe, expect, it } from 'vitest';
import { resolveInitialHubId, shouldApplyAgentLoadResult } from '../useDataLoader';

describe('useDataLoader Agent list request guard', () => {
  it('applies only the latest request for the active Hub', () => {
    expect(
      shouldApplyAgentLoadResult({
        requestedHubId: 'hub-2',
        activeHubId: 'hub-2',
        requestGeneration: 4,
        latestGeneration: 4,
      })
    ).toBe(true);
  });

  it('rejects a late response after the user switches to another Hub', () => {
    expect(
      shouldApplyAgentLoadResult({
        requestedHubId: 'hub-1',
        activeHubId: 'hub-2',
        requestGeneration: 3,
        latestGeneration: 4,
      })
    ).toBe(false);
  });

  it('rejects an older request even after the user switches back to its Hub', () => {
    expect(
      shouldApplyAgentLoadResult({
        requestedHubId: 'hub-1',
        activeHubId: 'hub-1',
        requestGeneration: 2,
        latestGeneration: 5,
      })
    ).toBe(false);
  });

  it('preserves a valid Hub selected by notification activation during hydration', () => {
    const hubs = [{ id: 'hub-1' }, { id: 'hub-2' }];

    expect(resolveInitialHubId(hubs, 'hub-2')).toBe('hub-2');
    expect(resolveInitialHubId(hubs, 'deleted-hub')).toBe('hub-1');
  });
});
