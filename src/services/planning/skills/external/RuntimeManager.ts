/**
 * RuntimeManager - Python Runtime v1 环境管理
 *
 * 管理所有 External Skill 共享的 Python runtime。
 * 正式安装包使用预置 Python 环境和基础依赖；运行时只验收基础包并增量安装 Skill 额外依赖。
 *
 * 设计理念：
 * - 只在冷启动时执行环境检查/预置 runtime 解压
 * - 所有 Skill 共享一个 venv（减少磁盘占用）
 * - 基础包清单 runtime-requirements-v1.txt 覆盖常用依赖，打包期预安装
 * - Script 模式 Skill 的额外依赖增量安装
 *
 * 依赖注入：
 * - shellExecute 函数可注入，便于测试时 mock
 * - pythonBinaryPath 可注入，保留开发/测试兜底创建 venv 能力
 *
 * 增强功能（v2）：
 * - 回滚机制：开发/测试兜底创建 venv 失败时自动清理残留目录
 * - 进度回调：各阶段进度实时通知 UI
 * - 预置 runtime 验收：检查 SSL、pip、基础包 import 可用性
 * - 中间状态标记：base_incomplete / extra_partial
 */

import type { ShellExecuteFn } from './ExternalExecutor';
import type { SkillDependencies } from './types';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('RuntimeManager');

// ==================== 常量 ====================

/**
 * 基础包清单文件名
 *
 * 文件位于项目根目录，覆盖 Anthropic 官方 pdf/docx/xlsx/pptx 技能所需依赖。
 * 调用方需拼接完整路径后传给 ensureReady()。
 */
export const BASE_REQUIREMENTS_FILENAME = 'runtime-requirements-v1.txt';

/**
 * 单个 pip install 命令的超时时间（秒）
 *
 * 部分包（如 markitdown[pptx]）有大量子依赖（magika、markdownify 等），
 * 在网络条件不佳（如 SSL 重试）时 120s 不够用，增加到 300s。
 */
const PIP_INSTALL_TIMEOUT_SECS = 300;
const PACKAGED_PYTHON_VERSION = '3.13.14';
const EXTRA_REQUIREMENTS_PROBE_ENV = 'AGENTVIS_EXTRA_REQUIREMENTS_JSON';

/**
 * Windows 环境下 Python 可执行文件的候选路径
 *
 * 按优先级排序：
 * 1. PATH 中的 python / python3（最常见）
 * 2. Python Launcher (py -3)
 * 3. 常见安装路径（Microsoft Store / python.org installer）
 */
const WINDOWS_PYTHON_CANDIDATES = [
    'python',
    'python3',
    'py -3',
] as const;

/**
 * Windows 环境下 Python 常见安装目录模式
 *
 * 使用 LOCALAPPDATA 环境变量动态构造，覆盖 3.11-3.13 版本
 */
const WINDOWS_PYTHON_DIR_PATTERNS = [
    'Programs\\Python\\Python313\\python.exe',
    'Programs\\Python\\Python312\\python.exe',
    'Programs\\Python\\Python311\\python.exe',
] as const;

const ANSI_ESCAPE_SEQUENCE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

interface PackageInstallFailure {
    packageSpec: string;
    exitCode: number;
    output: string;
}

interface ExtraPackageSatisfactionProbe {
    satisfied: string[];
    unsatisfied: string[];
    skipped: string[];
}

type RuntimeShellExecuteParams = Parameters<ShellExecuteFn>[0];

const BASE_PACKAGE_IMPORT_NAME_OVERRIDES = new Map<string, string>([
    ['beautifulsoup4', 'bs4'],
    ['python-docx', 'docx'],
    ['python-pptx', 'pptx'],
    ['pyyaml', 'yaml'],
    ['python-dateutil', 'dateutil'],
    ['python-dotenv', 'dotenv'],
    ['pillow', 'PIL'],
    ['pip-system-certs', 'pip_system_certs'],
]);

// ==================== Runtime 状态 ====================

/**
 * Runtime 环境状态
 *
 * 新增中间状态 base_incomplete 和 extra_partial，
 * 用于标识安装过程中断的精确恢复点
 */
export type RuntimeStatus =
    | 'not_created'        // venv 不存在
    | 'creating'           // 正在创建
    | 'installing_base'    // 正在安装基础包
    | 'base_incomplete'    // 基础包安装失败，venv 保留
    | 'installing_extra'   // 正在安装额外依赖
    | 'extra_partial'      // 部分额外依赖安装失败
    | 'ready'              // 就绪
    | 'error';             // 严重错误

/**
 * Runtime 环境检查结果
 */
export interface RuntimeCheckResult {
    status: RuntimeStatus;
    venvPath: string;
    pythonVersion?: string;
    error?: string;
    failedPackages?: string[];
}

/**
 * 进度回调参数
 */
export interface RuntimeProgress {
    /** 当前阶段 */
    phase: string;
    /** 进度百分比 (0-100) */
    percent: number;
}

/** 进度回调函数类型 */
export type ProgressCallback = (progress: RuntimeProgress) => void;

// ==================== RuntimeManager 实现 ====================

export class RuntimeManager {
    private readonly runtimeDir: string;
    private readonly shellExecute: ShellExecuteFn;
    private readonly pythonBinaryPath: string | null;
    private status: RuntimeStatus = 'not_created';

    /** 内嵌 Python 可执行文件路径（优先用于创建沙箱兼容 venv） */
    private embeddedPythonExe: string | null = null;
    /** get-pip.py 路径（用于内嵌 Python 引导 pip） */
    private embeddedGetPipPath: string | null = null;

    /**
     * @param runtimeDir Runtime 根目录，如 {AppDataDir}/runtime/python-v1
     * @param shellExecute Shell 执行函数（依赖注入）
     * @param pythonBinaryPath 可选，指定 Python 路径（打包内嵌场景）
     */
    constructor(
        runtimeDir: string,
        shellExecute: ShellExecuteFn,
        pythonBinaryPath?: string
    ) {
        this.runtimeDir = runtimeDir.replace(/\\/g, '/');
        this.shellExecute = shellExecute;
        this.pythonBinaryPath = pythonBinaryPath ?? null;
    }

    /**
     * 获取 venv 路径
     */
    get venvPath(): string {
        return `${this.runtimeDir}/.venv`;
    }

    /**
     * 获取当前状态
     */
    get currentStatus(): RuntimeStatus {
        return this.status;
    }

    // ==================== 核心流程 ====================

