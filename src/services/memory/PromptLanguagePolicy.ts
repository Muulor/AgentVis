/**
 * 记忆 Prompt 语言保真策略
 *
 * 系统 prompt 可以保持英文，但用户提供的对话、事实和摘要内容必须保留来源语言。
 */

export const SOURCE_LANGUAGE_PRESERVATION_RULES = `## Source Language Preservation (hard requirement)
- JSON keys, enum values, and category/scope labels must remain exactly as specified in English.
- Natural-language values derived from user messages, assistant messages, candidates, summaries, or facts must preserve the source language. Do not translate them into English merely because these instructions are written in English.
- If the source is primarily Chinese, write the extracted summary/fact/reason/notes in Chinese. If the source is mixed-language, preserve the mixed-language wording and technical terms as they appeared.
- Names, file paths, code identifiers, UI labels, and quoted phrases must stay verbatim unless you are only normalizing obvious whitespace.
- Translation is allowed only when the source itself asks for a translation or when a field is purely a system-owned schema label.`;
