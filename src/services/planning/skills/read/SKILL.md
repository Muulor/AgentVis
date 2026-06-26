---
name: read
description: Use when you need to inspect file or image content, analyze code structure, or understand implementation logic
category: file_operation
complexity: 1
requiresAuth: false
---

# read Tool

Reads file content and returns it. Supports optional line ranges for text files.

## When To Use

- Inspect text or code file content.
- Read the current content before modifying a file, so patch search text can match exactly.
- Inspect office documents. `.docx`, `.xlsx`, `.pptx`, and `.pdf` files are automatically parsed into text or Markdown.
- On Windows, image-only PDFs may fall back to native system OCR when the PDF text layer is empty.
- Read image files such as `.jpg`, `.png`, `.webp`, `.gif`, `.svg`, and `.bmp`.

## When Not To Use

- Video or other unsupported multimedia files.
- Repeated tiny line-range reads just to verify file content when a larger read would be clearer.

## Decision Hint

- `read` is a low-risk read-only tool. Use it with `behaviorHint='direct'`.
- A single call returns at most 700 lines. Any extra content is truncated automatically.
- Returned content ends with `[READ_META]`. `hasMore=true` means the file still has unread content.
- When handling large files, keep calling `read` until `hasMore=false`, then perform the overall analysis.
  - Example: first call `read(path)` -> see `hasMore=true` -> call `read(path, startLine=701)` -> continue.
- Before modifying a file, use `read` to confirm the current content and make patch search text exact.
- Windows file names can contain visually similar characters, such as ASCII `'` versus smart quote `’`.
  If a copied path fails, use `local_search` find mode to confirm the actual file name, then retry `read`.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| path | string | yes | Absolute file path. |
| startLine | number | no | Starting line number, 1-based. When specified, returned content includes line-number prefixes automatically. |
| endLine | number | no | Ending line number, inclusive. |

> Office documents (`.docx`, `.xlsx`, `.pptx`, `.pdf`) are automatically parsed into text or Markdown and do not support `startLine` or `endLine`.
