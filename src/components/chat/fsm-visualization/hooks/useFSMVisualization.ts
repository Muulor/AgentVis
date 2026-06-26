/**
 * useFSMVisualization - FSM 可视化 Hook
 *
 * 提供将 AgentLoop 回调连接到 FSM 可视化 Store 的方法
 */

import { useCallback } from 'react';
import { useFSMVisualizationStore } from '@stores/fsmVisualizationStore';
import type { ThinkingPhaseEvent } from '@/services/planning/agent-loop';
import type { AgentServiceState } from '@/services/planning/fsm/types';
import type { GovernorSnapshot } from '@/services/planning/agent-loop/LoopGovernor';
import type { MasterBrainDecision } from '@/services/planning/brain/types';
import type { SubAgentSpec, SubAgentOutput } from '@/services/planning/sub-agents/types';
import type { AgentLoopCallbacks } from '@/services/planning/agent-loop';

/**
 * FSM 可视化相关的回调接口
 */
export interface FSMVisualizationCallbacks {
    /** 思维阶段事件 */
    onThinkingPhase: (event: ThinkingPhaseEvent) => void;
    /** FSM 状态变更 */
    onFSMStateChange: (from: AgentServiceState, to: AgentServiceState) => void;
    /** 治理器指标更新 */
    onMetricsUpdate: (snapshot: GovernorSnapshot) => void;
    /** Sub-Agent 创建 */
    onSubAgentSpawn: (spec: SubAgentSpec) => void;
    /** Sub-Agent 完成 */
    onSubAgentComplete: (id: string, output: SubAgentOutput) => void;
    /** Sub-Agent 失败 */
    onSubAgentFail: (id: string, error: string) => void;
}

/**
 * FSM 可视化 Hook
 *
 * @returns 回调函数，可直接传递给 AgentLoop
 */
export function useFSMVisualization(contextId: string) {
    const {
        handleThinkingPhaseEvent,
        handleFSMStateChange,
        updateMetrics,
        recordSubAgentSpawn,
        recordSubAgentComplete,
        recordSubAgentFail,
        setCurrentDecision,
        reset,
    } = useFSMVisualizationStore();

    // 创建稳定的回调函数
    const onThinkingPhase = useCallback(
        (event: ThinkingPhaseEvent) => {
            handleThinkingPhaseEvent(event, contextId);
        },
        [contextId, handleThinkingPhaseEvent]
    );

    const onFSMStateChange = useCallback(
        (from: AgentServiceState, to: AgentServiceState) => {
            handleFSMStateChange(from, to, contextId);
        },
        [contextId, handleFSMStateChange]
    );

    const onMetricsUpdate = useCallback(
        (snapshot: GovernorSnapshot) => {
            updateMetrics(snapshot, contextId);
        },
        [contextId, updateMetrics]
    );

    const onSubAgentSpawn = useCallback(
        (spec: SubAgentSpec) => {
            const id = crypto.randomUUID();
            recordSubAgentSpawn(id, spec, contextId);
        },
        [contextId, recordSubAgentSpawn]
    );

    const onSubAgentComplete = useCallback(
        (id: string, output: SubAgentOutput) => {
            recordSubAgentComplete(id, output, contextId);
        },
        [contextId, recordSubAgentComplete]
    );

    const onSubAgentFail = useCallback(
        (id: string, error: string) => {
            recordSubAgentFail(id, error, contextId);
        },
        [contextId, recordSubAgentFail]
    );

    // 设置决策
    const setDecision = useCallback(
        (decision: MasterBrainDecision | null) => {
            setCurrentDecision(decision, contextId);
        },
        [contextId, setCurrentDecision]
    );

    // 重置可视化状态
    const resetVisualization = useCallback(() => {
        reset(contextId);
    }, [contextId, reset]);

    // 获取可传递给 AgentLoop 的完整回调对象
    const getCallbacks = useCallback((): Partial<AgentLoopCallbacks> => ({
        onThinkingPhase,
        onFSMStateChange,
        onMetricsUpdate,
        onSubAgentSpawn,
        onSubAgentComplete,
        onSubAgentFail,
    }), [
        onThinkingPhase,
        onFSMStateChange,
        onMetricsUpdate,
        onSubAgentSpawn,
        onSubAgentComplete,
        onSubAgentFail,
    ]);

    return {
        // 单独的回调函数
        onThinkingPhase,
        onFSMStateChange,
        onMetricsUpdate,
        onSubAgentSpawn,
        onSubAgentComplete,
        onSubAgentFail,

        // 设置决策
        setDecision,

        // 重置
        resetVisualization,

        // 获取完整回调对象（用于传递给 AgentLoop）
        getCallbacks,
    };
}
