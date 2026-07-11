/**
 * ReadTool - 文件读取工具
 *
 * 读取文件内容，支持行号范围限制
 *
 * 技能定义: SKILL.md
 * 工具实现: 本文件
 */

import { invoke } from '@tauri-apps/api/core';
import { readDir } from '@tauri-apps/plugin-fs';
import { translate } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { getLogger } from '@services/logger';
import { estimateTokens } from '../../sub-agents/ToolOutputCompressor';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';
import { loadImageAttachmentFromPath } from '../shared/imageAttachment';
import { getSandboxPathViolation } from '../shared/sandboxPath';

const logger = getLogger('tool');

const VISUAL_SINGLE_QUOTE_CHARS = /[\u2018\u2019\u201A\u201B\uFF07]/g;
const VISUAL_DOUBLE_QUOTE_CHARS = /[\u201C\u201D\u201E\u201F\uFF02]/g;
const VISUAL_DASH_CHARS = /[\u2010-\u2015\u2212]/g;

interface PathParts {
  parent: string;
  fileName: string;
  separator: string;
}

interface ReadContentResolution {
  content: string;
  path: string;
  requestedPath?: string;
}

function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, code: string) => {
    return String.fromCharCode(Number.parseInt(code, 16));
  });
}

export function createVisualPathMatchKey(value: string): string {
  return decodeUnicodeEscapes(value)
    .normalize('NFC')
    .replace(VISUAL_SINGLE_QUOTE_CHARS, "'")
    .replace(VISUAL_DOUBLE_QUOTE_CHARS, '"')
    .replace(VISUAL_DASH_CHARS, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function splitPathParts(inputPath: string): PathParts | null {
  const slashIndex = inputPath.lastIndexOf('/');
  const backslashIndex = inputPath.lastIndexOf('\\');
  const separatorIndex = Math.max(slashIndex, backslashIndex);
  if (separatorIndex < 0) return null;

  const fileName = inputPath.slice(separatorIndex + 1);
  if (!fileName) return null;

  return {
    parent: inputPath.slice(0, separatorIndex),
    fileName,
    separator: inputPath.charAt(separatorIndex),
  };
}

export function findUniqueVisualSiblingPath(
  inputPath: string,
  siblingNames: string[]
): string | null {
  const decodedInputPath = decodeUnicodeEscapes(inputPath);
  const parts = splitPathParts(decodedInputPath);
  if (!parts) return null;

  const requestedKey = createVisualPathMatchKey(parts.fileName);
  const shouldExcludeSameName = decodedInputPath === inputPath;
  const matches = siblingNames.filter((name) => {
    return (
      (!shouldExcludeSameName || name !== parts.fileName) &&
      createVisualPathMatchKey(name) === requestedKey
    );
  });

  if (matches.length !== 1) return null;
  return `${parts.parent}${parts.separator}${matches[0] ?? ''}`;
}

/**
 * 工具 Schema
 */
const SCHEMA: ToolSchema = {
  name: 'read',
  description: 'Read file or image content. Optionally read only a specific line range.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the file to read.',
      },
      startLine: {
        type: 'number',
        description: 'Optional starting line number, 1-based.',
      },
      endLine: {
        type: 'number',
        description: 'Optional ending line number, inclusive.',
      },
    },
    required: ['path'],
  },
};

/**
 * ReadTool 实现
 */
class ReadToolImpl implements Tool {
  readonly schema = SCHEMA;

  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    // 参数别名容错：不同 LLM 对参数命名有不同偏好
    // Claude 倾向用 file_path，Gemini 用 path，GPT 可能用 filePath
    let path = (params.path ?? params.file_path ?? params.filePath) as string;
    const startLine = (params.startLine ?? params.start_line) as number | undefined;
    const endLine = (params.endLine ?? params.end_line) as number | undefined;

    if (!path) {
      return {
        success: false,
        content: translate('tools.read.missingPath'),
      };
    }

    // 路径规范化（与 file_write 保持一致）
    path = this.resolvePath(path, context.workdir);
    const sandboxViolation = getSandboxPathViolation(path, context);
    if (sandboxViolation) {
      return {
        success: false,
        content:
          sandboxViolation.reason === 'missingWorkdir'
            ? translate('tools.common.sandboxMissingWorkdir', { path })
            : translate('tools.common.sandboxPathDenied', {
                path,
                root: sandboxViolation.root,
                mode: sandboxViolation.mode,
              }),
      };
    }
    logger.debug(`[ReadTool] 解析后的路径: ${path}`);

