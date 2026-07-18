"""
Yahoo Finance CLI - stock/ETF/crypto market data query tool.

Uses Yahoo Finance JSON endpoints directly. In AgentVis brokerOnly mode,
HTTP(S) requests are sent through agentvis-broker-fetch; local direct runs fall
back to httpx. No API key is required.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
import io
import json
import os
import subprocess
import sys
import time
from typing import Any
from urllib.parse import quote as url_quote
from urllib.parse import urlencode, urlparse

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


REQUEST_TIMEOUT_SECONDS = 12
EXECUTION_DEADLINE_SECONDS = 82
USER_AGENT = "Mozilla/5.0 AgentVis-Yahoo-Finance/1.0"
DEFAULT_HISTORY_PERIOD = "1mo"
DEFAULT_HISTORY_INTERVAL = "1d"
DEFAULT_RESULT_LIMIT = 25
MAX_RESULT_LIMIT = 250
MAX_JSON_OUTPUT_BYTES = 118_000
OBSERVATION_SCHEMA_VERSION = "1.0"
HeaderItems = Iterable[tuple[str, str]]
QUOTE_SUMMARY_MODULES = ",".join([
    "assetProfile",
    "summaryProfile",
    "summaryDetail",
    "financialData",
    "defaultKeyStatistics",
    "recommendationTrend",
    "upgradeDowngradeHistory",
    "earnings",
    "earningsHistory",
    "earningsTrend",
    "calendarEvents",
])

FINANCIAL_STATEMENT_KEYS: dict[str, tuple[str, ...]] = {
    "income": (
        "TotalRevenue",
        "CostOfRevenue",
        "GrossProfit",
        "OperatingExpense",
        "OperatingIncome",
        "PretaxIncome",
        "TaxProvision",
        "NetIncome",
        "NetIncomeCommonStockholders",
        "BasicEPS",
        "DilutedEPS",
        "EBIT",
        "EBITDA",
        "BasicAverageShares",
        "DilutedAverageShares",
    ),
    "balance-sheet": (
        "TotalAssets",
        "CurrentAssets",
        "CashCashEquivalentsAndShortTermInvestments",
        "AccountsReceivable",
        "Inventory",
        "NetPPE",
        "GoodwillAndOtherIntangibleAssets",
        "TotalLiabilitiesNetMinorityInterest",
        "CurrentLiabilities",
        "PayablesAndAccruedExpenses",
        "TotalDebt",
        "NetDebt",
        "StockholdersEquity",
        "RetainedEarnings",
        "OrdinarySharesNumber",
        "WorkingCapital",
        "InvestedCapital",
        "TangibleBookValue",
    ),
    "cash-flow": (
        "OperatingCashFlow",
        "InvestingCashFlow",
        "FinancingCashFlow",
        "EndCashPosition",
        "ChangesInCash",
        "CapitalExpenditure",
        "FreeCashFlow",
        "IssuanceOfCapitalStock",
        "RepurchaseOfCapitalStock",
        "CashDividendsPaid",
        "IssuanceOfDebt",
        "RepaymentOfDebt",
        "ChangeInWorkingCapital",
        "DepreciationAndAmortization",
    ),
}


class YahooAPIError(Exception):
    """Yahoo Finance API error."""

    def __init__(
        self,
        message: str,
        *,
        error_kind: str = "provider_error",
        reason_code: str = "YAHOO_REQUEST_FAILED",
        retryable: bool = False,
        retry_after: int | None = None,
        http_status: int | None = None,
        endpoint_family: str | None = None,
        next_step: str | None = None,
        blocked: bool = False,
    ) -> None:
        super().__init__(message)
        self.error_kind = error_kind
        self.reason_code = reason_code
        self.retryable = retryable
        self.retry_after = retry_after
        self.http_status = http_status
        self.endpoint_family = endpoint_family
        self.next_step = next_step
        self.blocked = blocked

    def to_observation(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "errorKind": self.error_kind,
            "reasonCode": self.reason_code,
            "message": str(self),
            "retryable": self.retryable,
            "blocked": self.blocked,
        }
        if self.retry_after is not None:
            result["retryAfterSeconds"] = self.retry_after
        if self.http_status is not None:
            result["httpStatus"] = self.http_status
        if self.endpoint_family:
            result["endpointFamily"] = self.endpoint_family
        return result


class HTTPResponse:
    def __init__(self, status_code: int, text: str, headers: dict[str, str]) -> None:
        self.status_code = status_code
        self.text = text
        self.headers = headers

    def json(self) -> Any:
        return json.loads(self.text)


class SimpleTable:
    """Plain-text table renderer."""

    def __init__(self, columns: list[str], show_header: bool = True) -> None:
        self.columns = columns
        self.rows: list[list[str]] = []
        self.show_header = show_header

    def add_row(self, *values: object) -> None:
        self.rows.append([str(v) for v in values])

    def render(self) -> str:
        if not self.rows:
            return "(no data)"
        all_rows = ([self.columns] if self.show_header else []) + self.rows
        widths = [
            min(max(len(row[i]) if i < len(row) else 0 for row in all_rows), 42)
            for i in range(len(self.columns))
        ]
        lines: list[str] = []
        if self.show_header:
            lines.append("  ".join(self.columns[i][:widths[i]].ljust(widths[i]) for i in range(len(self.columns))))
            lines.append("  ".join("-" * width for width in widths))
        for row in self.rows:
            lines.append("  ".join((row[i] if i < len(row) else "")[:widths[i]].ljust(widths[i]) for i in range(len(widths))))
        return "\n".join(lines)


def _print(text: str = "") -> None:
    print(text)


def _print_table(table: SimpleTable) -> None:
    print(table.render())


def _safe(val: object, fmt: str = "", suffix: str = "") -> str:
    if val is None:
        return "N/A"
    try:
        from math import isnan
        if isinstance(val, float) and isnan(val):
            return "N/A"
    except (TypeError, ValueError):
        pass
    if fmt:
        try:
            return f"{val:{fmt}}{suffix}"
        except (TypeError, ValueError):
            return "N/A"
    return f"{val}{suffix}"


def _pct(val: object) -> str:
    if val is None:
        return "N/A"
    try:
        from math import isnan
        if isinstance(val, float) and isnan(val):
            return "N/A"
        return f"{val * 100:.2f}%"
    except (TypeError, ValueError):
        return "N/A"


def _money(val: object, currency: str = "") -> str:
    if val is None:
        return "N/A"
    try:
        from math import isnan
        if isinstance(val, float) and isnan(val):
            return "N/A"
        prefix = f"{currency} " if currency else ""
        return f"{prefix}{val:,.0f}"
    except (TypeError, ValueError):
        return "N/A"


def _date_from_epoch(value: object) -> str:
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return "N/A"


def _iso_from_epoch(value: object) -> str | None:
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _parse_retry_after(value: object) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(float(str(value))))
    except (TypeError, ValueError):
        return None


def _value(node: Any) -> Any:
    if isinstance(node, dict):
        if "raw" in node:
            return node.get("raw")
        if "fmt" in node:
            return node.get("fmt")
    return node


def broker_helper_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


def broker_helper_required() -> bool:
    if not broker_helper_available():
        return False
    return (
        os.environ.get("AGENTVIS_NETWORK_BROKER_MODE") == "required"
        or os.environ.get("AGENTVIS_BROKER_MODE") == "explicit"
    )


def broker_failure_diagnostics(payload: dict[str, Any], url: str) -> str:
    """Return stable broker diagnostics for Agent observations."""
    lines = []
    reason_code = str(payload.get("reasonCode") or "").strip()
    error_kind = str(payload.get("errorKind") or "").strip()
    if reason_code:
        lines.append(f"brokerReasonCode: {reason_code}")
    if error_kind:
        lines.append(f"brokerErrorKind: {error_kind}")
    target_host = str(payload.get("targetHost") or urlparse(url).hostname or "").strip()
    if target_host:
        lines.append(f"brokerTargetHost: {target_host}")
    credential_ref = str(payload.get("credentialRef") or "").strip()
    if credential_ref:
        lines.append(f"brokerCredentialRef: {credential_ref}")
    if "credentialApplied" in payload:
        lines.append(f"credentialApplied: {bool(payload.get('credentialApplied'))}")
    if not lines:
        return ""
    return "\n" + "\n".join(lines)


def broker_response_header_items(payload: dict[str, Any]) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for item in payload.get("headers") or []:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        result.append((str(item.get("name", "")), str(item.get("value", ""))))
    return result


def response_headers_dict(headers: HeaderItems) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in headers:
        key = name.lower()
        if key == "set-cookie" and key in result:
            result[key] = f"{result[key]}\n{value}"
        else:
            result[key] = value
    return result


class YahooSession:
    def __init__(self) -> None:
        self.cookies: dict[str, str] = {}
        self.crumb: str | None = None
        self._client: Any = None
        self.request_log: list[dict[str, Any]] = []
        self._started_at = time.monotonic()

    def reset_observation(self) -> None:
        self.request_log = []
        self._started_at = time.monotonic()

    def _remaining_timeout(self) -> float:
        remaining = EXECUTION_DEADLINE_SECONDS - (time.monotonic() - self._started_at)
        if remaining <= 1:
            raise YahooAPIError(
                "Yahoo Finance execution deadline was reached",
                error_kind="timeout",
                reason_code="YAHOO_DEADLINE_EXCEEDED",
                retryable=True,
                next_step="Retry with a narrower action after network conditions improve.",
            )
        return min(float(REQUEST_TIMEOUT_SECONDS), remaining - 1)

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
        self.cookies = {}
        self.crumb = None

    def _cookie_header(self) -> str:
        return "; ".join(f"{name}={value}" for name, value in self.cookies.items())

    def _update_cookies(self, headers: HeaderItems | dict[str, str]) -> None:
        items = headers.items() if isinstance(headers, dict) else headers
        for name, value in items:
            if name.lower() != "set-cookie":
                continue
            for header_value in str(value).splitlines():
                cookie = header_value.split(";", 1)[0]
                if "=" in cookie:
                    key, cookie_value = cookie.split("=", 1)
                    if key and cookie_value:
                        self.cookies[key] = cookie_value

    def _request_broker(
        self,
        method: str,
        url: str,
        accept: str = "application/json",
        json_body: dict[str, Any] | None = None,
    ) -> HTTPResponse:
        helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
        remaining_timeout = self._remaining_timeout()
        headers = {
            "Accept": accept,
            "User-Agent": USER_AGENT,
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        cookie = self._cookie_header()
        if cookie:
            headers["Cookie"] = cookie
        request = {
            "method": method,
            "url": url,
            "headers": [{"name": k, "value": v} for k, v in headers.items()],
            "timeoutMs": int(remaining_timeout * 1000),
        }
        if json_body is not None:
            request["bodyBase64"] = base64.b64encode(
                json.dumps(json_body, separators=(",", ":")).encode("utf-8")
            ).decode("ascii")
        try:
            completed = subprocess.run(
                [helper],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                timeout=remaining_timeout + 2,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise YahooAPIError(
                "Broker helper timed out before returning a response",
                error_kind="broker_response_timeout",
                reason_code="broker_response_timeout",
                retryable=True,
                endpoint_family="broker",
                next_step="Retry after the broker recovers.",
            ) from exc
        except OSError as exc:
            raise YahooAPIError(
                f"Broker helper could not start: {type(exc).__name__}",
                error_kind="broker_helper_unavailable",
                reason_code="broker_helper_unavailable",
                endpoint_family="broker",
                blocked=True,
                next_step="Check the AgentVis broker helper installation and network mode.",
            ) from exc
        try:
            payload = json.loads(completed.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise YahooAPIError(
                f"Broker helper returned invalid JSON: {exc}",
                error_kind="broker_protocol",
                reason_code="YAHOO_BROKER_INVALID_RESPONSE",
            ) from exc
        if not isinstance(payload, dict):
            raise YahooAPIError(
                "Broker helper returned a non-object JSON response",
                error_kind="broker_protocol",
                reason_code="YAHOO_BROKER_INVALID_RESPONSE",
                endpoint_family="broker",
                next_step="Report the broker protocol response to the skill maintainer.",
            )
        if completed.returncode != 0 or payload.get("ok") is not True:
            broker_kind = str(payload.get("errorKind") or "broker_failure")
            broker_reason = str(payload.get("reasonCode") or "YAHOO_BROKER_REQUEST_FAILED")
            broker_classification = f"{broker_kind} {broker_reason}".lower()
            retryable = bool(payload.get("retryable")) or any(
                token in broker_classification
                for token in (
                    "timeout",
                    "network_",
                    "connection",
                    "upstream",
                    "rate_limit",
                )
            )
            blocked = any(
                token in broker_classification
                for token in (
                    "policy",
                    "blocked",
                    "credential",
                    "helper_unavailable",
                    "not_configured",
                )
            )
            raise YahooAPIError(
                f"Broker helper request failed{broker_failure_diagnostics(payload, url)}",
                error_kind=broker_kind,
                reason_code=broker_reason,
                retryable=retryable,
                endpoint_family="broker",
                blocked=blocked,
                next_step=(
                    "Retry after the broker or upstream service recovers."
                    if retryable
                    else "Check the AgentVis network policy and broker diagnostics."
                ),
            )
        if payload.get("truncated"):
            raise YahooAPIError(
                "Broker helper truncated the Yahoo Finance response",
                error_kind="broker_protocol",
                reason_code="YAHOO_BROKER_RESPONSE_TRUNCATED",
                endpoint_family="broker",
                next_step="Narrow the request or report the broker response limit.",
            )
        response_header_items = broker_response_header_items(payload)
        response_headers = response_headers_dict(response_header_items)
        self._update_cookies(response_header_items)
        try:
            status_code = int(payload.get("status"))
            if status_code < 100 or status_code > 599:
                raise ValueError("status outside HTTP range")
            body_value = payload.get("bodyBase64") or ""
            if not isinstance(body_value, str):
                raise TypeError("bodyBase64 must be a string")
            body = base64.b64decode(body_value, validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise YahooAPIError(
                "Broker helper returned invalid HTTP response fields",
                error_kind="broker_protocol",
                reason_code="YAHOO_BROKER_INVALID_RESPONSE",
                endpoint_family="broker",
                next_step="Report the broker protocol response to the skill maintainer.",
            ) from exc
        return HTTPResponse(
            status_code=status_code,
            text=body.decode("utf-8", errors="replace"),
            headers=response_headers,
        )

    def _request_direct(
        self,
        method: str,
        url: str,
        accept: str = "application/json",
        json_body: dict[str, Any] | None = None,
    ) -> HTTPResponse:
        try:
            import httpx
        except ImportError as exc:
            raise YahooAPIError(
                "Missing httpx library. Please install httpx>=0.27.",
                error_kind="dependency",
                reason_code="YAHOO_DEPENDENCY_MISSING",
                next_step="Install the declared httpx dependency and retry.",
            ) from exc
        if self._client is None:
            self._client = httpx.Client(
                headers={"User-Agent": USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=True,
            )
        last_error: Exception | None = None
        for _ in range(2):
            try:
                remaining_timeout = self._remaining_timeout()
                response = self._client.request(
                    method,
                    url,
                    headers={"Accept": accept},
                    json=json_body,
                    timeout=remaining_timeout,
                )
                break
            except httpx.RequestError as exc:
                last_error = exc
                time.sleep(0.5)
        else:
            raise YahooAPIError(
                f"Yahoo Finance network request failed: {type(last_error).__name__}",
                error_kind="network",
                reason_code="YAHOO_NETWORK_ERROR",
                retryable=True,
                next_step="Retry after checking network connectivity.",
            ) from last_error
        return HTTPResponse(
            status_code=response.status_code,
            text=response.text,
            headers={k.lower(): v for k, v in response.headers.items()},
        )

    def request(
        self,
        url: str,
        accept: str = "application/json",
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
        endpoint_family: str = "unknown",
    ) -> HTTPResponse:
        transport = "broker" if broker_helper_required() else "direct"
        try:
            response = (
                self._request_broker(method, url, accept, json_body)
                if transport == "broker"
                else self._request_direct(method, url, accept, json_body)
            )
        except YahooAPIError as error:
            error.endpoint_family = endpoint_family
            self.request_log.append({
                "endpointFamily": endpoint_family,
                "host": urlparse(url).hostname or "",
                "method": method,
                "status": error.http_status,
                "transport": transport,
                "reasonCode": error.reason_code,
            })
            raise
        self.request_log.append({
            "endpointFamily": endpoint_family,
            "host": urlparse(url).hostname or "",
            "method": method,
            "status": response.status_code,
            "transport": transport,
        })
        if response.status_code >= 400:
            retry_after = _parse_retry_after(response.headers.get("retry-after"))
            if response.status_code == 429:
                error_kind = "rate_limited"
                reason_code = "YAHOO_HTTP_429"
                retryable = True
                next_step = "Retry after the indicated delay and avoid parallel requests."
            elif response.status_code in {408, 425, 500, 502, 503, 504}:
                error_kind = "provider_unavailable"
                reason_code = f"YAHOO_HTTP_{response.status_code}"
                retryable = True
                next_step = "Retry after the Yahoo Finance service recovers."
            elif response.status_code == 404:
                error_kind = "not_found"
                reason_code = "YAHOO_HTTP_404"
                retryable = False
                next_step = "Verify the ticker symbol or requested resource."
            elif response.status_code in {401, 403}:
                error_kind = "provider_rejected"
                reason_code = f"YAHOO_HTTP_{response.status_code}"
                retryable = False
                next_step = "Report the rejection; Yahoo may have changed its anti-bot or session requirements."
            else:
                error_kind = "provider_error"
                reason_code = f"YAHOO_HTTP_{response.status_code}"
                retryable = False
                next_step = "Check the request parameters before retrying."
            raise YahooAPIError(
                f"Yahoo Finance returned HTTP {response.status_code}",
                error_kind=error_kind,
                reason_code=reason_code,
                retryable=retryable,
                retry_after=retry_after,
                http_status=response.status_code,
                endpoint_family=endpoint_family,
                next_step=next_step,
            )
        return response

    def ensure_crumb(self) -> str:
        if self.crumb:
            return self.crumb
        try:
            self.request(
                "https://fc.yahoo.com",
                accept="text/html",
                endpoint_family="session-cookie",
            )
        except YahooAPIError:
            pass
        response = self.request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            accept="text/plain",
            endpoint_family="session-crumb",
        )
        crumb = response.text.strip()
        if not crumb or "<html" in crumb.lower():
            raise YahooAPIError(
                "Unable to obtain Yahoo Finance crumb",
                error_kind="provider_rejected",
                reason_code="YAHOO_CRUMB_UNAVAILABLE",
                next_step="Report the session rejection; Yahoo may have changed its crumb flow.",
            )
        self.crumb = crumb
        return crumb

    def json_request(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
        crumb: bool = False,
        endpoint_family: str = "unknown",
    ) -> dict[str, Any]:
        if crumb:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{urlencode({'crumb': self.ensure_crumb()})}"
        response = self.request(
            url,
            method=method,
            json_body=json_body,
            endpoint_family=endpoint_family,
        )
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise YahooAPIError(
                f"Yahoo returned invalid JSON: {exc}",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_INVALID_JSON",
                endpoint_family=endpoint_family,
                next_step="Report the endpoint response change to the skill maintainer.",
            ) from exc
        finance_error = data.get("finance", {}).get("error") if isinstance(data, dict) else None
        if finance_error:
            raise YahooAPIError(
                str(finance_error.get("description") or finance_error),
                error_kind="provider_error",
                reason_code="YAHOO_FINANCE_ERROR",
                endpoint_family=endpoint_family,
                next_step="Verify the request or report a Yahoo Finance endpoint change.",
            )
        if not isinstance(data, dict):
            raise YahooAPIError(
                "Yahoo returned an unexpected non-object JSON response",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_SCHEMA_CHANGED",
                endpoint_family=endpoint_family,
                next_step="Report the endpoint response change to the skill maintainer.",
            )
        return data

    def json_get(
        self,
        url: str,
        *,
        crumb: bool = False,
        endpoint_family: str = "unknown",
    ) -> dict[str, Any]:
        return self.json_request(
            url,
            crumb=crumb,
            endpoint_family=endpoint_family,
        )


SESSION = YahooSession()


def build_url(base: str, params: dict[str, str | int | float]) -> str:
    return f"{base}?{urlencode(params)}"


def _date_range_to_epoch(start: str, end: str) -> tuple[int, int]:
    if not start or not end:
        raise YahooAPIError(
            "start and end must be provided together",
            error_kind="invalid_request",
            reason_code="YAHOO_DATE_RANGE_INCOMPLETE",
            next_step="Provide both start and end as YYYY-MM-DD, or omit both and use period.",
        )
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_dt = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise YahooAPIError(
            "start and end must use YYYY-MM-DD",
            error_kind="invalid_request",
            reason_code="YAHOO_DATE_INVALID",
            next_step="Correct the date format and retry.",
        ) from exc
    if start_dt >= end_dt:
        raise YahooAPIError(
            "start must be earlier than end",
            error_kind="invalid_request",
            reason_code="YAHOO_DATE_RANGE_INVALID",
            next_step="Choose an end date after the start date.",
        )
    return int(start_dt.timestamp()), int(end_dt.timestamp())


def _filter_chart_indices(chart: dict[str, Any], indices: list[int]) -> None:
    timestamps = chart.get("timestamp") or []
    original_length = len(timestamps)
    chart["timestamp"] = [timestamps[index] for index in indices]
    indicators = chart.get("indicators") or {}
    if not isinstance(indicators, dict):
        return
    for groups in indicators.values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            for key, values in list(group.items()):
                if isinstance(values, list) and len(values) == original_length:
                    group[key] = [values[index] for index in indices]


def _resample_chart_to_30m(chart: dict[str, Any]) -> None:
    """Match yfinance's 30m workaround by aggregating Yahoo 15m bars."""
    timestamps = chart.get("timestamp") or []
    if not isinstance(timestamps, list) or not timestamps:
        return
    groups: list[list[int]] = []
    group_keys: list[object] = []
    for index, timestamp in enumerate(timestamps):
        try:
            key: object = int(timestamp) // 1800
        except (TypeError, ValueError):
            key = f"invalid-{index}"
        if not group_keys or group_keys[-1] != key:
            group_keys.append(key)
            groups.append([])
        groups[-1].append(index)

    indicators = chart.get("indicators") or {}
    quote_groups = indicators.get("quote") or [] if isinstance(indicators, dict) else []
    if not quote_groups or not isinstance(quote_groups[0], dict):
        return
    quote = quote_groups[0]

    def values_for(key: str, indices: list[int]) -> list[Any]:
        source = quote.get(key)
        return [
            source[index]
            for index in indices
            if isinstance(source, list) and index < len(source) and source[index] is not None
        ]

    aggregated: dict[str, list[Any]] = {
        "open": [],
        "high": [],
        "low": [],
        "close": [],
        "volume": [],
    }
    for indices in groups:
        opens = values_for("open", indices)
        highs = values_for("high", indices)
        lows = values_for("low", indices)
        closes = values_for("close", indices)
        volumes = values_for("volume", indices)
        aggregated["open"].append(opens[0] if opens else None)
        aggregated["high"].append(max(highs) if highs else None)
        aggregated["low"].append(min(lows) if lows else None)
        aggregated["close"].append(closes[-1] if closes else None)
        aggregated["volume"].append(sum(volumes) if volumes else None)
    quote.update(aggregated)
    chart["timestamp"] = [timestamps[indices[0]] for indices in groups]

    adj_groups = indicators.get("adjclose") or [] if isinstance(indicators, dict) else []
    if adj_groups and isinstance(adj_groups[0], dict):
        source = adj_groups[0].get("adjclose")
        if isinstance(source, list):
            adj_groups[0]["adjclose"] = [
                next(
                    (
                        source[index]
                        for index in reversed(indices)
                        if index < len(source) and source[index] is not None
                    ),
                    None,
                )
                for indices in groups
            ]
    meta = chart.get("meta")
    if isinstance(meta, dict):
        meta["dataGranularity"] = "30m"


