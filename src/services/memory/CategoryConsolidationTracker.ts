/**
 * CategoryConsolidationTracker - 类别汇总状态追踪器
 *
 * 职责：
 * 1. 追踪每个类别的事实数量
 * 2. 检测是否达到汇总阈值
 * 3. 支持多类别同时触发时的有序处理
 */

import { invoke } from '@tauri-apps/api/core';
import type { LongTermFactCategory } from './types';
import { CONSOLIDATION_THRESHOLDS, hasReachedThreshold } from './ConsolidationConfig';
import { getLogger } from '@services/logger';

const logger = getLogger('CategoryConsolidationTracker');

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 类别统计信息
 */
export interface CategoryStats {
  category: LongTermFactCategory;
  count: number;
  threshold: number;
  readyForConsolidation: boolean;
}

/**
 * 事实项（从后端查询）
 */
interface FactItem {
  id: string;
  content: string;
  category: string;
  importance: number | null;
  createdAt: number;
}

// ============================================================================
// 追踪器类
// ============================================================================

/**
 * 类别汇总状态追踪器
 */
export class CategoryConsolidationTracker {
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * 获取所有类别的统计信息
   */
  async getAllCategoryStats(): Promise<CategoryStats[]> {
    const stats: CategoryStats[] = [];

    for (const category of Object.keys(CONSOLIDATION_THRESHOLDS) as LongTermFactCategory[]) {
      const count = await this.getCategoryFactCount(category);
      const threshold = CONSOLIDATION_THRESHOLDS[category];

      stats.push({
        category,
        count,
        threshold,
        readyForConsolidation: hasReachedThreshold(category, count),
      });
    }

    return stats;
  }

  /**
   * 检查哪些类别需要汇总
   *
   * @returns 需要汇总的类别列表（按阈值从小到大排序）
   */
  async checkPendingConsolidations(): Promise<LongTermFactCategory[]> {
    const pending: LongTermFactCategory[] = [];

    for (const category of Object.keys(CONSOLIDATION_THRESHOLDS) as LongTermFactCategory[]) {
      const count = await this.getCategoryFactCount(category);

      if (hasReachedThreshold(category, count)) {
        pending.push(category);
      }
    }

    // 按阈值从小到大排序（先处理更容易满足的类别）
    return pending.sort((a, b) => CONSOLIDATION_THRESHOLDS[a] - CONSOLIDATION_THRESHOLDS[b]);
  }

  /**
   * 获取某类别的所有事实
   */
  async getCategoryFacts(category: LongTermFactCategory): Promise<
    Array<{
      id: string;
      content: string;
      confidence: number;
    }>
  > {
    try {
      // 使用 memory_list_facts 命令（需要 agentId 和 category 参数）
      const result = await invoke<FactItem[]>('memory_list_facts', {
        agentId: this.agentId,
        category,
      });

      return result.map((r) => ({
        id: r.id,
        content: r.content,
        // 将 importance (1-5) 转换为 confidence (0-1)
        confidence: (r.importance ?? 3) / 5,
      }));
    } catch (error) {
      logger.error(`[ConsolidationTracker] 获取类别 ${category} 事实失败:`, error);
      return [];
    }
  }

  /**
   * 获取某类别的事实数量
   */
  private async getCategoryFactCount(category: LongTermFactCategory): Promise<number> {
    const facts = await this.getCategoryFacts(category);
    return facts.length;
  }
}

/**
 * 创建 CategoryConsolidationTracker 实例
 */
export function createCategoryConsolidationTracker(agentId: string): CategoryConsolidationTracker {
  return new CategoryConsolidationTracker(agentId);
}
