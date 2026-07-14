/**
 * Project Preview structured errors.
 *
 * Service errors cross async store boundaries as strings. A compact wire format keeps
 * machine-readable error codes available to the UI while avoiding hard-coded user copy.
 */

export type PreviewErrorCode =
  | 'cancelled'
  | 'missing-dependencies'
  | 'invalid-package'
  | 'ambiguous-entry'
  | 'entry-not-found'
  | 'nested-project'
  | 'unsupported-project'
  | 'unsafe-path'
  | 'node-missing'
  | 'install-failed'
  | 'install-auth-failed'
  | 'install-network-failed'
  | 'server-start-failed'
  | 'compile-failed'
  | 'process-exited'
  | 'retry-unavailable'
  | 'asset-budget-exceeded';

const PREVIEW_ERROR_CODES = new Set<PreviewErrorCode>([
  'cancelled',
  'missing-dependencies',
  'invalid-package',
  'ambiguous-entry',
  'entry-not-found',
  'nested-project',
  'unsupported-project',
  'unsafe-path',
  'node-missing',
  'install-failed',
  'install-auth-failed',
  'install-network-failed',
  'server-start-failed',
  'compile-failed',
  'process-exited',
  'retry-unavailable',
  'asset-budget-exceeded',
]);

const PREVIEW_ERROR_PREFIX = 'AGENTVIS_PREVIEW_ERROR:';
const VITE_ERROR_PAYLOAD_PREFIX_LIMIT = 128 * 1024;

export interface PreviewErrorHint {
  code: 'environment-files-omitted';
  count: number;
}

export interface PreviewErrorPayload {
  code: PreviewErrorCode;
  detail?: string;
  hints?: readonly PreviewErrorHint[];
}

export class PreviewServiceError extends Error {
  readonly code: PreviewErrorCode;
  readonly detail?: string;
  readonly hints: readonly PreviewErrorHint[];

  constructor(
    code: PreviewErrorCode,
    detail?: string,
    options?: ErrorOptions,
    hints: readonly PreviewErrorHint[] = []
  ) {
    const payload: PreviewErrorPayload = {
      code,
      ...(detail ? { detail } : {}),
      ...(hints.length > 0 ? { hints } : {}),
    };
    super(`${PREVIEW_ERROR_PREFIX}${JSON.stringify(payload)}`, options);
    this.name = 'PreviewServiceError';
    this.code = code;
    this.detail = detail;
    this.hints = hints;
  }
}

export function parsePreviewError(message: string | null | undefined): PreviewErrorPayload | null {
  if (!message?.startsWith(PREVIEW_ERROR_PREFIX)) return null;

  try {
    const value = JSON.parse(
      message.slice(PREVIEW_ERROR_PREFIX.length)
    ) as Partial<PreviewErrorPayload>;
    if (typeof value.code !== 'string' || !PREVIEW_ERROR_CODES.has(value.code)) {
      return null;
    }
    return {
      code: value.code,
      ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
      ...(Array.isArray(value.hints)
        ? {
            hints: value.hints
              .filter(
                (hint): hint is PreviewErrorHint =>
                  typeof hint === 'object' &&
                  hint !== null &&
                  (hint as Partial<PreviewErrorHint>).code === 'environment-files-omitted' &&
                  Number.isSafeInteger((hint as Partial<PreviewErrorHint>).count) &&
                  ((hint as Partial<PreviewErrorHint>).count ?? 0) > 0
              )
              .slice(0, 4),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function isPreviewCancellation(error: unknown): boolean {
  return error instanceof PreviewServiceError && error.code === 'cancelled';
}

function extractJsonStringProperty(
  source: string,
  property: string,
  startIndex: number
): string | null {
  const propertyToken = JSON.stringify(property);
  let propertyIndex = source.indexOf(propertyToken, startIndex);

  while (propertyIndex >= 0) {
    let cursor = propertyIndex + propertyToken.length;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== ':') {
      propertyIndex = source.indexOf(propertyToken, cursor);
      continue;
    }
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '"') return null;

    const valueStart = cursor;
    let escaped = false;
    for (cursor += 1; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        try {
          const value = JSON.parse(source.slice(valueStart, cursor + 1)) as unknown;
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  return null;
}

/** Extract Vite's JSON-encoded error and code frame without evaluating its HTML response. */
export function extractPreviewHttpErrorDetail(body: string, limit = 2_000): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) return '';

  const boundedBody = body.slice(0, VITE_ERROR_PAYLOAD_PREFIX_LIMIT);
  const payloadStart = boundedBody.indexOf('const error =');
  if (payloadStart >= 0) {
    const message = extractJsonStringProperty(boundedBody, 'message', payloadStart);
    const frame = extractJsonStringProperty(boundedBody, 'frame', payloadStart);
    if (message) {
      const detail = frame ? `${message}\n${frame}` : message;
      return detail.length <= limit ? detail : `${detail.slice(0, Math.max(0, limit - 1))}…`;
    }
  }

  const normalized = body.trim();
  return normalized.length <= limit ? normalized : `…${normalized.slice(-limit)}`;
}

const INSTALL_AUTH_FAILURE =
  /(?:\bE(?:401|403|NEEDAUTH)\b|authentication (?:failed|required)|incorrect or missing password|invalid authentication token|unable to authenticate)/iu;
const INSTALL_NETWORK_FAILURE =
  /(?:\bE(?:AI_AGAIN|CONNREFUSED|CONNRESET|HOSTUNREACH|NETUNREACH|NOTFOUND|TIMEDOUT)\b|\bERR_SOCKET_TIMEOUT\b|\bSELF_SIGNED_CERT\b|\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b|certificate (?:has expired|is not yet valid)|fetch failed|network request failed|socket hang up)/iu;

/** Preserve actionable npm failure categories without exposing credentials or changing policy. */
export function createPreviewInstallError(
  detail: string,
  options?: ErrorOptions
): PreviewServiceError {
  const code: PreviewErrorCode = INSTALL_AUTH_FAILURE.test(detail)
    ? 'install-auth-failed'
    : INSTALL_NETWORK_FAILURE.test(detail)
      ? 'install-network-failed'
      : 'install-failed';
  return new PreviewServiceError(code, detail, options);
}
