/**
 * DependencyAnalyzer — 技能包静态依赖分析器（第 2 层）
 *
 * 职责：
 * 从 SKILL.md fullContent 和脚本文件中提取 Python import 语句，
 * 过滤标准库和基础包后，输出需要增量安装的 pip 包名列表。
 * 同时检测 npm/npx 依赖和系统级 CLI 工具依赖。
 *
 * 扫描来源：
 * 1. Python import 语句（import xxx / from xxx import yyy）
 * 2. Markdown 代码块中的 import 语句（```python 块）
 * 3. "Requires: pip install xxx" 注释模式
 * 4. Markdown 正文中的 pip install 命令
 * 5. npm install / npx 命令中的包名
 * 6. 系统级 CLI 工具白名单匹配
 *
 * 设计原则：
 * - 纯函数，无副作用，易于单元测试
 * - 仅用于 frontmatter 无 dependencies.packages 声明的 fallback
 * - 误判可接受（pip install 已安装的包是幂等无害操作）
 */

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * 依赖来源信息
 */
export interface DependencySource {
    /** pip 包名 */
    package: string;
    /** 来源类型 */
    source: 'import' | 'requires_comment';
    /** 原始 import 名称（import 名可能与 pip 名不同） */
    importName?: string;
}

/**
 * npm 包的后置安装命令
 *
 * 部分 npm 包（如 agent-browser）在 `npm install` 后需要执行额外的初始化命令。
 * 这类命令通常紧跟在 `npm install <pkg>` 之后，格式为 `<pkg> <subcommand>`。
 */
export interface NpmPostInstallCommand {
    /** 关联的 npm 包名（如 agent-browser） */
    npmPackage: string;
    /** 后置初始化命令（如 "agent-browser install"） */
    command: string;
}

/**
 * 静态分析结果
 */
export interface AnalyzedDependencies {
    /** 推断出的 pip 包名列表（已去重、已过滤标准库和基础包） */
    packages: string[];
    /** 详细来源信息（用于日志和调试） */
    sources: DependencySource[];
    /** 检测到的 npm 包（需用户手动安装） */
    npmPackages: string[];
    /** 检测到的 cargo 包（Rust 生态 CLI 工具，需用户手动安装） */
    cargoPackages: string[];
    /** 检测到的 go 包（Go 生态 CLI 工具，需用户手动安装） */
    goPackages: string[];
    /** 检测到的系统级工具（需用户手动安装） */
    systemTools: SystemToolInfo[];
    /**
     * 检测到的 npm 包后置安装命令
     *
     * 部分 npm 包需要在安装后执行额外的初始化命令才能正常使用。
     * 例如 agent-browser 需要在 `npm install -g agent-browser` 后运行
     * `agent-browser install` 来下载 Playwright 浏览器引擎。
     */
    npmPostInstallCommands: NpmPostInstallCommand[];
}

/**
 * 系统级工具信息
 *
 * 包含工具名称和对应的安装指令，供 UI 展示「一键复制」按钮
 */
export interface SystemToolInfo {
    /** 工具命令名（如 pdfimages、ffmpeg） */
    command: string;
    /**
     * 用于检测工具是否已安装的替代命令（可选）
     *
     * 当 command 与系统内置命令冲突时使用。
     * 例如 Windows 内置 convert.exe 与 ImageMagick 的 convert 冲突，
     * 此时用 magick 作为检测命令。
     */
    detectCommand?: string;
    /** 工具所属软件包名（如 Poppler、FFmpeg） */
    packageName: string;
    /** Windows 安装指令（优先用 winget，fallback 到 choco/scoop） */
    windowsInstall: string;
    /** macOS 安装指令 */
    macInstall: string;
    /** Linux (apt) 安装指令 */
    linuxInstall: string;
    /**
     * Windows 上已知的可执行文件路径（可选）
     *
     * 用于检测不加入 PATH 的程序（如 LibreOffice、QPDF）。
     * 路径中可使用 %ProgramFiles% 等环境变量占位符。
     * 依次 Test-Path 检查，任一存在即视为已安装。
     */
    windowsExePaths?: string[];
    /**
     * 自动安装失败时的手动下载链接（可选）
     *
     * 当工具不在主流包管理器（如 winget）中时，
     * 安装失败后 UI 展示此链接引导用户手动下载安装。
     */
    fallbackUrl?: string;
}

// ═══════════════════════════════════════════════════════════════
// Import → Pip 包名映射表
// ═══════════════════════════════════════════════════════════════

/**
 * Python import 名称到 pip 包名的映射
 *
 * 解决 import 名 ≠ pip 包名的常见差异。
 * 不在此表中的 import 名假定与 pip 名一致。
 */
const IMPORT_TO_PIP_MAP: Record<string, string> = {
    // 图像/视觉处理
    fitz: 'PyMuPDF',
    cv2: 'opencv-python',
    PIL: 'Pillow',
    skimage: 'scikit-image',

    // 数据/ML
    sklearn: 'scikit-learn',
    attr: 'attrs',

    // 文档处理
    docx: 'python-docx',
    pptx: 'python-pptx',

    // Windows COM / Win32 API（pywin32 包的多个子模块）
    win32com: 'pywin32',
    win32api: 'pywin32',
    win32gui: 'pywin32',
    win32con: 'pywin32',
    win32print: 'pywin32',
    win32process: 'pywin32',
    pywintypes: 'pywin32',
    pythoncom: 'pywin32',

    // 通用工具
    bs4: 'beautifulsoup4',
    yaml: 'pyyaml',
    dateutil: 'python-dateutil',
    dotenv: 'python-dotenv',
    gi: 'PyGObject',
    charset_normalizer: 'charset-normalizer',

    // 数据库
    MySQLdb: 'mysqlclient',
    psycopg2: 'psycopg2-binary',

    // 生态包名差异
    pillow_heif: 'pillow-heif',
    yt_dlp: 'yt-dlp',
};

// ═══════════════════════════════════════════════════════════════
// 系统级工具白名单 + 安装指令映射
// ═══════════════════════════════════════════════════════════════

/**
 * 已知系统级 CLI 工具 → 安装信息的映射
 *
 * 白名单策略：只检测列表中的已知工具，避免将普通 shell 命令误判为需要安装。
 * Windows 安装优先使用 winget（Win10 1709+ 内置），fallback 提供 choco/scoop 备选。
 *
 * 初始列表从 Anthropic 官方技能包中实际出现的工具提取，
 * 并加入用户请求的网络/数据处理工具。
 */
