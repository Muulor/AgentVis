/**
 * MemoryTriggerManager - 混合触发模型状态机
 * 
 *  持久化计数器 + 语义事件混合触发
 * 
 * 触发信号来源（多源）：
 * 1. 计数型（Weak signal）：turns 计数作为兜底
 * 2. 语义型（Strong signal）：用户显式确认 + 候选扫描分数
 * 3. 生命周期事件（Hard trigger）：会话结束、任务完成
 */

import { invoke } from '@tauri-apps/api/core';
import type { ScanResult } from './MemoryCandidateScanner';
import { MEMORY_COMMAND_KEYWORDS } from './MemoryIntentDictionary';
import { getLogger } from '@services/logger';

const logger = getLogger('MemoryTriggerManager');

// ============================================================================
// 配置常量
// ============================================================================

/** 语义分数触发阈值 */
const SEMANTIC_SCORE_THRESHOLD = 5.0;

/** 最大轮次（兜底触发） */
const MAX_TURNS_BEFORE_FALLBACK = 10;

/** 候选分数的最低要求（与轮次兜底配合） */
const MIN_CANDIDATE_SCORE_FOR_FALLBACK = 2.0;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 触发器状态（与后端 MemoryTriggerState 对应）
 */
export interface MemoryTriggerState {
    agentId: string;
    turnsSinceLastExtract: number;
    candidateSignalScore: number;
    lastExtractTurn: number;
    /** 上次处理的消息 ID（用于生命周期触发时检测内容变化） */
    lastProcessedMessageId?: string;
    updatedAt: number;
}

/**
 * 触发决策结果
 */
export interface TriggerDecision {
    /** 是否应该触发 */
    shouldTrigger: boolean;
    /** 触发原因 */
    reason: 'semantic' | 'lifecycle' | 'fallback' | 'none';
    /** 当前状态 */
    state: MemoryTriggerState;
}

// ============================================================================
// 触发器管理器
// ============================================================================

/**
 * 混合触发模型状态机
 */
export class MemoryTriggerManager {
    private agentId: string;

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    /**
     * 记录一轮交互并判断是否应该触发
     * 
     * @param scanResult - 候选扫描结果（来自 MemoryCandidateScanner）
     * @param userMessage - 用户消息内容（用于检测显式记忆请求）
     * @returns 触发决策
     */
    async recordInteractionAndDecide(
        scanResult: ScanResult | null,
        userMessage: string
    ): Promise<TriggerDecision> {
        // 1. 自增轮次计数
        let state = await this.incrementTurn();

        // 2. 累加语义信号分数
        const semanticDelta = this.calculateSemanticDelta(scanResult, userMessage);
        if (semanticDelta > 0) {
            state = await this.accumulateScore(semanticDelta);
            logger.trace(`[MemoryTrigger] 累加语义分数: +${semanticDelta.toFixed(1)}, 当前: ${state.candidateSignalScore.toFixed(1)}`);
        }

        // 3. 判断是否触发
        return this.makeDecision(state, false);
    }

    /**
     * 生命周期事件触发（强制触发，只需新内容即可）
     * 
     * 会话结束、任务完成等场景调用
     * 设计意图：作为"强一致点"，只要有未处理的新内容就触发提取
     * 
     * @param latestMessageId - 最新消息 ID（用于检测内容是否变化）
     */
    async triggerOnLifecycleEvent(latestMessageId?: string): Promise<TriggerDecision> {
        const state = await this.getState();

        // 生命周期触发的核心条件：有新内容未处理
        // 如果没有传入 latestMessageId，或者初次使用（lastProcessedMessageId 为 undefined），认为有新内容
        const hasNewContent = !latestMessageId ||
            !state.lastProcessedMessageId ||
            latestMessageId !== state.lastProcessedMessageId;

        // 辅助条件：有累积分数或轮次（用于日志判断）
        const hasAccumulatedSignals =
            state.candidateSignalScore > 0 || state.turnsSinceLastExtract > 0;

        // 只要有新内容就强制触发（生命周期触发的设计意图）
        if (hasNewContent) {
            logger.trace(`[MemoryTrigger] 生命周期强制触发: 新内容=${hasNewContent}, 累积信号=${hasAccumulatedSignals}`);
            return {
                shouldTrigger: true,
                reason: 'lifecycle',
                state,
            };
        }

        // 内容无变化 → 不触发（避免重复处理）
        logger.trace('[MemoryTrigger] 生命周期检测: 内容无变化，跳过');
        return {
            shouldTrigger: false,
            reason: 'none',
            state,
        };
    }

