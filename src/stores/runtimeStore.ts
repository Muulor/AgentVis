/**
 * runtimeStore - Python Runtime 环境状态管理
 *
 * 管理外部技能包系统的 Runtime 环境状态，包括：
 * - Python 虚拟环境（venv）生命周期
 * - 已安装技能列表
 * - 待安装依赖队列
 * - 安装进度追踪
 * - 技能包安全审查状态
 *
 * 设计原则：
 * - Zustand persist 持久化 UI 状态到 localStorage
 * - 启动时物理检测 venv 作为 ground truth（reconcile）
 * - 单一职责：只管 Runtime 相关状态，不管 Planning 逻辑
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getLogger } from '@services/logger';
import type { SkillAuditResult, AuditProgress } from '@services/planning/skills/external/SkillAuditService';
import type { SkillEnabledOverrides } from '@services/planning/skills/external/skillPreferencesService';

const logger = getLogger('runtimeStore');

/** 技能包安全审查状态 */
export type SkillAuditStatus =
    | 'idle'              // 未审查
    | 'preparing'         // 正在准备待审查的技能包
    | 'auditing'          // 审查中
    | 'approved'          // 通过
    | 'rejected'          // 拒绝
    | 'manual_review'     // 需要人工审查
    | 'error';            // 审查服务异常

// ==================== 类型定义 ====================

/** Runtime 环境状态 */
export type RuntimeEnvStatus =
    | 'not_checked'       // 尚未检查（应用刚启动）
    | 'not_created'       // venv 不存在
    | 'creating'          // 正在创建 venv
    | 'installing_base'   // 正在安装基础包
    | 'installing_extra'  // 正在安装增量依赖
    | 'ready'             // 环境就绪
    | 'error'             // 出错
    | 'skipped';          // 用户跳过安装

/** 已安装技能信息 */
export interface InstalledSkillInfo {
    /** 技能名称 */
    name: string;
    /** 技能描述 */
    description: string;
    /** 运行模式 */
    mode: 'guide' | 'script';
    /** 是否启用 */
    enabled: boolean;
    /** 技能包的绝对路径（用于删除操作） */
    packagePath: string;
    /** 依赖状态 */
    dependencyStatus: 'satisfied' | 'pending' | 'unknown';
    /** 缺失依赖列表（pip） */
    missingDependencies: string[];
    /** 需手动安装的 npm 包 */
    npmDependencies: string[];
    /** npm 包安装后需执行的后置命令（如 agent-browser install） */
    npmPostInstallCommands: Array<{ npmPackage: string; command: string }>;
    /** 需手动安装的 cargo 包（Rust CLI 工具） */
    cargoDependencies: string[];
    /** 需手动安装的 go 包（Go CLI 工具） */
    goDependencies: string[];
    /** 需手动安装的系统工具（含安装指令） */
    systemDependencies: Array<{
        command: string;
        packageName: string;
        windowsInstall: string;
        macInstall: string;
        linuxInstall: string;
    }>;
}

/** 待安装依赖 */
export interface PendingDependency {
    /** 来源技能名 */
    skillName: string;
    /** 待安装包列表 */
    packages: string[];
}

/** 安装进度 */
export interface InstallProgress {
    /** 阶段描述 */
    phase: string;
    /** 进度百分比 (0-100) */
    percent: number;
}

/** GitHub 安装状态 */
export type GitHubInstallStatus = 'idle' | 'downloading' | 'extracting' | 'done' | 'error';

/** 非 pip 依赖的安装状态 */
export type ToolInstallStatus = 'idle' | 'checking' | 'installing' | 'installed' | 'error';

/** 单个工具的安装状态条目 */
export interface ToolInstallEntry {
    status: ToolInstallStatus;
    /** 错误/成功消息 */
    message: string;
    /** 是否为网络错误（可重试） */
    isNetworkError: boolean;
}

// ==================== Store 状态接口 ====================

