/**
 * ToolOutputCompressor 单元测试
 *
 * 测试三级梯度截断策略：
 * - Level 1: 短输出完整保留
 * - Level 2: 中等输出首尾截断
 * - Level 3: 大输出元信息提取
 */

import { describe, it, expect } from 'vitest';
import { ToolOutputCompressor, estimateTokens } from '../ToolOutputCompressor';
import { translate } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 生成指定 token 数的测试文本（英文，4 字符 ≈ 1 token） */
function generateText(targetTokens: number): string {
    // 每个单词约 5 字符（含空格），≈ 1.25 token
    // 为简化，直接生成 targetTokens * 4 个字符
    const chars = targetTokens * 4;
    const word = 'test ';
    return word.repeat(Math.ceil(chars / word.length)).slice(0, chars);
}

/** 生成模拟的 read 工具输出 */
function generateReadOutput(lines: number): string {
    return Array.from({ length: lines }, (_, i) =>
        `${i + 1}: const variable${i} = "value${i}";`
    ).join('\n');
}

/** 生成模拟的 web_search 工具输出 */
function generateSearchOutput(resultCount: number): string {
    return Array.from({ length: resultCount }, (_, i) =>
        `### Result ${i + 1}\n[Search Result ${i + 1} Title](https://example.com/result-${i + 1})\nThis is the description of search result ${i + 1}. It contains detailed information about the topic.`
    ).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
// estimateTokens 基础测试
// ═══════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
    it('空文本返回 0', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('正确估算纯英文', () => {
        const text = 'Hello world test'; // 16 字符 → ~4 tokens
        const tokens = estimateTokens(text);
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    it('正确估算纯中文', () => {
        const text = '你好世界测试'; // 6 个中文字符 → ~4 tokens
        const tokens = estimateTokens(text);
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    it('生成的文本 token 数近似目标值', () => {
        const target = 1000;
        const text = generateText(target);
        const tokens = estimateTokens(text);
        // 允许 20% 误差
        expect(tokens).toBeGreaterThan(target * 0.8);
        expect(tokens).toBeLessThan(target * 1.2);
    });
});

// ═══════════════════════════════════════════════════════════════
// Level 1: 完整保留
// ═══════════════════════════════════════════════════════════════

describe('ToolOutputCompressor Level 1 (完整保留)', () => {
    const compressor = new ToolOutputCompressor();

    it('短输出 (< 5K tokens) 完整保留', () => {
        const content = generateText(500);
        const result = compressor.compress(content, 'read', 'test.ts');

        expect(result.level).toBe('full');
        expect(result.wasCompressed).toBe(false);
        expect(result.content).toBe(content);
        expect(result.originalTokens).toBe(result.finalTokens);
    });

    it('恰好在阈值边界的输出完整保留', () => {
        const content = generateText(4800); // 略低于 5K
        const result = compressor.compress(content, 'read', 'test.ts');

        expect(result.level).toBe('full');
        expect(result.wasCompressed).toBe(false);
    });

    it('空输出完整保留', () => {
        const result = compressor.compress('', 'read', 'test.ts');

        expect(result.level).toBe('full');
        expect(result.wasCompressed).toBe(false);
        expect(result.content).toBe('');
        expect(result.originalTokens).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// Level 2: 首尾截断
// ═══════════════════════════════════════════════════════════════

describe('ToolOutputCompressor Level 2 (首尾截断)', () => {
    const compressor = new ToolOutputCompressor();

    it('中等输出 (L1~L2 tokens) 被首尾截断', () => {
        // L1 阈值已从 5000 提升至 8000（PLANNING_CONSTANTS.SUB_AGENT_COMPRESS_THRESHOLD_L1）
        // 7000 现在低于 L1，需使用 9000 才能触发 Level 2。
        const content = generateText(9000);
        const result = compressor.compress(content, 'read', 'src/utils.ts');

        expect(result.level).toBe('truncated');
        expect(result.wasCompressed).toBe(true);
        expect(result.finalTokens).toBeLessThan(result.originalTokens);
        // 压缩后应远小于原始
        expect(result.finalTokens).toBeLessThan(result.originalTokens * 0.5);
    });

    it('截断后包含省略标记', () => {
        const content = generateText(9000);
        const result = compressor.compress(content, 'read', 'src/utils.ts');
        const omissionMarkerPrefix = translate('chat.subAgentToolOutputOmissionMarker', {
            tokens: '__TOKENS__',
            meta: '__META__',
        }).split('__TOKENS__')[0]?.trim() ?? '';

        expect(result.content).toContain(omissionMarkerPrefix);
        expect(result.content).toContain('tokens');
    });

    it('read 工具截断包含文件类型信息', () => {
        // 生成足够超过 L1 阈值（8000）的文本以触发 Level 2 截断
        const content = generateText(9000);
        const result = compressor.compress(content, 'read', 'src/components/App.tsx');

        expect(result.content).toContain('TypeScript/React');
    });

    it('web_search 工具截断包含结果计数', () => {
        // 生成足够大的搜索结果以超过 L1 阈值（3000 tokens）
        // 每条约 200 字符 ≈ 50 tokens，80 条 ≈ 4000 tokens
        const searchContent = generateSearchOutput(80);
        const tokens = estimateTokens(searchContent);

        // 确保在 Level 2 范围内（L1=5000, L2=10000）
        if (tokens >= 5000 && tokens < 10000) {
            const result = compressor.compress(searchContent, 'web_search', 'TypeScript async patterns');
            expect(result.content).toContain(
                translate('chat.subAgentToolOutputMetaSearchResults', { count: 80 })
            );
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// Level 3: 元信息摘要
// ═══════════════════════════════════════════════════════════════

describe('ToolOutputCompressor Level 3 (元信息摘要)', () => {
    const compressor = new ToolOutputCompressor();

    it('大输出 (> 10K tokens) 压缩为元信息', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'read', 'src/large-file.ts');

        expect(result.level).toBe('meta');
        expect(result.wasCompressed).toBe(true);
        // 元信息应该很短
        expect(result.finalTokens).toBeLessThan(200);
        expect(result.originalTokens).toBeGreaterThan(10000);
    });

    it('read 工具元信息包含文件路径和行数', () => {
        const content = generateReadOutput(500);
        // 确保超过 10K tokens
        const bigContent = content + '\n' + generateText(15000);
        const result = compressor.compress(bigContent, 'read', 'src/services/LargeService.ts');

        expect(result.content).toContain('read');
        expect(result.content).toContain('LargeService.ts');
        expect(result.content).toContain('TypeScript');
        expect(result.content).toContain(
            translate('chat.subAgentToolOutputReadStatusSucceeded')
        );
    });

    it('web_search 工具元信息保留标题和 URL', () => {
        // 生成大量搜索结果，确保超过 8K tokens
        const searchContent = generateSearchOutput(100);
        const padding = generateText(12000); // 额外填充确保超过阈值
        const content = searchContent + '\n' + padding;
        const result = compressor.compress(content, 'web_search', 'React performance optimization');

        expect(result.level).toBe('meta');
        expect(result.content).toContain('web_search');
        expect(result.content).toContain('React performance optimization');
        expect(result.content).toContain(String(result.originalTokens));
        // 保留的标题和 URL
        expect(result.content).toContain('example.com');
    });

    it('通用工具元信息格式正确', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'shell_execute', '/usr/bin/some-command');

        expect(result.level).toBe('meta');
        expect(result.content).toContain('shell_execute');
        expect(result.content).toContain(
            translate('chat.subAgentToolOutputExecutionSucceeded')
        );
    });

    it('失败的工具输出标记为 ❌', () => {
        const content = '❌ Error: File not found\n' + generateText(15000);
        const result = compressor.compress(content, 'read', 'nonexistent.ts');

        expect(result.level).toBe('meta');
        expect(result.content).toContain('❌');
        // 失败输出包含执行失败标记
        expect(result.content).toContain(
            translate('chat.subAgentToolOutputReadStatusFailed')
        );
    });
});

// ═══════════════════════════════════════════════════════════════
// 自定义配置
// ═══════════════════════════════════════════════════════════════

describe('ToolOutputCompressor 自定义配置', () => {
    it('自定义阈值生效', () => {
        const compressor = new ToolOutputCompressor({
            thresholdL1: 100,
            thresholdL2: 500,
        });

        // 200 tokens 在默认下是 Level 1，自定义下是 Level 2
        const content = generateText(200);
        const result = compressor.compress(content, 'read', 'test.ts');

        expect(result.level).toBe('truncated');
    });

    it('自定义首尾保留 tokens', () => {
        const compressor = new ToolOutputCompressor({
            thresholdL1: 100,
            thresholdL2: 5000,
            headTokens: 200,
            tailTokens: 200,
        });

        const content = generateText(3000);
        const result = compressor.compress(content, 'read', 'test.ts');

        expect(result.level).toBe('truncated');
        // 首尾各 200 tokens + 省略标记，应远小于原始
        expect(result.finalTokens).toBeLessThan(1000);
    });
});

// ═══════════════════════════════════════════════════════════════
// 语言检测
// ═══════════════════════════════════════════════════════════════

describe('ToolOutputCompressor 语言检测', () => {
    const compressor = new ToolOutputCompressor();

    it('检测 TypeScript', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'read', 'src/index.ts');
        expect(result.content).toContain('TypeScript');
    });

    it('检测 Python', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'read', 'main.py');
        expect(result.content).toContain('Python');
    });

    it('检测 Rust', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'read', 'lib.rs');
        expect(result.content).toContain('Rust');
    });

    it('未知扩展名不报错', () => {
        const content = generateText(15000);
        const result = compressor.compress(content, 'read', 'README.xyz');
        expect(result.level).toBe('meta');
        // 无语言信息，但不应崩溃
        expect(result.content).toContain('read');
    });
});
