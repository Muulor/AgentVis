/**
 * ContentMatcher 单元测试
 *
 * 验证内容匹配器在各种场景下的正确性：
 * - CRLF/LF 兼容性（核心 Bug 修复验证）
 * - 精确匹配（直接 + 逐行修剪）
 * - 正规化匹配（box-drawing 字符容错）
 * - 模糊匹配
 * - 语义匹配（mock EmbeddingService）
 * - startOffset 精度验证
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContentMatcher } from '../ContentMatcher';

// ==================== 测试数据 ====================

/** LF 内容 */
const LF_CONTENT = 'line1\nline2\nline3\nline4\nline5';

/** CRLF 内容 */
const CRLF_CONTENT = 'line1\r\nline2\r\nline3\r\nline4\r\nline5';

/** 包含 box-drawing 字符的 CRLF 内容 */
const BOX_CRLF_CONTENT = [
    '\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
    '\u2502  Header  \u2502',
    '\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524',
    '\u2502  Body    \u2502',
    '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
].join('\r\n');

/** 多段落 CRLF 文档（模拟 PRD 文档） */
const DOC_CRLF = [
    '# Title',
    '',
    '## Section 1',
    'Content of section 1.',
    'More content here.',
    '',
    '## Section 2',
    'Content of section 2.',
    'Additional details.',
    '',
    '## Section 3',
    'Content of section 3.',
    'Final content.',
].join('\r\n');

// ==================== 辅助函数 ====================

/**
 * 验证 matchedContent 在原始内容中可被 indexOf 正确找到
 * 这是 CRLF Bug 修复的核心验证点
 */
function assertMatchedContentFoundable(content: string, matchedContent: string): void {
    const idx = content.indexOf(matchedContent);
    expect(idx, `matchedContent "${matchedContent.substring(0, 40)}..." should be found by indexOf`).not.toBe(-1);
}

/**
 * 验证 startOffset 指向原始内容的正确位置
 */
function assertStartOffsetCorrect(
    content: string,
    matchedContent: string,
    startOffset: number | undefined
): void {
    expect(startOffset, 'startOffset should be defined').not.toBeUndefined();
    const extracted = content.substring(startOffset!, startOffset! + matchedContent.length);
    expect(extracted, 'content at startOffset should match matchedContent').toBe(matchedContent);
}

// ==================== 测试用例 ====================