    /**
     * 确保 Runtime 环境就绪
     *
     * 冷启动时调用。检查预置 runtime 是否存在，不存在则从安装包资源解压。
     * 随后验收 SSL/pip/基础包，并安装所有 Script 模式 Skill 声明的额外依赖。
     *
     * 回滚策略：
     * - 预置 runtime 缺失/损坏 → 标记 base_incomplete（提示重新打包或重建）
     * - 基础包验收失败 → 保留 runtime，标记 base_incomplete（可重建）
     * - 额外依赖失败 → 保留已安装内容，标记 extra_partial（降级运行）
     *
     * @param baseRequirementsPath 基础包清单路径 runtime-requirements-v1.txt
     * @param extraDependencies 各 Script 模式 Skill 声明的额外依赖
     * @param onProgress 可选进度回调
     * @returns 环境检查/准备结果
     */
    async ensureReady(
        basePackages: string[],
        extraDependencies: SkillDependencies[],
        onProgress?: ProgressCallback
    ): Promise<RuntimeCheckResult> {
        try {
            // Step 1: 检查 venv 是否存在
            onProgress?.({ phase: translate('runtime.progress.checkEnvironment'), percent: 5 });
            const venvExists = await this.checkVenvExists();

            if (!venvExists) {
                this.status = 'creating';
                // Step 2: 准备预置 runtime；开发/测试环境可回退到动态创建 venv
                onProgress?.({ phase: translate('runtime.progress.preparePrebuiltRuntime'), percent: 10 });
                const prepared = await this.preparePrebuiltPythonRuntime();
                if (!prepared) {
                    if (!this.isRuntimeBuildFallbackAllowed()) {
                        this.status = 'base_incomplete';
                        throw new Error(translate('runtime.errors.prebuiltRuntimeUnavailable', {
                            error: 'python-runtime-v1.zip is unavailable',
                        }));
                    }
                    onProgress?.({ phase: translate('runtime.progress.createVenv'), percent: 10 });
                    await this.createVenvWithRollback();
                }
            } else {
                // 让安装包内的 runtime 签名检查有机会刷新旧版本基础依赖。
                await this.preparePrebuiltPythonRuntime();
            }

            await this.ensureVenvWindowsDllSearchBootstrap();
            await this.ensureVenvSslAvailable();
            await this.ensureVenvPipSslContextAvailable();

            // Step 3: 验收预置基础依赖，不在用户机器上重新下载基础包
            if (basePackages.length > 0) {
                this.status = 'installing_base';
                onProgress?.({ phase: translate('runtime.progress.verifyBaseRuntime'), percent: 65 });
                await this.validatePrebuiltBasePackages(basePackages);
                onProgress?.({ phase: translate('runtime.progress.baseComplete'), percent: 70 });
            }

            // Step 4: 安装额外依赖（增量，逐包安装+进度回调）
            const allExtraPackages = this.aggregateExtraDependencies(extraDependencies);
            let extraPackageFailures: PackageInstallFailure[] = [];
            if (allExtraPackages.length > 0) {
                this.status = 'installing_extra';
                onProgress?.({ phase: translate('runtime.progress.installExtraDeps'), percent: 75 });
                const packagesToInstall = await this.filterSatisfiedExtraPackages(allExtraPackages);
                if (packagesToInstall.length > 0) {
                    extraPackageFailures = await this.installExtraPackagesWithFallback(packagesToInstall, onProgress);
                } else {
                    logger.debug('[RuntimeManager] 额外依赖已满足，跳过安装:', allExtraPackages.join(', '));
                }
            }

            // Step 5: 验证 Python 版本
            onProgress?.({ phase: translate('runtime.progress.verifyEnvironment'), percent: 95 });
            const pythonVersion = await this.getPythonVersion();

            if (extraPackageFailures.length > 0) {
                this.status = 'extra_partial';
                return {
                    status: 'extra_partial',
                    venvPath: this.venvPath,
                    pythonVersion,
                    error: this.formatExtraPackageFailureMessage(extraPackageFailures, allExtraPackages.length),
                    failedPackages: extraPackageFailures.map(failure => failure.packageSpec),
                };
            }

            this.status = 'ready';
            onProgress?.({ phase: translate('runtime.progress.ready'), percent: 100 });
            return {
                status: 'ready',
                venvPath: this.venvPath,
                pythonVersion,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('[RuntimeManager] 环境初始化失败:', errorMessage);

            // 保持已标记的中间状态（base_incomplete 等），不覆盖为 error
            if (this.status !== 'base_incomplete' && this.status !== 'extra_partial') {
                this.status = 'error';
            }

            return {
                status: this.status,
                venvPath: this.venvPath,
                error: errorMessage,
            };
        }
    }

    /**
     * 销毁当前 venv（重建环境前调用）
     *
     * 删除整个 .venv 目录，重置状态为 not_created
     */
    async destroyVenv(): Promise<void> {
        logger.trace('[RuntimeManager] 销毁 venv:', this.venvPath);
        await this.removeVenvDirectory();
        this.status = 'not_created';
        logger.trace('[RuntimeManager] venv 已销毁');
    }

    // ==================== Windows Python 检测 ====================

    /**
     * 检测可用于创建 AgentVis venv 的 Python 路径
     *
     * 多路径探测策略：
     * 1. 优先使用注入的 pythonBinaryPath
     * 2. 尝试 PATH 中的 python / python3 / py -3
     * 3. 探测常见安装路径（LocalAppData/Programs/Python/）
     * 4. 最后回退安装包内嵌 Python
     *
     * @returns 可用的 Python 命令或路径，null 表示未找到
     */
    private async preparePrebuiltPythonRuntime(): Promise<boolean> {
        if (typeof window === 'undefined') {
            return false;
        }

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const runtimeInfo = await invoke<{
                runtime_dir: string;
                venv_path: string;
                python_exe: string;
                just_extracted: boolean;
            }>('prepare_prebuilt_python_runtime');

            logger.info(
                '[RuntimeManager] 使用预置 Python runtime:',
                runtimeInfo.python_exe,
                runtimeInfo.just_extracted ? '（本次解压）' : '（已缓存）'
            );
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('[RuntimeManager] 预置 Python runtime 准备失败:', message);

            if (!this.isRuntimeBuildFallbackAllowed()) {
                this.status = 'base_incomplete';
                throw new Error(translate('runtime.errors.prebuiltRuntimeUnavailable', {
                    error: message,
                }));
            }

            return false;
        }
    }

    private isRuntimeBuildFallbackAllowed(): boolean {
        return typeof window === 'undefined' || import.meta.env.DEV;
    }

    async detectPython(): Promise<string | null> {
        // 如果已注入路径，直接验证
        if (this.pythonBinaryPath) {
            const valid = await this.validatePythonCommand(this.pythonBinaryPath);
            if (valid) return this.pythonBinaryPath;
            logger.warn(
                '[RuntimeManager] 注入的 Python 路径无效:',
                this.pythonBinaryPath
            );
        }

        // 尝试 PATH 中的候选命令
        for (const candidate of WINDOWS_PYTHON_CANDIDATES) {
            const valid = await this.validatePythonCommand(candidate);
            if (valid) {
                logger.trace('[RuntimeManager] 找到 Python:', candidate);
                return candidate;
            }
        }

        // 尝试常见安装目录
        const localAppData = await this.getLocalAppData();
        if (localAppData) {
            for (const pattern of WINDOWS_PYTHON_DIR_PATTERNS) {
                const fullPath = `${localAppData}\\${pattern}`;
                const valid = await this.validatePythonCommand(`"${fullPath}"`);
                if (valid) {
                    logger.trace('[RuntimeManager] 在安装目录找到 Python:', fullPath);
                    return `"${fullPath}"`;
                }
            }
        }

        const embeddedPython = await this.prepareEmbeddedPythonRuntime();
        if (embeddedPython) {
            return embeddedPython;
        }

        logger.warn('[RuntimeManager] 未找到可用的 Python 安装');

        return null;
    }

