/**
 * Provider-neutral token estimates for StatusBar context capacity reporting.
 *
 * These estimates intentionally trade tokenizer-specific precision for one
 * complete and auditable application-wide fallback. Provider-reported usage
 * remains authoritative when it is available.
 */

const CJK_TOKEN_RATIO = 1.5;
const OTHER_TOKEN_RATIO = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const REQUEST_PRIMER_TOKENS = 2;

/** Fixed fallback for one already-preprocessed image; never estimate from base64 length. */
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1024;

export interface TokenEstimateToolCall {
  name?: string;
  args?: unknown;
  id?: string;
  thoughtSignature?: string;
}

export interface TokenEstimateMessage {
  role?: string;
  content?: string;
  reasoningContent?: string;
  reasoningDetails?: unknown;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: readonly TokenEstimateToolCall[];
  images?: readonly unknown[];
}

export interface RequestTokenEstimateOptions {
  tools?: unknown;
  imageTokenEstimate?: number;
}

function stringifyForEstimate(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return value.name;

  try {
    const serialized = JSON.stringify(value);
    return serialized;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function estimateStagedContentTokens(args: unknown): number {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 0;

  const staged = args as Record<string, unknown>;
  if (staged.contentStaged !== true) return 0;

  const contentChars = normalizeReportedTokenCount(staged.contentChars);
  if (!contentChars) return 0;

  const contentBytes = normalizeReportedTokenCount(staged.contentBytes) ?? contentChars;
  // The backend replaces large file_write content before WebView IPC. Infer the
  // missing mixed-language body from its retained byte/character metadata so the
  // compact staging reference does not make Current Context drop by tens of KB.
  const inferredCjkChars = Math.min(
    contentChars,
    Math.max(0, Math.round((contentBytes - contentChars) / 2))
  );
  const inferredOtherChars = contentChars - inferredCjkChars;

  return (
    Math.ceil(inferredCjkChars / CJK_TOKEN_RATIO) +
    Math.ceil(inferredOtherChars / OTHER_TOKEN_RATIO)
  );
}

/** Estimate mixed-language text without depending on a provider tokenizer. */
export function estimateTextTokens(text: string | undefined | null): number {
  if (!text) return 0;

  const cjkCount = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const otherCount = Math.max(0, Array.from(text).length - cjkCount);

  return Math.ceil(cjkCount / CJK_TOKEN_RATIO) + Math.ceil(otherCount / OTHER_TOKEN_RATIO);
}

function estimateToolCalls(toolCalls: readonly TokenEstimateToolCall[] | undefined): number {
  if (!toolCalls || toolCalls.length === 0) return 0;

  return toolCalls.reduce(
    (total, call) =>
      total +
      estimateTextTokens(call.name) +
      estimateTextTokens(call.id) +
      estimateTextTokens(call.thoughtSignature) +
      estimateTextTokens(stringifyForEstimate(call.args)) +
      estimateStagedContentTokens(call.args),
    0
  );
}

/** Estimate the final outbound request, including protocol and media overhead. */
export function estimateRequestTokens(
  messages: readonly TokenEstimateMessage[],
  options: RequestTokenEstimateOptions = {}
): number {
  const imageTokenEstimate = Math.max(
    0,
    Math.floor(options.imageTokenEstimate ?? DEFAULT_IMAGE_TOKEN_ESTIMATE)
  );

  const messageTokens = messages.reduce((total, message) => {
    const imageCount = message.images?.length ?? 0;
    const reasoningTokens =
      message.reasoningDetails !== undefined
        ? estimateTextTokens(stringifyForEstimate(message.reasoningDetails))
        : estimateTextTokens(message.reasoningContent);
    return (
      total +
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(message.role) +
      estimateTextTokens(message.content) +
      reasoningTokens +
      estimateTextTokens(message.toolName) +
      estimateTextTokens(message.toolCallId) +
      estimateToolCalls(message.toolCalls) +
      imageCount * imageTokenEstimate
    );
  }, REQUEST_PRIMER_TOKENS);

  return messageTokens + estimateTextTokens(stringifyForEstimate(options.tools));
}

/** Estimate all generated output that may consume the response/context budget. */
export function estimateGeneratedTokens(response: {
  content?: string;
  reasoningContent?: string;
  toolCalls?: readonly TokenEstimateToolCall[];
}): number {
  return (
    estimateTextTokens(response.content) +
    estimateTextTokens(response.reasoningContent) +
    estimateToolCalls(response.toolCalls)
  );
}

/** Accept provider-reported zero while rejecting missing or invalid counters. */
export function normalizeReportedTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
