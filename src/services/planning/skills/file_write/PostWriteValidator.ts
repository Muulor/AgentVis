/**
 * PostWriteValidator — 代码写入后语法检查器
 *
 * 职责：给定文件路径，路由到对应语言检查器，返回结构化错误列表。
 *
 * 设计决策：
 * - 采用后缀映射 + 语言工具链策略（而非 Tree-sitter/LSP），
 *   原因是 Tree-sitter 需要编译 C 扩展，Windows 依赖 MSVC，安装不稳定；
 *   LSP 需要常驻进程，生命周期管理复杂，属于过度设计。
 * - 超时后静默降级为括号配对兜底，不阻塞 file_write 返回。
 * - 仅上报 error 级别，过滤 warning/info，避免 Observation 噪音干扰 Agent 决策。
 * - 每次检查最多返回 MAX_ERRORS_REPORTED 条错误，防止大量错误灌满 Observation。
 *
 * 语言覆盖：
 *   .ts/.tsx         → tsc --noEmit（项目模式，需 tsconfig.json；否则降级单文件）
 *   .py              → pyright/mypy（项目模式）/ python -m py_compile（兜底）
 *   .js/.mjs/.cjs    → eslint（项目模式）/ node --check（兜底）
 *   .jsx             → eslint（项目模式）/ 括号配对兜底
 *   .json            → python -m json.tool       （py 内置）
 *   .yaml/.yml       → js-yaml loadAll           （项目内依赖）
 *   .toml            → python tomllib/tomli      （py 内置优先）
 *   .rs              → cargo check（项目模式）/ rustc --emit=metadata（兜底）
 *   .go              → go test（package 编译）/ gofmt -e（parse-only 兜底）
 *   其他             → 括号配对降级 / checked=false
 *
 * tsc 超时修复（v2）：
 *   原实现使用 `npx tsc --noEmit "单文件路径"` 单文件孤立模式，
 *   每次冷启动 tsc 进程约需 15-30s → 必然超时。
 *   修复策略：向上查找最近的 tsconfig.json，在其目录执行全项目
 *   `npx tsc --noEmit --skipLibCheck`，之后从输出中只提取
 *   与当前文件相关的错误，减少 Observation 噪音。
 *   超时阈值从 8s 调整为 30s（项目模式首次约 5-20s，有缓存后 < 3s）。
 */

import yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('PostWriteValidator');

// ══════════════════════════════════════════════════════════
// 公共类型
// ══════════════════════════════════════════════════════════

/** 单条语法错误 */
export interface SyntaxError {
    /** 工具输出中的文件路径（项目级检查时可用） */
    filePath?: string;
    /** 错误行号（1-based；工具无法给出时为 0） */
    line: number;
    /** 错误列号（可选，1-based） */
    column?: number;
    /** 错误描述 */
    message: string;
}

/** 验证结果 */
export interface ValidationResult {
    /**
     * 是否执行了检查
     * false = 语言不在支持列表，或工具链未找到，或超时降级后 fallback 也无法运行
     */
    checked: boolean;
    /** 使用的检查工具标识 */
    tool: 'tsc' | 'py_compile' | 'pyright' | 'mypy' | 'node_check' | 'json_tool' | 'rustc' | 'cargo_check' | 'eslint' | 'go_test' | 'gofmt' | 'yaml_parse' | 'toml_parse' | 'bracket_fallback' | 'none';
    /** 检测到的错误列表（上限 MAX_ERRORS_REPORTED 条；空数组 = 通过） */
    errors: SyntaxError[];
    /**
     * 项目模式下与本次写入可能相关的其他文件诊断。
     *
     * 典型场景：修改 types.ts / shared.ts 后，当前文件本身无错，
     * 但消费者文件出现类型错误。该字段用于阻止错误积累到最终全量 tsc。
     */
    relatedErrors?: SyntaxError[];
    /** 工具输出中扫描到的项目级错误总数（用于提示仍有未展示诊断） */
    projectErrorCount?: number;
    /** 原始工具输出（仅调试用，不注入 Agent Prompt） */
    rawOutput?: string;
}

/** 工具调用上下文（来自 ToolExecutionContext 的子集） */
export interface ValidatorContext {
    /** venv Python 可执行文件路径（用于 py_compile / json_tool） */
    venvPythonPath?: string;
    /** 工作目录（用于向上查找 tsconfig.json） */
    workdir?: string;
    /** 任务取消信号，用于中断写后语法检查进程 */
    signal?: AbortSignal;
}

// ══════════════════════════════════════════════════════════
// 内部常量
// ══════════════════════════════════════════════════════════

/** 各语言检查超时（秒） */
const TIMEOUTS: Record<string, number> = {
    /**
     * tsc 超时策略（v3）：
     * - v1 8s + 单文件模式 = 100% 超时
     * - v2 30s + 项目模式 = 首次冷启动仍可能超时
     * - v3 30s + 本地二进制 + --incremental = 首次运行超时高风险，二次起 < 3s
     *
     * 为何 30s 无法覆盖大型项目首次冷启动：
     *   AgentVis 有数百个 TS 文件，冷启动全项目检查可超 30s。
     *   --incremental 写入 .tsbuildinfo 后，后续每次只增量检查变更文件，
     *   通常 1-3s 并且不会再超时。
     */
    tsc: 30,
    py_compile: 5,
    pyright: 30,
    mypy: 30,
    node_check: 5,
    eslint: 15,
    json_tool: 5,
    toml_parse: 5,
    cargo_check: 60,
    /**
     * rustc --emit=metadata 仅做 AST 解析，跳过链接，通常 3-10s 完成
     * 首次冷启动（无缓存）需额外编译 core crate，保留 15s 余量
     */
    rustc: 15,
    /**
     * gofmt -e 是纯 parse-only 操作，极快，通常 < 1s
     */
    gofmt: 5,
    go_test: 30,
};

/** 默认超时（不在映射中时使用） */
const DEFAULT_TIMEOUT = 5;

/**
 * 最多向 Agent 报告的错误条数
 *
 * 防止在 tsconfig 全项目检查时，几百条错误全部灌入 Observation，
 * 超出 LLM 上下文有效注意力范围。Agent 每次修一批即可。
 */
const MAX_ERRORS_REPORTED = 5;
const MAX_RELATED_ERRORS_REPORTED = 5;
const MAX_TSC_PROJECT_ERRORS_SCANNED = 50;
const MAX_PROJECT_ERRORS_SCANNED = 50;
const VALIDATION_CANCELLED_ERROR = 'validation_cancelled';

function capture(match: ArrayLike<string | undefined>, index: number): string {
    return match[index] ?? '';
}

function captureInt(match: ArrayLike<string | undefined>, index: number): number {
    return parseInt(capture(match, index), 10);
}

/**
 * tsconfig.json 向上搜索的最大目录层级
 * 避免在超大仓库中无限向上搜索
 */
const MAX_TSCONFIG_SEARCH_DEPTH = 8;
const MAX_PROJECT_CONFIG_SEARCH_DEPTH = 8;

/**
 * 从文件路径提取小写扩展名（含 '.'，如 '.ts'）
 *
 * 使用与 tool.ts getFileName 相同的内联字符串策略，
 * 避免引入 path-browserify 或 Node.js path 模块。
 */
function getFileExtension(filePath: string): string {
    // 先提取文件名部分（支持 / 和 \ 分隔符）
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return '';
    return fileName.substring(dotIndex).toLowerCase();
}

/**
 * 获取文件所在目录
 */
function getDirPath(filePath: string): string {
    // 找到最后一个 / 或 \ 的位置
    const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSep > 0 ? filePath.substring(0, lastSep) : '.';
}

/**
 * 获取路径分隔符（根据路径风格判断）
 */
function getPathSeparator(filePath: string): string {
    return filePath.includes('\\') ? '\\' : '/';
}

