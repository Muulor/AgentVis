/**
 * TreeWidget - 渐进式决策树交互组件
 *
 * 在聊天气泡中渲染多层级决策树。用户每次点击一个选项后：
 * - 已选项保留高亮，未选项淡出消失
 * - 下一层选项从下方滑入
 * - 面包屑导航显示已选路径
 * - 到达叶子节点时，通过 widgetStore 向 LLM 发送完整决策路径
 *
 * 核心设计：LLM 提前生成 2-3 层完整嵌套树，Widget 在内部自治管理展开状态，
 * 仅在到达叶子节点时才回调 LLM，实现无延迟的渐进式交互体验。
 *
 * JSON Schema:
 * ```json
 * {
 *   "title": "探索方向",
 *   "description": "可选描述",
 *   "tree": {
 *     "question": "你更偏向哪个方向?",
 *     "options": [
 *       {
 *         "label": "选项A", "icon": "Building2", "description": "简短描述",
 *         "children": {
 *           "question": "更细的问题?",
 *           "options": [
 *             { "label": "子选项1", "icon": "Home" }
 *           ]
 *         }
 *       }
 *     ]
 *   }
 * }
 * ```
 */

import { memo, useCallback, useMemo } from 'react';
import { Undo2, ChevronRight } from 'lucide-react';
import type { WidgetComponentProps } from './WidgetRenderer';
import { useWidgetStore } from '@stores/widgetStore';
import { WidgetIcon } from './WidgetIcon';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './TreeWidget.module.css';

// ============================================================================
// 类型定义
// ============================================================================

interface TreeOption {
    label: string;
    icon?: string;
    description?: string;
    /** 子层级（无此字段则为叶子节点） */
    children?: TreeLevel;
}

interface TreeLevel {
    question?: string;
    options: TreeOption[];
}

interface TreeData {
    title: string;
    description?: string;
    tree: TreeLevel;
}

/** 渲染用的展开层级信息 */
interface ResolvedLevel {
    level: TreeLevel;
    selectedIndex: number | null;
    depth: number;
}

// ============================================================================
// 数据校验
// ============================================================================

function parseTreeLevel(raw: Record<string, unknown>): TreeLevel | null {
    const question = typeof raw.question === 'string' ? raw.question : undefined;

    if (!Array.isArray(raw.options) || raw.options.length === 0) {
        return null;
    }

    const options: TreeOption[] = [];
    for (const opt of raw.options) {
        if (typeof opt !== 'object' || opt === null) continue;
        const o = opt as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label : '';
        if (!label) continue;

        let children: TreeLevel | undefined;
        if (typeof o.children === 'object' && o.children !== null) {
            children = parseTreeLevel(o.children as Record<string, unknown>) ?? undefined;
        }

        options.push({
            label,
            icon: typeof o.icon === 'string' ? o.icon : undefined,
            description: typeof o.description === 'string' ? o.description : undefined,
            children,
        });
    }

    return options.length > 0 ? { question, options } : null;
}

function parseTreeData(raw: Record<string, unknown>): TreeData | null {
    const title = typeof raw.title === 'string' ? raw.title : '';
    const description = typeof raw.description === 'string' ? raw.description : undefined;

    if (typeof raw.tree !== 'object' || raw.tree === null) return null;
    const tree = parseTreeLevel(raw.tree as Record<string, unknown>);
    if (!tree) return null;

    return { title, description, tree };
}

// ============================================================================
// 状态键生成工具
// ============================================================================

/**
 * TreeWidget 使用 widgetStore 的 selections Map 存储多层级选择
 *
 * 存储策略（利用 Map<string, number>）：
 * - `tree:{contextId}:{title}:L{depth}` → 该层选中的选项索引
 * - `tree:{contextId}:{title}:depth`   → 当前已选到的深度
 * - `tree:{contextId}:{title}:done`    → 是否已到达叶子节点（1=是）
 */