describe('ContentMatcher', () => {
    let matcher: ContentMatcher;

    beforeEach(() => {
        // 禁用语义匹配，避免测试中调用网络 API
        matcher = new ContentMatcher({ enableSemanticMatch: false });
    });

    // ==================== CRLF 兼容性（核心 Bug 修复） ====================

    describe('CRLF 兼容性', () => {
        it('exactMatch: CRLF 内容中精确匹配应保留 CRLF', async () => {
            // 直接搜索 CRLF 内容中的一段
            const search = 'line2\r\nline3';
            const result = await matcher.match(CRLF_CONTENT, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('exact');
            assertMatchedContentFoundable(CRLF_CONTENT, result.matchedContent);
        });

        it('exactMatchWithTrimmedLines: CRLF 内容中 trim 后匹配应保留 CRLF', async () => {
            // 搜索带有额外空白的内容，触发 trimmedLines 路径
            const search = '  line2  \n  line3  '; // LF + 额外空白
            const result = await matcher.match(CRLF_CONTENT, search);

            expect(result.success).toBe(true);
            // matchedContent 必须能在原始 CRLF 内容中被 indexOf 找到
            assertMatchedContentFoundable(CRLF_CONTENT, result.matchedContent);
            assertStartOffsetCorrect(CRLF_CONTENT, result.matchedContent, result.startOffset);
        });

        it('normalizedMatch: CRLF 内容中 box-drawing 正规化后应保留 CRLF', async () => {
            // 搜索用 ASCII 近似替代 box-drawing 字符，触发 normalizedMatch
            const search = '+----------+\n|  Header  |';
            const result = await matcher.match(BOX_CRLF_CONTENT, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('normalized');
            // 核心验证：matchedContent 必须在原始 CRLF 内容中可被 indexOf 找到
            assertMatchedContentFoundable(BOX_CRLF_CONTENT, result.matchedContent);
            assertStartOffsetCorrect(BOX_CRLF_CONTENT, result.matchedContent, result.startOffset);
        });

        it('fuzzyMatch: CRLF 内容中模糊匹配应保留 CRLF', async () => {
            // 搜索与原文有微小差异的内容，触发 fuzzyMatch
            const search = 'Content of section 1.\nMore content hereX.'; // 末尾 X 制造差异
            const result = await matcher.match(DOC_CRLF, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('fuzzy');
            // 核心验证
            assertMatchedContentFoundable(DOC_CRLF, result.matchedContent);
            assertStartOffsetCorrect(DOC_CRLF, result.matchedContent, result.startOffset);
        });

        it('多 patch 场景: 所有 patches 的 matchedContent 都应在 CRLF 内容中可定位', async () => {
            // 模拟 executePatch 的多 patch 场景
            const patches = [
                { search: '# Title', replace: '# New Title' },
                { search: '## Section 1\nContent of section 1.', replace: '## Section A\nNew content.' },
                { search: '## Section 3\nContent of section 3.', replace: '## Section C\nUpdated.' },
            ];

            for (const patch of patches) {
                const result = await matcher.match(DOC_CRLF, patch.search);
                expect(result.success, `patch "${patch.search.substring(0, 30)}" should match`).toBe(true);
                assertMatchedContentFoundable(DOC_CRLF, result.matchedContent);
            }
        });
    });

    // ==================== 精确匹配 ====================

    describe('精确匹配', () => {
        it('LF 内容应正常工作', async () => {
            const result = await matcher.match(LF_CONTENT, 'line2\nline3');
            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('exact');
            expect(result.matchedContent).toBe('line2\nline3');
        });

        it('CRLF 搜索 CRLF 内容应精确匹配', async () => {
            const result = await matcher.match(CRLF_CONTENT, 'line3\r\nline4');
            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('exact');
            expect(result.matchedContent).toBe('line3\r\nline4');
        });

        it('单行搜索应精确匹配', async () => {
            const result = await matcher.match(LF_CONTENT, 'line3');
            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('exact');
            expect(result.confidence).toBe(1.0);
        });

        it('不存在的内容应返回失败', async () => {
            const result = await matcher.match(LF_CONTENT, 'nonexistent');
            expect(result.success).toBe(false);
            expect(result.matchLevel).toBe('manual');
        });
    });

    // ==================== 正规化匹配 ====================

    describe('正规化匹配', () => {
        it('box-drawing 字符差异应通过正规化匹配', async () => {
            const content = '\u2502 cell1 \u2502 cell2 \u2502';
            const search = '| cell1 | cell2 |'; // ASCII 近似
            const result = await matcher.match(content, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('normalized');
            expect(result.matchedContent).toBe(content);
        });

        it('混合 box-drawing 变体应正确匹配', async () => {
            const content = '\u2554\u2550\u2550\u2550\u2557\n\u2551 A \u2551\n\u255a\u2550\u2550\u2550\u255d';
            const search = '+---+\n| A |\n+---+';  // ASCII 近似
            const result = await matcher.match(content, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('normalized');
        });
    });

    // ==================== 模糊匹配 ====================

    describe('模糊匹配', () => {
        it('相似内容应通过模糊匹配', async () => {
            // 搜索文本有小差异
            const content = 'function calculateTotal(price, tax) {\n  return price + tax;\n}';
            const search = 'function calculateTotal(price, taxes) {\n  return price + taxes;\n}';
            const result = await matcher.match(content, search);

            expect(result.success).toBe(true);
            expect(result.matchLevel).toBe('fuzzy');
            expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        });

        it('差异过大的内容不应匹配', async () => {
            const content = 'completely different content\nnothing similar at all';
            const search = 'function foo() {\n  return bar;\n}';
            const result = await matcher.match(content, search);

            expect(result.success).toBe(false);
        });
    });

    // ==================== 语义匹配 ====================

    describe('语义匹配', () => {
        it('搜索内容不足 2 行时应跳过语义匹配', async () => {
            const semanticMatcher = new ContentMatcher({ enableSemanticMatch: true });
            const result = await semanticMatcher.semanticMatch('line1\nline2\nline3', 'single');
            expect(result).toBeNull();
        });
    });

    // ==================== startOffset 精度 ====================

    describe('startOffset 精度', () => {
        it('exactMatch 应返回正确的 startOffset（CRLF）', async () => {
            const result = await matcher.match(CRLF_CONTENT, 'line3');
            expect(result.success).toBe(true);
            expect(result.startOffset).toBeDefined();
            // 'line1\r\n' = 7, 'line2\r\n' = 7, 所以 line3 从第 14 个字符开始
            expect(result.startOffset).toBe(14);
        });

        it('exactMatch 应返回正确的 startOffset（LF）', async () => {
            const result = await matcher.match(LF_CONTENT, 'line3');
            expect(result.success).toBe(true);
            expect(result.startOffset).toBeDefined();
            // 'line1\n' = 6, 'line2\n' = 6, 所以 line3 从第 12 个字符开始
            expect(result.startOffset).toBe(12);
        });

        it('非精确匹配路径也应返回 startOffset 和 matchLength', async () => {
            // 使用 trimmed 搜索触发 exactMatchWithTrimmedLines
            const content = '  spaced line1  \r\n  spaced line2  \r\n  spaced line3  ';
            const search = 'spaced line2\nspaced line3'; // 无空白前缀
            const result = await matcher.match(content, search);

            expect(result.success).toBe(true);
            expect(result.startOffset).toBeDefined();
            expect(result.matchLength).toBeDefined();
            assertStartOffsetCorrect(content, result.matchedContent, result.startOffset);
        });
    });

    // ==================== 集成场景 ====================

    describe('多 patch 替换集成', () => {
        it('模拟 executePatch: 逆序替换所有 patches 应全部生效', async () => {
            const patches = [
                { search: '# Title', replace: '# Updated Title' },
                { search: '## Section 2\nContent of section 2.', replace: '## Part 2\nNew content.' },
                { search: 'Final content.', replace: 'Done.' },
            ];

            // Phase 1: 匹配
            interface LocatedPatch {
                patch: { search: string; replace: string };
                matchResult: Awaited<ReturnType<typeof matcher.match>>;
            }
            const locatedPatches: LocatedPatch[] = [];
            for (const patch of patches) {
                const result = await matcher.match(DOC_CRLF, patch.search);
                expect(result.success).toBe(true);
                locatedPatches.push({ patch, matchResult: result });
            }

            // Phase 2: 按 startOffset 逆序排列
            locatedPatches.sort((a, b) => {
                const offsetA = a.matchResult.startOffset ?? DOC_CRLF.indexOf(a.matchResult.matchedContent);
                const offsetB = b.matchResult.startOffset ?? DOC_CRLF.indexOf(b.matchResult.matchedContent);
                return offsetB - offsetA;
            });

            // Phase 3: 逐个替换（模拟修复后的 executePatch 逻辑）
            let newContent = DOC_CRLF;
            for (const { patch, matchResult } of locatedPatches) {
                const matchLen = matchResult.matchLength ?? matchResult.matchedContent.length;
                const idx = matchResult.startOffset ?? newContent.indexOf(matchResult.matchedContent);
                expect(idx, `patch "${patch.search.substring(0, 20)}..." should be found`).not.toBe(-1);
                newContent = newContent.substring(0, idx)
                    + patch.replace
                    + newContent.substring(idx + matchLen);
            }

            // 验证所有替换都生效
            expect(newContent).toContain('# Updated Title');
            expect(newContent).toContain('## Part 2');
            expect(newContent).toContain('New content.');
            expect(newContent).toContain('Done.');
            // 验证原始内容已被替换
            expect(newContent).not.toContain('Content of section 2.');
            expect(newContent).not.toContain('Final content.');
        });
    });
});