function getFileBaseName(filePath: string): string {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.slice(0, dotIndex).toLowerCase() : fileName.toLowerCase();
}

function getParentDir(dirPath: string): string | undefined {
    const lastSep = Math.max(dirPath.lastIndexOf('/'), dirPath.lastIndexOf('\\'));
    if (lastSep <= 0) return undefined;
    const parentDir = dirPath.substring(0, lastSep);
    if (parentDir === dirPath || /^[a-zA-Z]:$/.test(parentDir)) return undefined;
    return parentDir;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
    try {
        const content = await invoke<string>('file_read_content', { filePath });
        return typeof content === 'string' ? content : undefined;
    } catch {
        return undefined;
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    return (await readFileIfExists(filePath)) !== undefined;
}

/**
 * shell_execute 调用结果（与 ExecTool 中的 ExecResult 保持一致）
 */
interface ShellResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function createShellExecutionId(): string {
    return `validator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidationCancelled(error: unknown): boolean {
    return error instanceof Error && error.message === VALIDATION_CANCELLED_ERROR;
}

function cancelledValidationResult(): ValidationResult {
    return { checked: false, tool: 'none', errors: [] };
}

// ══════════════════════════════════════════════════════════
// Shell 调用抽象层
// ══════════════════════════════════════════════════════════

/**
 * 调用 Tauri shell_execute Rust 命令执行语法检查器
 * 超时时 Rust 层抛出，这里 catch 后向上传播（由调用方决定如何降级）
 */
async function runChecker(
    command: string,
    workdir: string | undefined,
    timeoutSecs: number,
    signal?: AbortSignal
): Promise<ShellResult> {
    if (signal?.aborted) {
        throw new Error(VALIDATION_CANCELLED_ERROR);
    }

    const executionId = signal ? createShellExecutionId() : undefined;
    const cancelShellExecution = (): void => {
        if (!executionId) return;
        invoke('shell_cancel', { executionId }).catch((cancelError: unknown) => {
            logger.warn('[PostWriteValidator] 取消语法检查进程失败:', cancelError);
        });
    };
    signal?.addEventListener('abort', cancelShellExecution, { once: true });

    try {
        const result = await invoke<ShellResult>('shell_execute', {
            command,
            workdir: workdir ?? '.',
            timeoutSecs,
            background: false,
            executionId,
        });

        if (signal?.aborted) {
            throw new Error(VALIDATION_CANCELLED_ERROR);
        }

        return result;
    } catch (error) {
        if (signal?.aborted) {
            throw new Error(VALIDATION_CANCELLED_ERROR);
        }
        throw error;
    } finally {
        signal?.removeEventListener('abort', cancelShellExecution);
    }
}

// ══════════════════════════════════════════════════════════
// tsconfig.json 查找
// ══════════════════════════════════════════════════════════

/**
 * 在 tsconfig.json 所在目录及其父目录的 node_modules 里查找本地 tsc 二进制
 *
 * 为什么用本地二进制而非 npx：
 *   npx 每次运行都会解析包名、检查缓存、冷1-3s 额外开销。
 *   本地 node_modules/.bin/tsc（Windows: tsc.cmd）直接调用，无额外负担。
 *
 * @param tsconfigDir tsconfig.json 所在目录
 * @returns 本地 tsc 命令（带引号包裹），找不到时返回 undefined
 */
async function findLocalTscBinary(tsconfigDir: string): Promise<string | undefined> {
    const sep = getPathSeparator(tsconfigDir);

    // 从 tsconfigDir 向上查找 node_modules/.bin/tsc.cmd（Windows 中 .bin 下是 .cmd，非 .bin/tsc）
    //
    // Windows PowerShell / cmd 调用解析顺序：
    //   tsc.cmd > tsc.ps1 > tsc（无扩展名）
    // node_modules/.bin/ 目录下存在 tsc.cmd 和 tsc（无扩展名）两个文件；
    // PowerShell 中调用 tsc.cmd 需要包展名
    const candidates = ['tsc.cmd', 'tsc'];

    let currentDir = tsconfigDir;
    // 最多查 4 层（大多数项目 node_modules 在 tsconfig 旁边或上 1-2 层）
    for (let depth = 0; depth < 4; depth++) {
        for (const candidate of candidates) {
            const binPath = `${currentDir}${sep}node_modules${sep}.bin${sep}${candidate}`;
            try {
                await invoke<string>('file_read_content', { filePath: binPath });
                // 能读到说明文件存在
                logger.trace(`[PostWriteValidator] 找到本地 tsc: ${binPath}`);
                // Windows 下需用 .cmd 后缀局式才能由 shell 直接调用
                // 直接把完整路径包在引号里返回
                return `"${binPath}"`;
            } catch {
                // 不存在，继续尝试
            }
        }

        // 向上一层
        const lastSep = Math.max(currentDir.lastIndexOf('/'), currentDir.lastIndexOf('\\'));
        if (lastSep <= 0) break;
        const parentDir = currentDir.substring(0, lastSep);
        if (parentDir === currentDir || /^[a-zA-Z]:$/.test(parentDir)) break;
        currentDir = parentDir;
    }

    logger.trace('[PostWriteValidator] 未找到本地 tsc，回退使用 npx');
    return undefined;
}

/**
 * 从文件所在目录向上查找最近的 tsconfig.json
 *
 * 策略：
 * 1. 从文件目录开始，逐层向上搜索
 * 2. 找到 tsconfig.json 即返回其所在目录（作为 tsc 的工作目录）
 * 3. 超过 MAX_TSCONFIG_SEARCH_DEPTH 层或到达根目录时返回 undefined
 *
 * 为什么在 TypeScript 层查找而不是在 shell 里：
 * 避免 PowerShell 脚本的跨平台兼容问题（macOS/Linux 的 while 语法不同）。
 *
 * @returns tsconfig.json 所在目录的路径，或 undefined（未找到）
 */
async function findTsconfigDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);

    for (let depth = 0; depth < MAX_TSCONFIG_SEARCH_DEPTH; depth++) {
        const tsconfigPath = `${currentDir}${sep}tsconfig.json`;

        try {
            // 尝试读取文件，成功说明 tsconfig.json 存在
            await invoke<string>('file_read_content', { filePath: tsconfigPath });
            logger.trace(`[PostWriteValidator] 找到 tsconfig.json: ${tsconfigPath}`);
            return currentDir;
        } catch {
            // 文件不存在，向上一层
        }

        // 计算父目录
        const lastSep = Math.max(currentDir.lastIndexOf('/'), currentDir.lastIndexOf('\\'));
        if (lastSep <= 0) {
            // 已到根目录
            break;
        }
        // 处理 Windows 根目录（如 "C:" 不能再向上）
        const parentDir = currentDir.substring(0, lastSep);
        if (parentDir === currentDir || /^[a-zA-Z]:$/.test(parentDir)) {
            break;
        }
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 tsconfig.json（从 ${getDirPath(filePath)} 向上搜索 ${MAX_TSCONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

// ══════════════════════════════════════════════════════════
// 各语言错误解析函数
// ══════════════════════════════════════════════════════════

/**
 * 规范化文件路径用于比较（统一为小写 + 正斜杠）
 */
function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getStringProp(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

function getNumberProp(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRecordProp(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
    const value = record[key];
    return isRecord(value) ? value : undefined;
}

function getArrayProp(record: Record<string, unknown>, key: string): unknown[] | undefined {
    const value = record[key];
    return Array.isArray(value) ? value : undefined;
}

function pathsReferToSameFile(diagnosticPath: string | undefined, targetFilePath: string): boolean {
    if (!diagnosticPath) return false;
    const diagnostic = normalizePath(diagnosticPath);
    const target = normalizePath(targetFilePath);
    return diagnostic === target
        || target.endsWith(`/${diagnostic}`)
        || diagnostic.endsWith(`/${target}`)
        || target.endsWith(diagnostic);
}

/**
 * 解析 tsc 的 stderr/stdout 输出
 *
 * tsc 典型格式：
 *   src/foo.ts(45,7): error TS2339: Property 'x' does not exist on type 'Y'.
 *
 * 注意：tsc 将错误写入 stdout（不是 stderr），退出码非 0 表示有错误。
 *
 * @param output    tsc 完整输出（stdout + stderr 合并）
 * @param fileFilter 可选，只保留以此路径结尾的文件的错误（项目模式时过滤）
 *                   使用路径后缀匹配（取最后 2~3 段），避免同名不同目录的文件误合并
 */
function parseTscOutput(
    output: string,
    fileFilter?: string,
    limit = MAX_ERRORS_REPORTED
): SyntaxError[] {
    // 匹配：任意路径(行,列): error TSxxxx: 消息
    // 路径允许包含 Windows 盘符冒号（如 C:\project\src\App.tsx）。
    const pattern = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/gm;
    const errors: SyntaxError[] = [];
    let match: RegExpExecArray | null;

    // 将过滤路径规范化后取最后几个路径分段作为唯一性基准
    // 例如：C:\proj\src\audio\Track.ts → src/audio/track.ts（最后3段）
    const normalizedFilterSuffix = fileFilter
        ? normalizePath(fileFilter).split('/').slice(-3).join('/')
        : undefined;

    while ((match = pattern.exec(output)) !== null) {
        const errorFilePath = capture(match, 1).trim();

        // 如果指定了过滤条件，用路径后缀匹配（更精确，避免同名文件混淆）
        if (normalizedFilterSuffix) {
            const normalizedError = normalizePath(errorFilePath).split('/').slice(-3).join('/');
            if (!normalizedError.endsWith(normalizedFilterSuffix.split('/').slice(-2).join('/'))) {
                continue;
            }
        }

        errors.push({
            filePath: errorFilePath,
            line: captureInt(match, 2),
            column: captureInt(match, 3),
            message: capture(match, 4).trim(),
        });

        if (errors.length >= limit) {
            break;
        }
    }

    return errors;
}

async function findCargoTomlDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);

    for (let depth = 0; depth < MAX_PROJECT_CONFIG_SEARCH_DEPTH; depth++) {
        const cargoTomlPath = `${currentDir}${sep}Cargo.toml`;
        if (await fileExists(cargoTomlPath)) {
            logger.trace(`[PostWriteValidator] 找到 Cargo.toml: ${cargoTomlPath}`);
            return currentDir;
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 Cargo.toml（从 ${getDirPath(filePath)} 向上搜索 ${MAX_PROJECT_CONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

async function findEslintConfigDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);
    const configNames = [
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.cjs',
        '.eslintrc.cjs',
        '.eslintrc.js',
        '.eslintrc.json',
        '.eslintrc.yml',
        '.eslintrc.yaml',
    ];

    for (let depth = 0; depth < MAX_PROJECT_CONFIG_SEARCH_DEPTH; depth++) {
        for (const configName of configNames) {
            const configPath = `${currentDir}${sep}${configName}`;
            if (await fileExists(configPath)) {
                logger.trace(`[PostWriteValidator] 找到 ESLint 配置: ${configPath}`);
                return currentDir;
            }
        }

        const packageJsonPath = `${currentDir}${sep}package.json`;
        const packageJson = await readFileIfExists(packageJsonPath);
        if (packageJson?.includes('"eslintConfig"')) {
            logger.trace(`[PostWriteValidator] 找到 package.json eslintConfig: ${packageJsonPath}`);
            return currentDir;
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 ESLint 配置（从 ${getDirPath(filePath)} 向上搜索 ${MAX_PROJECT_CONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

function hasConfigSection(content: string, sectionName: string): boolean {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, 'm').test(content);
}

async function findPyrightConfigDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);

    for (let depth = 0; depth < MAX_PROJECT_CONFIG_SEARCH_DEPTH; depth++) {
        const pyrightConfigPath = `${currentDir}${sep}pyrightconfig.json`;
        if (await fileExists(pyrightConfigPath)) {
            logger.trace(`[PostWriteValidator] 找到 Pyright 配置: ${pyrightConfigPath}`);
            return currentDir;
        }

        const pyprojectPath = `${currentDir}${sep}pyproject.toml`;
        const pyproject = await readFileIfExists(pyprojectPath);
        if (pyproject && hasConfigSection(pyproject, 'tool.pyright')) {
            logger.trace(`[PostWriteValidator] 找到 pyproject.toml [tool.pyright]: ${pyprojectPath}`);
            return currentDir;
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 Pyright 配置（从 ${getDirPath(filePath)} 向上搜索 ${MAX_PROJECT_CONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

async function findMypyConfigDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);

    for (let depth = 0; depth < MAX_PROJECT_CONFIG_SEARCH_DEPTH; depth++) {
        for (const configName of ['mypy.ini', '.mypy.ini']) {
            const configPath = `${currentDir}${sep}${configName}`;
            if (await fileExists(configPath)) {
                logger.trace(`[PostWriteValidator] 找到 Mypy 配置: ${configPath}`);
                return currentDir;
            }
        }

        const pyprojectPath = `${currentDir}${sep}pyproject.toml`;
        const pyproject = await readFileIfExists(pyprojectPath);
        if (pyproject && hasConfigSection(pyproject, 'tool.mypy')) {
            logger.trace(`[PostWriteValidator] 找到 pyproject.toml [tool.mypy]: ${pyprojectPath}`);
            return currentDir;
        }

        const setupCfgPath = `${currentDir}${sep}setup.cfg`;
        const setupCfg = await readFileIfExists(setupCfgPath);
        if (setupCfg && hasConfigSection(setupCfg, 'mypy')) {
            logger.trace(`[PostWriteValidator] 找到 setup.cfg [mypy]: ${setupCfgPath}`);
            return currentDir;
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 Mypy 配置（从 ${getDirPath(filePath)} 向上搜索 ${MAX_PROJECT_CONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

async function findGoModuleDir(filePath: string): Promise<string | undefined> {
    const sep = getPathSeparator(filePath);
    let currentDir = getDirPath(filePath);

    for (let depth = 0; depth < MAX_PROJECT_CONFIG_SEARCH_DEPTH; depth++) {
        for (const configName of ['go.mod', 'go.work']) {
            const configPath = `${currentDir}${sep}${configName}`;
            if (await fileExists(configPath)) {
                logger.trace(`[PostWriteValidator] 找到 Go 配置: ${configPath}`);
                return currentDir;
            }
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到 go.mod/go.work（从 ${getDirPath(filePath)} 向上搜索 ${MAX_PROJECT_CONFIG_SEARCH_DEPTH} 层）`);
    return undefined;
}