const SYSTEM_TOOL_REGISTRY: Record<string, Omit<SystemToolInfo, 'command'>> = {
    // PDF 处理（Poppler 套件）
    pdfimages: {
        packageName: 'Poppler',
        windowsInstall: 'scoop install poppler',
        macInstall: 'brew install poppler',
        linuxInstall: 'sudo apt install poppler-utils',
    },
    pdftotext: {
        packageName: 'Poppler',
        windowsInstall: 'scoop install poppler',
        macInstall: 'brew install poppler',
        linuxInstall: 'sudo apt install poppler-utils',
    },
    pdftoppm: {
        packageName: 'Poppler',
        windowsInstall: 'scoop install poppler',
        macInstall: 'brew install poppler',
        linuxInstall: 'sudo apt install poppler-utils',
    },

    // PDF 工具
    qpdf: {
        packageName: 'QPDF',
        windowsInstall: 'scoop install qpdf',
        macInstall: 'brew install qpdf',
        linuxInstall: 'sudo apt install qpdf',
        // QPDF 安装后不加入 PATH，版本号在目录名中（如 qpdf 12.2.0），使用通配符匹配
        windowsExePaths: [
            'C:\\Program Files\\qpdf*\\bin\\qpdf.exe',
            'C:\\Program Files (x86)\\qpdf*\\bin\\qpdf.exe',
        ],
    },
    pdftk: {
        packageName: 'PDFtk',
        // PDFTKBuilder Enhanced 版本捆绑了 pdftk CLI (v2.02)
        windowsInstall: 'winget install AngusJohnson.PDFTKBuilder',
        macInstall: 'brew install pdftk-java',
        linuxInstall: 'sudo apt install pdftk',
        // PDFTKBuilder 安装后 pdftk.exe 不加入 PATH
        windowsExePaths: [
            'C:\\Program Files\\PDFtk*\\bin\\pdftk.exe',
            'C:\\Program Files (x86)\\PDFtk*\\bin\\pdftk.exe',
            'C:\\Program Files\\PDFTK Builder\\pdftk.exe',
            'C:\\Program Files (x86)\\PDFTK Builder\\pdftk.exe',
        ],
    },

    // 办公套件
    // soffice 是 LibreOffice 的 CLI 入口命令，多数技能包（如 pptx）使用 soffice 而非 libreoffice
    // 两个 key 指向同一个 packageName，extractSystemToolHints 按 packageName 去重不会重复
    libreoffice: {
        packageName: 'LibreOffice',
        windowsInstall: 'winget install TheDocumentFoundation.LibreOffice',
        macInstall: 'brew install --cask libreoffice',
        linuxInstall: 'sudo apt install libreoffice',
        // LibreOffice 安装后不加入 PATH，需要指定已知路径（与 soffice 条目共享路径）
        windowsExePaths: [
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
            'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        ],
    },
    soffice: {
        packageName: 'LibreOffice',
        detectCommand: 'soffice',
        windowsInstall: 'winget install TheDocumentFoundation.LibreOffice',
        macInstall: 'brew install --cask libreoffice',
        linuxInstall: 'sudo apt install libreoffice',
        // LibreOffice 安装后不加入 PATH，需要指定已知路径
        windowsExePaths: [
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
            'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        ],
    },

    // 多媒体
    ffmpeg: {
        packageName: 'FFmpeg',
        windowsInstall: 'winget install Gyan.FFmpeg',
        macInstall: 'brew install ffmpeg',
        linuxInstall: 'sudo apt install ffmpeg',
    },

    // 本地 ASR / 原生构建工具链
    git: {
        packageName: 'Git',
        windowsInstall: 'winget install Git.Git',
        macInstall: 'brew install git',
        linuxInstall: 'sudo apt install git',
        windowsExePaths: [
            'C:\\Program Files\\Git\\cmd\\git.exe',
            'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        ],
    },
    cmake: {
        packageName: 'CMake',
        windowsInstall: 'winget install Kitware.CMake',
        macInstall: 'brew install cmake',
        linuxInstall: 'sudo apt install cmake',
        windowsExePaths: [
            'C:\\Program Files\\CMake\\bin\\cmake.exe',
            'C:\\Program Files (x86)\\CMake\\bin\\cmake.exe',
        ],
    },

    // 图像处理（ImageMagick）
    magick: {
        packageName: 'ImageMagick',
        windowsInstall: 'winget install ImageMagick.ImageMagick',
        macInstall: 'brew install imagemagick',
        linuxInstall: 'sudo apt install imagemagick',
    },
    convert: {
        packageName: 'ImageMagick',
        // Windows 内置 convert.exe（磁盘格式化工具）会导致误判，
        // 使用 magick 作为检测命令（ImageMagick v7+ 主命令）
        detectCommand: 'magick',
        windowsInstall: 'winget install ImageMagick.ImageMagick',
        macInstall: 'brew install imagemagick',
        linuxInstall: 'sudo apt install imagemagick',
    },

    // OCR
    tesseract: {
        packageName: 'Tesseract OCR',
        windowsInstall: 'winget install UB-Mannheim.TesseractOCR',
        macInstall: 'brew install tesseract',
        linuxInstall: 'sudo apt install tesseract-ocr',
    },

    // 文档转换
    pandoc: {
        packageName: 'Pandoc',
        windowsInstall: 'winget install JohnMacFarlane.Pandoc',
        macInstall: 'brew install pandoc',
        linuxInstall: 'sudo apt install pandoc',
    },

    // 网络/数据处理工具
    curl: {
        packageName: 'cURL',
        windowsInstall: 'winget install cURL.cURL',
        macInstall: 'brew install curl',
        linuxInstall: 'sudo apt install curl',
    },
    rg: {
        packageName: 'ripgrep',
        windowsInstall: 'winget install BurntSushi.ripgrep.MSVC',
        macInstall: 'brew install ripgrep',
        linuxInstall: 'sudo apt install ripgrep',
    },
    jq: {
        packageName: 'jq',
        windowsInstall: 'winget install jqlang.jq',
        macInstall: 'brew install jq',
        linuxInstall: 'sudo apt install jq',
    },

    // PDF 压缩（Ghostscript）
    // Ghostscript 在 Windows 上的命令名为 gswin64c/gswin32c，Linux/macOS 上为 gs
    // 三个 key 指向同一个 packageName，extractSystemToolHints 按 packageName 去重不会重复
    gs: {
        packageName: 'Ghostscript',
        windowsInstall: 'scoop install ghostscript',
        macInstall: 'brew install ghostscript',
        linuxInstall: 'sudo apt install ghostscript',
        windowsExePaths: [
            'C:\\Program Files\\gs\\*\\bin\\gswin64c.exe',
            'C:\\Program Files (x86)\\gs\\*\\bin\\gswin32c.exe',
        ],
        fallbackUrl: 'https://ghostscript.com/releases/gsdnld.html',
    },
    gswin64c: {
        packageName: 'Ghostscript',
        windowsInstall: 'scoop install ghostscript',
        macInstall: 'brew install ghostscript',
        linuxInstall: 'sudo apt install ghostscript',
        windowsExePaths: [
            'C:\\Program Files\\gs\\*\\bin\\gswin64c.exe',
            'C:\\Program Files (x86)\\gs\\*\\bin\\gswin32c.exe',
        ],
        fallbackUrl: 'https://ghostscript.com/releases/gsdnld.html',
    },
    gswin32c: {
        packageName: 'Ghostscript',
        windowsInstall: 'scoop install ghostscript',
        macInstall: 'brew install ghostscript',
        linuxInstall: 'sudo apt install ghostscript',
        windowsExePaths: [
            'C:\\Program Files\\gs\\*\\bin\\gswin64c.exe',
            'C:\\Program Files (x86)\\gs\\*\\bin\\gswin32c.exe',
        ],
        fallbackUrl: 'https://ghostscript.com/releases/gsdnld.html',
    },

    // 语言工具链（作为 cargo install / go install 的前置依赖引导）
    cargo: {
        packageName: 'Rust (Cargo)',
        windowsInstall: 'winget install Rustlang.Rustup',
        macInstall: 'brew install rustup && rustup-init',
        linuxInstall: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    },
    go: {
        packageName: 'Go',
        windowsInstall: 'winget install GoLang.Go',
        macInstall: 'brew install go',
        linuxInstall: 'sudo apt install golang-go',
    },
};

const TEXT_CONTEXT_SYSTEM_TOOL_EXCLUDES = new Set(['convert']);
const PYTHON_CODE_BLOCK_LANGUAGES = new Set(['python', 'py']);
const SHELL_CODE_BLOCK_LANGUAGES = new Set(['', 'bash', 'sh', 'shell', 'powershell', 'ps1', 'cmd', 'bat']);

interface MarkdownCodeBlock {
    language: string;
    content: string;
}

function extractMarkdownCodeBlocks(markdown: string): MarkdownCodeBlock[] {
    const blocks: MarkdownCodeBlock[] = [];
    const codeBlockRegex = /^```([^\r\n`]*)[^\S\r\n]*\r?\n([\s\S]*?)^```\s*$/gm;
    let blockMatch;

    while ((blockMatch = codeBlockRegex.exec(markdown)) !== null) {
        const languageInfo = (blockMatch[1] ?? '').trim().toLowerCase();
        const language = languageInfo.split(/\s+/)[0] ?? '';
        blocks.push({
            language,
            content: blockMatch[2] ?? '',
        });
    }

    return blocks;
}

function stripMarkdownCodeBlocks(markdown: string): string {
    return markdown.replace(/^```([^\r\n`]*)[^\S\r\n]*\r?\n[\s\S]*?^```\s*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// Python 标准库白名单
// ═══════════════════════════════════════════════════════════════

/**
 * Python 3.13+ 标准库模块名白名单
 *
 * 收录 ~115 个常见标准库模块。
 * 在此白名单中的 import 被视为标准库，不会触发安装。
 * 不在白名单中的 import 统一视为第三方包（可能误判，但 pip install 幂等无害）。
 */
const PYTHON_STDLIB_MODULES = new Set([
    // 核心
    'os', 'sys', 'io', 'abc', 'enum', 'typing', 'types',
    'dataclasses', 'contextlib', 'functools', 'operator',
    'itertools', 'collections', 'copy', 'weakref',

    // 字符串/正则/文本
    'string', 're', 'textwrap', 'difflib', 'unicodedata',
    'codecs', 'locale', 'gettext', 'pprint',

    // 数值/数学
    'math', 'decimal', 'fractions', 'numbers', 'statistics',
    'random', 'bisect', 'heapq', 'array', 'colorsys',

    // 文件/路径
    'pathlib', 'shutil', 'glob', 'tempfile', 'fnmatch',
    'linecache', 'fileinput', 'stat',

    // 时间/日期
    'time', 'datetime', 'calendar', 'sched',

    // 数据格式
    'json', 'csv', 'configparser', 'xml', 'html',
    'base64', 'struct', 'pickle', 'shelve', 'dbm',
    'sqlite3', 'tomllib', 'binascii', 'plistlib',

    // 压缩/归档
    'gzip', 'zipfile', 'tarfile', 'zlib', 'bz2', 'lzma',

    // 安全/哈希
    'hashlib', 'hmac', 'secrets', 'uuid', 'getpass',

    // 网络（标准库部分）
    'http', 'urllib', 'email', 'mimetypes', 'socket', 'ssl',
    'select', 'webbrowser', 'ftplib', 'imaplib', 'smtplib',
    'xmlrpc', 'socketserver',

    // 并发
    'threading', 'multiprocessing', 'concurrent', 'asyncio',
    'signal', 'queue',

    // 调试/测试
    'logging', 'argparse', 'warnings', 'traceback',
    'unittest', 'pdb', 'inspect', 'dis',
    'doctest', 'timeit', 'cProfile', 'profile', 'trace',

    // 模块/导入系统
    'importlib', 'pkgutil', 'runpy',

    // 平台/运行时
    'platform', 'ctypes', 'gc', 'atexit',
    'subprocess', 'sysconfig', 'site', 'venv',
    'errno', 'winreg',

    // GUI/终端
    'tkinter', 'curses',

    // 其他
    'keyword', 'tokenize', 'ast', 'compileall',

    // Python 内置特殊命名空间（dunder 模块，不可 pip 安装）
    // __future__: 语言特性前向兼容开关（如 annotations、generator_stop）
    // __main__: 脚本入口模块，Python 解释器内置，不存在于 PyPI
    // __init__: 包初始化占位符，非独立可安装模块
    '__future__', '__main__', '__init__',
]);

/**
 * Common local helper module names used by Script Skill templates.
 *
 * These names are implementation placeholders, not PyPI packages. They may be
 * referenced from template/example code before a concrete skill renames the
 * helper file, so dependency inference must not try to install them.
 */
const PYTHON_LOCAL_HELPER_MODULES = new Set([
    'script_core',
]);

// ═══════════════════════════════════════════════════════════════
// 核心分析函数
// ═══════════════════════════════════════════════════════════════

/**
 * 分析技能包的 Python 依赖
 *
 * 从 SKILL.md fullContent 和脚本文件内容中静态提取 import 语句，
 * 过滤标准库、基础包和本地模块后输出需安装的 pip 包名列表。
 *
 * @param fullContent SKILL.md 的 markdown 正文（frontmatter 之后）
 * @param scriptContents 脚本文件内容数组（scripts/*.py 的文件内容）
 * @param basePackageNames 基础包名集合（runtime-requirements-v1.txt 中的包名，不含版本号）
 * @param localModuleNames 本地脚本模块名集合（scripts/ 下 .py 文件去掉后缀的名称，用于排除模块间互相引用）
 * @returns 分析结果
 */
export function analyzeDependencies(
    fullContent: string,
    scriptContents: string[],
    basePackageNames: Set<string>,
    localModuleNames: Set<string> = new Set()
): AnalyzedDependencies {
    const allSources: DependencySource[] = [];

    // 来源 1：Markdown 代码块中的 import（SKILL.md 中的示例代码）
    const codeBlockImports = extractImportsFromMarkdownCodeBlocks(fullContent);
    for (const importName of codeBlockImports) {
        const pipName = mapImportToPip(importName);
        allSources.push({ package: pipName, source: 'import', importName });
    }

    // 来源 2：脚本文件中的 import（scripts/*.py）
    for (const content of scriptContents) {
        const scriptImports = extractImportsFromPython(content);
        for (const importName of scriptImports) {
            const pipName = mapImportToPip(importName);
            allSources.push({ package: pipName, source: 'import', importName });
        }
    }

    // 来源 3：`# Requires: pip install xxx` 注释
    const requiresPackages = extractRequiresComments(fullContent);
    for (const pkgName of requiresPackages) {
        allSources.push({ package: pkgName, source: 'requires_comment' });
    }

    // 来源 4：Markdown 正文中的 `pip install xxx` 命令
    // 覆盖 Dependencies 部分列表项、行内代码等场景
    const markdownPipPackages = extractPipInstallFromMarkdown(fullContent);
    for (const pkgName of markdownPipPackages) {
        allSources.push({ package: pkgName, source: 'requires_comment' });
    }

    // 来源 5：npm 包（需用户手动安装）
    const npmFromInstall = extractNpmInstallFromMarkdown(fullContent);

    // 来源 5b：npx 调用的包（也是 npm 包，预安装后 npx 不再弹交互式 Y/N 提示）
    const npxPackages = extractNpxPackagesFromMarkdown(fullContent);

    // 合并 npm install 和 npx 来源，去重
    const npmPackagesSet = new Set<string>(npmFromInstall);
    for (const pkg of npxPackages) {
        npmPackagesSet.add(pkg);
    }
    const npmPackages = Array.from(npmPackagesSet);

    // 来源 6：系统级工具（需用户手动安装）
    const systemTools = extractSystemToolHints(fullContent);

    // 来源 7：cargo 包（Rust 生态 CLI 工具）
    const cargoPackages = extractCargoInstallFromMarkdown(fullContent);

    // 来源 8：go 包（Go 生态 CLI 工具）
    const goPackages = extractGoInstallFromMarkdown(fullContent);

    // 来源 9：npm 包的后置安装命令
    // 例如 agent-browser 在 npm install 后还需要运行 `agent-browser install`
    const npmPostInstallCommands = extractNpmPostInstallCommandsFromMarkdown(
        fullContent,
        npmPackagesSet
    );

    // 去重 + 过滤标准库 + 过滤基础包
    const seen = new Set<string>();
    const filteredSources: DependencySource[] = [];
    const resultPackages: string[] = [];

    // 构建小写的基础包名集合，用于不区分大小写比较
    const basePackagesLower = new Set(
        Array.from(basePackageNames).map(p => p.toLowerCase())
    );

    for (const source of allSources) {
        const pkgLower = source.package.toLowerCase();

        // 已处理过 → 跳过
        if (seen.has(pkgLower)) continue;
        seen.add(pkgLower);

        // dunder 模块守卫：以双下划线包裹的名称（__future__、__main__ 等）
        // 是 Python 解释器内置命名空间，不存在于 PyPI，一律跳过。
        // 此守卫比白名单更通用，可覆盖任何未来新增的 dunder 命名空间。
        const importNameForCheck = source.importName ?? source.package;
        if (/^__\w+__$/.test(importNameForCheck)) continue;

        // 本地 helper 模块占位符 → 跳过，避免把模板里的 script_core 当作 PyPI 包安装
        if (source.importName && PYTHON_LOCAL_HELPER_MODULES.has(source.importName)) continue;
        if (PYTHON_LOCAL_HELPER_MODULES.has(source.package)) continue;

        // 标准库 → 跳过（用原始 import 名称检查）
        if (source.importName && PYTHON_STDLIB_MODULES.has(source.importName)) continue;
        // 也用 pip 名检查（处理 importName 缺失的 requires_comment 来源）
        if (PYTHON_STDLIB_MODULES.has(source.package)) continue;

        // 本地模块 → 跳过（同目录 .py 文件的互相引用，如 from extract_form_field_info import ...）
        if (source.importName && localModuleNames.has(source.importName)) continue;
        if (localModuleNames.has(source.package)) continue;

        // 基础包 → 跳过
        if (basePackagesLower.has(pkgLower)) continue;

        resultPackages.push(source.package);
        filteredSources.push(source);
    }

    return {
        packages: resultPackages,
        sources: filteredSources,
        npmPackages,
        cargoPackages,
        goPackages,
        systemTools,
        npmPostInstallCommands,
    };
}

// ═══════════════════════════════════════════════════════════════
// 内部提取函数
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Python 源代码中提取 import 的顶级模块名
 *
 * 匹配模式：
 * - `import xxx` → 提取 xxx
 * - `import xxx.yyy` → 提取 xxx（顶级模块）
 * - `from xxx import yyy` → 提取 xxx
 * - `from xxx.yyy import zzz` → 提取 xxx（顶级模块）
 *
 * 排除：
 * - 相对导入（`from . import` / `from .xxx import`）
 * - 注释行中的 import
 */
export function extractImportsFromPython(pythonCode: string): string[] {
    const imports = new Set<string>();

    // 逐行解析，避免匹配注释或字符串中的 import
    const lines = pythonCode.split('\n');
    for (const rawLine of lines) {
        // 去除行内注释（# 后面的部分），但保留字符串中的 #
        // 简化处理：只去除非引号包裹的 # 注释
        const commentStripped = rawLine.replace(/#[^"']*$/, '');
        const line = commentStripped.trim();

        // 跳过注释行
        if (line.startsWith('#') || line === '') continue;

        // 匹配 `from xxx import yyy`（排除相对导入 `from .xxx`）
        const fromMatch = line.match(/^from\s+([a-zA-Z_]\w*(?:\.\w+)*)\s+import/);
        if (fromMatch?.[1]) {
            // 提取顶级模块名
            const topLevel = fromMatch[1].split('.')[0];
            if (topLevel) {
                imports.add(topLevel);
            }
            continue;
        }

        // 匹配 `import xxx` 或 `import xxx, yyy`
        const importMatch = line.match(/^import\s+(.+)/);
        if (importMatch?.[1]) {
            // 处理 `import xxx, yyy, zzz` 多模块导入
            const modules = importMatch[1].split(',');
            for (const mod of modules) {
                // 处理 `import xxx as yyy`
                const moduleName = mod.trim().split(/\s+as\s+/)[0]?.trim();
                if (moduleName) {
                    // 提取顶级模块名
                    const topLevel = moduleName.split('.')[0];
                    if (topLevel && /^[a-zA-Z_]\w*$/.test(topLevel)) {
                        imports.add(topLevel);
                    }
                }
            }
        }
    }

    return Array.from(imports);
}

/**
 * 从 Markdown 内容中提取 Python 代码块的 import 语句
 *
 * 匹配 ```python 或 ```py 围栏代码块中的 import
 */
export function extractImportsFromMarkdownCodeBlocks(markdown: string): string[] {
    const allImports = new Set<string>();

    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!PYTHON_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const imports = extractImportsFromPython(block.content);
        for (const imp of imports) {
            allImports.add(imp);
        }
    }

    return Array.from(allImports);
}

/**
 * 从文本中提取 `# Requires: pip install xxx yyy` 模式的包名
 *
 * 匹配模式（不区分大小写）：
 * - `# Requires: pip install pytesseract pdf2image`
 * - `# requires: pip install scipy networkx`
 * - `# Requires: pip install pytesseract, pdf2image`
 */
export function extractRequiresComments(text: string): string[] {
    const packages = new Set<string>();

    const lines = text.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();

        // 匹配 `# Requires: pip install ...` 模式（不区分大小写）
        const requiresMatch = line.match(
            /^#\s*requires:\s*pip\s+install\s+(.+)/i
        );
        if (requiresMatch?.[1]) {
            // 支持空格分隔和逗号分隔
            const pkgString = requiresMatch[1].trim();
            const pkgNames = pkgString.split(/[\s,]+/).filter(Boolean);
            for (const pkg of pkgNames) {
                // 只保留合法的包名（字母、数字、连字符、下划线、点）
                if (/^[a-zA-Z][a-zA-Z0-9._\-[\]]*$/.test(pkg)) {
                    packages.add(pkg);
                }
            }
        }
    }

    return Array.from(packages);
}

/**
 * 将 import 名称映射为 pip 包名
 *
 * 查找映射表，未找到时假定 import 名与 pip 名相同
 */
export function mapImportToPip(importName: string): string {
    return IMPORT_TO_PIP_MAP[importName] ?? importName;
}

/**
 * 从 runtime-requirements 文件内容中提取包名列表（不含版本号）
 *
 * 解析 requirements.txt 格式：
 * - 跳过空行和注释行（# 开头）
 * - 提取包名部分（去掉 ==, >=, <=, ~=, < 等版本约束）
 *
 * @param requirementsContent requirements.txt 文件内容
 * @returns 包名集合（小写）
 */
export function parseBasePackageNames(requirementsContent: string): Set<string> {
    const names = new Set<string>();
    const lines = requirementsContent.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // 跳过空行和注释
        if (line === '' || line.startsWith('#')) continue;

        // 提取包名（去掉版本约束）
        const pkgName = line.split(/[=<>~!]/)[0]?.trim();
        if (pkgName) {
            names.add(pkgName.toLowerCase());
        }
    }

    return names;
}

/**
 * 从 Markdown 正文中提取 `pip install xxx` 命令中的包名
 *
 * 匹配场景（不在 Python 代码块内）：
 * - `- \`pip install "markitdown[pptx]"\`` → markitdown[pptx]
 * - `pip install Pillow` → Pillow
 * - `\`pip install xxx yyy\`` → xxx, yyy
 *
 * 与 extractRequiresComments 互补：
 * - extractRequiresComments 匹配 `# Requires: pip install xxx`（Python 注释）
 * - 本函数匹配 Markdown 正文中的 pip install 命令
 */
export function extractPipInstallFromMarkdown(markdown: string): string[] {
    const packages = new Set<string>();

    // 来源 1：从 bash/shell/powershell/cmd 代码块中提取命令
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const blockLines = block.content.split('\n');
        for (const blockLine of blockLines) {
            extractPipPackagesFromCommand(blockLine.trim(), packages);
        }
    }

    // 来源 2：从行内代码段中提取命令，避免吞掉反引号外的自然语言说明
    const markdownWithoutCodeBlocks = stripMarkdownCodeBlocks(markdown);
    const inlineCodeRegex = /`([^`]+)`/g;
    let codeMatch;
    while ((codeMatch = inlineCodeRegex.exec(markdownWithoutCodeBlocks)) !== null) {
        const code = codeMatch[1];
        if (!code) continue;
        extractPipPackagesFromCommand(code, packages);
    }

    // 来源 3：仅解析看起来就是命令的普通 Markdown 行
    const textWithoutInlineCode = markdownWithoutCodeBlocks.replace(/`[^`]+`/g, '');
    const lines = textWithoutInlineCode.split('\n');
    for (const rawLine of lines) {
        const commandLikeLine = rawLine
            .trim()
            .replace(/^[-*+]\s+/, '')
            .replace(/^\d+[.)]\s+/, '')
            .trim();
        extractPipPackagesFromCommand(commandLikeLine, packages);
    }

    return Array.from(packages);
}

