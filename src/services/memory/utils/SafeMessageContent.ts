/**
 * Memory-safe message content helpers.
 *
 * The chat UI may persist assistant messages after visual enhancement so the UI
 * can render widgets after restart. Memory prompts should use the original
 * assistant text from metadata.persistContent when available, and must never
 * expose visual code blocks back to the LLM as examples to imitate.
 */

import { stripVisualCodeBlocks } from '@services/planning/visual-enhancer/stripVisualCodeBlocks';

interface MessageLike {
  role?: string;
  content: string;
  metadata?: string | Record<string, unknown> | null;
}

function parseMetadata(metadata: MessageLike['metadata']): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (typeof metadata === 'object') return metadata;

  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns content suitable for memory extraction, summary generation, and
 * memory recall prompts.
 */
export function getMemorySafeMessageContent(message: MessageLike): string {
  if (message.role !== 'assistant') {
    return message.content;
  }

  const metadata = parseMetadata(message.metadata);
  const persistContent = metadata?.persistContent;
  const preferredContent = typeof persistContent === 'string' ? persistContent : message.content;

  return stripVisualCodeBlocks(preferredContent);
}

/** Strips visual-only code blocks from arbitrary memory text before prompt injection. */
export function stripMemoryVisualCodeBlocks(content: string): string {
  return stripVisualCodeBlocks(content);
}