function getRelativeDir(rootDir: string, targetDir: string): string | undefined {
    const root = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
    const target = targetDir.replace(/\\/g, '/').replace(/\/$/, '');
    const rootLower = root.toLowerCase();
    const targetLower = target.toLowerCase();

    if (targetLower === rootLower) return '';
    if (!targetLower.startsWith(`${rootLower}/`)) return undefined;
    return target.slice(root.length + 1);
}

function getGoPackagePattern(filePath: string, moduleDir: string): string {
    const relativeDir = getRelativeDir(moduleDir, getDirPath(filePath));
    if (!relativeDir) return '.';
    return `./${relativeDir}`;
}

async function findLocalNodeBinary(startDir: string, binaryNames: string[], label: string): Promise<string | undefined> {
    const sep = getPathSeparator(startDir);
    let currentDir = startDir;

    for (let depth = 0; depth < 4; depth++) {
        for (const binaryName of binaryNames) {
            const binPath = `${currentDir}${sep}node_modules${sep}.bin${sep}${binaryName}`;
            if (await fileExists(binPath)) {
                logger.trace(`[PostWriteValidator] 找到本地 ${label}: ${binPath}`);
                return `"${binPath}"`;
            }
        }

        const parentDir = getParentDir(currentDir);
        if (!parentDir) break;
        currentDir = parentDir;
    }

    logger.trace(`[PostWriteValidator] 未找到本地 ${label}`);
    return undefined;
}

