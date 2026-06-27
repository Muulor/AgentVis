---
name: news-summary
description: "Fetch and summarize current RSS news from curated Chinese and international feeds. Use this skill when the user asks for news updates, daily briefings, RSS headlines, AI news, finance news, culture essays, general news, or obtain the detailed content of a news article with a specific title. Prefer this for RSS-based news briefings, and use web search as a supplement for additional sources."
triggers: [news-summary, news, RSS, rss订阅, 新闻摘要, 每日新闻, 今日新闻, AI新闻, 财经新闻, 文化文章, 综合新闻]
execution:
  runtime: python
  entry: scripts/news_summary_entry.py
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
      allowedValues: [fetch, detail, list]
      examples: [fetch, detail]
    - name: category
      type: string
      required: false
      description: "News category for action=fetch."
      allowedValues: [general, ai, finance, culture, all, world, china, tech, business]
      default: general
    - name: source
      type: string
      required: false
      description: "Optional fuzzy source-name filter, such as NPR, 36Kr, The Verge, FT, or 澎湃."
    - name: url
      type: string
      required: false
      description: "Article URL for action=detail."
    - name: limit
      type: number
      required: false
      description: "Maximum number of RSS items to display per source."
      min: 1
      default: 5
    - name: full
      type: boolean
      required: false
      description: "For action=fetch, also retrieve cleaned article body text for each displayed item."
    - name: max
      type: number
      required: false
      description: "Maximum characters for each full article body or detail output."
      min: 1
      examples: [800, 3000]
dependencies:
  python: ">=3.11"
  packages:
    - httpx>=0.27
---

# News Summary Skill for AgentVis

Fetch current RSS headlines and optional article bodies through a Script Skill contract. In AgentVis `brokerOnly` mode, HTTP(S) requests are sent through `agentvis-broker-fetch`; direct local runs fall back to `httpx`. RSS titles/descriptions are HTML-parser cleaned, dated items are sorted newest-first, and article-body extraction filters common page chrome such as navigation, subscriptions, captions, and share controls.

## Actions

- `fetch`: collect RSS headlines from a category or fuzzy-matched source.
- `detail`: fetch and clean the body text for one article URL.
- `list`: print all configured categories and sources.

## Categories

| Category | Description | Sources |
| --- | --- | --- |
| `general` | 综合新闻 | 新华社, 纽约时报双语版, 界面新闻, 澎湃新闻, NPR, Al Jazeera |
| `ai` | AI 前沿 | The Verge AI, MIT Tech Review AI, Ars Technica, Wired Science, TechCrunch AI |
| `finance` | 财经风向 | FT Markets, TechCrunch Venture, 华尔街见闻中文, 36氪 |
| `culture` | 文化与深思 | The Atlantic, New Yorker Culture, Aeon Magazine, Nowness, Southern Weekly (南方周末) |
| `all` | All categories | All configured sources |

Legacy CLI category aliases remain supported for compatibility: `world`/`china` map to `general`, `tech` maps to `ai`, and `business` maps to `finance`.

## Maintainer Notes

The Script entrypoint is intentionally thin so sandbox static checks inspect `scripts/news_summary_entry.py`, while the RSS implementation stays in `news.py`. Keep future network calls behind `_http_get_text` so brokerOnly execution remains fail-closed and local development stays convenient.
