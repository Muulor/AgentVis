/**
 * GenerateImageTool - AI 图像生成工具
 *
 * 默认使用隐藏的 local/gpt-image-2 图像生成路径，失败时回退到 Gemini。
 * - gpt-image-2：通过 local OpenAI-compatible relay 调用 Image API，支持参考图、质量、格式、尺寸控制
 * - gemini：兼容回退，调用 gemini-3.1-flash-image-preview
 * - zhipu(GLM-Image)/minimax(image-01)：可手动指定，仅支持 T2I 和选定宽高比
 *
 * 设计说明：
 * - 不在 UI 模型列表中显式暴露 gpt-image-2，避免被当作 Planning 主模型使用
 * - 不引导 Agent 自动切换到 zhipu/minimax（质量较低，若需引导在SKILL.md中说明并ToolSchema增加描述和在下面源码中增加返回消息提醒）
 * - Gemini 路径：使用 llm_chat_stream，图片内嵌于 markdown
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, writeFile, exists, readFile } from '@tauri-apps/plugin-fs';
import { translate } from '@/i18n';
import type { Tool, ToolSchema, ToolResult, ToolExecutionContext } from '../../tools/types';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useSettingsStore } from '@stores/settingsStore';
import { getLogger } from '@services/logger';
import { LLM_TOKEN_POLICIES } from '@services/llm/LlmTokenPolicy';

const logger = getLogger('GenerateImageTool');

// ═══════════════════════════════════════════════════════════════
// 常量定义
// ═══════════════════════════════════════════════════════════════

/** 图像模型配置：按优先级排序的供应商-模型对 */
const IMAGE_MODEL_CANDIDATES: ReadonlyArray<{ provider: string; model: string }> = [
  { provider: 'gemini', model: 'gemini-3.1-flash-image-preview' },
  // OpenRouter 备选：注意 OpenRouter 账单地址在受限区域时无法访问 Google 模型
  // { provider: 'openrouter', model: 'google/gemini-3.1-flash-image-preview' },
];

const GPT_IMAGE_MODEL = 'gpt-image-2';

// ═══════════════════════════════════════════════════════════════
// 工具 Schema 定义
// ═══════════════════════════════════════════════════════════════

const SCHEMA: ToolSchema = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt using an AI image model. The generated image is saved automatically to the deliverables directory.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Image generation prompt. Describe the scene narratively instead of listing keywords; include lighting, composition, style, and other useful details.',
      },
      provider: {
        type: 'string',
        description:
          'Optional image provider override. Usually leave empty so the tool can use the internal image generation pipeline automatically.',
      },
      ref_image_path: {
        type: 'string',
        description:
          'Optional single reference image file path for image editing, style transfer, or reference-based generation. Use ref_image_paths for multiple images.',
      },
      ref_image_paths: {
        type: 'array',
        items: { type: 'string', description: 'Reference image file path.' },
        description:
          'Optional array of reference image file paths, up to 14 images, for multi-image composition, style blending, and similar tasks.',
      },
      aspect_ratio: {
        type: 'string',
        description:
          'Optional output aspect ratio. Supported: 1:1 (default), 1:4, 1:8, 4:1, 8:1, 16:9, 9:16, 3:2, 2:3, 4:3, 3:4, 4:5, 5:4, 21:9.',
      },
      image_size: {
        type: 'string',
        description: 'Optional output image size. Available values: 1K (default), 2K, 4K.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'auto'],
        description:
          'Optional gpt-image-2 rendering quality. Defaults to auto; use low for drafts/thumbnails and medium or high for final assets.',
      },
      output_format: {
        type: 'string',
        enum: ['png', 'jpeg', 'webp'],
        description:
          'Optional gpt-image-2 output format. Defaults to png; jpeg and webp are also available.',
      },
      output_compression: {
        type: 'number',
        description:
          'Optional jpeg/webp compression level for gpt-image-2, from 0 to 100. Only applies when output_format is jpeg or webp.',
      },
      background: {
        type: 'string',
        enum: ['auto', 'opaque'],
        description:
          'Optional background mode. gpt-image-2 does not support transparent here; use auto or opaque.',
      },
      custom_name: {
        type: 'string',
        description:
          'Optional custom file name without extension, useful for meaningful generated asset names such as "hero_banner" or "logo_dark". Only letters, numbers, underscores, and hyphens are allowed.',
      },
    },
    required: ['prompt'],
  },
};

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** Tauri llm_chat_stream 请求 DTO */
interface ChatRequestDto {
  provider: string;
  messages: Array<{
    role: string;
    content: string;
    images?: Array<{ mime_type: string; data: string }>;
  }>;
  model: string;
  temperature?: number;
  max_tokens?: number;
  base_url?: string;
  /** 响应输出模态（["Text", "Image"] 或 ["Image"]） */
  response_modalities?: string[];
  /** 图像生成配置 */
  image_config?: { aspect_ratio?: string; image_size?: string };
}

