/**
 * Pure setup-checklist helpers for mode-aware RAG credential readiness.
 */

import { isCustomEmbeddingConfigValid } from '@services/rag/RagConnectionConfig';
import type { CustomEmbeddingConfig, RagServiceMode } from '@/types/rag';

export function isRagEmbeddingConnectionReady(options: {
  mode: RagServiceMode;
  customEmbeddingConfig: CustomEmbeddingConfig;
  credentialConfigured: boolean;
}): boolean {
  if (options.mode === 'siliconflow') return options.credentialConfigured;
  if (!isCustomEmbeddingConfigValid(options.customEmbeddingConfig)) return false;
  return options.customEmbeddingConfig.authMode === 'none' || options.credentialConfigured;
}
