/**
 * CrashReporter - 渲染进程崩溃诊断
 *
 * 捕获 window.error / unhandledrejection，并把运行时快照写入 Tauri 持久化日志。
 */

import { getLogger } from '@services/logger';

let registered = false;
let crashLogger: ReturnType<typeof getLogger> | undefined;

interface BrowserMemorySnapshot {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
}

function serializeError(value: unknown): Record<string, unknown> {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (typeof value === 'string') {
        return { message: value };
    }

    try {
        return {
            message: JSON.stringify(value),
        };
    } catch {
        return {
            message: String(value),
        };
    }
}

function getMemorySnapshot(): BrowserMemorySnapshot | undefined {
    const memory = (performance as Performance & { memory?: BrowserMemorySnapshot }).memory;
    if (!memory) return undefined;

    return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
    };
}

function getRuntimeSnapshot(): Record<string, unknown> {
    return {
        url: window.location.href,
        userAgent: navigator.userAgent,
        visibilityState: document.visibilityState,
        memory: getMemorySnapshot(),
        timestamp: new Date().toISOString(),
    };
}

function getCrashLogger(): ReturnType<typeof getLogger> {
    crashLogger ??= getLogger('CrashReporter');
    return crashLogger;
}

function getResourceTarget(event: Event): Record<string, unknown> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return {
            targetType: Object.prototype.toString.call(target),
        };
    }

    return {
        tagName: target.tagName,
        id: target.id || undefined,
        className: target.className || undefined,
        source: target.getAttribute('src') ?? target.getAttribute('href') ?? undefined,
    };
}

/**
 * 注册渲染进程异常捕获。
 *
 * 这里不替代 React error boundary，只负责在 release 包里尽量留下崩溃前线索。
 */
export function registerRendererCrashReporter(): void {
    if (registered || typeof window === 'undefined') return;
    registered = true;

    window.addEventListener('error', (event) => {
        if (event instanceof ErrorEvent) {
            getCrashLogger().error('[Renderer] window.error', {
                message: event.message,
                source: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: serializeError(event.error),
                runtime: getRuntimeSnapshot(),
            });
            return;
        }

        getCrashLogger().error('[Renderer] resource.error', {
            target: getResourceTarget(event),
            runtime: getRuntimeSnapshot(),
        });
    }, true);

    window.addEventListener('unhandledrejection', (event) => {
        getCrashLogger().error('[Renderer] unhandledrejection', {
            reason: serializeError(event.reason),
            runtime: getRuntimeSnapshot(),
        });
    });
}
