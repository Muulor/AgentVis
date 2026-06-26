/**
 * LocalSearchTool - 本地搜索工具
 *
 * 整合四种搜索能力：
 * - grep: 文本/正则搜索（调用 Rust code_grep）
 * - find: 文件名 glob 查找（调用 Rust code_find）
 * - outline: AST 结构大纲（调用 Rust code_outline, tree-sitter）
 * - symbol: 符号定位查看（调用 Rust code_symbol, tree-sitter）
 *
 * 技能定义: SKILL.md
 * 工具实现: 本文件
 *
 * 命令规范化层（在 invoke Rust 命令之前执行）：
 * - normalizeGrepQuery: 检测 query 中的正则元字符，自动提升 isRegex
 * - normalizeFilePath: 修正 Git Bash 风格路径为 Windows 绝对路径
 * - getUnsupportedLanguageHint: outline 空结果时精准提示不支持的语言
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { getLogger } from '@services/logger';
import { getSandboxPathViolation } from '../shared/sandboxPath';

const logger = getLogger('tool');

// ==================== 返回类型（与 Rust 侧 serde 对齐）====================

/** grep 匹配条目 */
interface GrepMatch {
    file: string;
    line: number;
    content: string;
}

/** find 结果条目 */
interface FindResult {
    path: string;
    fileType: string;
    size: number;
}

/** outline 符号条目 */
interface OutlineItem {
    name: string;
    kind: string;
    signature: string;
    startLine: number;
    endLine: number;
    children: OutlineItem[];
}

// ==================== 命令规范化层 ====================

/**
 * Rust 侧 tree-sitter 支持的文件扩展名集合
 * 与 search.rs 中 parse_outline 的 match 分支保持同步
 */
const TREE_SITTER_SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'css', 'scss', 'json',
]);

/**
 * grep 查询正则元字符自动检测结果
 */
interface NormalizedGrepQuery {
    normalizedQuery: string;
    normalizedIsRegex: boolean;
}

/**
 * 转义正则表达式中不属于合法量词的花括号
 *
 * PCRE 引擎对孤立 { 当字面量处理，但 Rust regex 引擎严格要求
 * { 后跟合法的重复量词格式（{n}, {n,}, {n,m}），否则报解析错误：
 *   "repetition quantifier expects a valid decimal"
 *
 * 典型失败案例（来自真实 log）：
 *   ^\.clip\s*{|^\.audio-clip\s*{
 *   → { 在这里是 CSS 花括号的字面量，不是量词
 *
 * 策略：
 * - 匹配所有 { ... } 片段
 * - 如果 { 后面跟的是合法量词格式（纯数字 + 可选逗号 + 可选数字），保留
 * - 否则将 { 转义为 \{ （Rust regex 中 } 单独出现是安全的，但对称处理更稳健）
 */
export function sanitizeRegexBraces(regex: string): string {
    if (!regex) return regex;

    // 单遍扫描策略：逐个匹配未转义的 {，判断其后是否为合法量词格式
    // 合法量词：{n}, {n,}, {n,m}（n/m 为非负整数）
    // 如果不是量词 → 转义为 \{
    return regex.replace(
        /(?<!\\)\{(\d+(,\d*)?\})?/g,
        (match) => {
            // 如果匹配到完整的量词格式（如 {3}, {2,}, {1,5}），保留原样
            if (/^\{\d+(,\d*)?\}$/.test(match)) {
                return match;
            }
            // 孤立 { 或后面不是合法量词 → 转义
            return '\\{';
        }
    );
}

