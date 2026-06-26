/**
 * DecisionLogger - 决策日志记录器
 *
 * 职责：
 * - 记录所有 Master Brain 决策
 * - 关联执行结果
 * - 支持按会话查询
 * - 提供统计信息
 *
 * 设计原则：
 * - 内存存储优先（后续可扩展到持久化）
 * - 轻量级，不影响主流程性能
 */

import type { MasterBrainDecisionType } from '../fsm/types';
import type { PersistentDecisionLogEntry } from './types';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * 决策日志输入（不含 id 和 timestamp，由 Logger 自动生成）
 */
export interface DecisionLogInput {
    sessionId: string;
    decisionType: MasterBrainDecisionType;
    rationale: string;
    riskAssessment: {
        level: 'low' | 'medium' | 'high';
        notes: string;
    };
    inputSummary: string;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
    success: boolean;
    output?: unknown;
    error?: string;
    duration?: number;
}

/**
 * 统计信息
 */
export interface DecisionStatistics {
    /** 总决策数 */
    totalDecisions: number;
    /** 按类型分布 */
    decisionTypeCount: Partial<Record<MasterBrainDecisionType, number>>;
    /** 成功率（有执行结果的记录） */
    successRate: number;
}

// ═══════════════════════════════════════════════════════════════
// DecisionLogger 实现
// ═══════════════════════════════════════════════════════════════

/**
 * 决策日志记录器
 *
 * 记录所有 Master Brain 决策及其执行结果
 */
export class DecisionLogger {
    private entries: Map<string, PersistentDecisionLogEntry> = new Map();

    /**
     * 记录决策
     *
     * @param input 决策输入
     * @returns 生成的决策 ID
     */
    log(input: DecisionLogInput): string {
        const id = crypto.randomUUID();
        const entry: PersistentDecisionLogEntry = {
            id,
            sessionId: input.sessionId,
            timestamp: new Date(),
            decisionType: input.decisionType,
            rationale: input.rationale,
            riskAssessment: input.riskAssessment,
            inputSummary: input.inputSummary,
        };

        this.entries.set(id, entry);
        return id;
    }

    /**
     * 更新执行结果
     *
     * @param id 决策 ID
     * @param result 执行结果
     * @returns 是否更新成功
     */
    updateExecutionResult(id: string, result: ExecutionResult): boolean {
        const entry = this.entries.get(id);
        if (!entry) {
            return false;
        }

        entry.executionResult = {
            success: result.success,
            output: result.output,
            error: result.error,
            duration: result.duration,
        };

        return true;
    }

    /**
     * 获取单个决策条目
     *
     * @param id 决策 ID
     */
    getEntry(id: string): PersistentDecisionLogEntry | undefined {
        return this.entries.get(id);
    }

    /**
     * 获取指定会话的所有日志
     *
     * @param sessionId 会话 ID
     */
    getSessionLog(sessionId: string): PersistentDecisionLogEntry[] {
        return Array.from(this.entries.values()).filter(
            (entry) => entry.sessionId === sessionId
        );
    }

    /**
     * 获取所有日志
     */
    getAllLogs(): PersistentDecisionLogEntry[] {
        return Array.from(this.entries.values());
    }

    /**
     * 获取统计信息
     *
     * @param sessionId 会话 ID
     */
    getStatistics(sessionId: string): DecisionStatistics {
        const sessionLogs = this.getSessionLog(sessionId);

        // 决策类型分布
        const decisionTypeCount: Partial<Record<MasterBrainDecisionType, number>> = {};
        for (const log of sessionLogs) {
            decisionTypeCount[log.decisionType] =
                (decisionTypeCount[log.decisionType] ?? 0) + 1;
        }

        // 成功率计算（仅计算有执行结果的记录）
        const logsWithResult = sessionLogs.filter((log) => log.executionResult);
        const successCount = logsWithResult.filter(
            (log) => log.executionResult?.success
        ).length;
        const successRate =
            logsWithResult.length > 0 ? successCount / logsWithResult.length : 0;

        return {
            totalDecisions: sessionLogs.length,
            decisionTypeCount,
            successRate,
        };
    }

    /**
     * 清空所有日志
     */
    clear(): void {
        this.entries.clear();
    }
}
