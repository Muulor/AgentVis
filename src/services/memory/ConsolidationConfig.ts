/**
 * ConsolidationConfig - 类别汇总配置
 *
 * 定义每个事实类别触发汇总的阈值。
 * 当某类别的事实数量达到阈值时，触发 LLM 汇总。
 */

import type { LongTermFactCategory } from './types';

// ============================================================================
// 汇总阈值配置
// ============================================================================

/**
 * 类别汇总阈值
 *
 * 设计原则：
 * - 偏好类出现频繁，较低阈值即可汇总
 * - 身份类较少重复表达，2 条即可
 * - 上下文需要更多验证（容易受环境变化）
 */
export const CONSOLIDATION_THRESHOLDS: Record<LongTermFactCategory, number> = {
  preference_style: 3, // 偏好通常出现频繁，3 条即可汇总
  identity_role: 2, // 身份较少重复表达，2 条足够
  long_term_goal: 3, // 目标需要多次确认
  knowledge_level: 3, // 知识水平需要验证
  // interaction_signals 每条可能是独立的观察信号，不宜过早合并，
  // 阈值设高一些，待积累到一定模式量后再汇总提炼
  interaction_signals: 5,
  task_experience: 5, // 任务经验需要积累到一定量后汇总合并
};

/**
 * 获取指定类别的汇总阈值
 */
export function getConsolidationThreshold(category: LongTermFactCategory): number {
  return CONSOLIDATION_THRESHOLDS[category];
}

/**
 * 检查类别是否达到汇总阈值
 */
export function hasReachedThreshold(category: LongTermFactCategory, count: number): boolean {
  return count >= CONSOLIDATION_THRESHOLDS[category];
}
