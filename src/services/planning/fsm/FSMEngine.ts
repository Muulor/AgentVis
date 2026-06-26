/**
 * FSM 引擎核心实现
 *
 * 纯状态机引擎，职责：
 * - 事件队列管理
 * - Guard 条件检查
 * - Action 执行
 * - 状态转移
 * - 轨迹记录
 *
 * 设计原则：
 * - FSMEngine 是纯逻辑，不包含业务逻辑
 * - 不直接调用 LLM
 * - 只负责 match → guard → action → transition
 */

import type {
    FSMDefinition,
    FSMContext,
    FSMTransition,
    FSMTraceEntry,
    IFSMEngine,
} from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('FSMEngine');

/**
 * FSM 引擎
 *
 * @template S - 状态类型
 * @template E - 事件类型
 */
export class FSMEngine<S extends string, E extends { type: string }>
    implements IFSMEngine<S, E> {
    /** 当前状态 */
    private state: S;

    /** 运行时上下文 */
    private context: FSMContext;

    /** 事件队列 */
    private eventQueue: E[] = [];

    /** 执行轨迹 */
    private trace: FSMTraceEntry<S, E>[] = [];

    /** 状态机定义 */
    private readonly definition: FSMDefinition<S, E>;

    /** 迭代计数 */
    private iterationCount = 0;

    constructor(definition: FSMDefinition<S, E>) {
        this.definition = definition;
        this.state = definition.initialState;
        this.context = definition.createInitialContext();
    }

    // ═══════════════════════════════════════════════════════════════
    // 公共接口
    // ═══════════════════════════════════════════════════════════════

    /**
     * 获取当前状态
     */
    get currentState(): S {
        return this.state;
    }

    /**
     * 获取当前上下文（只读）
     */
    getContext(): Readonly<FSMContext> {
        return this.context;
    }

    /**
     * 获取执行轨迹
     */
    getTrace(): FSMTraceEntry<S, E>[] {
        return [...this.trace];
    }

    /**
     * 发送事件到队列
     */
    send(event: E): void {
        this.eventQueue.push(event);
    }

    /**
     * 执行一步（处理当前事件队列中的一个事件）
     */
    async step(): Promise<void> {
        // 队列为空，直接返回
        if (this.eventQueue.length === 0) {
            return;
        }

        const event = this.eventQueue.shift();
        if (!event) return;
        const startTime = Date.now();

        // 查找转移
        const transition = this.findTransition(this.state, event);

        if (!transition) {
            // 无匹配转移，记录警告但不报错
            logger.warn(
                `[FSM] 无匹配转移: 状态=${this.state}, 事件=${event.type}`
            );
            return;
        }

        // 执行 Guard 检查
        if (transition.guard) {
            const guardResult = transition.guard(this.context, event);
            if (!guardResult) {
                logger.debug(`[FSM] Guard 阻止转移: ${event.type}`);
                return;
            }
        }

        // 记录起始状态
        const fromState = this.state;

        // 执行 Actions
        const actionsExecuted: string[] = [];
        if (transition.actions) {
            for (const action of transition.actions) {
                actionsExecuted.push(action.name || 'anonymous');
                try {
                    await action(this.context, event);
                } catch (error) {
                    // Action 失败记录但不阻止转移
                    logger.error(`[FSM] Action 执行失败:`, error);
                }
            }
        }

        // 状态转移
        this.state = transition.to;
        this.iterationCount++;

        // 记录轨迹
        const traceEntry: FSMTraceEntry<S, E> = {
            timestamp: new Date(),
            iteration: this.iterationCount,
            fromState,
            toState: this.state,
            event,
            guardResult: transition.guard ? true : undefined,
            actionsExecuted,
            budgetSnapshot: {
                remaining: this.context.loopBudget,
                risk: this.context.riskScore,
                progress: this.context.progress,
            },
            duration: Date.now() - startTime,
        };

        this.trace.push(traceEntry);
    }

    /**
     * 重置到初始状态
     */
    reset(): void {
        this.state = this.definition.initialState;
        this.context = this.definition.createInitialContext();
        this.eventQueue = [];
        this.trace = [];
        this.iterationCount = 0;
    }

    // ═══════════════════════════════════════════════════════════════
    // 私有方法
    // ═══════════════════════════════════════════════════════════════

    /**
     * 查找匹配的转移
     */
    private findTransition(
        state: S,
        event: E
    ): FSMTransition<S, E> | undefined {
        const stateConfig = this.definition.states[state];

        const transitions = stateConfig.on[event.type];
        if (!transitions) {
            return undefined;
        }

        // 支持单个转移或多个转移（用于多个 Guard 的情况）
        if (Array.isArray(transitions)) {
            // 返回第一个 Guard 通过的转移，如果没有 Guard 则返回第一个
            for (const t of transitions) {
                if (!t.guard || t.guard(this.context, event)) {
                    return t;
                }
            }
            return undefined;
        }

        return transitions;
    }
}
