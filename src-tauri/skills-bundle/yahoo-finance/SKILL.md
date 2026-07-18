---
name: yahoo-finance
description: "Get stock, ETF, index, forex, crypto, and fund data from Yahoo Finance. Use this skill for prices, quotes, valuation metrics, earnings, profiles, dividends, corporate actions, analyst ratings, options chains, configurable price history, financial statements, ticker news, comparisons, or symbol search. Results are market data only and are not investment advice."
triggers: [yahoo-finance, Yahoo Finance, 股票查询, 股价, 财报, fundamentals, financial statements, earnings, options chain, dividends, corporate actions, analyst ratings, ticker news, stock quote, ticker]
agentvisNetwork: brokerProxyPreferred
execution:
  runtime: python
  entry: scripts/yf_entry.py
  timeout: 90
  maxOutput: 131072
  permissions:
    network: true
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Operation to run. Use actions for dividends/splits/capital gains, financials for statement history, and news for ticker-specific news."
      allowedValues: [price, quote, fundamentals, earnings, profile, dividends, ratings, options, history, compare, search, actions, financials, news]
      examples: [price, history, financials, actions, news, search]
    - name: symbol
      type: string
      required: false
      description: "Yahoo ticker, comma-separated ticker list for compare, or legacy search text. Examples include AAPL, 7453.T, BTC-USD, EURUSD=X, and ^GSPC."
    - name: query
      type: string
      required: false
      description: "Search text for action=search. symbol remains a backward-compatible fallback."
    - name: period
      type: string
      required: false
      description: "Range for history or actions. history defaults to 1mo and actions defaults to max. Do not combine with start/end."
      allowedValues: [1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max]
    - name: interval
      type: string
      required: false
      description: "Price interval for action=history. Intraday intervals have Yahoo lookback limits."
      allowedValues: [1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo]
      default: 1d
    - name: start
      type: string
      required: false
      description: "Inclusive YYYY-MM-DD start date for history or actions. Must be paired with end."
    - name: end
      type: string
      required: false
      description: "Exclusive YYYY-MM-DD end date for history or actions. Must be paired with start."
    - name: includePrePost
      type: boolean
      required: false
      description: "Include pre-market and post-market price rows for history."
      default: false
    - name: includeActions
      type: boolean
      required: false
      description: "Include dividends, splits, and capital gains alongside history rows."
      default: false
    - name: limit
      type: number
      required: false
      description: "Maximum rows per output family: history prices, each actions event type, each options side, or news/search items. Defaults to 25 for history, 250 for actions, and 10 for options/news/search."
      min: 1
      max: 250
    - name: expiration
      type: string
      required: false
      description: "YYYY-MM-DD expiration for action=options. Omit to use the first available expiration."
    - name: statement
      type: string
      required: false
      description: "Statement family for action=financials."
      allowedValues: [income, balance-sheet, cash-flow, all]
      default: income
    - name: frequency
      type: string
      required: false
      description: "Statement frequency for action=financials. trailing is not supported for balance-sheet."
      allowedValues: [yearly, quarterly, trailing]
      default: yearly
    - name: periods
      type: number
      required: false
      description: "Maximum periods per metric for action=financials. Yahoo commonly exposes four annual or five quarterly periods."
      min: 1
      max: 8
      default: 4
    - name: newsType
      type: string
      required: false
      description: "Ticker news tab for action=news."
      allowedValues: [news, all, press-releases]
      default: news
    - name: includeNews
      type: boolean
      required: false
      description: "Include legacy search-news matches for action=search. This is distinct from ticker-specific action=news."
      default: false
    - name: includeResearch
      type: boolean
      required: false
      description: "Include research-report matches for action=search when Yahoo provides them."
      default: false
    - name: fuzzy
      type: boolean
      required: false
      description: "Enable fuzzy matching for action=search."
      default: false
    - name: outputFormat
      type: string
      required: false
      description: "Use json for a stable Agent observation envelope; text remains the backward-compatible default."
      allowedValues: [text, json]
      default: text
dependencies:
  python: ">=3.11"
  packages:
    - httpx>=0.27
---

# Yahoo Finance Skill for AgentVis

Query Yahoo Finance through a named-argument Script Skill. In LocalAudit mode, HTTP(S) requests use `httpx` directly; in ControlledNetwork mode, the implementation is proxy-aware and can use the explicit AgentVis broker helper.

