/**
 * External Skill 类型定义
 *
 * 定义外部技能包的类型系统，支持两种模式：
 * - Guide 模式：给 LLM 的使用指南（兼容 Anthropic 官方 Skill）
 * - Script 模式：独立可执行脚本工具（自研/社区 Skill）
 *
 * 核心约束：
 * - External Skill 作为一次性 Side-Effect Observation
 * - 不进入 FSM Loop，不可重试
 * - 只在冷启动时加载，运行时不变
 */

// ==================== 技能模式 ====================

/**
 * External Skill 运行模式
 *
 * - guide: SKILL.md 是给 LLM 的使用指南，LLM 自行编写代码通过 exec 执行
 * - script: SKILL.md 包含 Execution Contract，由 ExternalExecutor 直接调用入口脚本
 */
export type SkillMode = 'guide' | 'script';

// 所有命中的 Guide 技能统一在 MB 和 SA 端注入全文+脚本+资源文件

// ==================== Execution Contract ====================

/**
 * 脚本运行时类型
 */
export type ScriptRuntime = 'python' | 'bash' | 'node';

export type SkillNetworkMode = 'direct' | 'brokerOnly';
export type SkillAgentVisNetwork = 'brokerProxyPreferred';
export type SkillAgentVisNetworkEntrypointMode = 'brokerProxyPreferred' | 'legacyNonHttp';
export type SkillAgentVisNetworkEntrypoints = Record<string, SkillAgentVisNetworkEntrypointMode>;

export type BrokerCredentialMode = 'brokerAuth';

export interface BrokerCredentialRef {
    id: string;
    provider: string;
    mode: BrokerCredentialMode;
    hosts: string[];
    headerName: string;
    headerValuePrefix: string;
    required: boolean;
}

export type SkillFilesystemAccess = 'readOnly' | 'readWrite';

export interface SkillFilesystemGrant {
    fromArg: string;
    access: SkillFilesystemAccess;
}

/**
 * Contract 参数定义
 *
 * 描述 Script 模式工具的单个入参
 */
export interface ContractArg {
    /** 参数名称（映射为 CLI --name value） */
    name: string;
    /** 参数类型 */
    type: 'string' | 'number' | 'boolean';
    /** 是否必填 */
    required: boolean;
    /** 参数描述（注入 LLM 的工具 Schema） */
    description: string;
    /** Local value constraint; not exposed directly as provider JSON Schema. */
    allowedValues?: Array<string | number | boolean>;
    /** Local lower bound for number args. */
    min?: number;
    /** Local upper bound for number args. */
    max?: number;
    /** Suggested default value for prompt guidance and local validation. */
    default?: string | number | boolean;
    /** Prompt examples; not exposed directly as provider JSON Schema. */
    examples?: Array<string | number | boolean>;
}

/**
 * Execution Contract
 *
 * Script 模式 Skill 必须在 SKILL.md frontmatter 中声明。
 * 定义脚本的执行边界：运行时、入口、超时、输出限制、参数格式。
 */
export interface ExecutionContract {
    /** 脚本运行时 */
    runtime: ScriptRuntime;
    /** 入口脚本路径（相对于技能包根目录） */
    entry: string;
    /** 超时时间（秒），默认 60 */
    timeout: number;
    /** 最大输出字节数，默认 65536 (64KB) */
    maxOutput: number;
    /** 参数 Schema（映射为 CLI 参数） */
    argsSchema: ContractArg[];
    /** 允许注入的环境变量名称列表 */
    env?: string[];
    /** brokerOnly 模式下由主进程 broker 代持并注入的凭据引用 */
    credentials?: BrokerCredentialRef[];
    /** 权限声明；未声明网络权限的 Script Skill 默认按网络审计执行 */
    permissions?: {
        /** 是否允许脚本执行期访问网络 */
        network?: boolean;
        networkMode?: SkillNetworkMode;
        filesystem?: SkillFilesystemGrant[];
        /** 是否允许声明较长的脚本超时，用于异步轮询、长时间转码等任务 */
        longRunning?: boolean;
        /** 是否允许脚本启动桌面 GUI / detached 应用 */
        desktopLaunch?: boolean;
        /** 是否允许脚本控制或观察交互式桌面（热键、鼠标、截图、窗口激活等） */
        desktopControl?: boolean;
    };
}

// ==================== 依赖声明 ====================

/**
 * 技能包依赖声明
 *
 * Script 模式 Skill 可声明额外 Python 包依赖，
 * 超出基础包清单 runtime-requirements-v1.txt 的部分会增量安装
 */
export interface SkillDependencies {
    /** Python 版本要求（如 ">=3.11"） */
    python?: string;
    /** 额外 pip 包列表（如 ["scipy>=1.10", "networkx"]） */
    packages?: string[];
}

// ==================== registry.yaml 类型 ====================

/**
 * registry.yaml 中单个技能条目
 */