/** RuntimeStore 状态 */
interface RuntimeStoreState {
    // === 环境状态 ===
    /** 环境当前状态 */
    envStatus: RuntimeEnvStatus;
    /** Python 版本号 */
    pythonVersion: string | null;
    /** Python 可执行文件路径 */
    pythonPath: string | null;
    /** venv 路径 */
    venvPath: string | null;
    /** 错误信息 */
    errorMessage: string | null;

    // === 技能管理 ===
    /** 已安装技能列表 */
    installedSkills: InstalledSkillInfo[];
    /** 待安装依赖 */
    pendingDependencies: PendingDependency[];

    // === 技能开关偏好（持久化） ===
    /**
     * 用户对外部技能的启用/禁用覆盖
     *
     * key 为技能名称，value 为是否启用。
     * 不存在于 Map 中的技能默认启用（新安装的技能默认开启）。
     * 独立于 installedSkills 持久化，因为 installedSkills 每次启动由 scanAndRegister 重建。
     */
    skillEnabledOverrides: Record<string, boolean>;

    // === 安装进度 ===
    /** 环境安装进度 */
    installProgress: InstallProgress | null;
    /** GitHub 安装状态 */
    githubInstallStatus: GitHubInstallStatus;
    /** GitHub 安装错误信息 */
    githubInstallError: string | null;

    // === 后台安装结果（不持久化） ===
    /**
     * 后台依赖安装结果消息
     *
     * 启动时 bootstrapExternalSkills 自动安装完成后的结果，
     * 供 SkillSettings UI 读取展示。显示后由 UI 清除。
     */
    depInstallResultMessage: { type: 'success' | 'error'; text: string } | null;

    // === 内部标志（不持久化） ===
    /**
     * 当前会话是否有活跃的安装进程
     *
     * 用于区分「冷启动恢复的过期中间状态」和「当前正在执行的安装」。
     * 不持久化：重启后默认 false，reconcileWithPhysical 据此决定是否重置。
     */
    _isActiveInstall: boolean;

    // === 非 pip 依赖安装状态（不持久化） ===
    /**
     * 各工具/npm 包的安装状态
     *
     * key 格式: "npm:<packageName>" 或 "sys:<commandName>"
     * 每次启动重置，不持久化
     */
    toolInstallStatuses: Record<string, ToolInstallEntry>;

    // === npm 后置初始化命令（持久化） ===
    /**
     * 已由用户成功执行过的 npm 后置初始化命令
     *
     * key 格式: "post-npm:<command>"。不同于 toolInstallStatuses，这类命令
     * 通常没有稳定的探测命令，需在重启后保留“用户已完成过初始化”的 UI 状态。
     */
    completedPostInstallCommands: Record<string, boolean>;

    // === 技能包安全审查状态（不持久化） ===
    /** 当前审查状态 */
    skillAuditStatus: SkillAuditStatus;
    /** 审查结果（审查完成后填充） */
    skillAuditResult: SkillAuditResult | null;
    /** 审查错误信息 */
    skillAuditError: string | null;
    /** 正在审查的技能包路径 */
    skillAuditPackagePath: string | null;
    /** 审查进度信息（实时文件扫描进度） */
    skillAuditProgress: AuditProgress | null;
    /** 审查窗口是否已收起到技能页状态条 */
    skillAuditMinimized: boolean;
}

/** RuntimeStore 操作 */
interface RuntimeStoreActions {
    // === 环境状态管理 ===
    /** 设置环境状态 */
    setEnvStatus: (status: RuntimeEnvStatus) => void;
    /** 设置 Python 信息 */
    setPythonInfo: (version: string, path: string) => void;
    /** 设置 venv 路径 */
    setVenvPath: (path: string | null) => void;
    /** 设置错误 */
    setError: (message: string) => void;
    /** 清除错误 */
    clearError: () => void;
    /** 标记为已跳过 */
    markSkipped: () => void;
    /** 标记/取消活跃安装（当前会话内） */
    setActiveInstall: (active: boolean) => void;