## Action Guidance

- Use `price` or `quote` for current market data and `compare` for 2–20 comma-separated symbols.
- Use `history` for OHLCV/adjusted-close rows. `start` is inclusive, `end` is exclusive, and explicit dates cannot be combined with `period`. For `interval=30m`, the skill follows yfinance's compatibility workaround by requesting 15-minute bars and aggregating them into 30-minute OHLCV rows.
- Use `actions` for dividends, splits, and fund capital gains. Use `includeActions=true` only when those events should accompany price history.
- Use `financials` for income, balance-sheet, or cash-flow timeseries. Yahoo generally returns at most four annual or five quarterly periods. Trailing balance-sheet data is intentionally rejected rather than fabricated.
- Use `news` for current ticker-specific latest/all/press-release streams. Use `search` to discover symbols; optional search news is a separate legacy search result family.
- Use `expiration` and `limit` to constrain options chains. Use `outputFormat=json` whenever downstream logic needs stable fields instead of display text.

Common Yahoo symbols include US stocks such as `AAPL`, Japan stocks such as `7453.T`, India NSE symbols such as `RELIANCE.NS`, crypto pairs such as `BTC-USD`, FX pairs such as `EURUSD=X`, indices such as `^GSPC`, and ETFs such as `SPY`.

## Observation Contract

JSON output uses schema version `1.0` and always includes `status`, `ok`, `action`, `requested`, `source`, `warnings`, and an Agent-facing `observation`. Successful data is under `data`. Failures also include `error.errorKind`, `error.reasonCode`, `error.retryable`, optional `retryAfterSeconds`, and `observation.nextStep`.

- `success` means all requested components were returned.
- `partial_success` means useful data is present but Yahoo omitted fields, a component failed, or rows were intentionally limited. The Agent must disclose the warning and must never interpret missing values as zero.
- `error` with `retryable=true` covers rate limits, transient network failures, and selected Yahoo 5xx responses.
- `blocked` means the AgentVis broker/helper or network policy cannot execute the request; the Agent should follow `nextStep` instead of retrying blindly.
- `provider_schema_changed` and reason codes ending in `SCHEMA_CHANGED` are maintenance signals. Do not invent substitute values or repeatedly retry; tell the user which action is temporarily unavailable and report the reason code.

Text output carries the same status, warning/error codes, retryability, and next step, while preserving a human-readable mode for existing callers.

## Network, Privacy, And Upstream Risk

The skill calls Yahoo Finance JSON endpoints directly and manages Yahoo's cookie/crumb flow without reading an API key. Ticker symbols, search text, requested dates, and action parameters are sent to Yahoo Finance. Observations intentionally omit request URLs, crumb values, Cookie/Set-Cookie headers, broker tokens, and response bodies on failure.

Yahoo Finance endpoints used by `quoteSummary`, fundamentals timeseries, options, search, and ticker news are public-facing but unofficial/private interfaces. Yahoo can change schemas, anti-bot requirements, rate limits, or endpoint availability without notice. The direct `httpx` path also cannot reproduce yfinance's browser TLS fingerprint, so HTTP 401/403/429 responses are an expected operational risk and are surfaced explicitly rather than hidden.

## Maintainer Notes

The implementation follows the high-value request and response shapes used by yfinance 1.5.1 but deliberately does not depend on `yfinance`, pandas, or its `curl_cffi` transport. This keeps the AgentVis broker/proxy path inspectable. It is selective coverage, not a promise to expose every yfinance class or utility.

The declared entrypoint is `scripts/yf_entry.py` and intentionally contains no URL literals or direct network-client imports. Keep Yahoo HTTP access inside `yf.py` behind `YahooSession`. The broker path preserves duplicate `Set-Cookie` headers before building the next request.

The script enforces an 82-second execution deadline inside the 90-second Script contract and uses bounded per-request timeouts, leaving time to emit a structured retryable observation instead of being killed by the outer executor on a slow network.

Fixture tests must use minimal synthetic responses and must never contain real cookies, crumbs, broker tokens, credentials, or full diagnostic URLs. Run the offline parser/observation tests first, then an opt-in live smoke for `price`, `history`, `actions`, `financials`, `news`, and a deliberate invalid request. A ControlledNetwork smoke in the app is still required when broker behavior changes.