/**
 * 从单条命令文本中提取 pip install 的包名。
 *
 * 仅处理已确认为「命令」的文本（代码块、行内代码、或命令形态整行），
 * 避免把 `Install x (\`pip install x\`) and retry` 这类自然语言里的
 * `and` / `retry` 当作包名。
 */
function extractPipPackagesFromCommand(
    commandText: string,
    packages: Set<string>
): void {
    const command = commandText.trim();
    const pipMatch = command.match(/^(?:python(?:3)?\s+-m\s+)?pip(?:3)?\s+install\s+(.+)/i);
    if (!pipMatch?.[1]) return;

    const parts = pipMatch[1]
        .replace(/[`"']/g, '')
        .split(/[\s,]+/)
        .filter(Boolean);

    for (const part of parts) {
        // 遇到 shell 连接符或 Markdown 说明分隔符时停止提取
        if (part === '&&' || part === '||' || part === ';' || part === '|' || part === '-' || part.startsWith('#')) break;
        // 遇到括号说明时停止提取，避免 `pip install winocr (Windows native OCR)` 中的 Windows/native/OCR 被误判。
        if (/^[({\uff08]/.test(part)) break;

        const cleaned = part
            .replace(/^[`"'(\uff08]+/g, '')
            .replace(/[`"')\u0029\uff09;\uff1b|]+$/g, '');

        // 跳过 pip 标志参数（-U, --upgrade, --index-url 等）
        if (!cleaned || cleaned.startsWith('-')) continue;

        // 验证合法包名（支持 pip extras 语法如 markitdown[pptx]）
        // 同时约束只允许 ASCII 字符，防止描述词在极端情况下混入
        if (
            /^[a-zA-Z][a-zA-Z0-9._\-[\]]*$/.test(cleaned) &&
            // eslint-disable-next-line no-control-regex
            !/[^\x00-\x7F]/.test(cleaned)
        ) {
            packages.add(cleaned);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// npm 包提取
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 正文中提取 `npm install xxx` 命令中的包名
 *
 * 策略：两步解析
 * 1. 先提取反引号（`` ` ``）包裹的行内代码段
 * 2. 在代码段内匹配 `npm install` 命令
 *
 * 这样避免将反引号后面的描述文字（如 "creating from scratch"）误判为包名。
 *
 * 匹配场景：
 * - `npm install pptxgenjs` → pptxgenjs
 * - `npm install -g pptxgenjs` → pptxgenjs
 * - `npm install xxx yyy` → xxx, yyy
 */
export function extractNpmInstallFromMarkdown(markdown: string): string[] {
    const packages = new Set<string>();

    // 策略 1：从 bash/shell 代码块中提取（必须先于行内代码，避免三反引号和单反引号互相干扰）
    // 根因：`/`([^`]+)`/g` 无法区分 ``` 和 `，导致代码块的反引号被 inline regex 消耗，
    // 污染后续行内代码匹配，吞掉 Dependencies section 中的 npm 命令
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const blockLines = block.content.split('\n');
        for (const blockLine of blockLines) {
            extractNpmPackagesFromCommand(blockLine.trim(), packages);
        }
    }

    // 策略 2：从行内代码段（反引号包裹）中提取
    // 先去除所有代码块（包括任何语言标记），再匹配行内代码，防止三反引号干扰
    const markdownWithoutCodeBlocks = stripMarkdownCodeBlocks(markdown);
    const inlineCodeRegex = /`([^`]+)`/g;
    let codeMatch;
    while ((codeMatch = inlineCodeRegex.exec(markdownWithoutCodeBlocks)) !== null) {
        const code = codeMatch[1];
        if (!code) continue;
        extractNpmPackagesFromCommand(code, packages);
    }

    return Array.from(packages);
}

/**
 * 从单条命令文本中提取 npm install 的包名
 *
 * 仅处理已确认为「命令」的文本（反引号内或 bash 代码块内），
 * 因此不会误匹配自然语言描述。
 */
function extractNpmPackagesFromCommand(
    commandText: string,
    packages: Set<string>
): void {
    const npmMatch = commandText.match(/npm\s+install\s+(.+)/i);
    if (!npmMatch?.[1]) return;

    const parts = npmMatch[1].split(/[\s,]+/).filter(Boolean);
    for (const part of parts) {
        // 遇到 shell 命令连接符（&&, ||, ;）时停止提取
        // 避免将 `npm install -g appium && appium driver install xcuitest`
        // 中 `&&` 后的 `driver`/`install`/`xcuitest` 误识别为 npm 包
        if (part === '&&' || part === '||' || part === ';') break;

        const cleaned = part.replace(/[`"']+$/g, '').replace(/^[`"']+/g, '');

        // 跳过 npm 标志参数（-g, --save, --save-dev 等）
        if (cleaned.startsWith('-')) continue;

        // 验证合法包名（支持 @scope/name 格式）
        if (/^(@[a-zA-Z0-9_-]+\/)?[a-zA-Z][a-zA-Z0-9._-]*$/.test(cleaned)) {
            packages.add(cleaned);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// npx 包提取
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 正文中提取 `npx <package>` 命令的包名
 *
 * npx 调用未全局安装的包时会弹出交互式 Y/N 提示，
 * SA 无法处理此提示导致超时。预安装后 npx 直接执行，不再弹提示。
 *
 * 匹配场景：
 * - `npx skills find react` → skills
 * - `npx -y skills add owner/repo@skill` → skills（跳过 -y 标志）
 * - `npx @anthropic-ai/tool build` → @anthropic-ai/tool
 * - `npx prettier --write .` → prettier
 *
 * 扫描来源：
 * 1. bash/shell 代码块中的 npx 命令
 * 2. 行内代码（反引号包裹）中的 npx 命令
 */
export function extractNpxPackagesFromMarkdown(markdown: string): string[] {
    const packages = new Set<string>();

    // 来源 1：bash/shell 代码块中的 npx 命令
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const blockLines = block.content.split('\n');
        for (const blockLine of blockLines) {
            extractNpxPackageFromCommand(blockLine.trim(), packages);
        }
    }

    // 来源 2：行内代码段（反引号包裹）
    // 先去除所有代码块，再匹配行内代码，防止三反引号干扰
    const markdownWithoutCodeBlocks = stripMarkdownCodeBlocks(markdown);
    const inlineCodeRegex = /`([^`]+)`/g;
    let codeMatch;
    while ((codeMatch = inlineCodeRegex.exec(markdownWithoutCodeBlocks)) !== null) {
        const code = codeMatch[1];
        if (!code) continue;
        extractNpxPackageFromCommand(code, packages);
    }

    return Array.from(packages);
}

/**
 * 从单条命令文本中提取 npx 调用的包名
 *
 * 跳过 npx 自身的标志参数（-y, --yes, -p, --package, -q, --quiet 等），
 * 提取第一个非标志参数作为包名。
 */
function extractNpxPackageFromCommand(
    commandText: string,
    packages: Set<string>
): void {
    // 匹配以 npx 开头的命令（可能有 $ 或 sudo 前缀）
    const npxMatch = commandText.match(/^(?:\$\s+)?(?:sudo\s+)?npx\s+(.+)/i);
    if (!npxMatch?.[1]) return;

    const parts = npxMatch[1].split(/\s+/).filter(Boolean);

    // 在参数列表中找到第一个非标志的 token 作为包名
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        // 跳过 npx 标志参数
        if (isNpxFlag(part)) {
            // --package <name> 等需要消耗下一个参数的标志
            if (isNpxFlagWithValue(part)) {
                i++; // 跳过标志的值参数
            }
            continue;
        }

        // 去除包名中的版本号后缀（如 create-react-app@latest → create-react-app）
        // 但保留 @scope/name 格式（如 @anthropic-ai/tool）
        const cleaned = stripVersionSuffix(part);

        // 验证合法包名（支持 @scope/name 格式）
        if (/^(@[a-zA-Z0-9_-]+\/)?[a-zA-Z][a-zA-Z0-9._-]*$/.test(cleaned)) {
            packages.add(cleaned);
        }
        // 只取第一个包名（npx 只执行一个包）
        break;
    }
}

/**
 * 判断 token 是否为 npx 的标志参数
 *
 * 覆盖常见的 npx 标志，避免将标志误识别为包名
 */
function isNpxFlag(token: string): boolean {
    // 短标志和长标志
    const flags = new Set([
        '-y', '--yes',
        '-q', '--quiet',
        '-p', '--package',
        '-c',
        '--no-install',
        '--ignore-existing',
        '--prefer-online',
        '--prefer-offline',
    ]);
    return token.startsWith('-') && (flags.has(token) || token.startsWith('--'));
}

/**
 * 判断 token 是否为需要消耗下一个参数值的 npx 标志
 *
 * 例如 `--package react` 中 react 是标志的值，不是要执行的包
 */
function isNpxFlagWithValue(token: string): boolean {
    return token === '-p' || token === '--package' || token === '-c';
}

/**
 * 去除包名中的版本号后缀
 *
 * 处理 `create-react-app@latest` → `create-react-app`
 * 但保留 `@scope/name` 格式中的 @ 前缀
 */
function stripVersionSuffix(rawName: string): string {
    // @scope/name@version → 找到第二个 @
    if (rawName.startsWith('@')) {
        const afterScope = rawName.indexOf('/', 1);
        if (afterScope > 0) {
            const versionAt = rawName.indexOf('@', afterScope + 1);
            if (versionAt > 0) {
                return rawName.substring(0, versionAt);
            }
        }
        return rawName;
    }
    // name@version → 去掉 @version
    const atIndex = rawName.indexOf('@');
    if (atIndex > 0) {
        return rawName.substring(0, atIndex);
    }
    return rawName;
}

// ═══════════════════════════════════════════════════════════════
// cargo 包提取（Rust 生态）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 正文中提取 `cargo install <package>` 命令的包名
 *
 * Rust CLI 工具通常通过 cargo install 安装。
 * 如果 SKILL.md 中引用了 cargo install 命令，需要预安装对应包。
 *
 * 匹配场景：
 * - `cargo install bat` → bat
 * - `cargo install ripgrep` → ripgrep
 * - `cargo install --locked fd-find` → fd-find（跳过标志）
 *
 * 扫描来源：
 * 1. bash/shell 代码块中的 cargo install 命令
 * 2. 行内代码（反引号包裹）中的 cargo install 命令
 */
export function extractCargoInstallFromMarkdown(markdown: string): string[] {
    const packages = new Set<string>();

    // 来源 1：bash/shell 代码块
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        for (const blockLine of block.content.split('\n')) {
            extractCargoPackageFromLine(blockLine.trim(), packages);
        }
    }

    // 来源 2：行内代码
    const markdownWithoutCodeBlocks = stripMarkdownCodeBlocks(markdown);
    const inlineCodeRegex = /`([^`]+)`/g;
    let codeMatch;
    while ((codeMatch = inlineCodeRegex.exec(markdownWithoutCodeBlocks)) !== null) {
        const code = codeMatch[1];
        if (!code) continue;
        extractCargoPackageFromLine(code, packages);
    }

    return Array.from(packages);
}

/**
 * 从单行文本中提取 cargo install 的包名
 *
 * 跳过 cargo install 的标志参数（--locked, --force, --git 等），
 * 提取第一个非标志参数作为包名。
 */
function extractCargoPackageFromLine(
    line: string,
    packages: Set<string>
): void {
    // 匹配 cargo install 命令（可能有 $ 或 sudo 前缀）
    const cargoMatch = line.match(/^(?:\$\s+)?(?:sudo\s+)?cargo\s+install\s+(.+)/i);
    if (!cargoMatch?.[1]) return;

    const parts = cargoMatch[1].split(/\s+/).filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        // 跳过标志参数
        if (part.startsWith('-')) {
            // 需要消耗值的标志：--git <url>, --branch <name>, --tag <tag>, --rev <rev>
            if (isCargoFlagWithValue(part)) {
                i++;
            }
            continue;
        }

        // 验证合法的 crate 名（字母、数字、连字符、下划线，以字母开头）
        if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part)) {
            packages.add(part);
        }
        break;
    }
}

