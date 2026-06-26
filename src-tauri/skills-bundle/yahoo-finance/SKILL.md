---
name: yahoo-finance
description: "Get stock, ETF, index, forex, and crypto market data from Yahoo Finance. Use this skill when the user asks for prices, detailed quotes, fundamentals, earnings, company profiles, dividends, analyst ratings, options chains, historical prices, ticker comparison, or symbol search for financial analysis. This skill provides market data only and should not be treated as investment advice."
triggers: [yahoo-finance, Yahoo Finance, 股票查询, 股价, 财报, fundamentals, earnings, options chain, dividends, analyst ratings, stock quote, ticker]
execution:
  runtime: python
  entry: scripts/yf_entry.py
  timeout: 90
  maxOutput: 131072
  permissions:
    network: true
    networkMode: brokerOnly
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Action to run: price, quote, fundamentals, earnings, profile, dividends, ratings, options, history, compare, or search."
    - name: symbol
      type: string
      required: false
      description: "Ticker symbol, comma-separated ticker list for compare, or search text for search. Examples: AAPL, 7453.T, BTC-USD, AAPL,MSFT,GOOGL."
    - name: query
      type: string
      required: false
      description: "Fallback search text or ticker value when symbol is omitted."
    - name: period
      type: string
      required: false
      description: "Historical data period for action=history: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, or max. Defaults to 1mo."
dependencies:
  python: ">=3.11"
  packages:
    - httpx>=0.27
---

# Yahoo Finance Skill for AgentVis

Query Yahoo Finance market data through a Script Skill contract. In AgentVis `brokerOnly` mode, HTTP(S) requests are sent explicitly through `agentvis-broker-fetch`; direct local runs fall back to `httpx`.

The implementation calls Yahoo Finance JSON endpoints directly and manages the required Yahoo cookie/crumb flow itself, so it no longer depends on `yfinance`.

## Actions

- `price`: quick current price snapshot.
- `quote`: detailed quote table.
- `fundamentals`: valuation, profitability, financial health, and analyst target metrics.
- `earnings`: EPS and earnings/financials overview.
- `profile`: company profile and business description.
- `dividends`: dividend metrics and recent dividend events.
- `ratings`: analyst recommendation metrics and recent changes.
- `options`: nearest expiration options chain.
- `history`: historical OHLCV prices for `period`.
- `compare`: compare multiple comma-separated symbols.
- `search`: find ticker symbols by company/name text.

## Symbol Examples

| Asset | Example |
| --- | --- |
| US stock | `AAPL`, `MSFT`, `GOOGL`, `TSLA` |
| Japan stock | `7453.T`, `6758.T` |
| India NSE | `RELIANCE.NS`, `TCS.NS` |
| Cryptocurrency | `BTC-USD`, `ETH-USD` |
| FX | `EURUSD=X`, `GBPUSD=X` |
| ETF | `SPY`, `QQQ`, `VOO` |

## Maintainer Notes

The declared Script entrypoint is `scripts/yf_entry.py` and intentionally contains no URL literals or direct network client imports. Keep Yahoo HTTP access inside `yf.py` behind `YahooSession`, so sandboxed execution remains brokerOnly while local development stays convenient.
