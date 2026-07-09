import json
import sys
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup
import httpx


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = SKILL_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import scrape  # noqa: E402
import spa_extractors  # noqa: E402


LONG_PARAGRAPH = (
    "This page explains how the client application stores route content in "
    "structured hydration data so static scraping can recover the visible "
    "article without running a browser. The recovered body includes enough "
    "plain text to pass the structured-content threshold and represent a real "
    "documentation page with useful details, examples, and implementation "
    "notes for downstream agents that need reliable Markdown output. "
)


class FakeResponse:
    def __init__(self, payload, status_code=200, url="https://example.com/", headers=None):
        self.status_code = status_code
        self.url = url
        self.headers = headers or {"content-type": "text/html; charset=utf-8"}
        self.encoding = "utf-8"
        if isinstance(payload, bytes):
            self.content = payload
        elif isinstance(payload, str):
            self.content = payload.encode("utf-8")
        else:
            self.content = json.dumps(payload).encode("utf-8")


class FakeClient:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def get(self, url, headers=None):
        self.requests.append((url, headers or {}))
        if url not in self.routes:
            return FakeResponse({}, status_code=404, url=url)
        payload = self.routes[url]
        if isinstance(payload, FakeResponse):
            return payload
        if isinstance(payload, tuple):
            body, status_code = payload
            return FakeResponse(body, status_code=status_code, url=url)
        return FakeResponse(payload, url=url)


class HashRouterUrlTests(unittest.TestCase):
    def test_normalize_preserves_hash_routes_but_drops_regular_anchors(self):
        self.assertEqual(
            scrape.normalize_crawl_url("https://example.com/docs/?utm_source=x#intro"),
            "https://example.com/docs",
        )
        self.assertEqual(
            scrape.normalize_crawl_url("https://example.com/#/docs/getting-started"),
            "https://example.com/#/docs/getting-started",
        )
        self.assertEqual(
            scrape.normalize_crawl_url("https://example.com/#!/docs/getting-started"),
            "https://example.com/#!/docs/getting-started",
        )

    def test_discover_links_keeps_hash_routes_and_skips_local_anchors(self):
        soup = BeautifulSoup(
            """
            <main>
              <a href="#intro">Intro anchor</a>
              <a href="#/docs/a">Hash route A</a>
              <a href="/#/docs/b">Hash route B</a>
              <a href="/docs/c#section">Regular page with anchor</a>
            </main>
            """,
            "lxml",
        )

        links = scrape.discover_links(soup, "https://example.com/app/")

        self.assertIn("https://example.com/app#/docs/a", links)
        self.assertIn("https://example.com/#/docs/b", links)
        self.assertIn("https://example.com/docs/c", links)
        self.assertNotIn("https://example.com/app/#intro", links)


class HttpObservationTests(unittest.TestCase):
    def test_404_observation_marks_page_unavailable_instead_of_fingerprint_retry(self):
        url = "https://example.com/missing"
        html = """
        <html>
          <head><title>Page not found</title></head>
          <body><h1>Sorry, we couldn't find the page you were looking for.</h1></body>
        </html>
        """
        client = FakeClient({url: (html, 404)})

        with self.assertRaises(httpx.HTTPStatusError) as caught:
            scrape.fetch_page(client, url)

        message = str(caught.exception)
        self.assertIn("HTTP 404 Not Found", message)
        self.assertIn("does not exist", message)
        self.assertIn("removed or invalid", message)
        self.assertIn("do not retry alternate browser fingerprints", message)
        self.assertIn("Sorry, we couldn't find the page", message)

    def test_impersonate_aliases_align_user_agent_with_profile(self):
        chrome_ua = scrape._user_agent_for_impersonate(scrape.DEFAULT_USER_AGENT, "chrome")
        pinned_chrome_ua = scrape._user_agent_for_impersonate(scrape.DEFAULT_USER_AGENT, "chrome146")
        firefox_ua = scrape._user_agent_for_impersonate(scrape.DEFAULT_USER_AGENT, "firefox")
        safari_ua = scrape._user_agent_for_impersonate(scrape.DEFAULT_USER_AGENT, "safari")

        self.assertIn("Chrome/146.0.0.0", chrome_ua)
        self.assertIn("Chrome/146.0.0.0", pinned_chrome_ua)
        self.assertIn("Firefox/147.0", firefox_ua)
        self.assertIn("Version/26.0 Safari", safari_ua)


