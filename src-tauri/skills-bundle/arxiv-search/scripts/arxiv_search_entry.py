"""Script-mode wrapper for the arXiv search skill."""

from __future__ import annotations

import argparse
import sys

import arxiv_search


def optional_positive_int(value: int | None, default: int) -> int:
    if value is None or value <= 0:
        return default
    return value


def optional_non_negative_int(value: int | None, default: int) -> int:
    if value is None or value < 0:
        return default
    return value


def append_optional(argv: list[str], option: str, value: str) -> None:
    if value:
        argv.extend([option, value])


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()

    if action == "search":
        query = args.query.strip()
        has_filter = any([
            args.category.strip(),
            args.filter.strip(),
            args.title.strip(),
            args.author.strip(),
            args.abstract.strip(),
            args.date_from.strip(),
            args.date_to.strip(),
        ])
        if not query and not has_filter:
            raise ValueError("action=search requires --query or a filter argument")
        argv = [
            "arxiv_search.py",
            "search",
        ]
        if query:
            argv.append(query)
        argv.extend([
            "--limit",
            str(optional_positive_int(args.limit, 10)),
            "--start",
            str(optional_non_negative_int(args.start, 0)),
            "--sort",
            args.sort or "relevance",
            "--sort-order",
            args.sort_order or "descending",
            "--field",
            args.field or "all",
            "--abstract-max",
            str(optional_positive_int(args.abstract_max, arxiv_search.DEFAULT_ABSTRACT_MAX_CHARS)),
        ])
        append_optional(argv, "--category", args.category.strip())
        append_optional(argv, "--filter", args.filter.strip())
        append_optional(argv, "--title", args.title.strip())
        append_optional(argv, "--author", args.author.strip())
        append_optional(argv, "--abstract", args.abstract.strip())
        append_optional(argv, "--date-from", args.date_from.strip())
        append_optional(argv, "--date-to", args.date_to.strip())
        return argv

    if action == "latest":
        category = args.category.strip()
        if not category:
            raise ValueError("action=latest requires --category")
        argv = [
            "arxiv_search.py",
            "latest",
            category,
            "--limit",
            str(optional_positive_int(args.limit, 10)),
            "--start",
            str(optional_non_negative_int(args.start, 0)),
            "--sort-order",
            args.sort_order or "descending",
            "--abstract-max",
            str(optional_positive_int(args.abstract_max, arxiv_search.DEFAULT_ABSTRACT_MAX_CHARS)),
        ]
        append_optional(argv, "--filter", args.filter.strip())
        append_optional(argv, "--date-from", args.date_from.strip())
        append_optional(argv, "--date-to", args.date_to.strip())
        return argv

    if action == "detail":
        arxiv_id = args.arxiv_id or args.query
        if not arxiv_id:
            raise ValueError("action=detail requires --arxiv-id or --query")
        return ["arxiv_search.py", "detail", arxiv_id]

    if action == "download":
        arxiv_id = args.arxiv_id or args.query
        if not arxiv_id:
            raise ValueError("action=download requires --arxiv-id or --query")
        argv = [
            "arxiv_search.py",
            "download",
            arxiv_id,
        ]
        append_optional(argv, "--output-dir", args.output_dir.strip())
        append_optional(argv, "--output-file", args.output_file.strip())
        return argv

    if action == "categories":
        return ["arxiv_search.py", "categories"]

    raise ValueError("Unsupported action. Use search, latest, detail, download, or categories.")


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis arXiv search script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--query", default="")
    parser.add_argument("--category", default="")
    parser.add_argument("--arxiv-id", "--arxiv_id", dest="arxiv_id", default="")
    parser.add_argument("--sort", choices=["relevance", "date", "updated"], default="relevance")
    parser.add_argument("--sort-order", "--sort_order", dest="sort_order", default="descending")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--field", default="all")
    parser.add_argument("--filter", default="")
    parser.add_argument("--date-from", "--date_from", dest="date_from", default="")
    parser.add_argument("--date-to", "--date_to", dest="date_to", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--title", default="")
    parser.add_argument("--abstract", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--abstract-max", "--abstract_max", dest="abstract_max", type=int, default=0)
    parser.add_argument("--output-dir", "--output_dir", dest="output_dir", default="")
    parser.add_argument("--output-file", "--output_file", dest="output_file", default="")
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    return arxiv_search.main()


if __name__ == "__main__":
    sys.exit(main())
