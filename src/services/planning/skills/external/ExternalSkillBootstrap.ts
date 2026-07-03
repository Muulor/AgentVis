/**
 * ExternalSkillBootstrap - 外部技能启动集成
 *
 * 职责：
 * 1. 通过 Tauri IPC 适配文件 I/O 函数
 * 2. 实例化 ExternalSkillRegistryLoader 并扫描技能包
 * 3. 将加载结果注册到 SkillLoader
 * 4. 推送技能状态到 RuntimeStore
 * 5. 启动 SkillPackageWatcher 文件监听
 * 6. 提供 rescan / importFolder / installFromGitHub 等操作方法
 *
 * 设计约束：
 * - 幂等：内部 initialized flag 防止重复执行
 * - 懒加载：由 SkillLoader.loadAllSkills() 首次调用时触发
 * - 错误容忍：Tauri API 不可用或目录不存在时不阻断应用
 */

import { ExternalSkillRegistryLoader } from './ExternalSkillRegistry';
import type { FileReadFn, DirExistsFn, ListFilesFn } from './ExternalSkillRegistry';
import { skillLoader } from '../SkillLoader';
import { SkillPackageWatcher } from './SkillPackageWatcher';
import { useRuntimeStore } from '../../../../stores/runtimeStore';
import type { InstalledSkillInfo, PendingDependency } from '../../../../stores/runtimeStore';
import type { LoadedExternalSkill } from './types';
import { analyzeDependencies, parseBasePackageNames } from './DependencyAnalyzer';
import type { AnalyzedDependencies } from './DependencyAnalyzer';
import { inspectPythonVenvHermeticity } from './pythonRuntimeHermeticity';
import { createTauriShellExecute } from './tauriShellAdapter';
import { writeRuntimeReadyMarker } from './runtimeReadyMarker';
// 构建时嵌入 requirements 文件内容（与 requirementsProvider.ts 共用同一数据源）
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite ?raw 查询返回 string，TypeScript 无法推断模块类型
import requirementsContent from '../../../../../runtime-requirements-v1.txt?raw';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';

const logger = getLogger('ExternalSkillBootstrap');

// ==================== 常量 ====================

/** 外部技能包存放的相对路径（相对于 AppDataDir） */
const PACKAGES_RELATIVE_PATH = 'skills/external/packages';

/** venv 目录的相对路径（相对于 AppDataDir） */
const VENV_RELATIVE_PATH = 'runtime/python-v1/.venv';
const RUNTIME_RELATIVE_PATH = 'runtime/python-v1';

/**
 * 后台依赖安装的整体超时时间（毫秒）
 *
 * 用于防止 pip install 永久挂起导致后台任务泄漏。
 * 单批超时 300s × 最多 2 批 ≈ 600s，取整为 10 分钟作为安全上限。
 * 超时后恢复 envStatus 为 ready，通过 depInstallResultMessage 通知 UI。
 */
const BACKGROUND_INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

const RUNTIME_HEALTH_CHECK_MODULES = [
    'requests',
    'httpx',
    'curl_cffi',
    'pydantic',
    'bs4',
    'lxml',
    'pypdf',
    'pdf2image',
    'docx',
    'pptx',
    'openpyxl',
    'markdown',
    'yaml',
    'chardet',
    'dateutil',
    'tabulate',
    'jinja2',
    'dotenv',
    'matplotlib',
    'PIL',
    'plotly',
    'numpy',
    'pandas',
    'psutil',
    'tqdm',
    'pip_system_certs',
] as const;

// ==================== 状态 ====================

/** 初始化 Promise 锁（确保并发调用者都能等待扫描完成） */
let bootstrapPromise: Promise<void> | null = null;

/** 缓存的 packages 目录路径 */
let cachedPackagesDir: string | null = null;

/** 缓存的 IPC 适配函数 */
let cachedAdapters: {
    readFile: FileReadFn;
    dirExists: DirExistsFn;
    listFiles: ListFilesFn;
} | null = null;

/** FileWatcher 实例 */
let watcher: SkillPackageWatcher | null = null;

// ==================== Tauri IPC 适配 ====================

/**
 * 创建 Tauri IPC 文件读取适配器
 *
 * 将 @tauri-apps/plugin-fs 的 readTextFile 适配为 FileReadFn 类型
 */
async function createTauriReadFile(): Promise<FileReadFn> {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return async (path: string): Promise<string> => {
        return readTextFile(path);
    };
}

/**
 * 创建 Tauri IPC 目录存在检查适配器
 *
 * 将 @tauri-apps/plugin-fs 的 exists 适配为 DirExistsFn 类型
 */
async function createTauriDirExists(): Promise<DirExistsFn> {
    const { exists } = await import('@tauri-apps/plugin-fs');
    return async (path: string): Promise<boolean> => {
        return exists(path);
    };
}

/**
 * 创建 Tauri IPC 目录列举适配器
 *
 * 将 @tauri-apps/plugin-fs 的 readDir 适配为 ListFilesFn 类型
 * readDir 返回 DirEntry[]，提取其中的文件/目录名
 */
async function createTauriListFiles(): Promise<ListFilesFn> {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    return async (dirPath: string): Promise<string[]> => {
        const entries = await readDir(dirPath);
        return entries.map(entry => entry.name).filter((name): name is string => !!name);
    };
}

/**
 * 确保 IPC 适配函数和 packages 目录已初始化
 *
 * 复用缓存，避免重复 import
 */
