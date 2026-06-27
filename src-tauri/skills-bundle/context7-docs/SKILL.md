---
name: context7-docs
description: "Context7 equips LLMs with up-to-date, version-specific official tech docs and code snippets for public packages, frameworks, SDKs, CLIs, and APIs. Reactively, prefer this skill over web_search when a user asks for the latest library docs, API usage, or framework examples. More importantly, use it proactively during any coding or development task to verify setup steps and API references. This ensures you do not rely on stale training data and prevents you from generating incorrect code."
triggers: [context7-docs, context7, ctx7, latest docs, library docs, API docs, 文档查询, 最新文档, 库文档, 框架文档]
execution:
  runtime: python
  entry: scripts/context7_docs_entry.py
  timeout: 60
  maxOutput: 131072
  permissions:
    network: true
    networkMode: brokerOnly
  credentials:
    - id: context7
      provider: context7
      mode: brokerAuth
      hosts: [context7.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Action to run: search, docs, or resolve-docs. Use search to find a library id, docs when libraryId is known, and resolve-docs when one call should search then fetch docs."
      allowedValues: [search, docs, resolve-docs]
      examples: [search, docs]
    - name: libraryName
      type: string
      required: false
      description: "Library/package/framework name for action=search or action=resolve-docs. Examples: react, next.js, tanstack query."
    - name: libraryId
      type: string
      required: false
      description: "Context7 library id for action=docs. Examples: /reactjs/react.dev, /vercel/next.js, /websites/react_dev_reference."
    - name: query
      type: string
      required: false
      description: "Specific documentation question or topic. Use a detailed natural-language query for best results."
    - name: outputFormat
      type: string
      required: false
      description: "Output format for docs or resolve-docs."
      allowedValues: [text, json]
      default: text
    - name: limit
      type: number
      required: false
      description: "Maximum search results or formatted snippets to show. Defaults to 5."
      min: 1
      default: 5
    - name: max
      type: number
      required: false
      description: "Maximum characters for text output. Defaults to 12000."
      min: 1
      default: 12000
dependencies:
  python: ">=3.11"
  packages: []
---

# Context7 Docs Skill for AgentVis

Search Context7 libraries and retrieve current documentation snippets through Context7's public HTTP API. This Script Skill uses AgentVis `brokerOnly` networking and has no third-party Python dependencies.

## Actions

- `search`: find candidate Context7 library IDs from a library name and optional topic.
- `docs`: retrieve snippets for a known `libraryId` and query.
- `resolve-docs`: search by `libraryName`, pick the strongest match, then retrieve docs for that library. This costs two Context7 API requests.

## API Key And Rate Limits

Context7 can be used anonymously, but anonymous requests have a lower rate limit. If the user configures a Context7 API key in AgentVis settings, the broker injects it as `Authorization: Bearer ...` for `https://context7.com` when this skill sends `credentialRef: "context7"`. The script process never reads API keys from environment variables, Home/AppData files, or Credential Manager directly.

The output includes Context7 `RateLimit-*` metadata when the API returns it. Prefer `docs` with a known `libraryId` when possible to save requests. Use `resolve-docs` when the library ID is unknown and the extra request is worth it.

## Query Guidance

Use a focused query such as `How to configure middleware auth in app router?` rather than a vague word like `auth`. For version-specific docs, pass a pinned `libraryId` when known, such as `/vercel/next.js@v15.1.8`.

During coding tasks, proactively call this skill before writing or changing code that depends on recently changing libraries, unfamiliar SDKs, framework configuration, version-specific APIs, or generated examples. Prefer this skill over memory when current official/source-backed documentation can prevent stale API usage.

## Maintainer Notes

The declared Script entrypoint is `scripts/context7_docs_entry.py` and intentionally contains no URL literals or direct network-client imports. Keep Context7 HTTP access inside `scripts/context7_docs.py` behind `request_context7`, so sandboxed execution remains brokerOnly while local smoke tests can still run anonymously.
