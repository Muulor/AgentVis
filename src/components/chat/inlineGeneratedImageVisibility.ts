/**
 * inlineGeneratedImageVisibility - 内联生成图片可见性辅助逻辑
 *
 * 记录本地读取或解码失败的生成图片，并从消息中的图片网格过滤这些终态失败项。
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