async function ensureAdapters(): Promise<{
    packagesDir: string;
    readFile: FileReadFn;
    dirExists: DirExistsFn;
    listFiles: ListFilesFn;
} | null> {
    if (cachedPackagesDir && cachedAdapters) {
        return {
            packagesDir: cachedPackagesDir,
            ...cachedAdapters,
        };
    }

    try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        if (!appData) {
            logger.warn('[ExternalSkillBootstrap] appDataDir 不可用');
            return null;
        }

        cachedPackagesDir = await join(appData, PACKAGES_RELATIVE_PATH);

        const [readFile, dirExists, listFiles] = await Promise.all([
            createTauriReadFile(),
            createTauriDirExists(),
            createTauriListFiles(),
        ]);

        cachedAdapters = { readFile, dirExists, listFiles };

        return {
            packagesDir: cachedPackagesDir,
            ...cachedAdapters,
        };
    } catch (error) {
        logger.warn(
            '[ExternalSkillBootstrap] 初始化 IPC 适配失败:',
            error instanceof Error ? error.message : String(error)
        );
        return null;
    }
}

function detectWindowsRuntime(): boolean {
    if (typeof navigator !== 'undefined') {
        return navigator.userAgent.includes('Windows');
    }
    if (typeof process !== 'undefined') {
        return process.platform === 'win32';
    }
    return false;
}

function getVenvPythonCommand(venvPath: string): string {
    const normalizedPath = venvPath.replace(/\\/g, '/');
    const executablePath = detectWindowsRuntime()
        ? `${normalizedPath}/Scripts/python.exe`
        : `${normalizedPath}/bin/python`;
    return `"${executablePath}"`;
}

function getVenvScriptsDir(venvPath: string): string {
    const normalizedPath = venvPath.replace(/\\/g, '/');
    const scriptsPath = detectWindowsRuntime()
        ? `${normalizedPath}/Scripts`
        : `${normalizedPath}/bin`;
    return detectWindowsRuntime() ? scriptsPath.replace(/\//g, '\\') : scriptsPath;
}

function buildRuntimeHealthCheckCommand(venvPath: string): string {
    const modules = RUNTIME_HEALTH_CHECK_MODULES.map(moduleName => `'${moduleName}'`).join(',');
    const script = [
        'import ssl, importlib.util, sys',
        `modules=[${modules}]`,
        'missing=[m for m in modules if importlib.util.find_spec(m) is None]',
        "sys.exit('missing base packages: ' + ', '.join(missing)) if missing else print('ok')",
    ].join('; ');

    return `${getVenvPythonCommand(venvPath)} -c "${script}"`;
}

function combineShellOutput(stderr: string, stdout: string): string {
    return [stderr, stdout]
        .map(part => part.trim())
        .filter(Boolean)
        .join('\n');
}

async function validateExistingRuntime(venvPath: string): Promise<boolean> {
    try {
        await refreshPrebuiltRuntimeIfAvailable();

        const shellExecute = await createTauriShellExecute({
            sandboxLevel: 'installer',
            subjectType: 'installer',
            subjectId: 'python-runtime-health-check',
        });
        const result = await shellExecute({
            command: buildRuntimeHealthCheckCommand(venvPath),
            workdir: getVenvScriptsDir(venvPath),
            timeout: 30,
            background: false,
            env: {
                __AGENTVIS_VENV_SCRIPTS_DIR__: getVenvScriptsDir(venvPath),
                PYTHONUTF8: '1',
                PYTHONDONTWRITEBYTECODE: '1',
            },
        });

        if (result.exitCode === 0) {
            try {
                await writeRuntimeReadyMarker(venvPath, { source: 'health-check' });
            } catch (markerError) {
                logger.warn(
                    '[ExternalSkillBootstrap] runtime 健康检查通过，但写入就绪标记失败:',
                    markerError instanceof Error ? markerError.message : String(markerError)
                );
            }
            return true;
        }

        logger.warn(
            '[ExternalSkillBootstrap] runtime 健康检查失败:',
            combineShellOutput(result.stderr, result.stdout)
        );
        return false;
    } catch (error) {
        logger.warn(
            '[ExternalSkillBootstrap] runtime 健康检查异常:',
            error instanceof Error ? error.message : String(error)
        );
        return false;
    }
}

async function refreshPrebuiltRuntimeIfAvailable(): Promise<void> {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('prepare_prebuilt_python_runtime');
    } catch (error) {
        logger.debug(
            '[ExternalSkillBootstrap] 预置 Python runtime 刷新跳过:',
            error instanceof Error ? error.message : String(error)
        );
    }
}

async function isRuntimeUsable(venvPath: string): Promise<boolean> {
    // Ready marker only says a previous check passed. Always re-run the cheap import/SSL
    // check so a partially rebuilt runtime cannot be shown as ready after reopening settings.
    return validateExistingRuntime(venvPath);
}

/**
 * 检测 venv 物理状态并与 Store 协调
 *
 * 解决「应用启动时 envStatus 停留在 not_checked」的问题：
 * 迭代中新增的 Runtime 功能不会在非首次启动时自动检测 venv，
 * 导致 Onboarding Banner 无法显示。此函数在 bootstrap 流程中
 * 主动检测 venv 目录是否存在，推动状态流转。
 *
 * 独立导出：可由 SkillSettings 组件在挂载时调用，
 * 无需等待完整的 bootstrapExternalSkills 懒加载流程。
 */