    /**
     * 准备安装包内嵌的 Python runtime。
     *
     * 正式包中该 runtime 位于 {AppDataDir}/runtime/python-embed-3.13，
     * 用它创建出来的 venv 不会回头访问用户主机 Python，适合隔离/联网隔离模式。
     */
    private async prepareEmbeddedPythonRuntime(): Promise<string | null> {
        if (this.embeddedPythonExe) {
            return this.embeddedPythonExe;
        }
        if (typeof window === 'undefined') {
            return null;
        }

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const embeddedInfo = await invoke<{
                python_exe: string;
                get_pip_path: string;
                just_extracted: boolean;
            }>('prepare_embedded_runtime');

            if (embeddedInfo.python_exe) {
                this.embeddedPythonExe = embeddedInfo.python_exe;
                this.embeddedGetPipPath = embeddedInfo.get_pip_path;
                logger.info(
                    `[RuntimeManager] 使用内嵌 Python ${PACKAGED_PYTHON_VERSION}:`,
                    embeddedInfo.python_exe,
                    embeddedInfo.just_extracted ? '（首次解压）' : '（已缓存）'
                );
                return embeddedInfo.python_exe;
            }
        } catch (invokeError) {
            // Tauri 不可用（测试环境）或开发资源缺失时回退系统 Python
            logger.debug('[RuntimeManager] 内嵌 Python 准备失败，将回退系统 Python:', invokeError);
        }

