/**
 * SummaryView - 摘要层视图
 * 
 * 显示递归摘要层内容，包含：
 * - 摘要卡片列表
 * - 覆盖范围显示
 * - 展开原文 / 删除功能
 */

import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './SummaryView.module.css';
import type { SummaryViewProps, SummaryItem } from './types';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { getMemorySafeMessageContent, stripMemoryVisualCodeBlocks } from '@services/memory/utils/SafeMessageContent';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

const logger = getLogger('SummaryView');

// 后端返回的摘要格式
interface BackendMemory {
    id: string;
    agentId: string;
    layer: string;
    content: string;
    sourceMessageIds: string | null;
    metadataJson: string | null;
    createdAt: number;
}

/**
 * 解析 metadataJson 提取三类状态字段
 * 
 * 与 MemoryContextProvider.parseMetadataJson 逻辑一致，
 * 但仅提取 UI 需要的字段（confirmedDecisions/openQuestions/invalidatedPoints）
 */
function parseMetadataJson(json: string | null): Pick<SummaryItem, 'confirmedDecisions' | 'openQuestions' | 'invalidatedPoints'> {
    if (!json) return {};

    try {
        const metadata = JSON.parse(json) as {
            confirmedDecisions?: string[];
            openQuestions?: Array<{ question?: string; scope?: string }>;
            invalidatedPoints?: string[];
        };

        return {
            confirmedDecisions: metadata.confirmedDecisions,
            // 过滤掉缺少 question 字段的无效条目
            openQuestions: metadata.openQuestions
                ?.filter((q): q is { question: string; scope?: string } => !!q.question),
            invalidatedPoints: metadata.invalidatedPoints,
        };
    } catch (err) {
        logger.warn('解析 metadataJson 失败:', err);
        return {};
    }
}

function parseSourceMessageIds(sourceMessageIds: string): string[] {
    try {
        const parsed = JSON.parse(sourceMessageIds) as unknown;
        if (Array.isArray(parsed)) {
            const items = parsed as unknown[];
            return items.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
        }
    } catch {
        // JSON 解析失败，降级为逗号分隔
    }

    return sourceMessageIds.split(',').map(s => s.trim()).filter(Boolean);
}

/** 判断摘要是否包含任意状态数据 */
function hasStatusData(summary: SummaryItem): boolean {
    return (
        (summary.confirmedDecisions != null && summary.confirmedDecisions.length > 0) ||
        (summary.openQuestions != null && summary.openQuestions.length > 0) ||
        (summary.invalidatedPoints != null && summary.invalidatedPoints.length > 0)
    );
}