/**
 * 规范化 grep 查询参数
 *
 * LLM 经常传 query: "foo|bar" 但忘记设 isRegex: true。
 * Rust 侧在 is_regex=false 时对 query 做 regex::escape，
 * 导致 | 被转义为 \|，搜索到的是字面量 "foo|bar" 而非 OR 语义。
 *
 * 检测规则（仅在 isRegex 为 false/undefined 时生效）：
 * - | 管道符 → 几乎必然是 OR 语义，不会出现在正常搜索文本中
 * - (...) 分组 → 正则捕获组语法
 * - \d / \w / \s / \b → 正则转义序列
 *
 * 不检测（误判率太高）：
 * - * + . → 作为字面文本太常见（文件名、句末标点）
 * - ^ $ → 可能出现在 Markdown/注释文本中
 *
 * 花括号兼容：
 * - Rust regex 引擎不接受裸 { 作为字面量（PCRE 可以）
 * - 正则模式的 query 会自动调用 sanitizeRegexBraces 转义非量词花括号
 */
export function normalizeGrepQuery(
    query: string,
    isRegex: boolean | undefined
): NormalizedGrepQuery {
    // 如果已经显式指定为正则模式，修正花括号后返回
    if (isRegex === true) {
        return { normalizedQuery: sanitizeRegexBraces(query), normalizedIsRegex: true };
    }

    if (!query) {
        return { normalizedQuery: query, normalizedIsRegex: isRegex ?? false };
    }

    // 检测高置信度的正则元字符模式
    const regexIndicators: RegExp[] = [
        /\|/,              // OR 语义管道符："foo|bar"
        /\([^)]+\)/,       // 捕获组："(foo|bar)"
        /\\[dwsbDWSB]/,   // 正则转义序列："\d+", "\w+", "\s", "\b"
    ];

    const hasRegexPattern = regexIndicators.some(pattern => pattern.test(query));

    if (hasRegexPattern) {
        // 自动提升为正则模式，并修正花括号
        return { normalizedQuery: sanitizeRegexBraces(query), normalizedIsRegex: true };
    }

    return { normalizedQuery: query, normalizedIsRegex: isRegex ?? false };
}

/**
 * 规范化文件路径
 *
 * LLM 偶尔生成 Git Bash 风格的路径（如 /f/AgentVis/src/App.tsx），
 * Windows 原生 API 和 Rust std::path 无法识别。
 *
 * 修正规则：
 * - /X/... → X:/...（单字母盘符 + 斜杠开头的 Git Bash 风格）
 *
 * 不修正：
 * - 已是 Windows 绝对路径（X:\... 或 X:/...）
 * - 相对路径（不以 / 开头或以 ./ 开头）
 * - Linux 风格绝对路径但非盘符（/usr/local/...，盘符只有单字母）
 */
export function normalizeFilePath(inputPath: string): string {
    if (!inputPath) return inputPath;

    // 匹配 /X/... 格式（X 为单个字母，后跟 /）
    // 例: /f/AgentVis/src → f:/AgentVis/src
    const gitBashMatch = inputPath.match(/^\/([a-zA-Z])\/(.*)$/);
    if (gitBashMatch) {
        return `${gitBashMatch[1] ?? ''}:/${gitBashMatch[2] ?? ''}`;
    }

    return inputPath;
}

/**
 * 获取不支持的语言提示
 *
 * 当 outline/symbol 模式返回空结果时，根据文件扩展名判断
 * 是否在 tree-sitter 支持列表中，给出精准的错误引导。
 *
 * @returns 提示文本（不支持时），或 null（扩展名在支持列表中，文件可能为空）
 */
export function getUnsupportedLanguageHint(filePath: string): string | null {
    // 提取文件扩展名
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) {
        return translate('tools.localSearch.noExtension');
    }

    const ext = filePath.substring(lastDot + 1).toLowerCase();

    if (TREE_SITTER_SUPPORTED_EXTENSIONS.has(ext)) {
        // 在支持列表中但返回空 — 说明文件可能为空，不是语言问题
        return null;
    }

    return translate('tools.localSearch.unsupportedExtension', { ext });
}

// ==================== 工具 Schema ====================

