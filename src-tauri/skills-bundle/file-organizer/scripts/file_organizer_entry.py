"""AgentVis Script Skill thin entrypoint for file-organizer.

ExternalExecutor maps contract argsSchema fields to CLI flags:
    python scripts/file_organizer_entry.py --path "C:\\Users\\..." --action plan

Keep parser option names exactly aligned with argsSchema.name.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import file_organizer_core


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan, apply, or undo safe file organization by file type."
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Absolute path to the target directory.",
    )
    parser.add_argument(
        "--action",
        default="plan",
        help="Action to run: plan, apply, or undo. Defaults to plan.",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        default=False,
        help="Recursively process subdirectories. Defaults to false.",
    )
    parser.add_argument(
        "--includeHidden",
        action="store_true",
        default=False,
        help="Include hidden files and directories. Defaults to false.",
    )
    parser.add_argument(
        "--layout",
        default="",
        help="Destination layout: flat or preserveTree. Defaults to preserveTree when recursive.",
    )
    parser.add_argument(
        "--exclude",
        default="",
        help="Comma-separated directory/file names or glob patterns to exclude.",
    )
    parser.add_argument(
        "--manifestPath",
        default="",
        help="Undo manifest path. Required for action=undo; optional for action=apply.",
    )
    parser.add_argument(
        "--maxFiles",
        type=int,
        default=file_organizer_core.DEFAULT_MAX_APPLY_FILES,
        help="Maximum moves allowed for action=apply unless allowLarge is true.",
    )
    parser.add_argument(
        "--previewLimit",
        type=int,
        default=file_organizer_core.DEFAULT_PREVIEW_LIMIT,
        help="Maximum planned move rows included in JSON output.",
    )
    parser.add_argument(
        "--allowLarge",
        action="store_true",
        default=False,
        help="Allow action=apply to exceed maxFiles.",
    )
    return parser


def print_result(result: Any) -> None:
    if isinstance(result, str):
        print(result)
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> int:
    args = build_parser().parse_args()

    try:
        result = file_organizer_core.run(
            path=args.path,
            action=args.action,
            recursive=args.recursive,
            include_hidden=args.includeHidden,
            layout=args.layout,
            exclude=args.exclude,
            manifest_path=args.manifestPath,
            max_files=args.maxFiles,
            preview_limit=args.previewLimit,
            allow_large=args.allowLarge,
        )
    except file_organizer_core.UserCorrectableError as exc:
        print(str(exc))
        return 0
    except Exception as exc:
        print(f"File organizer failed: {exc}", file=sys.stderr)
        return 1

    print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