    /**
     * 更新上次处理的消息 ID
     * 
     * 在生命周期触发处理完成后调用
     */
    async updateLastProcessedMessage(messageId: string): Promise<void> {
        await invoke('memory_trigger_update_last_message', {
            agentId: this.agentId,
            lastProcessedMessageId: messageId,
        });
        logger.trace(`[MemoryTrigger] 已更新 lastProcessedMessageId: ${messageId}`);
    }

    /**
     * 提取完成后重置状态
     */
    async resetAfterExtract(): Promise<void> {
        const state = await this.getState();
        const currentTurn = state.lastExtractTurn + state.turnsSinceLastExtract;

        await invoke<MemoryTriggerState>('memory_trigger_reset', {
            agentId: this.agentId,
            currentTurn,
        });

        logger.trace(`[MemoryTrigger] 状态已重置, 上次提取轮次: ${currentTurn}`);
    }

    /**
     * 获取当前状态
     */
    async getState(): Promise<MemoryTriggerState> {
        return invoke<MemoryTriggerState>('memory_trigger_get_or_create', {
            agentId: this.agentId,
        });
    }

    // =========================================================================
    // 私有方法
    // =========================================================================

    /**
     * 自增轮次
     */
    private async incrementTurn(): Promise<MemoryTriggerState> {
        return invoke<MemoryTriggerState>('memory_trigger_increment_turn', {
            agentId: this.agentId,
        });
    }

    /**
     * 累加分数
     */
    private async accumulateScore(delta: number): Promise<MemoryTriggerState> {
        return invoke<MemoryTriggerState>('memory_trigger_accumulate_score', {
            agentId: this.agentId,
            delta,
        });
    }

    /**
     * 计算语义信号增量
     */
    private calculateSemanticDelta(scanResult: ScanResult | null, userMessage: string): number {
        let delta = 0.0;

        // 1. 用户显式确认（强信号）
        if (scanResult?.hasUserConfirmation) {
            delta += 3.0;
        }

        // 2. 显式记忆请求关键词（强信号）
        const lowerMessage = userMessage.toLowerCase();
        for (const keyword of MEMORY_COMMAND_KEYWORDS) {
            if (lowerMessage.includes(keyword.toLowerCase())) {
                delta += 4.0;
                break; // 只计一次
            }
        }

        // 3. 候选数量（弱信号）
        if (scanResult && scanResult.candidates.length > 0) {
            // 每个候选贡献 0.5 分，最多 2 分
            delta += Math.min(scanResult.candidates.length * 0.5, 2.0);
        }

        return delta;
    }

    /**
     * 做出触发决策
     */
    private makeDecision(state: MemoryTriggerState, isLifecycleEvent: boolean): TriggerDecision {
        // 生命周期事件 -> 强制触发
        if (isLifecycleEvent) {
            return {
                shouldTrigger: true,
                reason: 'lifecycle',
                state,
            };
        }

        // 语义分数达到阈值 -> 语义触发
        if (state.candidateSignalScore >= SEMANTIC_SCORE_THRESHOLD) {
            logger.trace(`[MemoryTrigger]  语义触发: 分数 ${state.candidateSignalScore.toFixed(1)} >= ${SEMANTIC_SCORE_THRESHOLD}`);
            return {
                shouldTrigger: true,
                reason: 'semantic',
                state,
            };
        }

        // 轮次达到上限 + 有基本分数 -> 兜底触发
        if (
            state.turnsSinceLastExtract >= MAX_TURNS_BEFORE_FALLBACK &&
            state.candidateSignalScore >= MIN_CANDIDATE_SCORE_FOR_FALLBACK
        ) {
            logger.trace(`[MemoryTrigger]  兜底触发: 轮次 ${state.turnsSinceLastExtract} >= ${MAX_TURNS_BEFORE_FALLBACK}, 分数 ${state.candidateSignalScore.toFixed(1)}`);
            return {
                shouldTrigger: true,
                reason: 'fallback',
                state,
            };
        }

        // 不触发
        return {
            shouldTrigger: false,
            reason: 'none',
            state,
        };
    }
}

/**
 * 创建 MemoryTriggerManager 实例
 */
export function createMemoryTriggerManager(agentId: string): MemoryTriggerManager {
    return new MemoryTriggerManager(agentId);
}