def get_quotes(symbols: list[str]) -> list[dict[str, Any]]:
    url = build_url("https://query1.finance.yahoo.com/v7/finance/quote", {
        "symbols": ",".join(symbols),
    })
    data = SESSION.json_get(url, crumb=True, endpoint_family="quote")
    response = data.get("quoteResponse")
    if not isinstance(response, dict):
        raise YahooAPIError(
            "Yahoo quote response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_QUOTE_SCHEMA_CHANGED",
            endpoint_family="quote",
            next_step="Report the quote endpoint response change to the skill maintainer.",
        )
    if response.get("error"):
        raise YahooAPIError(
            str(response.get("error")),
            error_kind="provider_error",
            reason_code="YAHOO_QUOTE_ERROR",
            endpoint_family="quote",
        )
    result = response.get("result")
    if not isinstance(result, list):
        raise YahooAPIError(
            "Yahoo quote result is missing",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_QUOTE_SCHEMA_CHANGED",
            endpoint_family="quote",
            next_step="Report the quote endpoint response change to the skill maintainer.",
        )
    return result


def get_quote(symbol: str) -> dict[str, Any]:
    quotes = get_quotes([symbol])
    if not quotes:
        raise YahooAPIError(
            f"No quote data found for {symbol}",
            error_kind="not_found",
            reason_code="YAHOO_SYMBOL_NOT_FOUND",
            endpoint_family="quote",
            next_step="Verify the Yahoo Finance ticker symbol and retry.",
        )
    return quotes[0]