export async function reconcileVenvState(): Promise<void> {
    try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const { exists } = await import('@tauri-apps/plugin-fs');

        const appData = await appDataDir();
        if (!appData) return;

        const venvPath = await join(appData, VENV_RELATIVE_PATH);
        const runtimeDir = await join(appData, RUNTIME_RELATIVE_PATH);
        const venvExists = await exists(venvPath);
        const hermeticity = venvExists
            ? await inspectPythonVenvHermeticity(runtimeDir, venvPath)
            : { status: 'unknown' as const, externalRoots: [] };
        const sandboxCompatible = hermeticity.status !== 'nonHermetic';
        const runtimeUsable = venvExists ? await isRuntimeUsable(venvPath) : false;

        const { reconcileWithPhysical, setVenvPath } = useRuntimeStore.getState();
        reconcileWithPhysical(runtimeUsable);

        // 只有 runtime 通过可用性检查后，才同步路径到 Store 供 SubAgentFactory 使用
        if (runtimeUsable) {
            setVenvPath(venvPath);
        } else {
            setVenvPath(null);
        }

        if (hermeticity.status === 'nonHermetic') {
            logger.warn(
                '[ExternalSkillBootstrap] venv 依赖沙箱外部 Python；默认本机审计模式可继续使用，离线隔离执行时会要求重建:',
                hermeticity.externalRoots.join(', ')
            );
        } else if (venvExists && !runtimeUsable) {
            logger.warn(
                '[ExternalSkillBootstrap] venv 存在但未通过 runtime 健康检查，已标记为需要重建'
            );
        }

        logger.debug(
            `[ExternalSkillBootstrap] venv 状态协调完成:`,
            `物理存在=${venvExists},`,
            `沙箱兼容=${sandboxCompatible},`,
            `runtime可用=${runtimeUsable},`,
            `envStatus=${useRuntimeStore.getState().envStatus}`
        );
    } catch (error) {
        // 检测失败不阻断启动
        logger.warn(
            '[ExternalSkillBootstrap] venv 状态检测失败:',
            error instanceof Error ? error.message : String(error)
        );
    }
}

// ==================== 内部工具 ====================

/**
 * 将 LoadedExternalSkill 转换为 InstalledSkillInfo（Store 使用）
 *
 * @param skill 加载的技能包
 * @param analyzed 静态分析结果（可选，包含 pip/npm/system 依赖）
 */
function toInstalledSkillInfo(
    skill: LoadedExternalSkill,
    analyzed?: AnalyzedDependencies,
    basePackageNames: Set<string> = new Set()
): InstalledSkillInfo {
    const explicitPackages = skill.dependencies?.packages ?? [];
    const installableExplicitPackages = filterRuntimeBasePackages(
        explicitPackages,
        basePackageNames
    );
    const hasDeps = installableExplicitPackages.length > 0;
    return {
        name: skill.name,
        description: skill.description,
        mode: skill.mode,
        enabled: skill.enabled,
        packagePath: skill.packagePath,
        // 无显式依赖声明 → satisfied；有声明 → 标记 unknown（需后续检测）
        dependencyStatus: hasDeps ? 'unknown' : 'satisfied',
        missingDependencies: [],
        npmDependencies: analyzed?.npmPackages ?? [],
        npmPostInstallCommands: analyzed?.npmPostInstallCommands ?? [],
        cargoDependencies: analyzed?.cargoPackages ?? [],
        goDependencies: analyzed?.goPackages ?? [],
        systemDependencies: analyzed?.systemTools ?? [],
    };
}

function getPythonPackageName(packageSpec: string): string {
    return packageSpec.trim().match(/^[A-Za-z0-9_.-]+/)?.[0].toLowerCase() ?? '';
}

function getPythonPackageIdentity(packageSpec: string): string {
    return getPythonPackageName(packageSpec).replace(/[-_.]+/g, '-');
}

interface FailedDependencyImpact {
    skillNames: string[];
    packageSpecs: string[];
}

export function summarizeFailedDependencyImpact(
    pendingDependencies: PendingDependency[],
    failedPackages: string[] | undefined
): FailedDependencyImpact {
    const failedIdentities = new Set(
        (failedPackages ?? [])
            .map(getPythonPackageIdentity)
            .filter(Boolean)
    );

    if (failedIdentities.size === 0) {
        return {
            skillNames: pendingDependencies.map(dep => dep.skillName),
            packageSpecs: [],
        };
    }

    const skillNames = new Set<string>();
    const packageSpecs = new Map<string, string>();
    for (const dep of pendingDependencies) {
        const matchedPackages = dep.packages.filter(pkg =>
            failedIdentities.has(getPythonPackageIdentity(pkg))
        );
        if (matchedPackages.length === 0) {
            continue;
        }
        skillNames.add(dep.skillName);
        for (const pkg of matchedPackages) {
            const identity = getPythonPackageIdentity(pkg);
            if (identity && !packageSpecs.has(identity)) {
                packageSpecs.set(identity, pkg);
            }
        }
    }

    return {
        skillNames: Array.from(skillNames),
        packageSpecs: packageSpecs.size > 0 ? Array.from(packageSpecs.values()) : failedPackages ?? [],
    };
}

export function filterRuntimeBasePackages(
    packages: string[],
    basePackageNames: Set<string>
): string[] {
    const basePackagesLower = new Set(
        Array.from(basePackageNames).map(pkg => pkg.toLowerCase())
    );
    return packages.filter(pkg => {
        const packageName = getPythonPackageName(pkg);
        return !packageName || !basePackagesLower.has(packageName);
    });
}

