---
name: arxiv-search
description: "Search, browse, inspect, and download academic papers from arXiv through the public arXiv API. Single-flight only: do not call this skill in parallel; serialize arxiv-search calls at least 3 seconds apart or combine terms into one broader query. Use this skill when the user asks for research papers, academic literature, paper summaries, latest ML/AI/CS papers, paper metadata, arXiv IDs, PDF downloads, or literature review starting points."
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
      description: "Operation to run. Do not issue multiple arxiv-search calls in parallel."
      allowedValues: [search, latest, detail, download, categories]
      examples: [search, detail]
    - name: query
      type: string
      required: false
      description: "Search query for action=search, or fallback arXiv ID/URL for detail/download. For multiple related terms, prefer one broader arXiv query with OR/AND instead of parallel skill calls."
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
      description: "Sort mode for search."
      allowedValues: [relevance, date, updated]
      default: relevance
    - name: sort_order
      type: string
      required: false
      description: "Sort order for search/latest."
      allowedValues: [ascending, asc, oldest, descending, desc, newest]
      default: descending
    - name: start
      type: number
      required: false
      description: "Zero-based result offset for pagination."
      min: 0
      default: 0
    - name: limit
      type: number
      required: false
      description: "Maximum search/latest results. Keep <=10 unless the user explicitly needs more."
      min: 1
      max: 50
      default: 10
      examples: [5, 10]
    - name: field
      type: string
      required: false
      description: "Field for plain search terms."
      allowedValues: [all, title, ti, author, au, abstract, abs, comment, co, journal, jr, category, cat, report, rn, id]
      default: all
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
      description: "Maximum abstract characters in search/latest list output."
      min: 1
      max: 5000
      default: 500
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

Routine Sub-Agent usage is encoded in the frontmatter execution contract and injected as a compact Script Skill card. This body is fallback material for maintainers and failure diagnosis.

## Troubleshooting

- If the arXiv API throttles or returns transient network errors, retry serially after a delay. The script already holds a cross-process single-flight lock and waits at least 3.2 seconds between arXiv API calls.
- If several related keyword searches are needed, combine terms with arXiv boolean syntax such as `OR`, `AND`, field prefixes (`ti:`, `au:`, `abs:`, `cat:`), or submitted-date clauses instead of launching parallel tool calls.
- If downloaded PDFs are corrupt or too small, inspect the script output for the saved path, byte count, content type, and `%PDF` validation result. Broker-mode downloads stream through `savePath` to avoid large base64 responses.
- If a category alias is unclear, run `action=categories` first.
- `filter`, `date_from`, `date_to`, `author`, `title`, `abstract`, `category`, and `field` are local helpers that are combined into the official arXiv `search_query`.

## Maintainer Notes

In AgentVis `brokerOnly` mode, HTTP(S) requests are sent explicitly through `agentvis-broker-fetch`; direct local runs use Python standard-library networking. The implementation parses arXiv Atom XML directly and no longer depends on the third-party `arxiv` Python package.

The declared Script entrypoint is `scripts/arxiv_search_entry.py` and intentionally contains no URL literals or direct network client imports. Keep arXiv HTTP access inside `scripts/arxiv_search.py` behind `request_url`, so sandboxed execution remains brokerOnly while local development stays convenient.