    // === 技能管理 ===
    /** 更新已安装技能列表 */
    setInstalledSkills: (skills: InstalledSkillInfo[]) => void;
    /** 初始化技能开关偏好（从 AppData 文件加载） */
    initSkillPreferences: () => Promise<void>;
    /** 切换外部技能的启用/禁用状态 */
    toggleSkillEnabled: (skillName: string) => void;
    /** 添加待安装依赖 */
    addPendingDependencies: (dep: PendingDependency) => void;
    /** 移除待安装依赖（安装完成后） */
    removePendingDependencies: (skillName: string) => void;
    /** 清除所有待安装依赖 */
    clearPendingDependencies: () => void;

    // === 安装进度 ===
    /** 更新安装进度 */
    setInstallProgress: (progress: InstallProgress | null) => void;
    /** 设置 GitHub 安装状态 */
    setGitHubInstallStatus: (status: GitHubInstallStatus) => void;
    /** 设置 GitHub 安装错误 */
    setGitHubInstallError: (error: string | null) => void;
    /** 设置后台依赖安装结果消息 */
    setDepInstallResultMessage: (msg: { type: 'success' | 'error'; text: string } | null) => void;

    // === Reconcile ===
    /**
     * 协调持久化状态与已验证的 runtime 状态
     *
     * 应用启动时调用：检测 venv 是否存在且可用。
     * 如果 localStorage 标记 ready 但 runtime 不可用，重置为 not_created。
     */
    reconcileWithPhysical: (runtimeUsable: boolean) => void;

    // === 非 pip 依赖安装 ===
    /** 更新单个工具的安装状态 */
    setToolInstallStatus: (key: string, entry: ToolInstallEntry) => void;
    /** 清除所有工具安装状态（重新扫描时） */
    clearToolInstallStatuses: () => void;
    /** 标记 npm 后置初始化命令已成功完成 */
    markPostInstallCommandCompleted: (key: string) => void;

    // === 技能包安全审查 ===
    /** 准备审查（下载/复制尚未完成，但需要让 UI 保持可见） */
    prepareSkillAudit: (packagePath: string) => void;
    /** 开始审查（设置状态为 auditing） */
    startSkillAudit: (packagePath: string) => void;
    /** 设置审查结果 */
    setSkillAuditResult: (result: SkillAuditResult) => void;
    /** 设置审查错误 */
    setSkillAuditError: (error: string) => void;
    /** 更新审查进度（SA 读取文件时实时推送） */
    updateAuditProgress: (progress: AuditProgress) => void;
    /** 收起或恢复审查窗口 */
    setSkillAuditMinimized: (minimized: boolean) => void;
    /** 清除审查状态（用户决策后重置） */
    clearSkillAudit: () => void;

    // === 重置 ===
    /** 重置为初始状态 */
    reset: () => void;
}

// ==================== 初始状态 ====================

const initialState: RuntimeStoreState = {
    envStatus: 'not_checked',
    pythonVersion: null,
    pythonPath: null,
    venvPath: null,
    errorMessage: null,
    installedSkills: [],
    pendingDependencies: [],
    skillEnabledOverrides: {},
    installProgress: null,
    githubInstallStatus: 'idle',
    githubInstallError: null,
    depInstallResultMessage: null,
    _isActiveInstall: false,
    toolInstallStatuses: {},
    completedPostInstallCommands: {},
    skillAuditStatus: 'idle',
    skillAuditResult: null,
    skillAuditError: null,
    skillAuditPackagePath: null,
    skillAuditProgress: null,
    skillAuditMinimized: false,
};

// ==================== Store 创建 ====================

