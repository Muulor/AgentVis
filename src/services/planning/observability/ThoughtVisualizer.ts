/**
 * ThoughtVisualizer - 思维链可视化器
 *
 * 职责：
 * - 从 LLM 响应提取思维步骤
 * - 估算信心度
 * - 通过回调通知 UI
 *
 * 设计原则：
 * - 解耦观测与展示
 * - 轻量级处理，不阻塞主流程
 */

import type { AgentLoopCallbacks, ThoughtPhase, ThoughtStep } from './types';

// ═══════════════════════════════════════════════════════════════
// 常量定义
// ═══════════════════════════════════════════════════════════════

/** 不确定性关键词（降低信心度） */
const UNCERTAIN_PATTERNS = [
    /\bmaybe\b/i,
    /\bperhaps\b/i,
    /\bmight\b/i,
    /\buncertain\b/i,
    /\bpossibly\b/i,
    /\bcould be\b/i,
    /\bunsure\b/i,
    /\bI think\b/i,
    /\bI guess\b/i,
];

/** 确定性关键词（提升信心度） */
const CERTAIN_PATTERNS = [
    /\bdefinitely\b/i,
    /\bclearly\b/i,
    /\bcertainly\b/i,
    /\babsolutely\b/i,
    /\bsurely\b/i,
    /\bobviously\b/i,
    /\bwithout doubt\b/i,
];

/** 摘要最大长度 */
const MAX_SUMMARY_LENGTH = 200;

// ═══════════════════════════════════════════════════════════════
// ThoughtVisualizer 实现
// ═══════════════════════════════════════════════════════════════

/**
 * 思维链可视化器
 *
 * 将 LLM 的思维过程转换为结构化的 ThoughtStep，通知 UI 展示
 */
export class ThoughtVisualizer {
    private callbacks: AgentLoopCallbacks;

    constructor(callbacks: AgentLoopCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * 处理 LLM 响应并通知 UI
     *
     * @param phase OODA 阶段
     * @param llmResponse LLM 原始响应
     */
    visualize(phase: ThoughtPhase, llmResponse: string): void {
        const thought = this.extractThinking(llmResponse);
        const confidence = this.estimateConfidence(llmResponse);

        const step: ThoughtStep = {
            phase,
            thought,
            confidence,
            timestamp: new Date(),
        };

        // 通知 UI
        this.callbacks.onThought?.(step);
    }

    /**
     * 从 LLM 响应中提取思维内容
     *
     * 优先提取 <thinking> 标签内容，否则返回摘要
     */
    private extractThinking(content: string): string {
        // 尝试提取 <thinking> 标签
        const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch?.[1]) {
            return thinkingMatch[1].trim();
        }

        // 回退到摘要
        return this.summarize(content);
    }

    /**
     * 生成内容摘要
     *
     * 截取前 N 字符
     */
    private summarize(content: string): string {
        const trimmed = content.trim();
        if (trimmed.length <= MAX_SUMMARY_LENGTH) {
            return trimmed;
        }
        return trimmed.slice(0, MAX_SUMMARY_LENGTH) + '...';
    }

    /**
     * 基于语言模式估算信心度
     *
     * @returns 0-1 之间的信心度值
     */
    private estimateConfidence(content: string): number {
        let score = 0.5; // 基础分数

        // 检查不确定性词汇
        for (const pattern of UNCERTAIN_PATTERNS) {
            if (pattern.test(content)) {
                score -= 0.08;
            }
        }

        // 检查确定性词汇
        for (const pattern of CERTAIN_PATTERNS) {
            if (pattern.test(content)) {
                score += 0.08;
            }
        }

        // 限制在 0-1 范围内
        return Math.max(0, Math.min(1, score));
    }
}