def get_quote_summary(symbol: str, modules: str = QUOTE_SUMMARY_MODULES) -> dict[str, Any]:
    encoded_symbol = url_quote(symbol, safe="")
    url = build_url(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{encoded_symbol}", {
        "modules": modules,
        "formatted": "false",
        "symbol": symbol,
    })
    data = SESSION.json_get(url, crumb=True, endpoint_family="quote-summary")
    response = data.get("quoteSummary")
    if not isinstance(response, dict):
        raise YahooAPIError(
            "Yahoo quote summary response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_QUOTE_SUMMARY_SCHEMA_CHANGED",
            endpoint_family="quote-summary",
            next_step="Report the quoteSummary endpoint response change to the skill maintainer.",
        )
    if response.get("error"):
        raise YahooAPIError(
            str(response.get("error")),
            error_kind="provider_error",
            reason_code="YAHOO_QUOTE_SUMMARY_ERROR",
            endpoint_family="quote-summary",
        )
    result = response.get("result")
    if not isinstance(result, list):
        raise YahooAPIError(
            "Yahoo quote summary result is missing",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_QUOTE_SUMMARY_SCHEMA_CHANGED",
            endpoint_family="quote-summary",
            next_step="Report the quoteSummary endpoint response change to the skill maintainer.",
        )
    if not result:
        raise YahooAPIError(
            "Yahoo returned no quote summary result for the requested modules",
            error_kind="not_found",
            reason_code="YAHOO_QUOTE_SUMMARY_NO_DATA",
            endpoint_family="quote-summary",
            next_step="Use the available quote data and disclose that summary modules were unavailable.",
        )
    if not isinstance(result[0], dict):
        raise YahooAPIError(
            "Yahoo quote summary result shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_QUOTE_SUMMARY_SCHEMA_CHANGED",
            endpoint_family="quote-summary",
            next_step="Report the quoteSummary endpoint response change to the skill maintainer.",
        )
    return result[0]


def get_chart(
    symbol: str,
    period: str = DEFAULT_HISTORY_PERIOD,
    interval: str = DEFAULT_HISTORY_INTERVAL,
    events: str = "",
    *,
    start: str = "",
    end: str = "",
    include_pre_post: bool = False,
) -> dict[str, Any]:
    api_interval = "15m" if interval == "30m" else interval
    params: dict[str, str] = {
        "interval": api_interval,
        "includePrePost": str(include_pre_post).lower(),
    }
    period2: int | None = None
    if start or end:
        start_epoch, period2 = _date_range_to_epoch(start, end)
        params["period1"] = str(start_epoch)
        params["period2"] = str(period2)
    else:
        params["range"] = period
    if events:
        params["events"] = events
    encoded_symbol = url_quote(symbol, safe="")
    url = build_url(f"https://query2.finance.yahoo.com/v8/finance/chart/{encoded_symbol}", params)
    data = SESSION.json_get(url, endpoint_family="chart")
    chart = data.get("chart")
    if not isinstance(chart, dict):
        raise YahooAPIError(
            "Yahoo chart response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_CHART_SCHEMA_CHANGED",
            endpoint_family="chart",
            next_step="Report the chart endpoint response change to the skill maintainer.",
        )
    if chart.get("error"):
        error = chart.get("error") or {}
        description = error.get("description") if isinstance(error, dict) else error
        raise YahooAPIError(
            str(description or "Yahoo chart request failed"),
            error_kind="not_found" if "not found" in str(description).lower() else "provider_error",
            reason_code="YAHOO_CHART_ERROR",
            endpoint_family="chart",
            next_step="Verify the symbol and date range, then retry.",
        )
    result = chart.get("result") or []
    if not result:
        raise YahooAPIError(
            f"No chart data found for {symbol}",
            error_kind="not_found",
            reason_code="YAHOO_CHART_NO_DATA",
            endpoint_family="chart",
            next_step="Verify the symbol, period, interval, and exchange trading dates.",
        )
    entry = result[0]
    if not isinstance(entry, dict):
        raise YahooAPIError(
            "Yahoo options result shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_OPTIONS_SCHEMA_CHANGED",
            endpoint_family="options",
            next_step="Report the options endpoint response change to the skill maintainer.",
        )
    if period2 is not None and isinstance(entry, dict):
        timestamps = entry.get("timestamp") or []
        keep: list[int] = []
        for index, timestamp in enumerate(timestamps):
            try:
                if int(timestamp) < period2:
                    keep.append(index)
            except (TypeError, ValueError):
                keep.append(index)
        if len(keep) != len(timestamps):
            _filter_chart_indices(entry, keep)
    if interval == "30m" and isinstance(entry, dict):
        _resample_chart_to_30m(entry)
    return entry


def cmd_price(symbol: str) -> None:
    quote = get_quote(symbol)
    name = quote.get("longName") or quote.get("shortName") or symbol
    price = quote.get("regularMarketPrice")
    prev_close = quote.get("regularMarketPreviousClose")
    change = quote.get("regularMarketChange")
    change_pct = quote.get("regularMarketChangePercent")
    currency = quote.get("currency", "")

    _print(f"\n{name} ({symbol})")
    _print(f"  Price: {_safe(price, ',.2f')} {currency}")
    if change is not None:
        sign = "+" if change >= 0 else ""
        _print(f"  Change: {sign}{change:.2f} ({sign}{_safe(change_pct, '.2f')}%)")
    _print(f"  Previous close: {_safe(prev_close, ',.2f')}")
    _print(f"  Open: {_safe(quote.get('regularMarketOpen'), ',.2f')}")
    _print(f"  High: {_safe(quote.get('regularMarketDayHigh'), ',.2f')}")
    _print(f"  Low: {_safe(quote.get('regularMarketDayLow'), ',.2f')}")
    _print(f"  Volume: {_safe(quote.get('regularMarketVolume'), ',')}")
    _print(f"  Market cap: {_money(quote.get('marketCap'), currency)}")
    _print()


def cmd_quote(symbol: str) -> None:
    q = get_quote(symbol)
    currency = q.get("currency", "")
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Detailed Quote\n")
    table = SimpleTable(["Metric", "Value"], show_header=False)
    rows = [
        ("Current Price", _safe(q.get("regularMarketPrice"), ",.2f")),
        ("Previous Close", _safe(q.get("regularMarketPreviousClose"), ",.2f")),
        ("Open", _safe(q.get("regularMarketOpen"), ",.2f")),
        ("Day High", _safe(q.get("regularMarketDayHigh"), ",.2f")),
        ("Day Low", _safe(q.get("regularMarketDayLow"), ",.2f")),
        ("52W High", _safe(q.get("fiftyTwoWeekHigh"), ",.2f")),
        ("52W Low", _safe(q.get("fiftyTwoWeekLow"), ",.2f")),
        ("Volume", _safe(q.get("regularMarketVolume"), ",")),
        ("Average Volume", _safe(q.get("averageDailyVolume3Month"), ",")),
        ("Market Cap", _money(q.get("marketCap"), currency)),
        ("P/E (TTM)", _safe(q.get("trailingPE"), ".2f")),
        ("EPS (TTM)", _safe(q.get("epsTrailingTwelveMonths"), ".2f")),
        ("Exchange", _safe(q.get("fullExchangeName") or q.get("exchange"))),
    ]
    for label, value in rows:
        table.add_row(label, value)
    _print_table(table)
    _print()