export const useRuntimeStore = create<RuntimeStoreState & RuntimeStoreActions>()(
    persist(
        (set, get) => ({
            ...initialState,

            // === 环境状态管理 ===
            setEnvStatus: (status) => set({ envStatus: status }),

            setPythonInfo: (version, path) => set({
                pythonVersion: version,
                pythonPath: path,
            }),

            setVenvPath: (path) => set({ venvPath: path }),

            setError: (message) => set({
                envStatus: 'error',
                errorMessage: message,
                installProgress: null,
            }),

            clearError: () => set({
                errorMessage: null,
            }),

            markSkipped: () => set({
                envStatus: 'skipped',
                installProgress: null,
            }),

            setActiveInstall: (active) => set({ _isActiveInstall: active }),

            // === 技能管理 ===
            setInstalledSkills: (skills) => {
                // 合并用户的开关偏好：不存在于 overrides 中的技能默认启用
                const { skillEnabledOverrides } = get();
                const merged = skills.map(skill => ({
                    ...skill,
                    enabled: skillEnabledOverrides[skill.name] ?? true,
                }));
                set({ installedSkills: merged });
            },

            initSkillPreferences: async () => {
                // 从 AppData 文件异步加载技能开关偏好并写入 store
                // 必须在 setInstalledSkills 被调用前执行完成，否则默认全部开启
                try {
                    const { loadSkillPreferences } = await import(
                        '@services/planning/skills/external/skillPreferencesService'
                    );
                    const overrides = await loadSkillPreferences();
                    set({ skillEnabledOverrides: overrides });
                    logger.debug('[RuntimeStore] 已加载技能开关偏好', {
                        count: Object.keys(overrides).length,
                    });
                } catch (error) {
                    logger.error('[RuntimeStore] 加载技能开关偏好失败:', error);
                }
            },

            toggleSkillEnabled: (skillName) => {
                const { skillEnabledOverrides, installedSkills } = get();
                // 不存在于 overrides 中时默认为 true，切换后为 false
                const currentEnabled = skillEnabledOverrides[skillName] ?? true;
                const newEnabled = !currentEnabled;

                // 更新内存中的开关 Map
                const newOverrides: SkillEnabledOverrides = { ...skillEnabledOverrides, [skillName]: newEnabled };

                // 同步更新 installedSkills 中对应技能的 enabled 状态
                const updatedSkills = installedSkills.map(skill =>
                    skill.name === skillName
                        ? { ...skill, enabled: newEnabled }
                        : skill
                );

                logger.debug(
                    `[RuntimeStore] 技能 "${skillName}" ${newEnabled ? '已启用' : '已禁用'}`
                );
                set({
                    skillEnabledOverrides: newOverrides,
                    installedSkills: updatedSkills,
                });

                // 异步将新的偏好展开写入 AppData 文件
                // 不 await：写入失败不阻塞 UI 操作
                import('@services/planning/skills/external/skillPreferencesService')
                    .then(({ saveSkillPreferences }) => saveSkillPreferences(newOverrides))
                    .catch((err: unknown) => logger.error('[RuntimeStore] 技能开关偏好写入失败:', err));
            },

            addPendingDependencies: (dep) => {
                const { pendingDependencies } = get();
                // 去重：同名技能只保留最新
                const filtered = pendingDependencies.filter(
                    (d) => d.skillName !== dep.skillName
                );
                set({ pendingDependencies: [...filtered, dep] });
            },

            removePendingDependencies: (skillName) => {
                const { pendingDependencies } = get();
                set({
                    pendingDependencies: pendingDependencies.filter(
                        (d) => d.skillName !== skillName
                    ),
                });
            },

            clearPendingDependencies: () => set({ pendingDependencies: [] }),

            // === 安装进度 ===
            setInstallProgress: (progress) => set({ installProgress: progress }),

            setGitHubInstallStatus: (status) => set({ githubInstallStatus: status }),

            setGitHubInstallError: (error) => set({ githubInstallError: error }),

            setDepInstallResultMessage: (msg) => set({ depInstallResultMessage: msg }),

            // === 非 pip 依赖安装 ===
            setToolInstallStatus: (key, entry) => {
                const { toolInstallStatuses } = get();
                set({
                    toolInstallStatuses: { ...toolInstallStatuses, [key]: entry },
                });
            },
            clearToolInstallStatuses: () => set({ toolInstallStatuses: {} }),

            markPostInstallCommandCompleted: (key) => {
                const { completedPostInstallCommands } = get();
                set({
                    completedPostInstallCommands: {
                        ...completedPostInstallCommands,
                        [key]: true,
                    },
                });
            },

            // === 技能包安全审查 ===
            prepareSkillAudit: (packagePath) => {
                logger.debug(`[RuntimeStore] 准备审查技能包: ${packagePath}`);
                set({
                    skillAuditStatus: 'preparing',
                    skillAuditResult: null,
                    skillAuditError: null,
                    skillAuditPackagePath: packagePath,
                    skillAuditProgress: null,
                    skillAuditMinimized: false,
                });
            },

            startSkillAudit: (packagePath) => {
                logger.debug(`[RuntimeStore] 开始审查技能包: ${packagePath}`);
                set({
                    skillAuditStatus: 'auditing',
                    skillAuditResult: null,
                    skillAuditError: null,
                    skillAuditPackagePath: packagePath,
                    skillAuditProgress: null,
                });
            },

            setSkillAuditResult: (result) => {
                // 根据裁决自动映射审查状态
                const statusMap: Record<string, SkillAuditStatus> = {
                    APPROVED: 'approved',
                    REJECTED: 'rejected',
                    MANUAL_REVIEW_REQUIRED: 'manual_review',
                };
                const auditStatus = statusMap[result.auditResult] ?? 'manual_review';
                logger.debug(
                    `[RuntimeStore] 审查结果: ${result.auditResult} → 状态: ${auditStatus}`
                );
                set({
                    skillAuditStatus: auditStatus,
                    skillAuditResult: result,
                });
            },

            setSkillAuditError: (error) => {
                logger.error(`[RuntimeStore] 审查错误: ${error}`);
                set({
                    skillAuditStatus: 'error',
                    skillAuditError: error,
                });
            },

            updateAuditProgress: (progress) => {
                set({ skillAuditProgress: progress });
            },

            setSkillAuditMinimized: (minimized) => {
                set({ skillAuditMinimized: minimized });
            },

            clearSkillAudit: () => {
                set({
                    skillAuditStatus: 'idle',
                    skillAuditResult: null,
                    skillAuditError: null,
                    skillAuditPackagePath: null,
                    skillAuditProgress: null,
                    skillAuditMinimized: false,
                });
            },

            // === Reconcile ===
            reconcileWithPhysical: (runtimeUsable) => {
                const { envStatus } = get();

                // 中间状态集合：如果从持久化恢复了这些状态，说明上次安装被中断
                // 应用启动时不可能有正在运行的安装进程，必须根据物理状态重置
                const isStaleIntermediateStatus =
                    envStatus === 'creating' ||
                    envStatus === 'installing_base' ||
                    envStatus === 'installing_extra' ||
                    envStatus === 'error';

                if (isStaleIntermediateStatus) {
                    // 检查是否有活跃安装进程（当前会话内）
                    const { _isActiveInstall } = get();
                    if (_isActiveInstall) {
                        // 当前会话有活跃安装 → 不重置，保持实时进度
                        logger.debug(
                            `[RuntimeStore] 中间状态 "${envStatus}" 有活跃安装进程，跳过重置`
                        );
                        return;
                    }

                    // 上次安装中途被中断，根据 runtime 可用性和中断阶段决定恢复状态
                    if (runtimeUsable) {
                        // 区分中断阶段：
                        // - installing_extra / error: runtime 已通过健康检查 → 恢复 ready
                        // - creating / installing_base: 基础环境可能不完整 → 重置 not_created
                        const isBaseEnvReady =
                            envStatus === 'installing_extra' || envStatus === 'error';

                        if (isBaseEnvReady) {
                            logger.warn(
                                `[RuntimeStore] 从持久化恢复了中间状态 "${envStatus}"（额外依赖安装被中断），` +
                                `runtime 已通过健康检查，恢复为 ready`
                            );
                            set({
                                envStatus: 'ready',
                                installProgress: null,
                                errorMessage: null,
                            });
                        } else {
                            logger.warn(
                                `[RuntimeStore] 从持久化恢复了中间状态 "${envStatus}"（基础安装被中断），` +
                                `runtime 需要重新安装，重置为 not_created`
                            );
                            set({
                                envStatus: 'not_created',
                                pythonVersion: null,
                                installProgress: null,
                                errorMessage: null,
                            });
                        }
                    } else {
                        const { errorMessage } = get();
                        if (envStatus === 'error' && errorMessage) {
                            logger.warn(
                                '[RuntimeStore] runtime 不可用且当前会话已有错误详情，保持 error 状态'
                            );
                            set({ installProgress: null });
                            return;
                        }

                        logger.warn(
                            `[RuntimeStore] 从持久化恢复了中间状态 "${envStatus}"（上次安装被中断），` +
                            `runtime 不可用，重置为 not_created`
                        );
                        set({
                            envStatus: 'not_created',
                            pythonVersion: null,
                            installProgress: null,
                            errorMessage: null,
                        });
                    }
                } else if (envStatus === 'ready' && !runtimeUsable) {
                    // 持久化标记 ready 但 runtime 不可用
                    logger.warn(
                        '[RuntimeStore] runtime 不可用但状态为 ready，重置为 not_created'
                    );
                    set({
                        envStatus: 'not_created',
                        pythonVersion: null,
                        installProgress: null,
                    });
                } else if (envStatus === 'not_checked' && runtimeUsable) {
                    // 首次启动且 runtime 已通过检查（可能是之前安装的）
                    set({ envStatus: 'ready' });
                } else if (envStatus === 'not_checked' && !runtimeUsable) {
                    set({ envStatus: 'not_created' });
                }
                // envStatus === 'ready' && runtimeUsable → 保持不变
                // envStatus === 'skipped' → 保持不变
            },

            // === 重置 ===
            reset: () => set(initialState),
        }),
        {
            name: 'agentvis-runtime-store',
            // 只持久化环境相关状态，不持久化进度和错误等瞬态信息
            // 注意：installedSkills 不持久化，每次启动通过 scanAndRegister 重建，
            // 避免删除技能包后列表中仍显示幽灵技能
            // skillEnabledOverrides 已迁移到 AppData 文件存储（skillPreferencesService.ts），不再持久化到 localStorage
            partialize: (state) => ({
                envStatus: state.envStatus,
                pythonVersion: state.pythonVersion,
                pythonPath: state.pythonPath,
                venvPath: state.venvPath,
                completedPostInstallCommands: state.completedPostInstallCommands,
            }),
        }
    )
);

// ==================== Selector Hooks ====================

/** 环境是否就绪 */
export const useRuntimeReady = () =>
    useRuntimeStore((state) => state.envStatus === 'ready');

/** 是否有待安装依赖 */
export const usePendingDeps = () =>
    useRuntimeStore((state) => state.pendingDependencies.length > 0);

/** 已安装技能列表 */
export const useInstalledSkills = () =>
    useRuntimeStore((state) => state.installedSkills);

/** 是否正在安装 */
export const useIsInstalling = () =>
    useRuntimeStore((state) =>
        state.envStatus === 'creating' ||
        state.envStatus === 'installing_base' ||
        state.envStatus === 'installing_extra'
    );

/** 是否需要初始化（首次使用） */
export const useNeedsSetup = () =>
    useRuntimeStore((state) =>
        state.envStatus === 'not_created' ||
        state.envStatus === 'not_checked'
    );
