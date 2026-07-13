/**
 * Pure context-selection helpers used by the Chat sender.
 */

/**
 * Select persisted messages that belong to historical context.
 *
 * The current user message is persisted before context preparation and then
 * appended explicitly to the final request. Removing it here prevents the same
 * user turn and its attachments from being sent twice.
 */
export function selectChatHistoryMessages<T extends { id?: string; role: string }>(
  messages: readonly T[],
  currentUserMessageId: string
): T[] {
  return messages.filter(
    (message) => message.role !== 'system' && message.id !== currentUserMessageId
  );
}
