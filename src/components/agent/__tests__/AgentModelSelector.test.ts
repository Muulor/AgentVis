/**
 * AgentModelSelector reasoning selection behavior tests.
 */

import { describe, expect, it } from 'vitest';
import {
  hasConfigurableReasoningPresets,
  resolveModelSelectionPreset,
} from '../AgentModelSelector.helpers';

describe('AgentModelSelector reasoning behavior', () => {
  it('opens a reasoning submenu only for routes with configurable presets', () => {
    expect(hasConfigurableReasoningPresets('openai', 'gpt-5.4')).toBe(true);
    expect(hasConfigurableReasoningPresets('local', 'gpt-5.4')).toBe(false);
  });

  it('selects a new or recommended-only model atomically with recommended', () => {
    expect(resolveModelSelectionPreset('openai', 'gpt-5.4', 'high', 'local', 'gpt-5.4')).toBe(
      'recommended'
    );
  });

  it('keeps the current valid preset when the selected model row is clicked again', () => {
    expect(resolveModelSelectionPreset('openai', 'gpt-5.4', 'high', 'openai', 'gpt-5.4')).toBe(
      'high'
    );
  });

  it('normalizes a stale current preset before preserving it', () => {
    expect(
      resolveModelSelectionPreset(
        'gemini',
        'gemini-3.1-pro-preview',
        'minimal',
        'gemini',
        'gemini-3.1-pro-preview'
      )
    ).toBe('recommended');
  });
});
