/**
 * Helpers for re-syncing chat state from persisted messages.
 *
 * Used after optimistic message mutations fail so the UI reflects the
 * database state instead of leaving a message hidden until the next restart.
 */

import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '@stores/chatStore';
import { useWidgetStore } from '@stores/widgetStore';
import { collectWidgetBubbleSubmissions } from '@stores/widgetSubmissionRecovery';
import { getLogger } from '@services/logger';
import type { Message } from '@/types';

const logger = getLogger('messageReload');
const DEFAULT_RELOAD_COUNT = 100;

export interface PersistedMessageItem {
  id: string;
  agentId: string;
  role: string;
  content: string;
  metadata: string | null;
  createdAt: number;
}

export function parseQuotedFrom(
  metadata: Record<string, unknown> | undefined | null
): Message['quotedFrom'] | undefined {
  if (!metadata) return undefined;

  const raw = metadata.quotedFrom;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const result = raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];

    const record = item as Record<string, unknown>;
    if (typeof record.content !== 'string') return [];

    const legacyContextContent =
      typeof record.contextContent === 'string' && record.contextContent.trim()
        ? record.contextContent
        : undefined;

    return [
      {
        content: legacyContextContent ?? record.content,
        ...(typeof record.agentName === 'string' ? { agentName: record.agentName } : {}),
      },
    ];
  });

  return result.length > 0 ? result : undefined;
}

export function mapPersistedMessage(message: PersistedMessageItem): Message {
  let metadata: Message['metadata'] = undefined;

  if (message.metadata) {
    try {
      metadata = JSON.parse(message.metadata) as Message['metadata'];
    } catch (error) {
      logger.warn('[messageReload] Failed to parse message metadata:', error);
    }
  }

  const metadataRecord = metadata as Record<string, unknown> | undefined;

  return {
    id: message.id,
    agentId: message.agentId,
    role: message.role as Message['role'],
    content: message.content,
    createdAt: message.createdAt,
    metadata,
    quotedFrom: parseQuotedFrom(metadataRecord),
  };
}

export function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

export function mapPersistedMessages(messages: PersistedMessageItem[]): Message[] {
  return sortMessages(messages.map(mapPersistedMessage));
}

export function restoreWidgetSubmissionsFromMessages(
  messages: Message[],
  logPrefix = '[messageReload]'
): number {
  const widgetSubmissions = collectWidgetBubbleSubmissions(messages);
  if (widgetSubmissions.length === 0) return 0;

  const { restoreBubbleSubmittedState } = useWidgetStore.getState();
  for (const submission of widgetSubmissions) {
    restoreBubbleSubmittedState(submission.bubbleId, submission.selections, submission.extraText);
  }

  logger.trace(`${logPrefix} Restored widget submissions`, widgetSubmissions.length);
  return widgetSubmissions.length;
}

function getReloadCount(minCount: number): number {
  return Math.max(DEFAULT_RELOAD_COUNT, Math.ceil(minCount));
}

export async function refreshAgentMessagesFromDb(
  agentId: string,
  minCount = DEFAULT_RELOAD_COUNT
): Promise<void> {
  const count = getReloadCount(minCount);
  const [messagesFromDb, totalCount] = await Promise.all([
    invoke<PersistedMessageItem[]>('message_get_recent', {
      agentId,
      count,
    }),
    invoke<number>('message_count_by_agent', {
      agentId,
    }),
  ]);

  const messages = mapPersistedMessages(messagesFromDb).filter(
    (message) => (message.metadata as { sourceType?: string } | undefined)?.sourceType !== 'hub'
  );
  restoreWidgetSubmissionsFromMessages(messages);

  const store = useChatStore.getState();
  store.setMessages(agentId, messages);
  store.setHasMore(agentId, messagesFromDb.length < totalCount);
}

export async function refreshHubMessagesFromDb(
  hubId: string,
  minCount = DEFAULT_RELOAD_COUNT
): Promise<void> {
  const count = getReloadCount(minCount);
  const [messagesFromDb, totalCount] = await Promise.all([
    invoke<PersistedMessageItem[]>('message_get_recent_hub', {
      hubId,
      count,
    }),
    invoke<number>('message_count_by_hub', {
      hubId,
    }),
  ]);

  const messages = mapPersistedMessages(messagesFromDb);
  restoreWidgetSubmissionsFromMessages(messages);

  const store = useChatStore.getState();
  store.setHubMessages(hubId, messages);
  store.setHubHasMore(hubId, messagesFromDb.length < totalCount);
}
