/**
 * chatMode - Chat / Task 模式类型与旧 Fast 值兼容
 *
 * 用户界面中的 Task 模式继续使用内部值 planning，避免破坏持久化数据与执行链路。
 * 旧版本曾使用 fast 表示普通对话模式；新代码统一使用 chat。
 */

export type ChatMode = 'chat' | 'planning';
export type LegacyChatMode = ChatMode | 'fast';

export function normalizeChatMode(mode: LegacyChatMode | null | undefined): ChatMode {
  if (mode === 'fast') return 'chat';
  return mode ?? 'planning';
}
