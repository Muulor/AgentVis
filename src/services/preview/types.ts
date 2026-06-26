/**
 * Preview 服务类型定义
 *
 * 定义 Vite Dev Server 实时预览系统的核心类型，
 * 包括项目文件、模板配置和服务器运行时状态。
 */

// ==================== 项目文件 ====================

/**
 * 预览项目的单个源文件
 *
 * Agent 生成的代码文件，写入到项目 src/ 目录下
 */
export interface ProjectFile {
    /** 相对路径，如 "src/App.jsx" */
    path: string;
    /** 文件内容 */
    content: string;
}

// ==================== 模板系统 ====================

/** 支持的模板 ID */
export type TemplateId = 'vanilla' | 'react-tailwind' | 'vue-tailwind';

/**
 * 模板配置
 *
 * 描述一个预览模板的完整配置，包括依赖、配置文件和入口文件。
 * 由 TemplateManager 持有并用于初始化项目目录。
 */
export interface TemplateConfig {
    /** 模板唯一标识 */
    id: TemplateId;
    /** 模板显示名称 */
    displayName: string;
    /** 生产依赖 */
    dependencies: Record<string, string>;
    /** 开发依赖 */
    devDependencies: Record<string, string>;
    /**
     * 配置文件映射（文件名 → 文件内容）
     *
     * 这些文件会被复制到项目根目录。
     * 例如：vite.config.js, tailwind.config.js
     */
    configFiles: Record<string, string>;
    /**
     * 入口文件映射（相对路径 → 默认内容）
     *
     * 这些文件作为项目骨架，Agent 会在此基础上修改。
     * 例如：index.html, src/main.jsx
     */
    entryFiles: Record<string, string>;
}

// ==================== Vite 服务器状态 ====================

/**
 * Vite Dev Server 生命周期状态
 *
 * 状态机流转：idle → installing → starting → running → idle
 *              ↓ error 可从 installing/starting 进入
 */
export type ViteServerStatus = 'idle' | 'installing' | 'starting' | 'running' | 'error';

/**
 * Vite Dev Server 运行时状态
 *
 * 记录当前预览服务器的完整状态，用于 UI 渲染和生命周期管理
 */
export interface ViteServerState {
    /** 当前状态 */
    status: ViteServerStatus;
    /** 可访问的本地 URL（running 状态有效） */
    url: string | null;
    /** Vite 进程 PID（用于停止时调用 shell_kill） */
    pid: number | null;
    /** 项目目录绝对路径 */
    projectDir: string | null;
    /** 使用的模板 ID */
    templateId: TemplateId | null;
    /** 错误信息（error 状态有效） */
    error: string | null;
}

/**
 * 模板安装状态（用于 TemplateManager 内部追踪）
 */
export interface TemplateStatus {
    /** 模板 ID */
    id: TemplateId;
    /** node_modules 是否已安装 */
    isInstalled: boolean;
    /** 模板缓存目录路径 */
    path: string;
}
