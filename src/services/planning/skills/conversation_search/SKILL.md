---
name: conversation_search
description: Search or browse the current Agent's own saved conversation history.
category: search
complexity: 1
requiresAuth: false
---

# conversation_search Tool

Searches persisted user and assistant messages for the current Agent only. It is useful when the live context or compressed memory does not contain enough evidence about an earlier conversation.

Use it in three stages:

1. `mode: "timeline"` lists lightweight chronological previews without requiring a keyword.
2. `mode: "search"` returns one lightweight first-match snippet per message, centered around the matched keyword, with matched terms marked as `[[...]]`.
3. `mode: "get"` fetches the full content of selected `messageId` or `messageIds` from the current Agent only.

## When To Use

- The user refers to a decision, conclusion, event, or keyword from an earlier conversation, or indicates an intent for you to recall past interactions.
- The user asks about the first/earliest/latest conversation, or gives a time clue such as yesterday, last week, last month, or a date range.
- You need to verify what was said before answering a question about history.
- Memory summaries are ambiguous, stale, or incomplete and a precise keyword can recover the original discussion.
- You need message timestamps or roles to separate user statements from assistant conclusions.

## When Not To Use

- Search another Agent, Hub messages, or all Agents -> this tool is intentionally scoped to the current Agent only.
- The user has already supplied the needed fact in the current request.

## Decision Hint

- `conversation_search` is a read-only tool. Use it with `behaviorHint='direct'`.
- Use `mode: "timeline"` when the user gives no reliable keyword but gives an ordering or time clue, such as first, earliest, latest, last week, or around a date.
- Use `mode: "search"` when you have concise, distinctive keywords. If the first query is broad or empty, retry with a more specific phrase.
- Search and timeline results are paged. If the result includes `hasMore=true`, continue with the same filters and `offset=nextOffset` only when more results may matter.
- Use `mode: "get"` only after search or timeline identifies one or more relevant message ids. Fetch the minimum needed messages.
- Treat results as historical evidence. If they conflict with the current user request, the current request wins.

## mode: "timeline" - Chronological Browsing

Use timeline mode for history-location tasks that do not have a good keyword.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"timeline"` |
| order | string | no | `"desc"` newest first (default), or `"asc"` oldest first. Use `"asc"` for first/earliest conversation questions. |
| limit | number | no | Maximum messages to return. Defaults to 10 and is capped at 50. |
| offset | number | no | Result offset for pagination. Defaults to 0. Use `nextOffset` from the previous page when `hasMore=true`. |
| role | string | no | `"any"` (default), `"user"`, or `"assistant"`. |
| startAt | string | no | Inclusive time lower bound. Prefer ISO timestamp with timezone. `YYYY-MM-DD` means that local-day boundary. |
| endAt | string | no | Exclusive time upper bound. Prefer ISO timestamp with timezone. `YYYY-MM-DD` means that local-day boundary. |

```json
{ "mode": "timeline", "order": "asc", "role": "user", "limit": 5 }
```

```json
{ "mode": "timeline", "order": "asc", "startAt": "2026-04-01T00:00:00+08:00", "endAt": "2026-05-01T00:00:00+08:00", "limit": 20 }
```

## mode: "search" - Lightweight Keyword Search

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | no | `"search"`; this is the default. |
| query | string | yes | Exact keyword or phrase to search in the current Agent's saved conversation history. |
| limit | number | no | Maximum matches to return. Defaults to 10 and is capped at 50. |
| offset | number | no | Result offset for pagination. Defaults to 0. Use `nextOffset` from the previous page when `hasMore=true`. |
| role | string | no | `"any"` (default), `"user"`, or `"assistant"`. |
| startAt | string | no | Inclusive time lower bound. Prefer ISO timestamp with timezone. |
| endAt | string | no | Exclusive time upper bound. Prefer ISO timestamp with timezone. |

```json
{ "mode": "search", "query": "Automation Lane", "limit": 10, "role": "any" }
```

```json
{ "mode": "search", "query": "Automation Lane", "limit": 10, "role": "any", "offset": 10 }
```

```json
{ "mode": "search", "query": "Automation Lane", "startAt": "2026-04-01T00:00:00+08:00", "endAt": "2026-05-01T00:00:00+08:00", "limit": 10 }
```

Search and timeline output includes `[conversation_search_meta] mode=<mode> offset=<n> limit=<n> hasMore=<true|false> nextOffset=<n>`.

## mode: "get" - Full Message Fetch

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"get"` |
| messageId | string | no | One message id to fetch in full. |
| messageIds | string[] | no | Multiple message ids to fetch in full. Capped at 5. |

```json
{ "mode": "get", "messageId": "message-id-from-search-result" }
```

```json
{ "mode": "get", "messageIds": ["message-id-1", "message-id-2"] }
```

## Result Use

- Cite or summarize the relevant result by timestamp, role, and message id when the answer depends on historical evidence.
- Do not infer that missing results prove something never happened; the user may have used different wording.