/** 流式 chunk 事件 payload */
interface StreamChunkPayload {
  sessionId: string;
  delta: string;
  reasoning?: string;
  done: boolean;
  error?: string;
}

/** 从 markdown 图片语法中提取的图片数据 */
interface ExtractedImage {
  mimeType: string;
  base64Data: string;
}

/** MiniMax 图像生成命令请求 DTO（与 Rust 端类型对齐） */
interface MinimaxImageGenerateRequest {
  prompt: string;
  aspect_ratio?: string;
}

/** MiniMax 图像生成命令响应 DTO（与 Rust 端类型对齐） */
interface MinimaxImageGenerateResponse {
  images_base64: string[];
}

interface GptImageGenerateRequest {
  prompt: string;
  model?: string;
  session_id?: string;
  aspect_ratio?: string;
  image_size?: string;
  quality?: string;
  output_format?: string;
  output_compression?: number;
  background?: string;
  base_url?: string;
  reference_images?: Array<{ mime_type: string; data: string }>;
  stream?: boolean;
}

interface GptImageGenerateResponse {
  images_base64: string[];
  mime_type: string;
}

/** 智谱图像生成命令请求 DTO（与 Rust 端类型对齐） */
interface ZhipuImageGenerateRequest {
  prompt: string;
  aspect_ratio?: string;
}

/** 智谱图像生成命令响应 DTO（与 Rust 端类型对齐） */
interface ZhipuImageGenerateResponse {
  images_base64: string[];
  mime_type: string; // Rust 端从响应 Content-Type 推断，通常为 image/png
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 清理文件夹名称（移除不安全字符）
 *
 * 与 AgentChatView 中的 sanitizeFolderName 保持一致
 */
function sanitizeFolderName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unnamed'
  );
}

/**
 * 从 markdown 格式的图片字符串中提取 base64 数据
 *
 * Gemini chat_stream 将 inlineData 转换为 ![text](data:mime;base64,...) 格式，
 * 此函数逆向解析出 MIME 类型和原始 base64 数据
 */
function extractBase64Images(content: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  // 匹配 markdown 图片语法中的 data URI
  const regex = /!\[.*?\]\(data:(image\/\w+);base64,([A-Za-z0-9+/=]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const mimeType = match[1];
    const base64Data = match[2];
    if (mimeType && base64Data) {
      images.push({ mimeType, base64Data });
    }
  }
  return images;
}

/**
 * 生成文件名
 *
 * 当提供 customName 时，使用自定义名称（清理不安全字符后）；
 * 否则使用带时间戳的自动命名，保持向后兼容
 */
function generateFileName(mimeType: string, index: number, customName?: string): string {
  const extension = mimeType.split('/')[1] ?? 'png';
  // 如果单次只生成一张图，不加索引后缀
  const suffix = index > 0 ? `_${index}` : '';

  if (customName) {
    // 清理自定义名称中的不安全字符，仅保留字母、数字、下划线、连字符
    const safeName =
      customName
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'image';
    return `${safeName}${suffix}.${extension}`;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d+Z$/, '');
  return `generated_${timestamp}${suffix}.${extension}`;
}

/**
 * 读取参考图片并编码为 base64
 *
 * @param imagePath - 图片文件路径
 * @returns MIME 类型和 base64 编码数据，失败时返回 null
 */
async function readReferenceImage(
  imagePath: string
): Promise<{ mimeType: string; base64Data: string } | null> {
  try {
    const fileExists = await exists(imagePath);
    if (!fileExists) {
      logger.warn('[GenerateImageTool] 参考图片不存在:', imagePath);
      return null;
    }

    const bytes = await readFile(imagePath);
    // 将 Uint8Array 转为 base64
    const base64Data = uint8ArrayToBase64(bytes);

    // 根据文件扩展名推断 MIME 类型
    const extension = imagePath.split('.').pop()?.toLowerCase() ?? 'png';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
    };
    const mimeType = mimeMap[extension] ?? 'image/png';

    return { mimeType, base64Data };
  } catch (error) {
    logger.error('[GenerateImageTool] 读取参考图片失败:', error);
    return null;
  }
}

