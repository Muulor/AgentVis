---
name: web_search
description: Use when you need latest information, technical documentation, or factual verification from the web
category: search
complexity: 2
requiresAuth: false
---

# web_search Tool

Retrieves web information through Tavily first and DDGS as a free fallback. Supports summaries and optional full page content.

## When To Use

- Find latest information, news, or technical updates.
- Look up unknown information or confirm facts.
- Verify a technical approach or best practice.
- Fetch detailed page content for deeper analysis.

## When Not To Use

- The user asks about known, stable knowledge, such as basic language syntax.
- The question is about code inside the current project. Inspect the code first.
- The user did not ask to search, and the question can be answered directly.

## Decision Hint

- `web_search` is a low-risk read-only tool. Use it with `behaviorHint='direct'`.
- Use it only when latest information is needed or when uncertain knowledge needs verification. Avoid unnecessary searching.
- For project-internal code questions, use `read` or `local_search` before web search.

## Rules

1. Use only when latest information is needed or uncertainty must be verified.
2. Keep search queries concise and keyword-focused.
3. Summarize key information from returned results instead of copying results directly.
4. Prefer `searchDepth: "basic"` for most cases that need concise information and answers.
5. Use `"advanced"` only when the first search is low-confidence or the query needs broader backend recall; it can be slower and is not always better for news or realtime facts.
6. Enable `includeContent: true` only when full page content is required for analysis, preferably with `maxResults` set to `2` or `3`.
7. Treat `WEB_SEARCH_PROVIDER provider=ddgs fallback=true` as a normal fallback result, not a failure.

## Search Mode Comparison

| Mode | `searchDepth` | `includeContent` | Best For |
| --- | --- | --- | --- |
| Quick search | `"basic"` | `false` | Quickly retrieving summary information. |
| Deep search | `"advanced"` | `false` | Broader backend recall for low-confidence or complex searches. |
| Content fetch | `"basic"` | `true` | Reading selected pages after search; keep result count small. |
| Deep plus content | `"advanced"` | `true` | Expensive fallback for difficult research tasks only. |

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| query | string | yes | Search query. |
| maxResults | number | no | Maximum number of results. Defaults to `5`. |
| searchDepth | string | no | Search depth: `"basic"` or `"advanced"`. `"advanced"` queries more backends and can be slower. Defaults to `"basic"`. |
| includeContent | boolean | no | Whether to fetch full page content. Defaults to `false`; prefer small `maxResults`. |
