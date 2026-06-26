"""Script-mode wrapper for the Yahoo Finance skill."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

import yf  # noqa: E402


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()
    if action not in yf.COMMANDS:
        raise ValueError(
            "Unsupported action. Use price, quote, fundamentals, earnings, "
            "profile, dividends, ratings, options, history, compare, or search."
        )

    symbol = args.symbol or args.query
    if not symbol:
        raise ValueError(f"action={action} requires --symbol or --query")

    argv = ["yf.py", action, symbol]
    if action == "history" and args.period:
        argv.append(args.period)
    return argv


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis Yahoo Finance script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--period", default=yf.DEFAULT_HISTORY_PERIOD)
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    return yf.main()


if __name__ == "__main__":
    sys.exit(main())