/**
 * 将 Uint8Array 转为 base64 字符串
 *
 * 分块处理以避免大文件导致的栈溢出
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binaryString = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    binaryString += String.fromCharCode(...chunk);
  }
  return btoa(binaryString);
}

function notifyImageGenerationError(message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent('agentvis:image-generation-error', {
        detail: { message },
      })
    );
  } catch {
    // Toast notification is best-effort; the tool result still carries the error.
  }
}

/**
 * 通过 llm_chat_stream 调用图像模型并收集完整响应
 *
 * 设计说明：
 * - 使用流式接口是因为 Gemini chat() 方法只提取 parts[0].text，
 *   丢失了 inlineData（图片数据）
 * - chat_stream 正确解析 inline_data 并转为 markdown 图片格式
 *
 * @returns 收集到的完整文本内容（含 markdown 图片语法）
 */
function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function cancelledResult(): ToolResult {
  return {
    success: false,
    content: translate('tools.generateImage.cancelled'),
  };
}

function cancelledImageResult(): { images: ExtractedImage[]; error?: string } {
  return { images: [], error: translate('tools.generateImage.cancelled') };
}

function cancelledTextResult(): { content: string; error?: string } {
  return { content: '', error: translate('tools.generateImage.cancelled') };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cancelLlmStream(sessionId: string): void {
  void invoke('llm_cancel_stream', { sessionId }).catch(() => undefined);
}

async function invokeWithAbort<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  if (isCancelled(signal)) {
    onAbort?.();
    throw new Error(translate('tools.generateImage.cancelled'));
  }

  if (!signal) {
    return invoke<T>(command, args);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      onAbort?.();
      reject(new Error(translate('tools.generateImage.cancelled')));
    };

    signal.addEventListener('abort', abortHandler, { once: true });

    invoke<T>(command, args)
      .then((result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        resolve(result);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        reject(toError(error));
      });
  });
}

async function callImageModel(
  request: ChatRequestDto,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ content: string; error?: string }> {
  if (isCancelled(signal)) {
    cancelLlmStream(sessionId);
    return cancelledTextResult();
  }

  return new Promise((resolve) => {
    let accumulatedContent = '';
    let settled = false;
    let unlisten: (() => void) | undefined;
    let abortHandler: () => void = () => undefined;

    const settle = (result: { content: string; error?: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abortHandler);
      unlisten?.();
      resolve(result);
    };

    abortHandler = () => {
      cancelLlmStream(sessionId);
      settle(cancelledTextResult());
    };

    signal?.addEventListener('abort', abortHandler, { once: true });

    // 监听流式响应事件
    listen<StreamChunkPayload>('llm-stream-chunk', (event) => {
      const payload = event.payload;
      // 只处理匹配 sessionId 的事件
      if (payload.sessionId !== sessionId) return;

      if (payload.delta) {
        accumulatedContent += payload.delta;
      }

      if (payload.error) {
        settle({ content: accumulatedContent, error: payload.error });
        return;
      }

      if (payload.done) {
        settle({ content: accumulatedContent });
      }
    })
      .then((unlistenFn) => {
        unlisten = unlistenFn;
        if (isCancelled(signal)) {
          abortHandler();
          return;
        }

        // 注册完监听器后再发起请求，避免丢失早期事件
        invoke('llm_chat_stream', {
          request,
          sessionId,
        }).catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          settle({
            content: '',
            error: isCancelled(signal)
              ? translate('tools.generateImage.cancelled')
              : translate('tools.generateImage.llmCallFailed', { error: errorMessage }),
          });
        });
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        settle({
          content: '',
          error: isCancelled(signal)
            ? translate('tools.generateImage.cancelled')
            : translate('tools.generateImage.eventListenFailed', { error: errorMessage }),
        });
      });
  });
}

