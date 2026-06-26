/**
 * FullFileDiffBuilder 单元测试
 *
 * 验证全文 Diff 构建器在多修改场景下行号计算的正确性。
 *
 * 核心测试目标：
 * - 单修改 REPLACE：行号与原文位置一致
 * - 多修改 + 行数变化：后续修改的行号正确偏移
 * - 不同修改状态（pending/applied/rejected）的行号处理
 */

import { describe, it, expect } from 'vitest';
import { FullFileDiffBuilder } from '../FullFileDiffBuilder';
import type {
    ModificationApplyResult,
    DiffResult,
    FullFileDiffLine,
} from '../types';

// ==================== 测试辅助函数 ====================

/**
 * 创建模拟 ModificationApplyResult
 *
 * 根据输入参数构建一个用于测试的 ModificationApplyResult 对象。
 * diff.hunks 的行号模拟真实场景：基于全文 diff 生成。
 */
function createMockModification(params: {
    id: string;
    startLine: number;
    endLine: number;
    /** 原始匹配区域的行内容（remove 行） */
    removeLines: string[];
    /** 替换内容（add 行） */
    addLines: string[];
    status?: ModificationApplyResult['status'];
}): ModificationApplyResult {
    const {
        id, startLine, endLine,
        removeLines, addLines,
        status = 'pending',
    } = params;

    // 构造 diff hunk 的行（模拟 DiffGenerator.generateDiff 的输出）
    const hunkLines = [
        ...removeLines.map((content, i) => ({
            type: 'remove' as const,
            content,
            oldLineNumber: startLine + i,
        })),
        ...addLines.map((content, i) => ({
            type: 'add' as const,
            content,
            newLineNumber: startLine + i,
        })),
    ];

    const diff: DiffResult = {
        oldContent: '',
        newContent: '',
        hasChanges: true,
        hunks: [{
            oldStart: startLine,
            oldLines: removeLines.length,
            newStart: startLine,
            newLines: addLines.length,
            lines: hunkLines,
        }],
    };

    return {
        modificationId: id,
        modification: {
            file: 'test.md',
            operation: 'REPLACE',
            search: removeLines.join('\n'),
            replace: addLines.join('\n'),
        },
        matchResult: {
            success: true,
            matchLevel: 'exact',
            confidence: 1,
            startLine,
            endLine,
            matchedContent: removeLines.join('\n'),
        },
        diff,
        status,
    };
}

/**
 * 生成指定行数的测试文件内容
 */
function generateContent(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
}

/**
 * 从构建结果中提取指定修改 ID 的行
 */
function getModLines(lines: FullFileDiffLine[], modId: string): FullFileDiffLine[] {
    return lines.filter(l => l.modificationId === modId);
}

// ==================== 测试用例 ====================

