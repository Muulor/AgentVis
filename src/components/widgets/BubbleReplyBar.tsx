/**
 * BubbleReplyBar - 气泡底部统一回复确认栏
 *
 * 当消息气泡中包含 widget-choices 时，在气泡底部渲染此组件。
 * 收集该气泡内所有 widget 的已选项，提供可选文字补充框，
 * 点击「确认回复」后将所有选择拼成一条消息一次性发给 LLM。
 *
 * 状态流转：
 *   未提交：显示已选摘要 + 文字输入 + 确认按钮
 *   已提交：显示「已回复」标记 + 「重新选择」按钮（触发回滚）
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Send, RotateCcw, MessageSquareDashed } from 'lucide-react';
import { useWidgetStore, type WidgetSelectionSnapshot } from '@stores/widgetStore';
import { normalizeWidgetTitle } from '@stores/widgetSubmissionRecovery';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n, type Language } from '@/i18n';
import styles from './BubbleReplyBar.module.css';

const logger = getLogger('BubbleReplyBar');

// ============================================================================
// 类型定义
// ============================================================================

interface BubbleReplyBarProps {
    /** 消息 ID（气泡唯一标识） */
    messageId: string;
    /** 当前 Agent/Hub 上下文 ID，用于 dispatchWidgetAction 和撤回 */
    contextId: string;
    /**
     * 产生该气泡的 Agent ID（Hub 场景下必须）
     * 用于 HubChatView 消费 Widget 事件时路由回正确的 Agent
     */
    agentId?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将气泡所有 widget 的选择整合为发送给 LLM 的文字
 *
 * 格式示例：
 *   核心功能：标准版、专业版
 *   目标用户：独立音乐人
 *   设计风格：专业DAW风格
 */
function formatSelectionsAsText(
    selections: Map<string, string[]>,
    fallbackTitle: string,
    language: Language
): string {
    const parts: string[] = [];
    const titleSeparator = language === 'zh-CN' ? '：' : ': ';
    const labelSeparator = language === 'zh-CN' ? '、' : ', ';

    for (const [widgetKey, labels] of selections.entries()) {
        if (labels.length === 0) continue;
        // widgetKey 格式: "choices:{contextId}:{title}"
        // 提取 title 部分（最后一段，去除可能的"（可多选）"等后缀）
        const segments = widgetKey.split(':');
        const rawTitle = normalizeWidgetTitle(segments.slice(2).join(':'));
        const title = rawTitle || fallbackTitle;
        parts.push(`${title}${titleSeparator}${labels.join(labelSeparator)}`);
    }
    return parts.join('\n');
}

// ============================================================================
// 组件实现
// ============================================================================