def cmd_fundamentals(symbol: str) -> None:
    q = get_quote(symbol)
    summary = get_quote_summary(symbol)
    financial = summary.get("financialData", {})
    stats = summary.get("defaultKeyStatistics", {})
    detail = summary.get("summaryDetail", {})
    currency = q.get("currency", "")
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Fundamentals\n")

    table = SimpleTable(["Metric", "Value"], show_header=False)
    rows = [
        ("Market Cap", _money(q.get("marketCap"), currency)),
        ("P/E (TTM)", _safe(q.get("trailingPE"), ".2f")),
        ("Forward P/E", _safe(_value(stats.get("forwardPE")), ".2f")),
        ("Price/Book", _safe(_value(stats.get("priceToBook")), ".2f")),
        ("Enterprise Value", _money(_value(stats.get("enterpriseValue")), currency)),
        ("EV/EBITDA", _safe(_value(stats.get("enterpriseToEbitda")), ".2f")),
        ("Profit Margin", _pct(_value(financial.get("profitMargins")))),
        ("Gross Margin", _pct(_value(financial.get("grossMargins")))),
        ("Operating Margin", _pct(_value(financial.get("operatingMargins")))),
        ("ROE", _pct(_value(financial.get("returnOnEquity")))),
        ("ROA", _pct(_value(financial.get("returnOnAssets")))),
        ("Total Revenue", _money(_value(financial.get("totalRevenue")), currency)),
        ("EBITDA", _money(_value(financial.get("ebitda")), currency)),
        ("Free Cash Flow", _money(_value(financial.get("freeCashflow")), currency)),
        ("Dividend Yield", _pct(_value(detail.get("dividendYield")))),
        ("Recommendation", _safe(_value(financial.get("recommendationKey")))),
        ("Target Mean", _safe(_value(financial.get("targetMeanPrice")), ",.2f")),
    ]
    for label, value in rows:
        table.add_row(label, value)
    _print_table(table)
    _print()


def cmd_earnings(symbol: str) -> None:
    q = get_quote(symbol)
    summary = get_quote_summary(symbol)
    earnings = summary.get("earnings", {})
    calendar = summary.get("calendarEvents", {})
    calendar_earnings = calendar.get("earnings", {}) if isinstance(calendar, dict) else {}
    financial = summary.get("financialData", {})
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Earnings Data\n")

    table = SimpleTable(["Metric", "Value"], show_header=False)
    table.add_row("EPS (TTM)", _safe(q.get("epsTrailingTwelveMonths"), ".2f"))
    table.add_row("Forward EPS", _safe(_value(financial.get("forwardEps")), ".2f"))
    earnings_dates = calendar_earnings.get("earningsDate") or []
    first_earnings_date = earnings_dates[0] if isinstance(earnings_dates, list) and earnings_dates else earnings_dates
    table.add_row("Earnings Date", _date_from_epoch(_value(first_earnings_date)))
    table.add_row("Revenue Avg", _money(_value(calendar_earnings.get("revenueAverage")), q.get("currency", "")))
    _print_table(table)

    history = earnings.get("financialsChart", {}).get("yearly", [])
    if history:
        _print("\nYearly Financials")
        t = SimpleTable(["Year", "Revenue", "Earnings"])
        for row in history[-5:]:
            t.add_row(row.get("date", "N/A"), _money(row.get("revenue", {}).get("raw"), q.get("currency", "")), _money(row.get("earnings", {}).get("raw"), q.get("currency", "")))
        _print_table(t)
    _print()


def cmd_profile(symbol: str) -> None:
    q = get_quote(symbol)
    summary = get_quote_summary(symbol)
    profile = summary.get("assetProfile") or summary.get("summaryProfile") or {}
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Company Profile\n")
    for label, key in [
        ("Sector", "sector"),
        ("Industry", "industry"),
        ("Employees", "fullTimeEmployees"),
        ("Website", "website"),
        ("Country", "country"),
        ("City", "city"),
    ]:
        value = profile.get(key)
        if value:
            _print(f"  {label}: {_safe(value, ',') if isinstance(value, int) else value}")
    desc = profile.get("longBusinessSummary")
    if desc:
        _print("\nBusiness Description")
        _print(f"  {desc[:900]}{'...' if len(desc) > 900 else ''}")
    _print()


def cmd_dividends(symbol: str) -> None:
    q = get_quote(symbol)
    summary = get_quote_summary(symbol)
    detail = summary.get("summaryDetail", {})
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Dividend Information\n")
    table = SimpleTable(["Metric", "Value"], show_header=False)
    table.add_row("Dividend Rate", _safe(_value(detail.get("dividendRate")), ".2f"))
    table.add_row("Dividend Yield", _pct(_value(detail.get("dividendYield"))))
    table.add_row("Payout Ratio", _pct(_value(summary.get("defaultKeyStatistics", {}).get("payoutRatio"))))
    table.add_row("Ex-Dividend Date", _date_from_epoch(_value(detail.get("exDividendDate"))))
    _print_table(table)

    try:
        chart = get_chart(symbol, period="5y", events="div")
        dividends = chart.get("events", {}).get("dividends", {})
        if dividends:
            _print("\nRecent Dividends")
            t = SimpleTable(["Date", "Amount"])
            rows = sorted(dividends.values(), key=lambda item: item.get("date", 0))[-8:]
            for item in rows:
                t.add_row(_date_from_epoch(item.get("date")), _safe(item.get("amount"), ".4f"))
            _print_table(t)
    except YahooAPIError as error:
        _print(f"\nDividend history unavailable ({error.reason_code}): {error}")
    _print()


def cmd_ratings(symbol: str) -> None:
    q = get_quote(symbol)
    summary = get_quote_summary(symbol)
    financial = summary.get("financialData", {})
    trend = summary.get("recommendationTrend", {}).get("trend", [])
    history = summary.get("upgradeDowngradeHistory", {}).get("history", [])
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Analyst Ratings\n")
    table = SimpleTable(["Metric", "Value"], show_header=False)
    table.add_row("Overall Rating", _safe(_value(financial.get("recommendationKey"))))
    table.add_row("Rating Mean", _safe(_value(financial.get("recommendationMean")), ".1f"))
    table.add_row("Analyst Count", _safe(_value(financial.get("numberOfAnalystOpinions"))))
    table.add_row("Mean Target", _safe(_value(financial.get("targetMeanPrice")), ",.2f"))
    table.add_row("High Target", _safe(_value(financial.get("targetHighPrice")), ",.2f"))
    table.add_row("Low Target", _safe(_value(financial.get("targetLowPrice")), ",.2f"))
    _print_table(table)

    if trend:
        _print("\nRecommendation Trend")
        t = SimpleTable(["Period", "Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"])
        for row in trend[:4]:
            t.add_row(row.get("period", "N/A"), row.get("strongBuy", "N/A"), row.get("buy", "N/A"), row.get("hold", "N/A"), row.get("sell", "N/A"), row.get("strongSell", "N/A"))
        _print_table(t)
    if history:
        _print("\nRecent Rating Changes")
        t2 = SimpleTable(["Date", "Firm", "To", "Action"])
        for row in history[:10]:
            t2.add_row(_date_from_epoch(row.get("epochGradeDate")), str(row.get("firm", "N/A"))[:24], row.get("toGrade", "N/A"), row.get("action", ""))
        _print_table(t2)
    _print()


def cmd_options(symbol: str) -> None:
    q = get_quote(symbol)
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Options Chain\n")
    url = f"https://query1.finance.yahoo.com/v7/finance/options/{url_quote(symbol, safe='')}"
    data = SESSION.json_get(url, crumb=True, endpoint_family="options")
    result = data.get("optionChain", {}).get("result") or []
    if not result:
        _print("  No options data")
        return
    entry = result[0]
    options = entry.get("options") or []
    dates = entry.get("expirationDates") or []
    if dates:
        _print(f"  Expiration date: {_date_from_epoch(dates[0])} ({len(dates)} expiration dates total)\n")
    if not options:
        _print("  No options data")
        return
    chain = options[0]
    for label, rows in [("Calls", chain.get("calls", [])), ("Puts", chain.get("puts", []))]:
        if not rows:
            continue
        _print(label)
        table = SimpleTable(["Strike", "Last", "Bid", "Ask", "Volume", "Open Interest", "IV"])
        for row in rows[:10]:
            table.add_row(
                _safe(row.get("strike"), ",.2f"),
                _safe(row.get("lastPrice"), ",.2f"),
                _safe(row.get("bid"), ",.2f"),
                _safe(row.get("ask"), ",.2f"),
                _safe(row.get("volume"), ","),
                _safe(row.get("openInterest"), ","),
                _pct(row.get("impliedVolatility")),
            )
        _print_table(table)
        _print()


def cmd_history(symbol: str, period: str = DEFAULT_HISTORY_PERIOD) -> None:
    chart = get_chart(symbol, period=period)
    meta = chart.get("meta", {})
    name = meta.get("longName") or meta.get("shortName") or symbol
    currency = meta.get("currency", "")
    timestamps = chart.get("timestamp") or []
    quote = (chart.get("indicators", {}).get("quote") or [{}])[0]
    if not timestamps:
        _print(f"  No {period} historical data")
        return
    _print(f"\n{name} ({symbol}) - Historical Prices ({period})\n")
    table = SimpleTable(["Date", "Open", "High", "Low", "Close", "Volume"])
    for idx, ts in list(enumerate(timestamps))[-25:]:
        table.add_row(
            _date_from_epoch(ts),
            _safe((quote.get("open") or [None])[idx], ",.2f"),
            _safe((quote.get("high") or [None])[idx], ",.2f"),
            _safe((quote.get("low") or [None])[idx], ",.2f"),
            _safe((quote.get("close") or [None])[idx], ",.2f"),
            _safe((quote.get("volume") or [None])[idx], ","),
        )
    _print_table(table)
    if currency:
        _print(f"\nCurrency: {currency}")
    _print()


def cmd_compare(symbols_str: str) -> None:
    symbols = [s.strip().upper() for s in symbols_str.split(",") if s.strip()]
    if len(symbols) < 2:
        _print("Please provide at least 2 stock symbols (comma-separated)")
        return
    quotes = {q.get("symbol"): q for q in get_quotes(symbols)}
    _print(f"\nStock Comparison: {', '.join(symbols)}\n")
    table = SimpleTable(["Metric"] + symbols)
    metrics = [
        ("Name", lambda i: (i.get("longName") or i.get("shortName") or "N/A")[:18]),
        ("Price", lambda i: _safe(i.get("regularMarketPrice"), ",.2f")),
        ("Change %", lambda i: _safe(i.get("regularMarketChangePercent"), ".2f", "%")),
        ("Market Cap", lambda i: _money(i.get("marketCap"))),
        ("P/E (TTM)", lambda i: _safe(i.get("trailingPE"), ".2f")),
        ("EPS (TTM)", lambda i: _safe(i.get("epsTrailingTwelveMonths"), ".2f")),
        ("52W High", lambda i: _safe(i.get("fiftyTwoWeekHigh"), ",.2f")),
        ("52W Low", lambda i: _safe(i.get("fiftyTwoWeekLow"), ",.2f")),
    ]
    for label, getter in metrics:
        table.add_row(label, *[getter(quotes.get(symbol, {})) for symbol in symbols])
    _print_table(table)
    _print()