function sameDiagnostic(a: SyntaxError, b: SyntaxError): boolean {
    return normalizePath(a.filePath ?? '') === normalizePath(b.filePath ?? '')
        && a.line === b.line
        && a.column === b.column
        && a.message === b.message;
}

function scoreRelatedProjectError(error: SyntaxError, targetFilePath: string): number {
    const errorPath = normalizePath(error.filePath ?? '');
    const targetPath = normalizePath(targetFilePath);
    const targetParts = targetPath.split('/');
    const targetParent = targetParts[targetParts.length - 2] ?? '';
    const targetBase = getFileBaseName(targetFilePath);

    if (!errorPath) return 50;

    const errorParts = errorPath.split('/');
    const errorParent = errorParts[errorParts.length - 2] ?? '';
    if (targetParent && errorParent === targetParent) return 0;

    if (targetBase && error.message.toLowerCase().includes(targetBase)) return 1;

    const targetTopLevel = targetParts.includes('src')
        ? targetParts[targetParts.indexOf('src') + 1]
        : targetParts[targetParts.length - 3];
    const errorTopLevel = errorParts.includes('src')
        ? errorParts[errorParts.indexOf('src') + 1]
        : errorParts[errorParts.length - 3];
    if (targetTopLevel && errorTopLevel && targetTopLevel === errorTopLevel) return 2;

    return 10;
}

function selectRelatedProjectErrors(
    projectErrors: SyntaxError[],
    currentErrors: SyntaxError[],
    targetFilePath: string
): SyntaxError[] {
    const targetPath = normalizePath(targetFilePath);

    return projectErrors
        .filter(error => {
            if (pathsReferToSameFile(error.filePath, targetPath)) return false;
            if (currentErrors.some(current => sameDiagnostic(current, error))) return false;
            return true;
        })
        .sort((a, b) => scoreRelatedProjectError(a, targetFilePath) - scoreRelatedProjectError(b, targetFilePath))
        .slice(0, MAX_RELATED_ERRORS_REPORTED);
}

function buildProjectValidationResult(
    tool: ValidationResult['tool'],
    projectErrors: SyntaxError[],
    filePath: string,
    rawOutput: string
): ValidationResult {
    const errors = projectErrors
        .filter(error => pathsReferToSameFile(error.filePath, filePath))
        .slice(0, MAX_ERRORS_REPORTED);
    const relatedErrors = selectRelatedProjectErrors(projectErrors, errors, filePath);

    return {
        checked: true,
        tool,
        errors,
        relatedErrors,
        projectErrorCount: projectErrors.length,
        rawOutput,
    };
}


/**
 * 解析 python -m py_compile 的 stderr 输出
 *
 * py_compile 典型格式（Python 3.x）：
 *   File "path/to/foo.py", line 10
 *     some_code
 *   SyntaxError: invalid syntax
 */
function parsePyCompileOutput(stderr: string): SyntaxError[] {
    const errors: SyntaxError[] = [];

    // 匹配 File "...", line N 格式（Python 标准格式）
    const fileLinePattern = /File\s+"[^"]+",\s+line\s+(\d+)/g;
    let match: RegExpExecArray | null;

    while ((match = fileLinePattern.exec(stderr)) !== null) {
        const line = captureInt(match, 1);
        // 提取紧随其后的错误类型
        const remainder = stderr.substring(match.index + match[0].length);
        const msgMatch = remainder.match(/\n.*\n?\s*(SyntaxError:[^\n]+)/);
        const message = msgMatch ? (msgMatch[1] ?? '').trim() : 'SyntaxError';
        errors.push({ line, message });
    }

    if (errors.length > 0) {
        return errors.slice(0, MAX_ERRORS_REPORTED);
    }

    // 紧凑格式兜底：形如 /path/file.py:10: SyntaxError: ...
    // 注意：必须排除 Windows 驱动器前缀（如 C:\ 中的 C:），
    // 使用"至少 2 位数字"来区分行号和驱动器盘符（盘符只有 1 个字母）
    const compactPattern = /:[^:\\/](\d{2,}):\s+(.+)/g;
    while ((match = compactPattern.exec(stderr)) !== null) {
        errors.push({
            line: captureInt(match, 1),
            message: capture(match, 2).trim(),
        });
        if (errors.length >= MAX_ERRORS_REPORTED) break;
    }

    return errors;
}

function parsePyrightJsonOutput(stdout: string): SyntaxError[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed) as unknown;
    } catch {
        return [];
    }

    if (!isRecord(parsed)) return [];
    const diagnostics = getArrayProp(parsed, 'generalDiagnostics') ?? [];
    const errors: SyntaxError[] = [];

    for (const diagnostic of diagnostics) {
        if (!isRecord(diagnostic) || getStringProp(diagnostic, 'severity') !== 'error') {
            continue;
        }

        const range = getRecordProp(diagnostic, 'range');
        const start = range ? getRecordProp(range, 'start') : undefined;
        const line = start ? (getNumberProp(start, 'line') ?? -1) + 1 : 0;
        const column = start ? (getNumberProp(start, 'character') ?? -1) + 1 : undefined;

        errors.push({
            filePath: getStringProp(diagnostic, 'file'),
            line: line > 0 ? line : 0,
            column: column && column > 0 ? column : undefined,
            message: getStringProp(diagnostic, 'message') ?? 'Pyright error',
        });

        if (errors.length >= MAX_PROJECT_ERRORS_SCANNED) break;
    }

    return errors;
}

function parseMypyOutput(output: string): SyntaxError[] {
    const errors: SyntaxError[] = [];
    const pattern = /^(.+?):(\d+)(?::(\d+))?:\s*error:\s*(.+)$/gm;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(output)) !== null) {
        errors.push({
            filePath: capture(match, 1).trim(),
            line: captureInt(match, 2),
            column: match[3] ? captureInt(match, 3) : undefined,
            message: capture(match, 4).trim(),
        });

        if (errors.length >= MAX_PROJECT_ERRORS_SCANNED) break;
    }

    return errors;
}

/**
 * 解析 node --check 的 stderr 输出
 *
 * node --check 典型格式：
 *   /path/to/foo.js:10
 *   SyntaxError: Unexpected token '}'
 *       at ...
 */
function parseNodeCheckOutput(stderr: string): SyntaxError[] {
    const errors: SyntaxError[] = [];

    // 匹配 path:line 后跟换行+错误描述
    const pattern = /[^\n]+:(\d+)\n([^\n]+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(stderr)) !== null) {
        const possibleLine = captureInt(match, 1);
        const possibleMsg = capture(match, 2).trim();
        // 过滤 at ... 调用栈行
        if (!possibleMsg.startsWith('at ') && possibleLine > 0) {
            errors.push({
                line: possibleLine,
                message: possibleMsg,
            });
            // node 通常只报一处，取第一条即可
            break;
        }
    }

    return errors;
}

function parseEslintJsonOutput(stdout: string): SyntaxError[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed) as unknown;
    } catch {
        return [];
    }

    if (!Array.isArray(parsed)) return [];

    const errors: SyntaxError[] = [];
    for (const result of parsed) {
        if (!isRecord(result)) continue;
        const resultFilePath = getStringProp(result, 'filePath');
        const messages = getArrayProp(result, 'messages') ?? [];

        for (const message of messages) {
            if (!isRecord(message)) continue;
            const severity = getNumberProp(message, 'severity') ?? 0;
            if (severity !== 2) continue;

            const text = getStringProp(message, 'message') ?? 'ESLint error';
            const ruleId = getStringProp(message, 'ruleId');
            errors.push({
                filePath: resultFilePath,
                line: getNumberProp(message, 'line') ?? 0,
                column: getNumberProp(message, 'column'),
                message: ruleId ? `${ruleId}: ${text}` : text,
            });

            if (errors.length >= MAX_ERRORS_REPORTED) return errors;
        }
    }

    return errors;
}