export interface ExternalSkillEntry {
    /** 技能名称（唯一标识，对应 packages/{name}/ 目录） */
    name: string;
    /** 技能模式（安装时自动检测） */
    mode: SkillMode;
    /** 是否启用 */
    enabled: boolean;
    /** 安装时间 ISO 8601 */
    installedAt: string;
}

/**
 * registry.yaml 完整结构
 */
export interface ExternalSkillRegistry {
    /** 注册表格式版本 */
    version: number;
    /** 已安装技能列表 */
    skills: ExternalSkillEntry[];
}

// ==================== 解析后的技能包 ====================

/**
 * SKILL.md frontmatter 解析结果（External 扩展字段）
 */
export interface ExternalSkillFrontmatter {
    /** 技能名称（必须） */
    name: string;
    /** 技能描述（必须） */
    description: string;
    /** Execution Contract（仅 Script 模式） */
    execution?: Partial<ExecutionContract>;
    /** 依赖声明（可选） */
    dependencies?: SkillDependencies;
    /** 许可证声明（可选） */
    license?: string;
    /** AgentVis 受控联网兼容声明（可选） */
    agentvisNetwork?: SkillAgentVisNetwork;
    /** AgentVis 受控联网入口级声明（可选） */
    agentvisNetworkEntrypoints?: SkillAgentVisNetworkEntrypoints;

    /**
     * 关键词触发列表（仅 Guide 模式有效）
     *
     * 用于 SkillRetriever L1 关键词精确匹配。
     * query 中包含任一触发词即视为命中该技能（大小写不敏感）。
     * 技能名称自动作为触发词，无需重复声明。
     *
     * 示例：triggers: [pptx, PPT, 演示文稿, slides, presentation]
     */
    triggers?: string[];
}

/**
 * 已加载的 External Skill 完整信息
 *
 * ExternalSkillRegistry 解析技能包后生成此结构
 */
export interface LoadedExternalSkill {
    /** 技能名称 */
    name: string;
    /** 技能描述 */
    description: string;
    /** 运行模式 */
    mode: SkillMode;
    /** 技能包的绝对路径 */
    packagePath: string;
    /** SKILL.md 完整内容（frontmatter 之后的 markdown） */
    fullContent: string;
    /** Execution Contract（仅 Script 模式有值） */
    contract?: ExecutionContract;
    /** 依赖声明 */
    dependencies?: SkillDependencies;
    /** AgentVis 受控联网兼容声明 */
    agentvisNetwork?: SkillAgentVisNetwork;
    /** AgentVis 受控联网入口级声明 */
    agentvisNetworkEntrypoints?: SkillAgentVisNetworkEntrypoints;
    /** 是否启用 */
    enabled: boolean;

    /**
     * 技能包内的脚本文件列表（相对于 packagePath）
     *
     * Guide 模式：扫描时收集 .py/.sh/.js 文件，供 SA 通过 exec 调用
     * Script 模式：无需此字段（入口由 execution.entry 指定）
     */
    scriptFiles?: string[];
    /**
     * 技能包内的资源文件列表（相对于 packagePath）
     *
     * 收集非脚本、非 SKILL.md 的文档/数据文件（.md/.pdf/.txt/.json/.yaml 等），
     * 供 SA 通过 read 工具读取。排除 SKILL.md（已注入 fullContent）和 LICENSE 文件。
     */
    resourceFiles?: string[];
    /**
     * 关键词触发列表（仅 Guide 模式有效）
     *
     * 来源于 SKILL.md frontmatter 的 triggers 声明。
     * 由 SkillRetriever 在 L1 层使用，query 包含触发词即直接命中。
     */
    triggers?: string[];
}

// ==================== 执行相关 ====================

/**
 * 脚本执行结果（ExternalExecutor 返回）
 */
export interface ScriptExecutionResult {
    /** 进程退出码 */
    exitCode: number;
    /** 标准输出 */
    stdout: string;
    /** 标准错误 */
    stderr: string;
    /** 执行耗时（毫秒） */
    durationMs: number;
    /** 是否超时 */
    timedOut: boolean;
}

// ==================== 常量 ====================

/** Execution Contract 默认超时（秒） */
export const DEFAULT_TIMEOUT_SECONDS = 60;

/** Execution Contract 默认最大输出（字节） */
export const DEFAULT_MAX_OUTPUT_BYTES = 65536;

/** registry.yaml 当前格式版本 */
export const REGISTRY_VERSION = 1;

/** 支持的脚本运行时列表 */
export const SUPPORTED_RUNTIMES: ReadonlyArray<ScriptRuntime> = ['python', 'bash', 'node'];

/** Native Skill 名称列表（用于冲突检测） */
export const NATIVE_SKILL_NAMES: ReadonlyArray<string> = [
    'read',
    'file_write',
    'exec',
    'web_search',
    'local_search',
    'conversation_search',
    'generate_image',
    'cron',
    'im_send',
    // Legacy IM bridge names are kept reserved even though im_send is the public tool.
    'feishu_send',
    'slack_send',
    'external_skill_execute',
];
