/**
 * FSMEngine 单元测试
 *
 * 遵循"先测试后实现"原则
 */

import { describe, it, expect, vi } from 'vitest';
import { FSMEngine } from '../FSMEngine';
import type {
    FSMDefinition,
    FSMContext,
    GuardFn,
    ActionFn,
} from '../types';

// ═══════════════════════════════════════════════════════════════
// 测试用简化状态机定义
// ═══════════════════════════════════════════════════════════════

type TestState = 'IDLE' | 'RUNNING' | 'DONE' | 'ERROR';
type TestEvent =
    | { type: 'START'; payload?: unknown }
    | { type: 'COMPLETE' }
    | { type: 'FAIL'; error: string }
    | { type: 'RESET' };

const createTestContext = (): FSMContext => ({
    loopBudget: 10,
    riskScore: 0,
    progress: false,
    decisionLog: [],
    activeSubAgents: new Map(),
    toolCallHistory: [],
    consecutiveNoProgress: 0,
    subAgentSpawnCount: 0,
});

// 创建测试用 FSM 定义
const createTestFSMDefinition = (options?: {
    guardFn?: GuardFn<TestEvent>;
    actionFn?: ActionFn<TestEvent>;
}): FSMDefinition<TestState, TestEvent> => ({
    initialState: 'IDLE',
    createInitialContext: createTestContext,
    states: {
        IDLE: {
            on: {
                START: {
                    to: 'RUNNING',
                    guard: options?.guardFn,
                    actions: options?.actionFn ? [options.actionFn] : undefined,
                },
            },
        },
        RUNNING: {
            on: {
                COMPLETE: { to: 'DONE' },
                FAIL: { to: 'ERROR' },
            },
        },
        DONE: {
            on: {
                RESET: { to: 'IDLE' },
            },
        },
        ERROR: {
            on: {
                RESET: { to: 'IDLE' },
            },
        },
    },
});

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('FSMEngine', () => {
    describe('基础功能', () => {
        it('应该从初始状态开始', () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            expect(engine.currentState).toBe('IDLE');
        });

        it('应该正确创建初始上下文', () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);
            const context = engine.getContext();

            expect(context.loopBudget).toBe(10);
            expect(context.riskScore).toBe(0);
            expect(context.consecutiveNoProgress).toBe(0);
        });

        it('reset 应该恢复到初始状态', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();
            expect(engine.currentState).toBe('RUNNING');

            engine.reset();
            expect(engine.currentState).toBe('IDLE');
        });
    });

    describe('状态转移', () => {
        it('有效事件应该触发状态转移', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            expect(engine.currentState).toBe('RUNNING');
        });

        it('多步转移应该正确执行', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();
            expect(engine.currentState).toBe('RUNNING');

            engine.send({ type: 'COMPLETE' });
            await engine.step();
            expect(engine.currentState).toBe('DONE');

            engine.send({ type: 'RESET' });
            await engine.step();
            expect(engine.currentState).toBe('IDLE');
        });

        it('无效事件不应该触发转移', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            // IDLE 状态下发送 COMPLETE 事件（无效）
            engine.send({ type: 'COMPLETE' });
            await engine.step();

            expect(engine.currentState).toBe('IDLE');
        });

        it('事件队列应该按顺序处理', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            // 一次性发送多个事件
            engine.send({ type: 'START' });
            engine.send({ type: 'COMPLETE' });

            // 按顺序处理
            await engine.step();
            expect(engine.currentState).toBe('RUNNING');

            await engine.step();
            expect(engine.currentState).toBe('DONE');
        });

        it('空队列时 step 不应报错', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            // 不发送事件直接 step
            await expect(engine.step()).resolves.not.toThrow();
            expect(engine.currentState).toBe('IDLE');
        });
    });

    describe('Guard 函数', () => {
        it('Guard 返回 true 应该允许转移', async () => {
            const guardFn = vi.fn().mockReturnValue(true);
            const definition = createTestFSMDefinition({ guardFn });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            expect(guardFn).toHaveBeenCalled();
            expect(engine.currentState).toBe('RUNNING');
        });

        it('Guard 返回 false 应该阻止转移', async () => {
            const guardFn = vi.fn().mockReturnValue(false);
            const definition = createTestFSMDefinition({ guardFn });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            expect(guardFn).toHaveBeenCalled();
            expect(engine.currentState).toBe('IDLE'); // 未转移
        });

        it('Guard 应该接收正确的参数', async () => {
            const guardFn = vi.fn().mockReturnValue(true);
            const definition = createTestFSMDefinition({ guardFn });
            const engine = new FSMEngine(definition);

            const event = { type: 'START' as const, payload: { test: 'data' } };
            engine.send(event);
            await engine.step();

            expect(guardFn).toHaveBeenCalledWith(
                expect.objectContaining({ loopBudget: 10 }),
                event
            );
        });
    });

    describe('Action 函数', () => {
        it('Action 应该在转移时执行', async () => {
            const actionFn = vi.fn();
            const definition = createTestFSMDefinition({ actionFn });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            expect(actionFn).toHaveBeenCalled();
        });

        it('Action 应该能修改上下文', async () => {
            const actionFn: ActionFn<TestEvent> = (ctx) => {
                ctx.loopBudget = 5;
            };
            const definition = createTestFSMDefinition({ actionFn });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            expect(engine.getContext().loopBudget).toBe(5);
        });

        it('Action 失败时不应阻止状态转移', async () => {
            const actionFn = vi.fn().mockRejectedValue(new Error('Action failed'));
            const definition = createTestFSMDefinition({ actionFn });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });

            // Action 失败不应抛出异常
            await expect(engine.step()).resolves.not.toThrow();
            // 状态仍应转移
            expect(engine.currentState).toBe('RUNNING');
        });
    });

    describe('轨迹记录', () => {
        it('应该记录状态转移轨迹', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            const trace = engine.getTrace();
            expect(trace).toHaveLength(1);
            expect(trace[0]).toMatchObject({
                fromState: 'IDLE',
                toState: 'RUNNING',
                event: { type: 'START' },
            });
        });

        it('轨迹应该包含时间戳', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            const trace = engine.getTrace();
            expect(trace[0]!.timestamp).toBeInstanceOf(Date);
        });

        it('轨迹应该包含迭代次数', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            engine.send({ type: 'COMPLETE' });
            await engine.step();

            const trace = engine.getTrace();
            expect(trace[0]!.iteration).toBe(1);
            expect(trace[1]!.iteration).toBe(2);
        });

        it('轨迹应该包含执行的 Action 名称', async () => {
            const namedAction: ActionFn<TestEvent> = () => { };
            Object.defineProperty(namedAction, 'name', { value: 'testAction' });

            const definition = createTestFSMDefinition({ actionFn: namedAction });
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            const trace = engine.getTrace();
            expect(trace[0]!.actionsExecuted).toContain('testAction');
        });

        it('reset 应该清空轨迹', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();
            expect(engine.getTrace()).toHaveLength(1);

            engine.reset();
            expect(engine.getTrace()).toHaveLength(0);
        });
    });

    describe('预算快照', () => {
        it('轨迹应该包含预算快照', async () => {
            const definition = createTestFSMDefinition();
            const engine = new FSMEngine(definition);

            engine.send({ type: 'START' });
            await engine.step();

            const trace = engine.getTrace();
            expect(trace[0]!.budgetSnapshot).toEqual({
                remaining: 10,
                risk: 0,
                progress: false,
            });
        });
    });
});
