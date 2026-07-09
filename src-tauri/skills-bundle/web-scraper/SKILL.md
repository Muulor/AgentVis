---
name: web-scraper
description: Scrape and extract structured knowledge from any web page or documentation site. Use this skill whenever needs to grab content from a URL, extract text and image from a website, crawl documentation pages, collect information from web pages, or convert web content to Markdown. Supports scraping without login (e.g., WeChat articles). For platforms with strict anti-scraping and authentication requirements (Xiaohongshu, Zhihu, Weibo), an agent-browser is recommended.
triggers: [web-scraper, scrape, extract web, crawl pages, website crawl, 网页抓取, 抓取图片，抓取网页, 网页内容, 提取网页, 抓取页面]
agentvisNetwork: brokerProxyPreferred
---

# Web Scraper skill for AgentVis - web knowledge scraping skill

Scrape web page content from any URL, extract structured knowledge (title, body text, links, metadata), and output it as Markdown. Supports single-page scraping and multi-page recursive scraping. The script includes browser request headers/profile alignment, 429/5xx retry, Retry-After backoff, randomized request intervals, and common verification-page warnings by default; no extra parameters are required.

## Quick Use - Recommended Method

- Use the `scripts/scrape.py` script to complete all scraping tasks. The script uses httpx, BeautifulSoup, and lxml already available in the runtime, so no additional dependencies need to be installed. For anti-scraping pages, prefer curl_cffi browser TLS fingerprint impersonation with `--impersonate chrome`; curl_cffi resolves this alias to the newest bundled Chrome profile. Pin a specific profile such as `chrome146` only when reproducibility matters. For platforms with stricter anti-scraping, use the Session Cookie method for scraping.
- For sparse SPA/documentation pages, the scraper automatically attempts structured data recovery before giving up. Current adapters cover Next.js `/api/doc/{identifier}` Notion-style record maps, Next.js `__NEXT_DATA__` and RSC flight data, Gatsby `page-data.json`, Nuxt payload data, Remix/React Router hydration data, SvelteKit `__data.json` and fetched payloads, Angular TransferState, Qwik JSON, page-level Markdown source files, VitePress/VuePress/Pagefind bodies, MkDocs/Docusaurus-style search indexes, `llms.txt`, documentation manifests, Algolia DocSearch, dehydrated app state, conservative same-origin JS bundle API discovery, and Swagger/OpenAPI specs, then continue through the normal Markdown saving/image pipeline.
- When `--sitemap` cannot find a valid sitemap, the scraper falls back to scoped link crawling. For documentation entry pages such as `/learn` or `/docs`, crawl discovery prioritizes URLs under the same top-level path before global navigation links.
- Multi-page crawling normalizes URLs for de-duplication (ordinary anchor fragments, default ports, trailing slashes, query ordering, and common tracking parameters) and skips both already scraped URLs and URLs already queued for scraping. Hash-router SPA routes such as `#/docs/page` and `#!/docs/page` are preserved as distinct crawl URLs.
- Multi-page crawling writes each completed page immediately as `page_001.md`, `page_002.md`, etc.; the final pass still refreshes the same files and writes `summary.md`. Image downloads are still saved during each page scrape.
- Most modern web pages combine images and text. Images encountered inside the extracted body are emitted inline in their original DOM order; when image flags are enabled, the scraper can prefer the body conversion that preserves inline image order over a text-only extraction. `--include-images` only appends extra images that were not already present in the body. Prefer using `--download-images` together with `--include-images` to save those image references locally for offline preview.

```bash
# Scrape a single page
python scripts/scrape.py "URL" --output-dir "OUTPUT_DIR"

# Recursively scrape a documentation site (depth 2, up to 30 pages)
python scripts/scrape.py "URL" --depth 2 --max-pages 30 --output-dir "OUTPUT_DIR"

# Scrape through sitemap.xml
python scripts/scrape.py "URL" --sitemap --max-pages 50 --output-dir "OUTPUT_DIR"

# Specify a CSS selector for precise extraction
python scripts/scrape.py "URL" --selector "article.main-content" --output-dir "OUTPUT_DIR"
```

## Script Parameters

