"""
Yahoo Finance CLI - stock/ETF/crypto market data query tool.

Uses Yahoo Finance JSON endpoints directly. In AgentVis brokerOnly mode,
HTTP(S) requests are sent through agentvis-broker-fetch; local direct runs fall
back to httpx. No API key is required.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import io
import json
import os
import subprocess
import sys
import time
from typing import Any
from urllib.parse import urlencode, urlparse

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


REQUEST_TIMEOUT_SECONDS = 30
USER_AGENT = "Mozilla/5.0 AgentVis-Yahoo-Finance/1.0"
DEFAULT_HISTORY_PERIOD = "1mo"
QUOTE_SUMMARY_MODULES = ",".join([
    "assetProfile",
    "summaryProfile",
    "summaryDetail",
    "financialData",
    "defaultKeyStatistics",
    "recommendationTrend",
    "upgradeDowngradeHistory",
    "earnings",
    "calendarEvents",
])


class YahooAPIError(Exception):
    """Yahoo Finance API error."""


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


class YahooSession:
    def __init__(self) -> None:
        self.cookies: dict[str, str] = {}
        self.crumb: str | None = None
        self._client: Any = None

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    def _cookie_header(self) -> str:
        return "; ".join(f"{name}={value}" for name, value in self.cookies.items())

    def _update_cookies(self, headers: dict[str, str]) -> None:
        for name, value in headers.items():
            if name.lower() != "set-cookie":
                continue
            cookie = value.split(";", 1)[0]
            if "=" in cookie:
                key, cookie_value = cookie.split("=", 1)
                if key and cookie_value:
                    self.cookies[key] = cookie_value

    def _request_broker(self, url: str, accept: str = "application/json") -> HTTPResponse:
        helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
        headers = {
            "Accept": accept,
            "User-Agent": USER_AGENT,
        }
        cookie = self._cookie_header()
        if cookie:
            headers["Cookie"] = cookie
        request = {
            "method": "GET",
            "url": url,
            "headers": [{"name": k, "value": v} for k, v in headers.items()],
            "timeoutMs": REQUEST_TIMEOUT_SECONDS * 1000,
        }
        completed = subprocess.run(
            [helper],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=REQUEST_TIMEOUT_SECONDS + 10,
            check=False,
        )
        try:
            payload = json.loads(completed.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise YahooAPIError(f"Broker helper returned invalid JSON: {exc}") from exc
        if completed.returncode != 0 or payload.get("ok") is not True:
            error = payload.get("error") or completed.stderr or "unknown broker helper failure"
            raise YahooAPIError(f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")
        response_headers = {
            str(item.get("name", "")).lower(): str(item.get("value", ""))
            for item in payload.get("headers") or []
            if item.get("name")
        }
        self._update_cookies(response_headers)
        body = base64.b64decode(payload.get("bodyBase64") or "")
        return HTTPResponse(
            status_code=int(payload.get("status") or 0),
            text=body.decode("utf-8", errors="replace"),
            headers=response_headers,
        )

    def _request_direct(self, url: str, accept: str = "application/json") -> HTTPResponse:
        try:
            import httpx
        except ImportError as exc:
            raise YahooAPIError("Missing httpx library. Please install httpx>=0.27.") from exc
        if self._client is None:
            self._client = httpx.Client(
                headers={"User-Agent": USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
                follow_redirects=True,
            )
        last_error: Exception | None = None
        for _ in range(2):
            try:
                response = self._client.get(url, headers={"Accept": accept})
                break
            except httpx.RequestError as exc:
                last_error = exc
                time.sleep(0.5)
        else:
            raise YahooAPIError(f"Request failed: {last_error}") from last_error
        return HTTPResponse(
            status_code=response.status_code,
            text=response.text,
            headers={k.lower(): v for k, v in response.headers.items()},
        )

    def request(self, url: str, accept: str = "application/json") -> HTTPResponse:
        response = self._request_broker(url, accept) if broker_helper_available() else self._request_direct(url, accept)
        if response.status_code >= 400 and response.status_code != 404:
            raise YahooAPIError(f"HTTP {response.status_code}: {response.text[:180]}")
        return response

    def ensure_crumb(self) -> str:
        if self.crumb:
            return self.crumb
        try:
            self.request("https://fc.yahoo.com", accept="text/html")
        except YahooAPIError:
            pass
        response = self.request("https://query1.finance.yahoo.com/v1/test/getcrumb", accept="text/plain")
        crumb = response.text.strip()
        if not crumb or "<html" in crumb.lower():
            raise YahooAPIError("Unable to obtain Yahoo Finance crumb")
        self.crumb = crumb
        return crumb

    def json_get(self, url: str, *, crumb: bool = False) -> dict[str, Any]:
        if crumb:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{urlencode({'crumb': self.ensure_crumb()})}"
        response = self.request(url)
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise YahooAPIError(f"Yahoo returned invalid JSON: {exc}") from exc
        finance_error = data.get("finance", {}).get("error") if isinstance(data, dict) else None
        if finance_error:
            raise YahooAPIError(str(finance_error.get("description") or finance_error))
        return data


SESSION = YahooSession()


def build_url(base: str, params: dict[str, str | int | float]) -> str:
    return f"{base}?{urlencode(params)}"


def get_quotes(symbols: list[str]) -> list[dict[str, Any]]:
    url = build_url("https://query1.finance.yahoo.com/v7/finance/quote", {
        "symbols": ",".join(symbols),
    })
    data = SESSION.json_get(url, crumb=True)
    return data.get("quoteResponse", {}).get("result", [])


def get_quote(symbol: str) -> dict[str, Any]:
    quotes = get_quotes([symbol])
    if not quotes:
        raise YahooAPIError(f"No quote data found for {symbol}")
    return quotes[0]


def get_quote_summary(symbol: str) -> dict[str, Any]:
    url = build_url(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}", {
        "modules": QUOTE_SUMMARY_MODULES,
    })
    data = SESSION.json_get(url, crumb=True)
    result = data.get("quoteSummary", {}).get("result") or []
    return result[0] if result else {}


def get_chart(symbol: str, period: str = DEFAULT_HISTORY_PERIOD, interval: str = "1d", events: str = "") -> dict[str, Any]:
    params: dict[str, str] = {
        "range": period,
        "interval": interval,
    }
    if events:
        params["events"] = events
    url = build_url(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", params)
    data = SESSION.json_get(url)
    result = data.get("chart", {}).get("result") or []
    if not result:
        raise YahooAPIError(f"No chart data found for {symbol}")
    return result[0]


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
    financial = summary.get("financialData", {})
    name = q.get("longName") or q.get("shortName") or symbol
    _print(f"\n{name} ({symbol}) - Earnings Data\n")

    table = SimpleTable(["Metric", "Value"], show_header=False)
    table.add_row("EPS (TTM)", _safe(q.get("epsTrailingTwelveMonths"), ".2f"))
    table.add_row("Forward EPS", _safe(_value(financial.get("forwardEps")), ".2f"))
    table.add_row("Earnings Date", _date_from_epoch(_value(calendar.get("earningsDate", [{}])[0]) if isinstance(calendar.get("earningsDate"), list) else _value(calendar.get("earningsDate"))))
    table.add_row("Revenue Avg", _money(_value(calendar.get("earningsAverage")), q.get("currency", "")))
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
    except Exception:
        pass
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
    url = f"https://query1.finance.yahoo.com/v7/finance/options/{symbol}"
    data = SESSION.json_get(url, crumb=True)
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
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Yahoo Finance CLI - stock data query tool",
        usage="python yf.py <command> <symbol> [options]",
    )
    parser.add_argument("command", nargs="?", default="price",
                        help="Command: price|quote|fundamentals|earnings|profile|dividends|ratings|options|history|compare|search")
    parser.add_argument("symbol", nargs="?", help="Stock symbol (e.g. AAPL, 7453.T, BTC-USD)")
    parser.add_argument("period", nargs="?", default=DEFAULT_HISTORY_PERIOD,
                        help="Historical data period: 1d|5d|1mo|3mo|6mo|1y|2y|5y|ytd|max")
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
