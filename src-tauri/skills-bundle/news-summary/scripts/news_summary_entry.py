"""Script-mode wrapper for the News Summary skill."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

import news  # noqa: E402


def optional_positive_int(value: int | None, default: int) -> int:
    if value is None or value <= 0:
        return default
    return value


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()

    if action == "list":
        return ["news.py", "--list"]

    if action == "fetch":
        argv = [
            "news.py",
            args.category or "general",
            "--limit",
            str(optional_positive_int(args.limit, 5)),
            "--max",
            str(optional_positive_int(args.max, 800)),
        ]
        if args.source:
            argv.extend(["--source", args.source])
        if args.full:
            argv.append("--full")
        return argv

    if action == "detail":
        if not args.url:
            raise ValueError("action=detail requires --url")
        return [
            "news.py",
            "detail",
            args.url,
            "--max",
            str(optional_positive_int(args.max, 3000)),
        ]

    raise ValueError("Unsupported action. Use fetch, detail, or list.")


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis news summary script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--category", default="general")
    parser.add_argument("--source", default="")
    parser.add_argument("--url", default="")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--max", type=int, default=0)
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    news.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
