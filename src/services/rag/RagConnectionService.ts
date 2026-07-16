/**
 * High-level activation and connection-test API for RAG settings UI.
 *
 * The UI keeps drafts locally and calls this service only after confirmation.
 * A changed embedding profile is committed before per-Agent migration; partial
 * failures therefore remain profile-safe and are explicitly retryable.
 */

import { useSettingsStore } from '@/stores/settingsStore';
import {
  assertValidRagConnectionSettings,
  getRagConnectionSettingsSnapshot,
  normalizeRagConnectionSettings,
  isCustomEmbeddingConfigValid,
  isCustomRerankerConfigValid,
  resolveRagEmbeddingRoute,
  resolveRagRerankerRoute,
  type RagConnectionSettingsInput,
} from './RagConnectionConfig';
import { embeddingService, type EmbeddingConnectionTestResult } from './EmbeddingService';
import { rerankService, type RerankConnectionTestResult } from './RerankService';
import {
  ragIndexRebuildService,
  RagIndexRebuildError,
  type RagIndexRebuildOptions,
  type RagIndexRebuildProgress,
  type RagIndexRebuildResult,
} from './RagIndexRebuildService';
import { ragIndexCoordinator, type RagIndexMigrationLease } from './RagIndexCoordinator';

export interface RagActivationOptions {
  onProgress?: (progress: RagIndexRebuildProgress) => void;
  /** Recheck the target embedding immediately before changing active settings. */
  testEmbedding?: boolean;
  /** Dimension returned by a still-current UI connection test. */
  expectedEmbeddingDimension?: number;
}

export interface RagActivationResult {
  settingsApplied: true;
  embeddingProfileChanged: boolean;
  previousProfileId: string;
  activeProfileId: string;
  rebuild: RagIndexRebuildResult | null;
}

let activationInProgress = false;

export class RagConnectionActivationError extends Error {
  readonly settingsApplied: boolean;
  readonly activeProfileId: string;
  readonly progress?: RagIndexRebuildProgress;
  override readonly cause: unknown;

  constructor(options: {
    settingsApplied: boolean;
    activeProfileId: string;
    progress?: RagIndexRebuildProgress;
    cause: unknown;
  }) {
    super(options.settingsApplied ? 'RAG_ACTIVATION_REBUILD_FAILED' : 'RAG_ACTIVATION_TEST_FAILED');
    this.name = 'RagConnectionActivationError';
    this.settingsApplied = options.settingsApplied;
    this.activeProfileId = options.activeProfileId;
    this.progress = options.progress;
    this.cause = options.cause;
  }
}

export async function testRagEmbeddingConnection(
  next: RagConnectionSettingsInput
): Promise<EmbeddingConnectionTestResult> {
  if (
    next.ragServiceMode === 'custom' &&
    !isCustomEmbeddingConfigValid(next.customEmbeddingConfig)
  ) {
    throw new Error('RAG_CUSTOM_EMBEDDING_CONFIG_INVALID');
  }
  const normalized = normalizeRagConnectionSettings(next);
  return embeddingService.testConnection(resolveRagEmbeddingRoute(normalized));
}

export async function testRagRerankerConnection(
  next: RagConnectionSettingsInput
): Promise<RerankConnectionTestResult> {
  if (next.ragServiceMode === 'custom' && !isCustomRerankerConfigValid(next.customRerankerConfig)) {
    throw new Error('RAG_CUSTOM_RERANKER_CONFIG_INVALID');
  }
  const normalized = normalizeRagConnectionSettings(next);
  const route = resolveRagRerankerRoute(normalized);
  if (!route.enabled) throw new Error('RAG_RERANK_DISABLED');
  return rerankService.testConnection(route);
}

export async function activateRagConnection(
  next: RagConnectionSettingsInput,
  options: RagActivationOptions = {}
): Promise<RagActivationResult> {
  if (activationInProgress || ragIndexRebuildService.isRunning()) {
    throw new Error('RAG_CONNECTION_ACTIVATION_IN_PROGRESS');
  }
  activationInProgress = true;
  let migrationLease: RagIndexMigrationLease | undefined;
  try {
    assertValidRagConnectionSettings(next);
    const normalized = normalizeRagConnectionSettings(next);
    const previous = getRagConnectionSettingsSnapshot();
    const previousProfileId = resolveRagEmbeddingRoute(previous).profileId;
    const targetRoute = resolveRagEmbeddingRoute(normalized);
    const embeddingProfileChanged = previousProfileId !== targetRoute.profileId;
    let expectedEmbeddingDimension = options.expectedEmbeddingDimension;

    if (embeddingProfileChanged && options.testEmbedding !== false) {
      try {
        const testResult = await embeddingService.testConnection(targetRoute);
        expectedEmbeddingDimension = testResult.dimension;
      } catch (cause) {
        throw new RagConnectionActivationError({
          settingsApplied: false,
          activeProfileId: previousProfileId,
          cause,
        });
      }
    }

    if (ragIndexRebuildService.isRunning()) {
      throw new Error('RAG_CONNECTION_ACTIVATION_IN_PROGRESS');
    }
    migrationLease = await ragIndexCoordinator.acquireMigration();
    if (ragIndexRebuildService.isRunning()) {
      throw new Error('RAG_CONNECTION_ACTIVATION_IN_PROGRESS');
    }
    useSettingsStore.getState().setRagConnectionSettings({
      mode: normalized.ragServiceMode,
      embedding: normalized.customEmbeddingConfig,
      reranker: normalized.customRerankerConfig,
    });

    if (!embeddingProfileChanged) {
      return {
        settingsApplied: true,
        embeddingProfileChanged: false,
        previousProfileId,
        activeProfileId: targetRoute.profileId,
        rebuild: null,
      };
    }

    try {
      const rebuild = await ragIndexRebuildService.rebuildAll({
        route: targetRoute,
        onProgress: options.onProgress,
        expectedDimension: expectedEmbeddingDimension,
        migrationLease,
      });
      return {
        settingsApplied: true,
        embeddingProfileChanged: true,
        previousProfileId,
        activeProfileId: targetRoute.profileId,
        rebuild,
      };
    } catch (cause) {
      throw new RagConnectionActivationError({
        settingsApplied: true,
        activeProfileId: targetRoute.profileId,
        progress: cause instanceof RagIndexRebuildError ? cause.progress : undefined,
        cause,
      });
    }
  } finally {
    migrationLease?.release();
    activationInProgress = false;
  }
}

export function retryActiveRagIndexRebuild(
  options: Pick<RagIndexRebuildOptions, 'onProgress'> = {}
): Promise<RagIndexRebuildResult> {
  if (activationInProgress) {
    return Promise.reject(new Error('RAG_CONNECTION_ACTIVATION_IN_PROGRESS'));
  }
  return ragIndexRebuildService.rebuildAll({
    route: resolveRagEmbeddingRoute(),
    onProgress: options.onProgress,
  });
}

export type { RagIndexRebuildProgress };
