/**
 * exec 超时策略单元测试
 *
 * 覆盖原生 exec 的默认超时、显式超时提示和上限校验。
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EXEC_TIMEOUT_SECONDS,
    MAX_EXEC_TIMEOUT_SECONDS,
    formatExecProgressMessage,
    resolveExecTimeout,
} from '../tool';

describe('exec timeout policy', () => {
    it('未显式传 timeout 时使用默认 120 秒且不标记为显式超时', () => {
        const result = resolveExecTimeout(undefined);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.timeout).toBe(DEFAULT_EXEC_TIMEOUT_SECONDS);
            expect(result.explicit).toBe(false);
        }
    });

    it('显式 timeout 在上限内时保留并标记为显式超时', () => {
        const result = resolveExecTimeout(1200);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.timeout).toBe(1200);
            expect(result.explicit).toBe(true);
        }
    });

    it('timeout 超过全局上限时拒绝执行', () => {
        const result = resolveExecTimeout(MAX_EXEC_TIMEOUT_SECONDS + 1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain(String(MAX_EXEC_TIMEOUT_SECONDS));
        }
    });

    it('只有显式 timeout 时 progress 才展示超时上限', () => {
        const defaultProgress = formatExecProgressMessage('npm test', {
            timeout: DEFAULT_EXEC_TIMEOUT_SECONDS,
            explicit: false,
        });
        const explicitProgress = formatExecProgressMessage('npm install', {
            timeout: 1200,
            explicit: true,
        });

        expect(defaultProgress).not.toContain(String(DEFAULT_EXEC_TIMEOUT_SECONDS));
        expect(explicitProgress).toContain('1200');
    });
});
