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
      description: "Operation to run."
      allowedValues: [price, quote, fundamentals, earnings, profile, dividends, ratings, options, history, compare, search]
      examples: [price, history, search]
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
      description: "Historical data period for action=history."
      allowedValues: [1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max]
      default: 1mo
dependencies:
  python: ">=3.11"
  packages:
    - httpx>=0.27
---

# Yahoo Finance Skill for AgentVis

Query Yahoo Finance market data through a Script Skill contract. In AgentVis `brokerOnly` mode, HTTP(S) requests are sent explicitly through `agentvis-broker-fetch`; direct local runs fall back to `httpx`.

## Symbol Hints

Common Yahoo symbols include US stocks such as `AAPL`, Japan stocks such as `7453.T`, India NSE symbols such as `RELIANCE.NS`, crypto pairs such as `BTC-USD`, FX pairs such as `EURUSD=X`, and ETFs such as `SPY`.

## Maintainer Notes

In AgentVis `brokerOnly` mode, HTTP(S) requests are sent explicitly through `agentvis-broker-fetch`; direct local runs fall back to `httpx`. The implementation calls Yahoo Finance JSON endpoints directly and manages the required Yahoo cookie/crumb flow itself, so it no longer depends on `yfinance`.

The declared Script entrypoint is `scripts/yf_entry.py` and intentionally contains no URL literals or direct network client imports. Keep Yahoo HTTP access inside `yf.py` behind `YahooSession`, so sandboxed execution remains brokerOnly while local development stays convenient.