/**
 * 判断 token 是否为 cargo install 需要消耗下一个参数的标志
 */
function isCargoFlagWithValue(token: string): boolean {
    const flagsWithValue = new Set([
        '--git', '--branch', '--tag', '--rev', '--path',
        '--version', '--root', '--target', '--target-dir',
        '-j', '--jobs',
    ]);
    return flagsWithValue.has(token);
}

// ═══════════════════════════════════════════════════════════════
// go 包提取（Go 生态）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 正文中提取 `go install <path>@<version>` 命令的包路径
 *
 * Go CLI 工具通常通过 go install 安装。
 * 包路径是完整的模块路径（如 github.com/golangci/golangci-lint/cmd/golangci-lint@latest）。
 *
 * 匹配场景：
 * - `go install golang.org/x/tools/gopls@latest` → golang.org/x/tools/gopls
 * - `go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.55.0` → github.com/golangci/golangci-lint/cmd/golangci-lint
 *
 * 扫描来源：
 * 1. bash/shell 代码块中的 go install 命令
 * 2. 行内代码（反引号包裹）中的 go install 命令
 */
export function extractGoInstallFromMarkdown(markdown: string): string[] {
    const packages = new Set<string>();

    // 来源 1：bash/shell 代码块
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        for (const blockLine of block.content.split('\n')) {
            extractGoPackageFromLine(blockLine.trim(), packages);
        }
    }

    // 来源 2：行内代码
    const markdownWithoutCodeBlocks = stripMarkdownCodeBlocks(markdown);
    const inlineCodeRegex = /`([^`]+)`/g;
    let codeMatch;
    while ((codeMatch = inlineCodeRegex.exec(markdownWithoutCodeBlocks)) !== null) {
        const code = codeMatch[1];
        if (!code) continue;
        extractGoPackageFromLine(code, packages);
    }

    return Array.from(packages);
}

/**
 * 从单行文本中提取 go install 的包路径
 *
 * Go 包路径的特征：包含域名（至少一个 /）和可选的 @version 后缀。
 * 例如 golang.org/x/tools/gopls@latest
 */
function extractGoPackageFromLine(
    line: string,
    packages: Set<string>
): void {
    // 匹配 go install 命令（可能有 $ 或 sudo 前缀）
    const goMatch = line.match(/^(?:\$\s+)?(?:sudo\s+)?go\s+install\s+(.+)/i);
    if (!goMatch?.[1]) return;

    const parts = goMatch[1].split(/\s+/).filter(Boolean);

    for (const part of parts) {
        if (!part) continue;

        // 跳过标志参数
        if (part.startsWith('-')) continue;

        // Go 包路径特征：包含 / 且看起来像域名路径
        // 如 golang.org/x/tools/gopls@latest 或 github.com/user/repo/cmd/tool@v1.0
        if (part.includes('/') && /^[a-zA-Z][a-zA-Z0-9.-]*\//.test(part)) {
            // 去除 @version 后缀
            const atIndex = part.indexOf('@');
            const cleanPath = atIndex > 0 ? part.substring(0, atIndex) : part;
            packages.add(cleanPath);
        }
        break;
    }
}

// ═══════════════════════════════════════════════════════════════
// 系统级工具检测
// ═══════════════════════════════════════════════════════════════

/**
 * 从 SKILL.md 中检测系统级 CLI 工具的使用
 *
 * 策略：使用白名单（SYSTEM_TOOL_REGISTRY）匹配 bash 代码块和内联代码中的命令。
 * 只检测已知工具，避免将 `ls`、`cd` 等常见 shell 命令误判为需要安装。
 *
 * 匹配来源：
 * 1. ```bash 代码块中作为行首命令出现的工具名
 * 2. 行内 `` `pdfimages -j input.pdf` `` 代码中的工具名
 *
 * 同一软件包名（如 Poppler）下的多个命令（pdfimages、pdftotext、pdftoppm）
 * 只返回一条记录，避免 UI 重复展示。
 */
