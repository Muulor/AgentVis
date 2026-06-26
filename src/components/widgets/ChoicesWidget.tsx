/**
 * ChoicesWidget - 选项卡片交互组件（气泡级表单模式）
 *
 * 支持两种模式：
 *   - 单选模式（默认，mode 字段缺失或为 "single"）：点击一次选定一项
 *   - 多选模式（mode: "multi"）：点击 Toggle 选中/取消，可选多项
 *
 * 所有选择均**暂存**到 widgetStore.bubbleSelections，不立即触发新对话。
 * 提交动作统一由气泡底部的 BubbleReplyBar 完成。
 *
 * JSON Schema:
 * ```json
 * {
 *   "title": "标题",
 *   "description": "可选描述",
 *   "mode": "multi",             // 可选，"single"（默认）或 "multi"
 *   "options": [
 *     { "label": "选项文本", "icon": "🏗️", "description": "简短描述" }
 *   ]
 * }
 * ```
 */

import { memo, useCallback, useMemo } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import type { WidgetComponentProps } from './WidgetRenderer';
import { useWidgetStore } from '@stores/widgetStore';
import { WidgetIcon } from './WidgetIcon';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './ChoicesWidget.module.css';

// 模块级稳定空 Set 常量（防止 selector 每次返回新实例导致无限重渲染）
const EMPTY_LABEL_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

// ============================================================================
// 类型定义
// ============================================================================

interface ChoiceOption {
    label: string;
    icon?: string;
    description?: string;
}

interface ChoicesData {
    title: string;
    description?: string;
    /** 交互模式：single = 单选（默认），multi = 多选 */
    mode: 'single' | 'multi';
    options: ChoiceOption[];
}

// ============================================================================
// 数据校验
// ============================================================================

function parseChoicesData(raw: Record<string, unknown>): ChoicesData | null {
    const title = typeof raw.title === 'string' ? raw.title : '';
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    const mode = raw.mode === 'multi' ? 'multi' : 'single';

    if (!Array.isArray(raw.options) || raw.options.length === 0) return null;

    const options: ChoiceOption[] = [];
    for (const opt of raw.options) {
        if (typeof opt === 'object' && opt !== null) {
            const o = opt as Record<string, unknown>;
            const label = typeof o.label === 'string' ? o.label : '';
            if (label) {
                options.push({
                    label,
                    icon: typeof o.icon === 'string' ? o.icon : undefined,
                    description: typeof o.description === 'string' ? o.description : undefined,
                });
            }
        }
    }

    return options.length > 0 ? { title, description, mode, options } : null;
}

// ============================================================================
// 主组件
// ============================================================================

export const ChoicesWidget = memo(function ChoicesWidget({
    data,
    contextId,
    messageId,
}: WidgetComponentProps) {
    const { t } = useI18n();
    const parsed = parseChoicesData(data);

    // widgetKey：气泡内标识该 widget 的唯一键（使用 messageId 而非 contextId 隔离，
    // 防止同一 contextId 下两个同标题 widget-choices 产生键碰撞）
    const widgetKey = `choices:${messageId ?? contextId}:${parsed?.title ?? ''}`;

    // 气泡是否已提交（messageId 存在时才有意义）
    const isBubbleSubmitted = useWidgetStore((s) =>
        messageId ? s.isBubbleSubmitted(messageId) : false
    );

    const setBubbleWidgetSelection = useWidgetStore((s) => s.setBubbleWidgetSelection);

    // 读取该 widget 的当前暂存标签集（用 Set 加速 has() 查询）
    // 注意：selector 不能直接返回 new Set()，会导致无限重渲染
    const rawLabels = useWidgetStore((s) => {
        if (!messageId) return null;
        const inner = s.bubbleSelections.get(messageId);
        return inner?.get(widgetKey) ?? null;
    });
    // 将标签数组转成 Set（稳定引用由 rawLabels 的引用稳定性保证）
    const selectedLabelSet: ReadonlySet<string> = useMemo(
        () => rawLabels ? new Set(rawLabels) : EMPTY_LABEL_SET,
        [rawLabels]
    );

    // 单选：点击 Toggle（再次点击已选项可取消，方便用户纠错）
    const handleSingleClick = useCallback(
        (label: string) => {
            if (!messageId || isBubbleSubmitted) return;
            // 已选中则取消（清空），否则选中
            const nextLabels = selectedLabelSet.has(label) ? [] : [label];
            setBubbleWidgetSelection(messageId, widgetKey, nextLabels);
        },
        [messageId, isBubbleSubmitted, selectedLabelSet, setBubbleWidgetSelection, widgetKey]
    );

    // 多选：点击 Toggle 选中/取消
    const handleMultiClick = useCallback(
        (label: string) => {
            if (!messageId || isBubbleSubmitted) return;
            const nextSet = new Set(selectedLabelSet);
            if (nextSet.has(label)) {
                nextSet.delete(label);
            } else {
                nextSet.add(label);
            }
            setBubbleWidgetSelection(messageId, widgetKey, Array.from(nextSet));
        },
        [messageId, isBubbleSubmitted, selectedLabelSet, setBubbleWidgetSelection, widgetKey]
    );

    if (!parsed) {
        return <div className={styles.errorFallback}>{t('widgets.choicesInvalid')}</div>;
    }

    const isMulti = parsed.mode === 'multi';

    return (
        <div className={styles.container}>
            {/* 标题区 */}
            {parsed.title && (
                <div className={styles.header}>
                    <h4 className={styles.title}>{parsed.title}</h4>
                    {parsed.description && (
                        <p className={styles.description}>{parsed.description}</p>
                    )}
                </div>
            )}

            <div className={styles.optionsList}>
                {parsed.options.map((option, index) => {
                    const isSelected = selectedLabelSet.has(option.label);
                    // 单选模式：有一项被选中后，其他项淡出
                    const isFaded = !isMulti && selectedLabelSet.size > 0 && !isSelected;
                    const isDisabled = isBubbleSubmitted;

                    return (
                        <button
                            key={index}
                            className={cx(styles.optionCard, isMulti && styles.optionCardMulti, isSelected && (isMulti ? styles.multiSelected : styles.optionSelected), isFaded && styles.optionDisabled)}
                            onClick={() => isMulti ? handleMultiClick(option.label) : handleSingleClick(option.label)}
                            disabled={isDisabled}
                        >
                            {/* 多选模式：左侧 checkbox 指示器 */}
                            {isMulti && (
                                <span className={cx(styles.checkboxIndicator, isSelected && styles.checkboxChecked)}>
                                    {isSelected
                                        ? <CheckCircle2 size={18} />
                                        : <Circle size={18} />
                                    }
                                </span>
                            )}

                            {option.icon && (
                                <span className={styles.optionIcon}>
                                    <WidgetIcon icon={option.icon} size={20} />
                                </span>
                            )}
                            <div className={styles.optionTextWrap}>
                                <span className={styles.optionLabel}>{option.label}</span>
                                {option.description && (
                                    <span className={styles.optionDesc}>{option.description}</span>
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
});
