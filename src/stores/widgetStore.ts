/**
 * WidgetStore - 生成式 UI 交互通信状态管理
 *
 * 用于 Widget 组件（渲染在 MarkdownRenderer 深层树中）向聊天系统发送交互事件。
 *
 * 设计原因：Widget 组件无法直接访问 useChatSender 的 sendMessage（Hook 闭包绑定了
 * 当前 Agent 上下文），通过 Store 解耦：Widget dispatch 事件 → AgentChatView 消费并调用 sendMessage。
 *
 * 用户在 Widget 中的交互（如点击选项卡片）不会在聊天列表中显示为用户消息，
 * LLM 仍然能接收到交互事件并生成后续响应。
 *
 * 气泡级表单模式（v2）：
 * 消息气泡中的所有 widget-choices 选择均暂存在 bubbleSelections 中，
 * 不立即发送。气泡底部的 BubbleReplyBar 统一收集并提交。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getLogger } from '@services/logger';

const logger = getLogger('widgetStore');

// ============================================================================
// 类型定义
// ============================================================================

/** Widget 提交时的结构化选择快照（用于持久化恢复） */
export interface WidgetSelectionSnapshot {
    widgetKey: string;
    labels: string[];
}

/** Widget 交互事件 */
export interface WidgetAction {
    /** 当前 Agent/Hub 的 contextId */
    contextId: string;
    /** 发送给 LLM 的完整交互描述（作为用户消息内容） */
    actionText: string;
    /** 在 UI 上显示的简短描述（用于日志等，不在聊天中显示） */
    displayText: string;
    /** 事件触发时间戳 */
    timestamp: number;
    /**
     * 产生该 Widget 的 Agent ID（Hub 场景下使用）
     * Hub 模式：BubbleReplyBar 通过消息的 agentId 传入，HubChatView 消费时据此路由回正确的 Agent
     * Agent 场景：undefined（AgentChatView 不需要此字段）
     */
    agentId?: string;
    /**
     * 产生该交互的气泡消息 ID（BubbleReplyBar 提交时注入）
     * 消费侧（AgentChatView/HubChatView）在 sendMessage 成功后调用 markBubbleSubmitted，
     * 确保已提交标记仅在消息持久化到 SQLite 之后才写入 localStorage，
     * 消除两层存储之间的竞争条件导致的不一致
     */
    widgetBubbleId?: string;
    /** 提交时的结构化选择快照，用于写入消息 metadata 并在重启后恢复 UI */
    widgetSelections?: WidgetSelectionSnapshot[];
    /** 提交时用户填写的补充文字，用于写入消息 metadata 并在重启后恢复 UI */
    widgetExtraText?: string;
}

/**
 * 气泡暂存状态：记录某条消息气泡中各 widget 的已选标签列表
 * - key（外层 Map）: messageId（消息ID）
 * - key（内层 Map）: widgetKey（`choices:{messageId}:{title}` / `tree:{messageId}:{title}` 格式）
 * - value: 已选选项的 label 字符串数组（单选时只有 1 项，多选时有多项）
 */
export type BubbleSelectionMap = Map<string, Map<string, string[]>>;

interface WidgetState {
    /** 待消费的交互事件（一次只能有一个，避免并发冲突） */
    pendingAction: WidgetAction | null;
    /** Widget 选中状态持久化（key: widgetKey，value: 已选索引）
     *  复用于：单选已提交标记（-1 = 已提交）、TreeWidget 各层级选中索引
     */
    selections: Map<string, number>;
    /** 待消费的撤回请求（BubbleReplyBar 重选时触发，AgentChatView 消费后删除最近的 widget 消息对） */
    pendingUndo: { contextId: string } | null;
    /**
     * 气泡级暂存：各消息气泡中 widget 的已选标签（未提交阶段）
     * - 持久化，用于重启后展示已选摘要；SQLite 隐藏 widget 消息会作为兜底恢复源
     */
    bubbleSelections: BubbleSelectionMap;
    /**
     * 气泡提交时用户填写的补充文字（key: messageId）
     * - 持久化，用于 BubbleReplyBar 在已提交态内联展示补充说明
     * - 撤回时随 bubbleSelections 一起清除
     */
    submittedExtraTexts: Map<string, string>;
}