const SCHEMA: ToolSchema = {
    name: 'local_search',
    description: 'Search local files. Supports four modes: grep (text search), find (file lookup), outline (AST outline), and symbol (symbol lookup).',
    parameters: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                description: 'Search mode: grep / find / outline / symbol.',
                enum: ['grep', 'find', 'outline', 'symbol'],
            },
            query: {
                type: 'string',
                description: '[grep] Text or regular expression to search for.',
            },
            searchPath: {
                type: 'string',
                description: '[grep/find] Directory to search. Defaults to the workspace directory.',
            },
            isRegex: {
                type: 'boolean',
                description: '[grep] Whether to treat query as a regular expression. Defaults to false.',
            },
            includes: {
                type: 'array',
                items: { type: 'string', description: 'Glob pattern.' },
                description: '[grep/find] File filter globs, for example ["*.ts", "*.tsx"].',
            },
            pattern: {
                type: 'string',
                description: '[find] File name glob pattern, for example "*.module.css".',
            },
            maxDepth: {
                type: 'number',
                description: '[find] Maximum search depth.',
            },
            fileType: {
                type: 'string',
                description: '[find] Type filter: file / directory / any.',
                enum: ['file', 'directory', 'any'],
            },
            path: {
                type: 'string',
                description: '[outline/symbol] Target file path.',
            },
            symbolName: {
                type: 'string',
                description: '[symbol] Fully qualified symbol name, for example "ClassName.methodName".',
            },
        },
        required: ['mode'],
    },
};

// ==================== 工具实现 ====================

class LocalSearchToolImpl implements Tool {
    readonly schema = SCHEMA;

    async execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const mode = (params.mode ?? params.search_mode) as string;

        if (!mode) {
            return {
                success: false,
                content: translate('tools.localSearch.missingMode'),
            };
        }

