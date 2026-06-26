/**
 * DecisionMapper - MasterBrain 决策到 FSM 事件映射器
 *
 * 将 MasterBrainDecision 转换为 FSM 可处理的事件，
 * 同时提取副作用（terminationReason、lastLLMContent、pendingSubAgentSpec）
 *
 * 注意：DecisionParser 已完成旧决策类型归一化，此处只处理 3 种规范类型
 */

import type { FSMEvent, DecisionReceivedPayload } from '../../fsm/types';
import type {
    MasterBrainDecision,
    SubAgentSpec,
    RespondToUserDecision,
    SpawnSubAgentDecision,
    ExternalGuideSkillInfo,
    ExternalScriptSkillInfo,
} from '../../brain/types';
import type { TerminationReason } from '../types';
import { SubAgentSpecBuilder } from '../builders/SubAgentSpecBuilder';
import { getLogger } from '@services/logger';

const logger = getLogger('DecisionMapper');

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function formatQuestionContent(value: unknown): string {
    if (value == null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        const items = value as unknown[];
        return items.map(formatQuestionContent).filter(Boolean).join('\n');
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : '';
    } catch {
        return '';
    }
}

function extractRequestMoreInputContent(decision: unknown): string {
    const decisionRecord = asRecord(decision);
    const nextStep = asRecord(decisionRecord?.nextStep);

    return formatQuestionContent(
        nextStep?.questionsForUser
        ?? decisionRecord?.questionsForUser
        ?? decisionRecord?.response
        ?? '',
    );
}

/**
 * 决策映射结果
 *
 * 包含 FSM 事件和相关副作用
 */
export interface DecisionMappingResult {
    /** FSM 事件 */
    event: FSMEvent;
    /** 终止原因（如果决策导致终止） */
    terminationReason?: TerminationReason;
    /** 最后的 LLM 内容（用于 UI 显示） */
    lastLLMContent?: string;
    /** 待处理的 SubAgentSpec（用于 DISPATCH 状态） */
    pendingSubAgentSpec?: SubAgentSpec | null;
    /** 是否有进展 */
    madeProgress?: boolean;
}

/**
 * MasterBrain 决策到 FSM 事件映射器
 */
export class DecisionMapper {
    private readonly specBuilder: SubAgentSpecBuilder;

    constructor(specBuilder?: SubAgentSpecBuilder) {
        this.specBuilder = specBuilder ?? new SubAgentSpecBuilder();
    }

    /**
     * 映射 MasterBrain 决策到 FSM 事件
     *
     * DecisionParser 已完成归一化，此处只需处理 3 种规范决策类型
     */
    map(
        decision: MasterBrainDecision,
        guideSkills?: ExternalGuideSkillInfo[],
        scriptSkills?: ExternalScriptSkillInfo[]
    ): DecisionMappingResult {
        switch (decision.decision) {
            case 'RESPOND_TO_USER':
                return this.mapRespondToUser(decision);

            case 'SPAWN_SUB_AGENT':
                return this.mapSpawnSubAgent(decision, guideSkills, scriptSkills);

            case 'REQUEST_MORE_INPUT':
                return this.mapRequestMoreInput(decision);

            default:
                return {
                    event: {
                        type: 'DECISION_INVALID',
                        reason: `Unknown decision type: ${(decision as MasterBrainDecision).decision}`,
                    },
                };
        }
    }

    /**
     * RESPOND_TO_USER 决策映射
     */
    private mapRespondToUser(decision: RespondToUserDecision): DecisionMappingResult {
        return {
            event: {
                type: 'DECISION_RECEIVED',
                payload: {
                    decision: 'RESPOND_TO_USER',
                    details: {
                        rationale: decision.rationale,
                        response: decision.response,
                    },
                } as DecisionReceivedPayload,
            },
            terminationReason: 'text_response',
            lastLLMContent: decision.response,
            madeProgress: true,
        };
    }

    /**
     * SPAWN_SUB_AGENT 决策映射
     *
     * 统一通过 SubAgentSpecBuilder 从 nextStep JIT 构建 SubAgentSpec
     */
    private mapSpawnSubAgent(
        decision: SpawnSubAgentDecision,
        guideSkills?: ExternalGuideSkillInfo[],
        scriptSkills?: ExternalScriptSkillInfo[]
    ): DecisionMappingResult {
        // 统一走 SubAgentSpecBuilder JIT 构建
        const spec = this.specBuilder.buildFromNextStep(decision, guideSkills, scriptSkills);

        if (spec) {
            const nextStepForLog = decision.nextStep as { task?: string } | undefined;
            logger.debug('[DecisionMapper] SPAWN_SUB_AGENT → SubAgentSpecBuilder 构建:', spec.role);
            logger.trace('[DecisionMapper] SubAgentSpec history gate:', {
                includeHistory: spec.includeHistory === true,
                tools: spec.allowedTools,
                taskPreview: nextStepForLog?.task?.slice(0, 160),
            });
        } else {
            logger.warn('[DecisionMapper] SPAWN_SUB_AGENT 但未找到有效的任务信息');
        }

        return {
            event: {
                type: 'DECISION_RECEIVED',
                payload: {
                    decision: 'SPAWN_SUB_AGENT',
                    details: {
                        subAgentSpec: spec,
                        riskAssessment: decision.riskAssessment,
                    },
                } as DecisionReceivedPayload,
            },
            pendingSubAgentSpec: spec,
        };
    }

    /**
     * REQUEST_MORE_INPUT 决策映射
     */
    private mapRequestMoreInput(decision: MasterBrainDecision): DecisionMappingResult {
        // questionsForUser 可能在多个位置，兼容处理
        const content = extractRequestMoreInputContent(decision);

        logger.trace('[DecisionMapper] REQUEST_MORE_INPUT, content:', content.substring(0, 100));

        return {
            event: {
                type: 'DECISION_RECEIVED',
                payload: {
                    decision: 'REQUEST_MORE_INPUT',
                    details: {
                        questionsForUser: content,
                        response: content,
                    },
                } as DecisionReceivedPayload,
            },
            terminationReason: 'awaiting_interaction',
            lastLLMContent: content,
        };
    }
}
