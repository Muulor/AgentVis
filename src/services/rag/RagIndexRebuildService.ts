/**
 * Rebuilds every persisted RAG and memory vector for one embedding profile.
 *
 * Each provider-sized checkpoint is committed with one Rust transaction.
 * Configuration activation happens before migration, so an interrupted rebuild
 * remains safe: old rows are excluded by profile and callers resume from the
 * last persisted checkpoint while BM25 continues working.
 */

import { getLogger } from '@services/logger';
import { clearAnchorCache } from '../memory/SemanticAnchors';
import { embeddingService } from './EmbeddingService';
import { buildEmbeddingIndexText } from './RagQueryPreprocessor';
import {
  getActiveEmbeddingProfileId,
  resolveRagEmbeddingRoute,
  type ResolvedEmbeddingRoute,
} from './RagConnectionConfig';
import { getVectorStore, type ChunkEmbeddingUpdate, type VectorStore } from './VectorStore';
import type { Chunk } from '@/types/rag';
import { ragIndexCoordinator, type RagIndexMigrationLease } from './RagIndexCoordinator';
import {
  encodeEmbeddingInputs,
  isEmbeddingAggregationMetadataStale,
  withEmbeddingAggregationMetadata,
  type EmbeddingInputResult,
} from './EmbeddingInputPlanner';

const logger = getLogger('RagIndexRebuildService');
/**
 * Persist after every 25 original logical chunks. A legacy oversized chunk may
 * expand into several provider windows, but successful logical batches still
 * become restart-safe before the rebuild advances to the next checkpoint.
 */
const REBUILD_CHECKPOINT_BATCH_SIZE = 25;

export type RagIndexRebuildPhase = 'discovering' | 'embedding' | 'updating' | 'complete';

export interface RagIndexRebuildProgress {
  phase: RagIndexRebuildPhase;
  agentId?: string;
  completedChunks: number;
  totalChunks: number;
  completedAgents: number;
  totalAgents: number;
}

export interface RagIndexRebuildResult {
  profileId: string;
  rebuiltChunkCount: number;
  skippedChunkCount: number;
  rebuiltAgentCount: number;
  totalAgentCount: number;
}

export interface RagIndexRebuildOptions {
  route?: ResolvedEmbeddingRoute;
  onProgress?: (progress: RagIndexRebuildProgress) => void;
  /** Dimension observed by the connection test for this exact route. */
  expectedDimension?: number;
  /** Existing exclusive lease held across settings commit and migration. */
  migrationLease?: RagIndexMigrationLease;
}

export class RagIndexRebuildError extends Error {
  readonly progress: RagIndexRebuildProgress;
  override readonly cause: unknown;

  constructor(message: string, progress: RagIndexRebuildProgress, cause: unknown) {
    super(message);
    this.name = 'RagIndexRebuildError';
    this.progress = progress;
    this.cause = cause;
  }
}

export class RagIndexRebuildService {
  private rebuildInProgress = false;

  constructor(private readonly vectorStore: VectorStore = getVectorStore()) {}

  isRunning(): boolean {
    return this.rebuildInProgress;
  }