/**
 * 加载基础包名（从构建时嵌入的 runtime-requirements-v1.txt 解析）
 *
 * 使用 Vite ?raw import 获取文件内容，避免 resolveResource 在 dev 模式下
 * 解析到 target/debug/ 目录导致文件不存在。
 * 返回小写的包名集合，用于静态分析时去重（不重复安装基础包）。
 */
function loadBasePackageNames(): Set<string> {
    try {
        return parseBasePackageNames(requirementsContent);
    } catch (error) {
        logger.warn(
            '[ExternalSkillBootstrap] 解析基础包清单失败:',
            error instanceof Error ? error.message : String(error)
        );
        return new Set();
    }
}

/**
 * 读取技能包内脚本文件的内容
 *
 * 逐个读取 scripts/*.py 等脚本文件，失败时跳过单个文件。
 * 用于静态分析提取 import 语句。
 */
async function readSkillScriptContents(
    packagePath: string,
    scriptFiles: string[] | undefined,
    readFile: FileReadFn
): Promise<string[]> {
    if (!scriptFiles || scriptFiles.length === 0) return [];

    const contents: string[] = [];
    for (const relPath of scriptFiles) {
        // 只分析 Python 文件（其他语言的 import 语法不同）
        if (!relPath.endsWith('.py')) continue;

        try {
            const fullPath = `${packagePath}/${relPath}`.replace(/\\/g, '/');
            const content = await readFile(fullPath);
            contents.push(content);
        } catch {
            // 单个脚本文件读取失败不影响其他文件
            continue;
        }
    }
    return contents;
}

/**
 * 从 scriptFiles 列表中提取本地模块名集合
 *
 * 用于过滤静态分析时的本地模块互引，防止将同目录 .py 文件或子目录包名误识为 pip 包。
 *
 * 提取策略：
 * 1. 顶层 .py 文件名（去掉后缀）→ 如 `extract_form_field_info`
 * 2. 所有路径段中的目录名 → 如 `scripts`、`office`、`helpers`、`validators`
 *    脚本间的 import 可能引用任意层级的子目录（Python 包）
 * 3. 技能包名称（kebab-case 和 snake_case）→ 如 `desktop-control` → `desktop_control`
 *    技能包内的脚本可能 import 与包名同名的本地模块
 *
 * @param scriptFiles 相对于 packagePath 的脚本文件路径列表
 * @param packagePath 技能包根路径（用于提取技能包名称）
 * @returns 本地模块名集合
 */
function buildLocalModuleNames(
    scriptFiles: string[],
    packagePath: string
): Set<string> {
    const names = new Set<string>();

    for (const relPath of scriptFiles) {
        // 统一使用正斜杠
        const normalized = relPath.replace(/\\/g, '/');
        const parts = normalized.split('/');

        // 策略 1：.py 文件名 → 去掉后缀作为模块名
        const fileName = parts[parts.length - 1];
        if (fileName?.endsWith('.py')) {
            const moduleName = fileName.replace(/\.py$/, '');
            // __init__.py 不作为独立模块名
            if (moduleName !== '__init__') {
                names.add(moduleName);
            }
        }

        // 策略 2：路径中的每个目录名都可能被 import 引用
        // 例如 scripts/office/helpers/merge_runs.py → scripts, office, helpers 都可能被引用
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            if (dirName && dirName !== '.' && dirName !== '..') {
                names.add(dirName);
            }
        }
    }

    // 策略 3：技能包名本身也可能被 import（如 desktop-control → from desktop_control import ...）
    // 提取包目录名并添加 kebab-case 和 snake_case 两种形式
    const packageDirName = packagePath.replace(/\\/g, '/').split('/').pop();
    if (packageDirName) {
        names.add(packageDirName);  // 原始形式（如 desktop-control）
        // kebab-case → snake_case（Python import 不允许连字符，通常用下划线）
        const snakeCase = packageDirName.replace(/-/g, '_');
        if (snakeCase !== packageDirName) {
            names.add(snakeCase);  // 转换形式（如 desktop_control）
        }
    }

    return names;
}

/**
 * 执行扫描并注册技能
 *
 * 核心 scan + register 逻辑，被 bootstrapExternalSkills 和 rescan 复用
 */