describe('FullFileDiffBuilder', () => {
    describe('单修改场景', () => {
        it('REPLACE：行号应与原文位置一致', () => {
            // 10 行文件，替换第 3 行（1 remove + 1 add）
            const content = generateContent(10);
            const mod = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 3,
                removeLines: ['line 3'],
                addLines: ['modified line 3'],
            });

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // 修改前的上下文行（第 1-2 行）
            const line1 = result.lines.find(l => l.content === 'line 1');
            expect(line1?.oldLineNumber).toBe(1);
            expect(line1?.newLineNumber).toBe(1);

            const line2 = result.lines.find(l => l.content === 'line 2');
            expect(line2?.oldLineNumber).toBe(2);
            expect(line2?.newLineNumber).toBe(2);

            // 修改块中的 remove 行
            const removeLine = result.lines.find(l => l.content === 'line 3' && l.type === 'remove');
            expect(removeLine?.oldLineNumber).toBe(3);

            // 修改块中的 add 行
            const addLine = result.lines.find(l => l.content === 'modified line 3' && l.type === 'add');
            expect(addLine?.newLineNumber).toBe(3);

            // 修改后的上下文行（第 4 行 → 绝对行号仍为 4，因为 1 remove + 1 add 没有行数变化）
            const line4 = result.lines.find(l => l.content === 'line 4');
            expect(line4?.oldLineNumber).toBe(4);
            expect(line4?.newLineNumber).toBe(4);
        });

        it('REPLACE 增加行数：后续上下文行号应正确偏移', () => {
            // 10 行文件，将第 3 行替换为 3 行（net +2）
            const content = generateContent(10);
            const mod = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 3,
                removeLines: ['line 3'],
                addLines: ['new line A', 'new line B', 'new line C'],
            });

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // 修改后的上下文行：原始第 4 行，新行号应为 4 + 2 = 6
            const line4 = result.lines.find(l => l.content === 'line 4' && l.type === 'context');
            expect(line4?.oldLineNumber).toBe(4);
            expect(line4?.newLineNumber).toBe(6);

            // 最后一行：原始第 10 行，新行号应为 10 + 2 = 12
            const line10 = result.lines.find(l => l.content === 'line 10' && l.type === 'context');
            expect(line10?.oldLineNumber).toBe(10);
            expect(line10?.newLineNumber).toBe(12);
        });
    });

    describe('多修改场景（核心用例：行号偏移累积）', () => {
        it('两个 REPLACE：第二个修改的行号应考虑第一个修改的行数变化', () => {
            // 20 行文件
            // 修改1: 第 3 行 → 替换为 3 行（net +2）
            // 修改2: 第 10 行 → 替换为 1 行（net 0）
            const content = generateContent(20);

            const mod1 = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 3,
                removeLines: ['line 3'],
                addLines: ['new A', 'new B', 'new C'],
            });

            const mod2 = createMockModification({
                id: 'mod-2',
                startLine: 10,
                endLine: 10,
                removeLines: ['line 10'],
                addLines: ['modified line 10'],
            });

            const builder = new FullFileDiffBuilder(content, [mod1, mod2], 'test.md');
            const result = builder.build();

            // mod2 的 remove 行：oldLineNumber 应为原始的 10
            const mod2Remove = getModLines(result.lines, 'mod-2')
                .find(l => l.type === 'remove');
            expect(mod2Remove?.oldLineNumber).toBe(10);

            // mod2 的 add 行：newLineNumber 应为 10 + 2（前面 mod1 的偏移）= 12
            const mod2Add = getModLines(result.lines, 'mod-2')
                .find(l => l.type === 'add');
            expect(mod2Add?.newLineNumber).toBe(12);

            // mod2 后的上下文行（原始第 11 行）：
            // oldLineNumber = 11, newLineNumber = 11 + 2 = 13
            const line11 = result.lines.find(l => l.content === 'line 11' && l.type === 'context');
            expect(line11?.oldLineNumber).toBe(11);
            expect(line11?.newLineNumber).toBe(13);
        });

        it('两个 REPLACE + 行数减少：行号偏移应正确累积', () => {
            // 20 行文件
            // 修改1: 第 3-5 行 → 替换为 1 行（net -2）
            // 修改2: 第 15-16 行 → 替换为 3 行（net +1）
            const content = generateContent(20);

            const mod1 = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 5,
                removeLines: ['line 3', 'line 4', 'line 5'],
                addLines: ['merged line'],
            });

            const mod2 = createMockModification({
                id: 'mod-2',
                startLine: 15,
                endLine: 16,
                removeLines: ['line 15', 'line 16'],
                addLines: ['expanded A', 'expanded B', 'expanded C'],
            });

            const builder = new FullFileDiffBuilder(content, [mod1, mod2], 'test.md');
            const result = builder.build();

            // mod1 后的上下文：原始第 6 行
            // oldLineNumber = 6, newLineNumber = 6 - 2 = 4
            const line6 = result.lines.find(l => l.content === 'line 6' && l.type === 'context');
            expect(line6?.oldLineNumber).toBe(6);
            expect(line6?.newLineNumber).toBe(4);

            // mod2 的 remove 行
            const mod2Removes = getModLines(result.lines, 'mod-2')
                .filter(l => l.type === 'remove');
            expect(mod2Removes[0]?.oldLineNumber).toBe(15);
            expect(mod2Removes[1]?.oldLineNumber).toBe(16);

            // mod2 的 add 行：前面 mod1 的偏移为 -2
            // 原始第 15 行位置 → 新行号 = absoluteLineNumber
            // mod1 前 2 行 context + 1 add = 3 行
            // 中间 context: 6-14 行 = 9 行 → 累计 3+9=12 行
            // mod2 的 add 行起始 absoluteLineNumber = 13
            const mod2Adds = getModLines(result.lines, 'mod-2')
                .filter(l => l.type === 'add');
            expect(mod2Adds[0]?.newLineNumber).toBe(13);
            expect(mod2Adds[1]?.newLineNumber).toBe(14);
            expect(mod2Adds[2]?.newLineNumber).toBe(15);

            // mod2 后的上下文（原始第 17 行）
            // 累计偏移 = -2 + 1 = -1
            // newLineNumber = 17 - 1 = 16
            const line17 = result.lines.find(l => l.content === 'line 17' && l.type === 'context');
            expect(line17?.oldLineNumber).toBe(17);
            expect(line17?.newLineNumber).toBe(16);
        });
    });

    describe('修改状态对行号的影响', () => {
        it('applied 修改：只输出 add 行作为上下文，后续行号正确偏移', () => {
            // 10 行文件，accepted 修改将第 3 行替换为 2 行（net +1）
            const content = generateContent(10);
            const mod = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 3,
                removeLines: ['line 3'],
                addLines: ['accepted A', 'accepted B'],
                status: 'applied',
            });

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // applied 修改不应有 modificationId
            const modLines = getModLines(result.lines, 'mod-1');
            expect(modLines).toHaveLength(0);

            // 被 accept 的内容作为 context 行输出
            const acceptedA = result.lines.find(l => l.content === 'accepted A');
            expect(acceptedA?.type).toBe('context');
            expect(acceptedA?.newLineNumber).toBe(3);

            const acceptedB = result.lines.find(l => l.content === 'accepted B');
            expect(acceptedB?.type).toBe('context');
            expect(acceptedB?.newLineNumber).toBe(4);

            // 修改后的上下文行：原始第 4 行 → 新行号 5
            const line4 = result.lines.find(l => l.content === 'line 4');
            expect(line4?.newLineNumber).toBe(5);
        });

        it('rejected 修改：输出原始行作为上下文，行号不变', () => {
            // 10 行文件，rejected 修改在第 3 行
            const content = generateContent(10);
            const mod = createMockModification({
                id: 'mod-1',
                startLine: 3,
                endLine: 3,
                removeLines: ['line 3'],
                addLines: ['rejected content'],
                status: 'rejected',
            });

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // rejected 修改不应有 modificationId
            const modLines = getModLines(result.lines, 'mod-1');
            expect(modLines).toHaveLength(0);

            // 原始第 3 行作为 context 输出
            const line3 = result.lines.find(l => l.content === 'line 3');
            expect(line3?.type).toBe('context');
            expect(line3?.oldLineNumber).toBe(3);
            expect(line3?.newLineNumber).toBe(3);

            // 后续行号不受影响
            const line4 = result.lines.find(l => l.content === 'line 4');
            expect(line4?.oldLineNumber).toBe(4);
            expect(line4?.newLineNumber).toBe(4);
        });
    });

    describe('hunk 上下文行过滤（防止重复输出）', () => {
        it('hunk 中 matchResult 范围外的 context 行不应被输出', () => {
            // 模拟真实的 DiffGenerator 行为：hunk 在变更两侧各加 3 行 context
            // 20 行文件，修改第 10 行，hunk 包含 7-13 行的 context + 变更
            const content = generateContent(20);

            const hunkLinesWithContext = [
                // DiffGenerator 添加的前置上下文（matchResult 范围外）
                { type: 'context' as const, content: 'line 7', oldLineNumber: 7, newLineNumber: 7 },
                { type: 'context' as const, content: 'line 8', oldLineNumber: 8, newLineNumber: 8 },
                { type: 'context' as const, content: 'line 9', oldLineNumber: 9, newLineNumber: 9 },
                // 实际变更
                { type: 'remove' as const, content: 'line 10', oldLineNumber: 10 },
                { type: 'add' as const, content: 'modified line 10', newLineNumber: 10 },
                // DiffGenerator 添加的后置上下文（matchResult 范围外）
                { type: 'context' as const, content: 'line 11', oldLineNumber: 11, newLineNumber: 11 },
                { type: 'context' as const, content: 'line 12', oldLineNumber: 12, newLineNumber: 12 },
                { type: 'context' as const, content: 'line 13', oldLineNumber: 13, newLineNumber: 13 },
            ];

            const mod: ModificationApplyResult = {
                modificationId: 'mod-1',
                modification: {
                    file: 'test.md',
                    operation: 'REPLACE',
                    search: 'line 10',
                    replace: 'modified line 10',
                },
                matchResult: {
                    success: true,
                    matchLevel: 'exact',
                    confidence: 1,
                    startLine: 10,
                    endLine: 10,
                    matchedContent: 'line 10',
                },
                diff: {
                    oldContent: '',
                    newContent: '',
                    hasChanges: true,
                    hunks: [{
                        oldStart: 7,
                        oldLines: 7,
                        newStart: 7,
                        newLines: 7,
                        lines: hunkLinesWithContext,
                    }],
                },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // 不应有重复内容：每行内容只应出现一次
            const line9Occurrences = result.lines.filter(l => l.content === 'line 9');
            expect(line9Occurrences).toHaveLength(1);

            const line11Occurrences = result.lines.filter(l => l.content === 'line 11');
            expect(line11Occurrences).toHaveLength(1);

            // 行号应保持连续且正确（1 remove + 1 add = net 0）
            const line9 = result.lines.find(l => l.content === 'line 9');
            expect(line9?.oldLineNumber).toBe(9);
            expect(line9?.newLineNumber).toBe(9);

            const line11 = result.lines.find(l => l.content === 'line 11');
            expect(line11?.oldLineNumber).toBe(11);
            expect(line11?.newLineNumber).toBe(11);

            // 总行数应为 20（没有行数变化）
            const contextAndAddLines = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(contextAndAddLines).toHaveLength(20);
        });

        it('多修改 + hunk context：右列行号不应因重复行而偏大', () => {
            // 30 行文件，2 个修改各自的 hunk 带 context
            const content = generateContent(30);

            // 修改1: 第 5 行，1→2（net +1），hunk 包含 2-8 行
            const mod1Hunk = [
                { type: 'context' as const, content: 'line 2', oldLineNumber: 2, newLineNumber: 2 },
                { type: 'context' as const, content: 'line 3', oldLineNumber: 3, newLineNumber: 3 },
                { type: 'context' as const, content: 'line 4', oldLineNumber: 4, newLineNumber: 4 },
                { type: 'remove' as const, content: 'line 5', oldLineNumber: 5 },
                { type: 'add' as const, content: 'new 5a', newLineNumber: 5 },
                { type: 'add' as const, content: 'new 5b', newLineNumber: 6 },
                { type: 'context' as const, content: 'line 6', oldLineNumber: 6, newLineNumber: 7 },
                { type: 'context' as const, content: 'line 7', oldLineNumber: 7, newLineNumber: 8 },
                { type: 'context' as const, content: 'line 8', oldLineNumber: 8, newLineNumber: 9 },
            ];

            // 修改2: 第 20 行，1→1（net 0），hunk 包含 17-23 行
            const mod2Hunk = [
                { type: 'context' as const, content: 'line 17', oldLineNumber: 17, newLineNumber: 17 },
                { type: 'context' as const, content: 'line 18', oldLineNumber: 18, newLineNumber: 18 },
                { type: 'context' as const, content: 'line 19', oldLineNumber: 19, newLineNumber: 19 },
                { type: 'remove' as const, content: 'line 20', oldLineNumber: 20 },
                { type: 'add' as const, content: 'modified 20', newLineNumber: 20 },
                { type: 'context' as const, content: 'line 21', oldLineNumber: 21, newLineNumber: 21 },
                { type: 'context' as const, content: 'line 22', oldLineNumber: 22, newLineNumber: 22 },
                { type: 'context' as const, content: 'line 23', oldLineNumber: 23, newLineNumber: 23 },
            ];

            const mod1: ModificationApplyResult = {
                modificationId: 'mod-1',
                modification: { file: 'test.md', operation: 'REPLACE', search: 'line 5', replace: 'new 5a\nnew 5b' },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 5, endLine: 5, matchedContent: 'line 5' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [{ oldStart: 2, oldLines: 7, newStart: 2, newLines: 8, lines: mod1Hunk }] },
                status: 'pending',
            };

            const mod2: ModificationApplyResult = {
                modificationId: 'mod-2',
                modification: { file: 'test.md', operation: 'REPLACE', search: 'line 20', replace: 'modified 20' },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 20, endLine: 20, matchedContent: 'line 20' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [{ oldStart: 17, oldLines: 7, newStart: 17, newLines: 7, lines: mod2Hunk }] },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(content, [mod1, mod2], 'test.md');
            const result = builder.build();

            // 最后一行：原始第 30 行，偏移 +1，新行号应为 31
            const line30 = result.lines.find(l => l.content === 'line 30');
            expect(line30?.newLineNumber).toBe(31);

            // 验证无重复行
            for (let i = 1; i <= 30; i++) {
                if (i === 5 || i === 20) continue; // 被修改的行只有 remove 不是 context
                const occurrences = result.lines.filter(l => l.content === `line ${i}` && l.type === 'context');
                expect(occurrences).toHaveLength(1);
            }

            // 验证右侧行号单调递增
            let lastNew = 0;
            for (const line of result.lines) {
                if (line.newLineNumber !== undefined) {
                    expect(line.newLineNumber).toBeGreaterThanOrEqual(lastNew);
                    lastNew = line.newLineNumber;
                }
            }
        });
    });

    describe('大文件场景', () => {
        it('1000 行文件 + 多修改：行号不应出现跳跃或倒退', () => {
            // 1000 行文件，3 个修改分布在不同位置
            const content = generateContent(1000);

            // 修改1: 第 42 行，1→3 行（net +2）
            const mod1 = createMockModification({
                id: 'mod-1',
                startLine: 42,
                endLine: 42,
                removeLines: ['line 42'],
                addLines: ['new 42a', 'new 42b', 'new 42c'],
            });

            // 修改2: 第 500-502 行，3→1 行（net -2）
            const mod2 = createMockModification({
                id: 'mod-2',
                startLine: 500,
                endLine: 502,
                removeLines: ['line 500', 'line 501', 'line 502'],
                addLines: ['merged 500'],
            });

            // 修改3: 第 930 行，1→2 行（net +1）
            const mod3 = createMockModification({
                id: 'mod-3',
                startLine: 930,
                endLine: 930,
                removeLines: ['line 930'],
                addLines: ['new 930a', 'new 930b'],
            });

            const builder = new FullFileDiffBuilder(content, [mod1, mod2, mod3], 'test.md');
            const result = builder.build();

            // 验证行号单调递增（newLineNumber 不应出现倒退）
            let lastNewLineNumber = 0;
            for (const line of result.lines) {
                if (line.newLineNumber !== undefined) {
                    expect(line.newLineNumber).toBeGreaterThanOrEqual(lastNewLineNumber);
                    lastNewLineNumber = line.newLineNumber;
                }
            }

            // 验证最后一行的 newLineNumber
            // 偏移 = +2 - 2 + 1 = +1
            // 最后一行（原始第 1000 行）newLineNumber 应为 1001
            const lastLine = result.lines.find(l => l.content === 'line 1000');
            expect(lastLine?.newLineNumber).toBe(1001);

            // 验证总行数：1000 + 1（净增）= 1001 个有 newLineNumber 的行
            const linesWithNewNum = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(linesWithNewNum).toHaveLength(1001);
        });
    });

    describe('INSERT→REPLACE 锚点型修改（核心 bug 场景）', () => {
        /**
         * 模拟 DiffToXmlConverter 将纯插入转换为 REPLACE 的场景：
         * search = 锚点行（原文不变的行），replace = 锚点行 + 新增行
         * diff 中只有 add，没有 remove（锚点行作为 context）
         */
        it('纯插入（INSERT→REPLACE 锚点）：总行数应精确等于原始+新增', () => {
            // 20 行文件，在第 5 行后插入 10 行
            // search = "line 4\nline 5"（2 行锚点）
            // replace = "line 4\nline 5\nnew 1\n...\nnew 10"（2 + 10 行）
            const content = generateContent(20);
            const addLines = Array.from({ length: 10 }, (_, i) => `new ${i + 1}`);

            const mod: ModificationApplyResult = {
                modificationId: 'mod-insert-1',
                modification: {
                    file: 'test.md',
                    operation: 'REPLACE',
                    search: 'line 4\nline 5',
                    replace: 'line 4\nline 5\n' + addLines.join('\n'),
                },
                matchResult: {
                    success: true, matchLevel: 'exact', confidence: 1,
                    startLine: 4, endLine: 5,
                    matchedContent: 'line 4\nline 5',
                },
                // diff 字段在新方案中不再使用，仍保留兼容
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(content, [mod], 'test.md');
            const result = builder.build();

            // 总行数 = 20 + 10 = 30（精确）
            const linesWithNewNum = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(linesWithNewNum).toHaveLength(30);

            // 最后一行行号
            const line20 = result.lines.find(l => l.content === 'line 20');
            expect(line20?.newLineNumber).toBe(30);

            // 锚点行应作为 context 带 modificationId
            const anchor4 = result.lines.find(l => l.content === 'line 4' && l.modificationId === 'mod-insert-1');
            expect(anchor4?.type).toBe('context');
            expect(anchor4?.oldLineNumber).toBe(4);

            // 新增行应为 add
            const newLine1 = result.lines.find(l => l.content === 'new 1');
            expect(newLine1?.type).toBe('add');
            expect(newLine1?.modificationId).toBe('mod-insert-1');
        });

        it('多个 INSERT→REPLACE：总行数和偏移应精确累积', () => {
            // 50 行文件，2 个 INSERT→REPLACE 修改
            const content = generateContent(50);

            // 修改1: 在第 10 行后插入 5 行（锚点 L9-10）
            const mod1: ModificationApplyResult = {
                modificationId: 'mod-ins-1',
                modification: {
                    file: 'test.md', operation: 'REPLACE',
                    search: 'line 9\nline 10',
                    replace: 'line 9\nline 10\ninserted A1\ninserted A2\ninserted A3\ninserted A4\ninserted A5',
                },
                matchResult: {
                    success: true, matchLevel: 'exact', confidence: 1,
                    startLine: 9, endLine: 10,
                    matchedContent: 'line 9\nline 10',
                },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            // 修改2: 在第 30 行后插入 3 行（锚点 L29-30）
            const mod2: ModificationApplyResult = {
                modificationId: 'mod-ins-2',
                modification: {
                    file: 'test.md', operation: 'REPLACE',
                    search: 'line 29\nline 30',
                    replace: 'line 29\nline 30\ninserted B1\ninserted B2\ninserted B3',
                },
                matchResult: {
                    success: true, matchLevel: 'exact', confidence: 1,
                    startLine: 29, endLine: 30,
                    matchedContent: 'line 29\nline 30',
                },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(content, [mod1, mod2], 'test.md');
            const result = builder.build();

            // 总行数 = 50 + 5 + 3 = 58
            const linesWithNewNum = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(linesWithNewNum).toHaveLength(58);

            // 最后一行
            const line50 = result.lines.find(l => l.content === 'line 50');
            expect(line50?.newLineNumber).toBe(58);

            // 行号单调递增
            let lastNew = 0;
            for (const line of result.lines) {
                if (line.newLineNumber !== undefined) {
                    expect(line.newLineNumber).toBeGreaterThanOrEqual(lastNew);
                    lastNew = line.newLineNumber;
                }
            }
        });
    });

    describe('大文件 INSERT→REPLACE 场景（复现 log9 偏差）', () => {
        it('1095 行文件 + 5 个修改（3 个 INSERT→REPLACE）：总行数应精确', () => {
            // 模拟 log9 场景的简化版本
            // 原始 1095 行，通过 5 个修改增加到 2087 行
            const content = generateContent(1095);

            // mod[0]: INSERT→REPLACE at L424-425, +470 行
            const mod0: ModificationApplyResult = {
                modificationId: 'mod-0',
                modification: {
                    file: 'test.html', operation: 'REPLACE',
                    search: 'line 424\nline 425',  // 2 行锚点
                    replace: 'line 424\nline 425\n' + Array.from({ length: 470 }, (_, i) => `new0-${i}`).join('\n'),
                },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 424, endLine: 425, matchedContent: 'line 424\nline 425' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            // mod[1]: REPLACE at L542-544, 3 行 → 21 行（net +18）
            const mod1: ModificationApplyResult = {
                modificationId: 'mod-1',
                modification: {
                    file: 'test.html', operation: 'REPLACE',
                    search: 'line 542\nline 543\nline 544',
                    replace: Array.from({ length: 21 }, (_, i) => `new1-${i}`).join('\n'),
                },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 542, endLine: 544, matchedContent: 'line 542\nline 543\nline 544' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            // mod[2]: REPLACE at L560-562, 3 行 → 6 行（net +3）
            const mod2: ModificationApplyResult = {
                modificationId: 'mod-2',
                modification: {
                    file: 'test.html', operation: 'REPLACE',
                    search: 'line 560\nline 561\nline 562',
                    replace: Array.from({ length: 6 }, (_, i) => `new2-${i}`).join('\n'),
                },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 560, endLine: 562, matchedContent: 'line 560\nline 561\nline 562' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            // mod[3]: INSERT→REPLACE at L584-585, +385 行
            const mod3: ModificationApplyResult = {
                modificationId: 'mod-3',
                modification: {
                    file: 'test.html', operation: 'REPLACE',
                    search: 'line 584\nline 585',
                    replace: 'line 584\nline 585\n' + Array.from({ length: 385 }, (_, i) => `new3-${i}`).join('\n'),
                },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 584, endLine: 585, matchedContent: 'line 584\nline 585' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            // mod[4]: INSERT→REPLACE at L1089-1091, +119 行
            const mod4: ModificationApplyResult = {
                modificationId: 'mod-4',
                modification: {
                    file: 'test.html', operation: 'REPLACE',
                    search: 'line 1089\nline 1090\nline 1091',
                    replace: 'line 1089\nline 1090\nline 1091\n' + Array.from({ length: 119 }, (_, i) => `new4-${i}`).join('\n'),
                },
                matchResult: { success: true, matchLevel: 'exact', confidence: 1, startLine: 1089, endLine: 1091, matchedContent: 'line 1089\nline 1090\nline 1091' },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(
                content,
                [mod0, mod1, mod2, mod3, mod4],
                'test.html'
            );
            const result = builder.build();

            // 净增行数 = 470 + 18 + 3 + 385 + 119 = 995
            // 总行数 = 1095 + 995 = 2090?
            // 不对——mod[1] 和 mod[2] 是真正的 REPLACE（search ≠ replace 的前缀）
            // mod[0]: 2 行 → 2+470=472 行, net +470
            // mod[1]: 3 行 → 21 行, net +18
            // mod[2]: 3 行 → 6 行, net +3
            // mod[3]: 2 行 → 2+385=387 行, net +385
            // mod[4]: 3 行 → 3+119=122 行, net +119
            // 总净增 = 470+18+3+385+119 = 995
            // 期望总行数 = 1095 + 995 = 2090
            const linesWithNewNum = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(linesWithNewNum).toHaveLength(2090);

            // 最后一行
            const line1095 = result.lines.find(l => l.content === 'line 1095');
            expect(line1095?.newLineNumber).toBe(2090);

            // 右侧行号单调递增
            let lastNew = 0;
            for (const line of result.lines) {
                if (line.newLineNumber !== undefined) {
                    expect(line.newLineNumber).toBeGreaterThanOrEqual(lastNew);
                    lastNew = line.newLineNumber;
                }
            }

            // 不应有重复的 context 行
            for (let i = 1; i <= 1095; i++) {
                // 被修改覆盖的行不检查（它们以其他角色输出）
                const isModified = [424, 425, 542, 543, 544, 560, 561, 562, 584, 585, 1089, 1090, 1091].includes(i);
                if (isModified) continue;
                const occurrences = result.lines.filter(
                    l => l.content === `line ${i}` && l.type === 'context' && !l.modificationId
                );
                expect(occurrences).toHaveLength(1);
            }
        });
    });

    describe('重叠 matchResult 修改（logA 偏差场景）', () => {
        it('两个 INSERT→REPLACE 共享锚点行：应合并为一个修改', () => {
            // 模拟 hunk 中两个 INSERT 块共享锚点行：
            // mod[1]: search="line 10\nline 11\nline 12", replace="line 10\nline 11\nline 12\nA1\nA2\nA3" (L10-12)
            // mod[2]: search="line 10\nline 11\nline 12\nline 13\nline 14", replace="line 10\n...\nline 14\nB1\n...B5" (L10-14)
            const content = generateContent(30);

            const mod1: ModificationApplyResult = {
                modificationId: 'mod-overlap-1',
                modification: {
                    file: 'test.md', operation: 'REPLACE',
                    search: 'line 10\nline 11\nline 12',
                    replace: 'line 10\nline 11\nline 12\ninsertA1\ninsertA2\ninsertA3',
                },
                matchResult: {
                    success: true, matchLevel: 'exact', confidence: 1,
                    startLine: 10, endLine: 12,
                    matchedContent: 'line 10\nline 11\nline 12',
                },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            const mod2: ModificationApplyResult = {
                modificationId: 'mod-overlap-2',
                modification: {
                    file: 'test.md', operation: 'REPLACE',
                    search: 'line 10\nline 11\nline 12\nline 13\nline 14',
                    replace: 'line 10\nline 11\nline 12\nline 13\nline 14\ninsertB1\ninsertB2\ninsertB3\ninsertB4\ninsertB5',
                },
                matchResult: {
                    success: true, matchLevel: 'exact', confidence: 1,
                    startLine: 10, endLine: 14,
                    matchedContent: 'line 10\nline 11\nline 12\nline 13\nline 14',
                },
                diff: { oldContent: '', newContent: '', hasChanges: true, hunks: [] },
                status: 'pending',
            };

            const builder = new FullFileDiffBuilder(content, [mod1, mod2], 'test.md');
            const result = builder.build();

            // mod1 在 L10-12 后插入 3 行，mod2 在 L10-14 后插入 5 行
            // 合并后：L10-14 (5 原始行) → replace 内容拼接
            // 原始 30 行 + 3 + 5 = 38 行
            const linesWithNewNum = result.lines.filter(l => l.newLineNumber !== undefined);
            expect(linesWithNewNum).toHaveLength(38);

            // 最后一行
            const line30 = result.lines.find(l => l.content === 'line 30');
            expect(line30?.newLineNumber).toBe(38);

            // 行号单调递增
            let lastNew = 0;
            for (const line of result.lines) {
                if (line.newLineNumber !== undefined) {
                    expect(line.newLineNumber).toBeGreaterThanOrEqual(lastNew);
                    lastNew = line.newLineNumber;
                }
            }

            // 插入的行应存在于结果中
            expect(result.lines.some(l => l.content === 'insertA1')).toBe(true);
            expect(result.lines.some(l => l.content === 'insertB5')).toBe(true);
        });
    });
});
