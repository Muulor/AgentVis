import { describe, expect, it } from 'vitest';
import {
  getMessageOriginalDisplayContent,
  getMessageQuoteContent,
  getQuoteContextContent,
  serializeQuoteForMessage,
} from '../quoteContent';

describe('quoteContent', () => {
  it('prefers persisted Planning content for assistant quote context', () => {
    const result = getMessageQuoteContent({
      role: 'assistant',
      content: 'Enhanced answer\n```echarts\n{"series":[]}\n```',
      metadata: {
        visualEnhanced: true,
        persistContent: 'Original Master Brain answer',
      },
    });

    expect(result).toBe('Original Master Brain answer');
  });

  it('strips persisted cross-turn context before quoting legacy Planning messages', () => {
    const result = getMessageQuoteContent({
      role: 'assistant',
      content: 'Enhanced answer',
      metadata: {
        persistContent: [
          'Original visible answer',
          '',
          'MB decision progress (system-injected context for the next decision):',
          'hidden rationale',
        ].join('\n'),
      },
    });

    expect(result).toBe('Original visible answer');
  });

  it('reuses persisted Planning content as the original UI version', () => {
    const result = getMessageOriginalDisplayContent({
      role: 'assistant',
      content: 'Enhanced answer',
      metadata: {
        visualEnhanced: true,
        persistContent: [
          'Original visible answer',
          '',
          'MB decision progress (system-injected context for the next decision):',
          'hidden rationale',
        ].join('\n'),
      },
    });

    expect(result).toBe('Original visible answer');
  });

  it('cleans visual blocks when formatting quote context', () => {
    const result = getQuoteContextContent({
      content: 'Original answer\n```widget-chart\n{"items":[]}\n```',
    });

    expect(result).toBe('Original answer');
  });

  it('serializes quotes without extra context fields', () => {
    const result = serializeQuoteForMessage({
      content: 'Original Master Brain answer',
      agentName: 'Planner',
    });

    expect(result).toEqual({
      content: 'Original Master Brain answer',
      agentName: 'Planner',
    });
  });
});
