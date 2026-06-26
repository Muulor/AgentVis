"""Script-mode wrapper for the Context7 docs skill."""

from __future__ import annotations

import argparse
import sys

import context7_docs


def optional_positive_int(value: int | None, default: int) -> int:
    if value is None or value <= 0:
        return default
    return value


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()
    output_format = (args.output_format or "text").strip().lower()
    if output_format not in {"text", "json"}:
        raise ValueError("outputFormat must be text or json")

    argv = [
        "context7_docs.py",
        action,
        "--limit",
        str(optional_positive_int(args.limit, context7_docs.DEFAULT_LIMIT)),
        "--max",
        str(optional_positive_int(args.max, context7_docs.DEFAULT_TEXT_MAX_CHARS)),
        "--output-format",
        output_format,
    ]

    if action == "search":
        if not args.library_name.strip():
            raise ValueError("action=search requires --libraryName")
        argv.extend(["--library-name", args.library_name.strip()])
        if args.query.strip():
            argv.extend(["--query", args.query.strip()])
        return argv

    if action == "docs":
        if not args.library_id.strip():
            raise ValueError("action=docs requires --libraryId")
        if not args.query.strip():
            raise ValueError("action=docs requires --query")
        argv.extend(["--library-id", args.library_id.strip(), "--query", args.query.strip()])
        return argv

    if action == "resolve-docs":
        if not args.library_name.strip():
            raise ValueError("action=resolve-docs requires --libraryName")
        if not args.query.strip():
            raise ValueError("action=resolve-docs requires --query")
        argv.extend(["--library-name", args.library_name.strip(), "--query", args.query.strip()])
        return argv

    raise ValueError("Unsupported action. Use search, docs, or resolve-docs.")


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis Context7 docs script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--libraryName", "--library-name", dest="library_name", default="")
    parser.add_argument("--libraryId", "--library-id", dest="library_id", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--outputFormat", "--output-format", dest="output_format", default="text")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max", type=int, default=0)
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    return context7_docs.main()


if __name__ == "__main__":
    sys.exit(main())
