/**
 * FactExtractor 单元测试
 *
 * 覆盖核心场景：
 * - LLM 正常返回（提取/拒绝）
 * - LLM API 异常 → _apiError 标记
 * - extractAndSaveFromVerified 混合场景（成功 + API 失败）
 */

import { describe, it, expect, vi } from 'vitest';
import { FactExtractor } from '../FactExtractor';
import type { LLMService, MemoryCandidate } from '../types';

// ==================== Mock 设置 ====================

// Mock Tauri invoke — 根据命令名返回不同结果
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockImplementation((command: string) => {
        // memory_list_facts 返回空数组（表示无已有事实，跳过去重）
        if (command === 'memory_list_facts') return Promise.resolve([]);
        // memory_create 返回新记录 ID
        if (command === 'memory_create') return Promise.resolve({ id: `fact_${Date.now()}` });
        // memory_update 无返回
        if (command === 'memory_update') return Promise.resolve(undefined);
        return Promise.resolve(undefined);
    }),
}));

// Mock EmbeddingService — 阻止实际 Embedding 调用
vi.mock('@services/rag/EmbeddingService', () => ({
    embeddingService: {
        isSemanticallySimilar: vi.fn().mockResolvedValue(false),
    },
}));

// Mock logger — 静默日志输出
vi.mock('@services/logger', () => ({
    getLogger: () => ({
        trace: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

// ==================== 测试工具 ====================

/** 创建 Mock LLM 服务 */
function createMockLLM(generateFn?: LLMService['generate']): LLMService {
    return {
        generate: generateFn ?? vi.fn().mockResolvedValue('{"extract": false, "reason": "不适合提取"}'),
    };
}

/** 创建测试候选 */
function createTestCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
    return {
        id: `candidate_${Math.random().toString(36).slice(2, 8)}`,
        agentId: 'test-agent',
        content: '用户喜欢简洁回复',
        category: 'preference_style',
        occurrenceCount: 2,
        firstSeenAt: Date.now() - 10000,
        lastSeenAt: Date.now(),
        userConfirmed: true,
        score: 7,
        contextMessages: [
            { role: 'user', content: '请回复简短一些' },
            { role: 'assistant', content: '好的，我会尽量简洁。' },
        ],
        ...overrides,
    };
}

// ==================== 测试用例 ====================

describe('FactExtractor', () => {
    // ───────────────────────────────────────────────────
    // extractFromVerifiedCandidate
    // ───────────────────────────────────────────────────

    describe('extractFromVerifiedCandidate', () => {
        it('LLM 正常返回提取结果时，不应标记 _apiError', async () => {
            const llm = createMockLLM(
                vi.fn().mockResolvedValue(JSON.stringify({
                    extract: true,
                    category: 'preference_style',
                    candidate_fact: '用户偏好简洁回复',
                    confidence: 0.85,
                    notes: '多次出现且用户已确认',
                }))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidate = createTestCandidate();

            const result = await extractor.extractFromVerifiedCandidate(candidate);

            expect(result.extract).toBe(true);
            expect(result._apiError).toBeUndefined();
            expect(result.candidate_fact).toBe('用户偏好简洁回复');
        });

        it('LLM 正常拒绝提取时，不应标记 _apiError', async () => {
            const llm = createMockLLM(
                vi.fn().mockResolvedValue(JSON.stringify({
                    extract: false,
                    reason: '内容过于临时',
                }))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidate = createTestCandidate();

            const result = await extractor.extractFromVerifiedCandidate(candidate);

            expect(result.extract).toBe(false);
            expect(result._apiError).toBeUndefined();
            expect(result.reason).toBe('内容过于临时');
        });

        it('LLM API 抛出异常时，应标记 _apiError: true', async () => {
            const llm = createMockLLM(
                vi.fn().mockRejectedValue(new Error('API rate limit exceeded'))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidate = createTestCandidate();

            const result = await extractor.extractFromVerifiedCandidate(candidate);

            expect(result.extract).toBe(false);
            expect(result._apiError).toBe(true);
            expect(result.reason).toBe('An error occurred during extraction');
        });

        it('LLM 网络超时异常时，应标记 _apiError: true', async () => {
            const llm = createMockLLM(
                vi.fn().mockRejectedValue(new Error('Network timeout'))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidate = createTestCandidate();

            const result = await extractor.extractFromVerifiedCandidate(candidate);

            expect(result.extract).toBe(false);
            expect(result._apiError).toBe(true);
        });
    });

    // ───────────────────────────────────────────────────
    // extractAndSaveFromVerified
    // ───────────────────────────────────────────────────

    describe('extractAndSaveFromVerified', () => {
        it('全部成功时，failedCandidateIds 应为空', async () => {
            const llm = createMockLLM(
                vi.fn().mockResolvedValue(JSON.stringify({
                    extract: true,
                    category: 'preference_style',
                    candidate_fact: '用户偏好简洁回复',
                    confidence: 0.85,
                }))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidates = [createTestCandidate({ id: 'c1' }), createTestCandidate({ id: 'c2' })];

            const result = await extractor.extractAndSaveFromVerified(candidates);

            expect(result.savedCount).toBe(2);
            expect(result.failedCandidateIds).toEqual([]);
        });

        it('全部 API 失败时，savedCount 应为 0 且全部 ID 在 failedCandidateIds', async () => {
            const llm = createMockLLM(
                vi.fn().mockRejectedValue(new Error('Service unavailable'))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidates = [createTestCandidate({ id: 'c1' }), createTestCandidate({ id: 'c2' })];

            const result = await extractor.extractAndSaveFromVerified(candidates);

            expect(result.savedCount).toBe(0);
            expect(result.failedCandidateIds).toEqual(['c1', 'c2']);
        });

        it('LLM 正常拒绝时，不应算入 failedCandidateIds', async () => {
            const llm = createMockLLM(
                vi.fn().mockResolvedValue(JSON.stringify({
                    extract: false,
                    reason: '临时性内容',
                }))
            );
            const extractor = new FactExtractor(llm, 'test-agent');
            const candidates = [createTestCandidate({ id: 'c1' })];

            const result = await extractor.extractAndSaveFromVerified(candidates);

            // LLM 正常拒绝：不保存，但也不标记为失败
            expect(result.savedCount).toBe(0);
            expect(result.failedCandidateIds).toEqual([]);
        });

        it('混合场景：1 成功 + 1 API 失败 + 1 正常拒绝', async () => {
            let callCount = 0;
            const llm = createMockLLM(
                vi.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount === 1) {
                        // 第一个：成功提取
                        return JSON.stringify({
                            extract: true,
                            category: 'preference_style',
                            candidate_fact: '用户偏好简洁回复',
                            confidence: 0.85,
                        });
                    } else if (callCount === 2) {
                        // 第二个：API 异常
                        throw new Error('API key expired');
                    } else {
                        // 第三个：正常拒绝
                        return JSON.stringify({
                            extract: false,
                            reason: '不适合提取',
                        });
                    }
                })
            );

            const extractor = new FactExtractor(llm, 'test-agent');
            const candidates = [
                createTestCandidate({ id: 'success' }),
                createTestCandidate({ id: 'api-fail' }),
                createTestCandidate({ id: 'rejected' }),
            ];

            const result = await extractor.extractAndSaveFromVerified(candidates);

            expect(result.savedCount).toBe(1);
            expect(result.failedCandidateIds).toEqual(['api-fail']);
            // 'rejected' 不在 failedCandidateIds 中（正常拒绝，不需重试）
        });
    });
});