| Parameter | Short | Description | Default |
|------|------|------|--------|
| `url` | - | Target URL (required positional argument) | - |
| `--output-dir` | `-o` | Output directory | `./scraped_output` |
| `--depth` | `-d` | Recursive scraping depth (0 = current page only) | `0` |
| `--max-pages` | `-m` | Maximum number of pages to scrape | `20` |
| `--selector` | `-s` | CSS selector for the body content area | Automatic detection |
| `--exclude-selector` | `-e` | Area selector to exclude (can be specified multiple times) | `nav,header,footer,.sidebar` |
| `--include-links` | | Include the list of in-page links in the output | `false` |
| `--include-images` | | Include image URLs in the output | `false` |
| `--download-images` | | Download page images to the `images/` subdirectory and replace image links in the MD with local relative paths (offline previewable) | `false` |
| `--sitemap` | | Prefer sitemap.xml to discover pages | `false` |
| `--timeout` | `-t` | Per-page request timeout (seconds) | `15` |
| `--delay` | | Request interval (seconds) to avoid rate limiting | `0.5` |
| `--proxy` | | HTTP proxy address | - |
| `--headers` | | Custom request headers (JSON string) | - |
| `--cookies` | | Additional cookies, in JSON string format, such as `'{"name": "value"}'` | - |
| `--cookies-file` | | Read cookies from a JSON file (`{name: value}` dictionary) | - |
| `--user-agent` | | Custom User-Agent | Built-in browser UA |
| `--encoding` | | Force a specific encoding (auto-detect if not specified) | Auto |
| `--summary` | | Output the site summary file summary.md | `false` |
| `--no-trafilatura` | | Disable trafilatura body extraction and force fallback to the BeautifulSoup heuristic | `false` |
| `--impersonate` | | Use curl_cffi to impersonate browser TLS fingerprints and bypass anti-scraping (recommended `chrome`, or pin `chrome146`) | - |

## Output Format

### Single-page Mode (depth=0)

Output a single Markdown file `{output-dir}/{sanitized-title}.md`:

```markdown
---
url: https://example.com/docs/guide
title: Getting Started Guide
scraped_at: 2026-03-20T17:30:00+08:00
---

# Getting Started Guide

Body content...

## Links (if --include-links)
- [Installation](https://example.com/docs/install)
- [API Reference](https://example.com/docs/api)
```

### Multi-page Mode (depth > 0 or --sitemap)

Output directory structure:
```
output-dir/
|-- summary.md          # Site directory index (contains the list of all scraped pages)
|-- page_001.md         # Content for each page
|-- page_002.md
`-- ...
```

## Workflow

When the user asks to scrape web page content:

1. Confirm the target URL and scraping scope (single page vs whole site)
2. If it is a documentation site, recommend using `--depth 1` or `--sitemap` to get more complete content
3. If the user needs content from a specific area, use `--selector` to specify a CSS selector
4. Execute the script and return the results to the user
5. If there is a lot of content, generate a `--summary` summary for quick browsing

## Common Scenarios

### Scrape a Single Technical Documentation Page
```bash
python scripts/scrape.py "https://docs.python.org/3/library/json.html" -o "./python-json"
```

### Scrape Multiple Pages from a Documentation Site
```bash
python scripts/scrape.py "https://fastapi.tiangolo.com/" --depth 1 --max-pages 30 -o "./fastapi-docs" --summary
```

### Scrape a Page That Requires a Specific Area
```bash
python scripts/scrape.py "https://example.com" --selector "main" --exclude-selector "nav,.ads,.footer" -o "./result"
```

### Scrape Through a Proxy
```bash
python scripts/scrape.py "URL" --proxy "http://127.0.0.1:7890" -o "./result"
```

### Scrape a Page and Download Images (Images in MD Can Be Previewed Offline)
```bash
python scripts/scrape.py "https://example.com/article" --download-images -o "./result"
# Output directory structure:
# result/
# |-- Article_Title.md      # Image links point to images/xxx.png (relative paths)
# `-- images/
#     |-- hero.png
#     `-- diagram.webp
```

### Scrape Anti-scraping Websites (curl_cffi Fingerprint Impersonation)
```bash
# Use the latest bundled Chrome TLS fingerprint to bypass anti-scraping detection
python scripts/scrape.py "URL" --impersonate chrome -o "./result"

