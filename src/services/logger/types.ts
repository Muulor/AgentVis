/**
 * Logger 模块类型定义
 *
 * 定义日志系统的配置和级别类型，与 tslog 的 logLevelId 对应。
 */

/** 日志级别枚举（与 tslog 的 logLevelId 对应） */
export enum LogLevel {
    SILLY = 0,
    TRACE = 1,
    DEBUG = 2,
    INFO = 3,
    WARN = 4,
    ERROR = 5,
    FATAL = 6,
}

/** Logger 配置接口 */
export interface LoggerConfig {
    /** 根 Logger 名称 */
    readonly appName: string;
    /** 最小日志级别（低于此级别的日志不输出） */
    readonly minLevel: LogLevel;
    /** 是否启用 Tauri Transport（测试环境下自动关闭） */
    readonly enableTauriTransport: boolean;
    /** 是否在控制台显示 pretty 输出（生产环境关闭以减少噪声） */
    readonly enableConsoleOutput: boolean;
}