function makeLevelKey(baseKey: string, depth: number): string {
    return `${baseKey}:L${depth}`;
}

function makeDepthKey(baseKey: string): string {
    return `${baseKey}:depth`;
}

function makeDoneKey(baseKey: string): string {
    return `${baseKey}:done`;
}

// ============================================================================
// 组件实现
// ============================================================================

export const TreeWidget = memo(function TreeWidget({
    data,
    contextId,
    messageId,
    deferWidgetSubmit,
}: WidgetComponentProps) {
    const { t } = useI18n();
    const parsed = useMemo(() => parseTreeData(data), [data]);
    const dispatchAction = useWidgetStore((s) => s.dispatchWidgetAction);
    const setSelection = useWidgetStore((s) => s.setSelection);
    const clearSelectionOnly = useWidgetStore((s) => s.clearSelectionOnly);
    const setBubbleWidgetSelection = useWidgetStore((s) => s.setBubbleWidgetSelection);

    const baseKey = `tree:${contextId}:${parsed?.title ?? ''}`;
    const bubbleWidgetKey = `tree:${messageId ?? contextId}:${parsed?.title ?? ''}`;
    const shouldUseBubbleSubmit = Boolean(messageId && deferWidgetSubmit);
    const isBubbleSubmitted = useWidgetStore((s) =>
        messageId && shouldUseBubbleSubmit ? s.isBubbleSubmitted(messageId) : false
    );

    // 读取已选深度，驱动重渲染
    const currentDepth = useWidgetStore((s) => s.selections.get(makeDepthKey(baseKey)) ?? 0);
    const isTreeDone = useWidgetStore((s) => s.selections.get(makeDoneKey(baseKey)) === 1);
    const isDone = isTreeDone || isBubbleSubmitted;

    // 读取各层选中索引，构建已选路径
    const selectedPath = useMemo(() => {
        const path: number[] = [];
        const selections = useWidgetStore.getState().selections;
        for (let i = 0; i < currentDepth; i++) {
            const val = selections.get(makeLevelKey(baseKey, i));
            if (val !== undefined) path.push(val);
            else break;
        }
        return path;
    }, [baseKey, currentDepth]);

    // 根据已选路径遍历树，收集每层展开信息
    const resolvedLevels: ResolvedLevel[] = useMemo(() => {
        if (!parsed) return [];

        const result: ResolvedLevel[] = [];
        let currentLevel: TreeLevel | undefined = parsed.tree;
        let depth = 0;

        while (currentLevel) {
            const selectedIndex = depth < selectedPath.length ? (selectedPath[depth] ?? null) : null;
            result.push({ level: currentLevel, selectedIndex, depth });

            if (selectedIndex !== null && selectedIndex >= 0) {
                currentLevel = currentLevel.options[selectedIndex]?.children;
            } else {
                currentLevel = undefined;
            }
            depth++;
        }

        return result;
    }, [parsed, selectedPath]);

    // 面包屑标签
    const breadcrumbs = useMemo(() => {
        return resolvedLevels
            .flatMap(({ level, selectedIndex }) => {
                if (selectedIndex === null || selectedIndex < 0) return [];
                return [level.options[selectedIndex]?.label ?? ''];
            })
            .filter(Boolean);
    }, [resolvedLevels]);

    // 处理选项点击
    const handleOptionClick = useCallback(
        (depth: number, optionIndex: number, option: TreeOption) => {
            // 只允许点击当前最深层的选项
            if (depth !== selectedPath.length) return;
            if (isDone) return;

            // 记录该层选择
            setSelection(makeLevelKey(baseKey, depth), optionIndex);
            setSelection(makeDepthKey(baseKey), depth + 1);

            if (!option.children) {
                // 叶子节点 → 标记完成并回调 LLM
                setSelection(makeDoneKey(baseKey), 1);

                // 仅发送路径标签，模型通过上下文中的决策树内容即可理解用户选择
                const pathLabels = [...breadcrumbs, option.label].join(' → ');
                const actionText = pathLabels;
                const displayText = t('widgets.decisionPath', { path: pathLabels });

                if (shouldUseBubbleSubmit && messageId) {
                    setBubbleWidgetSelection(messageId, bubbleWidgetKey, [actionText]);
                } else {
                    dispatchAction(contextId, actionText, displayText);
                }
            }
            // 有子节点 → 仅更新 store（触发重渲染，新层级滑入）
        },
        [
            selectedPath.length,
            isDone,
            baseKey,
            breadcrumbs,
            shouldUseBubbleSubmit,
            messageId,
            setBubbleWidgetSelection,
            bubbleWidgetKey,
            contextId,
            dispatchAction,
            setSelection,
            t,
        ]
    );

    // 处理重选 — 清除所有层级的持久化键
    // 使用 clearSelectionOnly 而非 clearSelectionAndUndo，
    // 确保树内部重选不会误触 pendingUndo 导致 AgentChatView 删除上一轮消息对
    const handleReselect = useCallback(() => {
        clearSelectionOnly(baseKey);
        for (let i = 0; i < 10; i++) {
            clearSelectionOnly(makeLevelKey(baseKey, i));
        }
        clearSelectionOnly(makeDepthKey(baseKey));
        clearSelectionOnly(makeDoneKey(baseKey));
        if (shouldUseBubbleSubmit && messageId) {
            setBubbleWidgetSelection(messageId, bubbleWidgetKey, []);
        }
    }, [
        clearSelectionOnly,
        baseKey,
        shouldUseBubbleSubmit,
        messageId,
        setBubbleWidgetSelection,
        bubbleWidgetKey,
    ]);

    if (!parsed) {
        return (
            <div className={styles.errorFallback}>
                {t('widgets.treeInvalid')}
            </div>
        );
    }

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

            {/* 面包屑导航 */}
            {breadcrumbs.length > 0 && (
                <div className={styles.breadcrumb}>
                    {breadcrumbs.map((crumb, i) => (
                        <span key={i} className={styles.breadcrumbItem}>
                            {i > 0 && <span className={styles.breadcrumbSep}>›</span>}
                            <span className={
                                i === breadcrumbs.length - 1
                                    ? styles.breadcrumbItemActive
                                    : undefined
                            }>
                                {crumb}
                            </span>
                        </span>
                    ))}
                </div>
            )}

            {/* 各层级渲染 */}
            {resolvedLevels.map(({ level, selectedIndex, depth }) => {
                const isCurrentLevel = depth === selectedPath.length;
                const isAnimated = depth > 0 && isCurrentLevel;

                return (
                    <div
                        key={depth}
                        className={cx(styles.levelContainer, isAnimated && styles.levelEnter)}
                    >
                        {level.question && (
                            <p className={styles.levelQuestion}>{level.question}</p>
                        )}

                        <div className={styles.optionsList}>
                            {level.options.map((option, index) => {
                                const isSelected = selectedIndex === index;
                                const isFaded = selectedIndex !== null && !isSelected;
                                const isClickable = selectedIndex === null && !isDone;

                                return (
                                    <button
                                        key={index}
                                        className={cx(styles.optionCard, isSelected && styles.optionSelected, isFaded && styles.optionFaded)}
                                        onClick={() => isClickable && handleOptionClick(depth, index, option)}
                                        disabled={!isClickable}
                                    >
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
                                        {option.children && !isFaded && (
                                            <span className={styles.optionArrow}>
                                                <ChevronRight size={16} />
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            })}

            {/* 重选按钮 */}
            {selectedPath.length > 0 && !isBubbleSubmitted && (
                <button
                    className={styles.reselectBtn}
                    onClick={handleReselect}
                >
                    <Undo2 size={13} />
                    <span>{t('widgets.reselect')}</span>
                </button>
            )}
        </div>
    );
});
