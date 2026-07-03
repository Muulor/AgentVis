"""
AgentVis 原生 DDGS 后备搜索 helper。

Rust 原生命令 web_search 负责工具策略和网络审计；本脚本只通过 stdin 接收 JSON
请求，并通过 stdout 返回 JSON 响应。清洗逻辑时产生的人类可读日志会被收集进 
diagnostics，确保 stdout 始终保持机器可解析。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import contextlib
from dataclasses import dataclass, field
from datetime import datetime
import io
import json
import math
import os
from pathlib import Path
import re
import sys
from time import perf_counter
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TRACKING_QUERY_PREFIXES = ("utm_",)
TRACKING_QUERY_PARAMS = {
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "msclkid",
    "yclid",
}

TRUSTED_DOMAIN_SUFFIXES = (
    ".edu",
    ".gov",
    ".ac.uk",
)

TRUSTED_DOMAINS = {
    "github.com",
    "docs.github.com",
    "stackoverflow.com",
    "stackexchange.com",
    "wikipedia.org",
    "arxiv.org",
    "auth0.com",
    "authlib.org",
    "docs.authlib.org",
    "docs.python.org",
    "developer.mozilla.org",
    "learn.microsoft.com",
    "cloud.google.com",
    "docs.aws.amazon.com",
    "kubernetes.io",
    "react.dev",
    "nextjs.org",
    "nodejs.org",
    "expressjs.com",
    "redis.io",
    "postgresql.org",
    "mongodb.com",
    "tauri.app",
    "openai.com",
    "oauth.net",
    "developers.openai.com",
    "platform.openai.com",
    "rust-lang.org",
    "crates.io",
    "pypi.org",
    "npmjs.com",
}

LOW_QUALITY_DOMAIN_HINTS = (
    "coupon",
    "lyrics",
    "pinterest.",
    "quora.com",
    "medium.com",
    "answers.",
    "archive.ph",
    "toolora.biz",
    "blog.mean.ceo",
)

NEWS_QUERY_HINTS = (
    "latest",
    "today",
    "breaking",
    "news",
    "release",
    "launched",
    "recent",
    "update",
    "announcement",
    "announces",
    "announced",
)

NEWS_QUERY_CJK_HINTS = (
    "\u6700\u65b0",
    "\u4eca\u5929",
    "\u65b0\u95fb",
    "\u53d1\u5e03",
    "\u66f4\u65b0",
    "\u6700\u8fd1",
)

RRF_K = 60
BACKEND_WEIGHTS = {
    "google": 1.08,
    "bing": 1.0,
    "brave": 0.98,
    "duckduckgo": 0.95,
    "wikipedia": 0.72,
    "auto": 0.7,
    "news:bing": 0.95,
    "news:duckduckgo": 0.9,
    "news:yahoo": 0.85,
    "news": 0.86,
}

DDGS_RATE_LIMIT_ERROR_HINTS = (
    "rate",
    "ratelimit",
    "too many requests",
    "202",
    "403",
    "429",
)

SHORT_STRONG_ANCHORS = {
    "ai",
    "agi",
    "llm",
    "gpt",
    "ml",
    "rsc",
    "js",
    "ts",
}

AI_QUERY_TERMS = {
    "ai",
    "agi",
    "llm",
    "gpt",
    "openai",
    "anthropic",
    "claude",
    "gemini",
    "deepmind",
    "nvidia",
    "人工智能",
    "大模型",
    "机器学习",
    "生成式",
}

TECH_QUERY_HINTS = (
    "api",
    "asyncio",
    "client component",
    "client components",
    "component",
    "components",
    "database",
    "docs",
    "express",
    "framework",
    "github",
    "implement",
    "implementation",
    "javascript",
    "mongodb",
    "node",
    "oauth",
    "pkce",
    "postgres",
    "postgresql",
    "python",
    "rate limiting",
    "react",
    "redis",
    "server component",
    "server components",
    "typescript",
    "认证",
    "实现",
    "代码",
    "文档",
    "框架",
)

WEATHER_QUERY_HINTS = (
    "weather",
    "forecast",
    "temperature",
    "rain",
    "snow",
    "天气",
    "气温",
    "预报",
    "降雨",
)

TIME_QUERY_HINTS = (
    "current time",
    "time in",
    "what time",
    "现在几点",
    "当前时间",
    "当地时间",
    "几点",
)

COMPARISON_QUERY_HINTS = (
    " vs ",
    " versus ",
    "compare",
    "comparison",
    "difference",
    "differences",
    "better",
    "which is best",
    "performance",
    "benchmark",
    "对比",
    "比较",
    "区别",
    "差异",
    "性能",
    "横评",
)

COMPARISON_TITLE_HINTS = (
    " vs ",
    " versus ",
    "compare",
    "comparison",
    "difference",
    "differences",
    "benchmark",
    "对比",
    "比较",
    "区别",
    "差异",
    "横评",
)

COMPARISON_NOISE_HINTS = (
    "moving from",
    "migrating",
    "migration",
    "converting",
    "conversion",
    "compatibility",
    "release",
    "活动",
    "大会",
    "迁移",
    "转换",
    "发布",
    "兼容",
)

DATA_QUERY_HINTS = (
    "market cap",
    "stock price",
    "share price",
    "gdp",
    "growth rate",
    "population",
    "inflation",
    "cpi",
    "exchange rate",
    "interest rate",
    "市值",
    "股价",
    "股票",
    "行情",
    "gdp",
    "增长率",
    "人口",
    "通胀",
    "汇率",
    "利率",
    "数据",
)

MARKET_DATA_HINTS = (
    "market cap",
    "stock price",
    "share price",
    "ticker",
    "市值",
    "股价",
    "股票",
    "行情",
)

MACRO_DATA_HINTS = (
    "gdp",
    "growth rate",
    "inflation",
    "cpi",
    "unemployment",
    "增长率",
    "通胀",
    "失业率",
)

POPULATION_DATA_HINTS = (
    "population",
    "人口",
)

HEALTH_QUERY_HINTS = (
    "health",
    "sleep",
    "diet",
    "cold",
    "flu",
    "symptom",
    "treatment",
    "健康",
    "睡眠",
    "感冒",
    "饮食",
    "症状",
    "治疗",
)

JOB_QUERY_HINTS = (
    "job",
    "jobs",
    "hiring",
    "recruit",
    "career",
    "招聘",
    "岗位",
    "求职",
    "校招",
    "社招",
)

LOCAL_RECOMMENDATION_HINTS = (
    "restaurant",
    "restaurants",
    "recommend",
    "near me",
    "好吃",
    "餐厅",
    "推荐",
    "本帮菜",
    "攻略",
    "旅游",
)

CJK_FACT_HINTS = (
    "最大",
    "最高",
    "最长",
    "最小",
    "多少",
    "哪个",
    "哪一个",
    "是什么",
    "是谁",
)

AMBIGUOUS_INTENT_HINTS = (
    "游戏",
    "手游",
    "下载",
    "攻略",
    "电影",
    "电视剧",
    "小说",
    "动漫",
    "歌词",
    "歌曲",
    "app",
    "apk",
)

NEWS_AUTHORITY_DOMAINS = {
    "apnews.com",
    "bbc.com",
    "bbc.co.uk",
    "bloomberg.com",
    "cnbc.com",
    "finance.yahoo.com",
    "forbes.com",
    "fortune.com",
    "reuters.com",
    "technologyreview.com",
    "techcrunch.com",
    "theguardian.com",
    "theverge.com",
    "wsj.com",
    "xinhuanet.com",
    "news.cn",
    "caixin.com",
    "cls.cn",
    "thepaper.cn",
    "36kr.com",
    "huxiu.com",
    "qq.com",
    "163.com",
}

NEWS_AGGREGATOR_DOMAIN_HINTS = (
    "aiagentstore.",
    "aiapps.",
    "aitools",
    "buildfastwithai.",
    "imfounder.",
    "llm-stats.",
    "toolora.",
)

DATA_AUTHORITY_DOMAINS = {
    "companiesmarketcap.com",
    "finance.yahoo.com",
    "investing.com",
    "marketcapwatch.com",
    "macrotrends.net",
    "eastmoney.com",
    "cnyes.com",
    "tradingeconomics.com",
    "data.worldbank.org",
    "worldbank.org",
    "imf.org",
    "stats.gov.cn",
    "fred.stlouisfed.org",
    "bea.gov",
    "oecd.org",
    "worldometers.info",
    "countrymeters.info",
    "population.un.org",
    "un.org",
}

MARKET_DATA_DOMAINS = {
    "companiesmarketcap.com",
    "finance.yahoo.com",
    "investing.com",
    "marketcapwatch.com",
    "macrotrends.net",
    "eastmoney.com",
    "cnyes.com",
}

MACRO_DATA_DOMAINS = {
    "tradingeconomics.com",
    "data.worldbank.org",
    "worldbank.org",
    "imf.org",
    "stats.gov.cn",
    "fred.stlouisfed.org",
    "bea.gov",
    "oecd.org",
}

POPULATION_DATA_DOMAINS = {
    "worldometers.info",
    "countrymeters.info",
    "population.un.org",
    "un.org",
    "data.worldbank.org",
    "worldbank.org",
}

DATA_ENTITY_ALIASES = {
    "特斯拉": "Tesla TSLA",
    "苹果": "Apple AAPL",
    "英伟达": "Nvidia NVDA",
    "微软": "Microsoft MSFT",
    "亚马逊": "Amazon AMZN",
    "谷歌": "Alphabet GOOG GOOGL",
}

HEALTH_AUTHORITY_DOMAINS = {
    "who.int",
    "cdc.gov",
    "nih.gov",
    "nhs.uk",
    "mayoclinic.org",
    "clevelandclinic.org",
    "health.harvard.edu",
    "nhc.gov.cn",
    "news.cctv.com",
    "cctv.com",
    "xinhuanet.com",
    "news.qq.com",
    "people.com.cn",
    "health.people.com.cn",
    "health.baidu.com",
}

HEALTH_LOW_QUALITY_HINTS = (
    "mattress",
    "bedding",
    "pillow",
    "床垫",
    "寝具",
    "枕头",
    "民营",
    "推广",
    "加盟",
    "白癜风",
    "妇产医院",
    "皮肤病",
    "招商",
    "财经快报",
)

HEALTH_QA_LOW_QUALITY_HINTS = (
    "xywy.com",
    "有问必答",
    "问答",
)

JOB_AUTHORITY_DOMAINS = {
    "zhipin.com",
    "liepin.com",
    "lagou.com",
    "51job.com",
    "zhaopin.com",
    "linkedin.com",
    "shenzhenrcw.com",
}

JOB_LIST_HINTS = (
    "search",
    "jobs",
    "job",
    "zhaopin",
    "招聘网",
    "人才网",
    "社会招聘",
    "职位",
)

LOCAL_RECOMMENDATION_DOMAINS = {
    "timeout.com",
    "tripadvisor.com",
    "ctrip.com",
    "dianping.com",
    "mafengwo.cn",
    "thepaper.cn",
    "zhihu.com",
}

ZH_CITY_HINTS = (
    "北京",
    "上海",
    "深圳",
    "广州",
    "杭州",
    "南京",
    "成都",
    "武汉",
    "苏州",
)

WEATHER_AUTHORITY_DOMAINS = {
    "accuweather.com",
    "weather.com",
    "weather.gov",
    "timeanddate.com",
    "aqi.in",
    "weather25.com",
}

TECH_OFFICIAL_DOMAIN_MAP = {
    "asyncio": {"docs.python.org"},
    "authlib": {"authlib.org", "docs.authlib.org"},
    "express": {"expressjs.com"},
    "express.js": {"expressjs.com"},
    "mongodb": {"mongodb.com"},
    "next": {"nextjs.org"},
    "nextjs": {"nextjs.org"},
    "node": {"nodejs.org"},
    "nodejs": {"nodejs.org"},
    "oauth": {"oauth.net", "auth0.com", "authlib.org", "docs.authlib.org"},
    "oauth2": {"oauth.net", "auth0.com", "authlib.org", "docs.authlib.org"},
    "openai": {"openai.com", "developers.openai.com", "platform.openai.com"},
    "pkce": {"oauth.net", "auth0.com", "authlib.org", "docs.authlib.org"},
    "postgres": {"postgresql.org"},
    "postgresql": {"postgresql.org"},
    "react": {"react.dev"},
    "redis": {"redis.io"},
    "rust": {"rust-lang.org", "crates.io"},
    "tauri": {"tauri.app"},
}

GENERIC_ANCHOR_TERMS = {
    "about",
    "api",
    "best",
    "blog",
    "code",
    "docs",
    "find",
    "guide",
    "latest",
    "news",
    "official",
    "reference",
    "release",
    "search",
    "the",
    "today",
    "update",
    "what",
    "when",
    "where",
    "which",
    "wiki",
}

ENGLISH_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "with",
}

OFFICIAL_DOC_HINTS = (
    "api",
    "docs",
    "documentation",
    "guide",
    "official",
    "reference",
    "\u5b98\u65b9",
    "\u6587\u6863",
    "\u6307\u5357",
)

GITHUB_HINTS = (
    "github",
    "repo",
    "repository",
    "source code",
    "\u4ee3\u7801",
    "\u6e90\u7801",
    "\u4ed3\u5e93",
)


@dataclass
class Diagnostic:
    level: str
    message: str


@dataclass
class Candidate:
    title: str
    url: str
    content: str
    rank: int
    provider: str
    category: str = "text"
    raw_content: str | None = None
    score: float = 0.0
    duplicate_providers: set[str] = field(default_factory=set)
    rank_signals: dict[str, int] = field(default_factory=dict)
    rrf_score: float = 0.0
    bm25_score: float = 0.0
    anchor_score: float = 0.0
    official_score: float = 0.0
    source_quality_score: float = 0.0
    recency_score: float = 0.0
    ambiguity_score: float = 0.0
    cleanliness_score: float = 0.0
    matched_anchors: set[str] = field(default_factory=set)


@dataclass
class TextBackendAttempt:
    backend: str
    used_region: str
    results: list[dict[str, Any]] | None
    elapsed: float
    diagnostics: list[Diagnostic] = field(default_factory=list)
    last_error: Exception | None = None
    error_kind: str | None = None


@dataclass
class QuerySignals:
    tokens: set[str]
    anchors: set[str]
    quoted_phrases: list[str]
    site_domains: set[str]
    preferred_domains: set[str]
    explicit_years: set[int]
    wants_official_docs: bool
    wants_github: bool
    wants_news: bool
    wants_tech: bool
    wants_weather: bool
    wants_time: bool
    wants_ai: bool
    wants_comparison: bool
    comparison_terms: tuple[str, ...]
    wants_data: bool
    wants_market_data: bool
    wants_macro_data: bool
    wants_population_data: bool
    wants_health: bool
    wants_jobs: bool
    wants_local_recommendation: bool
    query_language: str
    short_cjk_fact_query: bool


def clamp_int(value: Any, default: int, lower: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(lower, min(upper, parsed))


def compact_text(value: Any, limit: int = 800) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit].strip()


def tokenize(text: str) -> set[str]:
    lowered = text.lower()
    tokens = set(re.findall(r"[a-z0-9][a-z0-9_+#.-]{1,}", lowered))
    tokens.update(ch for ch in lowered if "\u4e00" <= ch <= "\u9fff")
    return tokens


def has_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def has_japanese_kana(text: str) -> bool:
    return any("\u3040" <= ch <= "\u30ff" for ch in text)


def infer_query_language(query: str) -> str:
    if has_japanese_kana(query):
        return "ja"
    if has_cjk(query):
        return "zh"
    if re.search(r"[a-zA-Z]", query):
        return "en"
    return "unknown"


def extract_years(text: str) -> set[int]:
    return {
        int(match.group(0))
        for match in re.finditer(r"\b(?:19|20)\d{2}\b", text)
    }


def is_weather_query(query: str) -> bool:
    lowered = query.lower()
    return any(hint in lowered or hint in query for hint in WEATHER_QUERY_HINTS)


def is_time_query(query: str) -> bool:
    lowered = query.lower()
    return any(hint in lowered or hint in query for hint in TIME_QUERY_HINTS)


def contains_hint(query: str, hints: tuple[str, ...]) -> bool:
    lowered = f" {query.lower()} "
    return any(hint in lowered or hint in query for hint in hints)


def is_ai_query(query: str) -> bool:
    lowered = query.lower()
    return any(term in lowered or term in query for term in AI_QUERY_TERMS)


def is_tech_query(query: str) -> bool:
    lowered = query.lower()
    if any(hint in lowered or hint in query for hint in TECH_QUERY_HINTS):
        return True
    return bool(re.search(r"[A-Za-z][A-Za-z0-9]*[._+#][A-Za-z0-9]+", query))


def is_comparison_query(query: str) -> bool:
    return contains_hint(query, COMPARISON_QUERY_HINTS) or bool(
        re.search(r"\b\S+\s+(?:vs\.?|versus)\s+\S+", query, re.IGNORECASE)
    )


def is_data_query(query: str) -> bool:
    return contains_hint(query, DATA_QUERY_HINTS)


def is_market_data_query(query: str) -> bool:
    return contains_hint(query, MARKET_DATA_HINTS)


def is_macro_data_query(query: str) -> bool:
    return contains_hint(query, MACRO_DATA_HINTS)


def is_population_data_query(query: str) -> bool:
    return contains_hint(query, POPULATION_DATA_HINTS)


def is_health_query(query: str) -> bool:
    return contains_hint(query, HEALTH_QUERY_HINTS)


def is_job_query(query: str) -> bool:
    return contains_hint(query, JOB_QUERY_HINTS)


def is_local_recommendation_query(query: str) -> bool:
    return contains_hint(query, LOCAL_RECOMMENDATION_HINTS)


def is_short_cjk_fact_query(query: str) -> bool:
    cjk_chars = [ch for ch in query if "\u4e00" <= ch <= "\u9fff"]
    if not cjk_chars or len(cjk_chars) > 14:
        return False
    return any(hint in query for hint in CJK_FACT_HINTS)


def clean_comparison_term(term: str) -> str:
    value = compact_text(term, 120).lower()
    value = re.sub(r"\b(vs\.?|versus|compare|comparison|difference|differences|performance|benchmark)\b", " ", value)
    for hint in ("对比", "比较", "区别", "差异", "性能", "横评"):
        value = value.replace(hint, " ")
    value = re.sub(r"\s+", " ", value).strip(" -_/|:：，,")
    return value


def extract_comparison_terms(query: str) -> tuple[str, ...]:
    parts = re.split(
        r"\bvs\.?\b|\bversus\b|对比|比较|区别|差异|横评",
        query,
        maxsplit=1,
        flags=re.IGNORECASE,
    )
    terms: list[str] = []
    if len(parts) >= 2:
        terms.extend(clean_comparison_term(part) for part in parts[:2])
    else:
        for match in re.finditer(r"([A-Za-z][A-Za-z0-9+.#-]{1,})\s+(?:和|与)\s+([A-Za-z][A-Za-z0-9+.#-]{1,})", query):
            terms.extend(clean_comparison_term(part) for part in match.groups())
            break
    terms = [term for term in terms if term and term not in GENERIC_ANCHOR_TERMS]
    return tuple(terms[:2])


def query_city_terms(query: str) -> set[str]:
    return {city for city in ZH_CITY_HINTS if city in query}


def infer_cjk_place_terms(query: str) -> list[str]:
    city_terms = [city for city in ZH_CITY_HINTS if city in query]
    if city_terms:
        return city_terms

    matches = re.findall(
        r"([\u4e00-\u9fff]{2,6})(?:今天|今日|现在|当前|当地)?(?:的)?(?:天气|时间|几点)",
        query,
    )
    blocked = {"今天", "今日", "现在", "当前", "当地", "天气", "时间"}
    return [match for match in matches if match not in blocked][:2]


def rewrite_chinese_natural_query(query: str, signals: QuerySignals) -> str:
    if signals.query_language != "zh":
        return query

    places = infer_cjk_place_terms(query)
    place = places[0] if places else ""
    if signals.wants_weather:
        if place:
            return f"{place} 今天 天气预报"
        return "今天 天气预报"
    if signals.wants_time:
        if place:
            return f"{place} 当前时间"
        return "当前时间"

    rewritten = query
    colloquial_replacements = (
        ("怎么样", ""),
        ("好不好", ""),
        ("怎么办", "解决方法"),
        ("怎么解决", "解决方法"),
    )
    for source, target in colloquial_replacements:
        rewritten = rewritten.replace(source, target)
    rewritten = compact_text(rewritten, 500)
    return rewritten or query


def preferred_domains_for_query(query: str, anchors: set[str]) -> set[str]:
    lowered = query.lower()
    preferred: set[str] = set()
    for term, domains in TECH_OFFICIAL_DOMAIN_MAP.items():
        if term in lowered or term in anchors:
            preferred.update(domains)
    if "server components" in lowered or "client components" in lowered:
        preferred.update({"react.dev", "nextjs.org"})
    return preferred


def split_identifier_parts(value: str) -> list[str]:
    parts: list[str] = []
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_+#.-]{1,}", value):
        parts.append(token)
        parts.extend(part for part in re.split(r"[_+#./-]+", token) if len(part) > 1)
        camel_parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", token).split()
        parts.extend(part for part in camel_parts if len(part) > 1)
    return parts


def tokenize_terms(text: str) -> list[str]:
    terms: list[str] = []
    for raw in split_identifier_parts(text):
        term = raw.lower()
        if len(term) > 1 and term not in ENGLISH_STOP_WORDS:
            terms.append(term)

    lowered = text.lower()
    for term in re.findall(r"[a-z0-9][a-z0-9_+#.-]{1,}", lowered):
        if len(term) > 1 and term not in ENGLISH_STOP_WORDS:
            terms.append(term)

    for segment in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        if len(segment) <= 8:
            terms.append(segment)
        for size in (2, 3, 4):
            if len(segment) >= size:
                terms.extend(segment[index:index + size] for index in range(len(segment) - size + 1))
    return terms


def extract_query_signals(query: str) -> QuerySignals:
    lowered = query.lower()
    wants_weather = is_weather_query(query)
    wants_time = is_time_query(query)
    wants_ai = is_ai_query(query)
    wants_tech = is_tech_query(query)
    wants_comparison = is_comparison_query(query)
    wants_data = is_data_query(query)
    wants_market_data = is_market_data_query(query)
    wants_macro_data = is_macro_data_query(query)
    wants_population_data = is_population_data_query(query)
    wants_health = is_health_query(query)
    wants_jobs = is_job_query(query)
    wants_local_recommendation = is_local_recommendation_query(query)
    wants_news = is_news_query(query) and not wants_weather
    quoted_phrases = [
        match.group(1).strip().lower()
        for match in re.finditer(r"['\"]([^'\"]{2,})['\"]", query)
        if match.group(1).strip()
    ]
    site_domains = {
        match.group(1).lower()
        for match in re.finditer(r"\bsite:([a-z0-9.-]+\.[a-z]{2,})\b", lowered)
    }
    bare_domains = {
        match.group(1).lower()
        for match in re.finditer(r"\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b", lowered)
    }
    tokens = tokenize(query)
    anchors = {
        token
        for token in tokens
        if (len(token) >= 4 or token in SHORT_STRONG_ANCHORS)
        and token not in GENERIC_ANCHOR_TERMS
        and not token.isdigit()
    }
    anchors.update(quoted_phrases)
    anchors.update(site_domains)
    anchors.update(bare_domains)
    for segment in re.findall(r"[\u4e00-\u9fff]{2,}", query):
        if len(segment) <= 8:
            anchors.add(segment)
        for size in (2, 3, 4):
            if len(segment) >= size:
                anchors.update(segment[index:index + size] for index in range(len(segment) - size + 1))
    for identifier in split_identifier_parts(query):
        normalized = identifier.lower()
        if (
            (len(normalized) >= 4 or normalized in SHORT_STRONG_ANCHORS)
            and normalized not in GENERIC_ANCHOR_TERMS
        ):
            anchors.add(normalized)

    repo_hints = tuple(hint for hint in GITHUB_HINTS if hint != "github")
    non_github_anchors = {anchor for anchor in anchors if anchor not in {"github", "repository", "repo"}}
    wants_github = any(hint in lowered or hint in query for hint in repo_hints) or (
        "github" in lowered
        and len(non_github_anchors) >= 2
        and not wants_news
    )
    preferred_domains = preferred_domains_for_query(query, anchors)

    return QuerySignals(
        tokens=tokens,
        anchors=anchors,
        quoted_phrases=quoted_phrases,
        site_domains=site_domains,
        preferred_domains=preferred_domains,
        explicit_years=extract_years(query),
        wants_official_docs=any(hint in lowered or hint in query for hint in OFFICIAL_DOC_HINTS),
        wants_github=wants_github,
        wants_news=wants_news,
        wants_tech=wants_tech,
        wants_weather=wants_weather,
        wants_time=wants_time,
        wants_ai=wants_ai,
        wants_comparison=wants_comparison,
        comparison_terms=extract_comparison_terms(query) if wants_comparison else (),
        wants_data=wants_data,
        wants_market_data=wants_market_data,
        wants_macro_data=wants_macro_data,
        wants_population_data=wants_population_data,
        wants_health=wants_health,
        wants_jobs=wants_jobs,
        wants_local_recommendation=wants_local_recommendation,
        query_language=infer_query_language(query),
        short_cjk_fact_query=is_short_cjk_fact_query(query),
    )


def normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return ""

    port = parsed.port
    netloc = hostname
    if port and not ((parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)):
        netloc = f"{hostname}:{port}"

    query_items = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in TRACKING_QUERY_PARAMS
        and not key.lower().startswith(TRACKING_QUERY_PREFIXES)
    ]
    query = urlencode(query_items, doseq=True)
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((parsed.scheme, netloc, path, "", query, ""))


def domain_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def registrable_domain(domain: str) -> str:
    labels = [label for label in domain.lower().split(".") if label]
    if len(labels) <= 2:
        return domain.lower()
    multi_part_suffixes = {
        "co.uk",
        "com.au",
        "com.br",
        "com.cn",
        "com.hk",
        "com.sg",
        "com.tw",
        "co.jp",
        "co.kr",
        "co.nz",
        "org.cn",
        "net.cn",
    }
    suffix = ".".join(labels[-2:])
    if suffix in multi_part_suffixes and len(labels) >= 3:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def domain_quality_score(domain: str) -> float:
    if not domain:
        return -0.25
    if any(domain == trusted or domain.endswith("." + trusted) for trusted in TRUSTED_DOMAINS):
        return 0.25
    if domain.endswith(TRUSTED_DOMAIN_SUFFIXES):
        return 0.2
    if any(hint in domain for hint in LOW_QUALITY_DOMAIN_HINTS):
        return -0.2
    return 0.0


def domain_matches(domain: str, candidates: set[str]) -> bool:
    return any(domain == candidate or domain.endswith("." + candidate) for candidate in candidates)


def combined_candidate_text(candidate: Candidate) -> str:
    parsed = urlparse(candidate.url)
    return " ".join(
        [
            candidate.title,
            candidate.content,
            parsed.hostname or "",
            parsed.path.replace("/", " "),
        ]
    ).lower()


def is_low_quality_domain(domain: str) -> bool:
    return any(hint in domain for hint in LOW_QUALITY_DOMAIN_HINTS)


def text_overlap_score(query_tokens: set[str], title: str, content: str) -> float:
    if not query_tokens:
        return 0.0
    title_tokens = tokenize(title)
    body_tokens = tokenize(content)
    title_hits = len(query_tokens & title_tokens) / len(query_tokens)
    body_hits = len(query_tokens & body_tokens) / len(query_tokens)
    return (title_hits * 0.28) + (body_hits * 0.14)


def candidate_index_text(candidate: Candidate) -> str:
    parsed = urlparse(candidate.url)
    domain = parsed.hostname or ""
    path = parsed.path.replace("/", " ").replace("-", " ").replace("_", " ")
    return " ".join(
        [
            candidate.title,
            candidate.title,
            candidate.title,
            domain,
            domain,
            path,
            path,
            candidate.content,
        ]
    )


def bm25_query_text(query: str, signals: QuerySignals) -> str:
    anchors = " ".join(sorted(signals.anchors))
    quoted = " ".join(signals.quoted_phrases)
    sites = " ".join(signals.site_domains)
    return " ".join(part for part in (query, anchors, anchors, quoted, sites) if part)


def compute_bm25_scores(candidates: list[Candidate], query: str, signals: QuerySignals) -> dict[str, float]:
    query_terms = tokenize_terms(bm25_query_text(query, signals))
    if not query_terms or not candidates:
        return {}

    doc_terms = [tokenize_terms(candidate_index_text(candidate)) for candidate in candidates]
    doc_count = len(doc_terms)
    doc_lengths = [len(terms) for terms in doc_terms]
    avg_doc_length = sum(doc_lengths) / max(1, doc_count)
    document_frequency: Counter[str] = Counter()
    for terms in doc_terms:
        document_frequency.update(set(terms))

    query_counter = Counter(query_terms)
    raw_scores: dict[str, float] = {}
    k1 = 1.2
    b = 0.75
    for candidate, terms, doc_length in zip(candidates, doc_terms, doc_lengths):
        term_counts = Counter(terms)
        score = 0.0
        for term, query_weight in query_counter.items():
            term_frequency = term_counts.get(term, 0)
            if term_frequency <= 0:
                continue
            df = document_frequency.get(term, 0)
            idf = math.log((doc_count - df + 0.5) / (df + 0.5) + 1)
            denominator = term_frequency + k1 * (1 - b + b * doc_length / max(1.0, avg_doc_length))
            score += min(3, query_weight) * idf * (term_frequency * (k1 + 1) / denominator)
        raw_scores[candidate.url] = score

    max_score = max(raw_scores.values(), default=0.0)
    if max_score <= 0:
        return {}
    return {
        url: min(1.0, score / max_score)
        for url, score in raw_scores.items()
    }


def provider_weight(provider: str) -> float:
    base_provider = provider.split("/", 1)[0]
    return BACKEND_WEIGHTS.get(base_provider, BACKEND_WEIGHTS.get(provider, 0.8))


def rrf_score_candidate(candidate: Candidate) -> float:
    total = 0.0
    for provider, rank in candidate.rank_signals.items():
        total += provider_weight(provider) / (RRF_K + rank + 1)
    return total


def anchor_match_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.anchors:
        return 0.0

    title = candidate.title.lower()
    content = candidate.content.lower()
    parsed = urlparse(candidate.url)
    domain = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    score = 0.0
    matched: set[str] = set()

    for anchor in signals.anchors:
        if not anchor or anchor in GENERIC_ANCHOR_TERMS:
            continue
        anchor_lower = anchor.lower()
        if anchor_lower in title:
            score += 0.08
            matched.add(anchor_lower)
        if anchor_lower in domain or anchor_lower in path:
            score += 0.07
            matched.add(anchor_lower)
        if anchor_lower in content:
            score += 0.03
            matched.add(anchor_lower)

    candidate.matched_anchors = matched
    return min(0.35, score)


def second_level_label(domain: str) -> str:
    labels = [label for label in domain.split(".") if label]
    if len(labels) < 2:
        return domain
    return labels[-2]


def brand_authority_match(domain: str, anchors: set[str]) -> bool:
    second_level = second_level_label(domain)
    for anchor in anchors:
        if anchor in GENERIC_ANCHOR_TERMS or len(anchor) < 4:
            continue
        if second_level == anchor:
            return True
    return False


def important_tech_anchors(signals: QuerySignals) -> set[str]:
    brand_like = set(TECH_OFFICIAL_DOMAIN_MAP.keys()) | {
        "python",
        "javascript",
        "typescript",
        "node",
        "nodejs",
        "docs",
        "official",
        "implement",
        "implementation",
        "实现",
        "文档",
    }
    return {
        anchor
        for anchor in signals.anchors
        if anchor not in brand_like
        and anchor not in GENERIC_ANCHOR_TERMS
        and not anchor.isdigit()
        and len(anchor) >= 2
    }


def has_important_tech_match(candidate: Candidate, signals: QuerySignals) -> bool:
    important = important_tech_anchors(signals)
    if not important:
        return True
    text = combined_candidate_text(candidate)
    return bool(candidate.matched_anchors & important) or any(anchor in text for anchor in important)


def official_source_score(candidate: Candidate, signals: QuerySignals) -> float:
    parsed = urlparse(candidate.url)
    domain = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    title = candidate.title.lower()
    score = 0.0

    if signals.site_domains:
        if any(domain == site or domain.endswith("." + site) for site in signals.site_domains):
            score += 0.35
        else:
            score -= 0.12

    if signals.wants_github and domain == "github.com":
        score += 0.26
        if any(anchor in path for anchor in signals.anchors):
            score += 0.12
        if "github" in title:
            score += 0.04

    if signals.wants_official_docs:
        brand_anchors = [
            anchor
            for anchor in signals.anchors
            if anchor not in GENERIC_ANCHOR_TERMS and len(anchor) >= 4
        ]
        has_brand_authority = brand_authority_match(domain, set(brand_anchors))
        if has_brand_authority:
            score += 0.32
        if (
            domain.startswith("docs.")
            or domain.startswith("developer.")
            or domain.startswith("developers.")
            or ".docs." in domain
            or ".developer." in domain
            or ".developers." in domain
        ):
            score += 0.12
        if any(part in path for part in ("/docs", "/documentation", "/api", "/reference", "/guides")):
            score += 0.12
        if brand_anchors and not has_brand_authority and domain not in TRUSTED_DOMAINS:
            score -= 0.08

    if signals.wants_tech and signals.preferred_domains:
        if domain_matches(domain, signals.preferred_domains):
            if has_important_tech_match(candidate, signals):
                score += 0.3
                if any(part in path for part in ("/docs", "/documentation", "/api", "/reference", "/guides", "/learn")):
                    score += 0.1
            else:
                score -= 0.08
        elif signals.wants_official_docs and not domain_matches(domain, TRUSTED_DOMAINS):
            score -= 0.06

    return max(-0.16, min(0.65, score))


def candidate_has_ai_signal(candidate: Candidate) -> bool:
    text = combined_candidate_text(candidate)
    if re.search(r"\b(ai|agi|llm|gpt|openai|anthropic|claude|gemini|deepmind|nvidia)\b", text):
        return True
    return any(term in text for term in ("人工智能", "大模型", "机器学习", "生成式"))


def comparison_term_matches(term: str, text: str) -> bool:
    if not term:
        return False
    normalized_text = re.sub(r"\s+", " ", text.lower())
    compacted_text = re.sub(r"[\s_\-./|:：]+", "", normalized_text)
    compacted_term = re.sub(r"[\s_\-./|:：]+", "", term.lower())
    if compacted_term and compacted_term in compacted_text:
        return True

    ascii_terms = [
        token
        for token in re.findall(r"[a-z0-9][a-z0-9+.#-]*", term.lower())
        if token not in GENERIC_ANCHOR_TERMS
    ]
    cjk_terms = [
        segment
        for segment in re.findall(r"[\u4e00-\u9fff]{2,}", term)
        if segment not in {"对比", "比较", "区别", "差异", "性能"}
    ]
    if len(ascii_terms) >= 2:
        return all(token in normalized_text for token in ascii_terms)
    if ascii_terms and any(token in normalized_text for token in ascii_terms):
        return True
    return any(segment in text for segment in cjk_terms)


def comparison_match_count(candidate: Candidate, signals: QuerySignals) -> int:
    if not signals.comparison_terms:
        return 0
    text = combined_candidate_text(candidate)
    return sum(1 for term in signals.comparison_terms if comparison_term_matches(term, text))


def has_direct_comparison_signal(candidate: Candidate) -> bool:
    title = f" {candidate.title.lower()} "
    text = combined_candidate_text(candidate)
    return any(hint in title or hint in text for hint in COMPARISON_TITLE_HINTS)


def has_comparison_noise(candidate: Candidate) -> bool:
    text = combined_candidate_text(candidate)
    return any(hint in text for hint in COMPARISON_NOISE_HINTS)


def is_low_value_comparison_page(candidate: Candidate) -> bool:
    parsed = urlparse(candidate.url)
    domain = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    title = candidate.title.lower().strip()
    years = candidate_years(candidate)
    return (
        "/message-id/" in path
        or "/about/event" in path
        or path.rstrip("/") == "/docs"
        or domain == "wiki.postgresql.org"
        or "mailing list" in title
        or ("documentation" in title and "difference" not in title and "comparison" not in title)
        or title.startswith("re:")
        or ": re:" in title
        or (years and max(years) < 2020)
    )


def comparison_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.wants_comparison:
        return 0.0
    if is_low_value_comparison_page(candidate):
        return -0.55
    matched = comparison_match_count(candidate, signals)
    direct = has_direct_comparison_signal(candidate)
    score = 0.0
    if len(signals.comparison_terms) >= 2:
        if matched >= 2:
            score += 0.32
        elif matched == 1:
            score -= 0.14
        else:
            score -= 0.28
    if direct:
        score += 0.26
        if matched >= 2:
            score += 0.12
    else:
        score -= 0.08
    if has_comparison_noise(candidate) and not direct:
        score -= 0.36
    return max(-0.55, min(0.7, score))


def data_domains_for_signals(signals: QuerySignals) -> set[str]:
    domains: set[str] = set()
    if signals.wants_market_data:
        domains.update(MARKET_DATA_DOMAINS)
    if signals.wants_macro_data:
        domains.update(MACRO_DATA_DOMAINS)
    if signals.wants_population_data:
        domains.update(POPULATION_DATA_DOMAINS)
    if not domains:
        domains.update(DATA_AUTHORITY_DOMAINS)
    return domains


def data_indicator_match(candidate: Candidate, signals: QuerySignals) -> bool:
    text = combined_candidate_text(candidate)
    hints: list[str] = []
    if signals.wants_market_data:
        hints.extend(["market cap", "stock", "share", "市值", "股价", "股票", "行情"])
    if signals.wants_macro_data:
        hints.extend(["gdp", "growth", "inflation", "增长", "增长率", "通胀"])
    if signals.wants_population_data:
        hints.extend(["population", "人口"])
    if not hints:
        hints.extend(["data", "数据", "statistics", "统计"])
    return any(hint in text for hint in hints)


def data_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.wants_data:
        return 0.0
    domain = domain_of(candidate.url)
    score = 0.0
    if domain_matches(domain, data_domains_for_signals(signals)):
        score += 0.45
    elif domain_matches(domain, NEWS_AUTHORITY_DOMAINS):
        score -= 0.06
    if data_indicator_match(candidate, signals):
        score += 0.12
    elif domain_matches(domain, DATA_AUTHORITY_DOMAINS):
        score += 0.04
    else:
        score -= 0.12
    years = candidate_years(candidate)
    if not signals.explicit_years and years:
        newest_year = max(years)
        if newest_year < 2025:
            score -= min(0.32, 0.1 * (2025 - newest_year))
    if not re.search(r"\d", candidate.title + candidate.content):
        score -= 0.06
    return max(-0.45, min(0.62, score))


def language_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if signals.query_language != "zh":
        return 0.0
    text = candidate.title + " " + candidate.content
    domain = domain_of(candidate.url)
    if has_japanese_kana(text):
        return -0.22
    if re.search(r"\.(fi|jp|de|fr|ru|br|it|es|nl)$", domain) and not has_cjk(text):
        return -0.16
    return 0.0


def health_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.wants_health:
        return 0.0
    domain = domain_of(candidate.url)
    text = combined_candidate_text(candidate)
    score = 0.0
    if domain_matches(domain, HEALTH_AUTHORITY_DOMAINS):
        score += 0.55
    if any(hint in text or hint in domain for hint in HEALTH_LOW_QUALITY_HINTS):
        score -= 0.24
    if any(hint in text or hint in domain for hint in HEALTH_QA_LOW_QUALITY_HINTS):
        score -= 0.16
    if "医院" in text and not domain_matches(domain, HEALTH_AUTHORITY_DOMAINS):
        score -= 0.18
    return max(-0.42, min(0.65, score))


def job_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.wants_jobs:
        return 0.0
    domain = domain_of(candidate.url)
    text = combined_candidate_text(candidate)
    query_cities = query_city_terms(" ".join(signals.anchors))
    score = 0.0
    if domain_matches(domain, JOB_AUTHORITY_DOMAINS):
        score += 0.35
    if any(hint in text for hint in JOB_LIST_HINTS):
        score += 0.2
    if query_cities:
        if any(city in text for city in query_cities):
            score += 0.14
        elif any(city in text for city in ZH_CITY_HINTS):
            score -= 0.24
    if re.search(r"/company/|/campus|hotjob|wecruit|hr\.", candidate.url.lower()):
        score -= 0.22
    return max(-0.3, min(0.45, score))


def is_single_company_job_page(candidate: Candidate) -> bool:
    text = combined_candidate_text(candidate)
    return bool(
        re.search(r"/companys?/|/campus|hotjob|wecruit|hr\.", candidate.url.lower())
        or ("有限公司招聘" in text and "招聘网" not in text and "人才网" not in text)
    )


def is_job_list_like(candidate: Candidate) -> bool:
    domain = domain_of(candidate.url)
    text = combined_candidate_text(candidate)
    return domain_matches(domain, JOB_AUTHORITY_DOMAINS) and any(hint in text for hint in JOB_LIST_HINTS)


def local_recommendation_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    if not signals.wants_local_recommendation:
        return 0.0
    domain = domain_of(candidate.url)
    score = 0.0
    if domain_matches(domain, LOCAL_RECOMMENDATION_DOMAINS):
        score += 0.16
    years = candidate_years(candidate)
    if years and max(years) < 2023:
        score -= 0.18
    return max(-0.22, min(0.24, score))


def cleanliness_score(candidate: Candidate) -> float:
    title = candidate.title
    title_lower = title.lower()
    score = 0.0
    if len(title) > 210:
        score -= 0.38
    elif len(title) > 170:
        score -= 0.22

    source_markers = (
        "wikipedia",
        "知乎",
        "百度百科",
        "world population",
        "worldometer",
        "countrymeters",
        "united nations",
        "world bank",
        "搜狐",
        "网易",
    )
    marker_count = sum(1 for marker in source_markers if marker in title_lower or marker in title)
    separator_count = sum(title.count(separator) for separator in (" - ", " | ", "_", "—", "·"))
    if marker_count >= 3:
        score -= 0.34
    if separator_count >= 4 and len(title) > 120:
        score -= 0.22
    if title_lower.startswith("full text of") or "archive.org/stream" in candidate.url.lower():
        score -= 0.3
    return max(-0.55, min(0.0, score))


def obvious_ambiguous_result(candidate: Candidate, signals: QuerySignals) -> bool:
    if not signals.short_cjk_fact_query:
        return False
    text = combined_candidate_text(candidate)
    return any(hint in text for hint in AMBIGUOUS_INTENT_HINTS)


def candidate_years(candidate: Candidate) -> set[int]:
    return extract_years(" ".join([candidate.title, candidate.content, candidate.url]))


def current_year() -> int:
    return datetime.now().year


def relative_freshness_score(text: str) -> float:
    if re.search(r"\b\d+\s+(minute|minutes|min|mins|hour|hours|hr|hrs)\s+ago\b", text):
        return 0.18
    if re.search(r"\b\d+\s+(day|days)\s+ago\b", text):
        return 0.15
    if re.search(r"\b\d+\s+(week|weeks)\s+ago\b", text):
        return 0.08
    if re.search(r"\b\d+\s+(month|months)\s+ago\b", text):
        return 0.02
    if re.search(r"\d+\s*(分钟前|小时前)", text):
        return 0.18
    if re.search(r"\d+\s*天前", text):
        return 0.15
    if re.search(r"\d+\s*(周前|星期前)", text):
        return 0.08
    return 0.0


def recency_score(candidate: Candidate, signals: QuerySignals) -> float:
    score = 0.0
    text = combined_candidate_text(candidate)
    years = candidate_years(candidate)
    if signals.explicit_years:
        target_year = max(signals.explicit_years)
        if target_year in years:
            score += 0.16
        elif years:
            newest_year = max(years)
            if newest_year < target_year:
                score -= min(0.48, 0.16 * (target_year - newest_year))
            elif newest_year > target_year + 1:
                score -= 0.08
    if signals.wants_news:
        score += relative_freshness_score(text)
        if not signals.explicit_years and years:
            newest_year = max(years)
            target_year = current_year()
            if newest_year >= target_year:
                score += 0.12
            elif newest_year == target_year - 1:
                score += 0.03
            else:
                score -= min(0.45, 0.14 * (target_year - newest_year))
        if not years and "ago" not in text and "前" not in text:
            score -= 0.04
    return max(-0.52, min(0.28, score))


def source_quality_score(candidate: Candidate, signals: QuerySignals) -> float:
    domain = domain_of(candidate.url)
    score = 0.0
    if signals.wants_news:
        if domain_matches(domain, NEWS_AUTHORITY_DOMAINS):
            score += 0.5 if candidate.category == "news" else 0.42
        if any(hint in domain for hint in NEWS_AGGREGATOR_DOMAIN_HINTS):
            score -= 0.18
        if is_low_quality_domain(domain):
            score -= 0.28
        if signals.wants_ai:
            score += 0.08 if candidate_has_ai_signal(candidate) else -0.22
    if signals.wants_weather and domain_matches(domain, WEATHER_AUTHORITY_DOMAINS):
        score += 0.22
    if signals.wants_tech:
        if (
            signals.preferred_domains
            and domain_matches(domain, signals.preferred_domains)
            and has_important_tech_match(candidate, signals)
        ):
            score += 0.18
        if domain in {"youtube.com", "youtu.be", "m.youtube.com"}:
            score -= 0.08
    score += comparison_quality_score(candidate, signals)
    score += data_quality_score(candidate, signals)
    score += language_quality_score(candidate, signals)
    score += health_quality_score(candidate, signals)
    score += job_quality_score(candidate, signals)
    score += local_recommendation_quality_score(candidate, signals)
    return max(-0.7, min(0.95, score))


def ambiguity_score(candidate: Candidate, signals: QuerySignals) -> float:
    if obvious_ambiguous_result(candidate, signals):
        return -0.5
    if signals.short_cjk_fact_query:
        text = combined_candidate_text(candidate)
        focus_hints = [hint for hint in CJK_FACT_HINTS if hint in " ".join(signals.anchors)]
        if focus_hints and not any(hint in text for hint in focus_hints):
            return -0.24
    return 0.0


def score_candidate(candidate: Candidate, signals: QuerySignals) -> float:
    rrf_norm = min(1.0, candidate.rrf_score / 0.055)
    length_score = 0.0
    if 8 <= len(candidate.title) <= 160:
        length_score += 0.06
    if 40 <= len(candidate.content) <= 900:
        length_score += 0.08
    duplicate_score = min(0.1, max(0, len(candidate.duplicate_providers) - 1) * 0.04)
    news_score = 0.16 if signals.wants_news and candidate.category == "news" else 0.04 if candidate.category == "news" else 0.0
    return (
        0.34 * rrf_norm
        + 0.24 * candidate.bm25_score
        + text_overlap_score(signals.tokens, candidate.title, candidate.content)
        + domain_quality_score(domain_of(candidate.url))
        + length_score
        + duplicate_score
        + candidate.anchor_score
        + candidate.official_score
        + candidate.source_quality_score
        + candidate.recency_score
        + candidate.ambiguity_score
        + candidate.cleanliness_score
        + news_score
    )


def is_news_query(query: str) -> bool:
    if is_weather_query(query):
        return False
    lowered = query.lower()
    return any(hint in lowered for hint in NEWS_QUERY_HINTS) or any(
        hint in query for hint in NEWS_QUERY_CJK_HINTS
    )


def infer_region(query: str) -> str:
    return "cn-zh" if any("\u4e00" <= ch <= "\u9fff" for ch in query) else "us-en"


def candidate_regions(query: str, signals: QuerySignals) -> list[str]:
    primary = infer_region(query)
    if has_cjk(query):
        return [primary, "wt-wt"] if primary != "wt-wt" else [primary]
    return [primary]


def ddgs_proxy_from_env() -> str | None:
    for key in (
        "AGENTVIS_NETWORK_PROXY_URL",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
        "DDGS_PROXY",
    ):
        value = os.environ.get(key)
        if value:
            return value
    return None


def import_ddgs() -> tuple[Any, type[Exception], type[Exception], type[Exception]]:
    try:
        from ddgs import DDGS
        from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"ddgs is not available in the AgentVis Python runtime: {exc}") from exc
    return DDGS, DDGSException, RatelimitException, TimeoutException


def raw_result_url(result: dict[str, Any]) -> str:
    return str(result.get("href") or result.get("url") or result.get("content") or "").strip()


def raw_result_provider(result: dict[str, Any], fallback: str) -> str:
    return compact_text(result.get("source") or result.get("provider") or fallback, 80) or fallback


def append_unique(values: list[str], value: str) -> None:
    normalized = compact_text(value, 500)
    if normalized and normalized not in values:
        values.append(normalized)


def build_query_variants(query: str, signals: QuerySignals, search_depth: str) -> list[str]:
    rewritten_query = rewrite_chinese_natural_query(query, signals)
    variants = [rewritten_query]
    append_unique(variants, query)
    year_terms = " ".join(str(year) for year in sorted(signals.explicit_years))
    if signals.wants_weather:
        places = infer_cjk_place_terms(query)
        if places:
            append_unique(variants, f"{places[0]} 天气预报 今天 实时")
        append_unique(variants, f"{query} 天气预报 实时")
    if signals.wants_time:
        places = infer_cjk_place_terms(query)
        if places:
            append_unique(variants, f"{places[0]} 当前时间 time now")
        append_unique(variants, f"{query} current time")
    if signals.wants_news:
        append_unique(variants, f"{query} {current_year()}")
        if has_cjk(query):
            if signals.wants_ai:
                append_unique(variants, f"{query} 人工智能 AI 大模型 OpenAI Anthropic")
                append_unique(variants, f"{year_terms} 今日 AI 新闻 人工智能 大模型")
            else:
                append_unique(variants, f"{query} 今日 最新 权威 新闻")
                append_unique(variants, f"{query} 财联社 新华社 澎湃 科技")
        elif signals.wants_ai:
            append_unique(variants, f"{query} artificial intelligence OpenAI Anthropic DeepMind Nvidia")
            append_unique(variants, f"latest artificial intelligence news today OpenAI Anthropic Nvidia {year_terms}")
        else:
            append_unique(variants, f"{query} Reuters AP BBC Bloomberg CNBC")

    if signals.short_cjk_fact_query:
        append_unique(variants, f"{query} 答案 百科 科普")

    if signals.wants_comparison:
        if signals.comparison_terms:
            terms = " ".join(signals.comparison_terms)
            append_unique(variants, f"{terms} comparison difference benchmark")
        if has_cjk(query):
            append_unique(variants, f"{query} 区别 差异 评测")
        else:
            append_unique(variants, f"{query} differences comparison")

    if signals.wants_data:
        alias_terms = " ".join(alias for key, alias in DATA_ENTITY_ALIASES.items() if key in query)
        if signals.wants_market_data:
            append_unique(variants, f"{query} {alias_terms} market cap stock quote finance")
            append_unique(variants, f"{query} Yahoo Finance Investing 东方财富")
        elif signals.wants_macro_data:
            append_unique(variants, f"{query} Trading Economics World Bank IMF data")
            append_unique(variants, f"{query} 世界银行 TradingEconomics 国家统计局")
            append_unique(variants, f"site:tradingeconomics.com {query}")
            append_unique(variants, f"site:data.worldbank.org.cn {query}")
        elif signals.wants_population_data:
            append_unique(variants, f"{query} UN Worldometer Countrymeters population")
            append_unique(variants, f"site:worldometers.info {query}")
            append_unique(variants, f"site:population.un.org {query}")
        else:
            append_unique(variants, f"{query} data statistics source")

    if signals.wants_health:
        append_unique(variants, f"{query} 权威 建议 国家卫健委 WHO")
        append_unique(variants, f"site:news.cctv.com {query}")
        append_unique(variants, f"site:nhc.gov.cn {query}")

    if signals.wants_jobs:
        append_unique(variants, f"{query} 招聘网 职位 列表")

    if signals.wants_local_recommendation:
        append_unique(variants, f"{query} 最新 评价 榜单")

    if signals.wants_tech:
        lowered = query.lower()
        if "pkce" in lowered or "oauth" in lowered:
            append_unique(variants, f"{query} Authlib code_verifier code_challenge authorization code")
        append_unique(variants, f"official docs {query}")
        for domain in sorted(signals.preferred_domains)[:2]:
            append_unique(variants, f"site:{domain} {query}")

    limit = 6 if search_depth == "advanced" else 5 if (
        signals.wants_comparison or signals.wants_data or signals.wants_health
    ) else 4
    return variants[:limit]


def variant_text_backends(signals: QuerySignals, search_depth: str) -> list[str]:
    if search_depth == "advanced":
        return ["google", "bing", "duckduckgo"]
    if signals.short_cjk_fact_query:
        return ["bing", "duckduckgo", "auto"]
    if signals.wants_news:
        return ["bing", "duckduckgo"]
    if signals.wants_comparison or signals.wants_data or signals.wants_jobs or signals.wants_health:
        return ["bing", "duckduckgo"]
    if signals.wants_tech:
        return ["bing", "duckduckgo"]
    return ["bing"]


def query_mentions_today(query: str) -> bool:
    lowered = query.lower()
    return "today" in lowered or "今天" in query or "今日" in query


def infer_timelimit(query: str, signals: QuerySignals) -> str | None:
    if query_mentions_today(query):
        return "d"
    lowered = query.lower()
    if "this week" in lowered or "recent" in lowered or "最近" in query:
        return "w"
    if signals.wants_news or signals.explicit_years:
        return "m"
    return None


def variant_collection_limit(signals: QuerySignals, search_depth: str) -> int:
    if search_depth == "advanced":
        return 5
    if signals.wants_data or signals.wants_health:
        return 3
    if signals.wants_news or signals.wants_weather or signals.wants_time:
        return 2
    if signals.wants_comparison or signals.wants_tech or signals.short_cjk_fact_query:
        return 1
    return 0


def variant_soft_budget_seconds(signals: QuerySignals, search_depth: str) -> float:
    if search_depth == "advanced":
        return 65.0
    if signals.wants_data or signals.wants_health or signals.wants_news:
        return 30.0
    if signals.wants_weather or signals.wants_time:
        return 24.0
    if signals.wants_comparison or signals.wants_tech:
        return 22.0
    return 18.0


def should_continue_variant_collection(
    candidates: list[Candidate],
    signals: QuerySignals,
    search_depth: str,
    max_results: int,
    collection_started: float,
) -> bool:
    if search_depth == "advanced":
        return True
    if unique_candidate_count(candidates) < max(8, max_results * 2):
        return True
    return (perf_counter() - collection_started) < variant_soft_budget_seconds(signals, search_depth)


def text_backend_plan(search_depth: str) -> tuple[list[str], int]:
    if search_depth == "advanced":
        return ["google", "bing", "brave", "duckduckgo", "wikipedia", "auto"], 3
    return ["bing", "brave", "duckduckgo", "wikipedia", "auto"], 2


def combined_backend_plan(search_depth: str) -> list[str]:
    if search_depth == "advanced":
        return ["google,bing,brave,duckduckgo", "bing,brave,duckduckgo,wikipedia", "auto"]
    return ["bing,brave,duckduckgo,wikipedia", "auto"]


def unique_candidate_count(candidates: list[Candidate]) -> int:
    return len({candidate.url for candidate in candidates})


def should_stop_text_collection(
    search_depth: str,
    attempted_count: int,
    successful_count: int,
    candidates: list[Candidate],
    max_results: int,
    minimum_backends: int,
) -> bool:
    if attempted_count < minimum_backends or successful_count < 2:
        return False
    unique_count = unique_candidate_count(candidates)
    if search_depth == "advanced":
        return unique_count >= max(12, max_results * 3)
    return unique_count >= max(8, max_results * 2)


def ddgs_text_worker_limit(search_depth: str, backend_count: int) -> int:
    configured = os.environ.get("AGENTVIS_DDGS_TEXT_BACKEND_WORKERS")
    if configured:
        try:
            requested = int(configured)
        except ValueError:
            requested = 0
        if requested > 0:
            return max(1, min(backend_count, requested, 4))

    default_limit = 3 if search_depth == "advanced" else 2
    return max(1, min(backend_count, default_limit))


def classify_ddgs_error(
    exc: Exception,
    RatelimitException: type[Exception],
    TimeoutException: type[Exception],
) -> str:
    if isinstance(exc, RatelimitException):
        return "rate_limited"
    if isinstance(exc, TimeoutException):
        return "timeout"
    text = f"{type(exc).__name__}: {exc}".lower()
    if any(hint in text for hint in DDGS_RATE_LIMIT_ERROR_HINTS):
        return "rate_limited"
    if "timed out" in text or "timeout" in text:
        return "timeout"
    return "provider_error"


def backend_parts(backend: str) -> list[str]:
    return [part.strip() for part in backend.split(",") if part.strip()]


def should_skip_rate_limited_backend(backend: str, rate_limited_backends: set[str]) -> bool:
    return any(part in rate_limited_backends for part in backend_parts(backend))


def mark_rate_limited_backend(backend: str, rate_limited_backends: set[str]) -> None:
    rate_limited_backends.update(backend_parts(backend))


def search_text_backend(
    DDGS: Any,
    RatelimitException: type[Exception],
    TimeoutException: type[Exception],
    proxy: str | None,
    timeout: int,
    query: str,
    regions: list[str],
    backend: str,
    timelimit: str | None,
    max_results: int,
) -> TextBackendAttempt:
    started = perf_counter()
    diagnostics: list[Diagnostic] = []
    last_error: Exception | None = None
    error_kind: str | None = None
    used_region = regions[0] if regions else "wt-wt"

    try:
        with DDGS(proxy=proxy, timeout=timeout) as ddgs:
            for region in regions:
                try:
                    raw_results = ddgs.text(
                        query,
                        region=region,
                        safesearch="moderate",
                        timelimit=timelimit,
                        max_results=max_results,
                        backend=backend,
                    )
                    return TextBackendAttempt(
                        backend=backend,
                        used_region=region,
                        results=list(raw_results or []),
                        elapsed=perf_counter() - started,
                    )
                except Exception as exc:
                    last_error = exc
                    error_kind = classify_ddgs_error(exc, RatelimitException, TimeoutException)
                    diagnostics.append(
                        Diagnostic(
                            "warn",
                            f"text backend {backend}/{region} failed: {type(exc).__name__}: {exc}",
                        )
                    )
                    if error_kind == "rate_limited":
                        break
    except Exception as exc:
        last_error = exc
        error_kind = classify_ddgs_error(exc, RatelimitException, TimeoutException)
        diagnostics.append(
            Diagnostic("warn", f"text backend {backend} failed to initialize: {type(exc).__name__}: {exc}")
        )

    return TextBackendAttempt(
        backend=backend,
        used_region=used_region,
        results=None,
        elapsed=perf_counter() - started,
        diagnostics=diagnostics,
        last_error=last_error,
        error_kind=error_kind,
    )


def append_text_candidates(
    candidates: list[Candidate],
    raw_results: list[dict[str, Any]],
    provider: str,
    category: str,
    rank_provider: str | None = None,
) -> None:
    for rank, result in enumerate(raw_results):
        candidate = normalize_result(result, rank, provider, category, rank_provider=rank_provider)
        if candidate:
            candidates.append(candidate)


def collect_primary_text_results(
    DDGS: Any,
    RatelimitException: type[Exception],
    TimeoutException: type[Exception],
    proxy: str | None,
    timeout: int,
    primary_query: str,
    regions: list[str],
    text_timelimit: str | None,
    overfetch: int,
    backend_attempts: list[str],
    search_depth: str,
    max_results: int,
    minimum_backends: int,
    candidates: list[Candidate],
    diagnostics: list[Diagnostic],
) -> tuple[int, int, Exception | None, set[str]]:
    worker_limit = ddgs_text_worker_limit(search_depth, len(backend_attempts))
    if worker_limit > 1:
        diagnostics.append(Diagnostic("info", f"using {worker_limit}-way DDGS text backend concurrency"))

    attempted_backends = 0
    successful_backends = 0
    last_error: Exception | None = None
    rate_limited_backends: set[str] = set()

    for wave_start in range(0, len(backend_attempts), worker_limit):
        wave = [
            backend
            for backend in backend_attempts[wave_start:wave_start + worker_limit]
            if not should_skip_rate_limited_backend(backend, rate_limited_backends)
        ]
        if not wave:
            continue

        if len(wave) == 1:
            outcomes = [
                search_text_backend(
                    DDGS,
                    RatelimitException,
                    TimeoutException,
                    proxy,
                    timeout,
                    primary_query,
                    regions,
                    wave[0],
                    text_timelimit,
                    overfetch,
                )
            ]
        else:
            with ThreadPoolExecutor(max_workers=len(wave), thread_name_prefix="ddgs-text") as executor:
                futures = [
                    executor.submit(
                        search_text_backend,
                        DDGS,
                        RatelimitException,
                        TimeoutException,
                        proxy,
                        timeout,
                        primary_query,
                        regions,
                        backend,
                        text_timelimit,
                        overfetch,
                    )
                    for backend in wave
                ]
                outcomes = [future.result() for future in as_completed(futures)]

        for outcome in outcomes:
            attempted_backends += 1
            diagnostics.extend(outcome.diagnostics)
            if outcome.last_error:
                last_error = outcome.last_error
            if outcome.error_kind == "rate_limited":
                mark_rate_limited_backend(outcome.backend, rate_limited_backends)
            if outcome.results is None:
                continue

            successful_backends += 1
            diagnostics.append(
                Diagnostic(
                    "info",
                    (
                        f"text backend {outcome.backend}/{outcome.used_region} returned "
                        f"{len(outcome.results)} results in {outcome.elapsed:.2f}s"
                    ),
                )
            )
            append_text_candidates(candidates, outcome.results, outcome.backend, "text")

        if should_stop_text_collection(
            search_depth,
            attempted_backends,
            successful_backends,
            candidates,
            max_results,
            minimum_backends,
        ):
            break

    return attempted_backends, successful_backends, last_error, rate_limited_backends


def normalize_result(
    result: dict[str, Any],
    rank: int,
    provider: str,
    category: str,
    rank_provider: str | None = None,
) -> Candidate | None:
    url = normalize_url(raw_result_url(result))
    if not url:
        return None
    title = compact_text(result.get("title"), 220)
    content = compact_text(
        result.get("body")
        or result.get("description")
        or result.get("snippet")
        or result.get("content"),
        900,
    )
    if not title and not content:
        return None
    if not title:
        title = domain_of(url) or url
    return Candidate(
        title=title,
        url=url,
        content=content,
        rank=rank,
        provider=provider,
        category=category,
        duplicate_providers={provider},
        rank_signals={rank_provider or provider: rank},
    )


def collect_ddgs_results(
    query: str,
    max_results: int,
    search_depth: str,
    diagnostics: list[Diagnostic],
) -> list[Candidate]:
    DDGS, _DDGSException, RatelimitException, TimeoutException = import_ddgs()
    proxy = ddgs_proxy_from_env()
    signals = extract_query_signals(query)
    regions = candidate_regions(query, signals)
    query_variants = build_query_variants(query, signals, search_depth)
    primary_query = query_variants[0] if query_variants else query
    text_timelimit = infer_timelimit(query, signals) if signals.wants_news else None
    overfetch = min(12, max(8, max_results * 2))
    timeout = 12 if search_depth == "advanced" else 8
    backend_attempts, minimum_backends = text_backend_plan(search_depth)

    candidates: list[Candidate] = []
    last_error: Exception | None = None
    collection_started = perf_counter()
    if len(query_variants) > 1:
        diagnostics.append(Diagnostic("info", f"using {len(query_variants)} DDGS query variants"))

    (
        _attempted_backends,
        _successful_backends,
        primary_error,
        rate_limited_backends,
    ) = collect_primary_text_results(
        DDGS,
        RatelimitException,
        TimeoutException,
        proxy,
        timeout,
        primary_query,
        regions,
        text_timelimit,
        overfetch,
        backend_attempts,
        search_depth,
        max_results,
        minimum_backends,
        candidates,
        diagnostics,
    )
    if primary_error:
        last_error = primary_error

    with DDGS(proxy=proxy, timeout=timeout) as ddgs:
        extra_variants = query_variants[1:1 + variant_collection_limit(signals, search_depth)]
        for variant_index, variant in enumerate(extra_variants, start=1):
            if not should_continue_variant_collection(candidates, signals, search_depth, max_results, collection_started):
                diagnostics.append(Diagnostic("info", f"skipped remaining DDGS query variants after {variant_index - 1} extra variant(s)"))
                break
            variant_overfetch = min(8, max(5, max_results))
            for backend in variant_text_backends(signals, search_depth):
                if should_skip_rate_limited_backend(backend, rate_limited_backends):
                    diagnostics.append(Diagnostic("info", f"skipped rate-limited text backend {backend}"))
                    continue
                started = perf_counter()
                raw_results = None
                used_region = regions[0]
                for region in regions:
                    try:
                        raw_results = ddgs.text(
                            variant,
                            region=region,
                            safesearch="moderate",
                            timelimit=text_timelimit,
                            max_results=variant_overfetch,
                            backend=backend,
                        )
                        used_region = region
                        break
                    except Exception as exc:
                        last_error = exc
                        error_kind = classify_ddgs_error(exc, RatelimitException, TimeoutException)
                        if error_kind == "rate_limited":
                            mark_rate_limited_backend(backend, rate_limited_backends)
                        diagnostics.append(
                            Diagnostic(
                                "warn",
                                (
                                    f"variant {variant_index} text backend {backend}/{region} failed: "
                                    f"{type(exc).__name__}: {exc}"
                                ),
                            )
                        )
                        if error_kind == "rate_limited":
                            break
                if raw_results is None:
                    continue
                diagnostics.append(
                    Diagnostic(
                        "info",
                        (
                            f"variant {variant_index} text backend {backend}/{used_region} returned "
                            f"{len(raw_results)} results in {perf_counter() - started:.2f}s"
                        ),
                    )
                )
                append_text_candidates(
                    candidates,
                    raw_results,
                    backend,
                    "text",
                    rank_provider=f"{backend}/q{variant_index}",
                )

        if not candidates:
            for backend in combined_backend_plan(search_depth):
                if should_skip_rate_limited_backend(backend, rate_limited_backends):
                    diagnostics.append(Diagnostic("info", f"skipped rate-limited combined backend {backend}"))
                    continue
                started = perf_counter()
                raw_results = None
                used_region = regions[0]
                for region in regions:
                    try:
                        raw_results = ddgs.text(
                            primary_query,
                            region=region,
                            safesearch="moderate",
                            timelimit=text_timelimit,
                            max_results=max(10, max_results * 2),
                            backend=backend,
                        )
                        used_region = region
                        break
                    except Exception as exc:
                        last_error = exc
                        error_kind = classify_ddgs_error(exc, RatelimitException, TimeoutException)
                        if error_kind == "rate_limited":
                            mark_rate_limited_backend(backend, rate_limited_backends)
                        diagnostics.append(
                            Diagnostic(
                                "warn",
                                f"combined text backend {backend}/{region} failed: {type(exc).__name__}: {exc}",
                            )
                        )
                        if error_kind == "rate_limited":
                            break
                if raw_results is None:
                    continue
                diagnostics.append(
                    Diagnostic(
                        "info",
                        (
                            f"combined text backend {backend}/{used_region} returned {len(raw_results)} results "
                            f"in {perf_counter() - started:.2f}s"
                        ),
                    )
                )
                for rank, result in enumerate(raw_results):
                    candidate = normalize_result(result, rank, raw_result_provider(result, backend), "text")
                    if candidate:
                        candidates.append(candidate)
                if candidates:
                    break

        if signals.wants_news:
            news_timelimit = infer_timelimit(query, signals) or "m"
            news_variant_limit = 3 if search_depth == "advanced" else 2
            news_backends = ("bing", "duckduckgo", "yahoo") if search_depth == "advanced" else ("bing", "duckduckgo")
            for variant_index, variant in enumerate(query_variants[:news_variant_limit]):
                if not should_continue_variant_collection(candidates, signals, search_depth, max_results, collection_started):
                    diagnostics.append(Diagnostic("info", f"skipped remaining DDGS news variants after {variant_index} variant(s)"))
                    break
                for backend in news_backends:
                    if should_skip_rate_limited_backend(backend, rate_limited_backends):
                        diagnostics.append(Diagnostic("info", f"skipped rate-limited news backend {backend}"))
                        continue
                    news_provider = f"news:{backend}"
                    raw_news = None
                    used_region = regions[0]
                    for region in regions:
                        try:
                            raw_news = ddgs.news(
                                variant,
                                region=region,
                                safesearch="moderate",
                                timelimit=news_timelimit,
                                max_results=min(8, overfetch),
                                backend=backend,
                            )
                            used_region = region
                            break
                        except Exception as exc:
                            error_kind = classify_ddgs_error(exc, RatelimitException, TimeoutException)
                            if error_kind == "rate_limited":
                                mark_rate_limited_backend(backend, rate_limited_backends)
                            diagnostics.append(
                                Diagnostic(
                                    "warn",
                                    (
                                        f"news backend {backend}/{region} variant {variant_index} failed: "
                                        f"{type(exc).__name__}: {exc}"
                                    ),
                                )
                            )
                            if error_kind == "rate_limited":
                                break
                    if raw_news is None:
                        continue
                    diagnostics.append(
                        Diagnostic(
                            "info",
                            (
                                f"news backend {backend}/{used_region} variant {variant_index} "
                                f"returned {len(raw_news)} results"
                            ),
                        )
                    )
                    append_text_candidates(
                        candidates,
                        raw_news,
                        news_provider,
                        "news",
                        rank_provider=f"{news_provider}/q{variant_index}",
                    )

    if not candidates and last_error:
        raise RuntimeError(f"DDGS search failed: {type(last_error).__name__}: {last_error}") from last_error
    return candidates


def should_keep_after_gate(candidate: Candidate, signals: QuerySignals, rank_index: int) -> bool:
    domain = domain_of(candidate.url)
    if candidate.cleanliness_score <= -0.5:
        return False
    if candidate.cleanliness_score <= -0.34 and candidate.score < 0.82:
        return False
    if signals.wants_comparison:
        matched = comparison_match_count(candidate, signals)
        direct = has_direct_comparison_signal(candidate)
        if is_low_value_comparison_page(candidate):
            return False
        if has_comparison_noise(candidate) and not direct:
            return False
        if len(signals.comparison_terms) >= 2 and matched < 2 and candidate.score < 0.78:
            return False
        if not direct and candidate.score < 0.82:
            return False
    if signals.wants_data:
        data_domain = domain_matches(domain, data_domains_for_signals(signals))
        if not data_domain and candidate.source_quality_score < 0:
            return False
        if signals.wants_macro_data and not data_domain and candidate.url.lower().endswith(".pdf"):
            return False
        if not data_domain and not data_indicator_match(candidate, signals) and candidate.score < 0.74:
            return False
        years = candidate_years(candidate)
        if not signals.explicit_years and years and max(years) < 2024 and not data_domain:
            return False
    if signals.wants_health:
        text = combined_candidate_text(candidate)
        if "医院" in text and not domain_matches(domain, HEALTH_AUTHORITY_DOMAINS):
            return False
        if (
            any(hint in text or hint in domain for hint in HEALTH_LOW_QUALITY_HINTS)
            and not domain_matches(domain, HEALTH_AUTHORITY_DOMAINS)
        ):
            return False
    if signals.wants_jobs:
        cities = query_city_terms(" ".join(signals.anchors))
        text = combined_candidate_text(candidate)
        if is_single_company_job_page(candidate) and not is_job_list_like(candidate):
            return False
        if not domain_matches(domain, JOB_AUTHORITY_DOMAINS) and not any(hint in text for hint in ("招聘网", "人才网")):
            return False
        if cities and not any(city in text for city in cities) and any(city in text for city in ZH_CITY_HINTS):
            return False
    if obvious_ambiguous_result(candidate, signals):
        return False
    if signals.short_cjk_fact_query and candidate.ambiguity_score < 0 and candidate.score < 0.74:
        return False
    if signals.wants_news and signals.explicit_years:
        years = candidate_years(candidate)
        if years and max(years) < max(signals.explicit_years) - 1:
            return False
    if signals.wants_news and not signals.explicit_years:
        years = candidate_years(candidate)
        if years and max(years) < current_year() - 1 and candidate.score < 0.84:
            return False
    if signals.wants_news and signals.wants_ai and not candidate_has_ai_signal(candidate) and candidate.score < 0.58:
        return False
    if signals.wants_news and is_low_quality_domain(domain) and candidate.score < 0.72:
        return False

    if signals.wants_github:
        content_anchors = {
            anchor
            for anchor in signals.anchors
            if anchor not in {"github", "repo", "repository"} and anchor not in GENERIC_ANCHOR_TERMS
        }
        if domain == "github.com" and (not content_anchors or content_anchors & candidate.matched_anchors):
            return True
        return False

    if not signals.anchors and not signals.site_domains and not signals.wants_github:
        return True
    if candidate.anchor_score >= 0.08 or candidate.official_score >= 0.18:
        return True
    if candidate.bm25_score >= 0.34 and candidate.score >= 0.42:
        return True
    if len(candidate.duplicate_providers) >= 2 and candidate.score >= 0.52:
        return True
    if rank_index < 2 and candidate.score >= 0.55:
        return True
    return False


def rerank_and_filter(
    candidates: list[Candidate],
    query: str,
    max_results: int,
    search_depth: str = "basic",
    diagnostics: list[Diagnostic] | None = None,
) -> list[Candidate]:
    merged: dict[str, Candidate] = {}
    for candidate in candidates:
        existing = merged.get(candidate.url)
        if existing:
            existing.duplicate_providers.update(candidate.duplicate_providers)
            for provider, rank in candidate.rank_signals.items():
                current_rank = existing.rank_signals.get(provider)
                if current_rank is None or rank < current_rank:
                    existing.rank_signals[provider] = rank
            if len(candidate.content) > len(existing.content):
                existing.content = candidate.content
            if len(candidate.title) > len(existing.title):
                existing.title = candidate.title
            existing.rank = min(existing.rank, candidate.rank)
            continue
        merged[candidate.url] = candidate

    signals = extract_query_signals(query)
    scored = list(merged.values())
    bm25_scores = compute_bm25_scores(scored, query, signals)
    for candidate in scored:
        candidate.rrf_score = rrf_score_candidate(candidate)
        candidate.bm25_score = bm25_scores.get(candidate.url, 0.0)
        candidate.anchor_score = anchor_match_score(candidate, signals)
        candidate.official_score = official_source_score(candidate, signals)
        candidate.source_quality_score = source_quality_score(candidate, signals)
        candidate.recency_score = recency_score(candidate, signals)
        candidate.ambiguity_score = ambiguity_score(candidate, signals)
        candidate.cleanliness_score = cleanliness_score(candidate)
        candidate.score = score_candidate(candidate, signals)

    scored.sort(key=lambda item: item.score, reverse=True)
    gated = [
        candidate
        for index, candidate in enumerate(scored)
        if should_keep_after_gate(candidate, signals, index)
    ]
    if diagnostics is not None and len(gated) != len(scored):
        diagnostics.append(
            Diagnostic(
                "info",
                f"ranking gate kept {len(gated)} of {len(scored)} unique DDGS candidates",
            )
        )
    if gated:
        scored = gated

    domain_counts: dict[str, int] = {}
    filtered: list[Candidate] = []
    domain_limit = 1 if search_depth == "advanced" else 2
    for candidate in scored:
        domain = registrable_domain(domain_of(candidate.url))
        if domain_counts.get(domain, 0) >= domain_limit:
            continue
        domain_counts[domain] = domain_counts.get(domain, 0) + 1
        filtered.append(candidate)
        if len(filtered) >= max_results:
            break
    max_score = max((candidate.score for candidate in filtered), default=0.0)
    if max_score > 0:
        for candidate in filtered:
            candidate.score = candidate.score / max_score
    if diagnostics is not None:
        diagnostics.append(
            Diagnostic(
                "info",
                (
                    f"ranked {len(merged)} unique DDGS candidates with RRF, BM25 and anchors; "
                    f"returned {len(filtered)}"
                ),
            )
        )
    return filtered


def scraper_scripts_dir() -> Path | None:
    candidates: list[Path] = []
    resource_dir = os.environ.get("AGENTVIS_RESOURCE_DIR")
    if resource_dir:
        candidates.append(Path(resource_dir) / "skills-bundle" / "web-scraper" / "scripts")

    current = Path(__file__).resolve()
    for parent in current.parents:
        candidates.append(parent / "skills-bundle" / "web-scraper" / "scripts")

    for candidate in candidates:
        if (candidate / "scrape.py").is_file():
            return candidate
    return None


def extract_with_web_scraper(url: str, proxy: str | None, timeout: float) -> tuple[str, str]:
    scripts_dir = scraper_scripts_dir()
    if not scripts_dir:
        return "", "web-scraper scripts were not found"

    sys.path.insert(0, str(scripts_dir))
    try:
        import scrape  # type: ignore
    except Exception as exc:
        return "", f"failed to import web-scraper scrape.py: {exc}"

    log_buffer = io.StringIO()
    client = None
    try:
        with contextlib.redirect_stdout(log_buffer), contextlib.redirect_stderr(log_buffer):
            client = scrape.create_http_client(  # type: ignore[attr-defined]
                timeout=timeout,
                proxy=proxy,
                headers=None,
                user_agent=scrape.DEFAULT_USER_AGENT,  # type: ignore[attr-defined]
                impersonate=None,
            )
            result = scrape.scrape_single_page(  # type: ignore[attr-defined]
                client,
                url,
                selector=None,
                exclude_selectors=scrape.DEFAULT_EXCLUDE_SELECTORS[:],  # type: ignore[attr-defined]
                include_links=False,
                include_images=False,
                forced_encoding=None,
                download_images_flag=False,
                use_trafilatura=True,
            )
        content = compact_markdown(str(result.get("content_md") or ""))
        return content, log_buffer.getvalue().strip()
    except Exception as exc:
        return "", (log_buffer.getvalue().strip() + f"\n{type(exc).__name__}: {exc}").strip()
    finally:
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()
        if sys.path and sys.path[0] == str(scripts_dir):
            sys.path.pop(0)


def extract_with_fallback(url: str, proxy: str | None, timeout: float) -> tuple[str, str]:
    try:
        import httpx
        import trafilatura
        from bs4 import BeautifulSoup
    except Exception as exc:
        return "", f"fallback extractor dependencies unavailable: {exc}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, proxy=proxy, headers=headers) as client:
            response = client.get(url)
            response.raise_for_status()
            final_url = str(response.url)
            html = response.text
    except Exception as exc:
        return "", f"fallback fetch failed: {type(exc).__name__}: {exc}"

    try:
        extracted = trafilatura.extract(
            html,
            url=final_url,
            output_format="markdown",
            include_links=True,
            include_images=False,
            favor_precision=True,
        )
    except Exception:
        extracted = None
    if extracted and len(extracted.strip()) >= 200:
        return compact_markdown(extracted), "trafilatura fallback extractor"

    soup = BeautifulSoup(html, "lxml")
    for selector in ("nav", "header", "footer", "script", "style", "noscript", ".sidebar", ".ads"):
        for node in soup.select(selector):
            node.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = main.get_text("\n", strip=True)
    return compact_markdown(text), "beautifulsoup fallback extractor"


def compact_markdown(markdown: str, limit: int = 12000) -> str:
    markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")
    markdown = re.sub(r"<img\b[^>]*>", "", markdown, flags=re.IGNORECASE)
    markdown = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", markdown)
    markdown = re.sub(r"(?im)^\s*data:image/[^ \n]+\s*$", "", markdown)
    markdown = re.sub(
        r"(?im)^\s*https?://\S+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?\S*)?\s*$",
        "",
        markdown,
    )
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()
    if len(markdown) <= limit:
        return markdown
    cutoff = markdown.rfind("\n", 0, limit)
    if cutoff < int(limit * 0.7):
        cutoff = limit
    return markdown[:cutoff].rstrip() + "\n\n... [content truncated by DDGS helper] ..."


def enrich_with_content(
    candidates: list[Candidate],
    include_content: bool,
    diagnostics: list[Diagnostic],
) -> None:
    if not include_content:
        return

    proxy = ddgs_proxy_from_env()
    max_pages = min(5, len(candidates))
    for candidate in candidates[:max_pages]:
        content, detail = extract_with_web_scraper(candidate.url, proxy, timeout=12.0)
        if not content:
            content, fallback_detail = extract_with_fallback(candidate.url, proxy, timeout=12.0)
            detail = "; ".join(part for part in (detail, fallback_detail) if part)
        if content:
            candidate.raw_content = content
            diagnostics.append(Diagnostic("info", f"extracted content for {candidate.url}: {len(content)} chars"))
        elif detail:
            diagnostics.append(Diagnostic("warn", f"content extraction failed for {candidate.url}: {detail[:500]}"))


def candidate_to_dict(candidate: Candidate) -> dict[str, Any]:
    data: dict[str, Any] = {
        "title": candidate.title,
        "url": candidate.url,
        "content": candidate.content,
        "score": round(max(0.0, min(1.0, candidate.score)), 4),
        "provider": "ddgs",
        "source": ",".join(sorted(candidate.duplicate_providers)) or candidate.provider,
    }
    if candidate.raw_content:
        data["raw_content"] = candidate.raw_content
    return data


def run_request(request: dict[str, Any]) -> dict[str, Any]:
    query = compact_text(request.get("query"), 500)
    if not query:
        raise ValueError("query is required")

    max_results = clamp_int(request.get("max_results"), 5, 1, 10)
    search_depth = str(request.get("search_depth") or "basic").lower()
    if search_depth not in {"basic", "advanced"}:
        search_depth = "basic"
    include_content = bool(request.get("include_raw_content"))

    diagnostics: list[Diagnostic] = []
    started = perf_counter()
    candidates = collect_ddgs_results(query, max_results, search_depth, diagnostics)
    ranked = rerank_and_filter(candidates, query, max_results, search_depth, diagnostics)
    enrich_with_content(ranked, include_content, diagnostics)
    diagnostics.append(Diagnostic("info", f"DDGS helper completed in {perf_counter() - started:.2f}s"))

    return {
        "ok": True,
        "query": query,
        "answer": None,
        "provider": "ddgs",
        "results": [candidate_to_dict(candidate) for candidate in ranked],
        "diagnostics": [diagnostic.__dict__ for diagnostic in diagnostics],
    }


def error_kind(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if any(hint in text for hint in DDGS_RATE_LIMIT_ERROR_HINTS):
        return "rate_limited"
    if "timed out" in text or "timeout" in text:
        return "timeout"
    if "ddgs is not available" in text or "no module named" in text:
        return "runtime_unavailable"
    if "query is required" in text:
        return "bad_request"
    return "provider_error"


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        response = run_request(request)
        print(json.dumps(response, ensure_ascii=False))
        return 0
    except Exception as exc:
        response = {
            "ok": False,
            "provider": "ddgs",
            "errorKind": error_kind(exc),
            "error": f"{type(exc).__name__}: {exc}",
            "results": [],
            "answer": None,
            "diagnostics": [],
        }
        print(json.dumps(response, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
