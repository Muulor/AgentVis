---
name: local_search
description: Search text files on the local device, including code, configuration files, logs, and documents. Supports text search (grep), file lookup (find), code outline (outline), and symbol lookup (symbol).
category: search
complexity: 2
requiresAuth: false
---

# local_search Tool

Searches local-device content. It supports four search modes and can search code, configuration files, logs, documents, and other text files.

## When To Use

- Find where a function, variable, or text string is used in a project -> `grep`.
- Search logs, configuration files, or documents for specific text -> `grep`.
- Find files by type or name, such as all `.json` config files or `.css` module files -> `find`.
- Understand which classes, functions, interfaces, or types a file contains -> `outline`.
- Inspect the complete code for a specific function or class -> `symbol`.

## When Not To Use

- You need to read an entire file -> use `read`.
- You need to modify a file -> use `file_write`.

## Decision Hint

- `local_search` is a read-only tool. Use it with `behaviorHint='direct'`.
- Prefer `outline` to understand a file's structure before using `symbol` for precise inspection.

## Four Modes

### mode: grep - Text Search

Searches a directory for matching text and returns file names, line numbers, and matching line content.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"grep"` |
| query | string | yes | Search text or regular expression. |
| searchPath | string | no | Search directory. Defaults to the workdir. |
| isRegex | boolean | no | Whether `query` is a regular expression. Defaults to `false`. |
| includes | string[] | no | Glob filters, such as `["*.ts"]`. |

```json
{ "mode": "grep", "query": "indexToKnowledge", "includes": ["*.ts"] }
```

### mode: find - File Lookup

Finds files or directories by file-name glob pattern.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"find"` |
| pattern | string | yes | File-name glob, such as `"*.module.css"`. |
| searchPath | string | no | Search directory. Defaults to the workdir. |
| maxDepth | number | no | Maximum search depth. |
| fileType | string | no | `"file"`, `"directory"`, or `"any"`. |

```json
{ "mode": "find", "pattern": "*.module.css" }
```

### mode: outline - AST Structure Outline

Uses tree-sitter to parse a file's AST and returns a list of symbols such as classes, functions, interfaces, and types.
Supports TypeScript, JavaScript, Python, Rust, and CSS.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"outline"` |
| path | string | yes | Absolute file path. |

```json
{ "mode": "outline", "path": "f:/project/src/App.tsx" }
```

### mode: symbol - Symbol Lookup

Locates a specified symbol in a file and returns its complete source code. Dot-separated lookup is supported, such as `"ClassName.methodName"`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| mode | string | yes | `"symbol"` |
| path | string | yes | Absolute file path. |
| symbolName | string | yes | Symbol name, such as `"FileList.handleExport"`. |

```json
{ "mode": "symbol", "path": "f:/project/src/FileList.tsx", "symbolName": "FileList.handleExport" }
```

## Rules

1. Prefer `outline` before broad full-text searching when file structure can narrow the search.
2. Use `includes` with `grep` to limit file types and improve search efficiency.
3. Results are limited to 50 items. Keep the search scope as precise as possible.
4. `outline` and `symbol` require absolute paths.
