"""
SPA structured-content recovery helpers for scrape.py.

These adapters are intentionally kept separate from the HTML extraction path:
scrape.py should stay responsible for network setup, body extraction, Markdown
post-processing, and output. This module only tries to recover content from
structured data sources when a SPA page returns a sparse HTML shell.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import unescape
import json
import re
import shutil
import subprocess
from urllib.parse import unquote, urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup, NavigableString, Tag


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

SPARSE_CONTENT_MIN_LENGTH = 800
RECOVERED_CONTENT_MIN_LENGTH = 200


@dataclass
class StructuredSpaContent:
    """Recovered Markdown content from a structured SPA data source."""

    markdown: str
    metadata: dict[str, str]
    source_url: str
    adapter: str


def is_sparse_content(content_md: str) -> bool:
    """Return True when HTML extraction likely captured only an app shell."""
    return len(content_md.strip()) < SPARSE_CONTENT_MIN_LENGTH


def _has_recovered_content(content_md: str) -> bool:
    return len(content_md.strip()) >= RECOVERED_CONTENT_MIN_LENGTH


def try_structured_spa_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    """
    Try known SPA structured-data adapters.

    The order is intentionally conservative: use narrow, high-confidence
    adapters first. Generic JSON-to-Markdown adapters can be added later, but
    should only run after framework-specific sources fail.
    """
    adapters = (
        _try_nextjs_notion_doc_source,
        _try_nextjs_data_source,
        _try_nextjs_flight_source,
        _try_gatsby_page_data_source,
        _try_nuxt_payload_source,
        _try_remix_hydration_source,
        _try_sveltekit_source,
        _try_angular_transfer_state_source,
        _try_qwik_json_source,
        _try_page_markdown_source,
        _try_vitepress_vuepress_source,
        _try_pagefind_source,
        _try_search_index_source,
        _try_openapi_source,
        _try_llms_text_source,
        _try_doc_platform_manifest_source,
        _try_algolia_docsearch_source,
        _try_js_bundle_api_source,
        _try_dehydrated_state_source,
    )

    for adapter in adapters:
        result = adapter(client, html_text, page_url, forced_encoding)
        if result and _has_recovered_content(result.markdown):
            print(
                f"  [{result.adapter}] Recovered SPA content from structured API: "
                f"{result.source_url}"
            )
            return result

    return None


def _json_payload_to_structured_content(
    payload: object,
    page_url: str,
    source_url: str,
    adapter: str,
) -> StructuredSpaContent | None:
    converted = _structured_json_to_markdown(payload, page_url)
    if not converted:
        return None

    markdown, metadata = converted
    return StructuredSpaContent(
        markdown=markdown,
        metadata=metadata,
        source_url=source_url,
        adapter=adapter,
    )


def _structured_json_to_markdown(payload: object, base_url: str) -> tuple[str, dict[str, str]] | None:
    title = _find_title_in_json(payload)
    candidate = _best_json_content_candidate(payload)

    if not candidate:
        return None

    markdown = _content_string_to_markdown(candidate, base_url)
    if not markdown or not _has_recovered_content(markdown):
        return None

    if title and not _markdown_starts_with_title(markdown, title):
        markdown = f"# {title}\n\n{markdown}"

    return markdown.strip(), {"title": title} if title else {}


def _find_title_in_json(payload: object) -> str:
    best: tuple[int, str] | None = None

    def visit(value: object, path: tuple[str, ...]) -> None:
        nonlocal best
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, (*path, str(key)))
            return
        if isinstance(value, list):
            for index, child in enumerate(value[:100]):
                visit(child, (*path, str(index)))
            return
        if not isinstance(value, str):
            return

        text = _clean_inline_text(value)
        if not text or len(text) > 180:
            return

        path_text = ".".join(path).lower()
        score = 0
        if path_text.endswith("title"):
            score += 40
        if "frontmatter.title" in path_text or "seo.title" in path_text:
            score += 30
        if path_text.endswith("name"):
            score += 8
        if score and (best is None or score > best[0]):
            best = (score, text)

    visit(payload, ())
    return best[1] if best else ""


def _best_json_content_candidate(payload: object) -> str:
    candidates: list[tuple[int, str]] = []

    def visit(value: object, path: tuple[str, ...]) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, (*path, str(key)))
            return
        if isinstance(value, list):
            if _looks_like_text_block_list(value):
                text = _render_text_block_list(value)
                score = _score_json_content_string(text, (*path, "blocks"))
                if score > 0:
                    candidates.append((score + 25, text))
            for index, child in enumerate(value[:500]):
                visit(child, (*path, str(index)))
            return
        if not isinstance(value, str):
            return

        parsed_json = _parse_json_string(value)
        if parsed_json is not None:
            visit(parsed_json, (*path, "json"))
            return

        score = _score_json_content_string(value, path)
        if score > 0:
            candidates.append((score, value))

    visit(payload, ())
    if not candidates:
        return ""

    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _looks_like_text_block_list(value: list) -> bool:
    if len(value) < 2:
        return False
    sample = [item for item in value[:30] if isinstance(item, dict)]
    if len(sample) < 2:
        return False
    text_keys = {"text", "content", "value", "children", "title"}
    type_keys = {"type", "tag", "nodeType"}
    return any(text_keys & set(item.keys()) for item in sample) and any(
        type_keys & set(item.keys()) for item in sample
    )


def _render_text_block_list(value: list) -> str:
    lines: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        block_type = str(item.get("type") or item.get("tag") or item.get("nodeType") or "").lower()
        text = _block_dict_text(item)
        if not text:
            continue
        if block_type in ("h1", "heading1", "heading-1"):
            lines.extend(["", f"# {text}", ""])
        elif block_type in ("h2", "heading2", "heading-2"):
            lines.extend(["", f"## {text}", ""])
        elif block_type in ("h3", "heading3", "heading-3"):
            lines.extend(["", f"### {text}", ""])
        elif "list" in block_type:
            lines.append(f"- {text}")
        elif block_type in ("code", "pre"):
            lines.extend(["", "```", text, "```", ""])
        else:
            lines.extend(["", text, ""])
    return _normalize_markdown("\n".join(lines))


def _block_dict_text(item: dict) -> str:
    for key in ("text", "content", "value", "title"):
        value = item.get(key)
        if isinstance(value, str):
            return _clean_inline_text(value)
    children = item.get("children")
    if isinstance(children, list):
        return _clean_inline_text(" ".join(_block_dict_text(child) for child in children if isinstance(child, dict)))
    return ""


def _score_json_content_string(value: str, path: tuple[str, ...]) -> int:
    text = value.strip()
    if len(text) < 250:
        return 0

    lower = text[:2000].lower()
    path_text = ".".join(path).lower()

    if _looks_like_json_blob(text):
        return 0
    if _looks_like_compiled_code(text):
        return 0
    if text.count("{") > 30 and text.count(";") > 30 and ("function " in lower or "_jsx" in lower):
        return 0

    score = min(len(text) // 80, 80)
    if any(key in path_text for key in ("markdown", "mdx", "body", "content", "html", "article", "text")):
        score += 40
    if any(key in path_text for key in ("description", "overview", "excerpt")):
        score += 15
    if _looks_like_html_fragment(text):
        score += 35
    if _looks_like_markdown(text):
        score += 35
    if "\n" in text:
        score += 8
    if any(noisy in path_text for noisy in ("script", "style", "css", "image", "base64", "chunk", "manifest")):
        score -= 50
    return max(score, 0)


def _parse_json_string(text: str) -> object | None:
    stripped = text.strip()
    if len(stripped) < 50 or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def _looks_like_json_blob(text: str) -> bool:
    return _parse_json_string(text) is not None


def _looks_like_compiled_code(text: str) -> bool:
    sample = text[:5000]
    code_markers = (
        "function _extends",
        "Object.defineProperty",
        "/* @jsxRuntime",
        "_jsx(",
        "_jsxs(",
        "webpackJsonp",
        "module.exports",
    )
    return any(marker in sample for marker in code_markers)


def _looks_like_html_fragment(text: str) -> bool:
    return bool(re.search(r"</?(?:article|section|h[1-6]|p|ul|ol|li|pre|table|blockquote|div|span|a)\b", text, re.I))


def _looks_like_markdown(text: str) -> bool:
    return bool(
        re.search(r"(?m)^#{1,6}\s+\S", text)
        or re.search(r"(?m)^```", text)
        or re.search(r"(?m)^\s*[-*+]\s+\S", text)
        or re.search(r"(?m)^\|.+\|$", text)
    )


def _content_string_to_markdown(text: str, base_url: str) -> str:
    text = unescape(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if _looks_like_html_fragment(text):
        return _html_fragment_to_markdown(text, base_url)
    return _normalize_markdown(text)


def _html_fragment_to_markdown(html_text: str, base_url: str) -> str:
    soup = BeautifulSoup(html_text, "lxml")
    root = soup.body or soup
    lines: list[str] = []
    _render_html_children(root, lines, base_url)
    return _normalize_markdown("\n".join(lines))


def _render_html_children(node: Tag, lines: list[str], base_url: str) -> None:
    for child in node.children:
        if isinstance(child, NavigableString):
            text = _clean_inline_text(str(child))
            if text:
                lines.extend(["", text, ""])
            continue
        if not isinstance(child, Tag):
            continue
        _render_html_node(child, lines, base_url)


def _render_html_node(node: Tag, lines: list[str], base_url: str) -> None:
    name = node.name.lower()
    if name in ("script", "style", "noscript"):
        return
    if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
        text = _render_html_inline(node, base_url)
        if text:
            lines.extend(["", f"{'#' * int(name[1])} {text}", ""])
    elif name in ("p", "figcaption"):
        text = _render_html_inline(node, base_url)
        if text:
            lines.extend(["", text, ""])
    elif name == "pre":
        code = node.get_text("\n").strip("\n")
        if code:
            lines.extend(["", "```", code, "```", ""])
    elif name in ("ul", "ol"):
        ordered = name == "ol"
        for index, li in enumerate(node.find_all("li", recursive=False), 1):
            text = _render_html_inline(li, base_url)
            marker = f"{index}." if ordered else "-"
            if text:
                lines.append(f"{marker} {text}")
    elif name == "blockquote":
        text = _render_html_inline(node, base_url)
        if text:
            lines.extend(["", *[f"> {line}" for line in text.splitlines()], ""])
    elif name == "table":
        table_md = _html_table_to_markdown(node, base_url)
        if table_md:
            lines.extend(["", table_md, ""])
    elif name == "img":
        src = str(node.get("src", "")).strip()
        if src:
            alt = str(node.get("alt", "")).strip()
            lines.extend(["", f"![{alt}]({urljoin(base_url, src)})", ""])
    else:
        _render_html_children(node, lines, base_url)


def _render_html_inline(node: Tag | NavigableString, base_url: str) -> str:
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""

    name = node.name.lower()
    if name == "br":
        return "\n"
    if name == "code":
        return _inline_code(node.get_text())
    if name in ("strong", "b"):
        text = _clean_inline_text("".join(_render_html_inline(child, base_url) for child in node.children))
        return f"**{text}**" if text else ""
    if name in ("em", "i"):
        text = _clean_inline_text("".join(_render_html_inline(child, base_url) for child in node.children))
        return f"*{text}*" if text else ""
    if name == "a":
        text = _clean_inline_text("".join(_render_html_inline(child, base_url) for child in node.children))
        href = str(node.get("href", "")).strip()
        if text and href and not href.startswith("javascript:"):
            return f"[{_escape_markdown_link_text(text)}]({urljoin(base_url, href)})"
        return text
    if name == "img":
        src = str(node.get("src", "")).strip()
        alt = str(node.get("alt", "")).strip()
        return f"![{alt}]({urljoin(base_url, src)})" if src else ""
    return "".join(_render_html_inline(child, base_url) for child in node.children)


def _html_table_to_markdown(table: Tag, base_url: str) -> str:
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        cells = [
            _escape_markdown_table_cell(_render_html_inline(cell, base_url))
            for cell in tr.find_all(["th", "td"], recursive=False)
        ]
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    max_cols = max(len(row) for row in rows)
    rows = [row + [""] * (max_cols - len(row)) for row in rows]
    lines = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * max_cols) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def _normalize_markdown(markdown: str) -> str:
    markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return markdown.strip()


def _markdown_starts_with_title(markdown: str, title: str) -> bool:
    first = next((line.strip() for line in markdown.splitlines() if line.strip()), "")
    first = re.sub(r"^#{1,6}\s+", "", first)
    return _clean_inline_text(first).lower() == _clean_inline_text(title).lower()


def _try_llms_text_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    for llms_url in _llms_text_candidates(page_url):
        text = _fetch_text_or_none(client, llms_url, forced_encoding, referer=page_url)
        if not text:
            continue
        markdown = _normalize_markdown(text)
        if not _looks_like_markdown(markdown) or not _has_recovered_content(markdown):
            continue
        return StructuredSpaContent(
            markdown=markdown,
            metadata={"title": _markdown_first_heading(markdown) or "LLMS"},
            source_url=llms_url,
            adapter="llms-txt",
        )
    return None


def _llms_text_candidates(page_url: str) -> list[str]:
    parsed = urlparse(page_url)
    root = urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))
    candidates = [
        urljoin(root, "llms-full.txt"),
        urljoin(root, "llms.txt"),
    ]
    return _unique_preserve_order(candidates)


def _markdown_first_heading(markdown: str) -> str:
    for line in markdown.splitlines():
        match = re.match(r"^#{1,6}\s+(.+)$", line.strip())
        if match:
            return _clean_inline_text(match.group(1))
    return ""


def _try_nextjs_notion_doc_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not _looks_like_nextjs_spa(html_text):
        return None

    for api_url in _nextjs_doc_api_candidates(page_url):
        record_map = _fetch_json_or_none(client, api_url, forced_encoding, referer=page_url)
        if not record_map:
            continue

        converted = _notion_record_map_to_markdown(record_map, page_url)
        if not converted:
            continue

        markdown, metadata = converted
        return StructuredSpaContent(
            markdown=markdown,
            metadata=metadata,
            source_url=api_url,
            adapter="nextjs",
        )

    return None


def _try_nextjs_data_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if "__NEXT_DATA__" not in html_text:
        return None

    payload = _extract_json_script_by_id(html_text, "__NEXT_DATA__")
    if payload is None:
        return None

    return _json_payload_to_structured_content(payload, page_url, page_url + "#__NEXT_DATA__", "nextjs-data")


def _try_nextjs_flight_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if "self.__next_f.push" not in html_text:
        return None

    markdown = _next_flight_to_markdown(html_text, page_url)
    if not markdown or not _has_recovered_content(markdown):
        return None

    return StructuredSpaContent(
        markdown=markdown,
        metadata={"title": _markdown_first_heading(markdown) or ""},
        source_url=page_url + "#self.__next_f",
        adapter="nextjs-flight",
    )


def _next_flight_to_markdown(html_text: str, base_url: str) -> str:
    payloads = _extract_next_flight_payload_texts(html_text)
    if not payloads:
        return ""

    blocks: list[str] = []
    seen: set[str] = set()

    for payload in payloads:
        for line in payload.splitlines():
            value = _next_flight_line_value(line)
            if value is None:
                continue
            rendered = _render_rsc_value(value, base_url)
            rendered = _normalize_markdown(rendered)
            if not rendered or len(rendered) < 8:
                continue
            key = re.sub(r"\s+", " ", rendered).strip().lower()
            if key in seen or _is_noisy_rsc_text(rendered):
                continue
            seen.add(key)
            blocks.append(rendered)

    markdown = _normalize_markdown("\n\n".join(blocks))
    if _visible_word_count(markdown) < 40:
        return ""
    return markdown


def _extract_next_flight_payload_texts(html_text: str) -> list[str]:
    soup = BeautifulSoup(html_text, "lxml")
    payloads: list[str] = []
    for script in soup.find_all("script"):
        text = script.string or script.get_text()
        if not text or "self.__next_f.push" not in text:
            continue
        index = 0
        marker = "self.__next_f.push("
        while True:
            start = text.find(marker, index)
            if start < 0:
                break
            raw = _extract_balanced_json_at(text, start + len(marker))
            if not raw:
                index = start + len(marker)
                continue
            index = start + len(marker) + len(raw)
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(value, list):
                payloads.extend(str(item) for item in value if isinstance(item, str))
    return payloads


def _next_flight_line_value(line: str) -> object | None:
    line = line.strip()
    if not line or ":" not in line:
        return None
    _, raw = line.split(":", 1)
    raw = raw.strip()
    if not raw or raw[0] not in "[{\"":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _render_rsc_value(value: object, base_url: str) -> str:
    if isinstance(value, str):
        return _clean_inline_text(value) if _is_visible_rsc_text(value) else ""
    if isinstance(value, dict):
        if "children" in value:
            return _render_rsc_value(value["children"], base_url)
        parts: list[str] = []
        for key in ("title", "description", "content", "text"):
            child = value.get(key)
            if isinstance(child, (str, list, dict)):
                rendered = _render_rsc_value(child, base_url)
                if rendered:
                    parts.append(rendered)
        return _normalize_markdown("\n\n".join(parts))
    if isinstance(value, list):
        if len(value) >= 4 and value[0] == "$" and isinstance(value[1], str) and isinstance(value[3], dict):
            tag = value[1].lower()
            props = value[3]
            children = props.get("children")
            text = _render_rsc_value(children, base_url)
            if not text:
                return ""
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                return f"{'#' * int(tag[1])} {_clean_inline_text(text)}"
            if tag == "p":
                return _clean_inline_text(text)
            if tag == "li":
                return "- " + _clean_inline_text(text)
            if tag in ("pre", "code"):
                return f"```\n{text.strip()}\n```"
            if tag == "a":
                href = str(props.get("href") or "").strip()
                return f"[{_escape_markdown_link_text(_clean_inline_text(text))}]({urljoin(base_url, href)})" if href else text
            if tag in ("main", "article", "section", "div", "span", "strong", "em", "ul", "ol"):
                return text
            return text
        parts = [_render_rsc_value(item, base_url) for item in value]
        return _normalize_markdown("\n\n".join(part for part in parts if part))
    return ""


def _is_visible_rsc_text(text: str) -> bool:
    text = _clean_inline_text(text)
    if len(text) < 2:
        return False
    if text.startswith("$") or text.startswith("/_next/"):
        return False
    if re.fullmatch(r"[-_a-zA-Z0-9:/?&.=#%]+", text) and not re.search(r"\s", text):
        return False
    if any(fragment in text for fragment in ("static/chunks/", "webpack", "css", "className")):
        return False
    return True


def _is_noisy_rsc_text(text: str) -> bool:
    normalized = _clean_inline_text(text)
    if normalized.count("/") > 8 and " " not in normalized:
        return True
    if len(re.findall(r"\b[a-zA-Z0-9_-]{20,}\b", normalized)) >= 3:
        return True
    return False


def _visible_word_count(markdown: str) -> int:
    return len(re.findall(r"[\w\u4e00-\u9fff]+", markdown))


def _try_gatsby_page_data_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if "page-data" not in html_text and "___gatsby" not in html_text and "gatsby" not in html_text.lower():
        return None

    for data_url in _gatsby_page_data_candidates(page_url, html_text):
        payload = _fetch_json_or_none(client, data_url, forced_encoding, referer=page_url)
        if not payload:
            continue

        converted = _gatsby_page_data_to_markdown(payload, page_url)
        if converted:
            markdown, metadata = converted
            return StructuredSpaContent(markdown, metadata, data_url, "gatsby-page-data")

        generic = _json_payload_to_structured_content(payload, page_url, data_url, "gatsby-page-data")
        if generic:
            return generic

    return None


def _try_nuxt_payload_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if "__NUXT_DATA__" in html_text:
        payload = _extract_json_script_by_id(html_text, "__NUXT_DATA__")
        if payload is not None:
            converted = _nuxt_payload_to_markdown(payload, page_url)
            if converted:
                markdown, metadata = converted
                return StructuredSpaContent(markdown, metadata, page_url + "#__NUXT_DATA__", "nuxt-payload")
            generic = _json_payload_to_structured_content(payload, page_url, page_url + "#__NUXT_DATA__", "nuxt-payload")
            if generic:
                return generic

    if "_payload.json" not in html_text and "__NUXT" not in html_text:
        return None

    for payload_url in _nuxt_payload_candidates(page_url, html_text):
        payload = _fetch_json_or_none(client, payload_url, forced_encoding, referer=page_url)
        if not payload:
            continue
        converted = _nuxt_payload_to_markdown(payload, page_url)
        if converted:
            markdown, metadata = converted
            return StructuredSpaContent(markdown, metadata, payload_url, "nuxt-payload")
        generic = _json_payload_to_structured_content(payload, page_url, payload_url, "nuxt-payload")
        if generic:
            return generic

    return None


def _try_remix_hydration_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    markers = (
        "__remixContext",
        "__staticRouterHydrationData",
        "serverHandoffString",
        "loaderData",
    )
    if not any(marker in html_text for marker in markers):
        return None

    for payload, source_label in _extract_js_hydration_payloads(html_text, markers):
        generic = _json_payload_to_structured_content(
            payload,
            page_url,
            page_url + "#" + source_label,
            "remix-hydration",
        )
        if generic:
            return generic
    return None


def _try_sveltekit_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    sample = html_text[:300_000].lower()
    if "sveltekit" not in sample and "data-sveltekit-fetched" not in sample and "__data.json" not in sample:
        return None

    for payload, source_label in _extract_sveltekit_inline_payloads(html_text):
        generic = _json_payload_to_structured_content(
            payload,
            page_url,
            page_url + "#" + source_label,
            "sveltekit-data",
        )
        if generic:
            return generic

    for data_url in _sveltekit_data_candidates(page_url, html_text):
        payload = _fetch_json_or_none(client, data_url, forced_encoding, referer=page_url)
        if not payload:
            continue
        generic = _json_payload_to_structured_content(payload, page_url, data_url, "sveltekit-data")
        if generic:
            return generic
    return None


def _try_angular_transfer_state_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    sample = html_text[:300_000]
    markers = ("ng-state", "serverApp-state", "TRANSFER_STATE", "TransferState")
    if not any(marker in sample for marker in markers):
        return None

    for script_id in ("ng-state", "serverApp-state"):
        payload = _extract_json_script_by_id(html_text, script_id)
        if payload is None:
            continue
        generic = _json_payload_to_structured_content(
            payload,
            page_url,
            page_url + "#" + script_id,
            "angular-transfer-state",
        )
        if generic:
            return generic

    for payload, source_label in _extract_js_hydration_payloads(html_text, ("TRANSFER_STATE", "TransferState")):
        generic = _json_payload_to_structured_content(
            payload,
            page_url,
            page_url + "#" + source_label,
            "angular-transfer-state",
        )
        if generic:
            return generic
    return None


def _try_qwik_json_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    sample = html_text[:300_000].lower()
    if "qwik/json" not in sample and "q:container" not in sample and "q-data" not in sample:
        return None

    soup = BeautifulSoup(html_text, "lxml")
    for script in soup.find_all("script"):
        script_type = str(script.get("type") or "").lower()
        script_id = str(script.get("id") or "").lower()
        if "qwik/json" not in script_type and "qwik" not in script_id:
            continue
        raw = script.string or script.get_text()
        if not raw:
            continue
        try:
            payload = json.loads(unescape(raw))
        except json.JSONDecodeError:
            continue
        generic = _json_payload_to_structured_content(
            payload,
            page_url,
            page_url + "#qwik-json",
            "qwik-json",
        )
        if generic:
            return generic
    return None


def _extract_js_hydration_payloads(html_text: str, markers: tuple[str, ...]) -> list[tuple[object, str]]:
    payloads: list[tuple[object, str]] = []
    seen: set[str] = set()
    soup = BeautifulSoup(html_text, "lxml")

    for script in soup.find_all("script"):
        text = script.string or script.get_text()
        if not text:
            continue
        for marker in markers:
            search_index = 0
            while True:
                marker_index = text.find(marker, search_index)
                if marker_index < 0:
                    break
                search_index = marker_index + len(marker)

                payload = _json_parse_payload_near(text, marker_index)
                if payload is None:
                    payload = _direct_json_payload_after_marker(text, search_index)
                if payload is None:
                    continue

                key = _payload_dedupe_key(payload)
                if key in seen:
                    continue
                seen.add(key)
                payloads.append((payload, marker))

    return payloads


def _json_parse_payload_near(text: str, marker_index: int) -> object | None:
    parse_index = text.find("JSON.parse", marker_index, marker_index + 800)
    if parse_index < 0:
        return None

    open_paren = text.find("(", parse_index, parse_index + 80)
    if open_paren < 0:
        return None

    arg_index = _skip_spaces(text, open_paren + 1)
    if text.startswith("decodeURIComponent", arg_index):
        decode_paren = text.find("(", arg_index, arg_index + 120)
        if decode_paren < 0:
            return None
        extracted = _extract_js_string_at(text, decode_paren + 1)
        if not extracted:
            return None
        inner_text = unquote(extracted[0])
    else:
        extracted = _extract_js_string_at(text, arg_index)
        if not extracted:
            return None
        inner_text = extracted[0]

    try:
        return json.loads(inner_text)
    except json.JSONDecodeError:
        return None


def _direct_json_payload_after_marker(text: str, start_index: int) -> object | None:
    scan_end = min(len(text), start_index + 3000)
    for pos in range(start_index, scan_end):
        if text[pos] not in "[{":
            continue
        raw = _extract_balanced_json_at(text, pos)
        if not raw:
            continue
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            continue
    return None


def _extract_js_string_at(text: str, start_index: int) -> tuple[str, int] | None:
    index = _skip_spaces(text, start_index)
    if index >= len(text) or text[index] not in ("'", '"'):
        return None

    quote = text[index]
    escaped = False
    for pos in range(index + 1, len(text)):
        char = text[pos]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char != quote:
            continue

        raw = text[index:pos + 1]
        try:
            value = json.loads(raw) if quote == '"' else bytes(raw[1:-1], "utf-8").decode("unicode_escape")
        except Exception:
            return None
        return value, pos + 1
    return None


def _skip_spaces(text: str, index: int) -> int:
    while index < len(text) and text[index].isspace():
        index += 1
    return index


def _payload_dedupe_key(payload: object) -> str:
    try:
        return json.dumps(payload, sort_keys=True, ensure_ascii=False)[:4000]
    except TypeError:
        return repr(payload)[:4000]


def _extract_sveltekit_inline_payloads(html_text: str) -> list[tuple[object, str]]:
    payloads: list[tuple[object, str]] = []
    soup = BeautifulSoup(html_text, "lxml")

    for index, script in enumerate(soup.find_all("script")):
        raw = script.string or script.get_text()
        if not raw:
            continue

        attrs = " ".join(
            f"{key}={value}"
            for key, value in script.attrs.items()
        ).lower()
        text_sample = raw[:2000].lower()
        if "sveltekit" not in attrs and "sveltekit" not in text_sample and "data-sveltekit-fetched" not in attrs:
            continue

        try:
            payload = json.loads(unescape(raw))
        except json.JSONDecodeError:
            continue

        body = payload.get("body") if isinstance(payload, dict) else None
        if isinstance(body, str):
            parsed_body = _parse_json_string(body)
            if parsed_body is not None:
                payloads.append((parsed_body, f"sveltekit-fetched-{index}"))
                continue
        payloads.append((payload, f"sveltekit-inline-{index}"))

    return payloads


def _sveltekit_data_candidates(page_url: str, html_text: str) -> list[str]:
    candidates: list[str] = []
    for match in re.finditer(r'["\']([^"\']*?__data\.json[^"\']*)["\']', html_text):
        candidates.append(urljoin(page_url, match.group(1)))

    parsed = urlparse(page_url)
    path = parsed.path or "/"
    if path.endswith("/"):
        data_path = path + "__data.json"
    else:
        data_path = path.rstrip("/") + "/__data.json"
    candidates.append(urlunparse((parsed.scheme, parsed.netloc, data_path, "", "", "")))
    return _unique_preserve_order(candidates)


def _try_page_markdown_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    candidates = _page_markdown_candidates(html_text, page_url)
    for markdown_url in candidates:
        text = _fetch_text_or_none(client, markdown_url, forced_encoding, referer=page_url)
        if not text:
            continue
        markdown = _normalize_markdown(text)
        if not _looks_like_markdown(markdown) or not _has_recovered_content(markdown):
            continue
        return StructuredSpaContent(
            markdown=markdown,
            metadata={"title": _markdown_first_heading(markdown) or ""},
            source_url=markdown_url,
            adapter="page-markdown",
        )
    return None


def _page_markdown_candidates(html_text: str, page_url: str) -> list[str]:
    candidates: list[str] = []
    soup = BeautifulSoup(html_text, "lxml")
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "").strip()
        text = _clean_inline_text(link.get_text(" "))
        if not href.endswith(".md"):
            continue
        if text and not any(marker in text.lower() for marker in ("markdown", "llm", "source", ".md")):
            continue
        candidates.append(urljoin(page_url, href))

    parsed = urlparse(page_url)
    if parsed.path and not parsed.path.endswith(".md"):
        candidates.append(urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + ".md", "", "", "")))
    return _unique_preserve_order(candidates)


def _try_vitepress_vuepress_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    sample = html_text[:120_000].lower()
    if not any(marker in sample for marker in ("vitepress", "vp-doc", "vpcontent", "vuepress", "theme-default-content")):
        return None

    markdown = _extract_html_region_markdown(
        html_text,
        (
            ".VPDoc .content",
            ".vp-doc",
            ".VPContent",
            ".theme-default-content",
            "main",
        ),
        page_url,
    )
    if not _has_recovered_content(markdown):
        return None
    return StructuredSpaContent(
        markdown=markdown,
        metadata={"title": _markdown_first_heading(markdown) or ""},
        source_url=page_url + "#vitepress-vuepress",
        adapter="vitepress-vuepress",
    )


def _try_pagefind_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if "data-pagefind-body" not in html_text and "pagefind" not in html_text.lower():
        return None

    markdown = _extract_html_region_markdown(
        html_text,
        ("[data-pagefind-body]", "main"),
        page_url,
    )
    if not _has_recovered_content(markdown):
        return None
    return StructuredSpaContent(
        markdown=markdown,
        metadata={"title": _markdown_first_heading(markdown) or ""},
        source_url=page_url + "#pagefind-body",
        adapter="pagefind-body",
    )


def _extract_html_region_markdown(html_text: str, selectors: tuple[str, ...], base_url: str) -> str:
    soup = BeautifulSoup(html_text, "lxml")
    for selector in selectors:
        node = soup.select_one(selector)
        if not isinstance(node, Tag):
            continue
        for noisy in node.select("nav, aside, script, style, noscript, [data-pagefind-ignore]"):
            noisy.decompose()
        lines: list[str] = []
        _render_html_node(node, lines, base_url)
        markdown = _normalize_markdown("\n".join(lines))
        if _has_recovered_content(markdown):
            return markdown
    return ""


def _try_search_index_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not any(signal in html_text.lower() for signal in ("search_index.json", "search-index.json", "mkdocs", "docusaurus")):
        return None

    for index_url in _search_index_candidates(page_url, html_text):
        payload = _fetch_json_or_none(client, index_url, forced_encoding, referer=page_url)
        if not payload:
            continue

        converted = _search_index_to_markdown(payload, page_url)
        if converted:
            markdown, metadata = converted
            return StructuredSpaContent(markdown, metadata, index_url, "search-index")

    return None


def _try_doc_platform_manifest_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not any(marker in html_text.lower() for marker in ("gitbook", "mintlify", "fern", "readme", "redocly")):
        return None

    for manifest_url in _doc_platform_manifest_candidates(page_url, html_text):
        payload = _fetch_json_or_none(client, manifest_url, forced_encoding, referer=page_url)
        if not payload:
            continue
        if _looks_like_openapi_payload(payload):
            markdown, metadata = _openapi_to_markdown(payload)
            if _has_recovered_content(markdown):
                return StructuredSpaContent(markdown, metadata, manifest_url, "doc-platform")
        generic = _json_payload_to_structured_content(payload, page_url, manifest_url, "doc-platform")
        if generic:
            return generic
    return None


def _doc_platform_manifest_candidates(page_url: str, html_text: str) -> list[str]:
    candidates = _extract_openapi_urls(html_text, page_url)
    parsed = urlparse(page_url)
    root = urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))
    for path in (
        "llms.txt",
        "openapi.json",
        "swagger.json",
        "mint.json",
        "docs.json",
        "api-reference/openapi.json",
        "api-reference/swagger.json",
        "_next/static/chunks/pages/_app.js",
    ):
        candidates.append(urljoin(root, path))
    return _unique_preserve_order(candidates)


def _try_algolia_docsearch_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    config = _extract_algolia_docsearch_config(html_text)
    if not config:
        return None
    payload = _query_algolia_docsearch(config, page_url)
    if not payload:
        return None
    converted = _algolia_hits_to_markdown(payload, page_url)
    if not converted:
        return None
    markdown, metadata = converted
    return StructuredSpaContent(markdown, metadata, "algolia://" + config["indexName"], "algolia-docsearch")


def _extract_algolia_docsearch_config(html_text: str) -> dict[str, str] | None:
    sample = html_text[:300_000]
    if "algolia" not in sample.lower() and "docsearch" not in sample.lower():
        return None

    def pick(*names: str) -> str:
        for name in names:
            patterns = (
                rf'{name}\s*[:=]\s*["\']([^"\']+)["\']',
                rf'"{name}"\s*:\s*["\']([^"\']+)["\']',
            )
            for pattern in patterns:
                match = re.search(pattern, sample)
                if match:
                    return match.group(1)
        return ""

    app_id = pick("appId", "applicationID", "applicationId")
    api_key = pick("apiKey", "searchAPIKey", "searchApiKey")
    index_name = pick("indexName", "index_name")
    if not (app_id and api_key and index_name):
        return None
    return {"appId": app_id, "apiKey": api_key, "indexName": index_name}


def _query_algolia_docsearch(config: dict[str, str], page_url: str) -> dict | None:
    curl_path = shutil.which("curl") or shutil.which("curl.exe")
    if not curl_path:
        return None
    endpoint = f"https://{config['appId']}-dsn.algolia.net/1/indexes/{config['indexName']}/query"
    parsed = urlparse(page_url)
    query = parsed.path.strip("/").replace("-", " ").replace("/", " ")
    body = json.dumps({"query": query, "hitsPerPage": 8})
    command = [
        curl_path,
        "-L",
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-H",
        f"X-Algolia-Application-Id: {config['appId']}",
        "-H",
        f"X-Algolia-API-Key: {config['apiKey']}",
        "--data-binary",
        body,
        endpoint,
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=25,
        )
    except Exception:
        return None
    if completed.returncode != 0 or not completed.stdout:
        return None
    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _algolia_hits_to_markdown(payload: dict, page_url: str) -> tuple[str, dict[str, str]] | None:
    hits = payload.get("hits")
    if not isinstance(hits, list) or not hits:
        return None
    parts: list[str] = []
    title = ""
    parsed = urlparse(page_url)
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        url = str(hit.get("url") or hit.get("permalink") or "").strip()
        if url and parsed.netloc and parsed.netloc not in urlparse(urljoin(page_url, url)).netloc:
            continue
        hierarchy = hit.get("hierarchy") if isinstance(hit.get("hierarchy"), dict) else {}
        hit_title = _clean_inline_text(str(hit.get("title") or hierarchy.get("lvl0") or hierarchy.get("lvl1") or ""))
        content = _clean_inline_text(str(hit.get("content") or hit.get("text") or hit.get("description") or ""))
        if not hit_title and not content:
            continue
        if not title and hit_title:
            title = hit_title
            parts.extend([f"# {title}", ""])
        elif hit_title and hit_title != title:
            parts.extend([f"## {hit_title}", ""])
        if content:
            parts.extend([content, ""])
    markdown = _normalize_markdown("\n".join(parts))
    if not _has_recovered_content(markdown):
        return None
    return markdown, {"title": title} if title else {}


def _try_js_bundle_api_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not _looks_like_client_app_shell(html_text):
        return None

    candidates: list[str] = []
    for script_url in _same_origin_js_bundle_candidates(html_text, page_url)[:6]:
        script_text = _fetch_text_or_none(client, script_url, forced_encoding, referer=page_url)
        if not script_text or len(script_text) > 2_000_000:
            continue
        candidates.extend(_extract_content_api_urls_from_js(script_text, script_url, page_url))

    for api_url in _rank_api_url_candidates(_unique_preserve_order(candidates), page_url)[:12]:
        payload = _fetch_json_or_none(client, api_url, forced_encoding, referer=page_url)
        if not payload:
            continue
        generic = _json_payload_to_structured_content(payload, page_url, api_url, "js-bundle-api")
        if generic:
            return generic
    return None


def _looks_like_client_app_shell(html_text: str) -> bool:
    sample = html_text[:300_000].lower()
    return any(
        marker in sample
        for marker in (
            'id="root"',
            "id='root'",
            'id="app"',
            "id='app'",
            "data-reactroot",
            "__vite",
            "vite",
            "webpack",
            "spa",
            "client-side",
        )
    )


def _same_origin_js_bundle_candidates(html_text: str, page_url: str) -> list[str]:
    soup = BeautifulSoup(html_text, "lxml")
    candidates: list[tuple[int, str]] = []
    for index, script in enumerate(soup.find_all("script", src=True)):
        src = str(script.get("src") or "").strip()
        if not src:
            continue
        script_url = urljoin(page_url, src)
        if not _is_same_origin(script_url, page_url):
            continue
        path_lower = urlparse(script_url).path.lower()
        if not path_lower.endswith(".js"):
            continue
        if any(noisy in path_lower for noisy in ("analytics", "gtag", "googletag", "facebook", "ads", "sentry")):
            continue
        score = 20
        if any(marker in path_lower for marker in ("app", "main", "route", "page", "entry", "bundle")):
            score += 20
        if any(marker in path_lower for marker in ("vendor", "polyfill", "runtime")):
            score -= 15
        candidates.append((max(score, 0) * 1000 - index, script_url))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return _unique_preserve_order([url for _score, url in candidates])


def _extract_content_api_urls_from_js(script_text: str, script_url: str, page_url: str) -> list[str]:
    candidates: list[str] = []
    patterns = (
        r'\bfetch\(\s*([`"\'])([^`"\']{1,500})\1',
        r'\b(?:axios\.(?:get|post)|get|post)\(\s*([`"\'])([^`"\']{1,500})\1',
        r'([`"\'])((?:https?://|/)[^`"\']{1,500}(?:api|content|article|articles|post|posts|page|pages|doc|docs|cms|data|\.json)[^`"\']*)\1',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, script_text, flags=re.I):
            raw_url = match.group(2).strip()
            if "${" in raw_url:
                continue
            absolute_url = urljoin(script_url, unescape(raw_url))
            if _is_probable_content_api_url(absolute_url, page_url):
                candidates.append(absolute_url)
    return _unique_preserve_order(candidates)


def _is_probable_content_api_url(candidate_url: str, page_url: str) -> bool:
    parsed = urlparse(candidate_url)
    if parsed.scheme not in ("http", "https") or not _is_same_origin(candidate_url, page_url):
        return False

    path_lower = parsed.path.lower()
    if not path_lower or path_lower == "/":
        return False
    static_extensions = (
        ".js",
        ".css",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".svg",
        ".webp",
        ".woff",
        ".woff2",
        ".map",
        ".mp4",
        ".mp3",
        ".pdf",
    )
    if any(path_lower.endswith(ext) for ext in static_extensions):
        return False
    non_content_markers = (
        "auth",
        "login",
        "logout",
        "delete",
        "remove",
        "update",
        "create",
        "checkout",
        "cart",
        "payment",
        "mutation",
    )
    if any(marker in path_lower for marker in non_content_markers):
        return False
    content_markers = (
        "/api/",
        "api-",
        "content",
        "article",
        "post",
        "page",
        "doc",
        "cms",
        "data",
        ".json",
    )
    return any(marker in path_lower for marker in content_markers)


def _rank_api_url_candidates(candidates: list[str], page_url: str) -> list[str]:
    page_tokens = {
        token.lower()
        for token in re.split(r"[^A-Za-z0-9]+", urlparse(page_url).path)
        if len(token) >= 3
    }

    scored: list[tuple[int, int, str]] = []
    for index, candidate in enumerate(candidates):
        path_lower = urlparse(candidate).path.lower()
        score = 0
        if "/api/" in path_lower:
            score += 20
        if path_lower.endswith(".json"):
            score += 15
        if any(marker in path_lower for marker in ("content", "article", "post", "page", "doc")):
            score += 12
        score += sum(8 for token in page_tokens if token in path_lower)
        scored.append((score, -index, candidate))

    scored.sort(reverse=True)
    return [candidate for _score, _index, candidate in scored]


def _is_same_origin(candidate_url: str, page_url: str) -> bool:
    candidate = urlparse(candidate_url)
    page = urlparse(page_url)
    return candidate.scheme.lower() == page.scheme.lower() and candidate.netloc.lower() == page.netloc.lower()


def _try_dehydrated_state_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not any(marker in html_text for marker in ("__APOLLO_STATE__", "__INITIAL_STATE__", "dehydratedState", "__REACT_QUERY_STATE__")):
        return None

    for payload, source_label in _extract_dehydrated_state_payloads(html_text):
        generic = _json_payload_to_structured_content(payload, page_url, page_url + "#" + source_label, "dehydrated-state")
        if generic:
            return generic
    return None


def _extract_dehydrated_state_payloads(html_text: str) -> list[tuple[object, str]]:
    payloads: list[tuple[object, str]] = []
    soup = BeautifulSoup(html_text, "lxml")
    for script_id in ("__APOLLO_STATE__", "__INITIAL_STATE__", "__REACT_QUERY_STATE__"):
        payload = _extract_json_script_by_id(html_text, script_id)
        if payload is not None:
            payloads.append((payload, script_id))

    markers = (
        ("window.__INITIAL_STATE__=", "__INITIAL_STATE__"),
        ("window.__APOLLO_STATE__=", "__APOLLO_STATE__"),
        ("window.__REACT_QUERY_STATE__=", "__REACT_QUERY_STATE__"),
        ("dehydratedState:", "dehydratedState"),
        ('"dehydratedState":', "dehydratedState"),
    )
    for script in soup.find_all("script"):
        text = script.string or script.get_text()
        if not text:
            continue
        for marker, label in markers:
            start = text.find(marker)
            if start < 0:
                continue
            raw = _extract_balanced_json_at(text, start + len(marker))
            if not raw:
                continue
            try:
                payloads.append((json.loads(raw), label))
            except json.JSONDecodeError:
                continue
    return payloads


def _extract_balanced_json_at(text: str, start_index: int) -> str | None:
    index = start_index
    while index < len(text) and text[index].isspace():
        index += 1
    if index >= len(text) or text[index] not in "[{":
        return None

    expected_closers: list[str] = []
    in_string = False
    escaped = False
    quote = ""
    for pos in range(index, len(text)):
        char = text[pos]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            continue
        if char in ("'", '"'):
            in_string = True
            quote = char
            continue
        if char in "[{":
            expected_closers.append("]" if char == "[" else "}")
        elif char in "]}":
            if not expected_closers or char != expected_closers[-1]:
                return None
            expected_closers.pop()
            if not expected_closers:
                return text[index:pos + 1]
    return None


def _try_openapi_source(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> StructuredSpaContent | None:
    if not any(signal in html_text.lower() for signal in ("swagger-ui", "swagger", "openapi", "redoc")):
        return None

    for spec_url in _openapi_spec_candidates(client, html_text, page_url, forced_encoding):
        payload = _fetch_json_or_none(client, spec_url, forced_encoding, referer=page_url)
        if not payload:
            continue

        markdown, metadata = _openapi_to_markdown(payload)
        if markdown:
            return StructuredSpaContent(markdown, metadata, spec_url, "openapi")

    return None


def _looks_like_openapi_payload(payload: object) -> bool:
    return isinstance(payload, dict) and (
        "openapi" in payload
        or "swagger" in payload
        or (isinstance(payload.get("paths"), dict) and isinstance(payload.get("info"), dict))
    )


def _extract_json_script_by_id(html_text: str, script_id: str) -> object | None:
    soup = BeautifulSoup(html_text, "lxml")
    script = soup.find("script", id=script_id)
    if not script:
        return None
    raw = script.string or script.get_text()
    if not raw:
        return None
    try:
        return json.loads(unescape(raw))
    except json.JSONDecodeError:
        return None


def _gatsby_page_data_candidates(page_url: str, html_text: str) -> list[str]:
    candidates: list[str] = []
    for match in re.finditer(r'["\']([^"\']*?/page-data/[^"\']+?page-data\.json)["\']', html_text):
        candidates.append(urljoin(page_url, match.group(1)))

    parsed = urlparse(page_url)
    path = parsed.path
    if not path.endswith("/"):
        path += "/"
    if path == "/":
        data_path = "/page-data/index/page-data.json"
    else:
        data_path = "/page-data" + path + "page-data.json"
    candidates.append(urlunparse((parsed.scheme, parsed.netloc, data_path, "", "", "")))
    return _unique_preserve_order(candidates)


def _gatsby_page_data_to_markdown(payload: dict, base_url: str) -> tuple[str, dict[str, str]] | None:
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        return None

    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    page_context = result.get("pageContext") if isinstance(result.get("pageContext"), dict) else {}

    mdx = data.get("mdx") if isinstance(data.get("mdx"), dict) else None
    if mdx:
        frontmatter = mdx.get("frontmatter") if isinstance(mdx.get("frontmatter"), dict) else {}
        title = _clean_inline_text(str(frontmatter.get("title") or ""))
        parts: list[str] = []
        if title:
            parts.extend([f"# {title}", ""])
        for key in ("description", "overview", "excerpt"):
            value = frontmatter.get(key) or mdx.get(key)
            if isinstance(value, str) and value.strip():
                parts.extend([_content_string_to_markdown(value, base_url), ""])
        toc = _render_table_of_contents(mdx.get("tableOfContents"))
        if toc:
            parts.extend(["## Table of Contents", "", toc, ""])
        body = mdx.get("body")
        if isinstance(body, str) and not _looks_like_compiled_code(body):
            parts.append(_content_string_to_markdown(body, base_url))
        markdown = _normalize_markdown("\n".join(parts))
        if _has_recovered_content(markdown):
            return markdown, {"title": title} if title else {}

    section = page_context.get("section") if isinstance(page_context.get("section"), dict) else None
    if section:
        return _gatsby_section_to_markdown(section, base_url)

    return None


def _gatsby_section_to_markdown(section: dict, base_url: str) -> tuple[str, dict[str, str]] | None:
    title = _clean_inline_text(str(section.get("title") or section.get("label") or ""))
    parts: list[str] = []
    if title:
        parts.extend([f"# {title}", ""])
    for key in ("shortDescription", "longDescription", "description"):
        value = section.get(key)
        if isinstance(value, str) and value.strip():
            parts.extend([_content_string_to_markdown(value, base_url), ""])
    sub_items = section.get("subItems")
    if isinstance(sub_items, list) and sub_items:
        parts.extend(["## Pages", ""])
        for item in sub_items:
            if not isinstance(item, dict):
                continue
            label = _clean_inline_text(str(item.get("label") or ""))
            href = str(item.get("to") or "").strip()
            desc = _clean_inline_text(str(item.get("description") or ""))
            if not label:
                continue
            link = f"[{_escape_markdown_link_text(label)}]({urljoin(base_url, href)})" if href else label
            parts.append(f"- {link}" + (f" - {desc}" if desc else ""))
    markdown = _normalize_markdown("\n".join(parts))
    if not _has_recovered_content(markdown):
        return None
    return markdown, {"title": title} if title else {}


def _render_table_of_contents(toc: object) -> str:
    if not isinstance(toc, dict):
        return ""

    def render_items(items: object, depth: int = 0) -> list[str]:
        if not isinstance(items, list):
            return []
        lines: list[str] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            title = _clean_inline_text(str(item.get("title") or ""))
            url = str(item.get("url") or "").strip()
            if title:
                indent = "  " * depth
                lines.append(f"{indent}- [{_escape_markdown_link_text(title)}]({url})" if url else f"{indent}- {title}")
            lines.extend(render_items(item.get("items"), depth + 1))
        return lines

    return "\n".join(render_items(toc.get("items")))


def _nuxt_payload_candidates(page_url: str, html_text: str) -> list[str]:
    candidates: list[str] = []
    for match in re.finditer(r'["\']([^"\']*?_payload\.json[^"\']*)["\']', html_text):
        candidates.append(urljoin(page_url, match.group(1)))

    parsed = urlparse(page_url)
    path = parsed.path
    if not path.endswith("/"):
        path += "/"
    candidates.append(urlunparse((parsed.scheme, parsed.netloc, path + "_payload.json", "", "", "")))
    return _unique_preserve_order(candidates)


def _nuxt_payload_to_markdown(payload: object, base_url: str) -> tuple[str, dict[str, str]] | None:
    resolved = _resolve_nuxt_payload(payload)
    minimark = _find_nuxt_minimark_body(resolved)
    if minimark:
        title = _find_title_in_json(resolved)
        markdown = _render_minimark_document(minimark, base_url)
        if title and not _markdown_starts_with_title(markdown, title):
            markdown = f"# {title}\n\n{markdown}"
        if _has_recovered_content(markdown):
            return markdown, {"title": title} if title else {}

    title = _find_title_in_json(payload)
    candidates = _nuxt_markdown_candidates(payload)
    if not candidates:
        return _structured_json_to_markdown(payload, base_url)
    candidates.sort(key=lambda item: item[0], reverse=True)
    markdown = _content_string_to_markdown(candidates[0][1], base_url)
    if title and not _markdown_starts_with_title(markdown, title):
        markdown = f"# {title}\n\n{markdown}"
    if not _has_recovered_content(markdown):
        return None
    return markdown, {"title": title} if title else {}


def _resolve_nuxt_payload(payload: object) -> object:
    if not isinstance(payload, list):
        return payload

    root = payload

    def resolve(value: object, depth: int = 0, stack: frozenset[int] = frozenset()) -> object:
        if depth > 80:
            return value
        if isinstance(value, int) and 0 <= value < len(root):
            if value in stack:
                return value
            return resolve(root[value], depth + 1, stack | {value})
        if isinstance(value, dict):
            return {key: resolve(child, depth + 1, stack) for key, child in value.items()}
        if isinstance(value, list):
            return [resolve(child, depth + 1, stack) for child in value]
        return value

    return resolve(0)


def _find_nuxt_minimark_body(payload: object) -> list | None:
    found: list | None = None

    def visit(value: object) -> None:
        nonlocal found
        if found is not None:
            return
        if isinstance(value, dict):
            if value.get("type") == "minimark" and isinstance(value.get("value"), list):
                found = value["value"]
                return
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return found


def _render_minimark_document(nodes: list, base_url: str) -> str:
    lines: list[str] = []
    for node in nodes:
        _render_minimark_block(node, lines, base_url)
    return _normalize_markdown("\n".join(lines))


def _render_minimark_block(node: object, lines: list[str], base_url: str, depth: int = 0) -> None:
    if isinstance(node, str):
        text = _clean_inline_text(node)
        if text:
            lines.extend(["", text, ""])
        return
    if not isinstance(node, list) or not node:
        return

    tag = str(node[0])
    attrs, children = _minimark_attrs_children(node)

    if re.fullmatch(r"h[1-6]", tag):
        text = _render_minimark_inline_children(children, base_url)
        if text:
            lines.extend(["", f"{'#' * int(tag[1])} {text}", ""])
    elif tag == "p":
        text = _render_minimark_inline_children(children, base_url)
        if text:
            lines.extend(["", text, ""])
    elif tag in ("ul", "ol"):
        ordered = tag == "ol"
        for index, child in enumerate(children, 1):
            if not isinstance(child, list):
                continue
            marker = f"{index}." if ordered else "-"
            text = _render_minimark_inline_children(_minimark_attrs_children(child)[1], base_url)
            if text:
                lines.append(f"{'  ' * depth}{marker} {text}")
    elif tag in ("blockquote", "tip", "warning", "note"):
        text = _render_minimark_inline_children(children, base_url)
        if text:
            lines.extend(["", *[f"> {line}" for line in text.splitlines()], ""])
    elif tag == "pre":
        text = _render_minimark_inline_children(children, base_url)
        if text:
            lines.extend(["", "```", text, "```", ""])
    elif tag == "read-more":
        title = _clean_inline_text(str(attrs.get("title") or "Read more"))
        href = str(attrs.get("to") or attrs.get("href") or "").strip()
        if href:
            lines.append(f"- [{_escape_markdown_link_text(title)}]({urljoin(base_url, href)})")
        else:
            lines.append(f"- {title}")
    else:
        text = _render_minimark_inline_children(children, base_url)
        if text:
            lines.extend(["", text, ""])


def _minimark_attrs_children(node: list) -> tuple[dict, list]:
    if len(node) > 1 and isinstance(node[1], dict):
        return node[1], node[2:]
    return {}, node[1:]


def _render_minimark_inline_children(children: list, base_url: str) -> str:
    return _clean_inline_text("".join(_render_minimark_inline(child, base_url) for child in children))


def _render_minimark_inline(node: object, base_url: str) -> str:
    if isinstance(node, str):
        return node
    if not isinstance(node, list) or not node:
        return ""

    tag = str(node[0])
    attrs, children = _minimark_attrs_children(node)
    text = "".join(_render_minimark_inline(child, base_url) for child in children)

    if tag == "a":
        href = str(attrs.get("href") or "").strip()
        return f"[{_escape_markdown_link_text(_clean_inline_text(text))}]({urljoin(base_url, href)})" if href else text
    if tag in ("strong", "b"):
        text = _clean_inline_text(text)
        return f"**{text}**" if text else ""
    if tag in ("em", "i"):
        text = _clean_inline_text(text)
        return f"*{text}*" if text else ""
    if tag == "code":
        return _inline_code(text)
    return text


def _nuxt_markdown_candidates(payload: object) -> list[tuple[int, str]]:
    candidates: list[tuple[int, str]] = []

    def visit(value: object, path: tuple[str, ...]) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, (*path, str(key)))
            return
        if isinstance(value, list):
            for index, child in enumerate(value[:1000]):
                visit(child, (*path, str(index)))
            return
        if isinstance(value, str):
            score = _score_json_content_string(value, path)
            path_text = ".".join(path).lower()
            if "body" in path_text or "description" in path_text:
                score += 20
            if score > 0:
                candidates.append((score, value))

    visit(payload, ())
    return candidates


def _search_index_candidates(page_url: str, html_text: str) -> list[str]:
    candidates: list[str] = []
    for match in re.finditer(r'["\']([^"\']*?(?:search[_-]index|search_index)\.json[^"\']*)["\']', html_text):
        candidates.append(urljoin(page_url, match.group(1)))

    parsed = urlparse(page_url)
    root = urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))
    current_dir = page_url if page_url.endswith("/") else page_url.rsplit("/", 1)[0] + "/"
    for base in (current_dir, root):
        for path in ("search/search_index.json", "search_index.json", "search-index.json"):
            candidates.append(urljoin(base, path))
    for path in ("../search/search_index.json", "../search_index.json", "../search-index.json"):
        candidates.append(urljoin(current_dir, path))
    return _unique_preserve_order(candidates)


def _search_index_to_markdown(payload: object, page_url: str) -> tuple[str, dict[str, str]] | None:
    docs = payload.get("docs") if isinstance(payload, dict) else None
    if not isinstance(docs, list):
        return None

    parsed = urlparse(page_url)
    current_path = parsed.path.lstrip("/")
    if current_path and not current_path.endswith("/"):
        current_path += "/"

    scored_docs: list[tuple[int, dict]] = []
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        location = str(doc.get("location") or "").split("#", 1)[0].lstrip("/")
        score = 0
        if location == current_path:
            score = 100
        elif location and (current_path.endswith(location) or location.endswith(current_path)):
            score = 60
        elif location and location in current_path:
            score = 30
        if score > 0:
            scored_docs.append((score, doc))

    if not scored_docs:
        return None

    best_score = max(score for score, _doc in scored_docs)
    matched_docs = [doc for score, doc in scored_docs if score == best_score]

    title_doc = next(
        (
            doc
            for doc in matched_docs
            if _clean_inline_text(str(doc.get("title") or "")) and not str(doc.get("text") or "").strip()
        ),
        matched_docs[0],
    )
    title = _clean_inline_text(str(title_doc.get("title") or "Untitled"))
    parts = [f"# {title}", ""]
    for index, doc in enumerate(matched_docs):
        doc_title = _clean_inline_text(str(doc.get("title") or ""))
        text = str(doc.get("text") or "")
        section_md = _content_string_to_markdown(text, page_url) if text else ""
        if not section_md and doc_title == title:
            continue
        if index > 0 and doc_title and doc_title != title:
            parts.extend([f"## {doc_title}", ""])
        if section_md:
            parts.extend([section_md, ""])

    markdown = _normalize_markdown("\n".join(parts))
    if not _has_recovered_content(markdown):
        return None
    return markdown, {"title": title}


def _openapi_spec_candidates(
    client: object,
    html_text: str,
    page_url: str,
    forced_encoding: str | None = None,
) -> list[str]:
    candidates = _extract_openapi_urls(html_text, page_url)
    soup = BeautifulSoup(html_text, "lxml")
    for script in soup.find_all("script", src=True):
        src = str(script.get("src") or "")
        if "swagger" not in src.lower() and "redoc" not in src.lower() and "openapi" not in src.lower():
            continue
        script_url = urljoin(page_url, src)
        script_text = _fetch_text_or_none(client, script_url, forced_encoding, referer=page_url)
        if script_text:
            candidates.extend(_extract_openapi_urls(script_text, script_url))

    parsed = urlparse(page_url)
    root = urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))
    for path in ("openapi.json", "swagger.json", "api/openapi.json", "v2/swagger.json", "v3/api-docs"):
        candidates.append(urljoin(root, path))
    return _unique_preserve_order(candidates)


def _extract_openapi_urls(text: str, base_url: str) -> list[str]:
    candidates: list[str] = []
    patterns = (
        r'["\']([^"\']*(?:openapi|swagger)[^"\']*\.json[^"\']*)["\']',
        r'\burl\s*:\s*["\']([^"\']+)["\']',
        r'\bspec-url=["\']([^"\']+)["\']',
        r'\bdata-url=["\']([^"\']+)["\']',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            url = match.group(1).strip()
            if url and not url.startswith("#"):
                candidates.append(urljoin(base_url, url))
    return candidates


def _fetch_text_or_none(
    client: object,
    url: str,
    forced_encoding: str | None = None,
    referer: str | None = None,
) -> str | None:
    headers = {"Accept": "text/javascript, application/javascript, text/plain, */*"}
    if referer:
        headers["Referer"] = referer
    try:
        response = client.get(url, headers=headers)
        if getattr(response, "status_code", 0) >= 400:
            return None
        content = getattr(response, "content", b"")
        if forced_encoding:
            return content.decode(forced_encoding, errors="replace")
        return content.decode("utf-8", errors="replace")
    except Exception:
        return None


def _openapi_to_markdown(payload: dict) -> tuple[str, dict[str, str]]:
    info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
    title = _clean_inline_text(str(info.get("title") or "OpenAPI Specification"))
    version = _clean_inline_text(str(info.get("version") or ""))
    description = _normalize_markdown(str(info.get("description") or ""))

    parts: list[str] = [f"# {title}", ""]
    if version:
        parts.extend([f"Version: `{version}`", ""])
    if description:
        parts.extend([description, ""])

    servers = payload.get("servers")
    if isinstance(servers, list) and servers:
        parts.extend(["## Servers", ""])
        for server in servers:
            if isinstance(server, dict) and server.get("url"):
                desc = _clean_inline_text(str(server.get("description") or ""))
                parts.append(f"- `{server['url']}`" + (f" - {desc}" if desc else ""))
        parts.append("")

    paths = payload.get("paths")
    if isinstance(paths, dict) and paths:
        parts.extend(["## Paths", ""])
        for path, operations in paths.items():
            if not isinstance(operations, dict):
                continue
            for method, operation in operations.items():
                if method.lower() not in {"get", "post", "put", "patch", "delete", "head", "options", "trace"}:
                    continue
                if not isinstance(operation, dict):
                    continue
                summary = _clean_inline_text(str(operation.get("summary") or operation.get("operationId") or ""))
                parts.append(f"### `{method.upper()} {path}`")
                if summary:
                    parts.extend(["", summary])
                desc = _normalize_markdown(str(operation.get("description") or ""))
                if desc:
                    parts.extend(["", desc])
                responses = operation.get("responses")
                if isinstance(responses, dict) and responses:
                    parts.extend(["", "Responses:", ""])
                    for status, response in responses.items():
                        if isinstance(response, dict):
                            response_desc = _clean_inline_text(str(response.get("description") or ""))
                        else:
                            response_desc = ""
                        parts.append(f"- `{status}`" + (f" - {response_desc}" if response_desc else ""))
                parts.append("")

    return _normalize_markdown("\n".join(parts)), {"title": title}


def _unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _looks_like_nextjs_spa(html_text: str) -> bool:
    sample = html_text[:200_000]
    return (
        "/_next/static/" in sample
        or "self.__next_f" in sample
        or "__NEXT_DATA__" in sample
        or 'id="__next"' in sample
    )


def _nextjs_doc_api_candidates(page_url: str) -> list[str]:
    parsed = urlparse(page_url)
    segments = [segment for segment in parsed.path.split("/") if segment]
    candidates: list[str] = []

    for index, segment in enumerate(segments[:-1]):
        if segment != "doc":
            continue

        identifier = segments[index + 1]
        if not identifier:
            continue

        base = urlunparse((parsed.scheme, parsed.netloc, f"/api/doc/{identifier}", "", "", ""))
        for lang in ("zh-CN", "en"):
            candidates.append(f"{base}?lang={lang}")

    return candidates


def _fetch_json_or_none(
    client: object,
    url: str,
    forced_encoding: str | None = None,
    referer: str | None = None,
) -> dict | None:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    if referer:
        headers["Referer"] = referer

    try:
        response = client.get(url, headers=headers)
        status = getattr(response, "status_code", 0)
        if status >= 400:
            return _fetch_json_with_curl(url, referer)

        content = getattr(response, "content", b"")
        if forced_encoding:
            text = content.decode(forced_encoding, errors="replace")
        else:
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                text = content.decode("utf-8", errors="replace")
        return json.loads(text)
    except Exception:
        return _fetch_json_with_curl(url, referer)


def _fetch_json_with_curl(url: str, referer: str | None = None, timeout: float = 20.0) -> dict | None:
    curl_path = shutil.which("curl") or shutil.which("curl.exe")
    if not curl_path:
        return None

    command = [
        curl_path,
        "-L",
        "--silent",
        "--show-error",
        "--max-time",
        str(timeout),
        "-A",
        DEFAULT_USER_AGENT,
        "-H",
        "Accept: application/json, text/plain, */*",
        "-H",
        "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    ]
    if referer:
        command.extend(["-H", f"Referer: {referer}"])
    command.append(url)

    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout + 5,
        )
    except Exception:
        return None

    if completed.returncode != 0 or not completed.stdout:
        return None

    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _clean_inline_text(text: str) -> str:
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"\s+([,.;:!?%)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    return text.strip()


def _escape_markdown_link_text(text: str) -> str:
    return text.replace("[", "\\[").replace("]", "\\]")


def _inline_code(text: str) -> str:
    text = _clean_inline_text(text)
    if not text:
        return ""
    if "`" in text:
        return f"`` {text} ``"
    return f"`{text}`"


def _notion_record_map_blocks(record_map: dict) -> dict[str, dict]:
    raw_blocks = record_map.get("block")
    if not isinstance(raw_blocks, dict):
        return {}

    blocks: dict[str, dict] = {}
    for block_id, wrapper in raw_blocks.items():
        if not isinstance(wrapper, dict):
            continue

        value = wrapper.get("value")
        if isinstance(value, dict) and isinstance(value.get("value"), dict):
            block = value["value"]
        elif isinstance(value, dict):
            block = value
        else:
            continue

        if isinstance(block, dict):
            blocks[str(block_id)] = block

    return blocks


def _notion_annotation_value(annotations: list, marker: str) -> str | None:
    for annotation in annotations:
        if isinstance(annotation, list) and annotation and annotation[0] == marker:
            if len(annotation) > 1:
                return str(annotation[1])
            return ""
        if annotation == marker:
            return ""
    return None


def _normalize_notion_link(href: str, base_url: str) -> str:
    href = href.strip()
    if not href:
        return href
    if re.match(r"^[a-z][a-z0-9+.-]*:", href, flags=re.IGNORECASE) or href.startswith("#"):
        return href
    return urljoin(base_url, href)


def _notion_rich_text_to_markdown(
    parts: object,
    base_url: str,
    normalize: bool = True,
) -> str:
    if not isinstance(parts, list):
        return ""

    rendered_parts: list[str] = []
    for part in parts:
        if isinstance(part, str):
            text = part
            annotations: list = []
        elif isinstance(part, list) and part:
            text = str(part[0])
            annotations = part[1] if len(part) > 1 and isinstance(part[1], list) else []
        else:
            continue

        text = text.replace("\xa0", " ")
        if not text:
            continue

        is_code = _notion_annotation_value(annotations, "c") is not None
        if is_code:
            text = _inline_code(text)
        else:
            if _notion_annotation_value(annotations, "b") is not None:
                text = f"**{text}**"
            if _notion_annotation_value(annotations, "i") is not None:
                text = f"*{text}*"
            if _notion_annotation_value(annotations, "s") is not None:
                text = f"~~{text}~~"

        href = _notion_annotation_value(annotations, "a")
        if href:
            text = f"[{_escape_markdown_link_text(text)}]({_normalize_notion_link(href, base_url)})"

        rendered_parts.append(text)

    result = "".join(rendered_parts)
    return _clean_inline_text(result) if normalize else result.strip()


def _notion_plain_text(parts: object) -> str:
    if not isinstance(parts, list):
        return ""
    return _clean_inline_text("".join(str(part[0]) for part in parts if isinstance(part, list) and part))


def _notion_block_title(block: dict, base_url: str, markdown: bool = True) -> str:
    parts = (block.get("properties") or {}).get("title")
    if markdown:
        return _notion_rich_text_to_markdown(parts, base_url)
    return _notion_plain_text(parts)


def _notion_code_language(block: dict) -> str:
    language = _notion_plain_text((block.get("properties") or {}).get("language")).lower()
    language = re.sub(r"[^a-z0-9+#-]+", "", language)
    language_map = {
        "plaintext": "",
        "plain": "",
        "text": "",
        "shell": "bash",
        "sh": "bash",
        "javascript": "js",
        "typescript": "ts",
    }
    return language_map.get(language, language)


def _escape_markdown_table_cell(text: str) -> str:
    text = _clean_inline_text(text)
    return text.replace("|", "\\|").replace("\n", "<br>")


def _render_notion_table(block: dict, blocks: dict[str, dict], base_url: str) -> str:
    row_ids = block.get("content")
    if not isinstance(row_ids, list):
        return ""

    table_format = block.get("format") or {}
    column_order = table_format.get("table_block_column_order")
    if not isinstance(column_order, list):
        column_order = []

    rows: list[list[str]] = []
    for row_id in row_ids:
        row = blocks.get(str(row_id))
        if not row or row.get("type") != "table_row":
            continue
        properties = row.get("properties") or {}
        if not column_order:
            column_order = list(properties.keys())
        cells = [
            _escape_markdown_table_cell(
                _notion_rich_text_to_markdown(properties.get(column_id), base_url)
            )
            for column_id in column_order
        ]
        rows.append(cells)

    if not rows:
        return ""

    max_cols = max(len(row) for row in rows)
    for row in rows:
        while len(row) < max_cols:
            row.append("")

    lines = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * max_cols) + " |",
    ]
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _notion_root_page(blocks: dict[str, dict]) -> dict | None:
    pages = [
        block
        for block in blocks.values()
        if block.get("type") == "page" and isinstance(block.get("content"), list)
    ]
    if not pages:
        return None
    return max(pages, key=lambda block: len(block.get("content") or []))


def _append_markdown_blank(lines: list[str]) -> None:
    if lines and lines[-1] != "":
        lines.append("")


def _render_notion_blocks(
    block_ids: list,
    blocks: dict[str, dict],
    base_url: str,
    page_title: str,
    lines: list[str],
    state: dict[str, bool],
    depth: int = 0,
) -> None:
    for block_id in block_ids:
        block = blocks.get(str(block_id))
        if not block:
            continue

        block_type = str(block.get("type", ""))
        child_ids = block.get("content") if isinstance(block.get("content"), list) else []

        if block_type == "page":
            _render_notion_blocks(child_ids, blocks, base_url, page_title, lines, state, depth)
            continue

        if block_type == "header":
            text = _notion_block_title(block, base_url)
            if text:
                is_page_title = _clean_inline_text(text.strip("# ")) == page_title
                level = 1 if is_page_title and not state.get("page_title_seen") else 2
                if is_page_title:
                    state["page_title_seen"] = True
                _append_markdown_blank(lines)
                lines.append(f"{'#' * level} {text}")
                lines.append("")
        elif block_type == "sub_header":
            text = _notion_block_title(block, base_url)
            if text:
                _append_markdown_blank(lines)
                lines.append(f"### {text}")
                lines.append("")
        elif block_type == "sub_sub_header":
            text = _notion_block_title(block, base_url)
            if text:
                _append_markdown_blank(lines)
                lines.append(f"#### {text}")
                lines.append("")
        elif block_type == "text":
            text = _notion_block_title(block, base_url)
            if text:
                _append_markdown_blank(lines)
                lines.append(text)
                lines.append("")
        elif block_type in ("bulleted_list", "numbered_list"):
            text = _notion_block_title(block, base_url)
            marker = "1." if block_type == "numbered_list" else "-"
            indent = "  " * depth
            if lines and lines[-1] != "" and not re.match(r"^\s*(?:-|\d+\.)\s", lines[-1]):
                lines.append("")
            lines.append(f"{indent}{marker} {text}" if text else f"{indent}{marker}")
            if child_ids:
                _render_notion_blocks(child_ids, blocks, base_url, page_title, lines, state, depth + 1)
        elif block_type == "code":
            code_text = _notion_rich_text_to_markdown(
                (block.get("properties") or {}).get("title"),
                base_url,
                normalize=False,
            )
            if code_text:
                _append_markdown_blank(lines)
                lines.append(f"```{_notion_code_language(block)}")
                lines.append(code_text.rstrip())
                lines.append("```")
                lines.append("")
        elif block_type == "table":
            table_md = _render_notion_table(block, blocks, base_url)
            if table_md:
                _append_markdown_blank(lines)
                lines.extend(table_md.splitlines())
                lines.append("")
        elif block_type == "quote":
            text = _notion_block_title(block, base_url)
            if text:
                _append_markdown_blank(lines)
                lines.extend(f"> {line}" for line in text.splitlines())
                lines.append("")
        elif block_type == "divider":
            _append_markdown_blank(lines)
            lines.append("---")
            lines.append("")
        elif block_type == "image":
            properties = block.get("properties") or {}
            src = (
                _notion_plain_text(properties.get("source"))
                or str((block.get("format") or {}).get("display_source", "")).strip()
            )
            if src:
                caption = _notion_rich_text_to_markdown(properties.get("caption"), base_url)
                _append_markdown_blank(lines)
                lines.append(f"![{caption}]({_normalize_notion_link(src, base_url)})")
                lines.append("")

        if child_ids and block_type not in ("page", "bulleted_list", "numbered_list", "table"):
            _render_notion_blocks(child_ids, blocks, base_url, page_title, lines, state, depth)


def _notion_record_map_to_markdown(record_map: dict, base_url: str) -> tuple[str, dict[str, str]] | None:
    blocks = _notion_record_map_blocks(record_map)
    root = _notion_root_page(blocks)
    if not root:
        return None

    page_title = _notion_block_title(root, base_url, markdown=False) or "Untitled"
    content = root.get("content")
    if not isinstance(content, list):
        return None

    lines: list[str] = []
    _render_notion_blocks(
        content,
        blocks,
        base_url,
        page_title,
        lines,
        {"page_title_seen": False},
    )
    markdown = "\n".join(lines).strip()
    if not markdown:
        return None
    return markdown, {"title": page_title}
