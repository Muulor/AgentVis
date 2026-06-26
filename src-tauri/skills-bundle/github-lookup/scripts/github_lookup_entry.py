"""Script-mode wrapper for the GitHub lookup skill."""

from __future__ import annotations

import argparse
import sys

import github_lookup


def optional_positive_int(value: int | None, default: int) -> int:
    if value is None or value <= 0:
        return default
    return value


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()
    if action == "search":
        if not args.query:
            raise ValueError("action=search requires --query")
        return [
            "github_lookup.py",
            "search",
            args.query,
            "--limit",
            str(optional_positive_int(args.limit, 10)),
            "--sort",
            args.sort or "best-match",
        ]

    if action == "info":
        if not args.repo:
            raise ValueError("action=info requires --repo")
        return ["github_lookup.py", "info", args.repo]

    if action == "readme":
        if not args.repo:
            raise ValueError("action=readme requires --repo")
        return [
            "github_lookup.py",
            "readme",
            args.repo,
            "--max",
            str(optional_positive_int(args.max, github_lookup.DEFAULT_README_MAX_CHARS)),
        ]

    if action == "tree":
        if not args.repo:
            raise ValueError("action=tree requires --repo")
        argv = [
            "github_lookup.py",
            "tree",
            args.repo,
            "--depth",
            str(optional_positive_int(args.depth, 3)),
            "--limit",
            str(optional_positive_int(args.limit, 100)),
        ]
        if args.path:
            argv.extend(["--path", args.path])
        return argv

    if action == "file":
        if not args.repo or not args.path:
            raise ValueError("action=file requires --repo and --path")
        argv = [
            "github_lookup.py",
            "file",
            args.repo,
            args.path,
            "--max",
            str(optional_positive_int(args.max, github_lookup.DEFAULT_FILE_MAX_CHARS)),
        ]
        if args.ref:
            argv.extend(["--ref", args.ref])
        return argv

    if action == "releases":
        if not args.repo:
            raise ValueError("action=releases requires --repo")
        return [
            "github_lookup.py",
            "releases",
            args.repo,
            "--limit",
            str(optional_positive_int(args.limit, 10)),
        ]

    if action == "issues":
        if not args.repo:
            raise ValueError("action=issues requires --repo")
        argv = [
            "github_lookup.py",
            "issues",
            args.repo,
            "--state",
            args.state or "open",
            "--limit",
            str(optional_positive_int(args.limit, 10)),
        ]
        if args.labels:
            argv.extend(["--labels", args.labels])
        return argv

    raise ValueError("Unsupported action. Use search, info, readme, tree, file, releases, or issues.")


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis GitHub lookup script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--query", default="")
    parser.add_argument("--repo", default="")
    parser.add_argument("--path", default="")
    parser.add_argument("--ref", default="")
    parser.add_argument("--sort", default="best-match")
    parser.add_argument("--state", default="open")
    parser.add_argument("--labels", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max", type=int, default=0)
    parser.add_argument("--depth", type=int, default=0)
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    github_lookup.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
