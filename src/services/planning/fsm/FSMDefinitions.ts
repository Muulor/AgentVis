/**
 * FSM 定义解析与工厂
 *
 * 提供 YAML DSL 解析和预定义 FSM 创建功能
 */

import yaml from 'js-yaml';
import type {
    FSMDefinition,
    FSMContext,
    FSMEvent,
    FSMTransition,
    StateConfig,
    AgentServiceState,
    SubAgentState,
    GuardFn,
    ActionFn,
} from './types';
import { getGuard, GUARD_REGISTRY } from './guards';
import { getAction, ACTION_REGISTRY } from './actions';
import { PLANNING_CONSTANTS } from '../PlanningConstants';
import { getLogger } from '@services/logger';

const logger = getLogger('FSMDefinitions');

// ═══════════════════════════════════════════════════════════════
// YAML FSM 定义类型
// ═══════════════════════════════════════════════════════════════

/**
 * YAML 中的转移定义
 */
interface YAMLTransition {
    guard?: string;
    actions?: string[];
    next: string;
}

/**
 * YAML 中的状态定义
 */
interface YAMLState {
    on: Record<string, YAMLTransition>;
}

/**
 * YAML FSM 定义结构
 */
interface YAMLFSMDefinition {
    version?: string;
    name?: string;
    initialState: string;
    states: Record<string, YAMLState>;
}

// ═══════════════════════════════════════════════════════════════
// 解析函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建默认初始上下文
 */
const createDefaultContext = (): FSMContext => ({
    loopBudget: PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET,
    riskScore: 0,
    progress: false,
    decisionLog: [],
    activeSubAgents: new Map(),
    toolCallHistory: [],
    consecutiveNoProgress: 0,
    subAgentSpawnCount: 0,
});

const requireGuard = (name: string): GuardFn<FSMEvent> => {
    const guard = GUARD_REGISTRY[name];
    if (!guard) {
        throw new Error(`[FSM] Missing required Guard: ${name}`);
    }
    return guard;
};

const requireAction = (name: string): ActionFn<FSMEvent> => {
    const action = ACTION_REGISTRY[name];
    if (!action) {
        throw new Error(`[FSM] Missing required Action: ${name}`);
    }
    return action;
};

/**
 * 解析 Guard 函数
 */
const parseGuard = (guardName: string): GuardFn<FSMEvent> | undefined => {
    const guard = getGuard(guardName);
    if (!guard) {
        logger.warn(`[FSM] 未找到 Guard: ${guardName}`);
    }
    return guard;
};

/**
 * 解析 Action 函数列表
 */
const parseActions = (actionNames: string[]): ActionFn<FSMEvent>[] => {
    const actions: ActionFn<FSMEvent>[] = [];

    for (const name of actionNames) {
        const action = getAction(name);
        if (action) {
            actions.push(action);
        } else {
            logger.warn(`[FSM] 未找到 Action: ${name}`);
        }
    }

    return actions;
};

/**
 * 解析 YAML 转移定义
 */
const parseTransition = <S extends string>(
    yamlTransition: YAMLTransition
): FSMTransition<S, FSMEvent> => {
    const transition: FSMTransition<S, FSMEvent> = {
        to: yamlTransition.next as S,
    };

    if (yamlTransition.guard) {
        transition.guard = parseGuard(yamlTransition.guard);
    }

    if (yamlTransition.actions && yamlTransition.actions.length > 0) {
        transition.actions = parseActions(yamlTransition.actions);
    }

    return transition;
};

/**
 * 解析 YAML 状态定义
 */
const parseState = <S extends string>(
    yamlState: YAMLState
): StateConfig<S, FSMEvent> => {
    const stateConfig: StateConfig<S, FSMEvent> = {
        on: {},
    };

    for (const [eventType, yamlTransition] of Object.entries(yamlState.on)) {
        stateConfig.on[eventType] = parseTransition(yamlTransition);
    }

    return stateConfig;
};

/**
 * 从 YAML 字符串解析 FSM 定义
 *
 * @param yamlContent - YAML 内容字符串
 * @returns FSM 定义
 */
export const parseFSMDefinition = <S extends string>(
    yamlContent: string
): FSMDefinition<S, FSMEvent> => {
    const yamlDef = yaml.load(yamlContent) as YAMLFSMDefinition;

    const states: Record<S, StateConfig<S, FSMEvent>> = {} as Record<
        S,
        StateConfig<S, FSMEvent>
    >;

    for (const [stateName, yamlState] of Object.entries(yamlDef.states)) {
        states[stateName as S] = parseState(yamlState);
    }

    return {
        initialState: yamlDef.initialState as S,
        states,
        createInitialContext: createDefaultContext,
    };
};

// ═══════════════════════════════════════════════════════════════
// 预定义 FSM 创建函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Agent Service FSM 定义
 *
 * 硬编码版本，不依赖外部 YAML 文件
 */
