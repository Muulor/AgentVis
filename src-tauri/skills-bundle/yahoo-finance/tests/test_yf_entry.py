from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest


ENTRY_PATH = Path(__file__).resolve().parents[1] / "scripts" / "yf_entry.py"
SPEC = importlib.util.spec_from_file_location("yahoo_finance_entry", ENTRY_PATH)
assert SPEC is not None and SPEC.loader is not None
yahoo_finance_entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(yahoo_finance_entry)


def namespace(**overrides: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "action": "history",
        "symbol": "AAPL",
        "query": "",
        "period": "",
        "interval": "1d",
        "start": "",
        "end": "",
        "include_pre_post": False,
        "include_actions": False,
        "limit": 0,
        "expiration": "",
        "statement": "income",
        "frequency": "yearly",
        "periods": 4,
        "news_type": "news",
        "include_news": False,
        "include_research": False,
        "fuzzy": False,
        "output_format": "json",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class YahooFinanceEntryContractTests(unittest.TestCase):
    def test_named_flags_map_to_core_request(self) -> None:
        request = yahoo_finance_entry.build_request(
            namespace(
                action="financials",
                statement="cash-flow",
                frequency="quarterly",
                periods=5,
            )
        )

        self.assertEqual(request["action"], "financials")
        self.assertEqual(request["statement"], "cash-flow")
        self.assertEqual(request["frequency"], "quarterly")
        self.assertEqual(request["periods"], 5)

    def test_period_and_dates_conflict_is_stable_validation_error(self) -> None:
        with self.assertRaises(yahoo_finance_entry.yf.YahooAPIError) as raised:
            yahoo_finance_entry.build_request(
                namespace(period="1mo", start="2026-01-01", end="2026-02-01")
            )

        self.assertEqual(raised.exception.reason_code, "YAHOO_RANGE_CONFLICT")
        self.assertEqual(raised.exception.error_kind, "invalid_request")

    def test_argparse_errors_return_json_observation_without_traceback(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(ENTRY_PATH),
                "--action",
                "price",
                "--unknownFlag",
                "value",
                "--outputFormat",
                "json",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        observation = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(observation["error"]["reasonCode"], "YAHOO_ARGUMENT_PARSE_FAILED")
        self.assertEqual(completed.stderr, "")

    def test_validation_error_preserves_action_specific_request(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(ENTRY_PATH),
                "--action",
                "financials",
                "--symbol",
                "AAPL",
                "--statement",
                "cash-flow",
                "--frequency",
                "invalid",
                "--periods",
                "5",
                "--outputFormat",
                "json",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        observation = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(observation["requested"]["statement"], "cash-flow")
        self.assertEqual(observation["requested"]["frequency"], "invalid")
        self.assertEqual(observation["requested"]["periods"], 5)

    def test_action_specific_default_limits(self) -> None:
        self.assertEqual(
            yahoo_finance_entry.build_request(namespace(action="actions"))["limit"],
            250,
        )
        self.assertEqual(
            yahoo_finance_entry.build_request(namespace(action="news"))["limit"],
            10,
        )

    def test_text_output_is_bounded_before_executor_hard_truncation(self) -> None:
        observation = yahoo_finance_entry.yf.make_success_observation(
            "news",
            {"symbol": "AAPL"},
            {
                "articles": [
                    {"id": str(index), "summary": "x" * 2000}
                    for index in range(100)
                ]
            },
            [],
        )
        stdout = io.StringIO()

        with redirect_stdout(stdout):
            yahoo_finance_entry.emit(observation, "text")

        encoded = stdout.getvalue().encode("utf-8")
        self.assertLess(len(encoded), 131072)
        self.assertIn("YAHOO_OUTPUT_TRUNCATED", stdout.getvalue())
        self.assertIn("Narrow the request", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
