/**
 * DependencyInstaller - 非 pip 依赖安装服务
 *
 * 职责：检测 → 安装 → 验证 npm 包、cargo 包、go 包和系统级 CLI 工具。
 * 与 RuntimeManager（管理 Python venv 生命周期）互补，
 * 独立处理不需要虚拟环境的依赖安装。
 *
 * 设计原则：
 * - 单一职责：只负责 npm/cargo/go/系统工具的安装和验证
 * - 依赖注入：ShellExecuteFn 通过参数传入，便于测试
 * - 幂等安装：已安装的包不会重复安装
 * - 网络容错：检测网络错误并提供可读的重试提示
 */

import type { SystemToolInfo } from './DependencyAnalyzer';
import { getLogger } from '@services/logger';

const logger = getLogger('DependencyInstaller');

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** Shell 命令执行函数签名（与 ExternalExecutor 保持一致） */
export type ShellExecutor = (params: {
    command: string;
    workdir: string;
    timeout: number;
    background: boolean;
    env?: Record<string, string>;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** 单个依赖的安装状态 */
export type DepInstallStatus = 'idle' | 'checking' | 'installing' | 'installed' | 'error';

/** 安装结果 */
export interface InstallResult {
    /** 是否安装成功 */
    success: boolean;
    /** 结果消息（成功描述或错误信息） */
    message: string;
    /** 是否为网络相关错误（可重试） */
    isNetworkError: boolean;
}

/** 包管理器检测结果 */
interface PackageManagerInfo {
    /** 可用的包管理器名称 */
    name: string;
    /** 包管理器的安装命令前缀 */
    installPrefix: string;
}

// ═══════════════════════════════════════════════════════════════
// 网络错误检测
// ═══════════════════════════════════════════════════════════════

/**
 * 已知的网络/连接错误关键词
 *
 * 用于检测安装失败是否由网络问题导致，
 * 帮助用户区分「需要检查网络」和「命令/权限错误」。
 */
const NETWORK_ERROR_PATTERNS: readonly string[] = [
    // 通用
    'network',
    'timeout',
    'timed out',
    'connection refused',
    'connection reset',
    'connection timed out',
    'failed to fetch',
    'error sending request',
    'could not connect',
    'dns lookup',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    // npm 特有
    'npm ERR! network',
    'npm ERR! code ENOTFOUND',
    'npm ERR! fetch failed',
    'npm ERR! request to',
    // scoop 特有
    'Could not resolve host',
    'SSL connection',
    // 代理相关
    'proxy',
    'certificate',
    'CERT_',
    'SSL',
];

/**
 * 包管理器输出中表示「包已安装」的关键词
 *
 * winget/scoop/choco/brew 在目标已安装时会输出这些文本
 * 并返回非零 exit code，需要特殊处理为安装成功。
 */
const ALREADY_INSTALLED_PATTERNS: readonly string[] = [
    // winget
    'already installed',
    'no available upgrade',
    'no newer package versions',
    'installed already',
    'already exists',
    'no update available',
    'latest version is already installed',
    'nothing to upgrade',
    // scoop
    'is already installed',
    // choco
    'already installed',
    // brew
    'already installed',
    // 中文系统 winget 可能输出中文
    '\u5df2\u5b89\u88c5',
];

/**
 * 检测错误输出是否包含网络相关关键词
 *
 * @param output 命令的 stdout + stderr 文本
 * @returns 是否为网络错误（可通过重试或检查网络解决）
 */
export function isNetworkRelatedError(output: string): boolean {
    const lowerOutput = output.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some(
        pattern => lowerOutput.includes(pattern.toLowerCase())
    );
}

/**
 * 检测 agent-browser 首次初始化时 Chrome for Testing 下载失败。
 *
 * `agent-browser install` 会访问 googlechromelabs / storage.googleapis.com 获取
 * Chrome for Testing 元数据和压缩包。国内新机器未配置 VPN/代理时，此类失败
 * 需要给用户更具体的恢复路径，而不是只显示泛化的网络错误。
 */
export function isChromeForTestingInstallFailure(command: string, output: string): boolean {
    const normalizedCommand = command.trim().toLowerCase();
    const isAgentBrowserInstall = /^(?:npx\s+)?agent-browser(?:\.cmd|\.exe)?\s+install\b/.test(
        normalizedCommand
    );
    if (!isAgentBrowserInstall) return false;

    const lowerOutput = output.toLowerCase();
    const hasChromeForTestingSignal = [
        'chrome for testing',
        'chrome-for-testing',
        'googlechromelabs.github.io/chrome-for-testing',
        'last-known-good-versions-with-downloads',
        'storage.googleapis.com/chrome-for-testing-public',
        'failed to fetch version info',
    ].some(pattern => lowerOutput.includes(pattern));

    return hasChromeForTestingSignal || isNetworkRelatedError(output);
}

/**
 * 检测安装输出是否表示包已安装
 *
 * 某些包管理器（如 winget）对已安装的包返回非零 exit code，
 * 但实际上意味着安装是成功的（目标已存在）。
 *
 * @param output 命令的 stdout + stderr 合并文本
 * @returns 是否为「已安装」场景
 */
function isAlreadyInstalledOutput(output: string): boolean {
    const lowerOutput = output.toLowerCase();
    return ALREADY_INSTALLED_PATTERNS.some(
        pattern => lowerOutput.includes(pattern.toLowerCase())
    );
}

// ═══════════════════════════════════════════════════════════════
// 包管理器检测
// ═══════════════════════════════════════════════════════════════

/**
 * 检测 Windows 上可用的系统包管理器
 *
 * 优先级：scoop > winget > choco
 * 理由：scoop 无需管理员权限，安装路径可控
 *
 * @param shellExec Shell 执行函数
 * @returns 检测到的包管理器信息，无可用时返回 null
 */
export async function detectWindowsPackageManager(
    shellExec: ShellExecutor
): Promise<PackageManagerInfo | null> {
    // 按优先级依次检测
    const candidates: Array<{ name: string; testCmd: string; installPrefix: string }> = [
        { name: 'scoop', testCmd: 'scoop --version', installPrefix: 'scoop install' },
        { name: 'winget', testCmd: 'winget --version', installPrefix: 'winget install --accept-package-agreements --accept-source-agreements' },
        { name: 'choco', testCmd: 'choco --version', installPrefix: 'choco install -y' },
    ];

    for (const candidate of candidates) {
        try {
            const result = await shellExec({
                command: candidate.testCmd,
                workdir: '.',
                timeout: 10,
                background: false,
            });
            if (result.exitCode === 0) {
                logger.debug(
                    `[DependencyInstaller] 检测到包管理器: ${candidate.name} (${result.stdout.trim()})`
                );
                return { name: candidate.name, installPrefix: candidate.installPrefix };
            }
        } catch {
            // 命令不存在 → 跳过
        }
    }

    return null;
}

/**
 * 检测当前环境是否为 Windows
 *
 * 优先使用 navigator.userAgent（浏览器/Tauri 环境），
 * 回退到 process.platform（Node.js 测试环境）。
 */
function isWindowsPlatform(): boolean {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent.toLowerCase().includes('win');
    }
    // Node.js 测试环境回退
    const nodeProcess = (globalThis as { process?: { platform?: string } }).process;
    if (nodeProcess?.platform) {
        return nodeProcess.platform === 'win32';
    }
    return true; // 安全默认值：假定 Windows
}

/**
 * 检测命令是否已安装（通过 where/which）
 *
 * @param command 要检测的命令名
 * @param shellExec Shell 执行函数
 * @returns 是否已安装
 */
export async function isCommandAvailable(
    command: string,
    shellExec: ShellExecutor
): Promise<boolean> {
    try {
        const checkCmd = isWindowsPlatform()
            ? `where ${command}`
            : `which ${command}`;

        const result = await shellExec({
            command: checkCmd,
            workdir: '.',
            timeout: 10,
            background: false,
        });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

/**
 * 使用刷新后的 PATH 检测命令是否可用
 *
 * Windows 上的检测策略（按优先级）：
 * 1. 从注册表重新读取 PATH，用 where.exe 检测
 * 2. 在 Program Files 等常见安装目录中搜索可执行文件
 *
 * 第 2 步是必要的，因为 winget 安装的很多程序（如 LibreOffice、QPDF）
 * 不会自动将自身目录加入系统 PATH。
 *
 * @param command 要检测的命令名
 * @param shellExec Shell 执行函数
 * @returns 是否已安装
 */
export async function isCommandAvailableWithFreshPath(
    command: string,
    shellExec: ShellExecutor,
    windowsExePaths?: string[]
): Promise<boolean> {
    try {
        if (isWindowsPlatform()) {
            // 策略 1：从注册表获取最新 PATH + where.exe
            const whereResult = await findCommandViaFreshPath(command, shellExec);
            if (whereResult) return true;

            // 策略 2：检查已知安装路径（仅当提供了 windowsExePaths 时）
            if (windowsExePaths && windowsExePaths.length > 0) {
                return await checkWindowsKnownPaths(windowsExePaths, shellExec);
            }

            return false;
        }

        // 非 Windows: 标准 which
        return await isCommandAvailable(command, shellExec);
    } catch {
        return false;
    }
}

/**
 * 检测 npm 全局包是否已安装
 *
 * 使用 `npm list -g <pkg> --depth=0` 检测，
 * 而非 `where <pkg>`（库包不是可执行命令，where 永远找不到）。
 *
 * @param packageName npm 包名
 * @param shellExec Shell 执行函数
 * @returns 是否已安装
 */
export async function isNpmPackageInstalled(
    packageName: string,
    shellExec: ShellExecutor
): Promise<boolean> {
    try {
        // 先确认 npm 可用
        const npmAvailable = await isCommandAvailable('npm', shellExec);
        if (!npmAvailable) return false;

        const result = await shellExec({
            command: `npm list -g ${packageName} --depth=0`,
            workdir: '.',
            timeout: 15,
            background: false,
        });
        return result.exitCode === 0 && result.stdout.includes(packageName);
    } catch {
        return false;
    }
}

/**
 * 通过刷新 PATH + where.exe 检测命令
 *
 * 不能依赖 exitCode：cmd.exe /c 嵌套 powershell 时 exit code 可能始终为 0。
 * 改为检查 stdout 内容——where.exe 成功时输出完整路径。
 */
async function findCommandViaFreshPath(
    command: string,
    shellExec: ShellExecutor
): Promise<boolean> {
    try {
        const psScript = [
            `$m = [Environment]::GetEnvironmentVariable('Path','Machine')`,
            `$u = [Environment]::GetEnvironmentVariable('Path','User')`,
            `$env:Path = $m + ';' + $u`,
            `where.exe ${command}`,
        ].join('; ');

        const result = await shellExec({
            command: `powershell -NoProfile -Command "& {${psScript}}"`,
            workdir: '.',
            timeout: 15,
            background: false,
        });
        const output = result.stdout.trim();
        return output.length > 0 && (output.includes('\\') || output.includes('.exe'));
    } catch {
        return false;
    }
}

/**
 * 检查已知 Windows 安装路径中是否存在可执行文件
 *
 * 使用 PowerShell Test-Path 检查精确路径，毫秒级完成。
 * 路径中可包含通配符（如 `C:\Program Files\qpdf*\bin\qpdf.exe`），
 * 此时使用 Resolve-Path 尝试解析。
 *
 * 不使用 cmd.exe if exist：Tauri 的 shell 层会吃掉嵌套引号导致 stdout 为空。
 */
async function checkWindowsKnownPaths(
    exePaths: string[],
    shellExec: ShellExecutor
): Promise<boolean> {
    for (const exePath of exePaths) {
        try {
            // PowerShell Test-Path 原生支持通配符和含空格路径
            // 单引号包裹避免变量展开和特殊字符问题
            const result = await shellExec({
                command: `powershell -NoProfile -Command "Test-Path '${exePath}'"`,
                workdir: '.',
                timeout: 5,
                background: false,
            });
            const output = result.stdout.trim().toLowerCase();
            if (output === 'true') {
                return true;
            }
        } catch {
            // 单条路径检测失败不影响后续
            continue;
        }
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════
// 核心安装逻辑
// ═══════════════════════════════════════════════════════════════

/**
 * 安装 npm 全局包
 *
 * 执行 `npm install -g <packageName>` 并验证安装结果。
 * 先检测 npm 是否可用，再执行安装。
 *
 * @param packageName npm 包名
 * @param shellExec Shell 执行函数
 * @returns 安装结果
 */
export async function installNpmPackage(
    packageName: string,
    shellExec: ShellExecutor
): Promise<InstallResult> {
    // 1. 检测 npm 是否可用
    const npmAvailable = await isCommandAvailable('npm', shellExec);
    if (!npmAvailable) {
        return {
            success: false,
            message: 'npm was not detected. Install Node.js first (https://nodejs.org/).',
            isNetworkError: false,
        };
    }

    // 2. 检测是否已安装
    try {
        const listResult = await shellExec({
            command: `npm list -g ${packageName} --depth=0`,
            workdir: '.',
            timeout: 15,
            background: false,
        });
        if (listResult.exitCode === 0 && listResult.stdout.includes(packageName)) {
            return {
                success: true,
                message: `${packageName} is already installed`,
                isNetworkError: false,
            };
        }
    } catch {
        // 未安装，继续安装流程
    }

    // 3. 执行安装
    try {
        const result = await shellExec({
            command: `npm install -g ${packageName}`,
            workdir: '.',
            timeout: 120,
            background: false,
        });

        if (result.exitCode === 0) {
            return {
                success: true,
                message: `${packageName} installed successfully`,
                isNetworkError: false,
            };
        }

        // 安装失败 → 分析错误类型
        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        const networkError = isNetworkRelatedError(combinedOutput);

        return {
            success: false,
            message: networkError
                ? `${packageName} installation failed due to a network error. Check the connection and try again.`
                : `${packageName} installation failed: ${result.stderr.slice(0, 200)}`,
            isNetworkError: networkError,
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `${packageName} installation error: ${errorMsg}`,
            isNetworkError: isNetworkRelatedError(errorMsg),
        };
    }
}

/**
 * 安装系统工具
 *
 * 根据当前平台选择对应的安装命令执行。
 * Windows 上自动检测可用的包管理器。
 *
 * @param toolInfo 系统工具信息（含跨平台安装指令）
 * @param platform 当前平台
 * @param shellExec Shell 执行函数
 * @returns 安装结果
 */
export async function installSystemTool(
    toolInfo: SystemToolInfo,
    platform: 'windows' | 'mac' | 'linux',
    shellExec: ShellExecutor
): Promise<InstallResult> {
    // 使用 detectCommand（如果存在）替代 command 进行检测
    // 解决如 convert（Windows 内置磁盘工具）与 ImageMagick 的命名冲突
    const checkCommand = toolInfo.detectCommand ?? toolInfo.command;

    // 1. 检测工具是否已安装
    const alreadyInstalled = await isCommandAvailable(checkCommand, shellExec);
    if (alreadyInstalled) {
        return {
            success: true,
            message: `${toolInfo.packageName} is already installed`,
            isNetworkError: false,
        };
    }

    // 2. 确定安装命令
    let installCmd: string;

    if (platform === 'windows') {
        // Windows: 自动检测可用的包管理器
        const pkgMgr = await detectWindowsPackageManager(shellExec);
        if (!pkgMgr) {
            return {
                success: false,
                message: `No package manager detected (scoop/winget/choco). Install scoop first: https://scoop.sh/`,
                isNetworkError: false,
            };
        }

        // 从预设命令中提取包名，用检测到的包管理器替换
        installCmd = await buildWindowsInstallCommand(toolInfo, pkgMgr, shellExec);
    } else if (platform === 'mac') {
        // macOS: 使用 brew
        const brewAvailable = await isCommandAvailable('brew', shellExec);
        if (!brewAvailable) {
            return {
                success: false,
                message: 'Homebrew was not detected. Install it first: https://brew.sh/',
                isNetworkError: false,
            };
        }
        installCmd = toolInfo.macInstall;
    } else {
        // Linux: 使用 apt（需要 sudo）
        installCmd = toolInfo.linuxInstall;
    }

    // 3. 执行安装
    try {
        logger.debug(
            `[DependencyInstaller] 安装 ${toolInfo.packageName}: ${installCmd}`
        );

        const result = await shellExec({
            command: installCmd,
            workdir: '.',
            timeout: 300, // 系统工具安装可能较慢
            background: false,
        });

        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        if (result.exitCode === 0) {
            // 安装命令执行成功 →
            // 尝试用刷新 PATH 的方式验证命令是否可用
            const verified = await isCommandAvailableWithFreshPath(
                checkCommand, shellExec, toolInfo.windowsExePaths
            );
            return {
                // 安装命令成功即视为成功（PATH 刷新后可能需要重启应用才生效）
                success: true,
                message: verified
                    ? `${toolInfo.packageName} installed successfully`
                    : `${toolInfo.packageName} installed successfully; restart the app for it to take effect`,
                isNetworkError: false,
            };
        }

        // exit code 非零 → 检测是否为「已安装」场景
        if (isAlreadyInstalledOutput(combinedOutput)) {
            return {
                success: true,
                message: `${toolInfo.packageName} is already installed`,
                isNetworkError: false,
            };
        }

        // 真正的安装失败 → 分析错误类型
        const networkError = isNetworkRelatedError(combinedOutput);

        // 优先取 stderr，为空时取 stdout 的头 200 字符作为错误描述
        const errorDetail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200);

        // 非网络错误 + 有 fallbackUrl → 附带手动下载链接引导用户
        const fallbackHint = !networkError && toolInfo.fallbackUrl
            ? `\nDownload and install it manually from the official website: ${toolInfo.fallbackUrl}`
            : '';

        return {
            success: false,
            message: networkError
                ? `${toolInfo.packageName} installation failed due to a network error. Check the connection and try again.`
                : `${toolInfo.packageName} installation failed: ${errorDetail || 'Unknown error'}${fallbackHint}`,
            isNetworkError: networkError,
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `${toolInfo.packageName} installation error: ${errorMsg}`,
            isNetworkError: isNetworkRelatedError(errorMsg),
        };
    }
}

// ═══════════════════════════════════════════════════════════════
// Cargo 包安装（Rust 生态）
// ═══════════════════════════════════════════════════════════════

/**
 * 检测 cargo 包是否已安装
 *
 * 使用 `cargo install --list` 检测已安装的包。
 *
 * @param packageName cargo 包名（如 bat、ripgrep）
 * @param shellExec Shell 执行函数
 * @returns 是否已安装
 */
export async function isCargoPackageInstalled(
    packageName: string,
    shellExec: ShellExecutor
): Promise<boolean> {
    try {
        const cargoAvailable = await isCommandAvailable('cargo', shellExec);
        if (!cargoAvailable) return false;

        const result = await shellExec({
            command: 'cargo install --list',
            workdir: '.',
            timeout: 15,
            background: false,
        });
        // cargo install --list 输出格式：包名在行首，后续子条目缩进
        // 如 "bat v0.24.0:\n    bat" → 检查行首是否以包名开头
        return result.exitCode === 0 &&
            result.stdout.split('\n').some(line => line.startsWith(`${packageName} `));
    } catch {
        return false;
    }
}

/**
 * 安装 cargo 包
 *
 * 执行 `cargo install <packageName>` 并验证安装结果。
 * 先检测 cargo 是否可用，再执行安装。
 *
 * @param packageName cargo 包名
 * @param shellExec Shell 执行函数
 * @returns 安装结果
 */
export async function installCargoPackage(
    packageName: string,
    shellExec: ShellExecutor
): Promise<InstallResult> {
    // 1. 检测 cargo 是否可用
    const cargoAvailable = await isCommandAvailable('cargo', shellExec);
    if (!cargoAvailable) {
        return {
            success: false,
            message: 'Cargo was not detected. Install the Rust toolchain first (https://rustup.rs/).',
            isNetworkError: false,
        };
    }

    // 2. 检测是否已安装
    const alreadyInstalled = await isCargoPackageInstalled(packageName, shellExec);
    if (alreadyInstalled) {
        return {
            success: true,
            message: `${packageName} is already installed`,
            isNetworkError: false,
        };
    }

    // 3. 执行安装（cargo install 从源码编译，超时设大一些）
    try {
        const result = await shellExec({
            command: `cargo install ${packageName}`,
            workdir: '.',
            timeout: 600, // cargo 编译可能较慢
            background: false,
        });

        if (result.exitCode === 0) {
            return {
                success: true,
                message: `${packageName} installed successfully`,
                isNetworkError: false,
            };
        }

        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        const networkError = isNetworkRelatedError(combinedOutput);

        return {
            success: false,
            message: networkError
                ? `${packageName} installation failed due to a network error. Check the connection and try again.`
                : `${packageName} installation failed: ${result.stderr.slice(0, 200)}`,
            isNetworkError: networkError,
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `${packageName} installation error: ${errorMsg}`,
            isNetworkError: isNetworkRelatedError(errorMsg),
        };
    }
}

// ═══════════════════════════════════════════════════════════════
// Go 包安装（Go 生态）
// ═══════════════════════════════════════════════════════════════

/**
 * 检测 go 包是否已安装
 *
 * Go 包安装后会将二进制放到 GOBIN 或 GOPATH/bin，
 * 检测路径末尾的二进制名是否可用。
 *
 * @param modulePath Go 模块路径（如 golang.org/x/tools/gopls）
 * @param shellExec Shell 执行函数
 * @returns 是否已安装
 */
export async function isGoPackageInstalled(
    modulePath: string,
    shellExec: ShellExecutor
): Promise<boolean> {
    try {
        const goAvailable = await isCommandAvailable('go', shellExec);
        if (!goAvailable) return false;

        // 从模块路径提取二进制名（路径最后一段）
        // 如 github.com/golangci/golangci-lint/cmd/golangci-lint → golangci-lint
        const binaryName = modulePath.split('/').pop() ?? modulePath;
        return await isCommandAvailable(binaryName, shellExec);
    } catch {
        return false;
    }
}

/**
 * 安装 go 包
 *
 * 执行 `go install <modulePath>@latest` 并验证安装结果。
 * 先检测 go 是否可用，再执行安装。
 *
 * @param modulePath Go 模块路径
 * @param shellExec Shell 执行函数
 * @returns 安装结果
 */
export async function installGoPackage(
    modulePath: string,
    shellExec: ShellExecutor
): Promise<InstallResult> {
    // 1. 检测 go 是否可用
    const goAvailable = await isCommandAvailable('go', shellExec);
    if (!goAvailable) {
        return {
            success: false,
            message: 'Go was not detected. Install the Go SDK first (https://go.dev/dl/).',
            isNetworkError: false,
        };
    }

    // 2. 检测是否已安装
    const alreadyInstalled = await isGoPackageInstalled(modulePath, shellExec);
    if (alreadyInstalled) {
        return {
            success: true,
            message: `${modulePath} is already installed`,
            isNetworkError: false,
        };
    }

    // 3. 执行安装（默认使用 @latest 版本）
    try {
        const result = await shellExec({
            command: `go install ${modulePath}@latest`,
            workdir: '.',
            timeout: 300,
            background: false,
        });

        if (result.exitCode === 0) {
            return {
                success: true,
                message: `${modulePath} installed successfully`,
                isNetworkError: false,
            };
        }

        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        const networkError = isNetworkRelatedError(combinedOutput);

        return {
            success: false,
            message: networkError
                ? `${modulePath} installation failed due to a network error. Check the connection and try again.`
                : `${modulePath} installation failed: ${result.stderr.slice(0, 200)}`,
            isNetworkError: networkError,
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `${modulePath} installation error: ${errorMsg}`,
            isNetworkError: isNetworkRelatedError(errorMsg),
        };
    }
}

// ═══════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════

/**
 * 构建 Windows 安装命令
 *
 * 从系统工具的预设命令中提取包名，
 * 用实际检测到的包管理器构建安装命令。
 *
 * 例如：预设 `scoop install poppler`，但用户只有 winget → `winget install ... poppler`
 *
 * @param toolInfo 工具信息
 * @param pkgMgr 检测到的包管理器
 * @returns 安装命令字符串
 */
/**
 * 构建 Windows 安装命令
 *
 * 策略：优先使用预设命令中指定的包管理器。
 * 不同包管理器的包名/包 ID 不同（如 choco 的 `pdftk` 在 winget 上不存在），
 * 因此不能简单地替换包管理器前缀。
 *
 * 仅在预设包管理器不可用时才回退到检测到的备选包管理器。
 */
async function buildWindowsInstallCommand(
    toolInfo: SystemToolInfo,
    detectedPkgMgr: PackageManagerInfo,
    shellExec: ShellExecutor
): Promise<string> {
    const presetCmd = toolInfo.windowsInstall;

    // 提取预设命令使用的包管理器名称
    const presetMatch = presetCmd.match(/^(scoop|choco|winget)\s+install/i);
    if (!presetMatch) {
        // 无法解析格式，直接使用预设命令
        return presetCmd;
    }

    const presetMgr = (presetMatch[1] ?? '').toLowerCase();

    // 如果预设包管理器与检测到的一致 → 使用预设命令
    if (presetMgr === detectedPkgMgr.name) {
        // winget 需追加 --accept 参数
        if (presetMgr === 'winget' && !presetCmd.includes('--accept')) {
            return presetCmd.replace(
                'winget install',
                'winget install --accept-package-agreements --accept-source-agreements'
            );
        }
        return presetCmd;
    }

    // 预设包管理器与检测到的不同 → 检查预设包管理器是否可用
    const presetAvailable = await isCommandAvailable(presetMgr, shellExec);
    if (presetAvailable) {
        // 预设包管理器可用 → 使用预设命令（包名匹配更准确）
        return presetCmd;
    }

    // 预设包管理器不可用 → 回退到检测到的包管理器
    // 此时只能做最佳努力替换包名（可能不兼容）
    const packageNameMatch = presetCmd.match(
        /(?:scoop|choco|winget)\s+install\s+(?:-\S+\s+)*(.+)/i
    );
    if (packageNameMatch?.[1]) {
        const pkgName = packageNameMatch[1].trim();
        logger.warn(
            `[DependencyInstaller] 预设包管理器 ${presetMgr} 不可用，` +
            `回退到 ${detectedPkgMgr.name}（包名 ${pkgName} 可能不兼容）`
        );
        return `${detectedPkgMgr.installPrefix} ${pkgName}`;
    }

    return presetCmd;
}
