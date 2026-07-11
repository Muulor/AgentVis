/**
 * ChartWidget - 图表/图示交互组件
 *
 * 在聊天气泡中渲染结构化的信息图或流程图。
 * 使用纯 CSS + HTML 实现（不引入 D3/ECharts 等重量级依赖）。
 *
 * 支持的图表类型：
 * - flow: 流程图/层级图（节点 + 连接箭头）
 * - bar: 柱状图（水平条形）
 * - info: 信息卡片列表（键值对展示）
 *
 * JSON Schema:
 * ```json
 * {
 *   "title": "标题",
 *   "type": "flow" | "bar" | "info",
 *   "items": [
 *     { "label": "节点文本", "value": 85, "icon": "🏗️", "description": "描述" }
 *   ],
 *   "actions": [
 *     { "label": "按钮文本", "icon": "➕" }
 *   ]
 * }
 * ```
 */

import { memo, useCallback, useMemo } from 'react';
import { Undo2 } from 'lucide-react';
import type { WidgetComponentProps } from './WidgetRenderer';
import { useWidgetStore } from '@stores/widgetStore';
import { WidgetIcon } from './WidgetIcon';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ChartWidget.module.css';

// ============================================================================
// 类型定义
// ============================================================================

/** 图表类型 */
type ChartType = 'flow' | 'bar' | 'info';

/** 图表条目 */
interface ChartItem {
  label: string;
  /** 值（支持 number 和 string，LLM 可能输出字符串类型如 "Strong Buy"） */
  value?: number | string;
  icon?: string;
  description?: string;
  /** 可选颜色（十六进制或 CSS 颜色） */
  color?: string;
}

/** 底部交互按钮 */
interface ChartAction {
  label: string;
  icon?: string;
}

/** ChartWidget 的完整数据结构 */
interface ChartData {
  title: string;
  description?: string;
  type: ChartType;
  items: ChartItem[];
  /** 底部交互按钮（点击后触发 Widget 事件） */
  actions?: ChartAction[];
  /** 底部注脚文字 */
  footnote?: string;
}

// ============================================================================
// 数据校验
// ============================================================================

/** 支持的图表类型集合 */
const VALID_CHART_TYPES = new Set<string>(['flow', 'bar', 'info']);

/**
 * 校验并转换原始数据为 ChartData
 */
function parseChartData(raw: Record<string, unknown>): ChartData | null {
  const title = typeof raw.title === 'string' ? raw.title : '';
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const rawType = typeof raw.type === 'string' ? raw.type : 'info';
  const type: ChartType = VALID_CHART_TYPES.has(rawType) ? (rawType as ChartType) : 'info';

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return null;
  }

  const items: ChartItem[] = [];
  for (const item of raw.items) {
    if (typeof item === 'object' && item !== null) {
      const it = item as Record<string, unknown>;
      const label = typeof it.label === 'string' ? it.label : '';
      if (label) {
        items.push({
          label,
          value:
            typeof it.value === 'number' || typeof it.value === 'string' ? it.value : undefined,
          icon: typeof it.icon === 'string' ? it.icon : undefined,
          description: typeof it.description === 'string' ? it.description : undefined,
          color: typeof it.color === 'string' ? it.color : undefined,
        });
      }
    }
  }

  if (items.length === 0) return null;

  // 解析底部交互按钮
  let actions: ChartAction[] | undefined;
  if (Array.isArray(raw.actions)) {
    actions = [];
    for (const act of raw.actions) {
      if (typeof act === 'object' && act !== null) {
        const a = act as Record<string, unknown>;
        const label = typeof a.label === 'string' ? a.label : '';
        if (label) {
          actions.push({
            label,
            icon: typeof a.icon === 'string' ? a.icon : undefined,
          });
        }
      }
    }
    if (actions.length === 0) actions = undefined;
  }

  const footnote = typeof raw.footnote === 'string' ? raw.footnote : undefined;

  return { title, description, type, items, actions, footnote };
}

// ============================================================================
// 预设颜色盘（流程图节点和柱状图使用）
// ============================================================================

const PRESET_COLORS = [
  '#3F7BD9',
  '#7CB342',
  '#E0A238',
  '#4ba1c9',
  '#E34F53',
  '#7E57C2',
  '#E27A3A',
  '#21804E',
  '#ff9090',
  '#6da7e1',
  '#4a8131',
  '#7D8BF4',
];

function getItemColor(index: number, customColor?: string): string {
  if (customColor) return customColor;
  return PRESET_COLORS[index % PRESET_COLORS.length] ?? '#3F7BD9';
}

// ============================================================================
// 子渲染器
// ============================================================================

