/**
 * AgentModelSelector pure selection helpers.
 *
 * Keep non-component exports outside the TSX module so React Fast Refresh can
 * treat AgentModelSelector.tsx as a component-only boundary.
 */

import {
  getSupportedReasoningPresets,
  normalizeReasoningPreset,
  type ReasoningPreset,
} from '@/config/modelRegistry';

export function hasConfigurableReasoningPresets(providerId: string, modelId: string): boolean {
  return getSupportedReasoningPresets(providerId, modelId).length > 1;
}

export function formatModelSelectorLabel(
  providerId: string,
  modelId: string,
  displayName: string,
  preset: ReasoningPreset | null | undefined
): string {
  if (!hasConfigurableReasoningPresets(providerId, modelId)) return displayName;
  return `${displayName} · ${normalizeReasoningPreset(providerId, modelId, preset)}`;
}

export function resolveModelSelectionPreset(
  currentProvider: string | null,
  currentModel: string | null,
  currentPreset: ReasoningPreset | null | undefined,
  nextProvider: string,
  nextModel: string
): ReasoningPreset {
  return currentProvider === nextProvider && currentModel === nextModel
    ? normalizeReasoningPreset(nextProvider, nextModel, currentPreset)
    : 'recommended';
}
