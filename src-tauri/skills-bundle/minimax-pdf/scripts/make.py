#!/usr/bin/env python3
"""
make.py — minimax-pdf 统一 CLI（跨平台版）

用法:
    python scripts/make.py check
    python scripts/make.py fix
    python scripts/make.py run  --title T --type TYPE [--author A] [--date D]
                                [--subtitle S] [--abstract A] [--cover-image URL]
                                [--accent #HEX] [--cover-bg #HEX]
                                [--content content.json] [--out output.pdf]
    python scripts/make.py fill   --input form.pdf [--out filled.pdf]
                                  [--values '{...}'] [--data values.json] [--inspect]
    python scripts/make.py reformat --input doc.md --title T --type TYPE --out output.pdf
    python scripts/make.py demo

退出码: 0 成功, 1 参数错误, 2 依赖缺失, 3 运行时错误
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


# ── 路径常量 ────────────────────────────────────────────────────────────────────
SCRIPTS = Path(__file__).parent.resolve()


def _detect_python() -> str:
    """
    检测可用的 Python 可执行文件。
    Windows Store 中存在 python3.exe 占位程序（exit code 9009），需跳过。
    """
    for candidate in ("python3", "python"):
        exe = shutil.which(candidate)
        if not exe:
            continue
        try:
            result = subprocess.run(
                [exe, "--version"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                return candidate
        except Exception:
            continue
    return "python"  # 最后兜底


# 优先使用 python3，Windows Store 占位程序会被跳过
_PY   = _detect_python()
_NODE = "node"


# Windows 控制台默认编码为 cp1252，无法输出 ✓ ⚠ 等符号；强制切换为 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ── 彩色输出（不依赖 bash 的 ANSI helper）──────────────────────────────────────
def _red(msg: str)    -> None: print(f"\033[0;31m{msg}\033[0m")
def _green(msg: str)  -> None: print(f"\033[0;32m{msg}\033[0m")
def _yellow(msg: str) -> None: print(f"\033[0;33m{msg}\033[0m")
def _bold(msg: str)   -> None: print(f"\033[1m{msg}\033[0m")


# ── 子进程执行封装 ──────────────────────────────────────────────────────────────
def _run(cmd: list[str], check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    """运行子进程，失败时抛出 subprocess.CalledProcessError。"""
    return subprocess.run(cmd, check=check, **kwargs)


# ── check ──────────────────────────────────────────────────────────────────────
def cmd_check() -> None:
    ok = True
    _bold("Checking dependencies...")

    # Python
    py = shutil.which(_PY) or shutil.which("python")
    if py:
        ver = subprocess.check_output([py, "--version"], stderr=subprocess.STDOUT,
                                       text=True).strip()
        _green(f"  ✓ {ver}")
    else:
        _red("  ✗ python3 / python not found")
        ok = False

    # reportlab
    if _py_import_ok("reportlab"):
        _green("  ✓ reportlab")
    else:
        _yellow("  ⚠ reportlab not installed  (run: make.py fix)")
        ok = False

    # pypdf
    if _py_import_ok("pypdf"):
        _green("  ✓ pypdf")
    else:
        _yellow("  ⚠ pypdf not installed  (run: make.py fix)")
        ok = False

    # Node.js
    node = shutil.which(_NODE)
    if node:
        ver = subprocess.check_output([node, "--version"], stderr=subprocess.STDOUT,
                                       text=True).strip()
        _green(f"  ✓ node {ver}")
    else:
        _red("  ✗ node not found — cover rendering unavailable")
        ok = False

    # Playwright
    if _node_module_ok("playwright"):
        _green("  ✓ playwright")
    else:
        _yellow("  ⚠ playwright not found  (run: make.py fix)")
        ok = False

    # matplotlib（可选）
    if _py_import_ok("matplotlib"):
        _green("  ✓ matplotlib (math, chart, flowchart blocks enabled)")
    else:
        _yellow("  ⚠ matplotlib not installed — math/chart/flowchart blocks degrade to text  (run: make.py fix)")

    if ok:
        _green("\nAll dependencies satisfied.")
        sys.exit(0)
    else:
        _yellow("\nSome dependencies missing. Run: python scripts/make.py fix")
        sys.exit(2)


def _py_import_ok(pkg: str) -> bool:
    """检查 Python 包是否可导入。"""
    result = subprocess.run(
        [_py_exe(), "-c", f"import {pkg}"],
        capture_output=True,
    )
    return result.returncode == 0


def _node_module_ok(module: str) -> bool:
    """检查 Node.js 模块是否可用（全局或本地都算）。"""
    node = shutil.which(_NODE)
    if not node:
        return False
    result = subprocess.run(
        [node, "-e", f"require('{module}')"],
        capture_output=True,
    )
    return result.returncode == 0


def _py_exe() -> str:
    """返回当前可用的 Python 可执行文件路径。"""
    return shutil.which(_PY) or shutil.which("python") or "python"


# ── fix ────────────────────────────────────────────────────────────────────────
def cmd_fix() -> None:
    _bold("Installing missing dependencies...")
    rc = 0

    # Python 包
    py = _py_exe()
    try:
        _run([py, "-m", "pip", "install", "--break-system-packages", "-q",
              "reportlab", "pypdf", "matplotlib"],
             capture_output=True)
        _green("  ✓ Python packages installed (reportlab, pypdf, matplotlib)")
    except subprocess.CalledProcessError:
        try:
            _run([py, "-m", "pip", "install", "-q",
                  "reportlab", "pypdf", "matplotlib"],
                 capture_output=True)
            _green("  ✓ Python packages installed (reportlab, pypdf, matplotlib)")
        except subprocess.CalledProcessError:
            _yellow("  pip install failed — try: pip install reportlab pypdf matplotlib")
            rc = 3

    # Playwright
    npm = shutil.which("npm")
    npx = shutil.which("npx")
    if npm and npx:
        try:
            _run(["npm", "install", "-g", "playwright", "--silent"], capture_output=True)
            _run(["npx", "playwright", "install", "chromium", "--silent"], capture_output=True)
            _green("  ✓ Playwright + Chromium installed")
        except subprocess.CalledProcessError:
            _yellow("  playwright install failed — try manually")
            rc = 3
    else:
        _yellow("  npm/npx not found — cannot install Playwright automatically")
        rc = 2

    if rc == 0:
        _green("\nAll dependencies installed. Run: python scripts/make.py check")
    sys.exit(rc)


# ── run ────────────────────────────────────────────────────────────────────────
def cmd_run(
    title: str,
    doc_type: str,
    author: str = "",
    date: str = "",
    subtitle: str = "",
    abstract: str = "",
    cover_image: str = "",
    accent: str = "",
    cover_bg: str = "",
    content_file: str = "",
    out: str = "output.pdf",
) -> None:
    """完整 pipeline：design tokens → cover → body → merged PDF。"""
    py      = _py_exe()
    node    = shutil.which(_NODE) or _NODE
    workdir = tempfile.mkdtemp(prefix="minimax_pdf_")

    try:
        _bold(f"Building: {title}")
        print(f"  Type    : {doc_type}")
        print(f"  Output  : {out}")

        # ── Step 1: palette → tokens.json ─────────────────────────────────────
        print()
        _bold("Step 1/4  Generating design tokens...")
        tokens_path = os.path.join(workdir, "tokens.json")
        palette_cmd = [py, str(SCRIPTS / "palette.py"),
                       "--title", title, "--type", doc_type,
                       "--author", author, "--date", date,
                       "--out", tokens_path]
        if accent:
            palette_cmd += ["--accent", accent]
        if cover_bg:
            palette_cmd += ["--cover-bg", cover_bg]
        _run(palette_cmd)

        # 注入可选封面字段（abstract / cover_image）到 tokens.json
        if abstract or cover_image:
            with open(tokens_path, encoding="utf-8") as f:
                t = json.load(f)
            if abstract:
                t["abstract"] = abstract
            if cover_image:
                t["cover_image"] = cover_image
            with open(tokens_path, "w", encoding="utf-8") as f:
                json.dump(t, f, indent=2, ensure_ascii=False)

        # 打印 tokens 摘要
        with open(tokens_path, encoding="utf-8") as f:
            t = json.load(f)
        print(f"  Mood    : {t['mood']}")
        print(f"  Pattern : {t['cover_pattern']}")
        print(f"  Fonts   : {t['font_display']} / {t['font_body']}")
        if t.get("font_paths"):
            chosen = list(t["font_paths"].values())[0]
            print(f"  CJK     : {os.path.basename(chosen)}")

        # ── Step 2: cover HTML + render ───────────────────────────────────────
        print()
        _bold("Step 2/4  Rendering cover...")
        cover_html = os.path.join(workdir, "cover.html")
        cover_pdf  = os.path.join(workdir, "cover.pdf")
        cover_cmd  = [py, str(SCRIPTS / "cover.py"),
                      "--tokens", tokens_path,
                      "--out", cover_html]
        if subtitle:
            cover_cmd += ["--subtitle", subtitle]
        _run(cover_cmd)
        _run([node, str(SCRIPTS / "render_cover.js"),
              "--input", cover_html, "--out", cover_pdf])
        _green("  ✓ Cover rendered")

        # ── Step 3: body PDF ──────────────────────────────────────────────────
        print()
        _bold("Step 3/4  Rendering body pages...")
        body_pdf = os.path.join(workdir, "body.pdf")

        if not content_file:
            # 生成占位内容
            placeholder_path = os.path.join(workdir, "content.json")
            placeholder = [
                {"type": "h1",   "text": "Document Body"},
                {"type": "body", "text": "Replace this with your content.json file using --content path/to/content.json"},
                {"type": "body", "text": "See SKILL.md for the full list of supported block types."},
            ]
            with open(placeholder_path, "w", encoding="utf-8") as f:
                json.dump(placeholder, f, ensure_ascii=False)
            content_file = placeholder_path
            _yellow("  No content file provided — using placeholder body.")

        _run([py, str(SCRIPTS / "render_body.py"),
              "--tokens", tokens_path,
              "--content", content_file,
              "--out", body_pdf])
        _green("  ✓ Body rendered")

        # ── Step 4: merge ─────────────────────────────────────────────────────
        print()
        _bold("Step 4/4  Merging and QA...")
        _run([py, str(SCRIPTS / "merge.py"),
              "--cover", cover_pdf,
              "--body",  body_pdf,
              "--out",   out,
              "--title", title])

        _green(f"\n✓ Done — {out}")

    finally:
        # 清理临时目录
        shutil.rmtree(workdir, ignore_errors=True)


# ── fill ──────────────────────────────────────────────────────────────────────
def cmd_fill(
    input_pdf: str,
    out: str = "",
    values: str = "",
    data_file: str = "",
    inspect_only: bool = False,
) -> None:
    py = _py_exe()

    if not input_pdf:
        print("Usage: make.py fill --input form.pdf [--out filled.pdf] "
              "[--values '{...}'] [--data values.json] [--inspect]")
        sys.exit(1)

    if inspect_only or (not out and not values and not data_file):
        _bold(f"Inspecting form fields in: {input_pdf}")
        _run([py, str(SCRIPTS / "fill_inspect.py"), "--input", input_pdf])
        return

    _bold(f"Filling form: {input_pdf} → {out}")
    fill_cmd = [py, str(SCRIPTS / "fill_write.py"),
                "--input", input_pdf, "--out", out]
    if values:
        fill_cmd += ["--values", values]
    if data_file:
        fill_cmd += ["--data", data_file]
    _run(fill_cmd)


# ── reformat ───────────────────────────────────────────────────────────────────
def cmd_reformat(
    input_doc: str,
    title: str = "Reformatted Document",
    doc_type: str = "general",
    author: str = "",
    date: str = "",
    subtitle: str = "",
    out: str = "output.pdf",
) -> None:
    if not input_doc:
        print("Usage: make.py reformat --input source.md --title T --type TYPE --out output.pdf")
        sys.exit(1)

    py      = _py_exe()
    tmpdir  = tempfile.mkdtemp(prefix="minimax_reformat_")

    try:
        _bold(f"Parsing: {input_doc}")
        content_json = os.path.join(tmpdir, "content.json")
        _run([py, str(SCRIPTS / "reformat_parse.py"),
              "--input", input_doc, "--out", content_json])
        _green("  ✓ Parsed to content.json")

        _bold("Applying design and building PDF...")
        cmd_run(
            title=title, doc_type=doc_type,
            author=author, date=date, subtitle=subtitle,
            content_file=content_json, out=out,
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── demo ──────────────────────────────────────────────────────────────────────
DEMO_CONTENT = [
    {"type": "h1",      "text": "Executive Summary"},
    {"type": "body",    "text": "This document was generated by minimax-pdf — a skill for creating visually polished PDFs. Every design decision is rooted in the document type and content, not a generic template."},
    {"type": "callout", "text": "Key insight: design tokens flow from palette.py through every renderer, keeping cover and body visually consistent."},
    {"type": "h1",      "text": "How It Works"},
    {"type": "h2",      "text": "The Token Pipeline"},
    {"type": "body",    "text": "The palette.py script infers a color palette and typography pair from the document type."},
    {"type": "numbered","text": "palette.py generates color tokens, font selection, and the cover pattern"},
    {"type": "numbered","text": "cover.py renders the cover HTML using the selected pattern"},
    {"type": "numbered","text": "render_cover.js uses Playwright to convert the HTML cover to PDF"},
    {"type": "numbered","text": "render_body.py builds inner pages from content.json using ReportLab"},
    {"type": "numbered","text": "merge.py combines cover + body and runs final QA checks"},
    {"type": "h2",      "text": "Cover Patterns"},
    {"type": "table",
      "headers": ["Pattern",      "Document type",   "Visual character"],
      "rows": [
        ["fullbleed",   "report, general",  "Deep background, dot-grid texture"],
        ["split",       "proposal",         "Left dark panel, right dot-grid"],
        ["typographic", "resume, academic", "Oversized display type, first-word accent"],
        ["atmospheric", "portfolio",        "Dark bg, radial glow, dot-grid"],
    ]},
    {"type": "h1",      "text": "Code Example"},
    {"type": "code",    "language": "python",
      "text": "# Design token pipeline\ntokens = palette.build_tokens(\n    title='Annual Report',\n    doc_type='report',\n)\nhtml = cover.render(tokens)\npdf  = render_cover(html)"},
    {"type": "pagebreak"},
    {"type": "bibliography",
      "title": "References",
      "items": [
        {"id": "1", "text": "Bringhurst, R. (2004). The Elements of Typographic Style. Hartley & Marks."},
        {"id": "2", "text": "Cairo, A. (2016). The Truthful Art. New Riders."},
    ]},
]


def cmd_demo() -> None:
    tmpdir = tempfile.mkdtemp(prefix="minimax_demo_")
    try:
        content_path = os.path.join(tmpdir, "content.json")
        with open(content_path, "w", encoding="utf-8") as f:
            json.dump(DEMO_CONTENT, f, ensure_ascii=False, indent=2)

        from datetime import datetime
        month_year = datetime.now().strftime("%B %Y")
        cmd_run(
            title="minimax-pdf demo",
            doc_type="report",
            author="minimax-pdf skill",
            date=month_year,
            subtitle="A demonstration of the token-based design pipeline",
            content_file=content_path,
            out="demo.pdf",
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── CLI dispatch ───────────────────────────────────────────────────────────────
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="make.py",
        description="minimax-pdf — cross-platform build CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # check
    sub.add_parser("check", help="Verify all dependencies")

    # fix
    sub.add_parser("fix", help="Auto-install missing deps")

    # run
    p_run = sub.add_parser("run", help="CREATE: full pipeline → PDF")
    p_run.add_argument("--title",       default="Untitled Document")
    p_run.add_argument("--type",        default="general", dest="doc_type")
    p_run.add_argument("--author",      default="")
    p_run.add_argument("--date",        default="")
    p_run.add_argument("--subtitle",    default="")
    p_run.add_argument("--abstract",    default="")
    p_run.add_argument("--cover-image", default="", dest="cover_image")
    p_run.add_argument("--accent",      default="")
    p_run.add_argument("--cover-bg",    default="", dest="cover_bg")
    p_run.add_argument("--content",     default="", dest="content_file")
    p_run.add_argument("--out",         default="output.pdf")

    # fill
    p_fill = sub.add_parser("fill", help="FILL: inspect or fill form fields")
    p_fill.add_argument("--input",   required=True, dest="input_pdf")
    p_fill.add_argument("--out",     default="")
    p_fill.add_argument("--values",  default="")
    p_fill.add_argument("--data",    default="", dest="data_file")
    p_fill.add_argument("--inspect", action="store_true", dest="inspect_only")

    # reformat
    p_ref = sub.add_parser("reformat", help="REFORMAT: parse existing doc → apply design → PDF")
    p_ref.add_argument("--input",    required=True, dest="input_doc")
    p_ref.add_argument("--title",    default="Reformatted Document")
    p_ref.add_argument("--type",     default="general", dest="doc_type")
    p_ref.add_argument("--author",   default="")
    p_ref.add_argument("--date",     default="")
    p_ref.add_argument("--subtitle", default="")
    p_ref.add_argument("--out",      default="output.pdf")

    # demo
    sub.add_parser("demo", help="Build a full-featured demo PDF")

    return parser


def main() -> None:
    parser = _build_parser()
    args   = parser.parse_args()

    try:
        if args.command == "check":
            cmd_check()
        elif args.command == "fix":
            cmd_fix()
        elif args.command == "run":
            cmd_run(
                title=args.title, doc_type=args.doc_type,
                author=args.author, date=args.date, subtitle=args.subtitle,
                abstract=args.abstract, cover_image=args.cover_image,
                accent=args.accent, cover_bg=args.cover_bg,
                content_file=args.content_file, out=args.out,
            )
        elif args.command == "fill":
            cmd_fill(
                input_pdf=args.input_pdf, out=args.out,
                values=args.values, data_file=args.data_file,
                inspect_only=args.inspect_only,
            )
        elif args.command == "reformat":
            cmd_reformat(
                input_doc=args.input_doc, title=args.title,
                doc_type=args.doc_type, author=args.author,
                date=args.date, subtitle=args.subtitle, out=args.out,
            )
        elif args.command == "demo":
            cmd_demo()
    except subprocess.CalledProcessError as e:
        _red(f"\nCommand failed (exit {e.returncode}): {' '.join(str(a) for a in e.cmd)}")
        sys.exit(3)
    except KeyboardInterrupt:
        print()
        sys.exit(1)


if __name__ == "__main__":
    main()
