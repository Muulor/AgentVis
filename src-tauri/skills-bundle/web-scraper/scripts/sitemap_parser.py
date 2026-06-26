"""
Sitemap Parser - Sitemap parsing helper tool

Independent sitemap.xml parsing script that can be used separately.
Supports sitemap.xml and sitemap_index.xml (recursively parses child sitemaps).

Dependencies: httpx, lxml (both are in runtime-requirements-v1.txt)

Usage:
    python sitemap_parser.py "https://example.com/sitemap.xml"
    python sitemap_parser.py "https://example.com/sitemap.xml" --max 50
    python sitemap_parser.py "https://example.com/sitemap.xml" --output urls.txt
"""

import argparse
import os
import sys

import httpx
from lxml import etree


# Sitemap XML namespace
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

# Default User-Agent
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def default_proxy_from_env() -> str | None:
    """Return the AgentVis broker proxy (or a standard proxy env) when present."""
    for key in (
        "AGENTVIS_NETWORK_PROXY_URL",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ):
        value = os.environ.get(key)
        if value:
            return value
    return None


def fetch_xml(client: httpx.Client, url: str) -> bytes:
    """Fetch XML content."""
    response = client.get(url)
    response.raise_for_status()
    return response.content


def parse_sitemap(client: httpx.Client, sitemap_url: str, max_urls: int = 0) -> list[str]:
    """
    Parse sitemap.xml and return a URL list.

    Automatically determines whether it is a sitemap index or a regular sitemap,
    and recursively parses child sitemaps in a sitemap index.
    """
    try:
        xml_content = fetch_xml(client, sitemap_url)
        root = etree.fromstring(xml_content)
    except etree.XMLSyntaxError as e:
        print(f"XML parse error: {e}", file=sys.stderr)
        return []
    except httpx.HTTPStatusError as e:
        print(f"HTTP error {e.response.status_code}: {sitemap_url}", file=sys.stderr)
        return []

    urls: list[str] = []

    # Check whether this is a sitemap index (contains <sitemap> elements)
    sub_sitemaps = root.findall(".//sm:sitemap/sm:loc", SITEMAP_NS)
    if sub_sitemaps:
        print(f"Found sitemap index containing {len(sub_sitemaps)} child sitemaps")
        for loc_elem in sub_sitemaps:
            if loc_elem.text:
                sub_url = loc_elem.text.strip()
                print(f"  Parsing child sitemap: {sub_url}")
                sub_urls = _parse_single_sitemap(client, sub_url)
                urls.extend(sub_urls)

                # Early termination check
                if 0 < max_urls <= len(urls):
                    urls = urls[:max_urls]
                    break
    else:
        # Regular sitemap
        urls = _parse_single_sitemap(client, sitemap_url, root=root)

    if 0 < max_urls < len(urls):
        urls = urls[:max_urls]

    return urls


def _parse_single_sitemap(
    client: httpx.Client,
    sitemap_url: str,
    root: etree._Element | None = None,
) -> list[str]:
    """Parse the URL list in a single sitemap XML file."""
    if root is None:
        try:
            xml_content = fetch_xml(client, sitemap_url)
            root = etree.fromstring(xml_content)
        except Exception as e:
            print(f"  [WARN] Parse failed {sitemap_url}: {e}", file=sys.stderr)
            return []

    urls: list[str] = []
    for loc_elem in root.findall(".//sm:url/sm:loc", SITEMAP_NS):
        if loc_elem.text:
            urls.append(loc_elem.text.strip())

    return urls


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sitemap Parser - parse sitemap.xml and output a URL list",
    )
    parser.add_argument("url", help="URL of sitemap.xml")
    parser.add_argument("--max", type=int, default=0, help="Maximum number of URLs (0 = unlimited)")
    parser.add_argument("--output", help="Output file path (prints to console if not specified)")
    parser.add_argument("--timeout", type=float, default=15.0, help="Request timeout in seconds")

    args = parser.parse_args()

    client = httpx.Client(
        timeout=args.timeout,
        headers={"User-Agent": DEFAULT_USER_AGENT},
        proxy=default_proxy_from_env(),
        follow_redirects=True,
    )

    try:
        print(f"Parsing: {args.url}")
        urls = parse_sitemap(client, args.url, max_urls=args.max)

        if not urls:
            print("No URLs found")
            sys.exit(1)

        print(f"\nFound {len(urls)} URLs")

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                for url in urls:
                    f.write(url + "\n")
            print(f"Saved to: {args.output}")
        else:
            print("\nURL list:")
            for idx, url in enumerate(urls, 1):
                print(f"  {idx}. {url}")

    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
    finally:
        client.close()


if __name__ == "__main__":
    main()