def cmd_search(query: str) -> None:
    url = build_url("https://query2.finance.yahoo.com/v1/finance/search", {
        "q": query,
        "quotesCount": 10,
        "newsCount": 0,
    })
    data = SESSION.json_get(url)
    quotes = data.get("quotes", [])
    if not quotes:
        _print(f"  No results found for \"{query}\"")
        return
    _print(f"\nSearch Results: \"{query}\"\n")
    table = SimpleTable(["Symbol", "Name", "Type", "Exchange"])
    for q in quotes[:10]:
        table.add_row(
            q.get("symbol", "N/A"),
            (q.get("longname") or q.get("shortname") or "N/A")[:30],
            q.get("quoteType", "N/A"),
            q.get("exchange", "N/A"),
        )
    _print_table(table)
    _print()


def _item(values: Any, index: int) -> Any:
    if not isinstance(values, list) or index >= len(values):
        return None
    return values[index]


def _quote_name(quote: dict[str, Any], symbol: str) -> str:
    return str(quote.get("longName") or quote.get("shortName") or symbol)


def _warning_from_error(error: YahooAPIError, component: str) -> dict[str, Any]:
    warning: dict[str, Any] = {
        "reasonCode": error.reason_code,
        "component": component,
        "message": str(error),
        "retryable": error.retryable,
    }
    if error.retry_after is not None:
        warning["retryAfterSeconds"] = error.retry_after
    return warning


def _normalize_quote(quote: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": quote.get("symbol"),
        "name": quote.get("longName") or quote.get("shortName"),
        "quoteType": quote.get("quoteType"),
        "exchange": quote.get("fullExchangeName") or quote.get("exchange"),
        "exchangeTimezoneName": quote.get("exchangeTimezoneName"),
        "currency": quote.get("currency"),
        "marketState": quote.get("marketState"),
        "regularMarketTime": _iso_from_epoch(quote.get("regularMarketTime")),
        "price": quote.get("regularMarketPrice"),
        "previousClose": quote.get("regularMarketPreviousClose"),
        "open": quote.get("regularMarketOpen"),
        "dayHigh": quote.get("regularMarketDayHigh"),
        "dayLow": quote.get("regularMarketDayLow"),
        "change": quote.get("regularMarketChange"),
        "changePercent": quote.get("regularMarketChangePercent"),
        "volume": quote.get("regularMarketVolume"),
        "averageVolume3Month": quote.get("averageDailyVolume3Month"),
        "marketCap": quote.get("marketCap"),
        "trailingPE": quote.get("trailingPE"),
        "trailingEps": quote.get("epsTrailingTwelveMonths"),
        "fiftyTwoWeekHigh": quote.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": quote.get("fiftyTwoWeekLow"),
    }