interface WidgetActions {
    /** Widget 组件调用：派发一个交互事件 */
    dispatchWidgetAction: (
        contextId: string,
        actionText: string,
        displayText: string,
        agentId?: string,
        widgetBubbleId?: string,
        widgetSelections?: WidgetSelectionSnapshot[],
        widgetExtraText?: string
    ) => void;
    /** AgentChatView 调用：消费并清除待处理事件 */
    consumeAction: () => WidgetAction | null;
    /** 记录 Widget 选中状态（组件重渲染时可恢复） */
    setSelection: (widgetKey: string, selectedIndex: number) => void;
    /** 查询 Widget 选中状态（返回已选索引或 null） */
    getSelection: (widgetKey: string) => number | null;
    /** 清除 Widget 选中状态并派发撤回请求（重选功能） */
    clearSelectionAndUndo: (widgetKey: string, contextId: string) => void;
    /** AgentChatView 调用：消费并清除待处理的撤回请求 */
    consumeUndo: () => { contextId: string } | null;
    /**
     * 仅清除 Widget 选中状态，**不触发撤回请求**。
     * 用于 TreeWidget 内部重选（重置导航状态），与消息级回滚完全隔离。
     * 区别于 clearSelectionAndUndo：不会写入 pendingUndo，不会触发 AgentChatView 删除消息。
     */
    clearSelectionOnly: (widgetKey: string) => void;

    // ── 气泡级表单 actions ──

    /**
     * 暂存某 widget 的选择（写入 bubbleSelections，不触发发送）
     * @param messageId 消息ID（气泡唯一标识）
     * @param widgetKey  widget 唯一键（`choices:{messageId}:{title}` / `tree:{messageId}:{title}`）
     * @param labels     已选标签列表（单选传 1 项，多选传多项）
     */
    setBubbleWidgetSelection: (messageId: string, widgetKey: string, labels: string[]) => void;

    /**
     * 清除某消息气泡的所有 widget 暂存（重新选择时使用）
     * 同时触发撤回请求，由 AgentChatView 回滚 LLM 回复
     */
    clearBubbleSelectionsAndUndo: (messageId: string, contextId: string) => void;
    reopenBubbleSelectionsAndUndo: (messageId: string, contextId: string) => void;

    /** 读取某气泡的所有暂存选择 */
    getBubbleSelections: (messageId: string) => Map<string, string[]>;

    /**
     * 标记某气泡已提交（写入 selections 哨兵值 -2）
     * 使用 -2 区分 TreeWidget/旧单选的 -1
     */
    markBubbleSubmitted: (messageId: string) => void;

    /** 查询某气泡是否已提交 */
    isBubbleSubmitted: (messageId: string) => boolean;

    /**
     * 从已持久化的 widget 用户消息恢复气泡提交态、选择摘要和补充说明。
     * selections/extraText 传 undefined 表示保留 localStorage 中已有值。
     */
    restoreBubbleSubmittedState: (
        messageId: string,
        selections?: WidgetSelectionSnapshot[],
        extraText?: string
    ) => void;

    /**
     * 记录气泡提交时的补充文字（用于已提交态内联展示）
     * BubbleReplyBar 在 handleConfirm 时调用
     */
    setSubmittedExtraText: (messageId: string, text: string) => void;

    /** 读取某气泡已提交的补充文字（会话内有效，刷新后返回空字符串） */
    getSubmittedExtraText: (messageId: string) => string;
}

// ============================================================================
// Store 实现
// ============================================================================