    // 图片文件检测：自动压缩后传递给多模态模型
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const ext = path.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1');
    if (imageExtensions.includes(ext)) {
      try {
        // 可压缩格式：通过 ImageCompressionService 执行 WebP 转换 + 缩放
        // svg/bmp/gif 不适合 Canvas 压缩，回退到直接 base64 读取
        const compressibleExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        if (compressibleExtensions.includes(ext)) {
          return await this.readImageWithCompression(path, context);
        }
        // 不可压缩格式：直接 base64 读取
        return await this.readImageRaw(path, context);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          content: translate('tools.read.imageReadFailed', { path, error: errorMessage }),
        };
      }
    }

    try {
      // 调用后端读取文件；精确路径失败时，对同目录视觉等价文件名做唯一候选回退
      const readResolution = await this.readTextContentWithVisualPathFallback(path);
      const content = readResolution.content;
      const requestedPath = readResolution.requestedPath;
      path = readResolution.path;

      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // ── 双重截断策略 ──────────────────────────────────────────────────
      // 目标：单次工具输出真实低于 L1 压缩阈值（ToolOutputCompressor 将此阈值内的输出完整保留）
      // 直接复用 estimateTokens() 实时按行累算，中英文混合场景均准确
      //
      // 重要：estimateTokens() 是启发式估算，实测比 LLM 真实 tokenizer 系统性低估约 17%。
      const META_RESERVE_TOKENS = 100; // 估算误差 + META 后缀的综合 buffer
      const EFFECTIVE_LIMIT =
        PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_THRESHOLD_L1 - META_RESERVE_TOKENS;
      const MAX_LINES_PER_READ = 700; // 行数调度上限（小文件第二道防线）

      // 计算本次读取的起始行（0-indexed）
      const startIdx = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
      const requestedEndIdx = endLine ?? totalLines;

      // 按行累积 token（含行号前缀，与实际输出格式一致），找到不超过 EFFECTIVE_LIMIT 的截止行
      let accumTokens = 0;
      let actualEndIdx = startIdx;
      const lineLimit = Math.min(requestedEndIdx, startIdx + MAX_LINES_PER_READ);
      for (let i = startIdx; i < lineLimit && i < totalLines; i++) {
        // 按实际输出格式估算：行号前缀 + 内容 + 换行
        const lineWithPrefix = `${i + 1}: ${allLines[i] ?? ''}\n`;
        const lineTokens = estimateTokens(lineWithPrefix);
        if (accumTokens + lineTokens > EFFECTIVE_LIMIT && actualEndIdx > startIdx) {
          // 已有内容且再加会超标，就此截止
          break;
        }
        accumTokens += lineTokens;
        actualEndIdx = i + 1;
      }
      // 保证至少返回一行（避免单行巨文件永远截不出内容）
      if (actualEndIdx === startIdx && startIdx < totalLines) {
        actualEndIdx = startIdx + 1;
      }

      const hasMore = actualEndIdx < totalLines;

      // 提取目标行并为每行添加行号前缀，帮助模型精确定位修改位置
      const selectedLines = allLines.slice(startIdx, actualEndIdx);
      const result = selectedLines.map((line, i) => `${startIdx + i + 1}: ${line}`).join('\n');

      // 在返回内容末尾附加 READ_META 元信息块，使 SA 能主动感知文件是否还有未读部分
      // SA 看到 hasMore=true 后应继续以 startLine=<nextStart> 调用 read，而不是假设已读完整文件
      const nextStart = actualEndIdx + 1;
      const metaSuffix = hasMore
        ? translate('tools.read.metaHasMore', {
            totalLines,
            returnedLines: actualEndIdx - startIdx,
            startLine: startIdx + 1,
            endLine: actualEndIdx,
            tokens: accumTokens,
            nextStart,
          })
        : `\n\n[READ_META] totalLines=${totalLines} returnedLines=${actualEndIdx - startIdx} startLine=${startIdx + 1} endLine=${actualEndIdx} hasMore=false`;
      const resolutionPrefix = requestedPath
        ? translate('tools.read.pathAutoResolved', { requestedPath, resolvedPath: path })
        : '';

      // 报告进度
      context.onProgress?.(translate('tools.read.readProgress', { path }));

      return {
        success: true,
        content: resolutionPrefix + result + metaSuffix,
        data: {
          path,
          requestedPath,
          totalLines,
          returnedLines: actualEndIdx - startIdx,
          startLine: startIdx + 1,
          endLine: actualEndIdx,
          hasMore,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 文件不存在时追加 local_search 引导
      // LLM 经常幻觉出看似合理但实际不存在的路径（如 rendering → 实际为 render）
      let hint = '';
      const isPathNotFound = this.isPathNotFoundError(errorMessage);

      if (isPathNotFound) {
        const fileName = path.split(/[\\/]/).pop() ?? '';
        hint = translate('tools.read.pathHint', { fileName });
      }

      return {
        success: false,
        content: translate('tools.read.readFailed', { path, error: errorMessage, hint }),
      };
    }
  }

  private isPathNotFoundError(errorMessage: string): boolean {
    const lowerErrorMessage = errorMessage.toLowerCase();
    return (
      errorMessage.includes('\u4e0d\u5b58\u5728') ||
      lowerErrorMessage.includes('not found') ||
      lowerErrorMessage.includes('no such file') ||
      lowerErrorMessage.includes('cannot find') ||
      lowerErrorMessage.includes('could not find') ||
      lowerErrorMessage.includes('does not exist')
    );
  }

  private async readTextContentWithVisualPathFallback(
    path: string
  ): Promise<ReadContentResolution> {
    try {
      return {
        content: await invoke<string>('file_read_content', { filePath: path }),
        path,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!this.isPathNotFoundError(errorMessage)) {
        throw error;
      }

      const candidatePath = await this.findVisualSiblingPath(path);
      if (!candidatePath) {
        throw error;
      }

      logger.info(`[ReadTool] 路径未命中，改用同目录视觉匹配候选: ${candidatePath}`);
      return {
        content: await invoke<string>('file_read_content', { filePath: candidatePath }),
        path: candidatePath,
        requestedPath: path,
      };
    }
  }

  private async findVisualSiblingPath(path: string): Promise<string | null> {
    const parts = splitPathParts(decodeUnicodeEscapes(path));
    if (!parts) return null;

    try {
      const entries = await readDir(parts.parent);
      const siblingNames = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
      return findUniqueVisualSiblingPath(path, siblingNames);
    } catch (error) {
      logger.warn('[ReadTool] 同目录视觉路径回退扫描失败:', error);
      return null;
    }
  }

  /**
   * 解析路径为绝对路径
   *
   * 规范化策略（与 file_write 保持一致）:
   * - Windows 绝对路径(C:\...) → 直接返回
   * - Unix 绝对路径(/home/...) → 提取文件名,作为相对路径
   * - 相对路径(./file.md, file.md) → 移除 ./ 前缀,拼接 workdir
   */
  private resolvePath(inputPath: string, workdir?: string): string {
    logger.trace(`[ReadTool] 路径解析: 输入="${inputPath}", workdir="${workdir ?? ''}"`);

    // Windows 绝对路径检测
    const isWindowsAbsolute = /^[a-zA-Z]:[/\\]/.test(inputPath);

    if (isWindowsAbsolute) {
      logger.trace(`[ReadTool] 检测到 Windows 绝对路径,直接返回`);
      return inputPath;
    }

    if (!workdir) {
      logger.warn('[ReadTool] 无 workdir，无法解析相对路径:', inputPath);
      return inputPath;
    }

    // Unix 绝对路径处理(在 Windows 上,将其视为相对路径)
    // 例如: /home/user/file.md → file.md
    let relativePath = inputPath;
    if (relativePath.startsWith('/')) {
      // 提取最后一个路径部分作为文件名
      const parts = relativePath.split('/').filter((p) => p.length > 0);
      relativePath = parts[parts.length - 1] ?? relativePath;
      logger.warn(
        `[ReadTool] 检测到 Unix 风格绝对路径 "${inputPath}",` +
          `已提取文件名 "${relativePath}" 作为相对路径。` +
          `建议 Sub-Agent 直接使用简单文件名以避免路径混淆。`
      );
    }

    // 移除 ./ 前缀
    if (relativePath.startsWith('./')) {
      relativePath = relativePath.slice(2);
      logger.trace(`[ReadTool] 移除 ./ 前缀,规范化为: "${relativePath}"`);
    }

    // 拼接路径
    const separator = workdir.includes('\\') ? '\\' : '/';
    const normalizedWorkdir = workdir.endsWith(separator) ? workdir.slice(0, -1) : workdir;
    const resolvedPath = `${normalizedWorkdir}${separator}${relativePath}`;

    logger.trace(`[ReadTool] 最终解析路径: "${resolvedPath}"`);
    return resolvedPath;
  }

  /**
   * 压缩后读取图片（png/jpg/jpeg/webp）
   *
   * 使用 ImageCompressionService 执行长边缩放 + WebP 80% 质量压缩，
   * 大幅减少 base64 体积，降低上下文窗口占用。
   */
  private async readImageWithCompression(
    path: string,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const loaded = await loadImageAttachmentFromPath(path, context.workdir);
    logger.trace(`[ReadTool] 📷 图片压缩完成: ${loaded.path}, WebP`);
    context.onProgress?.(translate('tools.read.compressedImageProgress', { path }));

    return {
      success: true,
      content: translate('tools.read.imageLoaded', { path }),
      data: { path, isImage: true, compressed: true },
      images: [loaded.image],
    };
  }

  /**
   * 直接读取图片（svg/bmp/gif 等不可 Canvas 压缩的格式）
   */
  private async readImageRaw(path: string, context: ToolExecutionContext): Promise<ToolResult> {
    const loaded = await loadImageAttachmentFromPath(path, context.workdir);

    logger.trace(
      `[ReadTool] 📷 直接读取图片(无压缩): ${loaded.path}, MIME: ${loaded.image.mimeType}`
    );
    context.onProgress?.(translate('tools.read.rawImageProgress', { path }));

    return {
      success: true,
      content: translate('tools.read.imageLoaded', { path }),
      data: { path, isImage: true },
      images: [loaded.image],
    };
  }
}

/**
 * 导出单例实例
 */
export const readTool = new ReadToolImpl();
