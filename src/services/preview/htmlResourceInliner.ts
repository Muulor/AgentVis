/**
 * htmlResourceInliner - HTML 多文件资源内嵌工具
 *
 * 解决 iframe srcdoc 模式下无 base URL 导致相对路径资源无法加载的问题。
 *
 * 处理逻辑（分三阶段）：
 * 1. 结构内联：将外部 CSS（<link href>）和 JS（<script src>）文件读取后内联为
 *    <style> 和 <script> 标签，使 HTML 变为完全自包含的单文件
 * 2. 资源替换：扫描合并后 HTML 中的相对路径资源引用（CSS url() / img src 等），
 *    通过 Tauri file_read_as_base64 命令读取文件，替换为 base64 data URL
 * 3. 锚点兼容：注入微型脚本修复 null-origin 沙箱下 href="#id" 点击白屏问题
 *    （无 allow-same-origin 时，浏览器将 about:srcdoc#id 视为新导航而非滚动）
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';

const logger = getLogger('htmlResourceInliner');

/** 常见文件扩展名 → MIME 类型映射 */
const MIME_MAP: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // 字体
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
};

// ============================================================================
// 工具函数
// ============================================================================

/** 判断路径是否为需要内嵌的相对路径（排除绝对 URL、data: 和锚点） */
function isRelativePath(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^(https?:|data:|blob:|#|\{\{)/.test(trimmed)) return false;
  if (/^([/\\]|[A-Za-z]:)/.test(trimmed)) return false;
  return true;
}

/** 从文件名获取 MIME 类型 */
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * 拼接绝对路径：baseDir + 相对路径，并规范化 .. 和 . 段
 *
 * Agent 生成的 HTML/CSS 中，图片等资源可能通过 ../file.jpg 引用父级目录的文件。
 * 简单拼接会产生 "dare-lipstick\..\image.jpeg" 这样的未规范化路径，
 * 虽然 Windows 内核可以解析，但在某些 IPC 边界可能导致路径查找失败。
 * 此函数将 .. 和 . 段在 JS 侧提前解析为干净的绝对路径。
 */
function resolveAbsolutePath(baseDir: string, relPath: string): string {
  // 统一为反斜杠后拼接
  const combined = `${baseDir.replace(/\/+$/, '').replace(/\\+$/, '')}\\${relPath.replace(/\//g, '\\')}`;

  // 按路径分隔符拆分并逐段解析 .. 和 .
  const segments = combined.split(/[\\/]/);
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') {
      // 当前目录或空段（连续分隔符），跳过
      // 但保留第一个空段（UNC 路径前缀）和盘符
      if (resolved.length === 0) resolved.push(seg);
      continue;
    }
    if (seg === '..') {
      // 回退上一级，但不超过根目录/盘符
      if (resolved.length > 1) {
        resolved.pop();
      }
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join('\\');
}

/** 读取文本文件内容（CSS/JS），失败返回 null */
async function readTextFile(absolutePath: string): Promise<string | null> {
  try {
    return await invoke<string>('file_read_content', { filePath: absolutePath });
  } catch (error) {
    logger.warn('[htmlResourceInliner] 文本文件读取失败:', absolutePath, error);
    return null;
  }
}

/** 读取二进制文件为 base64 data URL，失败返回 null */
async function readAsDataUrl(absolutePath: string, relPath: string): Promise<string | null> {
  try {
    logger.debug('[htmlResourceInliner] 读取二进制文件:', absolutePath);
    const base64 = await invoke<string>('file_read_as_base64', { path: absolutePath });
    const mimeType = getMimeType(relPath);
    const dataUrl = `data:${mimeType};base64,${base64}`;
    logger.debug(
      '[htmlResourceInliner] 读取成功:',
      relPath,
      `(${(dataUrl.length / 1024).toFixed(0)} KB data URL)`
    );
    return dataUrl;
  } catch (error) {
    logger.warn('[htmlResourceInliner] 二进制文件读取失败:', absolutePath, error);
    return null;
  }
}

// ============================================================================
// 阶段 1：结构内联（外部 CSS/JS → 内联 <style>/<script>）
// ============================================================================

/**
 * 将外部 CSS 文件内联为 <style> 标签
 *
 * 匹配 <link rel="stylesheet" href="xxx.css"> 模式，
 * 读取 CSS 文件内容后替换为 <style> 标签。
 */
async function inlineExternalCss(html: string, baseDir: string): Promise<string> {
  // 匹配 <link ... href="xxx.css" ...> 标签（rel="stylesheet" 可选位置）
  const linkRegex = /<link\b[^>]*\bhref\s*=\s*(['"])([^'"]+\.css)\1[^>]*\/?>/gi;
  const matches: { fullMatch: string; relPath: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const relPath = match[2] ?? '';
    if (relPath && isRelativePath(relPath)) {
      matches.push({ fullMatch: match[0], relPath });
    }
  }

  if (matches.length === 0) return html;

  let result = html;
  // 串行处理避免同一 CSS 被并发读取
  for (const { fullMatch, relPath } of matches) {
    const absolutePath = resolveAbsolutePath(baseDir, relPath);
    const cssContent = await readTextFile(absolutePath);
    if (cssContent) {
      // 替换 <link> 为 <style>，保留 CSS 内容
      result = result.replace(
        fullMatch,
        `<style>/* inlined from ${relPath} */\n${cssContent}\n</style>`
      );
      logger.debug('[htmlResourceInliner] 内联 CSS:', relPath);
    }
  }

  return result;
}

/**
 * 将外部 JS 文件内联为 <script> 标签
 *
 * 匹配 <script src="xxx.js"></script> 模式，
 * 读取 JS 文件内容后替换为内联 <script>。
 */
async function inlineExternalJs(html: string, baseDir: string): Promise<string> {
  // 匹配 <script src="xxx.js" ...></script> 标签
  const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+\.js)\1[^>]*>\s*<\/script>/gi;
  const matches: { fullMatch: string; relPath: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const relPath = match[2] ?? '';
    if (relPath && isRelativePath(relPath)) {
      matches.push({ fullMatch: match[0], relPath });
    }
  }

  if (matches.length === 0) return html;

  let result = html;
  for (const { fullMatch, relPath } of matches) {
    const absolutePath = resolveAbsolutePath(baseDir, relPath);
    const jsContent = await readTextFile(absolutePath);
    if (jsContent) {
      result = result.replace(
        fullMatch,
        `<script>/* inlined from ${relPath} */\n${jsContent}\n</script>`
      );
      logger.debug('[htmlResourceInliner] 内联 JS:', relPath);
    }
  }

  return result;
}

// ============================================================================
// 阶段 2：资源替换（相对路径 → base64 data URL）
// ============================================================================

/**
 * 提取内容中所有相对路径的二进制资源引用（图片、字体等）
 *
 * 扫描三种模式：
 * 1. CSS url('path') — 样式中的资源引用
 * 2. HTML src="path" / href="path" — 标签属性中的资源引用
 * 3. JS 字符串字面量中的资源文件名 — 如 'image.png' 或 "photo.jpg"
 *    （覆盖 JS 动态创建元素并设置 src 的场景）
 *
 * 排除已内联的 CSS/JS 文件
 */
function extractBinaryResourcePaths(content: string): string[] {
  const paths = new Set<string>();

  /** 需要内嵌的二进制资源扩展名集合 */
  const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico|woff2?|ttf|otf|eot)$/i;

  // 模式 1：匹配 CSS url()
  const urlRegex = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(content)) !== null) {
    const path = match[2] ?? '';
    if (isRelativePath(path) && !path.endsWith('.css') && !path.endsWith('.js')) {
      paths.add(path);
    }
  }

  // 模式 2：匹配 HTML src 和 href 属性（排除 CSS/JS 文件引用，它们已在阶段 1 处理）
  const attrRegex = /(?:src|href)\s*=\s*(['"])([^'"]+?)\1/gi;
  while ((match = attrRegex.exec(content)) !== null) {
    const path = match[2] ?? '';
    if (isRelativePath(path) && !path.endsWith('.css') && !path.endsWith('.js')) {
      paths.add(path);
    }
  }

  // 模式 3：匹配 JS 字符串字面量中的资源文件名
  // 覆盖 `const imagePath = 'generated_xxx.png'` 等动态引用场景
  const jsStringRegex = /(?:['"])([^'"]*?\.[a-zA-Z]+)['"]/g;
  while ((match = jsStringRegex.exec(content)) !== null) {
    const path = match[1] ?? '';
    if (isRelativePath(path) && BINARY_EXTENSIONS.test(path)) {
      paths.add(path);
    }
  }

  return Array.from(paths);
}

/**
 * 批量读取二进制资源并转为 base64 data URL
 *
 * 使用 Promise.allSettled 并行读取，失败不影响其他资源。
 */
async function resolveBinaryResources(
  relativePaths: string[],
  baseDir: string
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  const results = await Promise.allSettled(
    relativePaths.map(async (relPath) => {
      const absolutePath = resolveAbsolutePath(baseDir, relPath);
      const dataUrl = await readAsDataUrl(absolutePath, relPath);
      if (dataUrl) {
        return { relPath, dataUrl };
      }
      throw new Error(`Failed to read: ${absolutePath}`);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      resolved.set(result.value.relPath, result.value.dataUrl);
    }
  }

  return resolved;
}

/**
 * 在内容中将相对路径替换为 base64 data URL
 */
function replacePaths(content: string, resourceMap: Map<string, string>): string {
  if (resourceMap.size === 0) return content;

  // 按路径长度降序排列，避免短路径误替换长路径的子串
  const sortedPaths = Array.from(resourceMap.keys()).sort((a, b) => b.length - a.length);

  let result = content;
  for (const relPath of sortedPaths) {
    const dataUrl = resourceMap.get(relPath);
    if (!dataUrl) continue;

    const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), dataUrl);
  }

  return result;
}

/**
 * 展开包含 url(data:...) 的 CSS 自定义属性引用
 *
 * WebView2 srcdoc 模式下，CSS 自定义属性存储超大 url(data:...) 值时
 * 会被静默截断或丢弃，导致 var(--xxx) 解析为空，背景图声明整体失效。
 * 典型案例：Agent 生成的 CSS 通过 --image-path: url('../hero.jpg') 定义变量，
 * 然后在 background-image: var(--image-path) 中引用。
 *
 * 此函数在路径替换完成后执行：
 * 1. 扫描所有 CSS 自定义属性定义，提取包含 url(data:...) 的属性名和值
 * 2. 将对应的 var(--xxx) 引用替换为实际值
 * 3. 删除已展开的自定义属性定义（避免 CSS 解析器处理超大值）
 */
function expandCssVarDataUrls(content: string): string {
  // 匹配 CSS 自定义属性定义：--name: url(data:...);
  // 捕获组 1: 属性名（如 --image-path）
  // 捕获组 2: 完整值（如 url('data:image/jpeg;base64,...')）
  const varDefRegex = /(--[\w-]+)\s*:\s*(url\(\s*['"]?data:[^)]+['"]?\s*\))\s*;/g;
  const varMap = new Map<string, string>();

  let match: RegExpExecArray | null;
  while ((match = varDefRegex.exec(content)) !== null) {
    const varName = match[1] ?? '';
    const varValue = match[2] ?? '';
    if (varName && varValue) {
      varMap.set(varName, varValue);
    }
  }

  if (varMap.size === 0) return content;

  logger.debug('[htmlResourceInliner] 展开 CSS 变量 data URL:', Array.from(varMap.keys()));

  let result = content;
  for (const [varName, varValue] of varMap) {
    // 替换 var(--xxx) 和 var(--xxx, fallback) 引用为实际值
    const varRefRegex = new RegExp(
      `var\\(\\s*${varName.replace(/[-]/g, '\\$&')}(?:\\s*,[^)]*)?\\)`,
      'g'
    );
    result = result.replace(varRefRegex, varValue);

    // 移除已展开的自定义属性定义行，避免 CSS 解析器处理超大值
    const escapedName = varName.replace(/[-]/g, '\\$&');
    const defLineRegex = new RegExp(
      `\\s*${escapedName}\\s*:\\s*url\\(\\s*['"]?data:[^)]+['"]?\\s*\\)\\s*;`,
      'g'
    );
    result = result.replace(defLineRegex, '');
  }

  return result;
}

// ============================================================================
// 阶段 3：srcdoc 锚点兼容注入
// ============================================================================

/**
 * 修复 null-origin 沙箱 iframe 中 hash 锚点链接点击白屏问题
 *
 * 问题根源：
 * - srcdoc iframe 在无 allow-same-origin 时，文档 URL 为 about:srcdoc
 * - 点击 <a href="#story"> 时目标解析为 about:srcdoc#story，与当前 URL 不同
 * - 浏览器触发导航而非滚动，导致 iframe 内容丢失呈现白屏
 *
 * 修复策略：
 * - 注入事件代理脚本，拦截所有 <a href="#..."> 点击事件
 * - 阻止默认导航行为，改用 scrollIntoView() 直接滚动到目标锚点
 * - 处理所有 hash 链接（href="#"、href="#id"），不干扰外部链接行为
 * - href="#" → 阻止导航 + scrollTo(top)，模拟浏览器默认的回到页首行为
 * - href="#id" 且元素存在 → 阻止导航 + scrollIntoView
 * - href="#nonexistent" → 阻止导航（防止跳转到父窗口 URL），不做特殊操作
 */
export function injectSrcdocHashNavFix(html: string): string {
  // 修复 null-origin 沙箱下所有 hash 链接触发导航（而非滚动）的问题
  const FIX_SCRIPT = `<script>
(function() {
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var hash = a.getAttribute('href');
    if (!hash) return;
    // Always prevent default navigation so WebView2 does not resolve # against the parent URL.
    e.preventDefault();
    if (hash === '#') {
      // href="#" scrolls back to the top, matching normal browser behavior.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var targetId = hash.slice(1);
    var target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // If the target does not exist, navigation has already been blocked; ignore silently.
  }, true);
})();
</script>`;

  // 注入到 </head> 前；若无 head 标签则注入到 <body> 开始处；兜底直接前置
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${FIX_SCRIPT}</head>`);
  }
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    return html.replace(bodyMatch[0], `${bodyMatch[0]}${FIX_SCRIPT}`);
  }
  return FIX_SCRIPT + html;
}

// ============================================================================
// 公开入口
// ============================================================================

/**
 * 将 HTML 中的外部资源完全内联为自包含的单文件
 *
 * 处理流程：
 * 1. 内联外部 CSS（<link> → <style>），并处理 CSS 内的图片引用
 * 2. 内联外部 JS（<script src> → <script>）
 * 3. 扫描合并后 HTML 中剩余的相对路径引用，替换为 base64 data URL
 *
 * @param html - 原始 HTML 字符串
 * @param baseDir - HTML 文件所在目录的绝对路径
 * @returns 完全自包含的 HTML 字符串
 */
export async function inlineHtmlResources(html: string, baseDir: string): Promise<string> {
  logger.debug('[htmlResourceInliner] 开始处理, baseDir:', baseDir);

  // 阶段 1：结构内联 — 将外部 CSS/JS 合并到 HTML 中
  let result = await inlineExternalCss(html, baseDir);
  result = await inlineExternalJs(result, baseDir);

  // 阶段 2：资源替换 — 扫描合并后 HTML 中的所有二进制资源引用
  const resourcePaths = extractBinaryResourcePaths(result);

  if (resourcePaths.length === 0) {
    logger.debug('[htmlResourceInliner] 未检测到二进制资源引用');
    // 即使没有二进制资源也需注入 hash 导航修复脚本，
    // 防止 null-origin 沙箱中 href="#id" 被解析到父窗口 URL 导致白屏
    return injectSrcdocHashNavFix(result);
  }

  logger.debug(
    '[htmlResourceInliner] 检测到',
    resourcePaths.length,
    '个二进制资源:',
    resourcePaths
  );

  const resourceMap = await resolveBinaryResources(resourcePaths, baseDir);
  result = replacePaths(result, resourceMap);

  // 展开包含 data URL 的 CSS 变量引用：
  // WebView2 srcdoc 下 CSS 自定义属性无法可靠存储超大 url(data:...) 值，
  // 需要将 var(--xxx) 直接替换为对应的 url(data:...) 值
  result = expandCssVarDataUrls(result);

  logger.debug(
    '[htmlResourceInliner] 完成, 内嵌',
    resourceMap.size,
    '/',
    resourcePaths.length,
    '个资源'
  );

  // 阶段 3：注入 hash 锚点兼容脚本（修复 null-origin 沙箱下点击 href="#id" 白屏）
  return injectSrcdocHashNavFix(result);
}
