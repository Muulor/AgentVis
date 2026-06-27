---
name: file-organizer
description: "Plan, apply, and undo safe file organization in a directory by file type. Use this skill whenever the user asks to organize, sort, tidy up, clean up, classify, preview, or undo file moves in a folder. The apply result includes an undo manifest for recovery. No need to ask the user for a second confirmation unless the user asks only to preview."
triggers: [file-organizer, organize files, sort files, tidy files, clean up folder, file cleanup, undo file organization, 整理文件, 文件分类, 归类文件, 文件整理, 清理文件夹, 撤销文件整理]
execution:
  runtime: python
  entry: scripts/file_organizer_entry.py
  timeout: 120
  maxOutput: 65536
  permissions:
    network: false
    filesystem:
      - fromArg: path
        access: readWrite
  argsSchema:
    - name: path
      type: string
      required: true
      description: "Absolute path to the target directory."
    - name: action
      type: string
      required: false
      description: "Action to run: plan, apply, or undo. Defaults to plan; for an explicit organize request, review a normal plan then run apply in the same task without waiting for a separate confirmation."
      allowedValues: [plan, apply, undo]
      default: plan
    - name: recursive
      type: boolean
      required: false
      description: "Whether to process subdirectories. Defaults to false. When true, common project/build folders are skipped."
    - name: layout
      type: string
      required: false
      description: "Destination layout: flat or preserveTree. Defaults to preserveTree when recursive, otherwise flat."
      allowedValues: [flat, preserveTree]
    - name: exclude
      type: string
      required: false
      description: "Comma-separated directory/file names or glob patterns to exclude, in addition to the built-in safe excludes."
    - name: includeHidden
      type: boolean
      required: false
      description: "Include hidden files and directories. Defaults to false."
    - name: manifestPath
      type: string
      required: false
      description: "Undo manifest path. Optional for action=apply. For action=undo, omit it to auto-select the newest file-organizer undo manifest in the target directory."
    - name: maxFiles
      type: number
      required: false
      description: "Maximum planned moves allowed for action=apply unless allowLarge is true. Defaults to 2000."
      min: 1
      default: 2000
    - name: previewLimit
      type: number
      required: false
      description: "Maximum planned move rows included in JSON output. Defaults to 200."
      min: 0
      default: 200
    - name: allowLarge
      type: boolean
      required: false
      description: "Allow action=apply to exceed maxFiles after the agent has reviewed a plan."
---

# File Organizer

Plan, apply, and undo file organization in a target directory by file type.

## Capabilities

- Defaults to `action=plan`, returning a structured move preview without changing files.
- For an explicit user request to organize, sort, tidy, clean up, or classify files, run `action=plan` first, inspect the result, then run `action=apply` in the same task when the plan is ordinary and reversible. Do not pause for a separate confirmation unless the user only asked for a preview or the plan has warnings, truncation, unusually large scope, failures, ambiguous intent, or risky paths.
- Uses `action=apply` to perform the reviewed plan and write a manifest for undo.
- Writes an undo manifest named `file-organizer-undo-manifest-YYYYMMDD-HHMMSS.json` for successful apply runs, then supports `action=undo`.
- Records directories created by `action=apply`, then removes those directories during `action=undo` when they are empty.
- Classifies files by extension into `Images`, `Documents`, `Videos`, `Audio`, `Archives`, `Code`, `Fonts`, `Installers`, `Data`, and `Others`.
- Resolves filename conflicts during both planning and apply using numeric suffixes.
- Supports non-recursive and recursive scans. Recursive scans skip generated category folders plus common project/build folders such as `.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, and `__pycache__`.
- Supports `layout=preserveTree` so recursive organization can keep the original subdirectory structure under each category folder.
- If the target already contains category folders such as `Images`, `Documents`, `Code`, `Installers`, or `Data`, files inside those folders are treated as already organized and skipped during scans. New matching files may still be moved into those folders; filename conflicts are renamed safely.
- Refuses to apply to drive roots or operating-system/application directories.

## Actions

| Action | Behavior |
| --- | --- |
| `plan` | Scan and return `plannedMoves` without moving files. This is the default. |
| `apply` | Move files according to the generated plan and write an undo manifest. |
| `undo` | Restore files from an undo manifest. Uses `manifestPath` when supplied; otherwise auto-selects the newest matching manifest in the target directory. |


## Recommended Use

1. If the user asks only to preview, dry-run, inspect, or estimate, call `action=plan` and report the plan without applying it.
2. If the user asks to actually organize, sort, tidy, clean up, or classify files, call `action=plan` first and inspect `plannedMoves`, `movesPlanned`, `byCategory`, `warnings`, `failures`, and `plannedMovesTruncated`.
3. When the plan is ordinary, not truncated, has no warnings/failures, and stays within `maxFiles`, call `action=apply` with the same path and options in the same task. Do not ask the user for a second confirmation; the apply result includes an undo manifest for recovery.
4. Pause and ask the user only when the plan is preview-only, risky, ambiguous, truncated, unexpectedly large, or blocked by `maxFiles` / high-risk path checks.
5. Save the returned `undoManifest` path in the final answer whenever files were moved, and mention that `action=undo` can restore the files. Prefer passing `manifestPath`; if it is missing, the script will search the target directory for the newest `file-organizer-undo-manifest-*.json` or legacy `.file-organizer-undo-*.json`.

## Output

The script returns JSON with:

- `movesPlanned`, `filesMoved`, `filesFailed`, `byCategory`
- `plannedMoves` preview rows with `source`, `destination`, `category`, and `reason`
- `warnings` and `failures`
- `undoManifest` after a successful apply
- `cleanedEmptyDirectories` after undo cleanup
- `summary` for concise human-readable reporting

## Troubleshooting

- If `plannedMovesTruncated` is true, rerun with a higher `previewLimit` or narrower `path`.
- If `action=apply` refuses due to `maxFiles`, review a plan first, then narrow the request or pass a higher `maxFiles`.
- If an older undo manifest is hard to find, search for `*undo*.json` or `.file-organizer-undo-*`; older versions did not include the word `manifest` in the filename.
- Undo removes empty category directories created by the organizer. Directories that still contain user files are preserved.
- If undo reports that an original path already exists, the script refuses to overwrite it; inspect the conflicting path manually before retrying.
