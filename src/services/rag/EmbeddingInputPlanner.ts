/**
 * EmbeddingInputPlanner - final embedding input windowing and aggregation.
 *
 * Provider limits apply to the final text after metadata enrichment, not only
 * to the source chunk. This module keeps every remote document input bounded
 * while preserving one persisted vector per logical chunk or memory record.
 */

import type { ChunkMetadata } from '@/types/rag';

export const EMBEDDING_INPUT_MAX_UTF8_BYTES = 6 * 1024;
export const EMBEDDING_INPUT_OVERLAP_UTF8_BYTES = 512;
export const EMBEDDING_INPUT_AGGREGATION_VERSION = 'utf8-window-weighted-v1';

const utf8Encoder = new TextEncoder();

export interface EmbeddingInputWindow {
  text: string;
  effectiveUtf8Bytes: number;
}

export interface EmbeddingInputPlan {
  windows: EmbeddingInputWindow[];
  windowed: boolean;
}

export interface EmbeddingInputResult {
  embedding: number[];
  segmentCount: number;
}

export interface EncodeEmbeddingInputsOptions {
  expectedDimension?: number;
  /** Preserve a caller-specific internal error namespace. */
  errorPrefix?: string;
}

type EmbeddingBatchEncoder = (texts: string[]) => Promise<number[][]>;

export function isEmbeddingAggregationMetadataStale(
  text: string,
  metadata: ChunkMetadata
): boolean {
  const plan = buildEmbeddingInputPlan(text);
  if (!plan.windowed) {
    return (
      metadata.embeddingAggregationVersion !== undefined ||
      metadata.embeddingSegmentCount !== undefined
    );
  }

  return (
    metadata.embeddingAggregationVersion !== EMBEDDING_INPUT_AGGREGATION_VERSION ||
    metadata.embeddingSegmentCount !== plan.windows.length
  );
}

export function withEmbeddingAggregationMetadata(
  metadata: ChunkMetadata,
  segmentCount: number
): ChunkMetadata {
  const nextMetadata = { ...metadata };
  delete nextMetadata.embeddingAggregationVersion;
  delete nextMetadata.embeddingSegmentCount;

  if (segmentCount > 1) {
    nextMetadata.embeddingAggregationVersion = EMBEDDING_INPUT_AGGREGATION_VERSION;
    nextMetadata.embeddingSegmentCount = segmentCount;
  }

  return nextMetadata;
}

export async function encodeEmbeddingInputs(
  texts: string[],
  encodeBatch: EmbeddingBatchEncoder,
  options: EncodeEmbeddingInputsOptions = {}
): Promise<EmbeddingInputResult[]> {
  if (texts.length === 0) return [];

  const errorPrefix = options.errorPrefix ?? 'RAG_EMBEDDING_INPUT';
  const plans = texts.map((text) => buildEmbeddingInputPlan(text, errorPrefix));
  const expandedTexts = plans.flatMap((plan) => plan.windows.map((window) => window.text));
  const expandedEmbeddings = await encodeBatch(expandedTexts);

  if (expandedEmbeddings.length !== expandedTexts.length) {
    throw plannerError(errorPrefix, 'EMBEDDING_RESULT_COUNT_MISMATCH');
  }

  const firstEmbedding = expandedEmbeddings[0];
  if (!firstEmbedding) {
    throw plannerError(errorPrefix, 'EMBEDDING_MISSING');
  }
  const resolvedDimension = options.expectedDimension ?? firstEmbedding.length;
  if (!Number.isInteger(resolvedDimension) || resolvedDimension <= 0) {
    throw plannerError(errorPrefix, 'EMBEDDING_DIMENSION_MISMATCH');
  }
  for (const embedding of expandedEmbeddings) {
    assertValidEmbedding(embedding, resolvedDimension, errorPrefix);
  }

  const results: EmbeddingInputResult[] = [];
  let embeddingOffset = 0;

  for (const plan of plans) {
    const windowEmbeddings = expandedEmbeddings.slice(
      embeddingOffset,
      embeddingOffset + plan.windows.length
    );
    embeddingOffset += plan.windows.length;
    if (windowEmbeddings.length !== plan.windows.length) {
      throw plannerError(errorPrefix, 'EMBEDDING_MISSING');
    }

    const directEmbedding = windowEmbeddings[0];
    if (!directEmbedding) {
      throw plannerError(errorPrefix, 'EMBEDDING_MISSING');
    }
    results.push({
      embedding: plan.windowed
        ? aggregateWindowEmbeddings(plan.windows, windowEmbeddings, resolvedDimension, errorPrefix)
        : directEmbedding,
      segmentCount: plan.windows.length,
    });
  }

  if (embeddingOffset !== expandedEmbeddings.length) {
    throw plannerError(errorPrefix, 'EMBEDDING_RESULT_COUNT_MISMATCH');
  }
  return results;
}

