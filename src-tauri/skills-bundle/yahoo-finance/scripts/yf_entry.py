"""Named-argument entrypoint for the AgentVis Yahoo Finance Script Skill."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

import yf  # noqa: E402


PERIODS = ("1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max")
INTERVALS = ("1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo")


class ObservationArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise yf.YahooAPIError(
            message,
            error_kind="invalid_request",
            reason_code="YAHOO_ARGUMENT_PARSE_FAILED",
            next_step="Use only the named arguments declared by the yahoo-finance skill contract.",
        )


def requested_output_format(argv: list[str]) -> str:
    for index, value in enumerate(argv):
        if value in {"--outputFormat", "--output-format"} and index + 1 < len(argv):
            return argv[index + 1] if argv[index + 1] in {"text", "json"} else "text"
        if value.startswith("--outputFormat=") or value.startswith("--output-format="):
            candidate = value.split("=", 1)[1]
            return candidate if candidate in {"text", "json"} else "text"
    return "text"


def effective_limit(action: str, value: int) -> int:
    if value > 0:
        return min(value, yf.MAX_RESULT_LIMIT)
    if action == "actions":
        return yf.MAX_RESULT_LIMIT
    if action in {"news", "options", "search"}:
        return 10
    return yf.DEFAULT_RESULT_LIMIT


def observation_request(args: argparse.Namespace) -> dict[str, object]:
    return {
        "symbol": args.symbol or None,
        "query": args.query or None,
        "period": args.period or None,
        "interval": args.interval,
        "start": args.start or None,
        "endExclusive": args.end or None,
        "includePrePost": args.include_pre_post,
        "includeActions": args.include_actions,
        "limit": args.limit or None,
        "expiration": args.expiration or None,
        "statement": args.statement,
        "frequency": args.frequency,
        "periods": args.periods,
        "newsType": args.news_type,
        "includeNews": args.include_news,
        "includeResearch": args.include_research,
        "fuzzy": args.fuzzy,
        "outputFormat": args.output_format,
    }


def build_request(args: argparse.Namespace) -> dict[str, object]:
    action = args.action.strip().lower()
    if action not in yf.STRUCTURED_ACTIONS:
        raise yf.YahooAPIError(
            f"Unsupported action: {action}",
            error_kind="invalid_request",
            reason_code="YAHOO_ACTION_UNSUPPORTED",
            next_step="Choose an action declared by the yahoo-finance skill contract.",
        )
    if args.period and args.period not in PERIODS:
        raise yf.YahooAPIError(
            f"Unsupported period: {args.period}",
            error_kind="invalid_request",
            reason_code="YAHOO_PERIOD_UNSUPPORTED",
            next_step="Choose a period declared by the yahoo-finance skill contract.",
        )
    if args.interval not in INTERVALS:
        raise yf.YahooAPIError(
            f"Unsupported interval: {args.interval}",
            error_kind="invalid_request",
            reason_code="YAHOO_INTERVAL_UNSUPPORTED",
            next_step="Choose an interval declared by the yahoo-finance skill contract.",
        )
    if (args.start or args.end) and args.period:
        raise yf.YahooAPIError(
            "period cannot be combined with start/end",
            error_kind="invalid_request",
            reason_code="YAHOO_RANGE_CONFLICT",
            next_step="Use either period or the start/end pair.",
        )
    if args.output_format not in {"text", "json"}:
        raise yf.YahooAPIError(
            "outputFormat must be text or json",
            error_kind="invalid_request",
            reason_code="YAHOO_OUTPUT_FORMAT_UNSUPPORTED",
            next_step="Choose outputFormat=text or outputFormat=json.",
        )
    if args.statement not in {"income", "balance-sheet", "cash-flow", "all"}:
        raise yf.YahooAPIError(
            f"Unsupported statement: {args.statement}",
            error_kind="invalid_request",
            reason_code="YAHOO_STATEMENT_UNSUPPORTED",
            next_step="Choose income, balance-sheet, cash-flow, or all.",
        )
    if args.frequency not in {"yearly", "quarterly", "trailing"}:
        raise yf.YahooAPIError(
            f"Unsupported frequency: {args.frequency}",
            error_kind="invalid_request",
            reason_code="YAHOO_FREQUENCY_UNSUPPORTED",
            next_step="Choose yearly, quarterly, or trailing.",
        )
    if args.news_type not in {"news", "all", "press-releases"}:
        raise yf.YahooAPIError(
            f"Unsupported newsType: {args.news_type}",
            error_kind="invalid_request",
            reason_code="YAHOO_NEWS_TYPE_UNSUPPORTED",
            next_step="Choose news, all, or press-releases.",
        )
    if args.limit < 0 or args.limit > yf.MAX_RESULT_LIMIT:
        raise yf.YahooAPIError(
            f"limit must be between 1 and {yf.MAX_RESULT_LIMIT}",
            error_kind="invalid_request",
            reason_code="YAHOO_LIMIT_INVALID",
            next_step=f"Choose limit between 1 and {yf.MAX_RESULT_LIMIT}.",
        )
    if args.periods < 1 or args.periods > 8:
        raise yf.YahooAPIError(
            "periods must be between 1 and 8",
            error_kind="invalid_request",
            reason_code="YAHOO_PERIODS_INVALID",
            next_step="Choose periods between 1 and 8.",
        )
    return {
        "action": action,
        "symbol": args.symbol or "",
        "query": args.query or "",
        "period": args.period or "",
        "interval": args.interval,
        "start": args.start or "",
        "end": args.end or "",
        "include_pre_post": args.include_pre_post,
        "include_actions": args.include_actions,
        "limit": effective_limit(action, args.limit),
        "expiration": args.expiration or "",
        "statement": args.statement,
        "frequency": args.frequency,
        "periods": args.periods,
        "news_type": args.news_type,
        "include_news": args.include_news,
        "include_research": args.include_research,
        "fuzzy": args.fuzzy,
    }


def emit(observation: dict[str, object], output_format: str) -> None:
    budget = yf.MAX_JSON_OUTPUT_BYTES if output_format == "json" else 116_000
    bounded = yf.fit_observation_to_budget(observation, max_bytes=budget)
    if output_format == "json":
        print(json.dumps(bounded, ensure_ascii=False, separators=(",", ":")))
    else:
        print(yf.render_observation_text(bounded))


def main() -> int:
    parser = ObservationArgumentParser(description="AgentVis Yahoo Finance script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--period", default="")
    parser.add_argument("--interval", default=yf.DEFAULT_HISTORY_INTERVAL)
    parser.add_argument("--start", default="")
    parser.add_argument("--end", default="")
    parser.add_argument("--includePrePost", "--include-pre-post", dest="include_pre_post", action="store_true")
    parser.add_argument("--includeActions", "--include-actions", dest="include_actions", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--expiration", default="")
    parser.add_argument("--statement", default="income")
    parser.add_argument("--frequency", default="yearly")
    parser.add_argument("--periods", type=int, default=4)
    parser.add_argument("--newsType", "--news-type", dest="news_type", default="news")
    parser.add_argument("--includeNews", "--include-news", dest="include_news", action="store_true")
    parser.add_argument("--includeResearch", "--include-research", dest="include_research", action="store_true")
    parser.add_argument("--fuzzy", action="store_true")
    parser.add_argument("--outputFormat", "--output-format", dest="output_format", default="text")
    action = "unknown"
    requested: dict[str, object] = {}
    output_format = requested_output_format(sys.argv[1:])
    try:
        args = parser.parse_args()
        action = args.action.strip().lower()
        output_format = args.output_format
        requested = observation_request(args)
        request = build_request(args)
        observation = yf.execute_action(**request)
        emit(observation, output_format)
        return 0
    except yf.YahooAPIError as error:
        observation = yf.make_error_observation(action, requested, error)
        emit(observation, output_format)
        if error.error_kind == "invalid_request":
            return 2
        return 3 if error.blocked else 1
    except Exception as error:  # Defensive boundary: never leak a traceback as the Agent observation.
        internal = yf.YahooAPIError(
            f"Unexpected yahoo-finance skill failure: {type(error).__name__}",
            error_kind="internal",
            reason_code="YAHOO_INTERNAL_ERROR",
            next_step="Report this failure to the skill maintainer with the action and symbol.",
        )
        observation = yf.make_error_observation(action, requested, internal)
        emit(observation, output_format)
        return 1
    finally:
        yf.SESSION.close()


if __name__ == "__main__":
    sys.exit(main())
