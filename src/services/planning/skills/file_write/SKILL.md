---
name: file_write
description: Create and modify non-binary files, including source code and documents. Supports full-file writes and precise search/replace patches.
category: file_operation
complexity: 2
requiresAuth: false
---

# file_write Tool

Writes non-binary file content. It supports two modes:

- **full mode** (default): provide complete file content. The system chooses create, overwrite, or merge behavior as appropriate.
- **patch mode**: provide precise `search` / `replace` patch pairs for existing files.

## When To Use

- Create new text files, source files, Markdown documents, JSON/config files, logs, scripts, or other non-binary files.
- Modify part of an existing file with `mode: "patch"`.
- Create long documents by writing a full skeleton first, then filling sections with patch mode.
- Record agent logs or task notes in text/Markdown files.

## When Not To Use

- Reading file content -> use `read`.
- Operating on binary files such as images or PDFs -> use `exec` or the appropriate binary-producing tool.
- Running commands or scripts -> use `exec`.
- Deleting files -> use `exec`.

## Decision Hint

- `file_write` is the only tool for creating or modifying text file content.
- Do not use `exec` or a shell script to create or modify text, source code, Markdown, JSON, config, or log files.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Target file path. |
| `content` | string | required for full mode | Complete file content. |
| `mode` | `"full"` or `"patch"` | no | Write mode. Defaults to `"full"`. |
| `patches` | PatchItem[] | required for patch mode | List of `{search, replace}` patch items. |

## Required Argument Shapes

Every `file_write` tool call must pass a non-empty JSON argument object.

Full mode:

```json
{
  "path": "relative/or/absolute/path.ext",
  "mode": "full",
  "content": "complete file content"
}
```

Patch mode:

```json
{
  "path": "relative/or/absolute/path.ext",
  "mode": "patch",
  "patches": [
    {
      "search": "exact existing text",
      "replace": "replacement text"
    }
  ]
}
```

Never call `file_write` with `{}`. If you are creating or overwriting a file, include both `path` and `content`. If you are patching a file, include `path`, `mode: "patch"`, and at least one patch item.

## Patch Mode Requirements

- Use `local_search` to locate code when helpful, then use `read` when needed to confirm the exact current text.
- `search` must match text that appears exactly once in the file.
- Include 2-3 surrounding context lines in `search` when necessary to make it unique.
- Multiple patch items may be provided in one call. The system applies them in reverse position order to avoid offset errors.
- If a patch fails, use `read(startLine, endLine)` to inspect the actual content, then rebuild the patch.

> **Do not split related patches into multiple separate calls.**
>
> Wrong: make one `file_write` tool call for each separate edit.
>
> Correct: combine all related edits into one `file_write` tool call whose `patches` array contains all patch items.
>
> Splitting patches can make later `search` text invalid after earlier patches modify the file, causing repeated no-change or no-match loops.

## Automatic Syntax Checks

After writing `.ts`, `.tsx`, `.py`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.json`, `.yaml`, `.yml`, `.toml`, `.rs`, or `.go` files, the system automatically runs a syntax check when the local toolchain is available. Rust files prefer `cargo check --message-format=json` when a `Cargo.toml` is present; Python files prefer Pyright/Mypy project diagnostics when explicit config is present; Go files prefer current-package `go test` compilation when `go.mod` or `go.work` is present; JavaScript and JSX files prefer local ESLint when project config and `node_modules/.bin/eslint` are present.

If the returned information contains a syntax-check failure, such as:

```text
POST_WRITE_VALIDATION_FAILED
Post-write syntax check failed (tsc); the current file has N error(s):
  - [line 45, column 7] Type 'number' is not assignable to type 'string'.
Next, patch only the lines above before continuing.
```

Handle it immediately with `file_write(mode="patch")` on the relevant lines. Do not continue creating files or repeatedly run full-project checks until the reported diagnostics are fixed. You do not need to reread the whole file unless the exact current text is unclear.

No syntax-check warning means the check passed, the current language is outside the supported syntax-check set, or the local toolchain was unavailable.
