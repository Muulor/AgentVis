---
name: exec
description: Run build commands, tests, scripts, filesystem operations, package management commands, or network requests.
category: execution
complexity: 4
requiresAuth: true
---

# exec Tool

Executes shell commands with timeout control and a configurable working directory.

## When To Use

- Build, test, lint, or run project checks.
- Inspect file, directory, process, environment, or Git state.
- Run scripts that perform computation.
- Generate binary artifacts such as `.docx`, `.pdf`, `.xlsx`, or `.pptx`.
- Install dependencies or manage packages when the task requires it.
- Perform directory-level or binary-file operations such as creating folders, copying assets, or moving generated binary files.

## When Not To Use

- Creating or modifying text file content -> use `file_write`.
- Writing Markdown logs, task notes, source code, JSON/config files, or scripts -> use `file_write`.
- Indirectly modifying code by running a helper script such as `python fix.py` -> use `file_write`.
- Searching file/project text -> use `local_search`.

## Decision Hint

- Safe commands, such as read-only inspection, build/test commands, and ordinary script execution, use `behaviorHint='direct'`.
- High-risk commands, such as unknown or large dependencies installation, deletion, or external network requests, use `behaviorHint='careful'`.
- Tasks that produce binary files must include `exec` in the available tools.
- Use an explicit timeout only when the operation is known to be long-running. Suggested ranges: `300-600` for checks/builds, `600-1200` for dependency installation or large Cargo builds, and `1200-1800` for model downloads, video renders, or other very long tasks.
- Environment: Windows. The default shell is `cmd.exe`.
- Do not use `exec` to write text content; use `file_write` instead.

## Non-Interactive Mode

`exec` stdin is always null. Commands cannot receive keyboard input.

All commands that normally ask for confirmation must use the tool's non-interactive flags, such as `npx -y`, `--yes`, `-y`, or `--accept-*`.


## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| command | string | yes | Shell command. |
| cwd | string | no | Working directory. Defaults to the project root. |
| timeout | number | no | Timeout in seconds. Defaults to 120. Maximum 1800. Use 300-600 for checks/builds, 600-1200 for dependency installation or large builds, and 1200-1800 for model downloads, video renders, or other very long tasks. |

## Windows Path And Quoting Rules

Windows command parsing is fragile. Prefer simple commands. For text writes, avoid shell quoting entirely and use `file_write`.

1. Paths without spaces: use normal double quotes in `cmd.exe`, such as `dir "C:\Users\Admin\Music"`.
2. Paths with spaces in PowerShell: wrap the entire PowerShell script in double quotes, and wrap paths inside the script with single quotes.
   - Example: `powershell -NoProfile -Command "Get-ChildItem -LiteralPath 'C:\Program Files'"`
3. Do not wrap the whole `powershell -Command` script in single quotes. `cmd.exe` does not treat single quotes as command quoting.
4. For delete, move, or copy operations on Windows, prefer PowerShell cmdlets with `-LiteralPath`.
5. For reading text file contents, prefer `read` over `type` / `Get-Content`; `exec` output is truncated and Windows shell quoting can corrupt Unicode file names.
6. If a Windows path contains smart quotes or other non-ASCII punctuation, avoid hand-typing the exact file name in `exec`. Locate it first with `local_search` or PowerShell `Get-ChildItem`, then pass the discovered path object/short path to the command.
