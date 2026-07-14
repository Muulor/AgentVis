/**
 * inlineGeneratedImageVisibility - 内联生成图片可见性辅助逻辑
 *
 * 记录本地读取或解码失败的生成图片，并维护画廊在列表变化后的稳定选中项。
 */

/** 将失败路径加入集合；重复上报时复用原集合，避免无意义渲染。 */
export function addUnavailableImagePath(
  current: ReadonlySet<string>,
  filePath: string
): ReadonlySet<string> {
  if (current.has(filePath)) return current;

  const next = new Set(current);
  next.add(filePath);
  return next;
}

/** 仅保留当前仍可尝试展示的图片路径。 */
export function getDisplayableImagePaths(
  imagePaths: readonly string[],
  unavailablePaths: ReadonlySet<string>
): string[] {
  return imagePaths.filter((filePath) => !unavailablePaths.has(filePath));
}

/** 当前图片仍有效时保持选中，否则回退到第一张可用图片。 */
export function resolveActiveImagePath(
  imagePaths: readonly string[],
  activePath: string | null
): string | null {
  if (activePath && imagePaths.includes(activePath)) return activePath;
  return imagePaths[0] ?? null;
}

export interface ImageGalleryNavigationState {
  activePath: string | null;
  currentIndex: number;
  totalCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** 根据有效路径和当前项生成计数及首尾按钮状态。 */
export function getImageGalleryNavigationState(
  imagePaths: readonly string[],
  activePath: string | null
): ImageGalleryNavigationState {
  const resolvedPath = resolveActiveImagePath(imagePaths, activePath);
  const currentIndex = resolvedPath ? imagePaths.indexOf(resolvedPath) : -1;

  return {
    activePath: resolvedPath,
    currentIndex,
    totalCount: imagePaths.length,
    hasPrevious: currentIndex > 0,
    hasNext: currentIndex >= 0 && currentIndex < imagePaths.length - 1,
  };
}

/**
 * 获取相邻图片路径，并在首尾处保持当前项。
 * 按钮禁用状态由调用方控制，这里的夹取可防止键盘或异步状态越界。
 */
export function getAdjacentImagePath(
  imagePaths: readonly string[],
  activePath: string | null,
  direction: -1 | 1
): string | null {
  const resolvedPath = resolveActiveImagePath(imagePaths, activePath);
  if (!resolvedPath) return null;

  const currentIndex = imagePaths.indexOf(resolvedPath);
  const nextIndex = Math.min(imagePaths.length - 1, Math.max(0, currentIndex + direction));
  return imagePaths[nextIndex] ?? resolvedPath;
}
