/**
 * RendererHealth - WebView renderer 健康诊断
 *
 * 记录 renderer 心跳、主线程长时间阻塞和高风险同步任务耗时。
 * 诊断逻辑必须静默降级，避免自身影响用户任务。
 */

import { getLogger } from '@services/logger';

type StageDetails = Record<string, string | number | boolean | null | undefined>;

interface RendererStage {
  name: string;
  details?: StageDetails;
  startedAt: number;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const HEARTBEAT_INTERVAL_MS = 5_000;
const MAIN_THREAD_STALL_WARN_MS = 3_000;
const SLOW_WORK_WARN_MS = 1_000;
const SLOW_WORK_ERROR_MS = 3_000;

const logger = getLogger('RendererHealth');

let registered = false;
let sequence = 0;
let currentStage: RendererStage | null = null;
let maxObservedDriftMs = 0;
let invokeLoader: Promise<TauriInvoke | null> | null = null;

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function getMemorySnapshot(): Record<string, number | undefined> | undefined {
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize?: number;
        totalJSHeapSize?: number;
        jsHeapSizeLimit?: number;
      };
    }
  ).memory;

  if (!memory) return undefined;

  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

async function getInvoke(): Promise<TauriInvoke | null> {
  if (!isTauriEnvironment()) return null;

  invokeLoader ??= import('@tauri-apps/api/core')
    .then((mod) => mod.invoke as TauriInvoke)
    .catch(() => null);

  return invokeLoader;
}

function logSlowWork(stageName: string, elapsedMs: number, details?: StageDetails): void {
  const payload = {
    stageName,
    elapsedMs: Math.round(elapsedMs),
    details,
    memory: getMemorySnapshot(),
    url: typeof window !== 'undefined' ? window.location.href : undefined,
  };

  if (elapsedMs >= SLOW_WORK_ERROR_MS) {
    logger.error('[RendererHealth] slow renderer work', payload);
  } else if (elapsedMs >= SLOW_WORK_WARN_MS) {
    logger.warn('[RendererHealth] slow renderer work', payload);
  }
}

async function sendHeartbeat(driftMs: number): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;

  const stage = currentStage;
  const memory = getMemorySnapshot();

  await invoke('renderer_health_heartbeat', {
    payload: {
      sequence: ++sequence,
      url: window.location.href,
      visibilityState: document.visibilityState,
      stage: stage?.name,
      stageAgeMs: stage ? Math.round(performance.now() - stage.startedAt) : undefined,
      stageDetails: safeStringify(stage?.details),
      maxMainThreadDriftMs: Math.round(driftMs),
      usedJsHeapSize: memory?.usedJSHeapSize,
      totalJsHeapSize: memory?.totalJSHeapSize,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit,
      timestampMs: Date.now(),
    },
  }).catch(() => {
    // IPC 不可用时静默降级，避免诊断逻辑打断主流程。
  });
}

export function setRendererHealthStage(name: string, details?: StageDetails): () => void {
  const stage: RendererStage = {
    name,
    details,
    startedAt: performance.now(),
  };
  currentStage = stage;

  return () => {
    if (currentStage === stage) {
      currentStage = null;
    }
  };
}

export function measureRendererWork<T>(
  stageName: string,
  details: StageDetails | undefined,
  work: () => T
): T {
  const clearStage = setRendererHealthStage(stageName, details);
  const start = performance.now();
  try {
    return work();
  } finally {
    const elapsedMs = performance.now() - start;
    logSlowWork(stageName, elapsedMs, details);
    clearStage();
  }
}

export function countTextLines(content: string): number {
  if (content.length === 0) return 0;

  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++;
    }
  }

  return lines;
}

export async function measureRendererWorkAsync<T>(
  stageName: string,
  details: StageDetails | undefined,
  work: () => Promise<T>
): Promise<T> {
  const clearStage = setRendererHealthStage(stageName, details);
  const start = performance.now();
  try {
    return await work();
  } finally {
    const elapsedMs = performance.now() - start;
    logSlowWork(stageName, elapsedMs, details);
    clearStage();
  }
}

export function registerRendererHealthMonitor(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;

  let lastTick = performance.now();

  window.setInterval(() => {
    const now = performance.now();
    const driftMs = Math.max(0, now - lastTick - HEARTBEAT_INTERVAL_MS);
    lastTick = now;
    maxObservedDriftMs = Math.max(maxObservedDriftMs, driftMs);

    if (driftMs >= MAIN_THREAD_STALL_WARN_MS) {
      logger.warn('[RendererHealth] main thread stall detected', {
        driftMs: Math.round(driftMs),
        currentStage,
        memory: getMemorySnapshot(),
      });
    }

    const heartbeatDrift = maxObservedDriftMs;
    maxObservedDriftMs = 0;
    void sendHeartbeat(heartbeatDrift);
  }, HEARTBEAT_INTERVAL_MS);

  void sendHeartbeat(0);
}
