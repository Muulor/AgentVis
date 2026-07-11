/**
 * CronJobItem - 定时任务卡片组件
 *
 * 显示单个定时任务的信息，支持启用/禁用、编辑和删除操作。
 */

import { useState, useCallback } from 'react';
import type { CronJob } from '@services/cron/types';
import { describeCronExpression } from '@services/cron/cronExpression';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './CronJobItem.module.css';

interface CronJobItemProps {
  job: CronJob;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => Promise<void>;
}

export function CronJobItem({ job, onToggle, onEdit, onDelete }: CronJobItemProps) {
  const { language, t } = useI18n();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  // 切换启用状态
  const handleToggle = useCallback(async () => {
    setIsToggling(true);
    try {
      await onToggle(job.id, !job.enabled);
    } finally {
      setIsToggling(false);
    }
  }, [job.id, job.enabled, onToggle]);

  // 删除任务
  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await onDelete(job.id);
    } finally {
      setIsDeleting(false);
    }
  }, [job.id, onDelete]);

  // 格式化时间戳
  const formatTime = (timestamp: number | null): string => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleString(language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 状态指示器颜色
  const statusClass =
    job.lastRunStatus === 'success'
      ? styles.statusSuccess
      : job.lastRunStatus === 'failed'
        ? styles.statusFailed
        : job.lastRunStatus === 'running'
          ? styles.statusRunning
          : '';

  return (
    <div className={cx(styles.card, !job.enabled && styles.disabled)}>
      <div className={styles.header}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{job.name}</span>
          {job.lastRunStatus && (
            <span
              className={cx(styles.statusDot, statusClass)}
              title={t('agent.cron.lastStatus', { status: job.lastRunStatus })}
            />
          )}
        </div>
        <div className={styles.schedule}>
          {describeCronExpression(job.cronExpression, language)}
        </div>
      </div>

      <div className={styles.prompt} title={job.prompt}>
        {job.prompt.length > 80 ? `${job.prompt.substring(0, 80)}...` : job.prompt}
      </div>

      <div className={styles.meta}>
        <div className={styles.metaInfo}>
          {job.lastRunAt && (
            <span className={styles.metaItem}>
              {t('agent.cron.lastRun', { time: formatTime(job.lastRunAt) })}
            </span>
          )}
          {job.nextRunAt && job.enabled && (
            <span className={styles.metaItem}>
              {t('agent.cron.nextRun', { time: formatTime(job.nextRunAt) })}
            </span>
          )}
        </div>

        <div className={styles.actions}>
          {/* 开关 */}
          <button
            className={cx(styles.toggleBtn, job.enabled && styles.toggleOn)}
            onClick={handleToggle}
            disabled={isToggling}
            title={job.enabled ? t('agent.cron.disableTitle') : t('agent.cron.enableTitle')}
          >
            <div className={styles.toggleTrack}>
              <div className={styles.toggleThumb} />
            </div>
          </button>

          {/* 编辑 */}
          <button className={styles.actionBtn} onClick={() => onEdit(job)} title={t('common.edit')}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <path d="M10 2l2 2L5 11H3V9L10 2z" />
            </svg>
          </button>

          {/* 删除 */}
          <button
            className={cx(styles.actionBtn, styles.deleteBtn)}
            onClick={handleDelete}
            disabled={isDeleting}
            title={t('common.delete')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <path d="M3 4h8M5 4V3h4v1M4 4v7a1 1 0 001 1h4a1 1 0 001-1V4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