export function SummaryView({ agentId }: SummaryViewProps) {
    const { language, t } = useI18n();
    const [summaries, setSummaries] = useState<SummaryItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    // 状态详情展开（独立于原文展开）
    const [statusExpandedIds, setStatusExpandedIds] = useState<Set<string>>(new Set());

    // 删除确认状态
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // 加载摘要数据
    const loadData = useCallback(async () => {
        if (!agentId) return;

        setIsLoading(true);
        setError(null);

        try {
            const result = await invoke<BackendMemory[]>('memory_list_by_layer', {
                agentId,
                layer: 'summary',
            });

            // 转换为 UI 数据格式
            const items: SummaryItem[] = result.map((mem, index) => {
                // 根据内容长度推断重要性
                const importance: 'high' | 'medium' | 'low' =
                    mem.content.length > 200 ? 'high' :
                        mem.content.length > 100 ? 'medium' : 'low';

                // 格式化创建时间
                const date = new Date(mem.createdAt);
                const timeStr = date.toLocaleString(language, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });

                // 解析 metadataJson 提取状态字段
                const statusFields = parseMetadataJson(mem.metadataJson);

                return {
                    id: mem.id,
                    content: stripMemoryVisualCodeBlocks(mem.content),
                    turnStart: index + 1,  // 保留字段但不用于显示
                    turnEnd: index + 1,
                    importance,
                    sourceMessageIds: mem.sourceMessageIds ?? undefined,
                    createdAt: mem.createdAt,
                    createdAtStr: timeStr,  // 格式化时间字符串
                    ...statusFields,
                };
            });

            setSummaries(items);
        } catch (err) {
            logger.error('加载摘要失败:', err);
            setError(String(err));
        } finally {
            setIsLoading(false);
        }
    }, [agentId, language]);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    // 切换展开状态（并加载原文）
    const toggleExpanded = useCallback(async (id: string, sourceMessageIds: string | null) => {
        // 如果已展开，则收起
        if (expandedIds.has(id)) {
            setExpandedIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            return;
        }

        // 展开，同时按需加载原文
        setExpandedIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });

        // 如果有 sourceMessageIds 且尚未加载原文，则加载
        const summary = summaries.find(s => s.id === id);
        if (sourceMessageIds && summary && !summary.originalMessages) {
            try {
                // 解析 sourceMessageIds（兼容 JSON 数组或逗号分隔格式）
                const ids = parseSourceMessageIds(sourceMessageIds);
                if (ids.length > 0) {
                    interface BackendMessageItem {
                        id: string;
                        agentId: string;
                        role: string;
                        content: string;
                        metadata: string | null;
                        createdAt: number;
                    }
                    const messages = await invoke<BackendMessageItem[]>('message_get_batch', { ids });

                    // 更新 summary 的 originalMessages
                    setSummaries((prev) => prev.map((s) => {
                        if (s.id === id) {
                            return {
                                ...s,
                                originalMessages: messages.map((msg, idx) => ({
                                    turnNumber: Math.floor(idx / 2) + 1,
                                    role: msg.role === 'user' ? 'user' as const : 'assistant' as const,
                                    content: getMemorySafeMessageContent(msg),
                                })),
                            };
                        }
                        return s;
                    }));
                }
            } catch (err) {
                logger.error('加载原文失败:', err);
            }
        }
    }, [expandedIds, summaries]);

    // 切换状态详情展开
    const toggleStatusExpanded = useCallback((id: string) => {
        setStatusExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    // 请求删除摘要（打开确认对话框）
    const handleDeleteRequest = useCallback((id: string) => {
        setDeleteTargetId(id);
    }, []);

    // 确认删除摘要（同时删除向量索引）
    const handleConfirmDelete = useCallback(async () => {
        if (!deleteTargetId) return;

        setIsDeleting(true);
        try {
            // 使用统一命令：同时删除记忆 + 向量索引
            await invoke('memory_delete_summary_with_vector', { id: deleteTargetId, agentId });
            setSummaries((prev) => prev.filter((s) => s.id !== deleteTargetId));
            setDeleteTargetId(null);
        } catch (err) {
            logger.error('删除摘要失败:', err);
        } finally {
            setIsDeleting(false);
        }
    }, [deleteTargetId, agentId]);

    // 取消删除
    const handleCancelDelete = useCallback(() => {
        setDeleteTargetId(null);
    }, []);

    // 获取重要性样式类
    const getImportanceClass = (importance: string) => {
        switch (importance) {
            case 'high': return styles.importanceHigh;
            case 'medium': return styles.importanceMedium;
            default: return styles.importanceLow;
        }
    };

    const getImportanceLabel = (importance: SummaryItem['importance']) => {
        switch (importance) {
            case 'high':
                return t('memory.importanceHigh');
            case 'medium':
                return t('memory.importanceMedium');
            case 'low':
                return t('memory.importanceLow');
        }
    };

    if (isLoading) {
        return (
            <div className={styles.container}>
                <div className={styles.loading}>{t('common.loading')}</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className={styles.container}>
                <div className={styles.error}>
                    <span>{t('memory.loadingFailed', { error })}</span>
                    <button onClick={loadData}>{t('common.retry')}</button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            {/* 头部 */}
            <div className={styles.header}>
                <span className={styles.title}>{t('memory.summariesTitle', { count: summaries.length })}</span>
                <button className={styles.refreshBtn} onClick={loadData} title={t('common.refresh')}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M1.5 7a5.5 5.5 0 109.5-3.75M11 1v2.25H8.75" />
                    </svg>
                </button>
            </div>

            {/* 摘要列表 */}
            <div className={styles.summaryList}>
                {summaries.length === 0 ? (
                    <div className={styles.empty}>{t('memory.emptySummaries')}</div>
                ) : (
                    summaries.map((summary, index) => (
                        <div key={summary.id} className={styles.summaryCard}>
                            {/* 卡片头部 */}
                            <div className={styles.cardHeader}>
                                <span className={styles.summaryNumber}>
                                    {t('memory.summaryNumber', { number: summaries.length - index })}
                                </span>
                                <span className={styles.turnRange}>
                                    {t('memory.createdAt', { time: (summary as SummaryItem & { createdAtStr?: string }).createdAtStr ?? t('memory.unknown') })}
                                </span>
                            </div>

                            {/* 摘要内容 */}
                            <div className={styles.summaryContent}>
                                {summary.content}
                            </div>

                            {/* 状态详情展开（已确认决策 / 待决问题 / 已失效观点） */}
                            {statusExpandedIds.has(summary.id) && (
                                <div className={styles.statusDetails}>
                                    {/* 已确认决策 */}
                                    {summary.confirmedDecisions && summary.confirmedDecisions.length > 0 && (
                                        <div className={styles.statusSection}>
                                            <div className={cx(styles.statusSectionTitle, styles.confirmed)}>
                                                {t('memory.confirmedDecisions', { count: summary.confirmedDecisions.length })}
                                            </div>
                                            {summary.confirmedDecisions.map((d, i) => (
                                                <div key={i} className={styles.statusItem}>{d}</div>
                                            ))}
                                        </div>
                                    )}
                                    {/* 待决问题 */}
                                    {summary.openQuestions && summary.openQuestions.length > 0 && (
                                        <div className={styles.statusSection}>
                                            <div className={cx(styles.statusSectionTitle, styles.pending)}>
                                                {t('memory.openQuestions', { count: summary.openQuestions.length })}
                                            </div>
                                            {summary.openQuestions.map((q, i) => (
                                                <div key={i} className={styles.statusItem}>
                                                    {q.question}
                                                    {q.scope && <span className={styles.statusScope}> ({q.scope})</span>}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {/* 已失效观点 */}
                                    {summary.invalidatedPoints && summary.invalidatedPoints.length > 0 && (
                                        <div className={styles.statusSection}>
                                            <div className={cx(styles.statusSectionTitle, styles.invalidated)}>
                                                {t('memory.invalidatedPoints', { count: summary.invalidatedPoints.length })}
                                            </div>
                                            {summary.invalidatedPoints.map((p, i) => (
                                                <div key={i} className={styles.statusItem}>{p}</div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* 展开的原文内容 */}
                            {expandedIds.has(summary.id) && summary.originalMessages && (
                                <div className={styles.originalMessages}>
                                    {summary.originalMessages.map((msg, idx) => (
                                        <div key={idx} className={styles.originalMessage}>
                                            <span className={styles.originalTurn}>#{msg.turnNumber}</span>
                                            <span className={styles.originalRole}>
                                                {msg.role === 'user' ? 'User' : 'Agent'}:
                                            </span>
                                            <span>{msg.content}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* 卡片底部 */}
                            <div className={styles.cardFooter}>
                                <span className={cx(styles.importance, getImportanceClass(summary.importance))}>
                                    {t('memory.importance', { level: getImportanceLabel(summary.importance) })}
                                </span>
                                <div className={styles.cardActions}>
                                    {hasStatusData(summary) && (
                                        <button
                                            className={cx(styles.actionBtn, statusExpandedIds.has(summary.id) && styles.activeStatus)}
                                            onClick={() => toggleStatusExpanded(summary.id)}
                                        >
                                            {statusExpandedIds.has(summary.id) ? t('memory.collapseDetails') : t('memory.statusDetails')}
                                        </button>
                                    )}
                                    <button
                                        className={styles.actionBtn}
                                        onClick={() => toggleExpanded(summary.id, summary.sourceMessageIds ?? null)}
                                    >
                                        {expandedIds.has(summary.id) ? t('memory.collapseOriginal') : t('memory.expandOriginal')}
                                    </button>
                                    <button
                                        className={cx(styles.actionBtn, styles.danger)}
                                        onClick={() => handleDeleteRequest(summary.id)}
                                    >
                                        {t('common.delete')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* 删除确认对话框 */}
            <ConfirmDialog
                open={deleteTargetId !== null}
                onClose={handleCancelDelete}
                onConfirm={handleConfirmDelete}
                title={t('agent.context.deleteTitle')}
                description={t('memory.deleteSummaryConfirm')}
                confirmText={t('common.delete')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