        return null;
    }

    /**
     * 验证 Python 命令是否可用且版本 >= 3.11
     */
    private async validatePythonCommand(command: string): Promise<boolean> {
        try {
            const result = await this.shellExecute({
                command: `${command} --version`,
                workdir: this.runtimeDir,
                timeout: 10,
                background: false,
            });

            if (result.exitCode !== 0) return false;

            // 检查版本号 >= 3.11
            const versionMatch = result.stdout.match(/Python (\d+)\.(\d+)/);
            if (!versionMatch) return false;

            const majorStr = versionMatch[1];
            const minorStr = versionMatch[2];
            if (!majorStr || !minorStr) return false;

            const major = parseInt(majorStr, 10);
            const minor = parseInt(minorStr, 10);

            // 要求 Python 3.11+
            return major === 3 && minor >= 11;
        } catch {
            return false;
        }
    }

    /**
     * 获取 Windows LOCALAPPDATA 环境变量
     */
    private async getLocalAppData(): Promise<string | null> {
        // 策略：先尝试 PowerShell 语法，再尝试 CMD 语法
        // Tauri shell 的 default shell 可能是 PowerShell 或 CMD，需要两者都覆盖
        const commands = [
            '$env:LOCALAPPDATA',          // PowerShell 语法
            'echo %LOCALAPPDATA%',         // CMD 语法
        ];

        for (const command of commands) {
            try {
                const result = await this.shellExecute({
                    command,
                    workdir: this.runtimeDir,
                    timeout: 5,
                    background: false,
                });
                const value = result.stdout.trim();
                // 确保不是未展开的变量名或 PowerShell 错误输出
                if (value && !value.includes('%LOCALAPPDATA%') && !value.includes('$env:')) {
                    return value;
                }
            } catch {
                // 单个命令失败时继续尝试下一个
                continue;
            }
        }

        return null;
    }

    // ==================== 内部方法 ====================

    /**
     * 检查 venv 是否存在（通过尝试获取 Python 版本来判断）
     */
    private async checkVenvExists(): Promise<boolean> {
        try {
            const pythonBin = this.getPythonBin();
            const result = await this.shellExecute({
                command: `${pythonBin} --version`,
                workdir: this.runtimeDir,
                timeout: 10,
                background: false,
            });
            return result.exitCode === 0;
        } catch {
            return false;
        }
    }

    /**
     * 创建 Python 虚拟环境（带回滚）
     *
     * 失败时自动删除残留 .venv 目录，避免污染后续重试。
     *
     * 若使用内嵌 Python：
     *   1. 先引导 pip（get-pip.py）+ 安装 virtualenv
     *   2. 使用 virtualenv 替代 venv（virtualenv 能正确处理 DLL 路径）
     */
    private async createVenvWithRollback(): Promise<void> {
        logger.trace('[RuntimeManager] 创建 Python 虚拟环境:', this.venvPath);

        // 探测系统 Python（或内嵌 Python）
        const pythonCommand = await this.detectPython();
        if (!pythonCommand) {
            throw new Error(
                'Python 3.11+ was not found. Install Python 3.11 or a newer version and try again.' +
                '\nDownload: https://www.python.org/downloads/'
            );
        }

        // 判断是否使用内嵌 Python（需要特殊引导流程）
        const isEmbedded = this.embeddedPythonExe !== null &&
            pythonCommand === this.embeddedPythonExe;

        try {
            if (isEmbedded) {
                // Step 1（仅内嵌 Python）：引导 pip + 安装 virtualenv
                logger.info('[RuntimeManager] 使用内嵌 Python，开始引导 pip 和 virtualenv');
                await this.bootstrapEmbeddedPipAndVirtualenv(pythonCommand);
            }

            // Step 2：创建 venv
            // 内嵌 Python → 使用 virtualenv（处理 DLL 路径问题）
            // 系统 Python → 使用标准 venv
            const createCmd = isEmbedded
                ? `"${pythonCommand}" -m virtualenv --copies "${this.venvPath}"`
                : `${pythonCommand} -m venv "${this.venvPath}"`;

            logger.trace(
                `[RuntimeManager] 创建 venv 命令: ${createCmd.slice(0, 120)}`
            );

            const result = await this.shellExecute({
                command: createCmd,
                workdir: this.runtimeDir,
                timeout: 120,
                background: false,
            });

            if (result.exitCode !== 0) {
                throw new Error(
                    `Failed to create venv (exit ${result.exitCode}): ${result.stderr}`
                );
            }

            logger.trace('[RuntimeManager] venv 创建成功');
        } catch (error) {
            // 回滚：删除可能残留的 .venv 目录
            logger.warn('[RuntimeManager] venv 创建失败，执行回滚...');
            await this.removeVenvDirectory();
            throw error;
        }
    }

    /**
     * 为内嵌 Python 引导 pip 和 virtualenv
     *
     * 内嵌 Python 不含 pip，需要通过 get-pip.py 引导：
     * 1. `python.exe get-pip.py`        → 安装 pip 到内嵌 Python 目录
     * 2. `python.exe -m pip install virtualenv` → 安装 virtualenv
     *
     * 两步均幂等：已安装则快速跳过。
     */
    private async bootstrapEmbeddedPipAndVirtualenv(embeddedPythonExe: string): Promise<void> {
        const quotedPython = `"${embeddedPythonExe}"`;

        // 检查 pip 是否已安装（幂等）
        const pipCheck = await this.shellExecute({
            command: `${quotedPython} -m pip --version`,
            workdir: this.runtimeDir,
            timeout: 10,
            background: false,
        });

        if (pipCheck.exitCode !== 0) {
            // 引导 pip
            if (!this.embeddedGetPipPath) {
                throw new Error('get-pip.py path is not configured, so pip cannot be bootstrapped for the embedded Python runtime');
            }
            logger.info('[RuntimeManager] 正在引导 pip（get-pip.py）...');
            const bootstrapResult = await this.shellExecute({
                command: `${quotedPython} "${this.embeddedGetPipPath}" --no-warn-script-location`,
                workdir: this.runtimeDir,
                timeout: 180,
                background: false,
            });
            if (bootstrapResult.exitCode !== 0) {
                throw new Error(
                    `Failed to bootstrap pip (exit ${bootstrapResult.exitCode}): ${bootstrapResult.stderr}`
                );
            }
            logger.info('[RuntimeManager] pip 引导成功');
        } else {
            logger.trace('[RuntimeManager] pip 已安装，跳过引导');
        }

        // 检查 virtualenv 是否已安装（幂等）
        const venvCheck = await this.shellExecute({
            command: `${quotedPython} -m virtualenv --version`,
            workdir: this.runtimeDir,
            timeout: 10,
            background: false,
        });

        if (venvCheck.exitCode !== 0) {
            // 安装 virtualenv（使用国内镜像加速）
            logger.info('[RuntimeManager] 正在安装 virtualenv...');
            const mirrorArgs = this.buildMirrorArgs();
            const installResult = await this.shellExecute({
                command: `${quotedPython} -m pip install virtualenv ${mirrorArgs}`,
                workdir: this.runtimeDir,
                timeout: PIP_INSTALL_TIMEOUT_SECS,
                background: false,
            });
            if (installResult.exitCode !== 0) {
                throw new Error(
                    `Failed to install virtualenv (exit ${installResult.exitCode}): ${installResult.stderr}`
                );
            }
            logger.info('[RuntimeManager] virtualenv 安装成功');
        } else {
            logger.trace('[RuntimeManager] virtualenv 已安装，跳过');
        }
    }

    private async ensureVenvSslAvailable(): Promise<void> {
        let result = await this.checkVenvSsl();

        const output = this.combineCommandOutput(result.stderr, result.stdout);
        if (result.exitCode === 0 && !this.containsPythonSslFailure(output)) {
            return;
        }

        const repaired = await this.repairVenvSslDllsFromEmbeddedRuntime();
        if (repaired) {
            result = await this.checkVenvSsl();
            const repairedOutput = this.combineCommandOutput(result.stderr, result.stdout);
            if (result.exitCode === 0 && !this.containsPythonSslFailure(repairedOutput)) {
                logger.info('[RuntimeManager] 已修复 venv SSL DLL 依赖');
                return;
            }
        }

        const finalOutput = this.combineCommandOutput(result.stderr, result.stdout);
        if (result.exitCode !== 0 || this.containsPythonSslFailure(finalOutput)) {
            this.status = 'base_incomplete';
            throw new Error(translate('runtime.errors.pythonSslUnavailable', {
                error: this.sanitizeFailureOutput(finalOutput) || `exit ${result.exitCode}`,
            }));
        }
    }

    private async checkVenvSsl(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const pythonBin = this.getPythonBin();
        return this.executeRuntimeShell({
            command: `${pythonBin} -c "import ssl; print(ssl.OPENSSL_VERSION)"`,
            workdir: this.getVenvScriptsDir(),
            timeout: 15,
            background: false,
        });
    }

    private async ensureVenvPipSslContextAvailable(): Promise<void> {
        const pythonBin = this.getPythonBin();
        let result = await this.executeRuntimeShell({
            command: [
                `${pythonBin} -c "`,
                'import ssl; ',
                'import pip._internal.cli.index_command as index_command; ',
                'factory=getattr(index_command, \'_create_truststore_ssl_context\', None); ',
                'factory() if factory else None; ',
                'print(\'pip ssl ok\')"',
            ].join(''),
            workdir: this.getVenvScriptsDir(),
            timeout: 20,
            background: false,
        });

        if (result.exitCode === 0) {
            return;
        }

        let output = this.combineCommandOutput(result.stderr, result.stdout);
        if (this.containsPythonSslFailure(output)) {
            const repaired = await this.repairVenvSslDllsFromEmbeddedRuntime();
            if (repaired) {
                result = await this.executeRuntimeShell({
                    command: [
                        `${pythonBin} -c "`,
                        'import ssl; ',
                        'import pip._internal.cli.index_command as index_command; ',
                        'factory=getattr(index_command, \'_create_truststore_ssl_context\', None); ',
                        'factory() if factory else None; ',
                        'print(\'pip ssl ok\')"',
                    ].join(''),
                    workdir: this.getVenvScriptsDir(),
                    timeout: 20,
                    background: false,
                });
                if (result.exitCode === 0) {
                    return;
                }
                output = this.combineCommandOutput(result.stderr, result.stdout);
            }
        }

        this.status = 'base_incomplete';
        throw new Error(translate('runtime.errors.pythonSslUnavailable', {
            error: this.sanitizeFailureOutput(output) || `exit ${result.exitCode}`,
        }));
    }

    private async ensureVenvWindowsDllSearchBootstrap(): Promise<void> {
        if (!this.detectWindows() || typeof window === 'undefined') {
            return;
        }

        const sitePackagesDirs = [
            this.toWindowsPath(`${this.venvPath}/Scripts/Lib/site-packages`),
            this.toWindowsPath(`${this.venvPath}/Lib/site-packages`),
        ];
        const siteCustomize = this.buildWindowsDllSearchSiteCustomize();

        try {
            const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
            for (const sitePackagesDir of sitePackagesDirs) {
                await mkdir(sitePackagesDir, { recursive: true });
                await writeTextFile(`${sitePackagesDir}\\sitecustomize.py`, siteCustomize);
            }
        } catch (error) {
            logger.warn(
                '[RuntimeManager] 写入 venv Python bootstrap 失败:',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private buildWindowsDllSearchSiteCustomize(): string {
        return [
            '# Auto-generated by AgentVis. Keeps embedded Python DLLs discoverable in venv.',
            'import os',
            'import sys',
            'from pathlib import Path',
            '',
            '_AGENTVIS_DLL_DIR_HANDLES = []',
            '',
            'def _agentvis_add_dll_dir(path):',
            '    try:',
            '        resolved = Path(path).resolve()',
            '        if hasattr(os, "add_dll_directory") and resolved.exists():',
            '            _AGENTVIS_DLL_DIR_HANDLES.append(os.add_dll_directory(str(resolved)))',
            '    except (OSError, ValueError):',
            '        pass',
            '',
            '_agentvis_candidate_dirs = [',
            '    Path(sys.executable).resolve().parent,',
            '    Path(getattr(sys, "base_prefix", sys.prefix)).resolve(),',
            '    Path(getattr(sys, "base_exec_prefix", sys.exec_prefix)).resolve(),',
            '    Path(sys.prefix).resolve(),',
            ']',
            '_agentvis_seen = set()',
            'for _agentvis_dir in _agentvis_candidate_dirs:',
            '    _agentvis_key = str(_agentvis_dir).lower()',
            '    if _agentvis_key not in _agentvis_seen:',
            '        _agentvis_seen.add(_agentvis_key)',
            '        _agentvis_add_dll_dir(_agentvis_dir)',
            '',
            'def _agentvis_add_entry_script_dir():',
            '    try:',
            '        if not sys.argv:',
            '            return',
            '        argv0 = sys.argv[0]',
            '        if not argv0 or argv0 in {"-c", "-m"}:',
            '            return',
            '        entry = Path(argv0)',
            '        if not entry.is_absolute():',
            '            entry = Path.cwd() / entry',
            '        if not entry.is_file():',
            '            return',
            '        script_dir = str(entry.resolve().parent)',
            '        if script_dir not in sys.path:',
            '            sys.path.insert(0, script_dir)',
            '    except (OSError, ValueError):',
            '        pass',
            '',
            '_agentvis_add_entry_script_dir()',
            '',
        ].join('\n');
    }

    private async repairVenvSslDllsFromEmbeddedRuntime(): Promise<boolean> {
        if (!this.detectWindows()) {
            return false;
        }

        const embeddedDir = await this.resolveVenvEmbeddedRuntimeDir();
        if (!embeddedDir) {
            return false;
        }

        const sourceDir = this.toWindowsPath(embeddedDir);
        const scriptsDir = this.toWindowsPath(`${this.venvPath}/Scripts`);
        const copyCommand = [
            `copy /Y "${sourceDir}\\*.dll" "${scriptsDir}\\"`,
            `copy /Y "${sourceDir}\\*.pyd" "${scriptsDir}\\"`,
        ].join(' && ');

        try {
            const result = await this.executeRuntimeShell({
                command: copyCommand,
                workdir: this.runtimeDir,
                timeout: 30,
                background: false,
            });

            if (result.exitCode === 0) {
                return true;
            }

            logger.warn(
                '[RuntimeManager] 修复 venv SSL DLL 依赖失败:',
                this.combineCommandOutput(result.stderr, result.stdout)
            );
        } catch (error) {
            logger.warn(
                '[RuntimeManager] 修复 venv SSL DLL 依赖异常:',
                error instanceof Error ? error.message : String(error)
            );
        }

        return false;
    }

    private async resolveVenvEmbeddedRuntimeDir(): Promise<string | null> {
        const configuredPythonExe = this.pythonBinaryPath?.replace(/^["']|["']$/g, '') ?? null;
        const configuredPythonDir = configuredPythonExe
            ? this.getParentDirectory(configuredPythonExe)
            : null;
        if (configuredPythonDir && this.isAppManagedEmbeddedRuntimeDir(configuredPythonDir)) {
            return configuredPythonDir;
        }

        if (this.embeddedPythonExe) {
            const embeddedDir = this.getParentDirectory(this.embeddedPythonExe);
            if (embeddedDir) {
                return embeddedDir;
            }
        }

        const cfgBaseDir = await this.readVenvBaseRuntimeDir();
        if (cfgBaseDir) {
            return this.isAppManagedEmbeddedRuntimeDir(cfgBaseDir) ? cfgBaseDir : null;
        }

        const embeddedPythonExe = await this.prepareEmbeddedPythonRuntime();
        return embeddedPythonExe ? this.getParentDirectory(embeddedPythonExe) : null;
    }

    private async readVenvBaseRuntimeDir(): Promise<string | null> {
        if (typeof window === 'undefined') {
            return null;
        }

        try {
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            const content = await readTextFile(this.toWindowsPath(`${this.venvPath}/pyvenv.cfg`));
            const values = new Map<string, string>();
            for (const line of content.split(/\r?\n/)) {
                const match = line.match(/^([^=]+?)\s*=\s*(.+)$/);
                if (!match) continue;
                const key = match[1];
                const value = match[2];
                if (!key || !value) continue;
                values.set(key.trim().toLowerCase(), value.trim());
            }

            const baseDir = values.get('base-prefix') ?? values.get('home');
            if (baseDir) {
                return baseDir;
            }

            const executable = values.get('base-executable') ?? values.get('executable');
            return executable ? this.getParentDirectory(executable) : null;
        } catch (error) {
            logger.debug(
                '[RuntimeManager] 读取 pyvenv.cfg 失败，无法判断 venv base runtime:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }
    }

    private isAppManagedEmbeddedRuntimeDir(path: string): boolean {
        const runtimeRoot = this.getParentDirectory(this.runtimeDir);
        if (!runtimeRoot) {
            return false;
        }
        const normalizedRuntimeRoot = runtimeRoot.replace(/^["']|["']$/g, '').replace(/\\/g, '/').toLowerCase();
        const normalized = path.replace(/^["']|["']$/g, '').replace(/\\/g, '/').toLowerCase();
        return (
            this.getParentDirectory(normalized) === normalizedRuntimeRoot &&
            normalized.startsWith(`${normalizedRuntimeRoot}/python-embed-`)
        );
    }

    private async executeRuntimeShell(
        params: RuntimeShellExecuteParams
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return this.shellExecute({
            ...params,
            env: {
                __AGENTVIS_VENV_SCRIPTS_DIR__: this.getVenvScriptsDir(),
                PYTHONUTF8: '1',
                PYTHONDONTWRITEBYTECODE: '1',
                ...(params.env ?? {}),
            },
        });
    }

    /**
     * 验收预置基础依赖。
     *
     * 基础依赖在打包期安装到 python-runtime-v1.zip，运行时只检查 import 是否可用。
     * 失败时标记 base_incomplete，提示重新构建预置 runtime。
     */
    private async validatePrebuiltBasePackages(packages: string[]): Promise<void> {
        const modules = this.getBasePackageImportNames(packages);
        if (modules.length === 0) {
            return;
        }

        const moduleList = modules.map(moduleName => this.toPythonSingleQuotedString(moduleName)).join(',');
        const pythonBin = this.getPythonBin();
        const script = [
            'import importlib.util, sys',
            `modules=[${moduleList}]`,
            'missing=[m for m in modules if importlib.util.find_spec(m) is None]',
            "sys.exit('missing prebuilt base modules: ' + ', '.join(missing)) if missing else print('prebuilt runtime ok')",
        ].join('; ');

        const result = await this.executeRuntimeShell({
            command: `${pythonBin} -c "${script}"`,
            workdir: this.getVenvScriptsDir(),
            timeout: 30,
            background: false,
        });

        if (result.exitCode === 0) {
            logger.trace('[RuntimeManager] 预置基础依赖验收通过:', modules.join(', '));
            return;
        }

        this.status = 'base_incomplete';
        const output = this.combineCommandOutput(result.stderr, result.stdout);
        throw new Error(translate('runtime.errors.prebuiltRuntimeMissingBasePackages', {
            modules: modules.join(', '),
            error: this.sanitizeFailureOutput(output) || `exit ${result.exitCode}`,
        }));
    }

    private getBasePackageImportNames(packages: string[]): string[] {
        const modules = new Set<string>();
        for (const packageSpec of packages) {
            const packageName = packageSpec.trim().match(/^[A-Za-z0-9_.-]+/)?.[0]?.toLowerCase();
            if (!packageName) {
                continue;
            }
            modules.add(BASE_PACKAGE_IMPORT_NAME_OVERRIDES.get(packageName) ?? packageName.replace(/-/g, '_'));
        }
        return Array.from(modules);
    }

    private toPythonSingleQuotedString(value: string): string {
        return `'${value
            .replace(/\\/g, '\\\\')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/'/g, "\\'")}'`;
    }

    async installBasePackages(
        packages: string[],
        onProgress?: ProgressCallback
    ): Promise<void> {
        logger.trace(`[RuntimeManager] 开始分批安装基础依赖 (共 ${packages.length} 个)`);

        const mirrorArgs = this.buildMirrorArgs();
        const pipCommand = this.getPipCommand();
        const failedPackages: PackageInstallFailure[] = [];

        // 进度范围：15% ~ 68%（留出前后空间给 venv 创建和验证）
        const PROGRESS_START = 15;
        const PROGRESS_END = 68;

        // 按 BATCH_SIZE 分批
        const BATCH_SIZE = 5;
        const batches: string[][] = [];
        for (let i = 0; i < packages.length; i += BATCH_SIZE) {
            batches.push(packages.slice(i, i + BATCH_SIZE));
        }

        let processedCount = 0;
        for (const batch of batches) {
            const batchStart = processedCount + 1;
            const batchEnd = processedCount + batch.length;
            const percent = PROGRESS_START + Math.round(
                (processedCount / packages.length) * (PROGRESS_END - PROGRESS_START)
            );

            // 提取包名（去掉版本号）用于 UI 显示
            const batchNames = batch.map(pkg =>
                (pkg.split('==')[0] ?? pkg).split('>=')[0]?.split('<=')[0]?.split('~=')[0] ?? pkg
            );
            onProgress?.({
                phase: translate('runtime.progress.installBaseBatch', {
                    range: `${batchStart}-${batchEnd}`,
                    total: packages.length,
                    packages: batchNames.join(', '),
                }),
                percent,
            });

            const batchFailed = await this.installPackageBatch(
                batch, pipCommand, mirrorArgs, `base ${batchStart}-${batchEnd}`
            );
            failedPackages.push(...batchFailed);

            processedCount += batch.length;
        }

        if (failedPackages.length > 0) {
            this.status = 'base_incomplete';
            throw new Error(this.formatBasePackageFailureMessage(failedPackages, packages.length));
        }

        logger.trace('[RuntimeManager] 全部基础包安装完成');
    }

    /**
     * 分批安装单个批次（批量尝试 → 失败回退逐包）
     *
     * 策略：
     * 1. 先尝试一次性安装整批（一次 pip 调用，减少进程启动和连接开销）
     * 2. 如果批量安装失败，回退到逐包安装以精确定位失败的包
     *
     * 这样正常场景下 N 个包只需 N/BATCH_SIZE 次 pip 调用，
     * 而单包失败时仍能像原来一样隔离错误。
     *
     * @returns 安装失败的包信息列表（空数组表示全部成功）
     */
    /**
     * 对单个包规范字符串加引号
     *
     * 含 platform marker（如 `pip-system-certs; sys_platform == "win32"`）的规范
     * 本身已含双引号，不能再用外层双引号包裹，否则 shell 命令会因引号嵌套而破坏。
     * 普通包规范（如 `requests==2.34.2`）仍加双引号，确保路径中空格被正确处理。
     */
    private quotePkgArg(pkg: string): string {
        // 含 '; ' 说明有 PEP 508 marker，marker 内部可能有 "win32" 等双引号字符串
        return pkg.includes('; ') ? pkg : `"${pkg}"`;
    }

    private async installPackageBatch(
        batch: string[],
        pipCommand: string,
        mirrorArgs: string,
        batchLabel: string,
    ): Promise<PackageInstallFailure[]> {
        const installTargetArgs = this.getPipInstallTargetArgs();

        // 单个包无需批量逻辑
        if (batch.length === 1) {
            const pkg = batch[0];
            if (!pkg) return [];
            const result = await this.executeRuntimeShell({
                command: `${pipCommand} install ${installTargetArgs} ${this.quotePkgArg(pkg)} ${mirrorArgs}`,
                workdir: this.getVenvScriptsDir(),
                timeout: PIP_INSTALL_TIMEOUT_SECS,
                background: false,
            });
            if (result.exitCode !== 0) {
                const failure = this.toPackageInstallFailure(pkg, result);
                logger.warn(
                    `[RuntimeManager] [${batchLabel}] 安装 ${pkg} 失败 (exit ${result.exitCode}):`,
                    this.sanitizeFailureOutput(failure.output) || `exit ${result.exitCode}`
                );
                return [failure];
            }
            logger.trace(`[RuntimeManager] [${batchLabel}] ${pkg} 安装成功`);
            return [];
        }

        // 尝试批量安装：将多个包合并到一条 pip install 命令
        // 超时按包数量线性放大，因为包含编译型包（如 curl_cffi）时单个包就可能需要数分钟
        const pkgArgs = batch.map(pkg => this.quotePkgArg(pkg)).join(' ');
        const batchTimeout = PIP_INSTALL_TIMEOUT_SECS * batch.length;
        logger.trace(`[RuntimeManager] [${batchLabel}] 批量安装: ${batch.join(', ')} (超时: ${batchTimeout}s)`);

        const batchResult = await this.executeRuntimeShell({
            command: `${pipCommand} install ${installTargetArgs} ${pkgArgs} ${mirrorArgs}`,
            workdir: this.getVenvScriptsDir(),
            timeout: batchTimeout,
            background: false,
        });

        if (batchResult.exitCode === 0) {
            logger.trace(`[RuntimeManager] [${batchLabel}] 批量安装成功 (${batch.length} 个包)`);
            return [];
        }

        // 批量失败 → 回退逐包安装，精确定位失败的包。兜底成功时不提升到 warn。
        const batchFailureOutput = this.combineCommandOutput(batchResult.stderr, batchResult.stdout);
        logger.debug(
            `[RuntimeManager] [${batchLabel}] 批量安装失败，回退逐包安装`,
            this.sanitizeFailureOutput(batchFailureOutput) || `exit ${batchResult.exitCode}`
        );
        const failedPackages: PackageInstallFailure[] = [];

        for (const pkg of batch) {
            const result = await this.executeRuntimeShell({
                command: `${pipCommand} install ${installTargetArgs} ${this.quotePkgArg(pkg)} ${mirrorArgs}`,
                workdir: this.getVenvScriptsDir(),
                timeout: PIP_INSTALL_TIMEOUT_SECS,
                background: false,
            });

            if (result.exitCode !== 0) {
                const failure = this.toPackageInstallFailure(pkg, result);
                logger.debug(
                    `[RuntimeManager] [${batchLabel}] 安装 ${pkg} 失败 (exit ${result.exitCode}):`,
                    this.sanitizeFailureOutput(failure.output) || `exit ${result.exitCode}`
                );
                failedPackages.push(failure);
            } else {
                logger.trace(`[RuntimeManager] [${batchLabel}] ${pkg} 安装成功`);
            }
        }

        if (failedPackages.length > 0) {
            logger.debug(
                `[RuntimeManager] [${batchLabel}] 逐包安装后仍有 ${failedPackages.length}/${batch.length} 个失败:`,
                failedPackages.map(failure => failure.packageSpec).join(', ')
            );
        } else {
            logger.debug(`[RuntimeManager] [${batchLabel}] 批量安装失败，但逐包安装全部成功`);
        }

        return failedPackages;
    }

    /**
     * 分批安装额外依赖（降级容错）
     *
     * 与 installBasePackages 相同的分批策略，复用 installPackageBatch：
     * - 正常场景：批量安装减少 pip 调用次数
     * - 批量失败时回退逐包安装，精确定位失败包
     * - 通过 onProgress 回调实时显示安装进度
     *
     * 安装失败不抛异常，标记 extra_partial 允许降级运行。
     */
    private async installExtraPackagesWithFallback(
        packages: string[],
        onProgress?: ProgressCallback
    ): Promise<PackageInstallFailure[]> {
        logger.trace('[RuntimeManager] 分批安装额外依赖:', packages.join(', '));

        const pipCommand = this.getPipCommand();
        const mirrorArgs = this.buildMirrorArgs();
        const failedPackages: PackageInstallFailure[] = [];

        // 进度范围：75% ~ 93%（在基础包之后、验证之前）
        const PROGRESS_START = 75;
        const PROGRESS_END = 93;

        // 按 BATCH_SIZE 分批
        const BATCH_SIZE = 5;
        const batches: string[][] = [];
        for (let i = 0; i < packages.length; i += BATCH_SIZE) {
            batches.push(packages.slice(i, i + BATCH_SIZE));
        }

        let processedCount = 0;
        for (const batch of batches) {
            const batchStart = processedCount + 1;
            const batchEnd = processedCount + batch.length;
            const percent = PROGRESS_START + Math.round(
                (processedCount / packages.length) * (PROGRESS_END - PROGRESS_START)
            );

            const batchNames = batch.map(pkg =>
                (pkg.split('==')[0] ?? pkg).split('>=')[0]?.split('<=')[0]?.split('~=')[0] ?? pkg
            );
            onProgress?.({
                phase: translate('runtime.progress.installExtraBatch', {
                    range: `${batchStart}-${batchEnd}`,
                    total: packages.length,
                    packages: batchNames.join(', '),
                }),
                percent,
            });

            const batchFailed = await this.installPackageBatch(
                batch, pipCommand, mirrorArgs, `extra ${batchStart}-${batchEnd}`
            );
            failedPackages.push(...batchFailed);

            processedCount += batch.length;
        }

        if (failedPackages.length > 0) {
            this.status = 'extra_partial';
            logger.warn(
                `[RuntimeManager] ${failedPackages.length}/${packages.length} 个额外依赖安装失败（降级运行）:`,
                failedPackages.map(failure => failure.packageSpec).join(', ')
            );
        } else {
            logger.trace('[RuntimeManager] 全部额外依赖安装完成');
        }

        return failedPackages;
    }

    private async filterSatisfiedExtraPackages(packages: string[]): Promise<string[]> {
        const probe = await this.probeExtraPackageSatisfaction(packages);
        if (!probe) {
            return packages;
        }

        if (probe.satisfied.length > 0) {
            logger.debug('[RuntimeManager] 跳过已满足的额外依赖:', probe.satisfied.join(', '));
        }
        if (probe.skipped.length > 0) {
            logger.debug('[RuntimeManager] 跳过当前环境不适用的额外依赖:', probe.skipped.join(', '));
        }
        if (probe.unsatisfied.length > 0) {
            logger.debug('[RuntimeManager] 需要安装或升级的额外依赖:', probe.unsatisfied.join(', '));
        }

        return probe.unsatisfied;
    }

    private async probeExtraPackageSatisfaction(
        packages: string[]
    ): Promise<ExtraPackageSatisfactionProbe | null> {
        const pythonBin = this.getPythonBin();
        const script = [
            'import importlib.metadata as metadata',
            'import json',
            'import os',
            'specs = json.loads(os.environ.get(\'AGENTVIS_EXTRA_REQUIREMENTS_JSON\', \'[]\'))',
            'satisfied = []',
            'unsatisfied = []',
            'skipped = []',
            'try:',
            '    from pip._vendor.packaging.requirements import Requirement',
            '    from pip._vendor.packaging.markers import default_environment',
            'except Exception:',
            '    print(json.dumps({\'ok\': False, \'satisfied\': [], \'unsatisfied\': specs, \'skipped\': []}))',
            '    raise SystemExit(0)',
            'env = default_environment()',
            'for spec in specs:',
            '    try:',
            '        req = Requirement(spec)',
            '    except Exception:',
            '        unsatisfied.append(spec)',
            '        continue',
            '    if req.url or req.extras:',
            '        unsatisfied.append(spec)',
            '        continue',
            '    try:',
            '        if req.marker is not None and not req.marker.evaluate(env):',
            '            skipped.append(spec)',
            '            continue',
            '    except Exception:',
            '        unsatisfied.append(spec)',
            '        continue',
            '    try:',
            '        version = metadata.version(req.name)',
            '    except metadata.PackageNotFoundError:',
            '        unsatisfied.append(spec)',
            '        continue',
            '    except Exception:',
            '        unsatisfied.append(spec)',
            '        continue',
            '    if req.specifier and not req.specifier.contains(version, prereleases=True):',
            '        unsatisfied.append(spec)',
            '    else:',
            '        satisfied.append(spec)',
            'print(json.dumps({\'ok\': True, \'satisfied\': satisfied, \'unsatisfied\': unsatisfied, \'skipped\': skipped}))',
        ].join('\n');

        const result = await this.executeRuntimeShell({
            command: `${pythonBin} -c "exec(${this.toPythonSingleQuotedString(script)})"`,
            workdir: this.getVenvScriptsDir(),
            timeout: 30,
            background: false,
            env: {
                [EXTRA_REQUIREMENTS_PROBE_ENV]: JSON.stringify(packages),
            },
        });

        if (result.exitCode !== 0) {
            logger.debug(
                '[RuntimeManager] 探测额外依赖安装状态失败，回退 pip install:',
                this.sanitizeFailureOutput(this.combineCommandOutput(result.stderr, result.stdout)) || `exit ${result.exitCode}`
            );
            return null;
        }

        try {
            const parsed = JSON.parse(result.stdout.trim()) as unknown;
            return this.normalizeExtraPackageProbe(parsed, packages);
        } catch (error) {
            logger.debug(
                '[RuntimeManager] 解析额外依赖安装状态失败，回退 pip install:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }
    }

    private normalizeExtraPackageProbe(
        value: unknown,
        fallbackUnsatisfied: string[]
    ): ExtraPackageSatisfactionProbe {
        if (!this.isRecord(value)) {
            return {
                satisfied: [],
                unsatisfied: fallbackUnsatisfied,
                skipped: [],
            };
        }

        const satisfied = this.readStringArray(value.satisfied);
        const unsatisfied = this.readStringArray(value.unsatisfied);
        const skipped = this.readStringArray(value.skipped);
        const classified = new Set([...satisfied, ...unsatisfied, ...skipped]);
        const unclassified = fallbackUnsatisfied.filter(pkg => !classified.has(pkg));

        return {
            satisfied,
            unsatisfied: [...unsatisfied, ...unclassified],
            skipped,
        };
    }

    private toPackageInstallFailure(
        packageSpec: string,
        result: { exitCode: number; stdout: string; stderr: string }
    ): PackageInstallFailure {
        return {
            packageSpec,
            exitCode: result.exitCode,
            output: this.combineCommandOutput(result.stderr, result.stdout),
        };
    }

    private formatBasePackageFailureMessage(
        failures: PackageInstallFailure[],
        totalPackages: number
    ): string {
        const packages = failures.map(failure => failure.packageSpec).join(', ');
        const details = failures.slice(0, 3).map(failure => {
            const reason = this.sanitizeFailureOutput(failure.output) || `exit ${failure.exitCode}`;
            return translate('runtime.errors.packageInstallFailureDetail', {
                package: failure.packageSpec,
                reason,
            });
        });

        if (failures.length > details.length) {
            details.push(translate('runtime.errors.packageInstallFailureMore', {
                count: failures.length - details.length,
            }));
        }

        if (this.containsPythonSslFailure(failures.map(failure => failure.output).join('\n'))) {
            details.unshift(translate('runtime.errors.pythonSslUnavailableShort'));
        }

        return translate('runtime.errors.basePackagesFailed', {
            failed: failures.length,
            total: totalPackages,
            packages,
            details: details.join('\n'),
        });
    }

    private formatExtraPackageFailureMessage(
        failures: PackageInstallFailure[],
        totalPackages: number
    ): string {
        const packages = failures.map(failure => failure.packageSpec).join(', ');
        const details = failures.slice(0, 3).map(failure => {
            const reason = this.sanitizeFailureOutput(failure.output) || `exit ${failure.exitCode}`;
            return translate('runtime.errors.packageInstallFailureDetail', {
                package: failure.packageSpec,
                reason,
            });
        });

        if (failures.length > details.length) {
            details.push(translate('runtime.errors.packageInstallFailureMore', {
                count: failures.length - details.length,
            }));
        }

        return translate('runtime.errors.extraPackagesFailed', {
            failed: failures.length,
            total: totalPackages,
            packages,
            details: details.join('\n'),
        });
    }

    private combineCommandOutput(stderr: string, stdout: string): string {
        return [stderr, stdout]
            .map(part => part.trim())
            .filter(Boolean)
            .join('\n');
    }

    private sanitizeFailureOutput(output: string): string {
        const cleaned = output
            .replace(ANSI_ESCAPE_SEQUENCE_RE, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (cleaned.length <= 320) {
            return cleaned;
        }
        return `${cleaned.slice(0, 320)}...`;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private readStringArray(value: unknown): string[] {
        return Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
    }

    private containsPythonSslFailure(output: string): boolean {
        return /no module named ['"]?_ssl['"]?|ssl module.*not available|can't connect to https url because the ssl module is not available/i
            .test(output);
    }

    /**
     * 构建 pip 镜像源参数
     *
     * 使用国内镜像源加速下载：
     * - 主源：阿里云 HTTP（速度快、稳定、规避 SSL 握手问题）
     * - 备源：清华 HTTP
     * - 兜底：PyPI 官方 HTTPS
     *
     * 为什么用 HTTP 而非 HTTPS：
     * Anaconda 创建的 venv 继承其自带的 OpenSSL 库，
     * 当系统存在代理/VPN/企业防火墙做 HTTPS 拦截（MITM）时，
     * Anaconda 的 SSL 不认识中间人证书，导致所有 HTTPS 请求报
     * SSL: UNEXPECTED_EOF_WHILE_READING。--trusted-host 只跳过
     * 证书验证，无法修复握手中断。使用 HTTP 彻底绕过此问题。
     *
     * --trusted-host 仍然需要：pip 默认拒绝从 HTTP 源安装。
     */
    private buildMirrorArgs(): string {
        // 国内镜像使用 HTTP，规避 Anaconda OpenSSL 兼容性问题
        const primaryMirror = 'http://mirrors.aliyun.com/pypi/simple/';
        const backupMirror = 'http://pypi.tuna.tsinghua.edu.cn/simple/';
        // PyPI 官方保持 HTTPS，作为最后兜底
        const officialPyPI = 'https://pypi.org/simple/';

        return [
            `--index-url ${primaryMirror}`,
            `--extra-index-url ${backupMirror}`,
            `--extra-index-url ${officialPyPI}`,
            '--trusted-host mirrors.aliyun.com',
            '--trusted-host pypi.tuna.tsinghua.edu.cn',
        ].join(' ');
    }

    /**
     * 删除 venv 目录
     *
     * 用于回滚和重建环境场景。
     * Windows 下使用 rmdir /s /q，Unix 使用 rm -rf。
     */
    private async removeVenvDirectory(): Promise<void> {
        try {
            const isWindows = this.detectWindows();
            const command = isWindows
                ? `rmdir /s /q "${this.venvPath}"`
                : `rm -rf "${this.venvPath}"`;

            await this.shellExecute({
                command,
                workdir: this.runtimeDir,
                timeout: 30,
                background: false,
            });
        } catch (error) {
            // 删除失败仅警告，不阻断流程
            logger.warn('[RuntimeManager] 删除 venv 目录失败:', error);
        }
    }

    /**
     * 获取 venv 中的 Python 版本号
     */
    private async getPythonVersion(): Promise<string | undefined> {
        try {
            const pythonBin = this.getPythonBin();
            const result = await this.shellExecute({
                command: `${pythonBin} --version`,
                workdir: this.runtimeDir,
                timeout: 10,
                background: false,
            });
            // "Python 3.11.5" → "3.11.5"
            return result.stdout.trim().replace('Python ', '');
        } catch {
            return undefined;
        }
    }

    /**
     * 聚合所有 Skill 的额外依赖包（去重）
     */
    private aggregateExtraDependencies(
        dependencies: SkillDependencies[]
    ): string[] {
        const packageSet = new Set<string>();
        for (const dep of dependencies) {
            if (dep.packages) {
                for (const pkg of dep.packages) {
                    packageSet.add(pkg);
                }
            }
        }
        return Array.from(packageSet);
    }

    /**
     * 获取 venv 中 Python 可执行文件路径
     *
     * Windows: .venv/Scripts/python.exe
     * Unix: .venv/bin/python
     */
    private getPythonBin(): string {
        const isWindows = this.detectWindows();
        if (isWindows) {
            return `"${this.venvPath}/Scripts/python.exe"`;
        }
        return `"${this.venvPath}/bin/python"`;
    }

    /**
     * 获取 pip 命令
     *
     * 使用 `python -m pip` 而不是 pip.exe launcher，确保 pip 与 SSL 预检共用同一个
     * Python 解释器入口和 DLL 搜索环境。
     */
    private getPipCommand(): string {
        return `${this.getPythonBin()} -m pip`;
    }

    private getPipInstallTargetArgs(): string {
        if (!this.detectWindows()) {
            return '';
        }
        return `--prefix "${this.toWindowsPath(this.venvPath)}"`;
    }

    private getVenvScriptsDir(): string {
        const isWindows = this.detectWindows();
        if (isWindows) {
            return this.toWindowsPath(`${this.venvPath}/Scripts`);
        }
        return `${this.venvPath}/bin`;
    }

    private getParentDirectory(path: string): string | null {
        const normalized = path.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        const index = normalized.lastIndexOf('/');
        if (index <= 0) {
            return null;
        }
        return normalized.slice(0, index);
    }

    private toWindowsPath(path: string): string {
        return path.replace(/^["']|["']$/g, '').replace(/\//g, '\\');
    }

    /**
     * 检测是否为 Windows 平台
     *
     * 抽取为方法便于测试时 mock
     */
    private detectWindows(): boolean {
        if (typeof navigator !== 'undefined') {
            return navigator.userAgent.includes('Windows');
        }
        // Node 环境（测试）回退
        if (typeof process !== 'undefined') {
            return process.platform === 'win32';
        }
        return false;
    }
}