export function extractSystemToolHints(markdown: string): SystemToolInfo[] {
    // 按软件包名去重（同一包下多个命令只返回一条）
    const foundPackages = new Map<string, SystemToolInfo>();

    // 构建所有白名单工具的正则匹配模式
    // 使用 word boundary 确保精确匹配（避免 `convert_pdf` 中的 `convert` 误匹配）
    const toolNames = Object.keys(SYSTEM_TOOL_REGISTRY);

    // 来源 1：bash 代码块中的命令
    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const blockLines = block.content.split('\n');
        for (const blockLine of blockLines) {
            const trimmed = blockLine.trim();
            if (trimmed === '' || trimmed.startsWith('#')) continue;

            // 提取行首命令（可能有 $ 前缀或 sudo 前缀）
            const cmdMatch = trimmed.match(/^(?:\$\s+)?(?:sudo\s+)?(\S+)/);
            if (!cmdMatch?.[1]) continue;

            const cmdName = cmdMatch[1];
            if (SYSTEM_TOOL_REGISTRY[cmdName] && !foundPackages.has(SYSTEM_TOOL_REGISTRY[cmdName].packageName)) {
                const registry = SYSTEM_TOOL_REGISTRY[cmdName];
                foundPackages.set(registry.packageName, {
                    command: cmdName,
                    ...registry,
                });
            }
        }
    }

    // 来源 2：行内代码中的工具名（`` `pdfimages -j input.pdf` ``）
    // 匹配单反引号包裹的内联代码（先移除 fenced code block）
    const allLines = stripMarkdownCodeBlocks(markdown).split('\n');

    for (const rawLine of allLines) {
        const trimmed = rawLine.trim();

        // 在行内代码中查找工具名
        const inlineCodeRegex = /`([^`]+)`/g;
        let inlineMatch;
        while ((inlineMatch = inlineCodeRegex.exec(trimmed)) !== null) {
            const code = inlineMatch[1];
            if (!code) continue;

            // 提取命令（可能有 sudo 前缀）
            const codeCmd = code.trim().match(/^(?:sudo\s+)?(\S+)/);
            if (!codeCmd?.[1]) continue;

            const cmdName = codeCmd[1];
            if (SYSTEM_TOOL_REGISTRY[cmdName] && !foundPackages.has(SYSTEM_TOOL_REGISTRY[cmdName].packageName)) {
                const registry = SYSTEM_TOOL_REGISTRY[cmdName];
                foundPackages.set(registry.packageName, {
                    command: cmdName,
                    ...registry,
                });
            }
        }
    }

    // 补充：检查 Python 代码块和注释中对系统工具的文字引用
    // 例如 `# Requires: poppler-utils` 或 SKILL.md 文本中提到的工具
    for (const toolName of toolNames) {
        const registry = SYSTEM_TOOL_REGISTRY[toolName];
        if (!registry || foundPackages.has(registry.packageName)) continue;
        if (TEXT_CONTEXT_SYSTEM_TOOL_EXCLUDES.has(toolName)) continue;

        // 在 Markdown 文本中查找明确的工具引用
        // 仅匹配独立的单词（word boundary），避免子串匹配
        const wordRegex = new RegExp(`\\b${toolName}\\b`);
        // 只在 bash-related 上下文中匹配（如 poppler-utils、pdfimages 等明确的工具名）
        // 对于短名称（如 rg、jq），要求出现在命令上下文中才匹配
        if (toolName.length >= 4 && wordRegex.test(markdown)) {
            foundPackages.set(registry.packageName, {
                command: toolName,
                ...registry,
            });
        }
    }

    return Array.from(foundPackages.values());
}