export const createAgentServiceFSMDefinition = (): FSMDefinition<
    AgentServiceState,
    FSMEvent
> => {
    // 预先获取必要的 Guard 和 Action，确保类型安全
    const loopBudgetRemaining = requireGuard('loopBudgetRemaining');
    // hasCurrentDecision 不再作为 Guard 使用，改用 storeDecision Action
    const budgetExhausted = requireGuard('budgetExhausted');
    const consecutiveNoProgressExceeded = requireGuard('consecutiveNoProgressExceeded');
    const toolThrashingDetected = requireGuard('toolThrashingDetected');
    const overDelegationDetected = requireGuard('overDelegationDetected');

    const initLoopBudget = requireAction('initLoopBudget');
    const storeSession = requireAction('storeSession');
    const storeDecision = requireAction('storeDecision');
    const recordProgress = requireAction('recordProgress');
    const recordNoProgress = requireAction('recordNoProgress');
    const decrementBudget = requireAction('decrementBudget');

    return {
        initialState: 'IDLE',
        createInitialContext: createDefaultContext,
        states: {
            IDLE: {
                on: {
                    USER_REQUEST: {
                        to: 'PREPARE_CONTEXT',
                        guard: loopBudgetRemaining,
                        actions: [initLoopBudget, storeSession],
                    },
                },
            },
            PREPARE_CONTEXT: {
                on: {
                    CONTEXT_READY: {
                        to: 'MASTER_DECISION',
                    },
                    CONTEXT_ERROR: {
                        to: 'TERMINATE',
                        actions: [recordNoProgress],
                    },
                },
            },
            MASTER_DECISION: {
                on: {
                    DECISION_RECEIVED: {
                        to: 'DISPATCH',
                        actions: [storeDecision],
                    },
                    DECISION_INVALID: {
                        to: 'TERMINATE',
                        actions: [recordNoProgress],
                    },
                },
            },
            DISPATCH: {
                on: {
                    ACTION_COMPLETED: {
                        to: 'OBSERVE',
                        actions: [recordProgress],
                    },
                    ACTION_FAILED: {
                        to: 'OBSERVE',
                        actions: [recordNoProgress],
                    },
                    AGENT_OUTPUT: {
                        to: 'OBSERVE',
                    },
                    AGENT_ERROR: {
                        to: 'OBSERVE',
                        actions: [recordNoProgress],
                    },
                },
            },
            OBSERVE: {
                on: {
                    CONTINUE: {
                        to: 'EVALUATE',
                    },
                    TIMEOUT: {
                        to: 'TERMINATE',
                    },
                },
            },
            EVALUATE: {
                on: {
                    CONTINUE: [
                        {
                            to: 'TERMINATE',
                            guard: budgetExhausted,
                        },
                        {
                            to: 'TERMINATE',
                            guard: consecutiveNoProgressExceeded,
                        },
                        {
                            to: 'TERMINATE',
                            guard: toolThrashingDetected,
                        },
                        {
                            to: 'TERMINATE',
                            guard: overDelegationDetected,
                        },
                        {
                            to: 'PREPARE_CONTEXT',
                            actions: [decrementBudget],
                        },
                    ],
                    TIMEOUT: {
                        to: 'TERMINATE',
                    },
                },
            },
            TERMINATE: {
                on: {},
            },
        },
    };
};

/**
 * 创建 Sub-Agent FSM 定义
 *
 * 子 Agent 的 FSM 是线性生命周期（SPAWNED → COMPLETED/FAILED），
 * 内部的 ReAct 原子事件循环由 SubAgentRunner 管理，不体现在 FSM 状态中
 */
export const createSubAgentFSMDefinition = (): FSMDefinition<
    SubAgentState,
    FSMEvent
> => ({
    initialState: 'SPAWNED',
    createInitialContext: createDefaultContext,
    states: {
        SPAWNED: {
            on: {
                CONTEXT_READY: {
                    to: 'INPUT_VALIDATED',
                },
                CONTEXT_ERROR: {
                    to: 'FAILED',
                },
            },
        },
        INPUT_VALIDATED: {
            on: {
                ACTION_COMPLETED: {
                    to: 'RUNNING',
                },
                ACTION_FAILED: {
                    to: 'FAILED',
                },
            },
        },
        RUNNING: {
            on: {
                ACTION_COMPLETED: {
                    to: 'OUTPUT_CHECKED',
                },
                ACTION_FAILED: {
                    to: 'FAILED',
                },
                TIMEOUT: {
                    to: 'FAILED',
                },
            },
        },
        OUTPUT_CHECKED: {
            on: {
                CONTINUE: {
                    to: 'COMPLETED',
                },
                ACTION_FAILED: {
                    to: 'FAILED',
                },
            },
        },
        COMPLETED: {
            on: {},
        },
        FAILED: {
            on: {},
        },
    },
});
