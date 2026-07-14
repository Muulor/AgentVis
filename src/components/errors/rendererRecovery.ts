/**
 * Renderer 恢复辅助逻辑
 *
 * 识别常见的动态模块/分块加载失败，用于选择更有针对性的恢复提示。
 */

const DYNAMIC_MODULE_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /chunkloaderror/i,
  /loading chunk \S+ failed/i,
];

function normalizeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 判断异常是否来自失效或不可达的动态模块。 */
export function isDynamicModuleLoadError(value: unknown): boolean {
  const message = normalizeErrorMessage(value);
  return DYNAMIC_MODULE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