async function scanAndRegister(): Promise<LoadedExternalSkill[]> {
    const ctx = await ensureAdapters();
    if (!ctx) return [];

    const { packagesDir, readFile, dirExists, listFiles } = ctx;

    // 检查目录是否存在
    const packagesDirExists = await dirExists(packagesDir);
    if (!packagesDirExists) {
        logger.debug(
            '[ExternalSkillBootstrap] packages 目录不存在:',
            packagesDir
        );
        return [];
    }

    // 扫描
    const loader = new ExternalSkillRegistryLoader(
        packagesDir,
        readFile,
        dirExists,
        listFiles
    );

    const result = await loader.scanAll();

    // 输出警告
    if (result.warnings.length > 0) {
        logger.warn(
            '[ExternalSkillBootstrap] 加载警告:',
            result.warnings
        );
    }

    // 清空旧缓存后重新注册（确保已删除的技能不残留）
    skillLoader.clearExternalSkills();
    for (const skill of result.skills) {
        skillLoader.registerExternal({
            name: skill.name,
            description: skill.description,
            category: 'external',
            complexity: 1,
            requiresAuth: false,
            fullContent: skill.fullContent,
            source: 'external',
            mode: skill.mode,
            contract: skill.contract,
            dependencies: skill.dependencies,
            agentvisNetwork: skill.agentvisNetwork,
            agentvisNetworkEntrypoints: skill.agentvisNetworkEntrypoints,
            packagePath: skill.packagePath,
            scriptFiles: skill.scriptFiles,
            resourceFiles: skill.resourceFiles,
        });
    }

    // 推送到 RuntimeStore
    const { setInstalledSkills, addPendingDependencies } = useRuntimeStore.getState();

    // 加载基础包名单（用于静态分析去重，同步操作不会失败）
    const basePackageNames = loadBasePackageNames();

    // 缓存每个技能的分析结果，供 toInstalledSkillInfo 使用
    const analysisMap = new Map<string, AnalyzedDependencies>();

    // 收集待安装 pip 依赖 + 非 pip 依赖分析
    for (const skill of result.skills) {
        if (skill.dependencies?.packages && skill.dependencies.packages.length > 0) {
            // 第 1 层：frontmatter 显式声明（优先级最高）
            const installablePackages = filterRuntimeBasePackages(
                skill.dependencies.packages,
                basePackageNames
            );
            if (installablePackages.length > 0) {
                addPendingDependencies({
                    skillName: skill.name,
                    packages: installablePackages,
                });
            }
            // 即使有显式声明，仍然分析 npm/system 依赖（frontmatter 只声明 pip 包）
            if (skill.fullContent) {
                const scriptContents = await readSkillScriptContents(
                    skill.packagePath,
                    skill.scriptFiles,
                    readFile
                );
                const localModuleNames = buildLocalModuleNames(
                    skill.scriptFiles ?? [],
                    skill.packagePath
                );
                const analyzed = analyzeDependencies(
                    skill.fullContent,
                    scriptContents,
                    basePackageNames,
                    localModuleNames
                );
                analysisMap.set(skill.name, analyzed);
            }
        } else if (skill.mode === 'guide' && skill.fullContent) {
            // 第 2 层：静态分析推断（fallback，仅对无显式声明的 Guide 技能）
            const scriptContents = await readSkillScriptContents(
                skill.packagePath,
                skill.scriptFiles,
                readFile
            );
            const localModuleNames = buildLocalModuleNames(
                skill.scriptFiles ?? [],
                skill.packagePath
            );
            const analyzed = analyzeDependencies(
                skill.fullContent,
                scriptContents,
                basePackageNames,
                localModuleNames
            );
            analysisMap.set(skill.name, analyzed);
            if (analyzed.packages.length > 0) {
                logger.debug(
                    `[ExternalSkillBootstrap] 静态分析推断 ${skill.name} 依赖:`,
                    analyzed.packages.join(', '),
                    `(来源: ${analyzed.sources.length} 条)`
                );
                addPendingDependencies({
                    skillName: skill.name,
                    packages: analyzed.packages,
                });
            }
        }

        // 记录非 pip 依赖检测结果
        const analyzed = analysisMap.get(skill.name);
        if (analyzed) {
            if (analyzed.npmPackages.length > 0) {
                logger.debug(
                    `[ExternalSkillBootstrap] ${skill.name} 需要 npm 包:`,
                    analyzed.npmPackages.join(', ')
                );
            }
            if (analyzed.cargoPackages.length > 0) {
                logger.debug(
                    `[ExternalSkillBootstrap] ${skill.name} 需要 cargo 包:`,
                    analyzed.cargoPackages.join(', ')
                );
            }
            if (analyzed.goPackages.length > 0) {
                logger.debug(
                    `[ExternalSkillBootstrap] ${skill.name} 需要 go 包:`,
                    analyzed.goPackages.join(', ')
                );
            }
            if (analyzed.systemTools.length > 0) {
                logger.debug(
                    `[ExternalSkillBootstrap] ${skill.name} 需要系统工具:`,
                    analyzed.systemTools.map(t => `${t.command} (${t.packageName})`).join(', ')
                );
            }
        }
    }

    // 构建 SkillInfo 时传入分析结果
    const skillInfos = result.skills.map(skill =>
        toInstalledSkillInfo(skill, analysisMap.get(skill.name), basePackageNames)
    );
    setInstalledSkills(skillInfos);

    return result.skills;
}

/**
 * 技能导入结果，包含依赖安装状态
 */
export interface SkillImportResult {
    /** 导入的技能名 */
    skillName: string;
    /** 依赖安装状态 */
    depStatus: 'installed' | 'partial' | 'skipped' | 'none';
    /** 安装的包数量 */
    installedCount: number;
    /** 失败的包数量 */
    failedCount: number;
}

/**
 * 在 venv 就绪时安装 store 中排队的待安装依赖
 *
 * 调用时机：
 * 1. rescanExternalSkills 完成后（导入/刷新技能后自动安装）
 * 2. bootstrapExternalSkills 完成后（首次启动，venv 已存在时）
 *
 * 前置条件：
 * - envStatus === 'ready' 或 'skipped'（venv 已存在且可用）
 * - pendingDependencies.length > 0（有待安装依赖）
 *
 * 失败处理：安装失败标记 extra_partial，不影响已有功能
 */