/**
 * 解析 rustc 的 stderr 输出
 *
 * rustc 典型格式（两行配对）：
 *   error[E0308]: mismatched types
 *    --> src/main.rs:5:10
 *
 * 注意：rustc 将错误头行写到 stderr，行列号在 --> 行给出。
 * 本解析器提取 --> 行的行列号，并与上方最近一条 error/warning 消息配对。
 */
function parseRustcOutput(stderr: string): SyntaxError[] {
    const errors: SyntaxError[] = [];

    // 匹配 " --> path/to/file.rs:行:列" 格式（前面可以有空格）
    const locationPattern = /^\s*-->\s*(.+):(\d+):(\d+)/gm;
    // 匹配 "error[...]: 消息" 或 "error: 消息" 行（不含 warning）
    const errorMsgPattern = /^error(?:\[E\d+\])?:\s*(.+)$/gm;

    // 提取所有 error 消息及其在字符串中的位置，用于与 --> 行配对
    interface MsgEntry { index: number; message: string; }
    const msgEntries: MsgEntry[] = [];
    let msgMatch: RegExpExecArray | null;
    while ((msgMatch = errorMsgPattern.exec(stderr)) !== null) {
        msgEntries.push({ index: msgMatch.index, message: capture(msgMatch, 1).trim() });
    }

    // 遍历每个 --> 位置行，找紧邻它之前的 error 消息配对
    let locMatch: RegExpExecArray | null;
    while ((locMatch = locationPattern.exec(stderr)) !== null) {
        const locIndex = locMatch.index;
        const errorFilePath = capture(locMatch, 1).trim();
        const line = captureInt(locMatch, 2);
        const column = captureInt(locMatch, 3);

        // 找最近一个在 locIndex 之前的 error 消息
        let pairedMsg = 'compile error';
        for (let i = msgEntries.length - 1; i >= 0; i--) {
            const entry = msgEntries[i];
            if (entry && entry.index < locIndex) {
                pairedMsg = entry.message;
                break;
            }
        }

        errors.push({ filePath: errorFilePath, line, column, message: pairedMsg });
        if (errors.length >= MAX_ERRORS_REPORTED) break;
    }

    // 兜底：若没有 --> 行但确实有 error 行（如 "error: could not compile"），
    // 提取第一条消息并报行号 0
    if (errors.length === 0 && msgEntries.length > 0) {
        const firstEntry = msgEntries[0];
        if (firstEntry) errors.push({ line: 0, message: firstEntry.message });
    }

    return errors;
}

function parseCargoCheckJsonOutput(output: string): SyntaxError[] {
    const errors: SyntaxError[] = [];
    const lines = output.split(/\r?\n/);

    for (const lineText of lines) {
        const line = lineText.trim();
        if (!line) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(line) as unknown;
        } catch {
            continue;
        }

        if (!isRecord(parsed) || getStringProp(parsed, 'reason') !== 'compiler-message') {
            continue;
        }

        const messageRecord = getRecordProp(parsed, 'message');
        if (!messageRecord || getStringProp(messageRecord, 'level') !== 'error') {
            continue;
        }

        const message = getStringProp(messageRecord, 'message') ?? 'cargo check error';
        const spans = getArrayProp(messageRecord, 'spans') ?? [];
        const primarySpan = spans.find(span => isRecord(span) && span.is_primary === true);
        const spanRecord = isRecord(primarySpan)
            ? primarySpan
            : spans.find(isRecord);

        errors.push({
            filePath: spanRecord ? getStringProp(spanRecord, 'file_name') : undefined,
            line: spanRecord ? (getNumberProp(spanRecord, 'line_start') ?? 0) : 0,
            column: spanRecord ? getNumberProp(spanRecord, 'column_start') : undefined,
            message,
        });

        if (errors.length >= MAX_PROJECT_ERRORS_SCANNED) break;
    }

    return errors;
}

/**
 * 解析 gofmt -e 的 stdout 输出
 *
 * gofmt -e 在 stdout 末尾追加错误信息（格式与其他工具不同，写到 stdout 而非 stderr）：
 *   <标准格式> path/to/file.go:10:5: expected ';', found '}'
 *
 * 实验确认：gofmt -e 将语法错误注释附加在格式化后的文件内容之后，
 * 实际上错误行直接写到 stderr（取决于 Go 版本和文件是否可部分解析）。
 * 本解析器同时扫描 stdout 和 stderr 中的 "file:line:col: msg" 格式。
 */
function parseGofmtOutput(stdoutAndStderr: string): SyntaxError[] {
    const errors: SyntaxError[] = [];

    // 匹配 "任意路径:行:列: 消息" 格式（gofmt 标准错误格式）
    // 使用 \d+ 匹配行号，\d+ 匹配列号——区分 Windows 盘符（字母，不是数字）
    const pattern = /[^\n]+:(\d+):(\d+):\s+(.+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stdoutAndStderr)) !== null) {
        const line = captureInt(match, 1);
        const column = captureInt(match, 2);
        const message = capture(match, 3).trim();
        // 过滤掉纯数字消息（误匹配版本号等）
        if (message.length > 0 && line > 0) {
            errors.push({ line, column, message });
            if (errors.length >= MAX_ERRORS_REPORTED) break;
        }
    }

    return errors;
}

function parseGoTestOutput(stdoutAndStderr: string): SyntaxError[] {
    const errors: SyntaxError[] = [];
    const pattern = /^(.+?):(\d+)(?::(\d+))?:\s+(.+)$/gm;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(stdoutAndStderr)) !== null) {
        const message = capture(match, 4).trim();
        if (
            message.length === 0
            || message.startsWith('exit status ')
            || message.startsWith('FAIL')
        ) {
            continue;
        }

        errors.push({
            filePath: capture(match, 1).trim(),
            line: captureInt(match, 2),
            column: match[3] ? captureInt(match, 3) : undefined,
            message,
        });

        if (errors.length >= MAX_PROJECT_ERRORS_SCANNED) break;
    }

    return errors;
}

/**
 * 解析 python -m json.tool 的 stderr 输出
 *
 * json.tool 典型格式：
 *   Expecting ',' delimiter: line 5 column 3 (char 42)
 */
function parseJsonToolOutput(stderr: string): SyntaxError[] {
    const pattern = /(.+):\s*line\s+(\d+)\s+column\s+(\d+)/i;
    const match = stderr.match(pattern);
    if (!match) return [];

    return [
        {
            line: captureInt(match, 2),
            column: captureInt(match, 3),
            message: capture(match, 1).trim(),
        },
    ];
}

function parseTomlDecodeOutput(stderr: string): SyntaxError[] {
    const locationMatch = stderr.match(/at line\s+(\d+),\s+column\s+(\d+)/i);
    if (!locationMatch) return [];

    const messageMatch = stderr.match(/TOMLDecodeError:\s*(.+)$/m);
    const message = messageMatch
        ? capture(messageMatch, 1).trim()
        : 'TOML parse error';

    return [
        {
            line: captureInt(locationMatch, 1),
            column: captureInt(locationMatch, 2),
            message,
        },
    ];
}

// ══════════════════════════════════════════════════════════
// 括号配对降级检查（Layer 2）
// ══════════════════════════════════════════════════════════

/**
 * 括号配对降级检查
 *
 * 当语言工具链超时或不可用时，提供最基本的括号平衡检查。
 * 覆盖约 60% 的低级括号错误（未闭合的 { [ (）。
 * 注意：字符串/注释中的括号会影响准确性，属于已知限制。
 */
