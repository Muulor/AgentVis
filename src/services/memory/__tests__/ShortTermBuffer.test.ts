/**
 * ShortTermBuffer 单元测试
 *
 * 覆盖滑动窗口、水位线检测、FIFO 弹出、配置变更、恢复、删除等核心逻辑
 * 
 * 重构后：buffer 存储 Message[]，水位线基于 user 消息数计算
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShortTermBuffer, createShortTermBuffer } from '../ShortTermBuffer';
import type { Message } from '../types';

// ==================== 测试工具 ====================

/** 创建测试消息 */
function createMessage(role: 'user' | 'assistant', content: string, id?: string): Message {
    return {
        id: id ?? `msg_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        agentId: 'test-agent',
        role,
        content,
        createdAt: Date.now(),
    };
}

/** 添加 N 个 user+assistant 消息对到缓冲区 */
function fillBuffer(buffer: ShortTermBuffer, count: number): void {
    for (let i = 0; i < count; i++) {
        buffer.addMessages(
            createMessage('user', `用户消息 ${i}`),
            createMessage('assistant', `助手回复 ${i}`)
        );
    }
}

// ==================== 测试用例 ====================

describe('ShortTermBuffer', () => {
    let buffer: ShortTermBuffer;

    beforeEach(() => {
        // 窗口大小 5（user 消息数上限），水位线 60%=3 个 user 时触发，批次 40%=2 个 user 弹出
        buffer = new ShortTermBuffer({
            windowSize: 5,
            watermarkThreshold: 0.6,
            batchSizeRatio: 0.4,
        });
    });

    // ───────────────────────────────────────────────────
    // 基本操作
    // ───────────────────────────────────────────────────

    describe('基本操作', () => {
        it('初始状态应为空', () => {
            expect(buffer.size()).toBe(0);
            expect(buffer.getUsageRatio()).toBe(0);
            expect(buffer.getAllMessages()).toEqual([]);
        });

        it('addMessages 应正确添加两条消息', () => {
            const result = buffer.addMessages(
                createMessage('user', '你好'),
                createMessage('assistant', '你好！')
            );

            expect(result).toBe(false); // 未超出窗口
            expect(buffer.size()).toBe(2); // 2 条消息
            expect(buffer.getUserMessageCount()).toBe(1); // 1 条 user
        });

        it('addMessages 应正确添加多条消息', () => {
            buffer.addMessages(
                createMessage('user', 'A'),
                createMessage('assistant', 'B'),
                createMessage('user', 'C')
            );

            expect(buffer.size()).toBe(3);
            expect(buffer.getUserMessageCount()).toBe(2);
        });

        it('getAllMessages 应按正确顺序返回', () => {
            buffer.addMessages(
                createMessage('user', 'A'),
                createMessage('assistant', 'B')
            );
            buffer.addMessages(
                createMessage('user', 'C'),
                createMessage('assistant', 'D')
            );

            const messages = buffer.getAllMessages();
            expect(messages.length).toBe(4);
            expect(messages[0]!.content).toBe('A');
            expect(messages[1]!.content).toBe('B');
            expect(messages[2]!.content).toBe('C');
            expect(messages[3]!.content).toBe('D');
        });
    });

    // ───────────────────────────────────────────────────
    // 窗口溢出（基于 user 消息数）
    // ───────────────────────────────────────────────────

    describe('窗口溢出', () => {
        it('user 消息数超出窗口时应返回 true', () => {
            fillBuffer(buffer, 5); // 5 个 user 消息，恰好满
            const result = buffer.addMessages(
                createMessage('user', '第6轮'),
                createMessage('assistant', '回复')
            );

            expect(result).toBe(true); // 超出窗口
        });

        it('恰好等于窗口大小时不触发溢出', () => {
            fillBuffer(buffer, 4);
            const result = buffer.addMessages(
                createMessage('user', '第5轮'),
                createMessage('assistant', '回复')
            );

            expect(result).toBe(false); // 恰好满，未超出
            expect(buffer.getUserMessageCount()).toBe(5);
        });

        it('只添加 assistant 消息不影响窗口溢出', () => {
            fillBuffer(buffer, 5); // 5 个 user
            // 再添加 1 条 assistant 不应触发溢出
            const result = buffer.addMessages(
                createMessage('assistant', '额外回复')
            );

            expect(result).toBe(false);
            expect(buffer.getUserMessageCount()).toBe(5);
        });
    });

    // ───────────────────────────────────────────────────
    // 水位线检测（基于 user 消息数）
    // ───────────────────────────────────────────────────

    describe('水位线检测', () => {
        it('user 消息数低于阈值时不触发', () => {
            fillBuffer(buffer, 2); // 2/5 = 40% < 60%
            expect(buffer.isAboveWatermark()).toBe(false);
            expect(buffer.getUsageRatio()).toBeCloseTo(0.4);
        });

        it('恰好达到阈值时应触发', () => {
            fillBuffer(buffer, 3); // 3/5 = 60% >= 60%
            expect(buffer.isAboveWatermark()).toBe(true);
            expect(buffer.getUsageRatio()).toBeCloseTo(0.6);
        });

        it('超过阈值时应触发', () => {
            fillBuffer(buffer, 4); // 4/5 = 80% >= 60%
            expect(buffer.isAboveWatermark()).toBe(true);
        });

        it('连续 user 消息应正确计数', () => {
            // 3 条 user + 1 条 assistant
            buffer.addMessages(
                createMessage('user', 'A'),
                createMessage('user', 'B'),
                createMessage('user', 'C'),
                createMessage('assistant', 'Reply')
            );

            expect(buffer.getUserMessageCount()).toBe(3);
            expect(buffer.getUsageRatio()).toBeCloseTo(0.6);
            expect(buffer.isAboveWatermark()).toBe(true);
        });
    });

    // ───────────────────────────────────────────────────
    // FIFO 批次弹出（按 user 消息边界切割）
    // ───────────────────────────────────────────────────

    describe('popBatchForConversion', () => {
        it('应弹出最早的 N 个 user 消息及跟随的 assistant', () => {
            fillBuffer(buffer, 5);

            // batchSizeRatio=0.4, windowSize=5 → ceil(2) = 2 个 user 消息
            const batch = buffer.popBatchForConversion();
            // 2 个 user + 2 个 assistant = 4 条消息
            expect(batch.length).toBe(4);
            expect(batch[0]!.content).toBe('用户消息 0');
            expect(batch[1]!.content).toBe('助手回复 0');
            expect(batch[2]!.content).toBe('用户消息 1');
            expect(batch[3]!.content).toBe('助手回复 1');

            // 缓冲区应剩余 6 条消息（3 个 user + 3 个 assistant）
            expect(buffer.size()).toBe(6);
            expect(buffer.getUserMessageCount()).toBe(3);
        });

        it('缓冲区不足一个批次时应弹出全部', () => {
            fillBuffer(buffer, 1);

            const batch = buffer.popBatchForConversion();
            expect(batch.length).toBe(2); // 1 个 user + 1 个 assistant
            expect(buffer.size()).toBe(0);
        });

        it('连续 user 消息后跟 assistant 应正确切割', () => {
            // user, user, assistant, user, assistant
            buffer.addMessages(
                createMessage('user', 'U1'),
                createMessage('user', 'U2'),
                createMessage('assistant', 'A1'),
                createMessage('user', 'U3'),
                createMessage('assistant', 'A2')
            );

            // 弹出 2 个 user → U1, U2 及其后的 A1
            const batch = buffer.popBatchForConversion();
            expect(batch.length).toBe(3);
            expect(batch[0]!.content).toBe('U1');
            expect(batch[1]!.content).toBe('U2');
            expect(batch[2]!.content).toBe('A1');

            // 剩余 U3, A2
            expect(buffer.size()).toBe(2);
            expect(buffer.getUserMessageCount()).toBe(1);
        });
    });

    // ───────────────────────────────────────────────────
    // 消息删除
    // ───────────────────────────────────────────────────

    describe('removeByMessageId', () => {
        it('删除 user 消息后水位线应下降', () => {
            const userId = 'user-to-delete';
            buffer.addMessages(
                createMessage('user', 'A', userId),
                createMessage('assistant', 'B'),
                createMessage('user', 'C'),
                createMessage('assistant', 'D'),
                createMessage('user', 'E'),
                createMessage('assistant', 'F')
            );

            expect(buffer.getUserMessageCount()).toBe(3);
            expect(buffer.isAboveWatermark()).toBe(true); // 3/5 >= 60%

            const removed = buffer.removeByMessageId(userId);
            expect(removed).toBe(true);
            expect(buffer.getUserMessageCount()).toBe(2);
            expect(buffer.isAboveWatermark()).toBe(false); // 2/5 = 40% < 60%
        });

        it('删除 assistant 消息应成功', () => {
            const assistantId = 'assistant-to-delete';
            buffer.addMessages(
                createMessage('user', 'A'),
                createMessage('assistant', 'B', assistantId)
            );

            const removed = buffer.removeByMessageId(assistantId);
            expect(removed).toBe(true);
            expect(buffer.size()).toBe(1);
            // user 消息数不变
            expect(buffer.getUserMessageCount()).toBe(1);
        });

        it('删除不存在的消息应返回 false', () => {
            buffer.addMessages(
                createMessage('user', 'A'),
                createMessage('assistant', 'B')
            );

            const removed = buffer.removeByMessageId('non-existent');
            expect(removed).toBe(false);
            expect(buffer.size()).toBe(2);
        });

        it('连续删除多条消息应正确', () => {
            const id1 = 'msg-1';
            const id2 = 'msg-2';
            buffer.addMessages(
                createMessage('user', 'A', id1),
                createMessage('assistant', 'B', id2),
                createMessage('user', 'C'),
                createMessage('assistant', 'D')
            );

            buffer.removeByMessageId(id1);
            buffer.removeByMessageId(id2);
            expect(buffer.size()).toBe(2);
            expect(buffer.getUserMessageCount()).toBe(1);
        });
    });

    // ───────────────────────────────────────────────────
    // 配置变更
    // ───────────────────────────────────────────────────

    describe('updateConfig', () => {
        it('缩小窗口应产生待转换批次', () => {
            fillBuffer(buffer, 5);

            // 将窗口从 5 缩小到 3，应产生 2 个 user + 2 个 assistant = 4 条待转换
            buffer.updateConfig({ windowSize: 3 });

            const pending = buffer.getPendingConversionBatch();
            expect(pending.length).toBe(4);
            expect(buffer.getUserMessageCount()).toBe(3);
        });

        it('扩大窗口不应产生待转换批次', () => {
            fillBuffer(buffer, 3);

            buffer.updateConfig({ windowSize: 10 });

            const pending = buffer.getPendingConversionBatch();
            expect(pending.length).toBe(0);
            expect(buffer.getUserMessageCount()).toBe(3);
        });

        it('连续调用 getPendingConversionBatch 第二次应返回空', () => {
            fillBuffer(buffer, 5);
            buffer.updateConfig({ windowSize: 3 });

            buffer.getPendingConversionBatch(); // 第一次取出
            const second = buffer.getPendingConversionBatch(); // 第二次应为空
            expect(second.length).toBe(0);
        });
    });

    // ───────────────────────────────────────────────────
    // 恢复与清空
    // ───────────────────────────────────────────────────

    describe('restore / clear', () => {
        it('restore 应替换当前缓冲区', () => {
            fillBuffer(buffer, 2);

            const messages: Message[] = [
                createMessage('user', '恢复1'),
                createMessage('assistant', '回复1'),
            ];

            buffer.restore(messages);
            expect(buffer.size()).toBe(2);
            expect(buffer.getUserMessageCount()).toBe(1);
            expect(buffer.getAllMessages()[0]!.content).toBe('恢复1');
        });

        it('clear 应清空缓冲区', () => {
            fillBuffer(buffer, 3);
            buffer.clear();

            expect(buffer.size()).toBe(0);
            expect(buffer.getUserMessageCount()).toBe(0);
            expect(buffer.getAllMessages()).toEqual([]);
        });
    });

    // ───────────────────────────────────────────────────
    // 工厂函数
    // ───────────────────────────────────────────────────

    describe('createShortTermBuffer', () => {
        it('应使用默认配置创建', () => {
            const defaultBuffer = createShortTermBuffer();
            const config = defaultBuffer.getConfig();

            expect(config.windowSize).toBe(10);
            expect(config.watermarkThreshold).toBe(0.6);
            expect(config.batchSizeRatio).toBe(0.4);
        });

        it('应使用自定义配置创建', () => {
            const customBuffer = createShortTermBuffer({ windowSize: 20 });
            expect(customBuffer.getWindowSize()).toBe(20);
        });
    });
});