  async rebuildAll(options: RagIndexRebuildOptions = {}): Promise<RagIndexRebuildResult> {
    if (this.rebuildInProgress) {
      throw new Error('RAG_INDEX_REBUILD_IN_PROGRESS');
    }
    this.rebuildInProgress = true;
    let acquiredMigrationLease: RagIndexMigrationLease | undefined;
    let progress: RagIndexRebuildProgress = {
      phase: 'discovering',
      completedChunks: 0,
      totalChunks: 0,
      completedAgents: 0,
      totalAgents: 0,
    };
    const report = (patch: Partial<RagIndexRebuildProgress>): void => {
      progress = { ...progress, ...patch };
      options.onProgress?.({ ...progress });
    };

    try {
      const migrationLease =
        options.migrationLease ?? (await ragIndexCoordinator.acquireMigration());
      if (!ragIndexCoordinator.ownsActiveMigrationLease(migrationLease)) {
        throw new Error('RAG_INDEX_MIGRATION_LEASE_INVALID');
      }
      if (!options.migrationLease) acquiredMigrationLease = migrationLease;

      const route = options.route ?? resolveRagEmbeddingRoute();
      if (route.profileId !== getActiveEmbeddingProfileId()) {
        throw new Error('RAG_REBUILD_ROUTE_IS_NOT_ACTIVE');
      }
      invalidateEmbeddingDependentCaches();
      const expectedDimension =
        options.expectedDimension ?? (await embeddingService.testConnection(route)).dimension;
      if (!Number.isInteger(expectedDimension) || expectedDimension <= 0) {
        throw new Error('RAG_REBUILD_EXPECTED_DIMENSION_INVALID');
      }

      const agentIds = await this.vectorStore.listVectorAgentIds();
      report({ totalAgents: agentIds.length });

      const statuses = await Promise.all(
        agentIds.map((agentId) => this.vectorStore.getStatus(agentId))
      );
      report({ totalChunks: statuses.reduce((sum, status) => sum + status.chunkCount, 0) });

      let rebuiltChunkCount = 0;
      let skippedChunkCount = 0;
      for (const agentId of agentIds) {
        if (getActiveEmbeddingProfileId() !== route.profileId) {
          throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
        }
        const chunks = await this.vectorStore.listChunks(agentId);
        const staleChunks = chunks.filter((chunk) =>
          this.isChunkStale(chunk, route.profileId, expectedDimension)
        );
        const skippedForAgent = chunks.length - staleChunks.length;
        skippedChunkCount += skippedForAgent;

        if (staleChunks.length === 0) {
          if (getActiveEmbeddingProfileId() !== route.profileId) {
            throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
          }
          report({
            phase: 'updating',
            agentId,
            completedChunks: progress.completedChunks + chunks.length,
            completedAgents: progress.completedAgents + 1,
          });
          continue;
        }

        for (
          let batchStart = 0;
          batchStart < staleChunks.length;
          batchStart += REBUILD_CHECKPOINT_BATCH_SIZE
        ) {
          if (getActiveEmbeddingProfileId() !== route.profileId) {
            throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
          }
          const batch = staleChunks.slice(batchStart, batchStart + REBUILD_CHECKPOINT_BATCH_SIZE);
          const texts = batch.map((chunk) => this.buildRebuildText(chunk));
          report({
            phase: 'embedding',
            agentId,
            completedChunks: rebuiltChunkCount + skippedChunkCount,
          });
          const embeddingResults = await this.encodeRebuildTexts(texts, route, expectedDimension);
          const updates: ChunkEmbeddingUpdate[] = [];

          for (let index = 0; index < batch.length; index++) {
            const chunk = batch[index];
            const embeddingResult = embeddingResults[index];
            if (!chunk || !embeddingResult) {
              throw new Error('RAG_REBUILD_EMBEDDING_MISSING');
            }
            const { embedding, segmentCount } = embeddingResult;
            const metadata = withEmbeddingAggregationMetadata(chunk.metadata, segmentCount);
            updates.push({
              chunkId: chunk.id,
              embedding,
              metadata: JSON.stringify({
                ...metadata,
                embeddingProfileId: route.profileId,
                embeddingDimension: embedding.length,
              }),
            });
          }

          if (getActiveEmbeddingProfileId() !== route.profileId) {
            throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
          }
          report({
            phase: 'updating',
            agentId,
            completedChunks: rebuiltChunkCount + skippedChunkCount,
          });
          const updatedCount = await this.vectorStore.batchUpdateChunkEmbeddings(agentId, updates);
          if (updatedCount !== updates.length) {
            throw new Error(`RAG_REBUILD_UPDATE_COUNT_MISMATCH:${updatedCount}:${updates.length}`);
          }
          rebuiltChunkCount += updatedCount;
          report({ completedChunks: rebuiltChunkCount + skippedChunkCount });
        }

        if (getActiveEmbeddingProfileId() !== route.profileId) {
          throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
        }
        report({
          phase: 'updating',
          agentId,
          completedAgents: progress.completedAgents + 1,
        });
      }

      if (getActiveEmbeddingProfileId() !== route.profileId) {
        throw new Error('RAG_ACTIVE_EMBEDDING_PROFILE_CHANGED_DURING_REBUILD');
      }
      report({ phase: 'complete', agentId: undefined });
      return {
        profileId: route.profileId,
        rebuiltChunkCount,
        skippedChunkCount,
        rebuiltAgentCount: progress.completedAgents,
        totalAgentCount: progress.totalAgents,
      };
    } catch (error) {
      logger.error('[RagIndexRebuildService] Rebuild interrupted');
      throw new RagIndexRebuildError('RAG_INDEX_REBUILD_FAILED', { ...progress }, error);
    } finally {
      acquiredMigrationLease?.release();
      this.rebuildInProgress = false;
    }
  }

  private buildRebuildText(chunk: Chunk): string {
    if (chunk.metadata.memoryType || chunk.metadata.memoryId) {
      return chunk.content;
    }
    return buildEmbeddingIndexText({
      fileName: chunk.metadata.fileName,
      filePath: chunk.metadata.filePath,
      sectionPath: chunk.metadata.sectionPath,
      heading: chunk.metadata.heading,
      content: chunk.content,
    });
  }

  private isChunkStale(chunk: Chunk, profileId: string, expectedDimension: number): boolean {
    if (
      chunk.metadata.embeddingProfileId !== profileId ||
      chunk.metadata.embeddingDimension !== expectedDimension
    ) {
      return true;
    }

    return isEmbeddingAggregationMetadataStale(this.buildRebuildText(chunk), chunk.metadata);
  }

  private async encodeRebuildTexts(
    texts: string[],
    route: ResolvedEmbeddingRoute,
    expectedDimension: number
  ): Promise<EmbeddingInputResult[]> {
    return encodeEmbeddingInputs(
      texts,
      (expandedTexts) => embeddingService.encodeBatchWithRoute(expandedTexts, route, 'document'),
      {
        expectedDimension,
        errorPrefix: 'RAG_REBUILD',
      }
    );
  }
}

export function invalidateEmbeddingDependentCaches(): void {
  embeddingService.clearCache();
  clearAnchorCache();
}

export const ragIndexRebuildService = new RagIndexRebuildService();
