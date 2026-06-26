import { describe, expect, it } from 'vitest';
import { classifyLlmRetry, getLlmRetryDelayMs } from '../LlmRetryPolicy';

describe('LlmRetryPolicy', () => {
    it('classifies transient provider and gateway status codes as retryable', () => {
        expect(classifyLlmRetry(
            'API returned an error (524 <unknown status code>): error code: 524'
        )).toMatchObject({
            kind: 'retryable',
            shouldRetry: true,
            statusCode: 524,
        });

        expect(classifyLlmRetry('HTTP request failed with status 502 Bad Gateway').shouldRetry).toBe(true);
        expect(classifyLlmRetry('Provider API error status=504 Gateway Timeout').shouldRetry).toBe(true);
        expect(classifyLlmRetry('API error code: 529 overloaded').shouldRetry).toBe(true);
    });

    it('classifies transient network text as retryable', () => {
        expect(classifyLlmRetry('Streaming response idle timeout (no data for 120 seconds)').shouldRetry).toBe(true);
        expect(classifyLlmRetry('Streaming request failed (network error): connection reset').shouldRetry).toBe(true);
        expect(classifyLlmRetry('Request failed: DNS error ENOTFOUND api.example.com').shouldRetry).toBe(true);
        expect(classifyLlmRetry('socket hang up').shouldRetry).toBe(true);
    });

    it('keeps deterministic request, auth, context, quota, and cancellation errors non-retryable', () => {
        expect(classifyLlmRetry('API returned an error (413 Payload Too Large): rate_limit_exceeded')).toMatchObject({
            kind: 'non_retryable',
            shouldRetry: false,
            statusCode: 413,
        });
        expect(classifyLlmRetry('HTTP status 401 Unauthorized').shouldRetry).toBe(false);
        expect(classifyLlmRetry('API returned an error (403 Forbidden)').shouldRetry).toBe(false);
        expect(classifyLlmRetry('API returned an error (404 Not Found)').shouldRetry).toBe(false);
        expect(classifyLlmRetry('invalid_request_error: bad request').shouldRetry).toBe(false);
        expect(classifyLlmRetry('context_length_exceeded: maximum context length').shouldRetry).toBe(false);
        expect(classifyLlmRetry('insufficient_quota: please check billing').shouldRetry).toBe(false);
        expect(classifyLlmRetry('Sub-agent LLM request cancelled')).toMatchObject({
            kind: 'cancelled',
            shouldRetry: false,
        });
    });

    it('does not treat unrelated plain numbers as status codes', () => {
        expect(classifyLlmRetry('Read line 500 from local file and continue')).toMatchObject({
            kind: 'unknown',
            shouldRetry: false,
        });
    });

    it('returns deterministic retry delays by one-based attempt', () => {
        expect(getLlmRetryDelayMs(1, [3000, 8000, 20000])).toBe(3000);
        expect(getLlmRetryDelayMs(2, [3000, 8000, 20000])).toBe(8000);
        expect(getLlmRetryDelayMs(3, [3000, 8000, 20000])).toBe(20000);
        expect(getLlmRetryDelayMs(99, [3000, 8000, 20000])).toBe(20000);
    });
});
