/**
 * WidgetRenderer - Widget 分发器组件
 *
 * 接收 widgetType（从 Markdown 代码块 language-widget-xxx 解析）和 JSON 数据，
 * 根据类型分发到对应的交互组件。使用 Registry 模式便于扩展新 Widget 类型。
 *
 * @module components/widgets/WidgetRenderer
 */

import { memo, useMemo } from 'react';
import { ChoicesWidget } from './ChoicesWidget';
import { ChartWidget } from './ChartWidget';
import { TreeWidget } from './TreeWidget';
import styles from './WidgetRenderer.module.css';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';

const logger = getLogger('WidgetRenderer');

// ============================================================================
// 类型定义
// ============================================================================

/** Widget 组件的通用 Props 接口 */
export interface WidgetComponentProps {
    /** 从 JSON 解析出的数据 */
    data: Record<string, unknown>;
    /** 当前对话上下文 ID（用于 dispatch 交互事件） */
    contextId: string;
    /**
     * 消息 ID（气泡唯一标识）。
     * 气泡级表单模式下由 MessageBubble → MarkdownRenderer → WidgetRenderer 传入，
     * Widget 组件使用它将选择写入 widgetStore.bubbleSelections 而非立即 dispatch。
     */
    messageId?: string;
    /** 是否将交互结果暂存到气泡级回复栏，由用户统一确认后发送 */
    deferWidgetSubmit?: boolean;
}

/** Widget 类型到组件的注册表 */
const WIDGET_REGISTRY: Record<string, React.ComponentType<WidgetComponentProps>> = {
    choices: ChoicesWidget,
    chart: ChartWidget,
    tree: TreeWidget,
};

interface WidgetRendererProps {
    /** Widget 类型（从 language-widget-xxx 解析出的 xxx 部分） */
    widgetType: string;
    /** JSON.parse 后的原始数据 */
    data: unknown;
    /** 当前 Agent/Hub 上下文 ID */
    contextId: string;
    /** 消息 ID（气泡唯一标识），用于气泡级表单暂存模式 */
    messageId?: string;
    /** 是否将支持的交互 widget 纳入气泡级统一提交 */
    deferWidgetSubmit?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

export const WidgetRenderer = memo(function WidgetRenderer({
    widgetType,
    data,
    contextId,
    messageId,
    deferWidgetSubmit,
}: WidgetRendererProps) {
    const { t } = useI18n();
    // 从注册表中查找对应的组件
    const WidgetComponent = useMemo(() => {
        return WIDGET_REGISTRY[widgetType] ?? null;
    }, [widgetType]);

    // 数据校验：确保是对象类型
    const validData = useMemo(() => {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return data as Record<string, unknown>;
        }
        logger.warn('[WidgetRenderer] 无效的 Widget 数据，期望对象类型:', typeof data);
        return null;
    }, [data]);

    // 未注册的 Widget 类型：优雅降级
    if (!WidgetComponent) {
        return (
            <div className={styles.unknownWidget}>
                <span className={styles.unknownIcon}>⚠️</span>
                <span className={styles.unknownText}>
                    {t('widgets.unknownType')} <code>{widgetType}</code>
                </span>
            </div>
        );
    }

    // 数据无效时的降级
    if (!validData) {
        return (
            <div className={styles.unknownWidget}>
                <span className={styles.unknownIcon}>⚠️</span>
                <span className={styles.unknownText}>{t('widgets.invalidData')}</span>
            </div>
        );
    }

    return (
        <div className={styles.widgetContainer}>
            <WidgetComponent
                data={validData}
                contextId={contextId}
                messageId={messageId}
                deferWidgetSubmit={deferWidgetSubmit}
            />
        </div>
    );
});
