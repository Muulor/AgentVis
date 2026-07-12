export type LlmRetryKind = 'retryable' | 'non_retryable' | 'cancelled' | 'unknown';

export interface LlmRetryClassification {
  kind: LlmRetryKind;
  shouldRetry: boolean;
  reason: string;
  statusCode?: number;
  message: string;
}

export const SUB_AGENT_LLM_RETRY_DELAYS_MS = [3000, 8000, 20000] as const;
export const MASTER_BRAIN_LLM_RETRY_DELAYS_MS = [3000, 8000] as const;
export const MEMORY_LLM_RETRY_DELAYS_MS = [3000, 8000] as const;

const RETRYABLE_STATUS_CODES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);

const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 413]);

const CANCELLED_PATTERNS = [
  /\babort(?:ed)?\b/i,
  /\bcancell?ed\b/i,
  /user manually cancelled/i,
  /user cancelled/i,
  /request cancelled/i,
  /tool execution cancelled/i,
  /用户取消/,
  /手动停止/,
];

const MAX_TOKENS_PARAMETER_NAME = String.raw`(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxCompletionTokens|maxOutputTokens)`;
const MAX_TOKENS_PARAMETER_REJECTION_PATTERNS = [
  new RegExp(
    String.raw`(?:invalid|unsupported|unrecognized|unknown|reject(?:ed|ion)?|参数(?:无效|不支持)?)[^,;\r\n]{0,64}\b${MAX_TOKENS_PARAMETER_NAME}\b`,
    'i'
  ),
  new RegExp(
    String.raw`\b${MAX_TOKENS_PARAMETER_NAME}\b[^,;\r\n]{0,160}(?:invalid|unsupported|unrecognized|unknown|reject(?:ed|ion)?|not\s+support(?:ed)?|must\s+be|has\s+to\s+be|should\s+be|cannot\s+exceed|at\s+most|less\s+than(?:\s+or\s+equal\s+to)?|greater\s+than|too\s+(?:large|high)|out\s+of\s+range|maximum\s+(?:allowed|value|limit)|exceeds?\s+(?:the\s+)?(?:maximum|allowed|limit)|expected(?:\s+(?:a\s+)?value)?|(?:<=|>=)|参数|最大(?:值|限制|允许)?|不能超过|取值范围|超出)`,
    'i'
  ),
];
const FINISH_REASON_MAX_TOKENS_PATTERN =
  /\bfinish[_\s-]?reason\b\s*["']?\s*[:=]\s*["']?\s*(?:max_tokens|max_completion_tokens|max_output_tokens)\b/gi;

const NON_RETRYABLE_PATTERNS = [
  /payload too large/i,
  /invalid[_\s-]?request/i,
  /context[_\s-]?length/i,
  /maximum context/i,
  /prompt too long/i,
  /insufficient[_\s-]?quota/i,
  /\bbilling\b/i,
  /authentication/i,
  /unauthorized/i,
  /permission denied/i,
  /forbidden/i,
  /api key/i,
  /no endpoints found that support image input/i,
  /image input/i,
  /image_url/i,
  /\bvision\b/i,
  /multi-?modal/i,
  /does not support images/i,
  /unsupported image/i,
  /failed to read request/i,
];

const RETRYABLE_PATTERNS = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /stream idle timeout/i,
  /stream transfer error/i,
  /network error/i,
  /error sending request/i,
  /connection (?:failed|reset|refused)/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bDNS\b/i,
  /socket hang up/i,
  /too many requests/i,
  /rate limit/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
];

const CONTEXTUAL_STATUS_PATTERNS = [
  /\b(?:api|http|status|error)(?:\s+(?:returned|code|status|response|request|error|failed|an))*[^\d]{0,40}(\d{3})\b/gi,
  /\b(?:status|error)\s*[:=]\s*(\d{3})\b/gi,
];

const PAREN_STATUS_PATTERN = /\((\d{3})(?:\s|[)<])/g;

export function getLlmRetryDelayMs(attempt: number, delaysMs: readonly number[]): number {
  const index = Math.max(0, Math.min(attempt - 1, delaysMs.length - 1));
  return delaysMs[index] ?? 0;
}

export function classifyLlmRetry(error: unknown): LlmRetryClassification {
  const message = normalizeErrorMessage(error);
  const statusCodes = extractContextualStatusCodes(message);
  const nonRetryableStatus = statusCodes.find((code) => NON_RETRYABLE_STATUS_CODES.has(code));
  const retryableStatus = statusCodes.find((code) => RETRYABLE_STATUS_CODES.has(code));

  if (CANCELLED_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      kind: 'cancelled',
      shouldRetry: false,
      reason: 'cancelled',
      statusCode: nonRetryableStatus ?? retryableStatus,
      message,
    };
  }

  if (
    nonRetryableStatus !== undefined ||
    NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return {
      kind: 'non_retryable',
      shouldRetry: false,
      reason:
        nonRetryableStatus !== undefined
          ? `non_retryable_status_${nonRetryableStatus}`
          : 'non_retryable_pattern',
      statusCode: nonRetryableStatus ?? retryableStatus,
      message,
    };
  }

  if (
    retryableStatus !== undefined ||
    RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return {
      kind: 'retryable',
      shouldRetry: true,
      reason:
        retryableStatus !== undefined ? `retryable_status_${retryableStatus}` : 'retryable_pattern',
      statusCode: retryableStatus,
      message,
    };
  }

  return {
    kind: 'unknown',
    shouldRetry: false,
    reason: 'unknown',
    message,
  };
}

/**
 * 判断 provider 是否明确拒绝了输出 token 参数。
 *
 * finish reason 表示响应已被截断，不是请求参数校验失败，因此会先从判定文本中排除。
 */
export function isMaxTokensParameterRejection(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  if (CANCELLED_PATTERNS.some((pattern) => pattern.test(message))) return false;

  const rejectionText = message.replace(FINISH_REASON_MAX_TOKENS_PATTERN, '');
  return MAX_TOKENS_PARAMETER_REJECTION_PATTERNS.some((pattern) => pattern.test(rejectionText));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return typeof serialized === 'string' ? serialized : String(error);
  } catch {
    return String(error);
  }
}

function extractContextualStatusCodes(message: string): number[] {
  const codes = new Set<number>();

  for (const pattern of CONTEXTUAL_STATUS_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      addStatusCode(codes, match[1]);
    }
  }

  if (/\b(?:api|http|status|error)\b/i.test(message)) {
    PAREN_STATUS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAREN_STATUS_PATTERN.exec(message)) !== null) {
      addStatusCode(codes, match[1]);
    }
  }

  return [...codes];
}

function addStatusCode(codes: Set<number>, value: string | undefined): void {
  if (!value) return;
  const code = Number(value);
  if (Number.isInteger(code) && code >= 100 && code <= 599) {
    codes.add(code);
  }
}
