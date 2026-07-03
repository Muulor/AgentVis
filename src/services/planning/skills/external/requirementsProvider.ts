/**
 * requirementsProvider - Runtime 基础依赖清单管理和环境安装共享逻辑
 *
 * 职责：
 * 1. 通过 Vite raw import 嵌入 runtime-requirements-v1.txt 内容
 * 2. 运行时将内容写入 AppData 目录供 pip install -r 使用
 * 3. 提供共享的环境安装函数，供 RuntimeOnboardingBanner 和 SkillSettings 复用
 *
 * 设计决策：
 * - 为什么不用 Tauri bundle resources：当前阶段开发迭代快，Vite raw import 更灵活
 * - 为什么写入文件而非传参：pip install -r 需要文件路径，无法直接接受 stdin
 * - writeTextFile 需要 Tauri capability fs:allow-write-text-file（不同于 fs:allow-write-file）
 */

import { useRuntimeStore } from '../../../../stores/runtimeStore';
// 构建时嵌入 requirements 文件内容
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite ?raw 查询返回 string，TypeScript 无法推断模块类型
import requirementsContent from '../../../../../runtime-requirements-v1.txt?raw';
import { getLogger } from '@services/logger';
import { translate } from '@/i18n';
import { writeRuntimeReadyMarker } from './runtimeReadyMarker';

const logger = getLogger('requirementsProvider');

// ==================== 常量 ====================

/** requirements 文件在 AppData 中的文件名 */
const REQUIREMENTS_FILENAME = 'runtime-requirements-v1.txt';

/** runtime 目录相对于 AppDataDir 的路径 */
const RUNTIME_RELATIVE_PATH = 'runtime/python-v1';

// ==================== 工具函数 ====================

/**
 * 从 Tauri 错误中提取可读的错误信息
 *
 * Tauri v2 插件/invoke 错误通常抛出字符串而非 Error 实例，
 * 直接用 `error instanceof Error` 会丢失原始错误信息。
 */
function extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    // Tauri 某些错误是带 message 属性的对象
    if (error !== null && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

/**
 * 直接删除应用内部维护目录，不经过 shell_execute。
 *
 * 这些目录是 AgentVis 自身的 runtime/cache 产物，删除行为不代表 Agent 操作；
 * 直接走 fs.remove 可避免污染 Agent Trash Bin 的用户语义。
 */
async function removeInternalDirectory(path: string): Promise<void> {
    const { exists, remove } = await import('@tauri-apps/plugin-fs');
    if (await exists(path)) {
        await remove(path, { recursive: true });
    }
}

// ==================== Requirements 解析 ====================

/**
 * 从嵌入的 requirements 内容中解析出基础包列表
 *
 * 过滤注释行（# 开头）和空行，只返回包声明行。
 * 此函数为纯同步操作，不涉及 I/O。
 *
 * @returns 包声明数组，如 ['requests==2.34.2', 'pdfminer.six>=20231228']
 */
function parseBasePackages(): string[] {
    return (requirementsContent)
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !line.startsWith('#'));
}

// ==================== Requirements 文件管理 ====================

/**
 * 确保 requirements 文件存在于 AppData 目录
 *
 * 将构建时嵌入的 requirements 内容写入 AppData 目录，
 * 每次调用都会覆盖写入以确保内容最新。
 *
 * 注意：写入前会过滤注释行和空行，只保留包声明行。
 * 原因：源文件包含 UTF-8 注释（如中文和 box-drawing 字符），
 * 但 Anaconda 等 Python 发行版默认以 cp1252 编码读取，导致 UnicodeDecodeError。
 *
 * @returns requirements 文件的绝对路径
 */
