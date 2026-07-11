/**
 * Logger 核心模块
 *
 * 基于 tslog 构建统一日志外壳，通过 Transport 桥接到 @tauri-apps/plugin-log
 * 实现前端日志的级别控制、模块标识和 Rust 侧文件持久化。
 *
 * 架构：tslog (开发体验 + TS 类型) → Transport → plugin-log (Rust 持久化)
 */

import { Logger as TsLogger, type ILogObj, type IMeta } from 'tslog';
import { LogLevel } from './types';

// ─── 环境检测 ─────────────────────────────────────────────────

/** 是否运行在 Tauri 宿主环境中（Vitest 测试时为 false） */
function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** 是否生产环境 */
function isProduction(): boolean {
  try {
    return import.meta.env.PROD;
  } catch {
    // Vitest 或非 Vite 环境下降级为 false
    return false;
  }
}

function parseLogLevel(value: string | undefined): LogLevel | null {
  switch (value?.trim().toLowerCase()) {
    case 'silly':
      return LogLevel.SILLY;
    case 'trace':
      return LogLevel.TRACE;
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
    case 'warning':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    case 'fatal':
      return LogLevel.FATAL;
    default:
      return null;
  }
}

function getLogLevelOverride(): string | undefined {
  try {
    const env = import.meta.env as { readonly VITE_AGENTVIS_LOG_LEVEL?: unknown };
    const value = env.VITE_AGENTVIS_LOG_LEVEL;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function getConfiguredMinLevel(isProd: boolean): LogLevel {
  return parseLogLevel(getLogLevelOverride()) ?? (isProd ? LogLevel.INFO : LogLevel.DEBUG);
}

// ─── Tauri Transport 桥接 ─────────────────────────────────────

/**
 * 将 tslog 日志对象序列化为可读字符串
 *
 * 为什么不直接 JSON.stringify：plugin-log 期望的是 string message，
 * 且 tslog 的 logObj 包含循环引用和 meta 属性，直接序列化会失败。
 */
function formatLogMessage(logObj: ILogObj & { _meta?: IMeta }): string {
  const moduleName = logObj._meta?.name ?? 'App';
  // tslog 将日志参数存储在数字索引的属性中（0, 1, 2...）
  const args: unknown[] = [];
  for (let i = 0; i in logObj; i++) {
    args.push(logObj[i]);
  }

  const messageParts = args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });

  return `[${moduleName}] ${messageParts.join(' ')}`;
}

/**
 * 创建 Tauri plugin-log Transport
 *
 * 延迟导入 @tauri-apps/plugin-log，避免在非 Tauri 环境（Vitest）下导入失败。
 * 使用 fire-and-forget 模式调用异步函数，加 .catch() 防止 unhandled rejection。
 */
function createTauriTransport(): (logObj: ILogObj & { _meta?: IMeta }) => void {
  // 缓存动态导入的模块引用，避免每次日志都触发 import()
  let tauriLogModule: typeof import('@tauri-apps/plugin-log') | null = null;
  let importFailed = false;

  return (logObj: ILogObj & { _meta?: IMeta }): void => {
    if (importFailed) return;

    const message = formatLogMessage(logObj);
    const logLevelId = (logObj._meta?.logLevelId ?? LogLevel.INFO) as LogLevel;

    // 首次调用时动态导入，后续使用缓存
    if (tauriLogModule === null) {
      import('@tauri-apps/plugin-log')
        .then((mod) => {
          tauriLogModule = mod;
          dispatchToTauri(tauriLogModule, logLevelId, message);
        })
        .catch(() => {
          // 非 Tauri 环境或插件不可用时，静默降级
          importFailed = true;
        });
    } else {
      dispatchToTauri(tauriLogModule, logLevelId, message);
    }
  };
}

/** 根据日志级别分发到对应的 Tauri plugin-log 函数 */
function dispatchToTauri(
  mod: typeof import('@tauri-apps/plugin-log'),
  logLevelId: LogLevel,
  message: string
): void {
  let logFn: (msg: string) => Promise<void>;

  switch (logLevelId) {
    case LogLevel.SILLY:
    case LogLevel.TRACE:
      logFn = mod.trace;
      break;
    case LogLevel.DEBUG:
      logFn = mod.debug;
      break;
    case LogLevel.INFO:
      logFn = mod.info;
      break;
    case LogLevel.WARN:
      logFn = mod.warn;
      break;
    case LogLevel.ERROR:
    case LogLevel.FATAL:
      logFn = mod.error;
      break;
    default:
      logFn = mod.info;
  }

  // fire-and-forget：不 await，但捕获 rejection 防止静默错误
  logFn(message).catch(() => {
    // Tauri IPC 通道异常时静默降级，避免日志系统本身抛出异常
  });
}

// ─── Logger 实例管理 ──────────────────────────────────────────

/** 根 Logger 实例（延迟初始化） */
let rootLogger: TsLogger<ILogObj> | null = null;

/**
 * 初始化全局 Logger
 *
 * 在应用入口（main.tsx）中调用，必须在其他模块使用 getLogger() 之前执行。
 * 根据环境自动决定输出模式：
 * - 开发环境：pretty 格式输出到控制台 + Tauri Transport
 * - 生产环境：隐藏控制台输出，仅通过 Tauri Transport 持久化
 */
export function initializeLogger(): void {
  if (rootLogger !== null) return; // 防止重复初始化

  const isProd = isProduction();
  const hasTauri = isTauriEnvironment();

  rootLogger = new TsLogger<ILogObj>({
    name: 'AgentVis',
    // 默认生产环境 info、开发环境 debug；可用 VITE_AGENTVIS_LOG_LEVEL 覆盖。
    minLevel: getConfiguredMinLevel(isProd),
    // 生产环境隐藏控制台输出（日志全走 Tauri Transport 持久化）
    type: isProd ? 'hidden' : 'pretty',
    // 简化 pretty 模板：只显示时间、级别和模块名
    prettyLogTemplate: '{{hh}}:{{MM}}:{{ss}} {{logLevelName}}\t{{name}}\t',
    // 生产环境隐藏文件位置以提升性能
    hideLogPositionForProduction: isProd,
    stylePrettyLogs: true,
    prettyLogTimeZone: 'local',
  });

  // 在 Tauri 环境下挂载持久化 Transport
  if (hasTauri) {
    rootLogger.attachTransport(createTauriTransport());
  }
}

/**
 * 获取模块级 Logger 实例
 *
 * 各模块在文件顶部调用此函数创建专属 Logger，自动继承根 Logger 的配置。
 * 如果根 Logger 未初始化（如在测试环境下），会自动创建一个默认配置的根 Logger。
 *
 * @param moduleName - 模块名称，用于日志前缀标识（如 'MemoryService'、'AgentLoop'）
 * @returns 带有模块标识的子 Logger 实例
 *
 * @example
 * ```typescript
 * import { getLogger } from '@services/logger';
 * const logger = getLogger('MemoryService');
 *
 * logger.info('初始化完成');
 * logger.debug('加载记忆', { count: 42 });
 * logger.error('加载失败', error);
 * ```
 */
export function getLogger(moduleName: string): TsLogger<ILogObj> {
  // 懒初始化：测试环境下可能没有显式调用 initializeLogger()
  if (rootLogger === null) {
    initializeLogger();
  }

  if (rootLogger === null) {
    throw new Error('Logger initialization failed');
  }

  return rootLogger.getSubLogger({ name: moduleName });
}
