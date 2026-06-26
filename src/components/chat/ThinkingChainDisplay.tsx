/**
 * ThinkingChainDisplay - 静态思维链显示组件
 *
 * 用于在 MessageBubble 中显示持久化的思维链数据
 * 样式与 ThinkingChainSection 保持一致
 *
 * 支持两种数据格式：
 * 1. 新版：thinkingSteps[] 步骤数组（顺序可靠，优先使用）
 * 2. 旧版：{ analyzing, planning, decided } 三字符串累积（向后兼容）
 */

import { useState, useMemo } from 'react';
import { BrainCog, ChevronDown, ChevronRight, Check } from 'lucide-react';
import styles from './ThinkingChainDisplay.module.css';

/** 旧版思维链数据类型（三个阶段的累积字符串） */
export interface ThinkingChainData {
    analyzing: string;
    planning: string;
    decided: string;
}

/** 新版持久化步骤（从 fsmVisualizationStore.ThinkingStep 序列化而来） */
interface PersistedThinkingStep {
    stepNumber: number;
    analyzing: string;
    planning: string;
    decided: string;
}

interface ThinkingChainDisplayProps {
    /** 旧版思维链数据 */
    data: ThinkingChainData;
    /** 新版步骤数组（优先使用，顺序可靠） */
    steps?: PersistedThinkingStep[];
}

/** 单个步骤的合并内容 */
interface StepContent {
    stepNumber: number;
    content: string;
}

/**
 * 从新版步骤数组构建显示内容
 *
 * 每步直接合并其 analyzing → planning → decided，顺序天然正确
 */
function buildStepsFromArray(steps: PersistedThinkingStep[]): StepContent[] {
    return steps
        .map((step) => {
            const parts: string[] = [];
            if (step.analyzing) parts.push(step.analyzing);
            if (step.planning) parts.push(step.planning);
            if (step.decided) parts.push(step.decided);

            if (parts.length === 0) return null;

            return {
                stepNumber: step.stepNumber,
                content: parts.join('\n\n'),
            };
        })
        .filter((s): s is StepContent => s !== null);
}

/**
 * 从旧版累积字符串解析步骤（向后兼容）
 *
 * 注意：此方法存在固有局限——当某阶段内容本身含 \n\n 时
 * 按 \n\n 分割会导致索引错位。新版 thinkingSteps 从根源上避免此问题。
 */
function parseStepsFromLegacy(data: ThinkingChainData): StepContent[] {
    const analyzingParts = data.analyzing ? data.analyzing.split('\n\n').filter(Boolean) : [];
    const planningParts = data.planning ? data.planning.split('\n\n').filter(Boolean) : [];
    const decidedParts = data.decided ? data.decided.split('\n\n').filter(Boolean) : [];

    const stepCount = Math.max(analyzingParts.length, planningParts.length, decidedParts.length);
    if (stepCount === 0) return [];

    const steps: StepContent[] = [];
    for (let i = 0; i < stepCount; i++) {
        const parts: string[] = [];
        const analyzing = analyzingParts[i];
        const planning = planningParts[i];
        const decided = decidedParts[i];
        if (analyzing) parts.push(analyzing);
        if (planning) parts.push(planning);
        if (decided) parts.push(decided);

        if (parts.length > 0) {
            steps.push({ stepNumber: i + 1, content: parts.join('\n\n') });
        }
    }

    return steps;
}

/**
 * 静态思维链显示组件
 */
export function ThinkingChainDisplay({ data, steps: persistedSteps }: ThinkingChainDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    // 优先使用新版步骤数组，回退到旧版解析
    const steps = useMemo(() => {
        if (persistedSteps && persistedSteps.length > 0) {
            return buildStepsFromArray(persistedSteps);
        }
        return parseStepsFromLegacy(data);
    }, [data, persistedSteps]);

    if (steps.length === 0) {
        return null;
    }

    return (
        <div className={styles.container}>
            {/* 标题栏（可点击折叠） */}
            <button
                className={styles.header}
                onClick={() => setIsExpanded(!isExpanded)}
                type="button"
            >
                <BrainCog size={10} className={styles.headerIcon} />
                <span className={styles.headerTitle}>Thought</span>
                <span className={styles.toggle}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
            </button>

            {/* 折叠内容 - 按步显示 */}
            {isExpanded && (
                <div className={styles.stepsContainer}>
                    {steps.map((step) => (
                        <div key={step.stepNumber} className={styles.stepItem}>
                            {/* 步骤指示器 */}
                            <div className={styles.stepIndicator}>
                                <Check size={10} className={styles.checkIcon} />
                            </div>

                            {/* 步骤内容 */}
                            <div className={styles.stepContent}>{step.content}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