async function installPendingDependenciesIfReady(): Promise<SkillImportResult | null> {
    const { envStatus, pendingDependencies } = useRuntimeStore.getState();

    // 仅在 venv 可用（ready / skipped）且有待安装依赖时执行
    const isEnvUsable = envStatus === 'ready' || envStatus === 'skipped';
    if (!isEnvUsable || pendingDependencies.length === 0) {
        return null;
    }

    // 聚合所有待安装包名（去重）
    const allPackages = new Set<string>();
    for (const dep of pendingDependencies) {
        for (const pkg of dep.packages) {
            allPackages.add(pkg);
        }
    }

    if (allPackages.size === 0) return null;

    logger.debug(
        `[ExternalSkillBootstrap] 触发增量依赖安装:`,
        Array.from(allPackages).join(', ')
    );

    try {
        const { setEnvStatus, setInstallProgress, clearPendingDependencies } =
            useRuntimeStore.getState();

        setEnvStatus('installing_extra');
        setInstallProgress({ phase: translate('runtime.progress.installSkillExtraDeps'), percent: 80 });

        // 初始化 RuntimeManager
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        const runtimeDir = await join(appData, 'runtime/python-v1');

        const { createTauriShellExecute } = await import('./tauriShellAdapter');
        const shellExecute = await createTauriShellExecute({
            sandboxLevel: 'installer',
            subjectType: 'installer',
            subjectId: 'external-skill-extra-deps',
        });
        const { RuntimeManager } = await import('./RuntimeManager');
        const manager = new RuntimeManager(runtimeDir, shellExecute);

        // 构造 SkillDependencies 格式
        const skillDeps = pendingDependencies.map((dep) => ({
            packages: dep.packages,
        }));

        // 使用 ensureReady 增量安装（venv 已存在时会跳过创建，只安装额外依赖）
        const result = await manager.ensureReady(
            [], // 基础包不重复安装
            skillDeps,
            (progress) => {
                setInstallProgress(progress);
            }
        );

        // 提前收集技能名称，用于通知消息（在 clearPendingDependencies 清空前记录）
        const installedSkillNames = pendingDependencies.map(d => d.skillName).join(', ');

        if (result.status === 'ready') {
            logger.debug('[ExternalSkillBootstrap] 增量依赖安装成功');
            clearPendingDependencies();
            setEnvStatus('ready');
            setInstallProgress(null);

            // 写入后台安装结果，供 SkillSettings UI 展示（含技能来源名）
            useRuntimeStore.getState().setDepInstallResultMessage({
                type: 'success',
                text: installedSkillNames
                    ? `Dependencies for skill "${installedSkillNames}" installed successfully (${allPackages.size} packages)`
                    : `Dependencies installed successfully (${allPackages.size} packages)`,
            });
            return {
                skillName: installedSkillNames,
                depStatus: 'installed',
                installedCount: allPackages.size,
                failedCount: 0,
            };
        } else {
            const failedImpact = summarizeFailedDependencyImpact(pendingDependencies, result.failedPackages);
            const failedSkillNames = failedImpact.skillNames.join(', ');
            const failedPackageText = failedImpact.packageSpecs.join(', ');
            logger.warn(
                '[ExternalSkillBootstrap] 增量依赖安装部分失败:',
                failedSkillNames && failedPackageText
                    ? `${failedSkillNames}: ${failedPackageText}`
                    : result.error
            );
            if (result.error) {
                logger.debug('[ExternalSkillBootstrap] 增量依赖安装失败详情:', result.error);
            }
            clearPendingDependencies();
            setEnvStatus('ready');
            setInstallProgress(null);

            // 写入后台安装失败结果（含技能来源名），供 SkillSettings UI 展示
            useRuntimeStore.getState().setDepInstallResultMessage({
                type: 'error',
                text: failedSkillNames && failedPackageText
                    ? `Dependency installation failed for skill "${failedSkillNames}" (${failedPackageText}). Click "Refresh list" in Skill Settings to retry.`
                    : 'Some dependencies failed to install due to a network issue. Click "Refresh list" in Skill Settings to retry.',
            });
            const failedCount = result.failedPackages?.length ?? 0;
            return {
                skillName: failedSkillNames || installedSkillNames,
                depStatus: 'partial',
                installedCount: Math.max(0, allPackages.size - failedCount),
                failedCount,
            };
        }
    } catch (error) {
        logger.error(
            '[ExternalSkillBootstrap] 增量依赖安装异常:',
            error instanceof Error ? error.message : String(error)
        );
        // 安装失败不影响已有功能，恢复 ready 状态
        const { setEnvStatus, setInstallProgress, pendingDependencies: failedDeps } =
            useRuntimeStore.getState();
        setEnvStatus('ready');
        setInstallProgress(null);

        // 写入后台安装异常结果（含技能来源名），供 SkillSettings UI 展示
        const failedSkillNames = failedDeps.map(d => d.skillName).join(', ');
        useRuntimeStore.getState().setDepInstallResultMessage({
            type: 'error',
            text: failedSkillNames
                ? `Dependency installation for skill "${failedSkillNames}" failed due to a network issue. Click "Refresh list" in Skill Settings to retry.`
                : 'Dependency installation failed, possibly due to a network issue. Click "Refresh list" in Skill Settings to retry.',
        });
        return {
            skillName: failedSkillNames,
            depStatus: 'partial',
            installedCount: 0,
            failedCount: allPackages.size,
        };
    }
}