# Optional pinned fingerprints: chrome146, chrome145, chrome142, chrome136, chrome131, safari260, safari184, firefox147, edge101, etc.
```

## Troubleshooting

| Problem | Solution |
|------|----------|
| Garbled encoding | Use `--encoding utf-8` to force the encoding |
| Rate limited by the target site | Increase the `--delay` value (for example `--delay 2`) |
| Suspected verification page or blank page returned | Check the `[WARN]` hints in the terminal; preferably provide login cookies or a proxy, and switch to a browser-rendering solution if necessary |
| HTTP 404/410 returned | The URL is likely invalid or the content was removed. If a normal browser shows the same not-found page, report the source as unavailable instead of retrying fingerprints |
| HTTP 401/403 returned | Authentication, permission, region, or anti-bot restrictions may apply. If a normal browser can access the real page, retry with cookies/proxy/browser rendering; if the browser also shows an error or not-found page, report it as unavailable |
| Scraped content is empty | Use `--selector` to manually specify the body content area |
| SPA returns only a loading shell | The script automatically tries structured data recovery (`__NEXT_DATA__`, RSC flight data, `page-data.json`, Nuxt payloads, Remix/React Router loader data, SvelteKit data, Angular TransferState, Qwik JSON, page Markdown, Pagefind bodies, search indexes, same-origin JS bundle API discovery, `llms.txt`, OpenAPI specs, etc.) when the extracted body is too short; if it still fails, use agent-browser/Playwright as the final fallback |
| Hash-router SPA child pages are missing | Crawl discovery preserves route fragments such as `#/docs/page` and `#!/docs/page`; ordinary anchors like `#intro` are still collapsed for de-duplication |
| Sitemap mode finds no child pages | The script falls back to scoped link crawling and prioritizes URLs under the same top-level path as the start page; increase `--max-pages` or set `--depth 1`/`--depth 2` for broader coverage |
| Output folder stays empty during a long multi-page crawl | Multi-page Markdown files are written incrementally as each page finishes. If only images appear first, the current page is still being scraped or image downloads are running before that page's Markdown is finalized |
| WeChat article has no section headings | Public-account articles are automatically extracted from `#js_content` and polished for visual headings; add `--include-images --download-images` flags to save inline images locally. |
| WeChat/remote images show placeholders in Markdown preview | Some CDNs block images embedded from localhost/file preview origins. Rerun with `--include-images --download-images` so Markdown uses local `images/...` paths. |
| Timeout | Increase `--timeout`, or check the network/proxy |
| Body content is a sidebar/related articles | trafilatura is available in the AgentVis runtime; if the warning still appears, use `--selector` to manually specify the body CSS selector or `--exclude-selector` to remove noisy areas |
| Code blocks become one line or only line numbers remain | The script fixes this automatically by default; if it is still abnormal, use `--selector article` to specify the body content area and retry |
| Page requires login or cookies | Prefer `--cookies-file cookies.json` (JSON dictionary) or `--cookies '{"name":"value"}'`; alternatively use `--headers '{"Cookie": "raw_string"}'` to paste the raw cookie string directly. **Note**: the server Set-Cookie is automatically maintained within the same run and does not need attention; **login-state cookies (sessionid, etc.) must be manually exported by the user from browser DevTools and provided to the Agent** |

## Helper Scripts

### sitemap_parser.py

An independent Sitemap parsing tool that can be used separately:

```bash
# Parse sitemap.xml and output a URL list
python scripts/sitemap_parser.py "https://example.com/sitemap.xml"

# Limit the count
python scripts/sitemap_parser.py "https://example.com/sitemap.xml" --max 50

# Output to a file
python scripts/sitemap_parser.py "https://example.com/sitemap.xml" --output urls.txt
```

## Dependencies

- **Python**: >= 3.11
- **Dependencies**: httpx, beautifulsoup4, lxml, chardet, tqdm, trafilatura
- **Optional**: curl_cffi (used for `--impersonate` anti-scraping mode, already in the runtime)