export async function ensureRequirementsFile(): Promise<string> {
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');

    const appData = await appDataDir();
    if (!appData) {
        throw new Error('AppDataDir is unavailable');
    }

    // 确保目录存在
    await mkdir(appData, { recursive: true });

    const reqPath = await join(appData, REQUIREMENTS_FILENAME);

    // 过滤掉注释行（# 开头）和空行，只保留包声明行
    // 避免 UTF-8 注释在 cp1252 默认编码的 Python 环境下引发 UnicodeDecodeError
    const packageLines = (requirementsContent)
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !line.startsWith('#'));

    const cleanContent = packageLines.join('\n') + '\n';

    logger.trace('[requirementsProvider] 正在写入 requirements 文件:', reqPath,
        `(${packageLines.length} 个包声明)`);

    // 覆盖写入，确保内容与构建版本一致
    // 需要 Tauri capability: fs:allow-write-text-file
    await writeTextFile(reqPath, cleanContent);

    logger.trace('[requirementsProvider] requirements 文件写入成功:', reqPath);
    return reqPath;
}

// ==================== 共享安装流程 ====================

/**
 * 执行完整的环境安装流程
 *
 * 流程：
 * 1. 确保 requirements 文件就绪
 * 2. 确保 runtime 目录存在
 * 3. 创建 RuntimeManager 并执行 ensureReady
 * 4. 同步结果到 RuntimeStore
 *
 * 供 RuntimeOnboardingBanner 和 SkillSettings 复用。
 */