/**
 * 以后台 fire-and-forget 方式启动依赖安装
 *
 * 适用于所有自动/被动触发的安装路径：
 * - 应用启动时 bootstrapExternalSkills 触发
 * - 用户点击「刷新列表」触发的 rescanExternalSkills
 * - SkillPackageWatcher 文件变化触发的 rescanExternalSkills
 *
 * 设计理由：
 * pip install 可能因网络原因长时间运行（单批最长 300s × 批次数），
 * 若在 bootstrapExternalSkills Promise 锁内 await，会导致 Planning 模式
 * 的启动路径（SkillLoader.loadAllSkills → externalSkillsInitOnce）整体挂起。
 * 通过 fire-and-forget 解耦后：
 * 1. 技能扫描注册完成即解锁 Planning 模式，安装并行进行
 * 2. Agent 运行缺依赖会自行反映，用户清楚知道原因
 * 3. 安装结果通过 depInstallResultMessage 精确通知（含来源技能名）
 * 4. 整体 10 分钟超时兜底，防止 pip 进程永久挂起
 */
function launchBackgroundInstall(): void {
    // 超时兜底：防止 pip 永久挂起导致 envStatus 卡在 installing_extra
    const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => {
            logger.warn('[ExternalSkillBootstrap] 后台依赖安装超时（已等待 10 分钟），自动放弃');
            const { envStatus, pendingDependencies: timedOutDeps, setEnvStatus, setInstallProgress } =
                useRuntimeStore.getState();
            // 仅在安装中间状态时恢复，避免干扰用户主动触发的其他安装流程
            if (envStatus === 'installing_extra') {
                const skillNames = timedOutDeps.map(d => d.skillName).join(', ');
                setEnvStatus('ready');
                setInstallProgress(null);
                useRuntimeStore.getState().setDepInstallResultMessage({
                    type: 'error',
                    text: skillNames
                        ? `Dependency installation for skill "${skillNames}" timed out. Click "Refresh list" in Skill Settings to retry.`
                        : 'Skill dependency installation timed out. Click "Refresh list" in Skill Settings to retry.',
                });
            }
            resolve(null);
        }, BACKGROUND_INSTALL_TIMEOUT_MS)
    );

    // fire-and-forget：主动丢弃 Promise，不向调用栈传播异常
    Promise.race([
        installPendingDependenciesIfReady(),
        timeoutPromise,
    ]).catch((error: unknown) => {
        // installPendingDependenciesIfReady 内部已有完整 try-catch，此处为额外安全网
        logger.error('[ExternalSkillBootstrap] 后台依赖安装意外异常（已在函数内处理）:', error);
        const { setEnvStatus, setInstallProgress } = useRuntimeStore.getState();
        setEnvStatus('ready');
        setInstallProgress(null);
    });
}

// ==================== 公开 API ====================

/**
 * 启动外部技能加载
 *
 * 流程：
 * 1. 获取 AppDataDir
 * 2. 扫描并加载所有技能包
 * 3. 注册到 SkillLoader + 推送到 RuntimeStore
 * 4. 启动 SkillPackageWatcher 文件监听
 *
 * 幂等：多次调用只执行一次
 */
export function bootstrapExternalSkills(): Promise<void> {
    // Promise 锁：并发调用者都会 await 同一 Promise，确保扫描完成后才返回
    // 原来使用布尔标志 initialized 有竞态：在 await scanAndRegister() 前就设 true，
    // 导致第二个调用者直接 return 但扫描尚未完成
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {

        try {
            const skills = await scanAndRegister();

            // 启动 FileWatcher（如果有 packages 目录）
            if (cachedPackagesDir) {
                watcher = new SkillPackageWatcher(cachedPackagesDir, rescanExternalSkills);
                // 异步启动，不阻断主流程
                watcher.start().catch((error: unknown) => {
                    logger.warn(
                        '[ExternalSkillBootstrap] FileWatcher 启动失败:',
                        error instanceof Error ? error.message : String(error)
                    );
                });
            }

            // 检测 venv 物理状态，推动 not_checked → not_created 或 ready
            await reconcileVenvState();

            // 如果 venv 已就绪且有待安装依赖，在后台异步安装（不 await）
            // 解耦原因：bootstrapPromise 被 SkillLoader.loadAllSkills() 层层 await，
            // 若在此处同步等待 pip install，Planning 模式启动路径将整体挂起。
            // 安装结果通过 runtimeStore.depInstallResultMessage 异步推送到 SkillSettings UI。
            launchBackgroundInstall();

            logger.debug(
                `[ExternalSkillBootstrap] 外部技能初始化完成:` +
                ` ${skills.length} 个技能已注册`
            );
        } catch (error) {
            // Tauri API 不可用或其他意外错误，不阻断应用启动
            logger.warn(
                '[ExternalSkillBootstrap] 外部技能初始化失败（Planning 模式将仅使用 Native Skill）:',
                error instanceof Error ? error.message : String(error)
            );
        }
    })();

    return bootstrapPromise;
}

/**
 * 重新扫描外部技能包
 *
 * 由 FileWatcher 或 UI 手动触发，重新扫描 packages/ 目录，
 * 更新 SkillLoader 和 RuntimeStore。
 */