/** 流程图渲染 */
function renderFlowChart(items: ChartItem[]): React.ReactElement {
  return (
    <div className={styles.flowContainer}>
      {items.map((item, index) => (
        <div key={index} className={styles.flowStep}>
          {/* 连接线（第一个节点不显示上连线） */}
          {index > 0 && (
            <div className={styles.flowConnector}>
              <div className={styles.flowArrow}>↓</div>
            </div>
          )}

          {/* 节点卡片 */}
          <div
            className={styles.flowNode}
            style={{
              borderLeftColor: getItemColor(index, item.color),
            }}
          >
            {item.icon && (
              <span className={styles.flowNodeIcon}>
                <WidgetIcon icon={item.icon} size={18} />
              </span>
            )}
            <div className={styles.flowNodeText}>
              <span className={styles.flowNodeLabel}>{item.label}</span>
              {item.description && <span className={styles.flowNodeDesc}>{item.description}</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 柱状图渲染 */
function renderBarChart(items: ChartItem[]): React.ReactElement {
  // 计算最大值用于归一化（仅对 number 类型的 value 有效）
  const maxValue = items.reduce((max, item) => {
    return Math.max(max, typeof item.value === 'number' ? item.value : 0);
  }, 0);

  return (
    <div className={styles.barContainer}>
      {items.map((item, index) => {
        const numericValue = typeof item.value === 'number' ? item.value : 0;
        const percentage = maxValue > 0 ? (numericValue / maxValue) * 100 : 0;

        return (
          <div key={index} className={styles.barRow}>
            <div className={styles.barLabelWrap}>
              {item.icon && (
                <span className={styles.barIcon}>
                  <WidgetIcon icon={item.icon} size={14} />
                </span>
              )}
              <span className={styles.barLabel}>{item.label}</span>
            </div>
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{
                  width: `${percentage}%`,
                  backgroundColor: getItemColor(index, item.color),
                }}
              />
            </div>
            <span className={styles.barValue}>{item.value ?? numericValue}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 信息卡片列表渲染 */
function renderInfoList(items: ChartItem[]): React.ReactElement {
  return (
    <div className={styles.infoContainer}>
      {items.map((item, index) => (
        <div key={index} className={styles.infoCard}>
          <div className={styles.infoHeader}>
            {item.icon && (
              <span className={styles.infoIcon}>
                <WidgetIcon icon={item.icon} size={16} />
              </span>
            )}
            <span className={styles.infoLabel}>{item.label}</span>
            {item.value !== undefined && <span className={styles.infoValue}>{item.value}</span>}
          </div>
          {item.description && <p className={styles.infoDesc}>{item.description}</p>}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// 组件实现
// ============================================================================

export const ChartWidget = memo(function ChartWidget({ data, contextId }: WidgetComponentProps) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseChartData(data), [data]);
  const dispatchAction = useWidgetStore((s) => s.dispatchWidgetAction);
  const setSelection = useWidgetStore((s) => s.setSelection);
  const clearSelectionAndUndo = useWidgetStore((s) => s.clearSelectionAndUndo);

  // 使用 widgetStore 持久化按钮点击状态
  const widgetKey = `chart:${contextId}:${parsed?.title ?? ''}`;
  const clickedActionIndex = useWidgetStore((s) => s.selections.get(widgetKey) ?? null);

  const handleActionClick = useCallback(
    (action: ChartAction, index: number) => {
      if (clickedActionIndex !== null) return;
      setSelection(widgetKey, index);

      // 仅发送按钮标签，模型通过上下文中的图表内容即可理解用户操作
      const actionText = action.label;
      const displayText = t('widgets.clickedAction', { label: action.label });

      dispatchAction(contextId, actionText, displayText);
    },
    [contextId, clickedActionIndex, dispatchAction, setSelection, widgetKey, t]
  );

  const handleReselect = useCallback(() => {
    clearSelectionAndUndo(widgetKey, contextId);
  }, [clearSelectionAndUndo, widgetKey, contextId]);

  if (!parsed) {
    return <div className={styles.errorFallback}>{t('widgets.chartInvalid')}</div>;
  }

  // 根据类型选择渲染器
  const renderChart = (): React.ReactElement => {
    switch (parsed.type) {
      case 'flow':
        return renderFlowChart(parsed.items);
      case 'bar':
        return renderBarChart(parsed.items);
      case 'info':
      default:
        return renderInfoList(parsed.items);
    }
  };

  return (
    <div className={styles.container}>
      {/* 标题区 */}
      {parsed.title && (
        <div className={styles.header}>
          <h4 className={styles.title}>{parsed.title}</h4>
          {parsed.description && <p className={styles.description}>{parsed.description}</p>}
        </div>
      )}

      {/* 图表内容 */}
      <div className={styles.chartBody}>{renderChart()}</div>

      {/* 底部注脚 */}
      {parsed.footnote && <p className={styles.footnote}>{parsed.footnote}</p>}

      {/* 底部交互按钮 */}
      {parsed.actions && parsed.actions.length > 0 && (
        <div className={styles.actionsBar}>
          {parsed.actions.map((action, index) => {
            const isClicked = clickedActionIndex === index;
            const isDisabled = clickedActionIndex !== null && !isClicked;

            return (
              <button
                key={index}
                className={cx(
                  styles.actionBtn,
                  isClicked && styles.actionClicked,
                  isDisabled && styles.actionDisabled
                )}
                onClick={() => handleActionClick(action, index)}
                disabled={clickedActionIndex !== null}
              >
                {action.icon && (
                  <span className={styles.actionIcon}>
                    <WidgetIcon icon={action.icon} size={14} />
                  </span>
                )}
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 重选按钮 — 仅在已点击按钮后显示 */}
      {clickedActionIndex !== null && (
        <button className={styles.reselectBtn} onClick={handleReselect}>
          <Undo2 size={13} />
          <span>{t('widgets.reselect')}</span>
        </button>
      )}
    </div>
  );
});