export async function performEnvironmentSetup(): Promise<void> {
    const {
        setEnvStatus,
        setInstallProgress,
        setPythonInfo,
        setVenvPath,
        setError,
        clearError,
        setActiveInstall,
    } = useRuntimeStore.getState();
    const previousRuntimeState = useRuntimeStore.getState();
    const shouldCleanupPreviousVenv =
        previousRuntimeState.errorMessage !== null ||
        previousRuntimeState.envStatus === 'error';

    try {
        // 标记当前会话有活跃安装，防止 reconcileWithPhysical 误重置状态
        setActiveInstall(true);
        setEnvStatus('creating');
        setInstallProgress({ phase: translate('runtime.progress.prepareInstall'), percent: 2 });

        // 提前导入公共依赖，供后续各步骤使用
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const { mkdir } = await import('@tauri-apps/plugin-fs');
        const appData = await appDataDir();

        // Step 0: 如果从失败状态重试，先删除残留的不完整 runtime。
        // not_created 只表示 Store 认为需要初始化，可能仍有可复用的预置 runtime；
        // 交由 RuntimeManager 的签名/健康检查决定是否需要重新解压，避免技能包变动后误删整套环境。
        if (shouldCleanupPreviousVenv) {
            logger.trace('[requirementsProvider] 检测到残留错误状态，清理旧 runtime');
            try {
                const runtimePath = await join(appData, RUNTIME_RELATIVE_PATH);
                await removeInternalDirectory(runtimePath);
                logger.trace('[requirementsProvider] 残留 runtime 已清理');
            } catch (cleanupErr) {
                // 清理失败不阻断流程，ensureReady 可能仍然能正常工作
                logger.warn('[requirementsProvider] 清理残留 runtime 失败:', extractErrorMessage(cleanupErr));
            }
        }

        // Step 1: 解析基础包列表
        logger.trace('[requirementsProvider] Step 1: 解析 requirements 内容');
        const basePackages = parseBasePackages();
        logger.trace(`[requirementsProvider] 解析到 ${basePackages.length} 个基础包`);

        // Step 2: 确保 runtime 目录存在
        logger.trace('[requirementsProvider] Step 2: 创建 runtime 目录');
        const runtimeDir = await join(appData, RUNTIME_RELATIVE_PATH);
        await mkdir(runtimeDir, { recursive: true });

        // Step 3: 初始化 shell 和 manager
        logger.trace('[requirementsProvider] Step 3: 初始化 RuntimeManager');
        setInstallProgress({ phase: translate('runtime.progress.checkPython'), percent: 5 });
        const { createTauriShellExecute } = await import('./tauriShellAdapter');
        const shellExecute = await createTauriShellExecute({
            sandboxLevel: 'installer',
            subjectType: 'installer',
            subjectId: 'python-runtime-setup',
        });

        const { RuntimeManager } = await import('./RuntimeManager');
        const manager = new RuntimeManager(runtimeDir, shellExecute);

        // Step 4: 执行完整的 ensureReady（解压/校验预置基础 runtime + 增量安装额外依赖）
        logger.trace('[requirementsProvider] Step 4: 执行 ensureReady');

        // 从 store 读取待安装的额外依赖（由静态分析或 frontmatter 声明注入）
        const { pendingDependencies, clearPendingDependencies } = useRuntimeStore.getState();
        const extraDeps = pendingDependencies.map((dep) => ({
            packages: dep.packages,
        }));
        if (extraDeps.length > 0) {
            logger.trace(
                `[requirementsProvider] 将安装 ${extraDeps.length} 个技能的额外依赖`
            );
        }

        const result = await manager.ensureReady(
            basePackages,
            extraDeps,
            (progress) => {
                setInstallProgress(progress);
                // 同步环境状态到 Store
                const phaseLower = progress.phase.toLowerCase();
                if (progress.phase.includes('额外依赖') || phaseLower.includes('extra dependencies')) {
                    setEnvStatus('installing_extra');
                } else if (
                    progress.phase.includes('预置 Python 环境') ||
                    phaseLower.includes('packaged python environment') ||
                    progress.phase.includes('虚拟环境') ||
                    phaseLower.includes('virtual environment')
                ) {
                    setEnvStatus('creating');
                } else if (
                    progress.phase.includes('预置基础依赖') ||
                    phaseLower.includes('packaged base dependencies') ||
                    progress.phase.includes('安装') ||
                    phaseLower.includes('installing')
                ) {
                    // 匹配逐包安装进度（如"安装 requests (1/15)"）和"安装基础依赖"
                    setEnvStatus('installing_base');
                }
            }
        );

        // Step 5: 同步结果
        if (result.status === 'ready') {
            logger.trace('[requirementsProvider] 环境安装成功');
            try {
                await writeRuntimeReadyMarker(result.venvPath, {
                    pythonVersion: result.pythonVersion,
                    source: 'fresh-install',
                });
            } catch (markerError) {
                logger.warn(
                    '[requirementsProvider] 写入 runtime 就绪标记失败:',
                    extractErrorMessage(markerError)
                );
            }
            clearError();
            clearPendingDependencies();
            setEnvStatus('ready');
            setInstallProgress(null);
            if (result.pythonVersion) {
                setPythonInfo(result.pythonVersion, '');
            }
            setVenvPath(result.venvPath);
            setActiveInstall(false);
        } else {
            const errorMsg = result.error ?? 'Environment installation failed';
            logger.error('[requirementsProvider] 环境安装失败:', errorMsg);
            setError(errorMsg);
            setActiveInstall(false);
        }
    } catch (error) {
        // 提取 Tauri 插件/invoke 的真实错误信息（可能是字符串而非 Error 实例）
        const errorMsg = extractErrorMessage(error);
        logger.error('[requirementsProvider] 安装过程异常:', errorMsg);
        setError(errorMsg);
        setActiveInstall(false);
    }
}

/**
 * 执行环境重建流程
 *
 * 流程：
 * 1. 删除现有 runtime 目录
 * 2. 自动触发完整的 performEnvironmentSetup
 *
 * @throws 删除失败时不中断，继续尝试重新创建
 */
export async function performEnvironmentRebuild(): Promise<void> {
    const { setEnvStatus, setInstallProgress } = useRuntimeStore.getState();

    setEnvStatus('creating');
    setInstallProgress({ phase: translate('runtime.progress.removeOldEnvironment'), percent: 1 });

    try {
        // 删除现有 runtime
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        const runtimePath = await join(appData, RUNTIME_RELATIVE_PATH);

        await removeInternalDirectory(runtimePath);
        logger.trace('[requirementsProvider] 旧 runtime 已删除');
    } catch (deleteError) {
        // 删除失败不中断流程，ensureReady 会检测 runtime 是否存在并决定是否重建
        logger.warn(
            '[requirementsProvider] 删除旧 runtime 失败（将尝试覆盖创建）:',
            extractErrorMessage(deleteError)
        );
    }

    // 触发完整的安装流程
    await performEnvironmentSetup();
}
