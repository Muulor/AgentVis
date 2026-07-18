from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch


SKILL_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SKILL_DIR))

import yf  # noqa: E402


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


class FakeSession:
    def __init__(self) -> None:
        self.request_log: list[dict] = []

    def reset_observation(self) -> None:
        self.request_log = []

    def close(self) -> None:
        return None

    def _record(self, endpoint_family: str, method: str = "GET") -> None:
        self.request_log.append({
            "endpointFamily": endpoint_family,
            "host": "query2.finance.yahoo.com",
            "method": method,
            "status": 200,
            "transport": "fixture",
        })

    def json_get(self, url: str, *, crumb: bool = False, endpoint_family: str = "unknown") -> dict:
        del crumb
        self._record(endpoint_family)
        if "/v7/finance/quote" in url:
            return copy.deepcopy(load_fixture("quote.json"))
        if "/quoteSummary/" in url:
            return copy.deepcopy(load_fixture("quote_summary.json"))
        if "/chart/" in url:
            return copy.deepcopy(load_fixture("chart.json"))
        if "/fundamentals-timeseries/" in url:
            return copy.deepcopy(load_fixture("financial_timeseries.json"))
        if "/options/" in url:
            return copy.deepcopy(load_fixture("options.json"))
        raise AssertionError(f"No fixture for URL: {url}")

    def json_request(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict | None = None,
        crumb: bool = False,
        endpoint_family: str = "unknown",
    ) -> dict:
        del url, json_body, crumb
        self._record(endpoint_family, method)
        return copy.deepcopy(load_fixture("news.json"))


class YahooFinanceObservationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.session = FakeSession()
        self.session_patch = patch.object(yf, "SESSION", self.session)
        self.session_patch.start()

    def tearDown(self) -> None:
        self.session_patch.stop()

    def test_history_aligns_short_arrays_and_reports_truncation(self) -> None:
        observation = yf.execute_action(
            "history",
            symbol="AAPL",
            period="1mo",
            limit=2,
            include_actions=True,
        )

        self.assertEqual(observation["status"], "partial_success")
        self.assertEqual(observation["data"]["returned"], 2)
        self.assertEqual(observation["data"]["prices"][0]["open"], 11.0)
        self.assertIsNone(observation["data"]["prices"][1]["open"])
        self.assertEqual(len(observation["data"]["actions"]["capitalGains"]), 1)
        self.assertEqual(observation["warnings"][0]["reasonCode"], "YAHOO_RESULT_TRUNCATED")

    def test_30m_history_requests_15m_and_resamples_ohlcv(self) -> None:
        payload = {
            "chart": {
                "result": [
                    {
                        "meta": {"symbol": "AAPL", "dataGranularity": "15m"},
                        "timestamp": [0, 900, 1800, 2700],
                        "indicators": {
                            "quote": [{
                                "open": [1.0, 2.0, 3.0, 4.0],
                                "high": [2.0, 3.0, 4.0, 5.0],
                                "low": [0.0, 1.0, 2.0, 3.0],
                                "close": [1.5, 2.5, 3.5, 4.5],
                                "volume": [10, 20, 30, 40],
                            }],
                            "adjclose": [{"adjclose": [1.4, 2.4, 3.4, 4.4]}],
                        },
                    }
                ],
                "error": None,
            }
        }
        requested_urls: list[str] = []

        def json_get(url: str, **_: object) -> dict:
            requested_urls.append(url)
            return copy.deepcopy(payload)

        with patch.object(self.session, "json_get", side_effect=json_get):
            data, warnings = yf.fetch_history_data(
                "AAPL",
                interval="30m",
                period="5d",
                limit=10,
            )

        self.assertIn("interval=15m", requested_urls[0])
        self.assertEqual(warnings, [])
        self.assertEqual(data["requestedInterval"], "30m")
        self.assertEqual(data["interval"], "30m")
        self.assertEqual(len(data["prices"]), 2)
        self.assertEqual(data["prices"][0]["open"], 1.0)
        self.assertEqual(data["prices"][0]["high"], 3.0)
        self.assertEqual(data["prices"][0]["close"], 2.5)
        self.assertEqual(data["prices"][0]["volume"], 30)

    def test_actions_normalizes_all_chart_event_families(self) -> None:
        observation = yf.execute_action("actions", symbol="AAPL", period="max", limit=10)

        self.assertEqual(observation["status"], "success")
        self.assertEqual(len(observation["data"]["dividends"]), 1)
        self.assertEqual(observation["data"]["splits"][0]["ratio"], "4:1")
        self.assertEqual(len(observation["data"]["capitalGains"]), 1)

    def test_financials_preserves_cells_and_marks_omitted_metrics(self) -> None:
        observation = yf.execute_action(
            "financials",
            symbol="AAPL",
            statement="income",
            frequency="yearly",
            periods=1,
        )

        self.assertEqual(observation["status"], "partial_success")
        statement = observation["data"]["statements"][0]
        self.assertEqual(statement["items"][0]["key"], "TotalRevenue")
        self.assertEqual(statement["items"][0]["values"][0]["raw"], 400000000000)
        self.assertIn("GrossProfit", observation["warnings"][0]["affectedFields"])

    def test_empty_financial_series_is_counted_as_unavailable(self) -> None:
        items, missing = yf._parse_financial_series(
            [
                {
                    "meta": {"type": ["annualTotalRevenue"]},
                    "annualTotalRevenue": [],
                }
            ],
            "annual",
            ("TotalRevenue",),
            4,
        )

        self.assertEqual(items, [])
        self.assertEqual(missing, ["TotalRevenue"])

    def test_earnings_reads_nested_calendar_events(self) -> None:
        observation = yf.execute_action("earnings", symbol="AAPL")

        self.assertEqual(observation["status"], "success")
        self.assertEqual(observation["data"]["calendar"]["earningsAverage"], 1.8)
        self.assertEqual(observation["data"]["calendar"]["revenueAverage"], 125000000000)
        self.assertEqual(len(observation["data"]["calendar"]["earningsDates"]), 1)

    def test_empty_quote_summary_is_partial_instead_of_null_success(self) -> None:
        quote = load_fixture("quote.json")
        empty_summary = {"quoteSummary": {"result": [], "error": None}}
        with patch.object(self.session, "json_get", side_effect=[quote, empty_summary]):
            observation = yf.execute_action("fundamentals", symbol="AAPL")

        self.assertEqual(observation["status"], "partial_success")
        self.assertEqual(observation["warnings"][0]["reasonCode"], "YAHOO_QUOTE_SUMMARY_NO_DATA")

    def test_missing_quote_summary_modules_are_reported(self) -> None:
        quote = load_fixture("quote.json")
        partial_summary = {
            "quoteSummary": {
                "result": [{"financialData": {}}],
                "error": None,
            }
        }
        with patch.object(self.session, "json_get", side_effect=[quote, partial_summary]):
            observation = yf.execute_action("fundamentals", symbol="AAPL")

        self.assertEqual(observation["status"], "partial_success")
        warning = observation["warnings"][0]
        self.assertEqual(warning["reasonCode"], "YAHOO_QUOTE_SUMMARY_MODULES_UNAVAILABLE")
        self.assertIn("summaryDetail", warning["affectedModules"])

    def test_news_uses_ticker_stream_and_filters_ads(self) -> None:
        observation = yf.execute_action(
            "news",
            symbol="AAPL",
            news_type="press-releases",
            limit=5,
        )

        self.assertEqual(observation["status"], "success")
        self.assertEqual(observation["data"]["returned"], 1)
        self.assertEqual(observation["data"]["articles"][0]["publisher"], "Example Wire")
        self.assertEqual(self.session.request_log[0]["method"], "POST")

    def test_options_returns_selected_chain_shape(self) -> None:
        observation = yf.execute_action("options", symbol="AAPL", limit=1)

        self.assertEqual(observation["status"], "success")
        self.assertEqual(observation["data"]["underlyingPrice"], 200.5)
        self.assertEqual(observation["data"]["calls"][0]["contractSymbol"], "AAPL-C")
        self.assertEqual(observation["data"]["puts"][0]["contractSymbol"], "AAPL-P")

    def test_options_does_not_relabel_default_chain_when_second_response_is_empty(self) -> None:
        first = load_fixture("options.json")
        empty_second = {"optionChain": {"result": [], "error": None}}
        expiration = yf._date_from_epoch(1800000000)
        with patch.object(self.session, "json_get", side_effect=[first, empty_second]):
            with self.assertRaises(yf.YahooAPIError) as raised:
                yf.fetch_options_data("AAPL", expiration=expiration, limit=1)

        self.assertEqual(raised.exception.reason_code, "YAHOO_OPTIONS_EXPIRATION_NOT_FOUND")

    def test_json_budget_reduces_complete_items_before_executor_truncation(self) -> None:
        observation = yf.make_success_observation(
            "news",
            {"symbol": "AAPL"},
            {
                "symbol": "AAPL",
                "articles": [
                    {"id": str(index), "summary": "x" * 400}
                    for index in range(12)
                ],
            },
            [],
        )

        bounded = yf.fit_observation_to_budget(observation, max_bytes=1400)
        encoded = json.dumps(bounded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

        self.assertLessEqual(len(encoded), 1400)
        self.assertEqual(bounded["status"], "partial_success")
        self.assertTrue(bounded["source"]["outputTruncated"])
        self.assertEqual(bounded["warnings"][-1]["reasonCode"], "YAHOO_OUTPUT_TRUNCATED")


class YahooFinanceErrorTests(unittest.TestCase):
    def test_duplicate_set_cookie_headers_are_preserved_for_broker_crumb_flow(self) -> None:
        headers = [
            ("Set-Cookie", "A=one; Path=/"),
            ("Set-Cookie", "B=two; Path=/"),
        ]
        session = yf.YahooSession()

        combined = yf.response_headers_dict(headers)
        session._update_cookies(headers)

        self.assertIn("A=one", combined["set-cookie"])
        self.assertIn("B=two", combined["set-cookie"])
        self.assertEqual(session.cookies, {"A": "one", "B": "two"})

    def test_broker_unavailable_is_blocked_not_retryable(self) -> None:
        session = yf.YahooSession()
        completed = subprocess.CompletedProcess(
            args=["agentvis-broker-fetch"],
            returncode=1,
            stdout=json.dumps({
                "ok": False,
                "reasonCode": "broker_helper_unavailable",
                "errorKind": "broker_helper_unavailable",
                "error": "failed https://example.invalid/?crumb=secret&token=secret",
            }),
            stderr="",
        )
        with patch.object(yf.subprocess, "run", return_value=completed):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        error = raised.exception
        self.assertTrue(error.blocked)
        self.assertFalse(error.retryable)
        observation = yf.make_error_observation("history", {"symbol": "AAPL"}, error)
        self.assertEqual(observation["status"], "blocked")
        encoded = json.dumps(observation)
        self.assertNotIn("crumb=secret", encoded)
        self.assertNotIn("token=secret", encoded)

    def test_broker_process_timeout_is_classified(self) -> None:
        session = yf.YahooSession()
        with patch.object(
            yf.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("agentvis-broker-fetch", 1),
        ):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        self.assertEqual(raised.exception.reason_code, "broker_response_timeout")
        self.assertTrue(raised.exception.retryable)

    def test_broker_invalid_base64_is_protocol_error(self) -> None:
        session = yf.YahooSession()
        completed = subprocess.CompletedProcess(
            args=["agentvis-broker-fetch"],
            returncode=0,
            stdout=json.dumps({
                "ok": True,
                "status": 200,
                "bodyBase64": "not base64!",
            }),
            stderr="",
        )
        with patch.object(yf.subprocess, "run", return_value=completed):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        self.assertEqual(raised.exception.reason_code, "YAHOO_BROKER_INVALID_RESPONSE")

    def test_transport_failure_records_requested_endpoint_family(self) -> None:
        session = yf.YahooSession()
        failure = yf.YahooAPIError(
            "network failed",
            error_kind="network",
            reason_code="YAHOO_NETWORK_ERROR",
            retryable=True,
        )
        with patch.object(session, "_request_direct", side_effect=failure):
            with self.assertRaises(yf.YahooAPIError):
                session.request(
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                    endpoint_family="chart",
                )

        self.assertEqual(session.request_log[0]["endpointFamily"], "chart")
        self.assertEqual(session.request_log[0]["transport"], "direct")

    def test_execution_deadline_is_shorter_than_skill_timeout(self) -> None:
        session = yf.YahooSession()
        session._started_at = time.monotonic() - yf.EXECUTION_DEADLINE_SECONDS

        with self.assertRaises(yf.YahooAPIError) as raised:
            session._remaining_timeout()

        self.assertEqual(raised.exception.reason_code, "YAHOO_DEADLINE_EXCEEDED")
        self.assertTrue(raised.exception.retryable)

    def test_broker_timeout_is_retryable(self) -> None:
        session = yf.YahooSession()
        completed = subprocess.CompletedProcess(
            args=["agentvis-broker-fetch"],
            returncode=1,
            stdout=json.dumps({
                "ok": False,
                "reasonCode": "broker_response_timeout",
                "errorKind": "broker_response_timeout",
                "error": "timed out waiting for broker response",
            }),
            stderr="",
        )
        with patch.object(yf.subprocess, "run", return_value=completed):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        self.assertTrue(raised.exception.retryable)
        self.assertFalse(raised.exception.blocked)

    def test_broker_dns_failure_is_retryable(self) -> None:
        session = yf.YahooSession()
        completed = subprocess.CompletedProcess(
            args=["agentvis-broker-fetch"],
            returncode=1,
            stdout=json.dumps({
                "ok": False,
                "reasonCode": "network_dns_failed",
                "errorKind": "network_dns_failed",
                "error": "DNS resolution failed",
            }),
            stderr="",
        )
        with patch.object(yf.subprocess, "run", return_value=completed):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        self.assertTrue(raised.exception.retryable)

    def test_broker_truncation_is_a_stable_protocol_error(self) -> None:
        session = yf.YahooSession()
        completed = subprocess.CompletedProcess(
            args=["agentvis-broker-fetch"],
            returncode=0,
            stdout=json.dumps({"ok": True, "status": 200, "truncated": True}),
            stderr="",
        )
        with patch.object(yf.subprocess, "run", return_value=completed):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session._request_broker(
                    "GET",
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                )

        self.assertEqual(raised.exception.reason_code, "YAHOO_BROKER_RESPONSE_TRUNCATED")
        self.assertEqual(raised.exception.error_kind, "broker_protocol")

    def test_http_429_is_retryable_and_preserves_retry_after(self) -> None:
        session = yf.YahooSession()
        response = yf.HTTPResponse(429, "rate limited", {"retry-after": "17"})
        with patch.object(session, "_request_direct", return_value=response):
            with self.assertRaises(yf.YahooAPIError) as raised:
                session.request(
                    "https://query2.finance.yahoo.com/v8/finance/chart/AAPL",
                    endpoint_family="chart",
                )

        error = raised.exception
        self.assertEqual(error.reason_code, "YAHOO_HTTP_429")
        self.assertTrue(error.retryable)
        self.assertEqual(error.retry_after, 17)
        self.assertNotIn("rate limited", str(error))

    def test_missing_chart_root_is_schema_change(self) -> None:
        session = FakeSession()
        with patch.object(session, "json_get", return_value={}):
            with patch.object(yf, "SESSION", session):
                with self.assertRaises(yf.YahooAPIError) as raised:
                    yf.get_chart("AAPL")

        self.assertEqual(raised.exception.reason_code, "YAHOO_CHART_SCHEMA_CHANGED")
        self.assertEqual(raised.exception.error_kind, "provider_schema_changed")


if __name__ == "__main__":
    unittest.main()