export function buildEmbeddingInputPlan(
  text: string,
  errorPrefix = 'RAG_EMBEDDING_INPUT'
): EmbeddingInputPlan {
  const totalUtf8Bytes = utf8Encoder.encode(text).byteLength;
  if (totalUtf8Bytes <= EMBEDDING_INPUT_MAX_UTF8_BYTES) {
    return {
      windows: [{ text, effectiveUtf8Bytes: totalUtf8Bytes }],
      windowed: false,
    };
  }

  const windows: EmbeddingInputWindow[] = [];
  let windowStart = 0;
  let coveredEnd = 0;

  while (windowStart < text.length) {
    const codePoints: Array<{ start: number; end: number; utf8Bytes: number }> = [];
    let windowEnd = windowStart;
    let windowUtf8Bytes = 0;

    for (const codePoint of text.slice(windowStart)) {
      const codePointUtf8Bytes = utf8Encoder.encode(codePoint).byteLength;
      if (
        windowUtf8Bytes + codePointUtf8Bytes > EMBEDDING_INPUT_MAX_UTF8_BYTES &&
        codePoints.length > 0
      ) {
        break;
      }
      const codePointStart = windowEnd;
      windowEnd += codePoint.length;
      windowUtf8Bytes += codePointUtf8Bytes;
      codePoints.push({
        start: codePointStart,
        end: windowEnd,
        utf8Bytes: codePointUtf8Bytes,
      });
    }

    if (codePoints.length === 0 || windowEnd <= windowStart) {
      throw plannerError(errorPrefix, 'WINDOW_SPLIT_FAILED');
    }

    const effectiveUtf8Bytes = codePoints.reduce(
      (sum, codePoint) => sum + (codePoint.start >= coveredEnd ? codePoint.utf8Bytes : 0),
      0
    );
    if (effectiveUtf8Bytes <= 0) {
      throw plannerError(errorPrefix, 'WINDOW_EFFECTIVE_LENGTH_INVALID');
    }
    windows.push({
      text: text.slice(windowStart, windowEnd),
      effectiveUtf8Bytes,
    });
    coveredEnd = windowEnd;
    if (windowEnd >= text.length) break;

    let nextWindowStart = windowEnd;
    let overlapUtf8Bytes = 0;
    for (let index = codePoints.length - 1; index >= 0; index--) {
      const codePoint = codePoints[index];
      if (!codePoint) continue;
      if (overlapUtf8Bytes + codePoint.utf8Bytes > EMBEDDING_INPUT_OVERLAP_UTF8_BYTES) {
        break;
      }
      overlapUtf8Bytes += codePoint.utf8Bytes;
      nextWindowStart = codePoint.start;
    }
    if (nextWindowStart <= windowStart || nextWindowStart >= windowEnd) {
      throw plannerError(errorPrefix, 'WINDOW_OVERLAP_INVALID');
    }
    windowStart = nextWindowStart;
  }

  const effectiveByteTotal = windows.reduce((sum, window) => sum + window.effectiveUtf8Bytes, 0);
  if (effectiveByteTotal !== totalUtf8Bytes) {
    throw plannerError(errorPrefix, 'WINDOW_COVERAGE_MISMATCH');
  }
  return { windows, windowed: true };
}

function aggregateWindowEmbeddings(
  windows: EmbeddingInputWindow[],
  embeddings: number[][],
  expectedDimension: number,
  errorPrefix: string
): number[] {
  const totalWeight = windows.reduce((sum, window) => sum + window.effectiveUtf8Bytes, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw plannerError(errorPrefix, 'AGGREGATION_WEIGHT_INVALID');
  }

  const aggregate = Array<number>(expectedDimension).fill(0);
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    const window = windows[windowIndex];
    const embedding = embeddings[windowIndex];
    if (!window || !embedding) {
      throw plannerError(errorPrefix, 'EMBEDDING_MISSING');
    }
    const normalizedWeight = window.effectiveUtf8Bytes / totalWeight;
    const embeddingNorm = embedding.reduce(
      (currentNorm, value) => Math.hypot(currentNorm, value),
      0
    );
    if (!Number.isFinite(embeddingNorm) || embeddingNorm <= 0) {
      throw plannerError(errorPrefix, 'WINDOW_EMBEDDING_NORM_INVALID');
    }
    for (let dimension = 0; dimension < expectedDimension; dimension++) {
      const value = embedding[dimension];
      if (value === undefined) {
        throw plannerError(errorPrefix, 'EMBEDDING_DIMENSION_MISMATCH');
      }
      aggregate[dimension] =
        (aggregate[dimension] ?? 0) + (value / embeddingNorm) * normalizedWeight;
    }
  }

  if (aggregate.some((value) => !Number.isFinite(value))) {
    throw plannerError(errorPrefix, 'AGGREGATED_EMBEDDING_NOT_FINITE');
  }
  const norm = aggregate.reduce((currentNorm, value) => Math.hypot(currentNorm, value), 0);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw plannerError(errorPrefix, 'AGGREGATED_EMBEDDING_NORM_INVALID');
  }
  return aggregate.map((value) => value / norm);
}

function assertValidEmbedding(
  embedding: number[],
  expectedDimension: number,
  errorPrefix: string
): void {
  if (embedding.length !== expectedDimension) {
    throw plannerError(errorPrefix, 'EMBEDDING_DIMENSION_MISMATCH');
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw plannerError(errorPrefix, 'EMBEDDING_NOT_FINITE');
  }
}

function plannerError(prefix: string, suffix: string): Error {
  return new Error(`${prefix}_${suffix}`);
}
