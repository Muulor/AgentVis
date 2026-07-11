/**
 * FactCard - 事实卡片组件
 *
 * 显示单个事实，包含：
 * - 类别标签（6 种颜色）
 * - 来源信息
 * - 操作按钮：跳转、编辑、删除
 */

import styles from './FactCard.module.css';
import type { CategoryDisplayConfig, FactCardProps } from './types';
import { CATEGORY_DISPLAY_MAP } from './types';
import type { LongTermFactCategory } from '@services/memory/types';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

function getCategoryLabel(category: LongTermFactCategory, t: ReturnType<typeof useI18n>['t']) {
  switch (category) {
    case 'identity_role':
      return t('memory.category.identityRole');
    case 'preference_style':
      return t('memory.category.preferenceStyle');
    case 'long_term_goal':
      return t('memory.category.longTermGoal');
    case 'knowledge_level':
      return t('memory.category.knowledgeLevel');
    case 'interaction_signals':
      return t('memory.category.interactionSignals');
    case 'task_experience':
      return t('memory.category.taskExperience');
    default:
      return category;
  }
}

export function FactCard({
  id,
  content,
  category,
  sourceDescription,
  onEdit,
  onDelete,
  onJump,
  sourceMessageId,
}: FactCardProps) {
  const { t } = useI18n();
  // 获取类别显示配置
  // 防御性 fallback：若数据库存在历史遗留的未知 category 值（如重构前的 stable_context），
  // 避免直接访问 undefined 导致组件崩溃、面板黑屏
  const categoryDisplayMap: Partial<Record<string, CategoryDisplayConfig>> = CATEGORY_DISPLAY_MAP;
  const categoryConfig = categoryDisplayMap[category] ?? {
    color: '#9CA3AF',
    bgColor: 'rgba(156, 163, 175, 0.15)',
  };

  return (
    <div className={styles.card}>
      {/* 头部：类别标签 + 来源 */}
      <div className={styles.header}>
        <span
          className={styles.categoryTag}
          style={{
            color: categoryConfig.color,
            backgroundColor: categoryConfig.bgColor,
          }}
        >
          {getCategoryLabel(category, t)}
        </span>
        {sourceDescription && (
          <span className={styles.source}>{t('memory.source', { source: sourceDescription })}</span>
        )}
      </div>

      {/* 内容 */}
      <div className={styles.content}>{content}</div>

      {/* 操作按钮 */}
      <div className={styles.actions}>
        {sourceMessageId && onJump && (
          <Tooltip content={t('memory.jumpOriginal')}>
            <button className={styles.actionBtn} onClick={() => onJump(sourceMessageId)}>
              {t('memory.jump')}
            </button>
          </Tooltip>
        )}
        {onEdit && (
          <Tooltip content={t('memory.editFact')}>
            <button className={styles.actionBtn} onClick={() => onEdit(id)}>
              {t('common.edit')}
            </button>
          </Tooltip>
        )}
        {onDelete && (
          <Tooltip content={t('memory.deleteFact')}>
            <button className={cx(styles.actionBtn, styles.danger)} onClick={() => onDelete(id)}>
              {t('common.delete')}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