function checkBracketBalance(content: string): SyntaxError[] {
    interface Frame {
        char: string;
        line: number;
    }

    const OPEN = new Set(['{', '[', '(']);
    const CLOSE_TO_OPEN: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

    const stack: Frame[] = [];
    const errors: SyntaxError[] = [];
    let lineNo = 1;
    let inSingleString = false;
    let inDoubleString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let prev = '';

    for (const ch of content) {

        // 换行追踪
        if (ch === '\n') {
            lineNo++;
            inLineComment = false;
            prev = ch;
            continue;
        }

        // 行注释
        if (!inBlockComment && !inSingleString && !inDoubleString && ch === '/' && prev === '/') {
            inLineComment = true;
        }

        // 块注释开始
        if (!inLineComment && !inSingleString && !inDoubleString && ch === '*' && prev === '/') {
            inBlockComment = true;
        }

        // 块注释关闭
        if (inBlockComment && ch === '/' && prev === '*') {
            inBlockComment = false;
            prev = ch;
            continue;
        }

        if (inLineComment || inBlockComment) {
            prev = ch;
            continue;
        }

        // 字符串切换（简单处理，不考虑模板字面量嵌套）
        if (ch === "'" && !inDoubleString) inSingleString = !inSingleString;
        if (ch === '"' && !inSingleString) inDoubleString = !inDoubleString;

        if (inSingleString || inDoubleString) {
            prev = ch;
            continue;
        }

        // 括号配对
        if (OPEN.has(ch)) {
            stack.push({ char: ch, line: lineNo });
        } else if (ch in CLOSE_TO_OPEN) {
            const expected = CLOSE_TO_OPEN[ch];
            const previousFrame = stack[stack.length - 1];
            if (!expected || previousFrame?.char !== expected) {
                errors.push({ line: lineNo, message: `Unexpected closing symbol '${ch}'` });
                // 每次只报第一个，避免连锁错误
                break;
            } else {
                stack.pop();
            }
        }

        prev = ch;
    }

    // 未闭合的括号
    if (errors.length === 0 && stack.length > 0) {
        const unclosed = stack[stack.length - 1];
        if (unclosed) {
            errors.push({
                line: unclosed.line,
                message: `Opening symbol '${unclosed.char}' on line ${unclosed.line} is not closed`,
            });
        }
    }

    return errors;
}

// ══════════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════════

/**
 * 对指定文件执行语法检查
 *
 * @param filePath 已写入的文件路径（绝对路径）
 * @param context  工具执行上下文（提供 venvPythonPath / workdir）
 * @returns ValidationResult（检查结果，errors 为空表示通过）
 */
export async function validateSyntax(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    if (context.signal?.aborted) {
        return { checked: false, tool: 'none', errors: [] };
    }

    const ext = getFileExtension(filePath);
    logger.trace(`[PostWriteValidator] 开始检查: ${filePath} (ext=${ext})`);

    switch (ext) {
        case '.ts':
        case '.tsx':
            return runTscCheck(filePath, context);

        case '.py':
            return runPyCompileCheck(filePath, context);

        case '.js':
        case '.mjs':
        case '.cjs':
            return runJavaScriptCheck(filePath, context, true);

        case '.jsx':
            return runJavaScriptCheck(filePath, context, false);

        case '.json':
            return runJsonToolCheck(filePath, context);

        case '.yaml':
        case '.yml':
            return runYamlParseCheck(filePath);

        case '.toml':
            return runTomlParseCheck(filePath, context);

        case '.rs':
            return runRustCheck(filePath, context);

        case '.go':
            return runGoCheck(filePath, context);

        default:
            // 不在支持列表内的语言：直接返回 checked=false
            logger.trace(`[PostWriteValidator] 语言 ${ext} 暂不支持工具链检查`);
            return { checked: false, tool: 'none', errors: [] };
    }
}

// ══════════════════════════════════════════════════════════
// 各语言检查器实现
// ══════════════════════════════════════════════════════════

/**
 * TypeScript 检查（v3：本地二进制 + incremental 增量缓存）
 *
 * 策略一：项目模式（推荐）
 *   向上查找 tsconfig.json，优先用本地 node_modules/.bin/tsc 执行：
 *     `<localTsc|npx tsc> --noEmit --skipLibCheck --incremental`
 *   --incremental 在 tsconfig 旁写入 .tsbuildinfo；首次后每次只增量检查变更文件（< 3s）。
 *
 * 策略二：单文件模式（降级）
 *   tsconfig.json 找不到时，退回 `npx tsc --noEmit --skipLibCheck --allowJs --strict "<file>"`。
 *   无缓存，每次冷启动，但仅在找不到 tsconfig 时才触发。
 *
 * v3 vs v2：
 *   v2 npx 每次额外 1-3s 包解析 → 改用本地二进制消除
 *   v2 无增量缓存 → 添加 --incremental 后首次超时但此后极快
 */
async function runTscCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const timeout = TIMEOUTS.tsc ?? DEFAULT_TIMEOUT;

    // 策略一：向上查找 tsconfig.json，使用项目模式
    const tsconfigDir = await findTsconfigDir(filePath);

    if (tsconfigDir) {
        // 优先使用本地 node_modules/.bin/tsc，跳过 npx 包解析开销（1-3s）
        // 找不到时退回 npx tsc（仍可用，只是多几秒延迟）
        const localTsc = await findLocalTscBinary(tsconfigDir);
        const tscBin = localTsc ?? 'npx tsc';

        // --incremental：写入 .tsbuildinfo，后续增量检查只需 1-3s
        // 首次无缓存时仍可能超时，但写入缓存后所有后续调用均极快
        const command = `${tscBin} --noEmit --skipLibCheck --incremental --pretty false`;
        logger.trace(`[PostWriteValidator] tsc 项目模式（v3）: workdir=${tsconfigDir}, bin=${tscBin}`);

        try {
            const result = await runChecker(command, tsconfigDir, timeout, context.signal);
            // tsc 将错误写到 stdout
            const output = `${result.stdout}\n${result.stderr}`.trim();
            // 提取文件路径最后 2 段（父目录/文件名）作为过滤基准
            // 例如：C:\proj\src\audio\Track.ts → audio/Track.ts
            // 使用 2 段而非 1 段（文件名），避免同名不同目录的文件混淆
            const pathParts = normalizePath(filePath).split('/');
            const fileFilter = pathParts.slice(-2).join('/');
            const errors = parseTscOutput(output, fileFilter);
            const projectErrors = parseTscOutput(output, undefined, MAX_TSC_PROJECT_ERRORS_SCANNED);
            const relatedErrors = selectRelatedProjectErrors(projectErrors, errors, filePath);
            logger.trace(`[PostWriteValidator] tsc 项目模式完成: exitCode=${result.exitCode}, 当前文件错误=${errors.length}`);
            return {
                checked: true,
                tool: 'tsc',
                errors,
                relatedErrors,
                projectErrorCount: projectErrors.length,
                rawOutput: output,
            };
        } catch (err) {
            if (isValidationCancelled(err)) return cancelledValidationResult();
            logger.warn('[PostWriteValidator] tsc 项目模式失败，降级为括号配对兜底:', err);
            return runBracketFallback(filePath, 'tsc');
        }
    }

    // 策略二：无 tsconfig.json，退回单文件模式
    // 这种情况通常发生在临时目录或非标准 TS 项目
    const command = `npx tsc --noEmit --skipLibCheck --allowJs --strict --pretty false "${filePath}"`;
    logger.trace(`[PostWriteValidator] tsc 单文件模式（未找到 tsconfig.json）`);

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const errors = parseTscOutput(output);
        logger.trace(`[PostWriteValidator] tsc 单文件模式完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'tsc', errors, rawOutput: output };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] tsc 单文件模式也失败，降级为括号配对兜底:', err);
        return runBracketFallback(filePath, 'tsc');
    }
}

/**
 * Python 检查：python -m py_compile
 *
 * py_compile 是 Python 标准库内置模块，零额外依赖。
 * 优先使用 venv Python，确保 Python 版本与项目一致。
 */
async function runPyCompileCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const pythonExe = context.venvPythonPath
        ? `"${context.venvPythonPath}"`
        : 'python';
    const command = `${pythonExe} -m py_compile "${filePath}"`;
    const timeout = TIMEOUTS.py_compile ?? DEFAULT_TIMEOUT;

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const errors = parsePyCompileOutput(result.stderr);
        logger.trace(`[PostWriteValidator] py_compile 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        const pyCompileResult: ValidationResult = { checked: true, tool: 'py_compile', errors, rawOutput: result.stderr };
        if (errors.length > 0) return pyCompileResult;

        const projectResult = await runPythonProjectCheckIfAvailable(filePath, context, pythonExe);
        return projectResult ?? pyCompileResult;
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] py_compile 检查失败，降级为括号配对兜底:', err);
        return runBracketFallback(filePath, 'py_compile');
    }
}