/**
 * 调用 MiniMax image-01 模型生成图片（仅 T2I，作为 Gemini 失败时的备用）
 *
 * 设计说明：
 * - MiniMax 图像 API 只支持 T2I；I2I 的 subject_reference.image_file 只接受 URL，
 *   本地图片无法传入，因此有参考图时由 execute() 层决策跳过此函数
 * - aspect_ratio 映射（Gemini 专有比例 → MiniMax 最近比例）在 Rust 端完成
 * - 返回 ExtractedImage[]，mimeType 固定为 image/jpeg（MiniMax 返回 JPEG）
 */
async function callGptImageModel(
  prompt: string,
  aspectRatio: string | undefined,
  imageSize: string | undefined,
  quality: string | undefined,
  outputFormat: string | undefined,
  outputCompression: number | undefined,
  background: string | undefined,
  baseUrl: string | undefined,
  referenceImages: Array<{ mime_type: string; data: string }>,
  signal?: AbortSignal
): Promise<{ images: ExtractedImage[]; error?: string }> {
  if (isCancelled(signal)) return cancelledImageResult();
  const sessionId = `generate_image_gpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const request: GptImageGenerateRequest = {
      prompt,
      model: useSettingsStore.getState().imageGenerationModel || GPT_IMAGE_MODEL,
      session_id: sessionId,
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
      ...(imageSize && { image_size: imageSize }),
      ...(quality && { quality }),
      ...(outputFormat && { output_format: outputFormat }),
      ...(typeof outputCompression === 'number' && { output_compression: outputCompression }),
      ...(background && { background }),
      ...(baseUrl && { base_url: baseUrl }),
      ...(referenceImages.length > 0 && { reference_images: referenceImages }),
      ...(useSettingsStore.getState().imageGenerationUseStreaming && { stream: true }),
    };

    const response = await invokeWithAbort<GptImageGenerateResponse>(
      'gpt_image_generate',
      { request },
      signal,
      () => cancelLlmStream(sessionId)
    );

    if (isCancelled(signal)) return cancelledImageResult();

    if (response.images_base64.length === 0) {
      return { images: [], error: translate('tools.generateImage.gptNoData') };
    }

    const images: ExtractedImage[] = response.images_base64.map((b64) => ({
      mimeType: response.mime_type || 'image/png',
      base64Data: b64,
    }));

    return { images };
  } catch (error) {
    if (isCancelled(signal)) return cancelledImageResult();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      images: [],
      error: translate('tools.generateImage.gptCommandFailed', { error: errorMessage }),
    };
  }
}

async function callMiniMaxImageModel(
  prompt: string,
  aspectRatio: string | undefined,
  signal?: AbortSignal
): Promise<{ images: ExtractedImage[]; error?: string }> {
  if (isCancelled(signal)) return cancelledImageResult();

  try {
    const request: MinimaxImageGenerateRequest = {
      prompt,
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
    };

    const response = await invokeWithAbort<MinimaxImageGenerateResponse>(
      'minimax_image_generate',
      { request },
      signal
    );

    if (isCancelled(signal)) return cancelledImageResult();

    if (response.images_base64.length === 0) {
      return { images: [], error: translate('tools.generateImage.minimaxApiEmpty') };
    }

    // 将 base64 数组转换为 ExtractedImage 格式（MIME 固定为 JPEG）
    const images: ExtractedImage[] = response.images_base64.map((b64) => ({
      mimeType: 'image/jpeg',
      base64Data: b64,
    }));

    return { images };
  } catch (error) {
    if (isCancelled(signal)) return cancelledImageResult();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      images: [],
      error: translate('tools.generateImage.minimaxCommandFailed', { error: errorMessage }),
    };
  }
}

/**
 * 调用智谱 GLM-Image 模型生成图片（T2I，作为第三备选 provider）
 *
 * 设计说明：
 * - 智谱 API 返回图片 URL（有效期 30 天），Rust 端下载后转为 base64 传回
 * - aspect_ratio 在 Rust 端映射到 glm-image 的 WxH size 参数
 * - 无法使用参考图（API 不支持），由 execute() 层拒绝并给出说明
 */
async function callZhipuImageModel(
  prompt: string,
  aspectRatio: string | undefined,
  signal?: AbortSignal
): Promise<{ images: ExtractedImage[]; error?: string }> {
  if (isCancelled(signal)) return cancelledImageResult();

  try {
    const request: ZhipuImageGenerateRequest = {
      prompt,
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
    };

    const response = await invokeWithAbort<ZhipuImageGenerateResponse>(
      'zhipu_image_generate',
      { request },
      signal
    );

    if (isCancelled(signal)) return cancelledImageResult();

    if (response.images_base64.length === 0) {
      return { images: [], error: translate('tools.generateImage.zhipuApiEmpty') };
    }

    // 将 base64 数组转换为 ExtractedImage 格式（MIME 类型由 Rust 端推断）
    const images: ExtractedImage[] = response.images_base64.map((b64) => ({
      mimeType: response.mime_type || 'image/png',
      base64Data: b64,
    }));

    return { images };
  } catch (error) {
    if (isCancelled(signal)) return cancelledImageResult();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      images: [],
      error: translate('tools.generateImage.zhipuCommandFailed', { error: errorMessage }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具实现
// ═══════════════════════════════════════════════════════════════

class GenerateImageToolImpl implements Tool {
  readonly schema = SCHEMA;

  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const prompt = params.prompt as string;
    const provider = (params.provider as string | undefined)?.trim() ?? 'auto';

    if (!prompt) {
      return { success: false, content: translate('tools.generateImage.missingPrompt') };
    }

    if (isCancelled(context.signal)) return cancelledResult();

    try {
      // ─── MiniMax 路径 ───────────────────────────────────────────
      if (provider === 'auto') {
        const gptResult = await this.runGptImage(prompt, params, context, true);
        if (gptResult.success) return gptResult;
        if (isCancelled(context.signal)) return cancelledResult();

        logger.warn(
          '[GenerateImageTool] gpt-image-2 path failed, falling back to Gemini:',
          gptResult.content
        );
        context.onProgress?.(translate('tools.generateImage.fallbackGemini'));
        const geminiResult = await this.runGemini(prompt, params, context);
        if (isCancelled(context.signal)) return cancelledResult();
        if (!geminiResult.success) {
          notifyImageGenerationError(gptResult.content);
          return {
            ...geminiResult,
            content: `${geminiResult.content}\n\n${translate('tools.generateImage.serviceInfo', { info: gptResult.content })}`,
          };
        }
        return geminiResult;
      }

      if (provider === 'local' || provider === GPT_IMAGE_MODEL) {
        return await this.runGptImage(prompt, params, context, false);
      }

      if (provider === 'minimax') {
        return await this.runMiniMax(prompt, params, context);
      }

      // ─── 智谱 路径 ───────────────────────────────────────────
      if (provider === 'zhipu') {
        return await this.runZhipu(prompt, params, context);
      }

      // ─── Gemini 路径（默认） ──────────────────────────────────────
      return await this.runGemini(prompt, params, context);
    } catch (error) {
      if (isCancelled(context.signal)) return cancelledResult();
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: translate('tools.generateImage.failed', { error: errorMessage }),
      };
    }
  }

  /**
   * Gemini 图像生成路径
   *
   * 使用 llm_chat_stream + gemini-3.1-flash-image-preview 生成图片。
   * 支持参考图、image_size、全宽高比。
   * 失败时直接返回错误，不自动降级到 MiniMax。
   */
  private async runGptImage(
    prompt: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
    silentFailure: boolean
  ): Promise<ToolResult> {
    if (isCancelled(context.signal)) return cancelledResult();

    const singlePath = params.ref_image_path as string | undefined;
    const multiPaths = params.ref_image_paths as string[] | undefined;
    const allRefPaths: string[] = [...(singlePath ? [singlePath] : []), ...(multiPaths ?? [])];

    context.onProgress?.(translate('tools.generateImage.prepareGpt', { model: GPT_IMAGE_MODEL }));

    const MAX_REFERENCE_IMAGES = 14;
    const refImages: Array<{ mime_type: string; data: string }> = [];
    for (const refPath of allRefPaths.slice(0, MAX_REFERENCE_IMAGES)) {
      if (isCancelled(context.signal)) return cancelledResult();
      const img = await readReferenceImage(refPath);
      if (!img) {
        return {
          success: false,
          content: translate('tools.generateImage.gptReadRefFailed', { path: refPath }),
        };
      }
      refImages.push({ mime_type: img.mimeType, data: img.base64Data });
    }

    const aspectRatio = params.aspect_ratio as string | undefined;
    const imageSize = params.image_size as string | undefined;
    const quality = params.quality as string | undefined;
    const outputFormat = params.output_format as string | undefined;
    const outputCompression = params.output_compression as number | undefined;
    const background = params.background as string | undefined;
    const customName = params.custom_name as string | undefined;
    const imageSettings = useSettingsStore.getState();
    const baseUrl = imageSettings.imageGenerationApiUrl.trim() || undefined;

    context.onProgress?.(translate('tools.generateImage.gptProgress', { model: GPT_IMAGE_MODEL }));
    logger.info('[GenerateImageTool] Using image-generation gpt-image-2 service');

    const result = await callGptImageModel(
      prompt,
      aspectRatio,
      imageSize,
      quality,
      outputFormat,
      outputCompression,
      background,
      baseUrl,
      refImages,
      context.signal
    );
    if (isCancelled(context.signal)) return cancelledResult();
    if (result.error || result.images.length === 0) {
      if (!silentFailure) {
        notifyImageGenerationError(result.error ?? 'no image data returned');
      }
      return {
        success: false,
        content: silentFailure
          ? translate('tools.generateImage.gptUnavailable', {
              error: result.error ?? translate('tools.generateImage.gptNoData'),
            })
          : translate('tools.generateImage.gptFailed', {
              error: result.error ?? translate('tools.generateImage.gptNoData'),
            }),
      };
    }

    return await this.saveAndReturn(result.images, context, GPT_IMAGE_MODEL, customName);
  }

  private async runGemini(
    prompt: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    if (isCancelled(context.signal)) return cancelledResult();

    // 兼容单张和多张参考图参数，合并为统一的路径数组
    const singlePath = params.ref_image_path as string | undefined;
    const multiPaths = params.ref_image_paths as string[] | undefined;
    const allRefPaths: string[] = [...(singlePath ? [singlePath] : []), ...(multiPaths ?? [])];

    context.onProgress?.(translate('tools.generateImage.prepareGemini'));

    // 1. 读取所有参考图片并编码为 base64（最多 14 张，Gemini 限制）
    const MAX_REFERENCE_IMAGES = 14;
    const refImages: Array<{ mime_type: string; data: string }> = [];
    for (const refPath of allRefPaths.slice(0, MAX_REFERENCE_IMAGES)) {
      if (isCancelled(context.signal)) return cancelledResult();
      const img = await readReferenceImage(refPath);
      if (!img) {
        return {
          success: false,
          content: translate('tools.generateImage.readRefFailed', { path: refPath }),
        };
      }
      refImages.push({ mime_type: img.mimeType, data: img.base64Data });
      logger.trace('[GenerateImageTool] 已加载参考图片:', refPath);
    }

    // 2. 构建消息（支持多张参考图片注入）
    const messages: ChatRequestDto['messages'] = [
      {
        role: 'user',
        content: prompt,
        ...(refImages.length > 0 && { images: refImages }),
      },
    ];

    // 3. 尝试图像模型候选列表
    const sessionId = `generate_image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let lastError = '';

    for (const candidate of IMAGE_MODEL_CANDIDATES) {
      if (isCancelled(context.signal)) return cancelledResult();
      context.onProgress?.(
        translate('tools.generateImage.generatingWith', {
          provider: candidate.provider,
          model: candidate.model,
        })
      );

      const aspectRatio = params.aspect_ratio as string | undefined;
      const imageSize = params.image_size as string | undefined;

      const request: ChatRequestDto = {
        provider: candidate.provider,
        model: candidate.model,
        messages,
        temperature: 1.0,
        max_tokens: LLM_TOKEN_POLICIES.imageGeneration.primaryMaxTokens,
        response_modalities: ['Text', 'Image'],
        ...((aspectRatio ?? imageSize) && {
          image_config: {
            ...(aspectRatio && { aspect_ratio: aspectRatio }),
            ...(imageSize && { image_size: imageSize }),
          },
        }),
      };

      logger.trace('[GenerateImageTool] 尝试图像模型:', candidate.provider, candidate.model);

      const result = await callImageModel(request, sessionId, context.signal);
      if (isCancelled(context.signal)) return cancelledResult();

      if (result.error) {
        lastError = result.error;
        logger.warn(
          `[GenerateImageTool] ${candidate.provider}/${candidate.model} 失败:`,
          result.error
        );
        continue;
      }

      // 4. 从响应内容中提取 base64 图片
      const extractedImages = extractBase64Images(result.content);
      if (extractedImages.length === 0) {
        lastError = translate('tools.generateImage.noImageData', { model: candidate.model });
        logger.warn('[GenerateImageTool]', lastError, '响应:', result.content.slice(0, 200));
        if (result.content.trim()) {
          return {
            success: false,
            content: translate('tools.generateImage.modelNoImage', {
              response: result.content.slice(0, 500),
            }),
          };
        }
        continue;
      }

      // 5. 保存并返回
      const customName = params.custom_name as string | undefined;
      return await this.saveAndReturn(extractedImages, context, 'Gemini', customName);
    }

    // 当前图像模型调用失败，提示用户重试，不引导 Agent 切换备用模型
    return {
      success: false,
      content: translate('tools.generateImage.currentModelFailed', { error: lastError }),
    };
  }

  /**
   * MiniMax 图像生成路径
   *
   * 直接调用 minimax_image_generate Tauri 命令（T2I 模式）。
   * 不支持参考图（仅 URL 参考图，本地图片无法传入）。
   * 不支持 image_size（分辨率由宽高比隐式决定）。
   */
  private async runMiniMax(
    prompt: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    if (isCancelled(context.signal)) return cancelledResult();

    // 防御性校验：明确拒绝 minimax 不支持的参数，给出清晰提示
    const hasRefImages = !!(params.ref_image_path ?? params.ref_image_paths);
    if (hasRefImages) {
      return {
        success: false,
        content: translate('tools.generateImage.minimaxNoLocalRef'),
      };
    }

    context.onProgress?.(translate('tools.generateImage.minimaxProgress'));
    logger.info('[GenerateImageTool] 使用 MiniMax image-01 生成图片');

    const aspectRatio = params.aspect_ratio as string | undefined;
    // image_size 不传给 MiniMax（MiniMax 通过宽高比隐式控制分辨率）
    const minimaxResult = await callMiniMaxImageModel(prompt, aspectRatio, context.signal);
    if (isCancelled(context.signal)) return cancelledResult();

    if (minimaxResult.error || minimaxResult.images.length === 0) {
      return {
        success: false,
        content: translate('tools.generateImage.minimaxFailed', {
          error: minimaxResult.error ?? translate('tools.generateImage.minimaxNoData'),
        }),
      };
    }

    const customName = params.custom_name as string | undefined;
    return await this.saveAndReturn(minimaxResult.images, context, 'MiniMax image-01', customName);
  }

  /**
   * 智谱 GLM-Image 图像生成路径
   *
   * 调用 zhipu_image_generate Tauri 命令，Rust 端负责下载 URL 转 base64。
   * 不支持参考图（glm-image 无此能力），不支持 image_size（由宽高比控制分辨率）。
   */
  private async runZhipu(
    prompt: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    if (isCancelled(context.signal)) return cancelledResult();

    // 防御性校验：明确拒绝参考图，给出清晰提示
    const hasRefImages = !!(params.ref_image_path ?? params.ref_image_paths);
    if (hasRefImages) {
      return {
        success: false,
        content: translate('tools.generateImage.zhipuNoRef'),
      };
    }

    context.onProgress?.(translate('tools.generateImage.zhipuProgress'));
    logger.info('[GenerateImageTool] 使用智谱 GLM-Image 生成图片');

    const aspectRatio = params.aspect_ratio as string | undefined;
    // image_size 不传给智谱（分辨率由 aspect_ratio → size 映射隐式决定）
    const zhipuResult = await callZhipuImageModel(prompt, aspectRatio, context.signal);
    if (isCancelled(context.signal)) return cancelledResult();

    if (zhipuResult.error || zhipuResult.images.length === 0) {
      return {
        success: false,
        content: translate('tools.generateImage.zhipuFailed', {
          error: zhipuResult.error ?? translate('tools.generateImage.zhipuNoData'),
        }),
      };
    }

    const customName = params.custom_name as string | undefined;
    return await this.saveAndReturn(
      zhipuResult.images,
      context,
      translate('tools.generateImage.zhipuModelLabel'),
      customName
    );
  }

  /**
   * 公共辅助：保存图片、发射刷新事件、返回成功结果
   */
  private async saveAndReturn(
    images: ExtractedImage[],
    context: ToolExecutionContext,
    modelLabel: string,
    customName?: string
  ): Promise<ToolResult> {
    if (isCancelled(context.signal)) return cancelledResult();
    context.onProgress?.(translate('tools.generateImage.saveProgress'));
    const savedPaths = await this.saveImages(images, context, customName);
    if (isCancelled(context.signal)) return cancelledResult();

    if (savedPaths.length === 0) {
      return { success: false, content: translate('tools.generateImage.saveFailed') };
    }

    // 发射事件通知右栏 FileList 刷新
    try {
      const { emit } = await import('@tauri-apps/api/event');
      for (const filePath of savedPaths) {
        await emit('file:deliverable_created', { agentId: context.agentId, filePath });
      }
    } catch (emitError) {
      logger.warn('[GenerateImageTool] 发射刷新事件失败:', emitError);
    }

    const pathList = savedPaths.map((p) => `- ${p}`).join('\n');
    return {
      success: true,
      content: translate('tools.generateImage.success', {
        count: savedPaths.length,
        model: modelLabel,
        paths: pathList,
      }),
      data: { savedPaths, imageCount: savedPaths.length },
    };
  }

  /**
   * 保存提取的图片到 deliverables 目录
   *
   * 路径格式: {appData}/deliverables/{hubName}/{agentName}/{fileName}
   * 与 AgentChatView.handleImageSave 保持一致
   */
  private async saveImages(
    images: ExtractedImage[],
    context: ToolExecutionContext,
    customName?: string
  ): Promise<string[]> {
    const savedPaths: string[] = [];
    if (isCancelled(context.signal)) return savedPaths;

    try {
      // 优先使用 AgentLoop 注入到 context 的 hub/agent 名称（从 workdir 路径解析，最可靠）。
      // 仅在 context 字段缺失时才通过 Store 查找（向后兼容老调用路径）。
      let hubName: string;
      let agentName: string;

      if (context.hubName && context.agentName) {
        // context 注入路径：AgentLoop 已从 workdir 解析好，直接使用
        hubName = context.hubName;
        agentName = context.agentName;
      } else {
        // Store 查找路径（fallback）：如果 Store 未就绪，图片将进入 'shared/{agentId前8位}' 目录
        // 注意：不再使用 'default'/'unknown'，避免与 Hub 视图的 FileList fallback 目录撞名
        const agent = context.agentId
          ? useAgentStore.getState().agents.find((a) => a.id === context.agentId)
          : undefined;
        const hub = agent
          ? useHubStore.getState().hubs.find((h) => h.id === agent.hubId)
          : undefined;
        hubName = sanitizeFolderName(hub?.name ?? 'shared');
        agentName = sanitizeFolderName(agent?.name ?? context.agentId?.slice(0, 8) ?? 'agent');
      }

      // 构建保存目录路径
      if (isCancelled(context.signal)) return savedPaths;
      const appData = await appDataDir();
      const dirPath = await join(appData, 'deliverables', hubName, agentName);

      // 确保目录存在
      await mkdir(dirPath, { recursive: true });
      if (isCancelled(context.signal)) return savedPaths;

      for (let i = 0; i < images.length; i++) {
        if (isCancelled(context.signal)) return savedPaths;
        const image = images[i];
        if (!image) continue;
        const fileName = generateFileName(image.mimeType, i, customName);
        const filePath = await join(dirPath, fileName);

        // 将 base64 解码为二进制并写入文件
        const binaryString = atob(image.base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let j = 0; j < binaryString.length; j++) {
          bytes[j] = binaryString.charCodeAt(j);
        }

        if (isCancelled(context.signal)) return savedPaths;
        await writeFile(filePath, bytes);
        savedPaths.push(filePath);
        logger.trace('[GenerateImageTool] 图片已保存:', filePath);
      }
    } catch (error) {
      logger.error('[GenerateImageTool] 保存图片失败:', error);
    }

    return savedPaths;
  }
}

/**
 * 导出单例实例
 */
export const generateImageTool = new GenerateImageToolImpl();
