/**
 * WatermarkIndicator - 水位线指示器组件
 * 
 * 显示短期缓冲的使用情况，包含：
 * - 当前轮次/总容量
 * - 进度条填充
 * - 水位线阈值标记
 * - 整理中状态动画
 */

import styles from './WatermarkIndicator.module.css';
import type { WatermarkIndicatorProps } from './types';
import { useI18n } from '@/i18n';

export function WatermarkIndicator({
    current,
    total,
    threshold = 0.7,
    isOrganizing = false,
}: WatermarkIndicatorProps) {
    const { t } = useI18n();
    // 计算使用率百分比
    const usageRatio = total > 0 ? current / total : 0;
    const usagePercent = Math.round(usageRatio * 100);
    const thresholdPercent = Math.round(threshold * 100);

    // 判断是否超过水位线
    const isAboveThreshold = usageRatio >= threshold;

    return (
        <div className={styles.container}>
            {/* 头部信息 */}
            <div className={styles.header}>
                <span className={styles.label}>
                    {t('memory.shortTermBuffer', { current, total })}
                </span>
                <span className={styles.threshold}>
                    {t('memory.watermark', { percent: thresholdPercent })}
                </span>
            </div>

            {/* 进度条 */}
            <div className={styles.track}>
                {/* 填充部分 */}
                <div
                    className={styles.fill}
                    data-above-threshold={isAboveThreshold}
                    data-organizing={isOrganizing}
                    style={{ width: `${usagePercent}%` }}
                />

                {/* 水位线标记 */}
                <div
                    className={styles.thresholdMarker}
                    style={{ left: `${thresholdPercent}%` }}
                />
            </div>

            {/* 整理中提示 */}
            {isOrganizing && (
                <div className={styles.organizingHint}>
                    <span className={styles.spinner} />
                    <span>{t('memory.organizing')}</span>
                </div>
            )}
        </div>
    );
}