        try {
            switch (mode) {
                case 'grep':
                    return await this.executeGrep(params, context);
                case 'find':
                    return await this.executeFind(params, context);
                case 'outline':
                    return await this.executeOutline(params, context);
                case 'symbol':
                    return await this.executeSymbol(params, context);
                default:
                    return {
                        success: false,
                        content: translate('tools.localSearch.unknownMode', { mode }),
                    };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[LocalSearchTool] ${mode} 执行失败:`, errorMessage);
            return {
                success: false,
                content: translate('tools.localSearch.failed', { mode, error: errorMessage }),
            };
        }
    }

    // ==================== grep 模式 ====================

    private async executeGrep(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const query = (params.query ?? params.search_query) as string;
        if (!query) {
            return { success: false, content: translate('tools.localSearch.missingGrepQuery') };
        }

        // 搜索路径：优先使用参数指定的，否则使用 workdir
        const searchPath = this.resolveSearchPath(
            params.searchPath as string | undefined,
            context.workdir
        );
        const sandboxViolation = getSandboxPathViolation(searchPath, context);
        if (sandboxViolation) {
            return {
                success: false,
                content: sandboxViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path: searchPath })
                    : translate('tools.common.sandboxPathDenied', {
                        path: searchPath,
                        root: sandboxViolation.root,
                        mode: sandboxViolation.mode,
                    }),
            };
        }

        // 规范化 grep 查询：检测正则元字符，自动提升 isRegex
        const { normalizedQuery, normalizedIsRegex } = normalizeGrepQuery(
            query,
            params.isRegex as boolean | undefined
        );

        const results = await invoke<GrepMatch[]>('code_grep', {
            query: normalizedQuery,
            searchPath,
            isRegex: normalizedIsRegex,
            includes: params.includes as string[] | undefined,
        });

        context.onProgress?.(translate('tools.localSearch.grepProgress', { count: results.length }));

        if (results.length === 0) {
            return { success: true, content: translate('tools.localSearch.grepNoResults', { query }) };
        }

        // 按文件分组格式化输出
        const formatted = this.formatGrepResults(results, query);
        return {
            success: true,
            content: formatted,
            data: { mode: 'grep', matchCount: results.length },
        };
    }

    // ==================== find 模式 ====================

    private async executeFind(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const pattern = (params.pattern ?? params.file_pattern) as string;
        if (!pattern) {
            return { success: false, content: translate('tools.localSearch.missingFindPattern') };
        }

        const searchPath = this.resolveSearchPath(
            params.searchPath as string | undefined,
            context.workdir
        );
        const sandboxViolation = getSandboxPathViolation(searchPath, context);
        if (sandboxViolation) {
            return {
                success: false,
                content: sandboxViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path: searchPath })
                    : translate('tools.common.sandboxPathDenied', {
                        path: searchPath,
                        root: sandboxViolation.root,
                        mode: sandboxViolation.mode,
                    }),
            };
        }

        const results = await invoke<FindResult[]>('code_find', {
            pattern,
            searchPath,
            maxDepth: params.maxDepth as number | undefined,
            fileType: params.fileType as string | undefined,
            includes: params.includes as string[] | undefined,
        });

        context.onProgress?.(translate('tools.localSearch.findProgress', { count: results.length }));

        if (results.length === 0) {
            return { success: true, content: translate('tools.localSearch.findNoResults', { pattern }) };
        }

        const formatted = this.formatFindResults(results, pattern);
        return {
            success: true,
            content: formatted,
            data: { mode: 'find', resultCount: results.length },
        };
    }

    // ==================== outline 模式 ====================

    private async executeOutline(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const path = this.resolvePath(
            (params.path ?? params.file_path ?? params.filePath) as string,
            context.workdir
        );
        if (!path) {
            return { success: false, content: translate('tools.localSearch.missingOutlinePath') };
        }
        const sandboxViolation = getSandboxPathViolation(path, context);
        if (sandboxViolation) {
            return {
                success: false,
                content: sandboxViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path })
                    : translate('tools.common.sandboxPathDenied', {
                        path,
                        root: sandboxViolation.root,
                        mode: sandboxViolation.mode,
                    }),
            };
        }

        const items = await invoke<OutlineItem[]>('code_outline', { path });

        context.onProgress?.(translate('tools.localSearch.outlineProgress', { count: items.length }));

        if (items.length === 0) {
            // 根据扩展名精准判断：是不支持的语言，还是文件本身为空
            const unsupportedHint = getUnsupportedLanguageHint(path);
            const message = unsupportedHint
                ? translate('tools.localSearch.outlineUnsupported', { path, hint: unsupportedHint })
                : translate('tools.localSearch.outlineEmpty', { path });
            return {
                success: true,
                content: message,
            };
        }

        const formatted = this.formatOutlineResults(items, path);
        return {
            success: true,
            content: formatted,
            data: { mode: 'outline', symbolCount: items.length },
        };
    }

    // ==================== symbol 模式 ====================

    private async executeSymbol(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const path = this.resolvePath(
            (params.path ?? params.file_path ?? params.filePath) as string,
            context.workdir
        );
        const symbolName = (params.symbolName ?? params.symbol_name) as string;

        if (!path) {
            return { success: false, content: translate('tools.localSearch.missingSymbolPath') };
        }
        const sandboxViolation = getSandboxPathViolation(path, context);
        if (sandboxViolation) {
            return {
                success: false,
                content: sandboxViolation.reason === 'missingWorkdir'
                    ? translate('tools.common.sandboxMissingWorkdir', { path })
                    : translate('tools.common.sandboxPathDenied', {
                        path,
                        root: sandboxViolation.root,
                        mode: sandboxViolation.mode,
                    }),
            };
        }
        if (!symbolName) {
            return { success: false, content: translate('tools.localSearch.missingSymbolName') };
        }

        const result = await invoke<string>('code_symbol', {
            path,
            symbolName,
        });

        context.onProgress?.(translate('tools.localSearch.symbolProgress', { symbolName }));

        return {
            success: true,
            content: result,
            data: { mode: 'symbol', symbolName },
        };
    }

    // ==================== 格式化方法 ====================

    /** 格式化 grep 结果：按文件分组，显示行号和内容 */
    private formatGrepResults(results: GrepMatch[], query: string): string {
        const grouped = new Map<string, GrepMatch[]>();
        for (const match of results) {
            const existing = grouped.get(match.file);
            if (existing) {
                existing.push(match);
            } else {
                grouped.set(match.file, [match]);
            }
        }

        const lines: string[] = [translate('tools.localSearch.grepHeader', { query, count: results.length })];

        for (const [file, matches] of grouped) {
            lines.push(`📄 ${file}`);
            for (const m of matches) {
                lines.push(`  L${m.line}: ${m.content}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /** 格式化 find 结果 */
    private formatFindResults(results: FindResult[], pattern: string): string {
        const lines: string[] = [translate('tools.localSearch.findHeader', { pattern, count: results.length })];

        for (const r of results) {
            if (r.fileType === 'directory') {
                lines.push(`📁 ${r.path}`);
            } else {
                const sizeStr = this.formatFileSize(r.size);
                lines.push(`📄 ${r.path} (${sizeStr})`);
            }
        }

        return lines.join('\n');
    }

    /** 格式化 outline 结果：递归树状结构 */
    private formatOutlineResults(items: OutlineItem[], path: string): string {
        // 提取文件名
        const fileName = path.split(/[\\/]/).pop() ?? path;
        const lines: string[] = [`📋 ${fileName}\n`];

        // 递归渲染符号树，支持任意深度嵌套（如 Python 内部类/函数套函数）
        this.renderOutlineTree(items, lines, 1);

        return lines.join('\n');
    }

    /** 递归渲染 outline 符号树 */
    private renderOutlineTree(items: OutlineItem[], lines: string[], depth: number): void {
        const indent = '  '.repeat(depth);
        const connector = depth > 1 ? '├─ ' : '';

        for (const item of items) {
            const kindIcon = this.getKindIcon(item.kind);
            lines.push(`${indent}${connector}${kindIcon} ${item.name}  L${item.startLine}-L${item.endLine}`);

            if (item.children.length > 0) {
                this.renderOutlineTree(item.children, lines, depth + 1);
            }
        }
    }

    // ==================== 辅助方法 ====================

    /** 路径解析（与 read 工具保持一致） */
    private resolvePath(inputPath: string | undefined, workdir?: string): string | null {
        if (!inputPath) return null;

        // 规范化 Git Bash 风格路径：/f/... → f:/...
        inputPath = normalizeFilePath(inputPath);

        // Windows 绝对路径
        if (/^[a-zA-Z]:[/\\]/.test(inputPath)) {
            return inputPath;
        }

        if (!workdir) return inputPath;

        // 相对路径拼接
        let relativePath = inputPath;
        if (relativePath.startsWith('./')) {
            relativePath = relativePath.slice(2);
        }
        if (relativePath.startsWith('/')) {
            const parts = relativePath.split('/').filter(p => p.length > 0);
            relativePath = parts[parts.length - 1] ?? relativePath;
        }

        const separator = workdir.includes('\\') ? '\\' : '/';
        const normalizedWorkdir = workdir.endsWith(separator) ? workdir.slice(0, -1) : workdir;
        return `${normalizedWorkdir}${separator}${relativePath}`;
    }

    /** 搜索路径解析（默认 workdir） */
    private resolveSearchPath(inputPath: string | undefined, workdir?: string): string {
        if (inputPath) {
            // 尝试解析为绝对路径
            const resolved = this.resolvePath(inputPath, workdir);
            if (resolved) return resolved;
        }
        // 默认使用 workdir
        return workdir ?? '.';
    }

    /** 获取符号类型对应的图标 */
    private getKindIcon(kind: string): string {
        const icons: Record<string, string> = {
            class: '🏛️',
            interface: '📐',
            function: 'ƒ',
            method: '⚡',
            type: '📝',
            enum: '🔢',
            struct: '🧱',
            trait: '🔗',
            impl: '⚙️',
            rule: '🎨',
        };
        return icons[kind] ?? '•';
    }

    /** 格式化文件大小 */
    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
}

/**
 * 导出单例实例
 */
export const localSearchTool = new LocalSearchToolImpl();
