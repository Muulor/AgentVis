/**
 * EmbeddingInputPlanner final-input windowing and metadata tests.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_INPUT_AGGREGATION_VERSION,
  EMBEDDING_INPUT_MAX_UTF8_BYTES,
  buildEmbeddingInputPlan,
  encodeEmbeddingInputs,
  isEmbeddingAggregationMetadataStale,
  withEmbeddingAggregationMetadata,
} from '../EmbeddingInputPlanner';

describe('EmbeddingInputPlanner', () => {
  it('keeps a short provider vector unchanged and clears stale aggregation metadata', async () => {
    const providerVector = [3, 4];
    const encodeBatch = vi.fn().mockResolvedValue([providerVector]);

    const results = await encodeEmbeddingInputs(['short input'], encodeBatch);

    expect(results).toEqual([{ embedding: providerVector, segmentCount: 1 }]);
    expect(encodeBatch).toHaveBeenCalledWith(['short input']);
    expect(
      withEmbeddingAggregationMetadata(
        {
          embeddingAggregationVersion: EMBEDDING_INPUT_AGGREGATION_VERSION,
          embeddingSegmentCount: 3,
        },
        1
      )
    ).toEqual({});
  });

  it('creates Unicode-safe physical windows and records the exact current segment count', async () => {
    const text = Array.from(
      { length: 1_100 },
      (_, index) => `${index.toString(36).padStart(4, '0')}汉🙂|`
    ).join('');
    const plan = buildEmbeddingInputPlan(text);
    const encodeBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));

    const [result] = await encodeEmbeddingInputs([text], encodeBatch);

    expect(plan.windowed).toBe(true);
    expect(plan.windows.length).toBeGreaterThan(1);
    for (const window of plan.windows) {
      expect(new TextEncoder().encode(window.text).byteLength).toBeLessThanOrEqual(
        EMBEDDING_INPUT_MAX_UTF8_BYTES
      );
      expect(window.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(window.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
    expect(result).toEqual({ embedding: [1, 0], segmentCount: plan.windows.length });

    const metadata = withEmbeddingAggregationMetadata({}, plan.windows.length);
    expect(metadata).toEqual({
      embeddingAggregationVersion: EMBEDDING_INPUT_AGGREGATION_VERSION,
      embeddingSegmentCount: plan.windows.length,
    });
    expect(isEmbeddingAggregationMetadataStale(text, metadata)).toBe(false);
    expect(
      isEmbeddingAggregationMetadataStale(text, {
        ...metadata,
        embeddingSegmentCount: plan.windows.length + 1,
      })
    ).toBe(true);
  });

  it('treats aggregation metadata on a short input as stale', () => {
    expect(
      isEmbeddingAggregationMetadataStale('short input', {
        embeddingAggregationVersion: EMBEDDING_INPUT_AGGREGATION_VERSION,
        embeddingSegmentCount: 2,
      })
    ).toBe(true);
  });
});