def _normalize_chart_events(chart: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    source = chart.get("events") or {}
    if not isinstance(source, dict):
        source = {}

    dividends: list[dict[str, Any]] = []
    for row in (source.get("dividends") or {}).values():
        if not isinstance(row, dict):
            continue
        dividends.append({
            "timestamp": _iso_from_epoch(row.get("date")),
            "amount": row.get("amount"),
            "currency": row.get("currency"),
        })

    splits: list[dict[str, Any]] = []
    for row in (source.get("splits") or {}).values():
        if not isinstance(row, dict):
            continue
        numerator = row.get("numerator")
        denominator = row.get("denominator")
        splits.append({
            "timestamp": _iso_from_epoch(row.get("date")),
            "numerator": numerator,
            "denominator": denominator,
            "ratio": row.get("splitRatio") or (
                f"{numerator}:{denominator}"
                if numerator is not None and denominator is not None
                else None
            ),
        })

    capital_gains: list[dict[str, Any]] = []
    capital_gain_source = source.get("capitalGains") or source.get("capital_gains") or {}
    for row in capital_gain_source.values():
        if not isinstance(row, dict):
            continue
        capital_gains.append({
            "timestamp": _iso_from_epoch(row.get("date")),
            "amount": row.get("amount"),
        })

    for rows in (dividends, splits, capital_gains):
        rows.sort(key=lambda item: str(item.get("timestamp") or ""))
    return {
        "dividends": dividends,
        "splits": splits,
        "capitalGains": capital_gains,
    }


def fetch_history_data(
    symbol: str,
    *,
    period: str = DEFAULT_HISTORY_PERIOD,
    interval: str = DEFAULT_HISTORY_INTERVAL,
    start: str = "",
    end: str = "",
    include_pre_post: bool = False,
    include_actions: bool = False,
    limit: int = DEFAULT_RESULT_LIMIT,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    events = "div,splits,capitalGains" if include_actions else ""
    chart = get_chart(
        symbol,
        period=period,
        interval=interval,
        events=events,
        start=start,
        end=end,
        include_pre_post=include_pre_post,
    )
    meta = chart.get("meta") or {}
    timestamps = chart.get("timestamp") or []
    indicators = chart.get("indicators") or {}
    quote_groups = indicators.get("quote") or [] if isinstance(indicators, dict) else []
    if not isinstance(quote_groups, list) or not quote_groups or not isinstance(quote_groups[0], dict):
        if timestamps:
            raise YahooAPIError(
                "Yahoo chart indicators are missing",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_CHART_INDICATORS_MISSING",
                endpoint_family="chart",
                next_step="Report the chart response change to the skill maintainer.",
            )
        quote = {}
    else:
        quote = quote_groups[0]
    adj_groups = indicators.get("adjclose") or [] if isinstance(indicators, dict) else []
    adjclose = adj_groups[0].get("adjclose") if adj_groups and isinstance(adj_groups[0], dict) else []

    rows: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps):
        rows.append({
            "timestamp": _iso_from_epoch(timestamp),
            "open": _item(quote.get("open"), index),
            "high": _item(quote.get("high"), index),
            "low": _item(quote.get("low"), index),
            "close": _item(quote.get("close"), index),
            "adjClose": _item(adjclose, index),
            "volume": _item(quote.get("volume"), index),
        })

    total = len(rows)
    bounded_limit = max(1, min(int(limit), MAX_RESULT_LIMIT))
    rows = rows[-bounded_limit:]
    warnings: list[dict[str, Any]] = []
    measured_interval = meta.get("dataGranularity") or interval
    if measured_interval != interval:
        warnings.append({
            "reasonCode": "YAHOO_INTERVAL_MISMATCH",
            "component": "history",
            "message": (
                f"Yahoo returned dataGranularity={measured_interval} for requested interval={interval}."
            ),
            "requestedInterval": interval,
            "measuredInterval": measured_interval,
            "retryable": False,
        })
    if total > len(rows):
        warnings.append({
            "reasonCode": "YAHOO_RESULT_TRUNCATED",
            "component": "history",
            "message": f"Returned the latest {len(rows)} of {total} price rows.",
            "retryable": False,
        })
    data: dict[str, Any] = {
        "symbol": meta.get("symbol") or symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency"),
        "instrumentType": meta.get("instrumentType"),
        "exchangeTimezoneName": meta.get("exchangeTimezoneName"),
        "requestedInterval": interval,
        "interval": measured_interval,
        "period": None if start else period,
        "start": start or None,
        "endExclusive": end or None,
        "dateBoundaryTimezone": "UTC",
        "includePrePost": include_pre_post,
        "prices": rows,
        "totalAvailable": total,
        "returned": len(rows),
        "truncated": total > len(rows),
        "validRanges": meta.get("validRanges"),
    }
    if include_actions:
        data["actions"] = _normalize_chart_events(chart)
    return data, warnings


def fetch_actions_data(
    symbol: str,
    *,
    period: str = "max",
    start: str = "",
    end: str = "",
    limit: int = MAX_RESULT_LIMIT,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    chart = get_chart(
        symbol,
        period=period,
        interval="1d",
        events="div,splits,capitalGains",
        start=start,
        end=end,
    )
    events = _normalize_chart_events(chart)
    bounded_limit = max(1, min(int(limit), MAX_RESULT_LIMIT))
    warnings: list[dict[str, Any]] = []
    truncated_types: list[str] = []
    for event_type, rows in events.items():
        if len(rows) > bounded_limit:
            events[event_type] = rows[-bounded_limit:]
            truncated_types.append(event_type)
    if truncated_types:
        warnings.append({
            "reasonCode": "YAHOO_RESULT_TRUNCATED",
            "component": "actions",
            "message": "Older rows were omitted for: " + ", ".join(truncated_types),
            "retryable": False,
        })
    meta = chart.get("meta") or {}
    return {
        "symbol": meta.get("symbol") or symbol,
        "currency": meta.get("currency"),
        "exchangeTimezoneName": meta.get("exchangeTimezoneName"),
        "period": None if start else period,
        "start": start or None,
        "endExclusive": end or None,
        **events,
    }, warnings


def _parse_financial_series(
    result: list[Any],
    prefix: str,
    requested_keys: tuple[str, ...],
    periods: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    by_key: dict[str, dict[str, Any]] = {}
    for series in result:
        if not isinstance(series, dict):
            continue
        series_key = ""
        meta_types = (series.get("meta") or {}).get("type") if isinstance(series.get("meta"), dict) else None
        if isinstance(meta_types, list) and meta_types:
            series_key = str(meta_types[0])
        if not series_key:
            series_key = next(
                (key for key in series if key.startswith(prefix) and isinstance(series.get(key), list)),
                "",
            )
        if not series_key.startswith(prefix):
            continue
        metric = series_key[len(prefix):]
        values: list[dict[str, Any]] = []
        for cell in series.get(series_key) or []:
            if not isinstance(cell, dict):
                continue
            reported = cell.get("reportedValue") or {}
            values.append({
                "asOfDate": cell.get("asOfDate"),
                "periodType": cell.get("periodType"),
                "raw": reported.get("raw") if isinstance(reported, dict) else None,
                "formatted": reported.get("fmt") if isinstance(reported, dict) else None,
                "currencyCode": cell.get("currencyCode"),
            })
        values.sort(key=lambda item: str(item.get("asOfDate") or ""), reverse=True)
        if values:
            by_key[metric] = {"key": metric, "values": values[:periods]}
    items = [by_key[key] for key in requested_keys if key in by_key]
    missing = [key for key in requested_keys if key not in by_key]
    return items, missing


def fetch_financial_statement(
    symbol: str,
    statement: str,
    frequency: str,
    periods: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if frequency == "trailing" and statement == "balance-sheet":
        raise YahooAPIError(
            "Trailing frequency is not supported for balance-sheet",
            error_kind="invalid_request",
            reason_code="YAHOO_FINANCIAL_FREQUENCY_UNSUPPORTED",
            next_step="Use yearly or quarterly for balance-sheet data.",
        )
    keys = FINANCIAL_STATEMENT_KEYS[statement]
    prefix = {"yearly": "annual", "quarterly": "quarterly", "trailing": "trailing"}[frequency]
    requested_types = [f"{prefix}{key}" for key in keys]
    now = datetime.now(tz=timezone.utc)
    start = now - timedelta(days=3650 if frequency == "yearly" else 900)
    encoded_symbol = url_quote(symbol, safe="")
    url = build_url(
        f"https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{encoded_symbol}",
        {
            "symbol": symbol,
            "type": ",".join(requested_types),
            "period1": int(start.timestamp()),
            "period2": int((now + timedelta(days=1)).timestamp()),
        },
    )
    payload = SESSION.json_get(url, crumb=True, endpoint_family="fundamentals-timeseries")
    timeseries = payload.get("timeseries")
    if not isinstance(timeseries, dict):
        raise YahooAPIError(
            "Yahoo financial timeseries response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_FINANCIALS_SCHEMA_CHANGED",
            endpoint_family="fundamentals-timeseries",
            next_step="Report the fundamentals-timeseries response change to the skill maintainer.",
        )
    if timeseries.get("error"):
        raise YahooAPIError(
            str(timeseries.get("error")),
            error_kind="provider_error",
            reason_code="YAHOO_FINANCIALS_ERROR",
            endpoint_family="fundamentals-timeseries",
        )
    result = timeseries.get("result")
    if not isinstance(result, list):
        raise YahooAPIError(
            "Yahoo financial timeseries result is missing",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_FINANCIALS_SCHEMA_CHANGED",
            endpoint_family="fundamentals-timeseries",
            next_step="Report the fundamentals-timeseries response change to the skill maintainer.",
        )
    items, missing = _parse_financial_series(result, prefix, keys, periods)
    warnings: list[dict[str, Any]] = []
    if missing:
        warnings.append({
            "reasonCode": "YAHOO_FINANCIAL_FIELDS_UNAVAILABLE",
            "component": statement,
            "message": f"Yahoo omitted {len(missing)} of {len(keys)} requested metrics.",
            "affectedFields": missing,
            "retryable": False,
        })
    return {
        "statement": statement,
        "frequency": frequency,
        "requestedPeriods": periods,
        "items": items,
        "returnedMetrics": len(items),
        "requestedMetrics": len(keys),
    }, warnings


def fetch_financials_data(
    symbol: str,
    *,
    statement: str = "income",
    frequency: str = "yearly",
    periods: int = 4,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    statements = list(FINANCIAL_STATEMENT_KEYS) if statement == "all" else [statement]
    output: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    first_error: YahooAPIError | None = None
    for item in statements:
        if frequency == "trailing" and item == "balance-sheet":
            warnings.append({
                "reasonCode": "YAHOO_FINANCIAL_FREQUENCY_UNSUPPORTED",
                "component": item,
                "message": "Trailing balance-sheet data is not supported and was skipped.",
                "retryable": False,
            })
            continue
        try:
            statement_data, statement_warnings = fetch_financial_statement(
                symbol,
                item,
                frequency,
                periods,
            )
            output.append(statement_data)
            warnings.extend(statement_warnings)
        except YahooAPIError as error:
            if first_error is None:
                first_error = error
            warnings.append(_warning_from_error(error, item))
    if not output and first_error is not None:
        raise first_error
    return {
        "symbol": symbol,
        "statements": output,
    }, warnings


def _normalize_news_item(item: dict[str, Any]) -> dict[str, Any]:
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    provider = content.get("provider") if isinstance(content.get("provider"), dict) else {}
    canonical = content.get("canonicalUrl") if isinstance(content.get("canonicalUrl"), dict) else {}
    clickthrough = content.get("clickThroughUrl") if isinstance(content.get("clickThroughUrl"), dict) else {}
    return {
        "id": item.get("id") or item.get("uuid"),
        "title": content.get("title") or item.get("title"),
        "summary": content.get("summary") or content.get("description"),
        "publisher": provider.get("displayName") or item.get("publisher"),
        "publishedAt": content.get("pubDate") or _iso_from_epoch(item.get("providerPublishTime")),
        "url": canonical.get("url") or clickthrough.get("url") or item.get("link"),
        "contentType": content.get("contentType") or item.get("type"),
    }


def fetch_news_data(
    symbol: str,
    *,
    news_type: str = "news",
    limit: int = 10,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    query_ref = {
        "news": "latestNews",
        "all": "newsAll",
        "press-releases": "pressRelease",
    }[news_type]
    bounded_limit = max(1, min(int(limit), 100))
    url = build_url(
        "https://finance.yahoo.com/xhr/ncp",
        {"queryRef": query_ref, "serviceKey": "ncp_fin"},
    )
    payload = SESSION.json_request(
        url,
        method="POST",
        json_body={"serviceConfig": {"snippetCount": bounded_limit, "s": [symbol]}},
        crumb=True,
        endpoint_family="ticker-news",
    )
    data_node = payload.get("data")
    ticker_stream = data_node.get("tickerStream") if isinstance(data_node, dict) else None
    stream = ticker_stream.get("stream") if isinstance(ticker_stream, dict) else None
    if not isinstance(stream, list):
        raise YahooAPIError(
            "Yahoo ticker news response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_NEWS_SCHEMA_CHANGED",
            endpoint_family="ticker-news",
            next_step="Report the ticker news endpoint response change to the skill maintainer.",
        )
    articles: list[dict[str, Any]] = []
    for item in stream:
        if not isinstance(item, dict):
            continue
        content = item.get("content") if isinstance(item.get("content"), dict) else {}
        if item.get("ad") or content.get("ad"):
            continue
        articles.append(_normalize_news_item(item))
    return {
        "symbol": symbol,
        "newsType": news_type,
        "articles": articles[:bounded_limit],
        "returned": min(len(articles), bounded_limit),
    }, []


def fetch_options_data(
    symbol: str,
    *,
    expiration: str = "",
    limit: int = 10,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    encoded_symbol = url_quote(symbol, safe="")
    base = f"https://query1.finance.yahoo.com/v7/finance/options/{encoded_symbol}"
    payload = SESSION.json_get(base, crumb=True, endpoint_family="options")
    response = payload.get("optionChain")
    if not isinstance(response, dict):
        raise YahooAPIError(
            "Yahoo options response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_OPTIONS_SCHEMA_CHANGED",
            endpoint_family="options",
            next_step="Report the options endpoint response change to the skill maintainer.",
        )
    if response.get("error"):
        raise YahooAPIError(
            str(response.get("error")),
            error_kind="provider_error",
            reason_code="YAHOO_OPTIONS_ERROR",
            endpoint_family="options",
        )
    result = response.get("result") or []
    if not result:
        return {
            "symbol": symbol,
            "selectedExpiration": expiration or None,
            "availableExpirations": [],
            "calls": [],
            "puts": [],
        }, []
    entry = result[0]
    dates = entry.get("expirationDates") or []
    selected_epoch = dates[0] if dates else None
    if expiration:
        try:
            selected_epoch = int(
                datetime.strptime(expiration, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
            )
        except ValueError as exc:
            raise YahooAPIError(
                "expiration must use YYYY-MM-DD",
                error_kind="invalid_request",
                reason_code="YAHOO_EXPIRATION_INVALID",
                next_step="Choose a date from availableExpirations.",
            ) from exc
        if dates and selected_epoch not in dates:
            raise YahooAPIError(
                f"No options chain is available for expiration {expiration}",
                error_kind="not_found",
                reason_code="YAHOO_OPTIONS_EXPIRATION_NOT_FOUND",
                endpoint_family="options",
                next_step="Choose a listed expiration date.",
            )
        second_url = build_url(base, {"date": selected_epoch})
        second = SESSION.json_get(second_url, crumb=True, endpoint_family="options")
        second_response = second.get("optionChain")
        if not isinstance(second_response, dict):
            raise YahooAPIError(
                "Yahoo options response shape changed for the requested expiration",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_OPTIONS_SCHEMA_CHANGED",
                endpoint_family="options",
                next_step="Report the options endpoint response change to the skill maintainer.",
            )
        if second_response.get("error"):
            raise YahooAPIError(
                str(second_response.get("error")),
                error_kind="provider_error",
                reason_code="YAHOO_OPTIONS_ERROR",
                endpoint_family="options",
            )
        second_result = second_response.get("result")
        if not isinstance(second_result, list):
            raise YahooAPIError(
                "Yahoo options result is missing for the requested expiration",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_OPTIONS_SCHEMA_CHANGED",
                endpoint_family="options",
                next_step="Report the options endpoint response change to the skill maintainer.",
            )
        if not second_result:
            raise YahooAPIError(
                f"No options chain is available for expiration {expiration}",
                error_kind="not_found",
                reason_code="YAHOO_OPTIONS_EXPIRATION_NOT_FOUND",
                endpoint_family="options",
                next_step="Choose a listed expiration date.",
            )
        entry = second_result[0]
        if not isinstance(entry, dict):
            raise YahooAPIError(
                "Yahoo options result shape changed for the requested expiration",
                error_kind="provider_schema_changed",
                reason_code="YAHOO_OPTIONS_SCHEMA_CHANGED",
                endpoint_family="options",
                next_step="Report the options endpoint response change to the skill maintainer.",
            )
    options = entry.get("options") or []
    chain = options[0] if options and isinstance(options[0], dict) else {}
    bounded_limit = max(1, min(int(limit), 100))

    def normalize_contract(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "contractSymbol": row.get("contractSymbol"),
            "strike": row.get("strike"),
            "lastPrice": row.get("lastPrice"),
            "bid": row.get("bid"),
            "ask": row.get("ask"),
            "change": row.get("change"),
            "percentChange": row.get("percentChange"),
            "volume": row.get("volume"),
            "openInterest": row.get("openInterest"),
            "impliedVolatility": row.get("impliedVolatility"),
            "inTheMoney": row.get("inTheMoney"),
            "lastTradeDate": _iso_from_epoch(row.get("lastTradeDate")),
        }

    calls_source = chain.get("calls") or []
    puts_source = chain.get("puts") or []
    warnings: list[dict[str, Any]] = []
    if len(calls_source) > bounded_limit or len(puts_source) > bounded_limit:
        warnings.append({
            "reasonCode": "YAHOO_RESULT_TRUNCATED",
            "component": "options",
            "message": f"Calls and puts were limited to {bounded_limit} rows each.",
            "retryable": False,
        })
    return {
        "symbol": symbol,
        "underlyingPrice": (entry.get("quote") or {}).get("regularMarketPrice"),
        "selectedExpiration": _date_from_epoch(selected_epoch) if selected_epoch else None,
        "availableExpirations": [_date_from_epoch(value) for value in dates],
        "calls": [normalize_contract(row) for row in calls_source[:bounded_limit] if isinstance(row, dict)],
        "puts": [normalize_contract(row) for row in puts_source[:bounded_limit] if isinstance(row, dict)],
    }, warnings


def fetch_search_data(
    query: str,
    *,
    limit: int = 10,
    include_news: bool = False,
    include_research: bool = False,
    fuzzy: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    bounded_limit = max(1, min(int(limit), 100))
    url = build_url("https://query2.finance.yahoo.com/v1/finance/search", {
        "q": query,
        "quotesCount": bounded_limit,
        "enableFuzzyQuery": str(fuzzy).lower(),
        "newsCount": bounded_limit if include_news else 0,
        "quotesQueryId": "tss_match_phrase_query",
        "newsQueryId": "news_cie_vespa",
        "listsCount": 0,
        "enableCb": "true",
        "enableNavLinks": "true",
        "enableResearchReports": str(include_research).lower(),
        "enableCulturalAssets": "true",
        "recommendedCount": 0,
    })
    payload = SESSION.json_get(url, endpoint_family="search")
    if not any(key in payload for key in ("quotes", "news", "researchReports", "nav")):
        raise YahooAPIError(
            "Yahoo search response shape changed",
            error_kind="provider_schema_changed",
            reason_code="YAHOO_SEARCH_SCHEMA_CHANGED",
            endpoint_family="search",
            next_step="Report the search endpoint response change to the skill maintainer.",
        )
    quotes = []
    for item in payload.get("quotes") or []:
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        quotes.append({
            "symbol": item.get("symbol"),
            "name": item.get("longname") or item.get("shortname"),
            "quoteType": item.get("quoteType"),
            "typeDisplay": item.get("typeDisp"),
            "exchange": item.get("exchange"),
            "exchangeDisplay": item.get("exchDisp"),
            "sector": item.get("sector"),
            "industry": item.get("industry"),
        })
    news = [
        _normalize_news_item(item)
        for item in (payload.get("news") or [])[:bounded_limit]
        if isinstance(item, dict)
    ]
    return {
        "query": query,
        "quotes": quotes[:bounded_limit],
        "news": news,
        "researchReports": (payload.get("researchReports") or [])[:bounded_limit]
        if include_research
        else [],
        "navigation": payload.get("nav") or [],
    }, []


def fetch_basic_action(
    action: str,
    symbol: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    quote = get_quote(symbol)
    if action in {"price", "quote"}:
        return _normalize_quote(quote), []

    module_map = {
        "fundamentals": "summaryDetail,financialData,defaultKeyStatistics",
        "earnings": "earnings,earningsHistory,earningsTrend,calendarEvents,financialData",
        "profile": "assetProfile,summaryProfile",
        "dividends": "summaryDetail,defaultKeyStatistics",
        "ratings": "financialData,recommendationTrend,upgradeDowngradeHistory",
    }
    warnings: list[dict[str, Any]] = []
    try:
        summary = get_quote_summary(symbol, module_map[action])
    except YahooAPIError as error:
        if error.reason_code != "YAHOO_QUOTE_SUMMARY_NO_DATA":
            raise
        summary = {}
        warnings.append(_warning_from_error(error, "quoteSummary"))

    requested_modules = module_map[action].split(",")
    if action == "profile":
        missing_modules = (
            []
            if summary.get("assetProfile") or summary.get("summaryProfile")
            else ["assetProfile|summaryProfile"]
        )
    else:
        missing_modules = [module for module in requested_modules if module not in summary]
    if missing_modules and summary:
        warnings.append({
            "reasonCode": "YAHOO_QUOTE_SUMMARY_MODULES_UNAVAILABLE",
            "component": "quoteSummary",
            "message": "Yahoo omitted one or more requested quoteSummary modules.",
            "affectedModules": missing_modules,
            "retryable": False,
        })

    if action == "fundamentals":
        financial = summary.get("financialData") or {}
        stats = summary.get("defaultKeyStatistics") or {}
        detail = summary.get("summaryDetail") or {}
        return {
            "symbol": symbol,
            "name": _quote_name(quote, symbol),
            "currency": quote.get("currency"),
            "marketCap": quote.get("marketCap"),
            "trailingPE": quote.get("trailingPE"),
            "forwardPE": _value(stats.get("forwardPE")),
            "priceToBook": _value(stats.get("priceToBook")),
            "enterpriseValue": _value(stats.get("enterpriseValue")),
            "enterpriseToEbitda": _value(stats.get("enterpriseToEbitda")),
            "profitMargins": _value(financial.get("profitMargins")),
            "grossMargins": _value(financial.get("grossMargins")),
            "operatingMargins": _value(financial.get("operatingMargins")),
            "returnOnEquity": _value(financial.get("returnOnEquity")),
            "returnOnAssets": _value(financial.get("returnOnAssets")),
            "totalRevenue": _value(financial.get("totalRevenue")),
            "ebitda": _value(financial.get("ebitda")),
            "freeCashflow": _value(financial.get("freeCashflow")),
            "dividendYield": _value(detail.get("dividendYield")),
            "recommendation": _value(financial.get("recommendationKey")),
            "targetMeanPrice": _value(financial.get("targetMeanPrice")),
        }, warnings

    if action == "earnings":
        calendar_events = summary.get("calendarEvents") or {}
        calendar_earnings = calendar_events.get("earnings") or {}
        financial = summary.get("financialData") or {}
        dates = calendar_earnings.get("earningsDate") or []
        if not isinstance(dates, list):
            dates = [dates]
        data = {
            "symbol": symbol,
            "name": _quote_name(quote, symbol),
            "currency": quote.get("currency"),
            "trailingEps": quote.get("epsTrailingTwelveMonths"),
            "forwardEps": _value(financial.get("forwardEps")),
            "calendar": {
                "earningsDates": [_iso_from_epoch(_value(item)) for item in dates if _value(item) is not None],
                "earningsAverage": _value(calendar_earnings.get("earningsAverage")),
                "earningsLow": _value(calendar_earnings.get("earningsLow")),
                "earningsHigh": _value(calendar_earnings.get("earningsHigh")),
                "revenueAverage": _value(calendar_earnings.get("revenueAverage")),
                "revenueLow": _value(calendar_earnings.get("revenueLow")),
                "revenueHigh": _value(calendar_earnings.get("revenueHigh")),
            },
            "yearlyFinancials": (summary.get("earnings") or {}).get("financialsChart", {}).get("yearly", []),
            "history": (summary.get("earningsHistory") or {}).get("history", []),
            "trend": (summary.get("earningsTrend") or {}).get("trend", []),
        }
        calendar = data["calendar"]
        if not calendar["earningsDates"] and calendar["earningsAverage"] is None and calendar["revenueAverage"] is None:
            warnings.append({
                "reasonCode": "YAHOO_EARNINGS_CALENDAR_UNAVAILABLE",
                "component": "calendarEvents",
                "message": "Yahoo did not return upcoming earnings calendar fields.",
                "affectedFields": ["earningsDates", "earningsAverage", "revenueAverage"],
                "retryable": False,
            })
        if data["forwardEps"] is None:
            warnings.append({
                "reasonCode": "YAHOO_EARNINGS_FIELDS_UNAVAILABLE",
                "component": "financialData",
                "message": "Yahoo did not return forwardEps for this instrument.",
                "affectedFields": ["forwardEps"],
                "retryable": False,
            })
        return data, warnings

    if action == "profile":
        profile = summary.get("assetProfile") or summary.get("summaryProfile") or {}
        return {
            "symbol": symbol,
            "name": _quote_name(quote, symbol),
            "sector": profile.get("sector"),
            "industry": profile.get("industry"),
            "employees": profile.get("fullTimeEmployees"),
            "website": profile.get("website"),
            "country": profile.get("country"),
            "city": profile.get("city"),
            "businessSummary": profile.get("longBusinessSummary"),
        }, warnings

    if action == "dividends":
        detail = summary.get("summaryDetail") or {}
        stats = summary.get("defaultKeyStatistics") or {}
        history: list[dict[str, Any]] = []
        try:
            chart = get_chart(symbol, period="5y", events="div")
            history = _normalize_chart_events(chart)["dividends"][-8:]
        except YahooAPIError as error:
            warnings.append(_warning_from_error(error, "dividendHistory"))
        return {
            "symbol": symbol,
            "name": _quote_name(quote, symbol),
            "currency": quote.get("currency"),
            "dividendRate": _value(detail.get("dividendRate")),
            "dividendYield": _value(detail.get("dividendYield")),
            "payoutRatio": _value(stats.get("payoutRatio")),
            "exDividendDate": _iso_from_epoch(_value(detail.get("exDividendDate"))),
            "recentDividends": history,
        }, warnings

    financial = summary.get("financialData") or {}
    return {
        "symbol": symbol,
        "name": _quote_name(quote, symbol),
        "overallRating": _value(financial.get("recommendationKey")),
        "ratingMean": _value(financial.get("recommendationMean")),
        "analystCount": _value(financial.get("numberOfAnalystOpinions")),
        "targetMeanPrice": _value(financial.get("targetMeanPrice")),
        "targetHighPrice": _value(financial.get("targetHighPrice")),
        "targetLowPrice": _value(financial.get("targetLowPrice")),
        "trend": (summary.get("recommendationTrend") or {}).get("trend", []),
        "recentChanges": (summary.get("upgradeDowngradeHistory") or {}).get("history", [])[:10],
    }, warnings


def _source_observation() -> dict[str, Any]:
    data_requests = [
        item
        for item in SESSION.request_log
        if item.get("endpointFamily") not in {"session-cookie", "session-crumb"}
    ]
    endpoint_families = list(dict.fromkeys(
        item.get("endpointFamily")
        for item in data_requests
    ))
    statuses = list(dict.fromkeys(
        item.get("status") for item in data_requests if item.get("status") is not None
    ))
    transports = list(dict.fromkeys(item.get("transport") for item in data_requests))
    return {
        "provider": "Yahoo Finance",
        "retrievedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "endpointFamilies": endpoint_families,
        "httpStatuses": statuses,
        "transport": transports[0] if len(transports) == 1 else transports,
        "requestCount": len(data_requests),
        "sessionRequestCount": len(SESSION.request_log) - len(data_requests),
    }


def _summary_for(action: str, data: dict[str, Any]) -> str:
    if action == "history":
        summary = f"Retrieved {data.get('returned', 0)} historical price rows."
        actions = data.get("actions")
        if isinstance(actions, dict):
            event_count = sum(
                len(actions.get(key) or [])
                for key in ("dividends", "splits", "capitalGains")
            )
            summary += f" Checked corporate actions and found {event_count} events."
        return summary
    if action == "actions":
        total = sum(len(data.get(key) or []) for key in ("dividends", "splits", "capitalGains"))
        return f"Retrieved {total} corporate-action rows."
    if action == "financials":
        return f"Retrieved {len(data.get('statements') or [])} financial statement groups."
    if action == "news":
        return f"Retrieved {data.get('returned', 0)} ticker news articles."
    if action == "options":
        return f"Retrieved {len(data.get('calls') or [])} calls and {len(data.get('puts') or [])} puts."
    if action == "search":
        return f"Retrieved {len(data.get('quotes') or [])} search matches."
    if action == "compare":
        return f"Retrieved {len(data.get('quotes') or [])} comparison quotes."
    return f"Retrieved Yahoo Finance data for action={action}."


def make_success_observation(
    action: str,
    requested: dict[str, Any],
    data: dict[str, Any],
    warnings: list[dict[str, Any]],
) -> dict[str, Any]:
    status = "partial_success" if warnings else "success"
    return {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "status": status,
        "ok": True,
        "action": action,
        "requested": requested,
        "data": data,
        "source": _source_observation(),
        "warnings": warnings,
        "observation": {
            "summary": _summary_for(action, data),
            "nextStep": (
                "Use the available data and disclose the warnings; do not treat missing values as zero."
                if warnings
                else "Use the returned market data with its timestamp and source context."
            ),
        },
    }


def make_error_observation(
    action: str,
    requested: dict[str, Any],
    error: YahooAPIError,
) -> dict[str, Any]:
    return {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "status": "blocked" if error.blocked else "error",
        "ok": False,
        "action": action,
        "requested": requested,
        "data": None,
        "source": _source_observation(),
        "warnings": [],
        "error": error.to_observation(),
        "observation": {
            "summary": f"Yahoo Finance action={action} failed with {error.reason_code}.",
            "nextStep": error.next_step or (
                "Retry later." if error.retryable else "Check the request or report an endpoint change."
            ),
        },
    }


def execute_action(
    action: str,
    *,
    symbol: str = "",
    query: str = "",
    period: str = "",
    interval: str = DEFAULT_HISTORY_INTERVAL,
    start: str = "",
    end: str = "",
    include_pre_post: bool = False,
    include_actions: bool = False,
    limit: int = DEFAULT_RESULT_LIMIT,
    expiration: str = "",
    statement: str = "income",
    frequency: str = "yearly",
    periods: int = 4,
    news_type: str = "news",
    include_news: bool = False,
    include_research: bool = False,
    fuzzy: bool = False,
) -> dict[str, Any]:
    SESSION.reset_observation()
    normalized_action = action.strip().lower()
    normalized_symbol = symbol.strip()
    if normalized_action not in STRUCTURED_ACTIONS:
        raise YahooAPIError(
            f"Unsupported action: {normalized_action}",
            error_kind="invalid_request",
            reason_code="YAHOO_ACTION_UNSUPPORTED",
            next_step="Choose an action declared by the yahoo-finance skill contract.",
        )
    if normalized_action == "search":
        effective_query = query.strip() or normalized_symbol
        if not effective_query:
            raise YahooAPIError(
                "action=search requires query or symbol",
                error_kind="invalid_request",
                reason_code="YAHOO_QUERY_REQUIRED",
                next_step="Provide a search query.",
            )
    elif not normalized_symbol:
        raise YahooAPIError(
            f"action={normalized_action} requires symbol",
            error_kind="invalid_request",
            reason_code="YAHOO_SYMBOL_REQUIRED",
            next_step="Provide a Yahoo Finance ticker symbol.",
        )

    requested = {
        "symbol": normalized_symbol or None,
        "query": query.strip() or None,
        "period": period or None,
        "interval": interval,
        "start": start or None,
        "endExclusive": end or None,
        "limit": limit,
    }
    if normalized_action == "history":
        requested.update({
            "includePrePost": include_pre_post,
            "includeActions": include_actions,
        })
    elif normalized_action == "options":
        requested["expiration"] = expiration or None
    elif normalized_action == "financials":
        requested.update({
            "statement": statement,
            "frequency": frequency,
            "periods": periods,
        })
    elif normalized_action == "news":
        requested["newsType"] = news_type
    elif normalized_action == "search":
        requested.update({
            "includeNews": include_news,
            "includeResearch": include_research,
            "fuzzy": fuzzy,
        })
    if normalized_action == "search":
        data, warnings = fetch_search_data(
            effective_query,
            limit=limit,
            include_news=include_news,
            include_research=include_research,
            fuzzy=fuzzy,
        )
    elif normalized_action in {"price", "quote", "fundamentals", "earnings", "profile", "dividends", "ratings"}:
        data, warnings = fetch_basic_action(normalized_action, normalized_symbol.upper())
    elif normalized_action == "history":
        data, warnings = fetch_history_data(
            normalized_symbol.upper(),
            period=period or DEFAULT_HISTORY_PERIOD,
            interval=interval,
            start=start,
            end=end,
            include_pre_post=include_pre_post,
            include_actions=include_actions,
            limit=limit,
        )
    elif normalized_action == "actions":
        data, warnings = fetch_actions_data(
            normalized_symbol.upper(),
            period=period or "max",
            start=start,
            end=end,
            limit=limit,
        )
    elif normalized_action == "financials":
        data, warnings = fetch_financials_data(
            normalized_symbol.upper(),
            statement=statement,
            frequency=frequency,
            periods=max(1, min(int(periods), 8)),
        )
    elif normalized_action == "news":
        data, warnings = fetch_news_data(
            normalized_symbol.upper(),
            news_type=news_type,
            limit=limit,
        )
    elif normalized_action == "options":
        data, warnings = fetch_options_data(
            normalized_symbol.upper(),
            expiration=expiration,
            limit=limit,
        )
    elif normalized_action == "compare":
        symbols = [item.strip().upper() for item in normalized_symbol.split(",") if item.strip()]
        if len(symbols) < 2:
            raise YahooAPIError(
                "action=compare requires at least two comma-separated symbols",
                error_kind="invalid_request",
                reason_code="YAHOO_COMPARE_SYMBOLS_REQUIRED",
                next_step="Provide between 2 and 20 comma-separated ticker symbols.",
            )
        if len(symbols) > 20:
            raise YahooAPIError(
                "action=compare accepts at most 20 symbols",
                error_kind="invalid_request",
                reason_code="YAHOO_COMPARE_TOO_MANY_SYMBOLS",
                next_step="Split the comparison into groups of at most 20 symbols.",
            )
        quotes = get_quotes(symbols)
        returned = {str(item.get("symbol")) for item in quotes}
        missing = [item for item in symbols if item not in returned]
        warnings = []
        if missing:
            warnings.append({
                "reasonCode": "YAHOO_COMPARE_SYMBOLS_MISSING",
                "component": "compare",
                "message": "Yahoo returned no quote for: " + ", ".join(missing),
                "affectedSymbols": missing,
                "retryable": False,
            })
        data = {
            "symbols": symbols,
            "quotes": [_normalize_quote(item) for item in quotes],
            "missingSymbols": missing,
        }
    else:
        raise AssertionError(f"Unhandled action: {normalized_action}")
    return make_success_observation(normalized_action, requested, data, warnings)


def render_observation_text(observation: dict[str, Any]) -> str:
    lines = [
        f"status: {observation.get('status')}",
        f"action: {observation.get('action')}",
    ]
    if observation.get("ok"):
        detail = observation.get("observation") or {}
        lines.append(f"summary: {detail.get('summary', '')}")
        warnings = observation.get("warnings") or []
        for warning in warnings:
            lines.append(
                f"warning: {warning.get('reasonCode')} - {warning.get('message')}"
            )
        lines.append(
            json.dumps(
                observation.get("data"),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        lines.append(f"nextStep: {detail.get('nextStep', '')}")
    else:
        error = observation.get("error") or {}
        lines.extend([
            f"errorKind: {error.get('errorKind')}",
            f"reasonCode: {error.get('reasonCode')}",
            f"retryable: {str(error.get('retryable', False)).lower()}",
            f"message: {error.get('message')}",
            f"nextStep: {(observation.get('observation') or {}).get('nextStep', '')}",
        ])
    return "\n".join(lines)


def _json_byte_length(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _nested_lists(value: Any) -> list[list[Any]]:
    result: list[list[Any]] = []
    if isinstance(value, list):
        result.append(value)
        for item in value:
            result.extend(_nested_lists(item))
    elif isinstance(value, dict):
        for item in value.values():
            result.extend(_nested_lists(item))
    return result


def _truncate_longest_string(value: Any) -> bool:
    parent: dict[str, Any] | list[Any] | None = None
    parent_key: str | int | None = None
    longest = ""

    def visit(node: Any, owner: dict[str, Any] | list[Any] | None, key: str | int | None) -> None:
        nonlocal parent, parent_key, longest
        if isinstance(node, str) and len(node) > len(longest):
            parent = owner
            parent_key = key
            longest = node
        elif isinstance(node, dict):
            for child_key, child in node.items():
                visit(child, node, child_key)
        elif isinstance(node, list):
            for child_index, child in enumerate(node):
                visit(child, node, child_index)

    visit(value, None, None)
    if parent is None or parent_key is None or len(longest) <= 64:
        return False
    parent[parent_key] = longest[: max(64, len(longest) // 2)] + "…"
    return True


def fit_observation_to_budget(
    observation: dict[str, Any],
    max_bytes: int = MAX_JSON_OUTPUT_BYTES,
) -> dict[str, Any]:
    """Keep JSON parseable when ExternalExecutor's hard byte limit is reached."""
    if _json_byte_length(observation) <= max_bytes:
        return observation

    warnings = observation.setdefault("warnings", [])
    if isinstance(warnings, list):
        warnings.append({
            "reasonCode": "YAHOO_OUTPUT_TRUNCATED",
            "component": "observation",
            "message": "The observation was reduced before the executor byte limit.",
            "retryable": False,
        })
    if observation.get("ok"):
        observation["status"] = "partial_success"
    source = observation.setdefault("source", {})
    if isinstance(source, dict):
        source["outputTruncated"] = True
    data = observation.get("data")
    if isinstance(data, dict):
        data["truncated"] = True
    detail = observation.get("observation")
    if isinstance(detail, dict):
        detail["nextStep"] = (
            "Narrow the request or lower limit if omitted rows or text are required."
        )

    while _json_byte_length(observation) > max_bytes:
        candidates = [rows for rows in _nested_lists(data) if rows]
        if candidates:
            largest = max(candidates, key=_json_byte_length)
            largest.pop()
            continue
        if not _truncate_longest_string(data):
            _truncate_longest_string(observation)
        if _json_byte_length(observation) > max_bytes and not _truncate_longest_string(observation):
            break
    return observation


STRUCTURED_ACTIONS = {
    "price",
    "quote",
    "fundamentals",
    "earnings",
    "profile",
    "dividends",
    "ratings",
    "options",
    "history",
    "compare",
    "search",
    "actions",
    "financials",
    "news",
}


def cmd_actions(symbol: str) -> None:
    _print(render_observation_text(execute_action("actions", symbol=symbol)))


def cmd_financials(symbol: str) -> None:
    _print(render_observation_text(execute_action("financials", symbol=symbol)))


def cmd_news(symbol: str) -> None:
    _print(render_observation_text(execute_action("news", symbol=symbol, limit=10)))


COMMANDS = {
    "price": cmd_price,
    "quote": cmd_quote,
    "fundamentals": cmd_fundamentals,
    "earnings": cmd_earnings,
    "profile": cmd_profile,
    "dividends": cmd_dividends,
    "ratings": cmd_ratings,
    "options": cmd_options,
    "history": cmd_history,
    "compare": cmd_compare,
    "search": cmd_search,
    "actions": cmd_actions,
    "financials": cmd_financials,
    "news": cmd_news,
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Yahoo Finance CLI - stock data query tool",
        usage="python yf.py <command> <symbol> [options]",
    )
    parser.add_argument("command", nargs="?", default="price",
                        help="Command: price|quote|fundamentals|earnings|profile|dividends|ratings|options|history|compare|search|actions|financials|news")
    parser.add_argument("symbol", nargs="?", help="Stock symbol (e.g. AAPL, 7453.T, BTC-USD)")
    parser.add_argument("period", nargs="?", default=DEFAULT_HISTORY_PERIOD,
                        help="Historical data period: 1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max")
    args = parser.parse_args()

    if args.command and args.command not in COMMANDS:
        args.symbol = args.command
        args.command = "price"

    if not args.symbol:
        parser.print_help()
        return 2

    try:
        if args.command == "history":
            COMMANDS[args.command](args.symbol.upper(), args.period)
        elif args.command in {"compare", "search"}:
            COMMANDS[args.command](args.symbol)
        else:
            COMMANDS[args.command](args.symbol.upper())
        return 0
    except YahooAPIError as exc:
        _print(f"[!] Yahoo Finance request failed: {exc}")
        return 1
    finally:
        SESSION.close()


if __name__ == "__main__":
    sys.exit(main())