class StructuredSpaRecoveryTests(unittest.TestCase):
    def recover(self, html, client=None, url="https://example.com/docs/page"):
        return spa_extractors.try_structured_spa_source(client or FakeClient({}), html, url)

    def test_recovers_remix_hydration_loader_data(self):
        payload = {
            "state": {
                "loaderData": {
                    "routes/docs": {
                        "title": "Remix Route",
                        "content": LONG_PARAGRAPH * 3,
                    }
                }
            }
        }
        html = f"<div id=\"root\"></div><script>window.__remixContext = {json.dumps(payload)};</script>"

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "remix-hydration")
        self.assertIn("# Remix Route", result.markdown)
        self.assertIn("structured hydration data", result.markdown)

    def test_recovers_sveltekit_inline_data(self):
        body = {"title": "Route Data", "content": LONG_PARAGRAPH * 3}
        payload = {"status": 200, "body": json.dumps(body)}
        html = (
            "<script type=\"application/json\" data-sveltekit-fetched>"
            + json.dumps(payload)
            + "</script>"
        )

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "sveltekit-data")
        self.assertIn("# Route Data", result.markdown)

    def test_recovers_angular_transfer_state(self):
        payload = {"route": {"title": "Angular State", "content": LONG_PARAGRAPH * 3}}
        html = f"<script id=\"ng-state\" type=\"application/json\">{json.dumps(payload)}</script>"

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "angular-transfer-state")
        self.assertIn("# Angular State", result.markdown)

    def test_recovers_qwik_json(self):
        payload = {"objs": [{"title": "Qwik JSON", "content": LONG_PARAGRAPH * 3}]}
        html = (
            "<div q:container></div>"
            f"<script type=\"qwik/json\">{json.dumps(payload)}</script>"
        )

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "qwik-json")
        self.assertIn("# Qwik JSON", result.markdown)

    def test_recovers_json_api_discovered_from_same_origin_bundle(self):
        routes = {
            "https://example.com/assets/main.js": 'fetch("/api/content/js-bundle-page.json")',
            "https://example.com/api/content/js-bundle-page.json": {
                "title": "Bundle API",
                "content": LONG_PARAGRAPH * 3,
            },
        }
        html = '<div id="root"></div><script src="/assets/main.js"></script>'

        result = self.recover(html, FakeClient(routes), "https://example.com/docs/js-bundle-page")

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "js-bundle-api")
        self.assertIn("# Bundle API", result.markdown)

    def test_js_bundle_api_discovery_skips_non_content_actions(self):
        self.assertFalse(
            spa_extractors._is_probable_content_api_url(
                "https://example.com/api/logout",
                "https://example.com/docs/page",
            )
        )
        self.assertFalse(
            spa_extractors._is_probable_content_api_url(
                "https://example.com/api/cart/update",
                "https://example.com/docs/page",
            )
        )
        self.assertTrue(
            spa_extractors._is_probable_content_api_url(
                "https://example.com/api/content/page.json",
                "https://example.com/docs/page",
            )
        )


class ExistingStrategyRegressionTests(unittest.TestCase):
    def recover(self, html, client=None, url="https://example.com/docs/page"):
        return spa_extractors.try_structured_spa_source(client or FakeClient({}), html, url)

    def test_existing_nextjs_data_adapter_still_wins(self):
        payload = {
            "props": {
                "pageProps": {
                    "title": "Next Data",
                    "content": LONG_PARAGRAPH * 3,
                }
            }
        }
        html = (
            "<div id=\"__next\"></div>"
            f"<script id=\"__NEXT_DATA__\" type=\"application/json\">{json.dumps(payload)}</script>"
        )

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "nextjs-data")
        self.assertIn("# Next Data", result.markdown)

    def test_existing_nuxt_payload_adapter_still_wins(self):
        payload = {"title": "Nuxt Payload", "content": LONG_PARAGRAPH * 3}
        html = f"<script id=\"__NUXT_DATA__\" type=\"application/json\">{json.dumps(payload)}</script>"

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "nuxt-payload")
        self.assertIn("# Nuxt Payload", result.markdown)

    def test_existing_vitepress_region_adapter_still_wins(self):
        html = (
            "<html><body class=\"vitepress\">"
            "<main class=\"VPContent\"><article class=\"vp-doc\">"
            "<h1>VitePress Region</h1>"
            f"<p>{LONG_PARAGRAPH * 3}</p>"
            "</article></main></body></html>"
        )

        result = self.recover(html)

        self.assertIsNotNone(result)
        self.assertEqual(result.adapter, "vitepress-vuepress")
        self.assertIn("# VitePress Region", result.markdown)


class IncrementalSaveTests(unittest.TestCase):
    def test_save_incremental_page_result_writes_numbered_markdown_immediately(self):
        result = {
            "title": "Incremental Page",
            "url": "https://example.com/docs/incremental",
            "metadata": {
                "title": "Incremental Page",
                "url": "https://example.com/docs/incremental",
            },
            "content_md": "Incremental content body.",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            filepath = scrape.save_incremental_page_result(result, tmpdir, 7)
            path = Path(filepath)

            self.assertEqual(path.name, "page_007.md")
            self.assertTrue(path.exists())
            self.assertFalse(path.with_suffix(path.suffix + ".tmp").exists())
            content = path.read_text(encoding="utf-8")
            self.assertIn('title: "Incremental Page"', content)
            self.assertIn("Incremental content body.", content)


if __name__ == "__main__":
    unittest.main()