export async function rescanExternalSkills(): Promise<void> {
    try {
        logger.debug('[ExternalSkillBootstrap] 触发 rescan...');
        const skills = await scanAndRegister();
        logger.debug(
            `[ExternalSkillBootstrap] rescan 完成: ${skills.length} 个技能`
        );

        // 依赖安装在后台异步进行（不 await），不阻塞 rescan 的调用方
        // 安装结果通过 runtimeStore.depInstallResultMessage 异步推送到 SkillSettings UI
        launchBackgroundInstall();
    } catch (error) {
        logger.error(
            '[ExternalSkillBootstrap] rescan 失败:',
            error instanceof Error ? error.message : String(error)
        );
    }
}

/**
 * 导入技能包文件夹
 *
 * 将用户选择的文件夹复制到 packages/ 目录，然后触发 rescan。
 * 使用 Tauri shell 的 xcopy/cp 命令执行跨目录复制。
 *
 * @param sourcePath 源文件夹绝对路径
 * @returns 导入的技能名（文件夹名）
 */
export async function copySkillPackageToPackagesDir(sourcePath: string): Promise<{
    destPath: string;
    skillName: string;
}> {
    const ctx = await ensureAdapters();
    if (!ctx) {
        throw new Error('Tauri IPC is unavailable, so the skill package cannot be imported');
    }

    const { packagesDir } = ctx;

    // 提取文件夹名作为技能名
    const skillName = sourcePath.split(/[/\\]/).filter(Boolean).pop();
    if (!skillName) {
        throw new Error('Unable to extract the folder name from the path');
    }

    // 检查是否已存在
    const { join } = await import('@tauri-apps/api/path');
    const destPath = await join(packagesDir, skillName);
    if (await ctx.dirExists(destPath)) {
        throw new Error(`Skill package '${skillName}' already exists`);
    }

    // 确保 packages 目录存在
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    await mkdir(packagesDir, { recursive: true });

    // 使用 shell 命令复制目录（跨平台）
    const { invoke } = await import('@tauri-apps/api/core');
    const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

    // 使用 shell_execute 命令执行复制
    const copyCommand = isWindows
        ? `xcopy "${sourcePath}" "${destPath}\\" /E /I /Q`
        : `cp -r "${sourcePath}" "${destPath}"`;

    const result = await invoke<{ exitCode: number; stdout: string; stderr: string }>(
        'shell_execute',
        {
            command: copyCommand,
            workdir: null,
            timeoutSecs: 30,
            background: false,
            subjectType: 'installer',
            subjectId: 'external-skill-copy',
        }
    );

    if (result.exitCode !== 0) {
        throw new Error(`Failed to copy folder: ${result.stderr}`);
    }

    return { destPath, skillName };
}

/**
 * 删除技能包目录（审查拒绝后清理）
 *
 * @param packagePath 技能包绝对路径
 */
export async function removeSkillPackage(packagePath: string): Promise<void> {
    try {
        const { exists, remove } = await import('@tauri-apps/plugin-fs');
        if (await exists(packagePath)) {
            await remove(packagePath, { recursive: true });
        }

        logger.debug(`[ExternalSkillBootstrap] 已删除技能包: ${packagePath}`);
    } catch (error) {
        logger.error(
            '[ExternalSkillBootstrap] 删除技能包失败:',
            error instanceof Error ? error.message : String(error)
        );
        throw error;
    }
}

/**
 * 卸载指定技能包
 *
 * 完整流程：
 * 1. 删除磁盘上的技能包目录
 * 2. 清空并重新扫描/注册所有技能（确保 SkillLoader 和 Store 一致）
 *
 * @param packagePath 技能包的绝对路径
 * @param skillName 技能名称（用于日志）
 */
export async function uninstallSkill(packagePath: string, skillName: string): Promise<void> {
    // 步骤 1：删除物理文件
    await removeSkillPackage(packagePath);

    // 步骤 2：重新扫描并注册（scanAndRegister 内含 clearExternalSkills + 重新注册）
    await scanAndRegister();

    logger.debug(`[ExternalSkillBootstrap] 技能 "${skillName}" 已卸载`);
}

/**
 * 导入技能包文件夹（向后兼容，包含复制 + rescan）
 *
 * 注意：此函数不包含安全审查步骤。新流程应使用
 * copySkillPackageToPackagesDir → audit → rescanExternalSkills 三阶段。
 *
 * @param sourcePath 源文件夹绝对路径
 * @returns 导入结果
 */
export async function importSkillFolder(sourcePath: string): Promise<SkillImportResult> {
    const { skillName } = await copySkillPackageToPackagesDir(sourcePath);

    // 触发 rescan（依赖安装已改为后台异步进行）
    await rescanExternalSkills();

    // rescan 立即返回，依赖安装结果通过 depInstallResultMessage 异步推送，
    // 此处返回固定格式以保持向后兼容（depStatus: 'none' 表示安装进行中）
    return {
        skillName,
        depStatus: 'none' as const,
        installedCount: 0,
        failedCount: 0,
    };
}

/**
 * 获取 packages 目录路径
 *
 * 供 SkillSettings UI 使用，显示路径信息
 */
export async function getPackagesDir(): Promise<string | null> {
    const ctx = await ensureAdapters();
    return ctx?.packagesDir ?? null;
}

/**
 * 停止 FileWatcher
 *
 * 应用关闭时调用，清理资源
 */
export function stopWatcher(): void {
    if (watcher) {
        watcher.stop();
        watcher = null;
    }
}

/**
 * 重置初始化状态（仅用于测试）
 */
export function resetBootstrapState(): void {
    bootstrapPromise = null;
    cachedPackagesDir = null;
    cachedAdapters = null;
    stopWatcher();
}