export const useWidgetStore = create<WidgetState & WidgetActions>()(
    persist(
        (set, get) => ({
            pendingAction: null,
            selections: new Map(),
            pendingUndo: null,
            bubbleSelections: new Map(),
            submittedExtraTexts: new Map(),

            dispatchWidgetAction: (contextId, actionText, displayText, agentId, widgetBubbleId, widgetSelections, widgetExtraText) => {
                const action: WidgetAction = {
                    contextId,
                    actionText,
                    displayText,
                    timestamp: Date.now(),
                    // Hub 场景下携带来源 Agent ID，供 HubChatView 精准路由
                    agentId,
                    // 气泡消息 ID，消费侧发送成功后据此调用 markBubbleSubmitted
                    widgetBubbleId,
                    widgetSelections,
                    widgetExtraText,
                };
                set({ pendingAction: action });
                logger.debug('[widgetStore] 派发 Widget 交互事件:', displayText, agentId ? `(agentId: ${agentId})` : '');
            },

            consumeAction: () => {
                const action = get().pendingAction;
                if (action) {
                    set({ pendingAction: null });
                    logger.debug('[widgetStore] 消费 Widget 交互事件:', action.displayText);
                }
                return action;
            },

            setSelection: (widgetKey, selectedIndex) => {
                set((state) => {
                    const next = new Map(state.selections);
                    next.set(widgetKey, selectedIndex);
                    return { selections: next };
                });
            },

            getSelection: (widgetKey) => {
                return get().selections.get(widgetKey) ?? null;
            },

            clearSelectionAndUndo: (widgetKey, contextId) => {
                set((state) => {
                    const next = new Map(state.selections);
                    next.delete(widgetKey);
                    return { selections: next, pendingUndo: { contextId } };
                });
                logger.debug('[widgetStore] 清除选中并派发撤回:', widgetKey);
            },

            consumeUndo: () => {
                const undo = get().pendingUndo;
                if (undo) {
                    set({ pendingUndo: null });
                }
                return undo;
            },

            clearSelectionOnly: (widgetKey) => {
                set((state) => {
                    const next = new Map(state.selections);
                    next.delete(widgetKey);
                    return { selections: next };
                });
                // 刻意不写 pendingUndo，避免触发 AgentChatView 的消息回滚
                logger.debug('[widgetStore] 仅清除选中（不触发撤回）:', widgetKey);
            },

            setBubbleWidgetSelection: (messageId, widgetKey, labels) => {
                set((state) => {
                    const nextBubble = new Map(state.bubbleSelections);
                    const existing = nextBubble.get(messageId);
                    // 复制内层 Map 避免 mutate
                    const nextInner = existing ? new Map(existing) : new Map<string, string[]>();
                    nextInner.set(widgetKey, labels);
                    nextBubble.set(messageId, nextInner);
                    return { bubbleSelections: nextBubble };
                });
                logger.debug('[widgetStore] 气泡暂存更新:', messageId, widgetKey, labels);
            },

            clearBubbleSelectionsAndUndo: (messageId, contextId) => {
                set((state) => {
                    // 清除气泡暂存
                    const nextBubble = new Map(state.bubbleSelections);
                    nextBubble.delete(messageId);
                    // 清除气泡已提交标记（selections 中的哨兵值 -2）
                    const nextSelections = new Map(state.selections);
                    nextSelections.delete(`bubble:${messageId}`);
                    // 同步清除已提交的补充文字
                    const nextExtraTexts = new Map(state.submittedExtraTexts);
                    nextExtraTexts.delete(messageId);
                    return {
                        bubbleSelections: nextBubble,
                        selections: nextSelections,
                        submittedExtraTexts: nextExtraTexts,
                        pendingUndo: { contextId },
                    };
                });
                logger.debug('[widgetStore] 气泡重选，派发撤回:', messageId);
            },

            reopenBubbleSelectionsAndUndo: (messageId, contextId) => {
                set((state) => {
                    const nextSelections = new Map(state.selections);
                    nextSelections.delete(`bubble:${messageId}`);

                    const nextExtraTexts = new Map(state.submittedExtraTexts);
                    nextExtraTexts.delete(messageId);

                    return {
                        selections: nextSelections,
                        submittedExtraTexts: nextExtraTexts,
                        pendingUndo: { contextId },
                    };
                });
                logger.debug('[widgetStore] 气泡恢复为可编辑草稿:', messageId);
            },

            getBubbleSelections: (messageId) => {
                return get().bubbleSelections.get(messageId) ?? new Map<string, string[]>();
            },

            markBubbleSubmitted: (messageId) => {
                set((state) => {
                    const next = new Map(state.selections);
                    // -2 作为气泡已提交哨兵值（与 TreeWidget 的 -1 区分）
                    next.set(`bubble:${messageId}`, -2);
                    return { selections: next };
                });
                logger.debug('[widgetStore] 气泡已提交标记:', messageId);
            },

            isBubbleSubmitted: (messageId) => {
                return get().selections.get(`bubble:${messageId}`) === -2;
            },

            restoreBubbleSubmittedState: (messageId, restoredSelections, extraText) => {
                set((state) => {
                    const nextSelections = new Map(state.selections);
                    nextSelections.set(`bubble:${messageId}`, -2);

                    let nextBubble = state.bubbleSelections;
                    if (restoredSelections !== undefined) {
                        nextBubble = new Map(state.bubbleSelections);
                        const nextInner = new Map<string, string[]>();
                        for (const snapshot of restoredSelections) {
                            if (snapshot.widgetKey && snapshot.labels.length > 0) {
                                nextInner.set(snapshot.widgetKey, [...snapshot.labels]);
                            }
                        }
                        nextBubble.set(messageId, nextInner);
                    }

                    let nextExtraTexts = state.submittedExtraTexts;
                    if (extraText !== undefined) {
                        nextExtraTexts = new Map(state.submittedExtraTexts);
                        const trimmed = extraText.trim();
                        if (trimmed) {
                            nextExtraTexts.set(messageId, trimmed);
                        } else {
                            nextExtraTexts.delete(messageId);
                        }
                    }

                    return {
                        selections: nextSelections,
                        bubbleSelections: nextBubble,
                        submittedExtraTexts: nextExtraTexts,
                    };
                });
                logger.debug('[widgetStore] 恢复气泡提交态:', messageId);
            },

            setSubmittedExtraText: (messageId, text) => {
                // 仅在有实际补充文字时才写入，避免无意义的空字符串占用内存
                if (!text) return;
                set((state) => {
                    const next = new Map(state.submittedExtraTexts);
                    next.set(messageId, text);
                    return { submittedExtraTexts: next };
                });
            },

            getSubmittedExtraText: (messageId) => {
                return get().submittedExtraTexts.get(messageId) ?? '';
            },
        }),
        {
            name: 'agentvis-widget-selections',
            // 持久化 selections（含气泡已提交标记）、bubbleSelections（选项内容）和
            // submittedExtraTexts（用户补充文字），三者配合保证重启后 BubbleReplyBar
            // 已提交态能完整展示选项摘要和补充说明，而无需依赖 SQLite 回扫。
            // bubbleSelections 是嵌套 Map，现有 replacer/reviver 会递归处理每一层 Map，无需额外逻辑。
            partialize: (state) => ({
                selections: state.selections,
                bubbleSelections: state.bubbleSelections,
                submittedExtraTexts: state.submittedExtraTexts,
            }),
            // 自定义 storage：Map 无法被 JSON.stringify 直接序列化
            storage: createJSONStorage(() => localStorage, {
                replacer: (_key: string, value: unknown) => {
                    if (value instanceof Map) {
                        return { __type: 'Map', entries: Array.from(value.entries()) };
                    }
                    return value;
                },
                reviver: (_key: string, value: unknown) => {
                    if (typeof value === 'object' && value !== null) {
                        const v = value as Record<string, unknown>;
                        if (v.__type === 'Map' && Array.isArray(v.entries)) {
                            return new Map(v.entries as [string, unknown][]);
                        }
                    }
                    return value;
                },
            }),
        },
    )
);
