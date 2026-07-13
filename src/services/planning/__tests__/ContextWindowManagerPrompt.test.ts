import { describe, expect, it } from 'vitest';
import { ContextWindowManager } from '../ContextWindowManager';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;

describe('ContextWindowManager prompt text invariants', () => {
  it('formats empty history with an English model-visible placeholder', () => {
    const manager = new ContextWindowManager();

    expect(manager.formatHistory([], 1000)).toBe('(No conversation history)');
  });

  it('formats history roles and truncation fallbacks in English', () => {
    const manager = new ContextWindowManager();
    const formatted = manager.formatHistory(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      1000
    );
    const omitted = manager.formatHistory(
      [{ role: 'user', content: 'this message cannot fit the tiny budget' }],
      1
    );

    expect(formatted).toContain('**User**:\nhello');
    expect(formatted).toContain('**Agent**:\nhi there');
    expect(formatted).not.toMatch(HAN_CHARACTER_PATTERN);
    expect(omitted).toBe('(History too long; omitted)');
  });

  it('returns English full-history text from prepareContext', async () => {
    const manager = new ContextWindowManager();

    const prepared = await manager.prepareContext(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      '',
      'default'
    );

    expect(prepared.conversationHistory).toContain('**User**:\nhello');
    expect(prepared.conversationHistory).toContain('**Agent**:\nhi there');
    expect(prepared.conversationHistory).not.toMatch(HAN_CHARACTER_PATTERN);
  });

  it('reserves capacity for the current user turn without injecting it into history', async () => {
    const manager = new ContextWindowManager();
    const reservedInputTokens = 50_000;

    const prepared = await manager.prepareContext(
      [{ role: 'user', content: 'historical message' }],
      '',
      'default',
      undefined,
      undefined,
      reservedInputTokens
    );

    expect(prepared.conversationHistory).toBe('(History too long; omitted)');
    expect(prepared.budgetReport.layers.historyAndOutput.historyUsed).toBeGreaterThanOrEqual(
      reservedInputTokens
    );
  });

  it('uses the provider route when duplicate model IDs have different context windows', async () => {
    const manager = new ContextWindowManager();

    const openai = await manager.prepareContext(
      [],
      '',
      'gpt-5.4',
      undefined,
      undefined,
      0,
      'openai'
    );
    const local = await manager.prepareContext([], '', 'gpt-5.4', undefined, undefined, 0, 'local');

    expect(openai.budgetReport.modelContextWindow).toBe(1_050_000);
    expect(local.budgetReport.modelContextWindow).toBe(400_000);
  });
});