async function runPythonProjectCheckIfAvailable(
    filePath: string,
    context: ValidatorContext,
    pythonExe: string
): Promise<ValidationResult | undefined> {
    const pyrightConfigDir = await findPyrightConfigDir(filePath);
    if (pyrightConfigDir) {
        const pyrightResult = await runPyrightCheckIfAvailable(filePath, context, pyrightConfigDir);
        if (pyrightResult) return pyrightResult;
    }

    const mypyConfigDir = await findMypyConfigDir(filePath);
    if (!mypyConfigDir) return undefined;
    return runMypyCheckIfAvailable(filePath, context, mypyConfigDir, pythonExe);
}

async function runPyrightCheckIfAvailable(
    filePath: string,
    context: ValidatorContext,
    configDir: string
): Promise<ValidationResult | undefined> {
    const pyrightBin = await findLocalNodeBinary(configDir, ['pyright.cmd', 'pyright'], 'pyright');
    if (!pyrightBin) return undefined;

    const command = `${pyrightBin} --outputjson`;
    const timeout = TIMEOUTS.pyright ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] Pyright 项目检查: workdir=${configDir}`);

    try {
        const result = await runChecker(command, configDir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const projectErrors = parsePyrightJsonOutput(result.stdout);
        if (result.exitCode !== 0 && projectErrors.length === 0) {
            return undefined;
        }
        logger.trace(`[PostWriteValidator] Pyright 完成: exitCode=${result.exitCode}, errors=${projectErrors.length}`);
        return buildProjectValidationResult('pyright', projectErrors, filePath, output);
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] Pyright 检查失败，回退到 Python 轻量检查结果:', err);
        return undefined;
    }
}

async function runMypyCheckIfAvailable(
    filePath: string,
    context: ValidatorContext,
    configDir: string,
    pythonExe: string
): Promise<ValidationResult | undefined> {
    const command = `${pythonExe} -m mypy --show-column-numbers --no-error-summary --no-pretty .`;
    const timeout = TIMEOUTS.mypy ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] Mypy 项目检查: workdir=${configDir}`);

    try {
        const result = await runChecker(command, configDir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const projectErrors = parseMypyOutput(output);
        if (result.exitCode !== 0 && projectErrors.length === 0) {
            return undefined;
        }
        logger.trace(`[PostWriteValidator] Mypy 完成: exitCode=${result.exitCode}, errors=${projectErrors.length}`);
        return buildProjectValidationResult('mypy', projectErrors, filePath, output);
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] Mypy 检查失败，回退到 Python 轻量检查结果:', err);
        return undefined;
    }
}

async function runJavaScriptCheck(
    filePath: string,
    context: ValidatorContext,
    allowNodeFallback: boolean
): Promise<ValidationResult> {
    const eslintResult = await runEslintCheckIfAvailable(filePath, context);
    if (eslintResult) return eslintResult;

    if (allowNodeFallback) {
        return runNodeCheck(filePath, context);
    }

    return runBracketFallback(filePath, 'eslint');
}

async function runEslintCheckIfAvailable(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult | undefined> {
    const eslintConfigDir = await findEslintConfigDir(filePath);
    if (!eslintConfigDir) return undefined;

    const eslintBin = await findLocalNodeBinary(eslintConfigDir, ['eslint.cmd', 'eslint'], 'eslint');
    if (!eslintBin) return undefined;

    const command = `${eslintBin} --quiet --format json "${filePath}"`;
    const timeout = TIMEOUTS.eslint ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] ESLint 检查: workdir=${eslintConfigDir}, file=${filePath}`);

    try {
        const result = await runChecker(command, eslintConfigDir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const errors = parseEslintJsonOutput(result.stdout);
        if (result.exitCode !== 0 && errors.length === 0) {
            throw new Error('eslint_no_parseable_errors');
        }
        logger.trace(`[PostWriteValidator] ESLint 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return {
            checked: true,
            tool: 'eslint',
            errors,
            projectErrorCount: errors.length,
            rawOutput: output,
        };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] ESLint 检查失败，降级为 JS/括号兜底:', err);
        return undefined;
    }
}

/**
 * JavaScript 检查：node --check
 *
 * node --check 是 Node.js 内置选项，仅做语法检查不执行代码，零额外依赖。
 */
async function runNodeCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const command = `node --check "${filePath}"`;
    const timeout = TIMEOUTS.node_check ?? DEFAULT_TIMEOUT;

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const errors = parseNodeCheckOutput(result.stderr);
        logger.trace(`[PostWriteValidator] node --check 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'node_check', errors, rawOutput: result.stderr };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] node --check 检查失败，降级为括号配对兜底:', err);
        return runBracketFallback(filePath, 'node_check');
    }
}

/**
 * JSON 检查：python -m json.tool
 *
 * json.tool 是 Python 标准库内置模块，能给出精确的行列号。
 *
 * 兼容性说明：
 * --no-ensure-ascii 参数在 Python 3.9+ 才支持；
 * 旧版本（3.8）会导致 json.tool 直接报错而不是 JSON 格式错误。
 * 因此不使用该参数，改用输出重定向到 NUL，只关心 stderr 中的错误信息。
 */
async function runJsonToolCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const pythonExe = context.venvPythonPath
        ? `"${context.venvPythonPath}"`
        : 'python';
    // 移除 --no-ensure-ascii，兼容 Python 3.8+（该参数在 3.9 才支持）
    // 不重定向 stdout：管道命令会导致 stderr 被吞，无法解析错误行列号
    const command = `${pythonExe} -m json.tool "${filePath}"`;
    const timeout = TIMEOUTS.json_tool ?? DEFAULT_TIMEOUT;

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const errors = parseJsonToolOutput(result.stderr);
        logger.trace(`[PostWriteValidator] json.tool 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'json_tool', errors, rawOutput: result.stderr };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] json.tool 检查失败，尝试 JSON.parse 兜底:', err);
        return runJsonParseFallback(filePath);
    }
}

/**
 * JSON 降级：JSON.parse（当 python 不可用时）
 *
 * 无法给出精确行列号，但至少能确认 JSON 是否合法。
 */
async function runJsonParseFallback(filePath: string): Promise<ValidationResult> {
    try {
        const content = await invoke<string>('file_read_content', { filePath });
        JSON.parse(content);
        return { checked: true, tool: 'json_tool', errors: [] };
    } catch (parseErr) {
        const message = parseErr instanceof SyntaxError
            ? parseErr.message
            : String(parseErr);
        return {
            checked: true,
            tool: 'json_tool',
            errors: [{ line: 0, message }],
        };
    }
}