export const BubbleReplyBar = memo(function BubbleReplyBar({
    messageId,
    contextId,
    agentId,
}: BubbleReplyBarProps) {
    const { language, t } = useI18n();
    const [extraText, setExtraText] = useState('');
    // 本地派发防抖标志：在 dispatchWidgetAction 派发后设为 true，防止 sendMessage 进行中重复点击
    // 当消费侧 markBubbleSubmitted 完成后，isSubmitted 从 widgetStore 读取到 true，接管显示"已回复"状态
    const [isDispatching, setIsDispatching] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const isSubmitted = useWidgetStore((s) => s.isBubbleSubmitted(messageId));
    const dispatchWidgetAction = useWidgetStore((s) => s.dispatchWidgetAction);
    // 注意：不在此处直接引用 markBubbleSubmitted
    // 标记由消费侧（AgentChatView/HubChatView）在 sendMessage 完成后调用，避免与 SQLite 的竞争条件
    const reopenBubbleSelectionsAndUndo = useWidgetStore((s) => s.reopenBubbleSelectionsAndUndo);
    const setSubmittedExtraText = useWidgetStore((s) => s.setSubmittedExtraText);
    // 已提交态展示：从 store 读取提交时保存的补充文字（会话内有效）
    const submittedExtraText = useWidgetStore((s) => s.submittedExtraTexts.get(messageId) ?? '');

    // 读取当前气泡的所有暂存选择
    // 注意：bubbleSelections 是 Map，selector 返回相同 Map 引用时不重渲染
    const selectionsSummary = useWidgetStore((s) => {
        const inner = s.bubbleSelections.get(messageId);
        return inner ?? null;
    });

    // 计算已选总项数（用于 UI 提示）
    const totalSelectedCount = selectionsSummary
        ? Array.from(selectionsSummary.values()).reduce((acc, labels) => acc + labels.length, 0)
        : 0;

    const hasSelections = totalSelectedCount > 0;

    // Textarea 自适应高度
    useEffect(() => {
        const el = textareaRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
        }
    }, [extraText]);

    const handleConfirm = useCallback(() => {
        // canSend: 有选项 OR 有补充文字均允许发送，与按鈕 disabled 条件保持一致
        const canSend = hasSelections || extraText.trim().length > 0;
        // isDispatching 防止 sendMessage 进行中重复点击（在 isSubmitted 接管前的窗口期保护）
        if (!canSend || isDispatching) return;

        // 拼接选择文字和补充说明
        let actionText: string;
        let displayText: string;
        let widgetExtraText: string | undefined;
        let widgetSelections: WidgetSelectionSnapshot[] = [];

        if (hasSelections) {
            // 确保 selections 引用是最新的（使用 getState 而非 closure）
            const latestInner = useWidgetStore.getState().bubbleSelections.get(messageId);
            if (!latestInner) return;

            widgetSelections = Array.from(latestInner.entries()).map(([widgetKey, labels]) => ({
                widgetKey,
                labels: [...labels],
            }));
            const selectionText = formatSelectionsAsText(latestInner, t('widgets.select'), language);
            const trimmedExtra = extraText.trim();
            widgetExtraText = trimmedExtra || undefined;
            actionText = trimmedExtra
                ? `${selectionText}\n\n${t('widgets.extraNote', { text: trimmedExtra })}`
                : selectionText;
            displayText = t('widgets.bubbleReply', {
                text: `${selectionText.slice(0, 60)}${selectionText.length > 60 ? '...' : ''}`,
            });

            // 持久化补充文字到 store，供已提交态内联展示（会话内有效）
            if (trimmedExtra) {
                setSubmittedExtraText(messageId, trimmedExtra);
            }
        } else {
            // 仅有补充文字，无选项：直接发送补充文字即可
            actionText = extraText.trim();
            widgetExtraText = actionText;
            displayText = t('widgets.extraNote', { text: actionText.slice(0, 60) });
            setSubmittedExtraText(messageId, actionText);
        }

        // 立即进入防抗态，防止 UI 在 sendMessage 期间被重复点击
        setIsDispatching(true);
        setExtraText('');

        // 派发事件 → HubChatView/AgentChatView 监听后触发新对话
        // 传入 widgetBubbleId：消费侧 sendMessage 完成后再调用 markBubbleSubmitted，
        // 确保已提交标记仅在 SQLite 持久化成功后才写入 localStorage
        dispatchWidgetAction(contextId, actionText, displayText, agentId, messageId, widgetSelections, widgetExtraText);
        logger.trace('[BubbleReplyBar] 确认回复:', displayText);
    }, [hasSelections, isDispatching, messageId, extraText, dispatchWidgetAction, contextId, agentId, setSubmittedExtraText, language, t]);

    const handleReselect = useCallback(() => {
        // 1) 清除气泡暂存 + 已提交标记 + 已提交补充文字
        // 2) 触发 pendingUndo → AgentChatView 回滚 LLM 回复
        // 3) 重置 isDispatching：撤回后第一次發送的防抗标志必须清除，
        //    否则 isDispatching=true 会导致重新选择后再次点击发送时 handleConfirm 直接 return
        setIsDispatching(false);
        reopenBubbleSelectionsAndUndo(messageId, contextId);
        logger.trace('[BubbleReplyBar] 重新选择:', messageId);
    }, [reopenBubbleSelectionsAndUndo, messageId, contextId]);

    const titleSeparator = language === 'zh-CN' ? '：' : ': ';
    const labelSeparator = language === 'zh-CN' ? '、' : ', ';

    // ── 已提交状态：内联展示选项摘要 + 补充文字，隐藏输入框和发送按钮 ──
    if (isSubmitted) {
        return (
            <div className={styles.bar}>
                {/* 已选择摘要：列出每个 widget 的选项标签 */}
                {selectionsSummary && Array.from(selectionsSummary.entries()).map(([widgetKey, labels]) => {
                    if (labels.length === 0) return null;
                    const segments = widgetKey.split(':');
                    const rawTitle = normalizeWidgetTitle(segments.slice(2).join(':'));
                    return (
                        <div key={widgetKey} className={styles.summaryRow}>
                            <span className={styles.summaryTitle}>{rawTitle || t('widgets.select')}{titleSeparator}</span>
                            <span className={styles.summaryLabels}>{labels.join(labelSeparator)}</span>
                        </div>
                    );
                })}
                {/* 用户填写的补充文字（会话内有效，刷新后不显示） */}
                {submittedExtraText && (
                    <p className={styles.submittedExtra}>{submittedExtraText}</p>
                )}
                <div className={styles.submittedRow}>
                    <span className={styles.submittedLabel}>
                        <MessageSquareDashed size={14} />
                        {t('widgets.replied')}
                    </span>
                    <button
                        className={styles.reselectBtn}
                        onClick={handleReselect}
                        title={t('widgets.reselectTitle')}
                    >
                        <RotateCcw size={13} />
                        {t('widgets.reselect')}
                    </button>
                </div>
            </div>
        );
    }

    // ── 未提交状态 ──
    return (
        <div className={styles.bar}>
            {/* 已选摘要 */}
            {hasSelections && selectionsSummary && (
                <div className={styles.summary}>
                    {Array.from(selectionsSummary.entries()).map(([widgetKey, labels]) => {
                        if (labels.length === 0) return null;
                        const segments = widgetKey.split(':');
                        const rawTitle = normalizeWidgetTitle(segments.slice(2).join(':'));
                        return (
                            <div key={widgetKey} className={styles.summaryRow}>
                                <span className={styles.summaryTitle}>{rawTitle || t('widgets.select')}{titleSeparator}</span>
                                <span className={styles.summaryLabels}>{labels.join(labelSeparator)}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 文字补充输入 */}
            <div className={styles.inputRow}>
                <textarea
                    ref={textareaRef}
                    className={styles.textarea}
                    placeholder={t('widgets.replyPlaceholder')}
                    value={extraText}
                    onChange={(e) => setExtraText(e.target.value)}
                    rows={1}
                    onKeyDown={(e) => {
                        // Ctrl+Enter / Cmd+Enter 快速发送
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            handleConfirm();
                        }
                    }}
                />
                <button
                    className={cx(styles.confirmBtn, ((!hasSelections && !extraText.trim()) || isDispatching) && styles.confirmBtnDisabled)}
                    onClick={handleConfirm}
                    disabled={(!hasSelections && !extraText.trim()) || isDispatching}
                    title={t('widgets.confirmReplyTitle')}
                >
                    <Send size={15} />
                </button>
            </div>

            {/* 提示文字 */}
            {!hasSelections && (
                <p className={styles.hint}>{t('widgets.confirmHint')}</p>
            )}
        </div>
    );
});
