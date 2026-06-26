/**
 * DependencyAnalyzer 单元测试
 *
 * 验证静态依赖分析器的各个子功能：
 * - Python import 语句提取
 * - Markdown 代码块内 import 提取
 * - `# Requires: pip install` 注释解析
 * - 标准库过滤
 * - Import→Pip 名称映射
 * - 基础包去重
 * - 综合分析
 */

import { describe, it, expect } from 'vitest';
import {
    extractImportsFromPython,
    extractImportsFromMarkdownCodeBlocks,
    extractRequiresComments,
    extractPipInstallFromMarkdown,
    extractNpmInstallFromMarkdown,
    extractNpxPackagesFromMarkdown,
    extractCargoInstallFromMarkdown,
    extractGoInstallFromMarkdown,
    extractSystemToolHints,
    mapImportToPip,
    parseBasePackageNames,
    analyzeDependencies,
} from '../DependencyAnalyzer';

// ═══════════════════════════════════════════════════════════════
// extractImportsFromPython
// ═══════════════════════════════════════════════════════════════

describe('extractImportsFromPython', () => {
    it('应该提取 import 语句', () => {
        const code = `
import fitz
import numpy
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('fitz');
        expect(result).toContain('numpy');
    });

    it('应该提取 from...import 语句', () => {
        const code = `
from pypdf import PdfReader, PdfWriter
from PIL import Image
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('pypdf');
        expect(result).toContain('PIL');
    });

    it('应该提取多级模块的顶级名称', () => {
        const code = `
import xml.etree.ElementTree
from reportlab.lib.pagesizes import letter
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('xml');
        expect(result).toContain('reportlab');
    });

    it('应该处理 import as 别名', () => {
        const code = `
import numpy as np
import pandas as pd
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('numpy');
        expect(result).toContain('pandas');
        expect(result).not.toContain('np');
        expect(result).not.toContain('pd');
    });

    it('应该处理多模块 import', () => {
        const code = `import os, sys, json, requests`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('os');
        expect(result).toContain('sys');
        expect(result).toContain('json');
        expect(result).toContain('requests');
    });

    it('应该跳过注释行中的 import', () => {
        const code = `
# import should_be_skipped
# from another import thing
import real_package
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('real_package');
        expect(result).not.toContain('should_be_skipped');
        expect(result).not.toContain('another');
    });

    it('应该跳过相对导入', () => {
        const code = `
from . import utils
from .core import helper
from ..base import BaseClass
`;
        const result = extractImportsFromPython(code);
        // 相对导入都以 . 开头，不匹配 ^from\s+([a-zA-Z_]\w*)
        expect(result).toHaveLength(0);
    });

    it('应该去重', () => {
        const code = `
import numpy
import numpy
from numpy import array
`;
        const result = extractImportsFromPython(code);
        const numpyCount = result.filter(r => r === 'numpy').length;
        expect(numpyCount).toBe(1);
    });

    it('空输入应该返回空数组', () => {
        expect(extractImportsFromPython('')).toEqual([]);
    });

    it('应该保留带 ImportError 处理的导入，避免漏扫真实功能依赖', () => {
        const code = `
try:
    import charset_normalizer
except ImportError:
    charset_normalizer = None

try:
    import h2
except ModuleNotFoundError:
    h2 = None

import requests
`;
        const result = extractImportsFromPython(code);
        expect(result).toContain('requests');
        expect(result).toContain('charset_normalizer');
        expect(result).toContain('h2');
    });
});

// ═══════════════════════════════════════════════════════════════
// extractImportsFromMarkdownCodeBlocks
// ═══════════════════════════════════════════════════════════════

describe('extractImportsFromMarkdownCodeBlocks', () => {
    it('应该从 python 代码块中提取 import', () => {
        const markdown = `
## Quick Start

\`\`\`python
from pypdf import PdfReader
import pdfplumber
reader = PdfReader("doc.pdf")
\`\`\`
`;
        const result = extractImportsFromMarkdownCodeBlocks(markdown);
        expect(result).toContain('pypdf');
        expect(result).toContain('pdfplumber');
    });

    it('应该从多个代码块中提取', () => {
        const markdown = `
\`\`\`python
import fitz
\`\`\`

Some text here.

\`\`\`python
from reportlab.lib.pagesizes import letter
\`\`\`
`;
        const result = extractImportsFromMarkdownCodeBlocks(markdown);
        expect(result).toContain('fitz');
        expect(result).toContain('reportlab');
    });

    it('应该忽略非 python 代码块', () => {
        const markdown = `
\`\`\`bash
pip install fitz
\`\`\`

\`\`\`javascript
import React from 'react';
\`\`\`
`;
        const result = extractImportsFromMarkdownCodeBlocks(markdown);
        expect(result).toHaveLength(0);
    });

    it('应该支持 py 语言标记', () => {
        const markdown = `
\`\`\`py
import scipy
\`\`\`
`;
        const result = extractImportsFromMarkdownCodeBlocks(markdown);
        expect(result).toContain('scipy');
    });

    it('无代码块时返回空数组', () => {
        expect(extractImportsFromMarkdownCodeBlocks('# Title\nSome text')).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════
// extractRequiresComments
// ═══════════════════════════════════════════════════════════════

describe('extractRequiresComments', () => {
    it('应该解析 Requires: pip install 注释', () => {
        const text = '# Requires: pip install pytesseract pdf2image';
        const result = extractRequiresComments(text);
        expect(result).toContain('pytesseract');
        expect(result).toContain('pdf2image');
    });

    it('应该不区分大小写', () => {
        const text = '# requires: pip install SomePackage';
        const result = extractRequiresComments(text);
        expect(result).toContain('SomePackage');
    });

    it('应该支持逗号分隔', () => {
        const text = '# Requires: pip install scipy, networkx';
        const result = extractRequiresComments(text);
        expect(result).toContain('scipy');
        expect(result).toContain('networkx');
    });

    it('不匹配的格式应返回空数组', () => {
        const text = `
# This is a regular comment
# pip install something
## Requires: pip install hidden
`;
        const result = extractRequiresComments(text);
        // 只有 `# Requires:` 格式匹配，`## Requires:` 因为 ## 不匹配 ^# 的模式
        expect(result).toHaveLength(0);
    });

    it('应该过滤非法包名', () => {
        const text = '# Requires: pip install valid-pkg 123invalid';
        const result = extractRequiresComments(text);
        expect(result).toContain('valid-pkg');
        expect(result).not.toContain('123invalid');
    });
});

// ═══════════════════════════════════════════════════════════════
// extractPipInstallFromMarkdown
// ═══════════════════════════════════════════════════════════════

describe('extractPipInstallFromMarkdown', () => {
    it('应该从 Dependencies 列表项中提取包名', () => {
        const markdown = `
## Dependencies

- \`pip install "markitdown[pptx]"\` - text extraction
- \`pip install Pillow\` - thumbnail grids
`;
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toContain('markitdown[pptx]');
        expect(result).toContain('Pillow');
    });

    it('应该处理多个包名', () => {
        const markdown = '`pip install scipy networkx`';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toContain('scipy');
        expect(result).toContain('networkx');
    });

    it('应该处理 pip extras 语法', () => {
        const markdown = '`pip install "markitdown[pptx]"` for parsing';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toContain('markitdown[pptx]');
    });

    it('不应把行内 pip 命令后的自然语言当作包名', () => {
        const markdown = 'Install trafilatura (`pip install trafilatura`) and retry; or use `--selector`.';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toEqual(['trafilatura']);
        expect(result).not.toContain('and');
        expect(result).not.toContain('retry');
    });

    it('应该从命令形态的普通行中提取包名', () => {
        const markdown = 'pip install scipy networkx - optional graph analysis';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toContain('scipy');
        expect(result).toContain('networkx');
        expect(result).not.toContain('optional');
    });

    it('非 shell 代码块不应干扰后续 bash 依赖块', () => {
        const markdown = `
Output example:
\`\`\`markdown
# Video Title

Summary text.
\`\`\`

## Dependencies

\`\`\`bash
pip install yt-dlp
pip install yutto
pip install aiohttp aiofiles gmssl
\`\`\`
`;
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toEqual(['yt-dlp', 'yutto', 'aiohttp', 'aiofiles', 'gmssl']);
    });

    it('不应把英文括号说明当作包名', () => {
        const markdown = 'pip install winocr (Windows native OCR)';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toEqual(['winocr']);
        expect(result).not.toContain('Windows');
        expect(result).not.toContain('native');
    });

    it('不应匹配 npm install', () => {
        const markdown = '- `npm install -g pptxgenjs`';
        const result = extractPipInstallFromMarkdown(markdown);
        expect(result).toHaveLength(0);
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without pip commands';
        expect(extractPipInstallFromMarkdown(markdown)).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════
// mapImportToPip
// ═══════════════════════════════════════════════════════════════

describe('mapImportToPip', () => {
    it('应该映射已知的 import→pip 差异', () => {
        expect(mapImportToPip('fitz')).toBe('PyMuPDF');
        expect(mapImportToPip('cv2')).toBe('opencv-python');
        expect(mapImportToPip('PIL')).toBe('Pillow');
        expect(mapImportToPip('bs4')).toBe('beautifulsoup4');
        expect(mapImportToPip('yaml')).toBe('pyyaml');
        expect(mapImportToPip('dateutil')).toBe('python-dateutil');
        expect(mapImportToPip('docx')).toBe('python-docx');
        expect(mapImportToPip('sklearn')).toBe('scikit-learn');
        expect(mapImportToPip('pillow_heif')).toBe('pillow-heif');
        expect(mapImportToPip('yt_dlp')).toBe('yt-dlp');
    });

    it('未知映射应返回原始名称', () => {
        expect(mapImportToPip('requests')).toBe('requests');
        expect(mapImportToPip('flask')).toBe('flask');
        expect(mapImportToPip('django')).toBe('django');
    });
});

// ═══════════════════════════════════════════════════════════════
// parseBasePackageNames
// ═══════════════════════════════════════════════════════════════

describe('parseBasePackageNames', () => {
    it('应该解析 requirements.txt 格式', () => {
        const content = `
# comment
requests==2.34.2
pypdf>=6.0
numpy~=1.26.4
pandas
`;
        const result = parseBasePackageNames(content);
        expect(result.has('requests')).toBe(true);
        expect(result.has('pypdf')).toBe(true);
        expect(result.has('numpy')).toBe(true);
        expect(result.has('pandas')).toBe(true);
    });

    it('包名应转为小写', () => {
        const content = 'PyYAML==6.0.3\nPillow==12.1.0';
        const result = parseBasePackageNames(content);
        expect(result.has('pyyaml')).toBe(true);
        expect(result.has('pillow')).toBe(true);
    });

    it('应该跳过空行和注释', () => {
        const content = `
# This is a comment

# Another comment
requests
`;
        const result = parseBasePackageNames(content);
        expect(result.size).toBe(1);
        expect(result.has('requests')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// analyzeDependencies（综合测试）
// ═══════════════════════════════════════════════════════════════

describe('analyzeDependencies', () => {
    const basePackages = new Set(['pypdf', 'pillow', 'pandas', 'numpy', 'requests']);

    it('应该从 SKILL.md 代码块中推断依赖', () => {
        const fullContent = `
## Extract Text
\`\`\`python
import pdfplumber
with pdfplumber.open("doc.pdf") as pdf:
    print(pdf.pages[0].extract_text())
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.packages).toContain('pdfplumber');
    });

    it('应该过滤标准库', () => {
        const fullContent = `
\`\`\`python
import os
import json
import pdfplumber
from pathlib import Path
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.packages).not.toContain('os');
        expect(result.packages).not.toContain('json');
        expect(result.packages).not.toContain('pathlib');
        expect(result.packages).toContain('pdfplumber');
    });

    it('应该过滤基础包', () => {
        const fullContent = `
\`\`\`python
from pypdf import PdfReader
import pandas as pd
import pdfplumber
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        // pypdf 和 pandas 在基础包中，不应出现
        expect(result.packages).not.toContain('pypdf');
        expect(result.packages).not.toContain('pandas');
        // pdfplumber 不在基础包中，应出现
        expect(result.packages).toContain('pdfplumber');
    });

    it('应该自动映射 import 名到 pip 名', () => {
        const fullContent = `
\`\`\`python
import fitz  # PyMuPDF
from PIL import Image
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.packages).toContain('PyMuPDF');
        // PIL 映射为 Pillow，但 Pillow 已在基础包中 → 过滤掉
        expect(result.packages).not.toContain('Pillow');
    });

    it('应该合并 Requires 注释和 import 分析', () => {
        const fullContent = `
# Requires: pip install pytesseract pdf2image
\`\`\`python
import pytesseract
from pdf2image import convert_from_path
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.packages).toContain('pytesseract');
        // pdf2image 出现在 import 和 requires 中，应去重
        expect(result.packages).toContain('pdf2image');
        const pdf2imageCount = result.packages.filter(p => p === 'pdf2image').length;
        expect(pdf2imageCount).toBe(1);
    });

    it('应该分析脚本文件内容', () => {
        const scriptContent = `
import scipy
from networkx import Graph
result = scipy.optimize.minimize(func, x0)
`;
        const result = analyzeDependencies('', [scriptContent], basePackages);
        expect(result.packages).toContain('scipy');
        expect(result.packages).toContain('networkx');
    });

    it('video-downloader 风格依赖块应保留 yutto', () => {
        const fullContent = `
Output example:
\`\`\`markdown
# Video Title

Readable transcript text.
\`\`\`

## Dependencies

\`\`\`bash
pip install yt-dlp
pip install yutto
# ffmpeg must be installed and in PATH

# Additional dependencies for Douyin download
pip install aiohttp aiofiles gmssl
\`\`\`
`;
        const scriptContent = `
import yt_dlp
import aiohttp
import aiofiles
import gmssl
`;
        const result = analyzeDependencies(fullContent, [scriptContent], basePackages);
        expect(result.packages).toContain('yt-dlp');
        expect(result.packages).toContain('yutto');
        expect(result.packages).toContain('aiohttp');
        expect(result.packages).toContain('aiofiles');
        expect(result.packages).toContain('gmssl');
    });

    it('应该跳过 Script Skill 模板中的本地 helper 占位模块', () => {
        const scriptContent = `
from pathlib import Path
import script_core
import httpx
`;
        const result = analyzeDependencies('', [scriptContent], new Set(['httpx']));

        expect(result.packages).not.toContain('script_core');
        expect(result.packages).not.toContain('httpx');
    });

    it('空输入应返回空结果', () => {
        const result = analyzeDependencies('', [], basePackages);
        expect(result.packages).toHaveLength(0);
        expect(result.sources).toHaveLength(0);
    });

    it('应该包含来源信息', () => {
        const fullContent = `
# Requires: pip install pytesseract
\`\`\`python
import pdfplumber
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        const pdfplumberSource = result.sources.find(s => s.package === 'pdfplumber');
        expect(pdfplumberSource?.source).toBe('import');

        const tesseractSource = result.sources.find(s => s.package === 'pytesseract');
        expect(tesseractSource?.source).toBe('requires_comment');
    });

    it('Anthropic pdf SKILL.md 风格测试', () => {
        // 模拟 Anthropic pdf SKILL.md 的核心内容片段
        const fullContent = `
## Python Libraries

### pypdf - Basic Operations
\`\`\`python
from pypdf import PdfReader, PdfWriter
reader = PdfReader("document.pdf")
\`\`\`

### pdfplumber - Text and Table Extraction
\`\`\`python
import pdfplumber
with pdfplumber.open("document.pdf") as pdf:
    text = page.extract_text()
\`\`\`

### reportlab - Create PDFs
\`\`\`python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
c = canvas.Canvas("hello.pdf", pagesize=letter)
\`\`\`

### Extract Text from Scanned PDFs
\`\`\`python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path
images = convert_from_path('scanned.pdf')
\`\`\`

## Command-Line Tools
\`\`\`bash
pdftotext input.pdf output.txt
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);

        // 应推断出这些额外依赖（不在基础包中）
        expect(result.packages).toContain('pdfplumber');
        expect(result.packages).toContain('reportlab');
        expect(result.packages).toContain('pytesseract');

        // pypdf 在基础包中 → 不应出现
        expect(result.packages).not.toContain('pypdf');

        // pdf2image 应出现（在基础包中但需确认）
        // 注意：我们的基础包集合没有 pdf2image，所以应出现
        expect(result.packages).toContain('pdf2image');

        // bash 代码块不应被分析
        expect(result.packages).not.toContain('pdftotext');
    });

    it('应该过滤本地脚本模块的互相引用', () => {
        // 模拟 fill_fillable_fields.py 中引用同目录的 extract_form_field_info.py
        const scriptContent = `
from extract_form_field_info import get_field_info
import pdfplumber
from pypdf import PdfWriter
`;
        const localModuleNames = new Set([
            'check_bounding_boxes',
            'check_fillable_fields',
            'convert_pdf_to_images',
            'create_validation_image',
            'extract_form_field_info',
            'extract_form_structure',
            'fill_fillable_fields',
            'fill_pdf_form_with_annotations',
        ]);

        const result = analyzeDependencies('', [scriptContent], basePackages, localModuleNames);

        // extract_form_field_info 是本地模块 → 不应出现
        expect(result.packages).not.toContain('extract_form_field_info');
        // pdfplumber 是真正的第三方依赖 → 应出现
        expect(result.packages).toContain('pdfplumber');
        // pypdf 在基础包中 → 不应出现
        expect(result.packages).not.toContain('pypdf');
    });

    it('应该过滤本地包目录导入并保留真实第三方依赖', () => {
        const scriptContent = `
import anthropic
from scripts.utils import parse_skill_md
from scripts.generate_report import generate_html
`;
        const localModuleNames = new Set(['scripts', 'utils', 'generate_report']);

        const result = analyzeDependencies('', [scriptContent], basePackages, localModuleNames);

        expect(result.packages).toContain('anthropic');
        expect(result.packages).not.toContain('scripts');
        expect(result.packages).not.toContain('utils');
        expect(result.packages).not.toContain('generate_report');
    });

    it('应该避免英文说明造成 web-scraper 风格误判，同时保留真实导入', () => {
        const fullContent = `
## Troubleshooting

| Problem | Solution |
|------|----------|
| Body content is a sidebar/related articles | Install trafilatura (\`pip install trafilatura\`) and retry; or use \`--selector\` to manually specify the body CSS selector |
`;
        const scriptContent = `
try:
    from charset_normalizer import from_bytes as charset_from_bytes
except ImportError:
    charset_from_bytes = None

try:
    import h2
    use_http2 = True
except ImportError:
    pass
`;
        const result = analyzeDependencies(fullContent, [scriptContent], basePackages);

        expect(result.packages).toContain('trafilatura');
        expect(result.packages).not.toContain('and');
        expect(result.packages).not.toContain('retry');
        expect(result.packages).toContain('charset-normalizer');
        expect(result.packages).toContain('h2');
    });

    it('应该保留 try/except ImportError 中的功能依赖并应用 pip 名映射', () => {
        const fullContent = '- pillow-heif (`pip install pillow-heif`)';
        const scriptContent = `
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    HEIF_AVAILABLE = False
`;
        const result = analyzeDependencies(fullContent, [scriptContent], basePackages);

        expect(result.packages).toContain('pillow-heif');
        expect(result.packages).not.toContain('pillow_heif');
    });

    it('Anthropic pptx SKILL.md 风格 - 应提取 Dependencies 部分的 pip install', () => {
        const fullContent = `
## Dependencies

- \`pip install "markitdown[pptx]"\` - text extraction
- \`pip install Pillow\` - thumbnail grids
- \`npm install -g pptxgenjs\` - creating from scratch
`;
        const result = analyzeDependencies(fullContent, [], basePackages);

        // markitdown[pptx] 应被提取
        expect(result.packages).toContain('markitdown[pptx]');
        // Pillow 在基础包中（pillow → 大小写不敏感） → 不应出现
        expect(result.packages).not.toContain('Pillow');
        // npm 包不应出现在 pip packages 中
        expect(result.packages).not.toContain('pptxgenjs');
        // 但应出现在 npmPackages 中
        expect(result.npmPackages).toContain('pptxgenjs');
    });

    it('应该检测 systemTools', () => {
        const fullContent = `
## Command-Line Tools
\`\`\`bash
pdftotext input.pdf output.txt
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        // 系统工具应出现在 systemTools 中
        expect(result.systemTools.length).toBeGreaterThan(0);
        const poppler = result.systemTools.find(t => t.packageName === 'Poppler');
        expect(poppler).toBeDefined();
    });

    it('应该检测 hyperframes-video 本地 ASR 依赖', () => {
        const fullContent = `
## Dependencies

\`\`\`bash
npx hyperframes doctor
ffmpeg --version
git --version
cmake --version
\`\`\`

whisper-bootstrap builds whisper.cpp into the skill cache when ASR is needed.
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        const systemPackageNames = result.systemTools.map(t => t.packageName);

        expect(result.npmPackages).toContain('hyperframes');
        expect(systemPackageNames).toContain('FFmpeg');
        expect(systemPackageNames).toContain('Git');
        expect(systemPackageNames).toContain('CMake');
        expect(systemPackageNames).not.toContain('whisper.cpp');
    });

    it('应该将 npx 调用的包合并到 npmPackages 中', () => {
        const fullContent = `
## How to Use

\`\`\`bash
npx skills find react
npx skills add vercel-labs/agent-skills@vercel-react-best-practices
\`\`\`

You can also install globally: \`npm install -g pptxgenjs\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        // npx skills 和 npm install pptxgenjs 都应出现在 npmPackages 中
        expect(result.npmPackages).toContain('skills');
        expect(result.npmPackages).toContain('pptxgenjs');
    });

    it('npx 和 npm install 同一个包应去重', () => {
        const fullContent = `
Install: \`npm install -g skills\`
Or run directly: \`npx skills find react\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        const skillsCount = result.npmPackages.filter(p => p === 'skills').length;
        expect(skillsCount).toBe(1);
    });

    it('应该检测 cargo 包', () => {
        const fullContent = `
## Prerequisites

\`\`\`bash
cargo install ripgrep
cargo install bat
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.cargoPackages).toContain('ripgrep');
        expect(result.cargoPackages).toContain('bat');
    });

    it('应该检测 go 包', () => {
        const fullContent = `
## Prerequisites

\`\`\`bash
go install golang.org/x/tools/gopls@latest
\`\`\`
`;
        const result = analyzeDependencies(fullContent, [], basePackages);
        expect(result.goPackages).toContain('golang.org/x/tools/gopls');
    });
});

// ═══════════════════════════════════════════════════════════════
// extractNpxPackagesFromMarkdown
// ═══════════════════════════════════════════════════════════════

describe('extractNpxPackagesFromMarkdown', () => {
    it('应该从标准 npx 命令中提取包名', () => {
        const markdown = '\`npx skills find react\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('skills');
        expect(result).toHaveLength(1);
    });

    it('应该跳过 -y/--yes 等标志参数', () => {
        const markdown = '\`npx -y skills add repo@skill\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('skills');
        expect(result).not.toContain('-y');
    });

    it('应该从 bash 代码块中提取', () => {
        const markdown = `
\`\`\`bash
npx prettier --write .
\`\`\`
`;
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('prettier');
    });

    it('应该支持 @scope/name 格式', () => {
        const markdown = '\`npx @anthropic-ai/tool build\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('@anthropic-ai/tool');
    });

    it('应该去除版本号后缀', () => {
        const markdown = '\`npx create-react-app@latest my-app\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('create-react-app');
        expect(result).not.toContain('create-react-app@latest');
    });

    it('应该处理 @scope/name@version 格式', () => {
        const markdown = '\`npx @angular/cli@17 new my-app\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('@angular/cli');
    });

    it('应该跳过 --package 标志的值参数', () => {
        const markdown = '\`npx --package react-scripts start\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        // react-scripts 是 --package 的值，start 才是要执行的命令
        // npx --package 场景中，实际要执行的是 start 命令，不是包名
        expect(result).not.toContain('react-scripts');
    });

    it('应该处理 $ 前缀', () => {
        const markdown = '\`$ npx skills find react\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('skills');
    });

    it('不应匹配 npm install 命令', () => {
        const markdown = '\`npm install -g skills\`';
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toEqual([]);
    });

    it('应该对多个 npx 命令去重', () => {
        const markdown = `
\`\`\`bash
npx skills find react
npx skills add vercel-labs/agent-skills@vercel-react-best-practices
\`\`\`
`;
        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('skills');
        // 两次都是 npx skills，应去重为 1
        const skillsCount = result.filter(p => p === 'skills').length;
        expect(skillsCount).toBe(1);
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without npx commands';
        expect(extractNpxPackagesFromMarkdown(markdown)).toEqual([]);
    });

    it('find-skills SKILL.md 风格测试', () => {
        // 模拟 find-skills SKILL.md 的关键内容
        const markdown = [
            '# Find Skills',
            '',
            '## Key commands:',
            '',
            '- \`npx skills find [query]\` - Search for skills',
            '- \`npx skills add <package>\` - Install a skill',
            '- \`npx skills check\` - Check for updates',
            '',
            '```bash',
            'npx skills find react performance',
            '```',
            '',
            '```bash',
            'npx skills add vercel-labs/agent-skills@vercel-react-best-practices -g -y',
            '```',
            '',
            '```bash',
            'npx skills init my-xyz-skill',
            '```',
        ].join('\n');

        const result = extractNpxPackagesFromMarkdown(markdown);
        expect(result).toContain('skills');
        // 全部都是 npx skills xxx，应该只有 1 个
        expect(result).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════
// extractCargoInstallFromMarkdown
// ═══════════════════════════════════════════════════════════════

describe('extractCargoInstallFromMarkdown', () => {
    it('应该从标准 cargo install 命令中提取包名', () => {
        const markdown = '\`cargo install bat\`';
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toContain('bat');
        expect(result).toHaveLength(1);
    });

    it('应该跳过 --locked 等标志参数', () => {
        const markdown = '\`cargo install --locked fd-find\`';
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toContain('fd-find');
        expect(result).not.toContain('--locked');
    });

    it('应该从 bash 代码块中提取', () => {
        const markdown = `
\`\`\`bash
cargo install ripgrep
cargo install tokei
\`\`\`
`;
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toContain('ripgrep');
        expect(result).toContain('tokei');
    });

    it('应该跳过 --git 标志及其值', () => {
        const markdown = '\`cargo install --git https://github.com/user/repo my-tool\`';
        const result = extractCargoInstallFromMarkdown(markdown);
        // --git 后面的 URL 不应被提取，my-tool 才是包名
        expect(result).toContain('my-tool');
        expect(result).not.toContain('https://github.com/user/repo');
    });

    it('应该处理 $ 前缀', () => {
        const markdown = '\`$ cargo install bat\`';
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toContain('bat');
    });

    it('不应匹配 npm install 命令', () => {
        const markdown = '\`npm install -g bat\`';
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toEqual([]);
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without cargo commands';
        expect(extractCargoInstallFromMarkdown(markdown)).toEqual([]);
    });

    it('应该去重', () => {
        const markdown = `
\`\`\`bash
cargo install bat
cargo install bat
\`\`\`
`;
        const result = extractCargoInstallFromMarkdown(markdown);
        expect(result).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════
// extractGoInstallFromMarkdown
// ═══════════════════════════════════════════════════════════════

describe('extractGoInstallFromMarkdown', () => {
    it('应该从标准 go install 命令中提取包路径', () => {
        const markdown = '\`go install golang.org/x/tools/gopls@latest\`';
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toContain('golang.org/x/tools/gopls');
        expect(result).toHaveLength(1);
    });

    it('应该去除 @version 后缀', () => {
        const markdown = '\`go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.55.0\`';
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toContain('github.com/golangci/golangci-lint/cmd/golangci-lint');
        expect(result).not.toContain('github.com/golangci/golangci-lint/cmd/golangci-lint@v1.55.0');
    });

    it('应该从 bash 代码块中提取', () => {
        const markdown = `
\`\`\`bash
go install golang.org/x/tools/gopls@latest
go install github.com/air-verse/air@latest
\`\`\`
`;
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toContain('golang.org/x/tools/gopls');
        expect(result).toContain('github.com/air-verse/air');
    });

    it('应该处理 $ 前缀', () => {
        const markdown = '\`$ go install golang.org/x/tools/gopls@latest\`';
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toContain('golang.org/x/tools/gopls');
    });

    it('不应匹配非 go install 命令', () => {
        const markdown = '\`go build ./...\`';
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toEqual([]);
    });

    it('不应匹配无域名的路径', () => {
        // go install 需要完整的模块路径（含域名 + /）
        const markdown = '\`go install mypackage@latest\`';
        const result = extractGoInstallFromMarkdown(markdown);
        // mypackage 没有 /，不像域名路径
        expect(result).toEqual([]);
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without go commands';
        expect(extractGoInstallFromMarkdown(markdown)).toEqual([]);
    });

    it('应该去重', () => {
        const markdown = `
\`\`\`bash
go install golang.org/x/tools/gopls@latest
go install golang.org/x/tools/gopls@latest
\`\`\`
`;
        const result = extractGoInstallFromMarkdown(markdown);
        expect(result).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════
// extractNpmInstallFromMarkdown
// ═══════════════════════════════════════════════════════════════

describe('extractNpmInstallFromMarkdown', () => {
    it('应该从标准 npm install 命令中提取包名', () => {
        const markdown = '- `npm install pptxgenjs` - creating presentations';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('pptxgenjs');
    });

    it('应该跳过 -g 等标志参数', () => {
        const markdown = '- `npm install -g pptxgenjs` - global install';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('pptxgenjs');
        expect(result).not.toContain('-g');
    });

    it('不应将反引号后的描述文字误识别为包名', () => {
        // 回归测试：pptx SKILL.md 中的 "creating from scratch" 曾被误识别
        const markdown = '- `npm install -g pptxgenjs` - creating from scratch';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('pptxgenjs');
        expect(result).toHaveLength(1);
        expect(result).not.toContain('creating');
        expect(result).not.toContain('from');
        expect(result).not.toContain('scratch');
    });

    it('应该提取多个包名', () => {
        const markdown = '`npm install express cors helmet`';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('express');
        expect(result).toContain('cors');
        expect(result).toContain('helmet');
    });

    it('应该支持 @scope/name 格式', () => {
        const markdown = '`npm install @anthropic-ai/sdk`';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('@anthropic-ai/sdk');
    });

    it('应该跳过 --save-dev 等标志', () => {
        const markdown = '`npm install --save-dev jest typescript`';
        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('jest');
        expect(result).toContain('typescript');
        expect(result).not.toContain('--save-dev');
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without npm commands';
        expect(extractNpmInstallFromMarkdown(markdown)).toEqual([]);
    });

    it('应该在含有代码块的 markdown 中正确提取 npm 包（回归测试：三反引号干扰）', () => {
        // 模拟真实 PPTX SKILL.md 结构：前面有多个代码块，Dependencies 在末尾
        const markdown = [
            '# PPTX Skill',
            '',
            '| Task | Guide |',
            '| Read | `python -m markitdown` |',
            '',
            '```bash',
            'python -m markitdown input.pptx',
            '```',
            '',
            '```python',
            'from markitdown import MarkItDown',
            '```',
            '',
            '## Dependencies',
            '',
            '- `pip install "markitdown[pptx]"` - text extraction',
            '- `npm install -g pptxgenjs` - creating from scratch',
            '- LibreOffice (`soffice`) - PDF conversion',
        ].join('\n');

        const result = extractNpmInstallFromMarkdown(markdown);
        expect(result).toContain('pptxgenjs');
        expect(result).toHaveLength(1);
    });

    it('不应匹配 pip install', () => {
        const markdown = '- `pip install requests`';
        expect(extractNpmInstallFromMarkdown(markdown)).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════
// extractSystemToolHints
// ═══════════════════════════════════════════════════════════════

describe('extractSystemToolHints', () => {
    it('应该从 bash 代码块中检测系统工具', () => {
        const markdown = `
\`\`\`bash
pdfimages -j input.pdf output
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        expect(result.length).toBeGreaterThan(0);
        const pdfimages = result.find(t => t.command === 'pdfimages');
        expect(pdfimages).toBeDefined();
        expect(pdfimages?.packageName).toBe('Poppler');
    });

    it('应该从行内代码中检测系统工具', () => {
        const markdown = 'Use `ffmpeg -i input.mp4 output.avi` to convert video.';
        const result = extractSystemToolHints(markdown);
        expect(result.length).toBeGreaterThan(0);
        const ffmpeg = result.find(t => t.command === 'ffmpeg');
        expect(ffmpeg).toBeDefined();
        expect(ffmpeg?.packageName).toBe('FFmpeg');
        expect(result.find(t => t.packageName === 'ImageMagick')).toBeUndefined();
    });

    it('同一软件包的多个命令应只返回一条记录', () => {
        const markdown = `
\`\`\`bash
pdfimages -j input.pdf output
pdftotext input.pdf output.txt
pdftoppm -png input.pdf output
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        // Poppler 下有多个命令，但只应返回一条记录
        const popplerResults = result.filter(t => t.packageName === 'Poppler');
        expect(popplerResults).toHaveLength(1);
    });

    it('应该包含跨平台安装指令', () => {
        const markdown = `
\`\`\`bash
pdfimages -j input.pdf output
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        const poppler = result.find(t => t.packageName === 'Poppler');
        expect(poppler?.windowsInstall).toBeDefined();
        expect(poppler?.macInstall).toBeDefined();
        expect(poppler?.linuxInstall).toBeDefined();
    });

    it('无匹配时返回空数组', () => {
        const markdown = '# Title\nSome text without system tools';
        expect(extractSystemToolHints(markdown)).toEqual([]);
    });

    it('不应匹配短名称工具（如 rg、jq）在普通文本中', () => {
        // rg 和 jq 长度 < 4，不应在普通正文中被匹配
        const markdown = 'We can use rg to search and jq to parse JSON.';
        const result = extractSystemToolHints(markdown);
        expect(result).toEqual([]);
    });

    it('不应把正文中的 convert 动词误判为 ImageMagick', () => {
        const markdown = 'Use this skill to fetch, clean, and convert web content to Markdown.';
        const result = extractSystemToolHints(markdown);
        expect(result.find(t => t.packageName === 'ImageMagick')).toBeUndefined();
    });

    it('应该在命令上下文中检测 convert', () => {
        const markdown = 'Run `convert input.png output.jpg` when ImageMagick v6 is available.';
        const result = extractSystemToolHints(markdown);
        const imagemagick = result.find(t => t.packageName === 'ImageMagick');
        expect(imagemagick).toBeDefined();
        expect(imagemagick?.command).toBe('convert');
    });

    it('应该在 bash 代码块中匹配短名称工具', () => {
        const markdown = `
\`\`\`bash
rg "pattern" file.txt
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        const rg = result.find(t => t.command === 'rg');
        expect(rg).toBeDefined();
        expect(rg?.packageName).toBe('ripgrep');
    });

    it('应该处理 sudo 前缀', () => {
        const markdown = `
\`\`\`bash
sudo ffmpeg -i input.mp4 output.avi
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        const ffmpeg = result.find(t => t.command === 'ffmpeg');
        expect(ffmpeg).toBeDefined();
    });

    it('应该处理 $ 前缀', () => {
        const markdown = `
\`\`\`bash
$ pdfimages -j input.pdf output
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        const poppler = result.find(t => t.packageName === 'Poppler');
        expect(poppler).toBeDefined();
    });

    it('应该在行内代码中检测 soffice 并映射到 LibreOffice', () => {
        const markdown = '- LibreOffice (`soffice`) - PDF conversion';
        const result = extractSystemToolHints(markdown);
        const libreoffice = result.find(t => t.packageName === 'LibreOffice');
        expect(libreoffice).toBeDefined();
        expect(libreoffice?.windowsInstall).toBeDefined();
    });

    it('soffice 和 libreoffice 应去重为同一个 LibreOffice 记录', () => {
        const markdown = `
Use \`soffice --headless\` or \`libreoffice --headless\` to convert.
`;
        const result = extractSystemToolHints(markdown);
        const libreofficeResults = result.filter(t => t.packageName === 'LibreOffice');
        expect(libreofficeResults).toHaveLength(1);
    });

    it('应该在 bash 代码块中检测 soffice', () => {
        const markdown = `
\`\`\`bash
soffice --headless --convert-to pdf output.pptx
\`\`\`
`;
        const result = extractSystemToolHints(markdown);
        const libreoffice = result.find(t => t.packageName === 'LibreOffice');
        expect(libreoffice).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════
// extractNpmPostInstallCommandsFromMarkdown
// ═══════════════════════════════════════════════════════════════

import { extractNpmPostInstallCommandsFromMarkdown } from '../DependencyAnalyzer';

describe('extractNpmPostInstallCommandsFromMarkdown', () => {
    it('应该提取 agent-browser 的后置安装命令（真实场景）', () => {
        const markdown = `
## Dependencies
\`\`\`bash
npm install agent-browser
agent-browser install
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            npmPackage: 'agent-browser',
            command: 'agent-browser install',
        });
    });

    it('应该提取带行内注释的后置命令', () => {
        // 官方文档格式：agent-browser install  # Download Chrome from Chrome for Testing
        const markdown = `
\`\`\`bash
npm install -g agent-browser
agent-browser install  # Download Chrome from Chrome for Testing (first time only)
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        expect(result).toHaveLength(1);
        // 注释部分应该被剥离，只保留命令本体
        expect(result[0]?.command).toBe('agent-browser install');
    });

    it('当 detectedNpmPackages 为空时应立即返回空数组', () => {
        const markdown = `
\`\`\`bash
npm install agent-browser
agent-browser install
\`\`\`
`;
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, new Set());
        expect(result).toHaveLength(0);
    });

    it('后置命令不在 npm install 包名集合范围内时不应提取', () => {
        // other-tool 不在 detectedNpmPackages 中
        const markdown = `
\`\`\`bash
npm install agent-browser
other-tool setup
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        expect(result).toHaveLength(0);
    });

    it('不同代码块中的后置命令应与对应 npm install 包名关联', () => {
        const markdown = `
\`\`\`bash
npm install agent-browser
agent-browser install
\`\`\`

其他内容

\`\`\`bash
npm install other-pkg
other-pkg setup
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser', 'other-pkg']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        expect(result).toHaveLength(2);
        const pkgs = result.map(r => r.npmPackage);
        expect(pkgs).toContain('agent-browser');
        expect(pkgs).toContain('other-pkg');
    });

    it('跨代码块的命令不应被错误关联', () => {
        // npm install 和 agent-browser install 在不同代码块中
        const markdown = `
\`\`\`bash
npm install agent-browser
\`\`\`

一些说明

\`\`\`bash
agent-browser install
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        // agent-browser install 在另一代码块中，不能被关联到第一个代码块的 npm install
        expect(result).toHaveLength(0);
    });

    it('应该去除重复的后置命令', () => {
        // 同一代码块中 agent-browser install 出现两次
        const markdown = `
\`\`\`bash
npm install agent-browser
agent-browser install
agent-browser install
\`\`\`
`;
        const detectedPkgs = new Set(['agent-browser']);
        const result = extractNpmPostInstallCommandsFromMarkdown(markdown, detectedPkgs);
        expect(result).toHaveLength(1);
    });
});