async function runYamlParseCheck(filePath: string): Promise<ValidationResult> {
    let content: string;
    try {
        content = await invoke<string>('file_read_content', { filePath });
    } catch (readErr) {
        logger.warn('[PostWriteValidator] YAML 检查无法读取文件，静默跳过:', readErr);
        return { checked: false, tool: 'none', errors: [] };
    }

    try {
        yaml.loadAll(content);
        return { checked: true, tool: 'yaml_parse', errors: [] };
    } catch (err) {
        const record = isRecord(err) ? err : undefined;
        const mark = record ? getRecordProp(record, 'mark') : undefined;
        const reason = record ? getStringProp(record, 'reason') : undefined;
        const message = reason
            ?? (err instanceof Error ? err.message : String(err));

        if (!mark && !(err instanceof Error)) {
            return { checked: false, tool: 'none', errors: [] };
        }

        const rawLine = mark ? getNumberProp(mark, 'line') : undefined;
        const rawColumn = mark ? getNumberProp(mark, 'column') : undefined;
        return {
            checked: true,
            tool: 'yaml_parse',
            errors: [
                {
                    line: rawLine === undefined ? 0 : rawLine + 1,
                    column: rawColumn === undefined ? undefined : rawColumn + 1,
                    message,
                },
            ],
        };
    }
}

async function runTomlParseCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const pythonExe = context.venvPythonPath
        ? `"${context.venvPythonPath}"`
        : 'python';
    const script = [
        'import sys, pathlib, importlib',
        "mod = importlib.import_module('tomllib' if sys.version_info >= (3, 11) else 'tomli')",
        "mod.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    ].join('; ');
    const command = `${pythonExe} -c "${script}" "${filePath}"`;
    const timeout = TIMEOUTS.toml_parse ?? DEFAULT_TIMEOUT;

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const errors = parseTomlDecodeOutput(output);
        if (result.exitCode !== 0 && errors.length === 0) {
            logger.warn('[PostWriteValidator] TOML 检查不可用，未找到 tomllib/tomli 或输出不可解析');
            return { checked: false, tool: 'none', errors: [] };
        }

        logger.trace(`[PostWriteValidator] TOML 检查完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'toml_parse', errors, rawOutput: output };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] TOML 检查不可用，静默跳过:', err);
        return { checked: false, tool: 'none', errors: [] };
    }
}

async function runRustCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const cargoTomlDir = await findCargoTomlDir(filePath);
    if (!cargoTomlDir) {
        return runRustcCheck(filePath, context);
    }

    const command = 'cargo check --message-format=json';
    const timeout = TIMEOUTS.cargo_check ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] cargo check 项目模式: workdir=${cargoTomlDir}`);

    try {
        const result = await runChecker(command, cargoTomlDir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const projectErrors = parseCargoCheckJsonOutput(output);
        const errors = projectErrors
            .filter(error => pathsReferToSameFile(error.filePath, filePath))
            .slice(0, MAX_ERRORS_REPORTED);
        const relatedErrors = selectRelatedProjectErrors(projectErrors, errors, filePath);
        logger.trace(`[PostWriteValidator] cargo check 完成: exitCode=${result.exitCode}, 当前文件错误=${errors.length}, related=${relatedErrors.length}`);
        return {
            checked: true,
            tool: 'cargo_check',
            errors,
            relatedErrors,
            projectErrorCount: projectErrors.length,
            rawOutput: output,
        };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] cargo check 失败，降级为 rustc 单文件检查:', err);
        return runRustcCheck(filePath, context);
    }
}

/**
 * Rust 检查：rustc --edition 2021 --emit=metadata -o NUL
 *
 * --emit=metadata 跳过代码生成和链接阶段，仅做 AST 解析 + 类型检查，
 * 是 cargo check 不可用时的单文件兜底。
 */
async function runRustcCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    // -o NUL：Windows 空设备，跳过实际文件输出
    const command = `rustc --edition 2021 --emit=metadata -o NUL "${filePath}"`;
    const timeout = TIMEOUTS.rustc ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] rustc 检查: ${filePath}`);

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        const errors = parseRustcOutput(result.stderr);
        logger.trace(`[PostWriteValidator] rustc 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'rustc', errors, rawOutput: result.stderr };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] rustc 检查失败，降级为括号配对兜底:', err);
        return runBracketFallback(filePath, 'rustc');
    }
}

async function runGoCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const goModuleDir = await findGoModuleDir(filePath);
    if (!goModuleDir) {
        return runGofmtCheck(filePath, context);
    }

    const packagePattern = getGoPackagePattern(filePath, goModuleDir);
    const command = `go test -run=__agentvis_post_write_no_tests__ -vet=off "${packagePattern}"`;
    const timeout = TIMEOUTS.go_test ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] go test package 编译: workdir=${goModuleDir}, package=${packagePattern}`);

    try {
        const result = await runChecker(command, goModuleDir, timeout, context.signal);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const projectErrors = parseGoTestOutput(output);
        if (result.exitCode !== 0 && projectErrors.length === 0) {
            logger.warn('[PostWriteValidator] go test 未返回可解析诊断，降级为 gofmt');
            return await runGofmtCheck(filePath, context);
        }

        logger.trace(`[PostWriteValidator] go test 完成: exitCode=${result.exitCode}, errors=${projectErrors.length}`);
        return buildProjectValidationResult('go_test', projectErrors, filePath, output);
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] go test 检查失败，降级为 gofmt:', err);
        return await runGofmtCheck(filePath, context);
    }
}

/**
 * Go 检查：gofmt -e
 *
 * gofmt -e 是 Go 官方格式化工具的 "报告所有错误" 模式：
 * - 无需 go.mod，单文件即可运行
 * - parse-only 阶段，不解析 import 依赖，极快（< 1s）
 * - 语法错误输出到 stderr，格式为 "file:line:col: message"
 *
 * 已知限制：gofmt 仅检查 parse 层语法，语义错误（类型不匹配、未导入包等）
 * 无法检测，属于已知设计取舍，足以捕获 Agent 写入时的括号/关键字拼写错误。
 */
async function runGofmtCheck(
    filePath: string,
    context: ValidatorContext
): Promise<ValidationResult> {
    const command = `gofmt -e "${filePath}"`;
    const timeout = TIMEOUTS.gofmt ?? DEFAULT_TIMEOUT;
    logger.trace(`[PostWriteValidator] gofmt 检查: ${filePath}`);

    try {
        const result = await runChecker(command, context.workdir, timeout, context.signal);
        // gofmt 将语法错误写到 stderr；stdout 是格式化后的内容（有错时可能为空）
        // 同时扫描两者以兼容不同 Go 版本行为
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        const errors = parseGofmtOutput(combined);
        logger.trace(`[PostWriteValidator] gofmt 完成: exitCode=${result.exitCode}, errors=${errors.length}`);
        return { checked: true, tool: 'gofmt', errors, rawOutput: combined };
    } catch (err) {
        if (isValidationCancelled(err)) return cancelledValidationResult();
        logger.warn('[PostWriteValidator] gofmt 检查失败，降级为括号配对兜底:', err);
        return runBracketFallback(filePath, 'gofmt');
    }
}

/**
 * 通用括号配对降级（Layer 2）
 *
 * 当具体语言工具链超时或找不到时调用。
 * 读取已写入的文件内容，执行括号配对字符扫描。
 *
 * @param filePath   目标文件的绝对路径
 * @param failedTool 原本应使用的工具（用于日志追踪）
 */
async function runBracketFallback(
    filePath: string,
    failedTool: string
): Promise<ValidationResult> {
    logger.trace(`[PostWriteValidator] 括号配对降级（原工具: ${failedTool}）`);
    try {
        const content = await invoke<string>('file_read_content', { filePath });
        const errors = checkBracketBalance(content);
        return { checked: true, tool: 'bracket_fallback', errors };
    } catch (readErr) {
        // 连文件都读不到，静默放弃
        logger.warn('[PostWriteValidator] 括号配对降级也失败（无法读取文件）:', readErr);
        return { checked: false, tool: 'none', errors: [] };
    }
}
