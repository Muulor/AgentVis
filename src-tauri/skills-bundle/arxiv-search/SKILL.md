---
name: arxiv-search
description: "Search, browse, inspect, and download academic papers from arXiv through the public arXiv API. Use this skill when the user asks for research papers, academic literature, paper summaries, latest ML/AI/CS papers, paper metadata, arXiv IDs, PDF downloads, or literature review starting points."
triggers: [arxiv-search, arxiv, arXiv, 论文搜索, 学术论文, 论文下载, 文献检索, 最新论文, research paper, paper search, academic search, paper download, literature review]
execution:
  runtime: python
  entry: scripts/arxiv_search_entry.py
  timeout: 90
  maxOutput: 131072
  permissions:
    network: true
    networkMode: brokerOnly
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Action to run: search, latest, detail, download, or categories."
    - name: query
      type: string
      required: false
      description: "Search query for action=search, or fallback arXiv ID/URL for detail/download."
    - name: category
      type: string
      required: false
      description: "arXiv category ID or alias for search/latest. Examples: cs.AI, cs.CL, ai, ml, nlp, cv."
    - name: arxiv_id
      type: string
      required: false
      description: "arXiv ID or URL for action=detail/download. Examples: 1706.03762, 1706.03762v7, https://arxiv.org/abs/1706.03762."
    - name: sort
      type: string
      required: false
      description: "Sort mode for action=search: relevance, date, or updated. Defaults to relevance."
    - name: sort_order
      type: string
      required: false
      description: "Sort order for search/latest: descending/newest or ascending/oldest. Defaults to descending."
    - name: start
      type: number
      required: false
      description: "Zero-based result offset for pagination. Defaults to 0."
    - name: limit
      type: number
      required: false
      description: "Maximum number of results for search/latest. Defaults to 10, matching the arXiv API default. Exceeding 10 is not recommended due to the risk of triggering a 429 rate limit."
    - name: field
      type: string
      required: false
      description: "Optional field for plain search terms: all, title, author, abstract, category, ti, au, abs, cat, co, jr, rn, or id. Defaults to all."
    - name: filter
      type: string
      required: false
      description: "Additional raw arXiv search_query clause appended with AND. This is a skill convenience parameter, not an official separate arXiv API URL parameter."
    - name: date_from
      type: string
      required: false
      description: "Submitted-date lower bound for search/latest. Accepts YYYY-MM-DD, YYYYMMDD, or YYYYMMDDHHMM and maps to submittedDate."
    - name: date_to
      type: string
      required: false
      description: "Submitted-date upper bound for search/latest. Accepts YYYY-MM-DD, YYYYMMDD, or YYYYMMDDHHMM and maps to submittedDate."
    - name: author
      type: string
      required: false
      description: "Author filter for action=search. Maps to au:<value>."
    - name: title
      type: string
      required: false
      description: "Title filter for action=search. Maps to ti:<value>."
    - name: abstract
      type: string
      required: false
      description: "Abstract filter for action=search. Maps to abs:<value>."
    - name: abstract_max
      type: number
      required: false
      description: "Maximum abstract characters in search/latest list output. Defaults to 500."
    - name: output_dir
      type: string
      required: false
      description: "Download directory for action=download. Defaults to the current Agent deliverables/workdir when available, otherwise ./arxiv_papers. If a .pdf path is provided here, it is treated as an output file for compatibility."
    - name: output_file
      type: string
      required: false
      description: "Exact PDF file path for action=download. Prefer this when the desired output name is known, for example ./2605.30335.pdf."
dependencies:
  python: ">=3.11"
  packages: []
---

# arXiv Search Skill for AgentVis

Search academic papers through the public arXiv API, fetch latest papers by category, inspect complete paper metadata, list common categories, and download PDFs through a Script Skill contract.

In AgentVis `brokerOnly` mode, HTTP(S) requests are sent explicitly through `agentvis-broker-fetch`; direct local runs use Python standard-library networking. The implementation parses arXiv Atom XML directly and no longer depends on the third-party `arxiv` Python package.

## Actions

- `search`: search papers by keyword or arXiv advanced query syntax.
- `latest`: fetch latest papers for a category or alias.
- `detail`: show complete metadata for one arXiv ID or URL.
- `download`: download one paper PDF to `output_file`, `output_dir`, or the current Agent deliverables/workdir.
- `categories`: list common category IDs and aliases.

## Query Syntax

arXiv supports field prefixes and boolean operators:

| Prefix | Description | Example |
| --- | --- | --- |
| `ti:` | Search titles | `ti:transformer` |
| `au:` | Search authors | `au:Hinton` |
| `abs:` | Search abstracts | `abs:reinforcement learning` |
| `cat:` | Search category | `cat:cs.AI` |
| `submittedDate:` | Filter by submitted date range | `submittedDate:[202603010000 TO 202605312359]` |
| `AND/OR/ANDNOT` | Boolean combination | `au:LeCun AND ti:deep` |

The official arXiv query endpoint accepts `search_query`, `id_list`, `start`, `max_results`, `sortBy`, and `sortOrder`. Use this skill's `filter`, `date_from`, `date_to`, `author`, `title`, `abstract`, `category`, and `field` arguments as local helpers that are combined into `search_query`.

The skill waits at least 3.2 seconds between arXiv API calls across AgentVis skill processes. Keep the default `limit=10` unless the user explicitly needs a broader page; repeated small requests should still be avoided.

## Category Aliases

| Alias | Category |
| --- | --- |
| `ai` | `cs.AI` |
| `ml` | `cs.LG` |
| `nlp` | `cs.CL` |
| `cv` | `cs.CV` |
| `robotics` | `cs.RO` |
| `security` | `cs.CR` |
| `ir` | `cs.IR` |
| `se` | `cs.SE` |

## Maintainer Notes

The declared Script entrypoint is `scripts/arxiv_search_entry.py` and intentionally contains no URL literals or direct network client imports. Keep arXiv HTTP access inside `scripts/arxiv_search.py` behind `request_url`, so sandboxed execution remains brokerOnly while local development stays convenient.