// ═══════════════════════════════════════════════════════════════
// npm 后置命令提取
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 中提取 npm 包的后置安装命令
 *
 * 部分 npm 包（如 agent-browser）在 `npm install` 之后还需要执行额外的
 * 初始化命令（如 `agent-browser install`）才能正常使用。
 *
 * 检测策略：
 * 在 bash/shell 代码块中，找到 `npm install <pkg>` 命令后，
 * 扫描同一代码块内后续行（注释行除外），若命令以已知 npm 包名开头，
 * 则将其识别为该包的后置安装命令。
 *
 * 示例（来自 agent-browser SKILL.md）：
 * ```bash
 * npm install agent-browser
 * agent-browser install  # Download Chrome from Chrome for Testing
 * ```
 * → 提取到 { npmPackage: 'agent-browser', command: 'agent-browser install' }
 *
 * @param markdown SKILL.md 的正文内容
 * @param detectedNpmPackages 已检测到的 npm 包名集合（用于精确匹配）
 * @returns 后置命令列表（已去重）
 */
export function extractNpmPostInstallCommandsFromMarkdown(
    markdown: string,
    detectedNpmPackages: Set<string>
): NpmPostInstallCommand[] {
    if (detectedNpmPackages.size === 0) return [];

    // 以代码块为单位扫描：跨行的安装命令只在同一代码块中才有意义
    // 使用 key = "pkg::cmd" 格式去重，避免同一后置命令重复出现
    const seen = new Set<string>();
    const results: NpmPostInstallCommand[] = [];

    for (const block of extractMarkdownCodeBlocks(markdown)) {
        if (!SHELL_CODE_BLOCK_LANGUAGES.has(block.language)) continue;
        const lines = block.content.split('\n').map(l => l.trim()).filter(Boolean);

        // 找出代码块中各行对应的 npm 包（若该行是 npm install <pkg>）
        // npmLinePackages[i] = 该行安装的包名，或 null（非 npm install 行）
        const npmLinePackages: Array<string | null> = lines.map(line => {
            // 匹配 npm install 命令，提取第一个非标志参数作为包名
            const npmMatch = line.match(/npm\s+install\s+(.+)/i);
            if (!npmMatch?.[1]) return null;

            const parts = npmMatch[1].split(/[\s,]+/).filter(Boolean);
            for (const part of parts) {
                if (part === '&&' || part === '||' || part === ';') break;
                const cleaned = part.replace(/[`"']+/g, '').replace(/#.*$/, '').trim();
                if (cleaned.startsWith('-')) continue;
                // 只返回在已检测 npm 包集合中的包名
                if (detectedNpmPackages.has(cleaned)) return cleaned;
            }
            return null;
        });

        // 对每个 npm install 行，向后扫描后续命令行
        for (let i = 0; i < lines.length; i++) {
            const installedPkg = npmLinePackages[i];
            if (!installedPkg) continue;

            // 向后扫描直到遇到另一个 npm install 或代码块结束
            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j];
                if (!nextLine) continue;

                // 去除行内注释（# 开头的部分）
                const lineWithoutComment = nextLine.replace(/#.*$/, '').trim();
                if (!lineWithoutComment) continue;

                // 遇到新的 npm install 行 → 停止扫描当前包的后置命令
                if (/^npm\s+install/i.test(lineWithoutComment)) break;

                // 判断是否以当前 npm 包名开头（后置命令必须与包名前缀匹配）
                // 例如：'agent-browser install' 以 'agent-browser' 开头
                if (!lineWithoutComment.startsWith(installedPkg)) continue;

                // 去除命令连接符（&& 等）之后的内容，只取第一条命令
                const cleanedCmd = lineWithoutComment
                    .split(/\s+&&\s+|\s+\|\|\s+|\s*;\s*/)[0]
                    ?.trim() ?? '';

                if (!cleanedCmd) continue;

                // 去重并收集
                const key = `${installedPkg}::${cleanedCmd}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push({ npmPackage: installedPkg, command: cleanedCmd });
                }
            }
        }
    }

    return results;
}
