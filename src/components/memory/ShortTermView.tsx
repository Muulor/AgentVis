/**
 * ShortTermView - 短期缓冲视图
 * 
 * 显示短期缓冲区的对话内容，包含：
 * - 水位线进度条
 * - 对话轮次列表（User + Agent 配对）
 * - 每条消息的跳转按钮
 */

import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './ShortTermView.module.css';
import type { ShortTermViewProps, ShortTermMessageItem } from './types';
import { WatermarkIndicator } from './WatermarkIndicator';
import { DEFAULT_SHORT_TERM_CONFIG } from '@services/memory/types';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';

const logger = getLogger('ShortTermView');

// 后端返回的消息格式
interface BackendMessage {
    id: string;
    agentId: string;
    layer: string;
    content: string;
    sourceMessageIds: string | null;
    createdAt: number;
}

export function ShortTermView({ agentId, onJumpToMessage }: ShortTermViewProps) {
    const { t } = useI18n();
    const [messages, setMessages] = useState<ShortTermMessageItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // isOrganizing 状态由 Tauri 事件 'memory:watermark_*' 触发更新
    const [isOrganizing, setIsOrganizing] = useState(false);

    const windowSize = DEFAULT_SHORT_TERM_CONFIG.windowSize;

    // 加载短期缓冲数据
    const loadData = useCallback(async () => {
        if (!agentId) return;

        setIsLoading(true);
        setError(null);

        try {
            // 调用后端获取短期缓冲消息
            const result = await invoke<BackendMessage[]>('memory_list_by_layer', {
                agentId,
                layer: 'short_term',
            });

            // 🔧 按创建时间正序排列（最早在前），确保 #1 是最早的对话
            const sortedResult = [...result].sort((a, b) => a.createdAt - b.createdAt);

            // 转换为 UI 数据格式，按 user 消息递增编号
            let userTurnCounter = 0;
            const items: ShortTermMessageItem[] = sortedResult.map((msg) => {
                // 解析内容中的角色（简单假设格式为 "User: xxx" 或 "Agent: xxx"）
                let role: 'user' | 'assistant' = 'user';
                let displayContent = msg.content;

                if (msg.content.startsWith('User:')) {
                    role = 'user';
                    displayContent = msg.content.replace(/^User:\s*/, '');
                } else if (msg.content.startsWith('Agent:') || msg.content.startsWith('Assistant:')) {
                    role = 'assistant';
                    displayContent = msg.content.replace(/^(Agent|Assistant):\s*/, '');
                }

                // user 消息递增编号，assistant 沿用当前 user 编号
                if (role === 'user') {
                    userTurnCounter++;
                }

                // 检测 cron 来源的 user 消息（这类消息在聊天视图中已隐藏，跳转必然失败）
                // 通过内容特征判断：cron 提示词包含固定的信封标记 ✉...✉
                const isCronUserMessage = role === 'user'
                    && /✉.*✉/.test(displayContent);

                return {
                    id: msg.id,
                    // 解析原始消息 ID（用于跳转到对话历史）
                    // cron user 消息在 UI 中已隐藏，清空 sourceMessageId 以禁用跳转
                    sourceMessageId: isCronUserMessage
                        ? undefined
                        : msg.sourceMessageIds ?? undefined,
                    role,
                    content: displayContent,
                    contentPreview: displayContent.length > 80
                        ? displayContent.slice(0, 80) + '...'
                        : displayContent,
                    turnNumber: userTurnCounter,
                    timestamp: msg.createdAt,
                };
            });

            setMessages(items);
        } catch (err) {
            logger.error('加载短期缓冲失败:', err);
            setError(String(err));
        } finally {
            setIsLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    // 监听水位线事件，更新整理状态
    useEffect(() => {
        let unlistenTriggered: (() => void) | undefined;
        let unlistenCompleted: (() => void) | undefined;
        let unlistenFailed: (() => void) | undefined;
        let unlistenChanged: (() => void) | undefined;

        const setupListeners = async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');

                // 监听水位线触发事件
                unlistenTriggered = await listen<{ agentId: string }>('memory:watermark_triggered', (event) => {
                    if (event.payload.agentId === agentId) {
                        setIsOrganizing(true);
                    }
                });

                // 监听水位线完成事件
                unlistenCompleted = await listen<{ agentId: string }>('memory:watermark_completed', (event) => {
                    if (event.payload.agentId === agentId) {
                        setIsOrganizing(false);
                        void loadData();  // 刷新数据
                    }
                });

                // 监听水位线失败事件
                unlistenFailed = await listen<{ agentId: string }>('memory:watermark_failed', (event) => {
                    if (event.payload.agentId === agentId) {
                        setIsOrganizing(false);
                    }
                });

                unlistenChanged = await listen<{ agentId: string }>('memory:short_term_changed', (event) => {
                    if (event.payload.agentId === agentId) {
                        void loadData();
                    }
                });
            } catch {
                // 事件监听设置失败不影响主流程
            }
        };

        void setupListeners();

        return () => {
            unlistenTriggered?.();
            unlistenCompleted?.();
            unlistenFailed?.();
            unlistenChanged?.();
        };
    }, [agentId, loadData]);

    // 计算当前 user 消息数（水位线基于 user 消息计数）
    const currentTurns = messages.filter(m => m.role === 'user').length;

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
            {/* 水位线指示器 */}
            <WatermarkIndicator
                current={currentTurns}
                total={windowSize}
                threshold={DEFAULT_SHORT_TERM_CONFIG.watermarkThreshold}
                isOrganizing={isOrganizing}
            />

            {/* 消息列表 */}
            <div className={styles.messageList}>
                {messages.length === 0 ? (
                    <div className={styles.empty}>{t('memory.emptyShortTerm')}</div>
                ) : (
                    messages.map((msg) => (
                        <div
                            key={msg.id}
                            className={styles.messageItem}
                            data-role={msg.role}
                        >
                            <span className={styles.turnNumber}>#{msg.turnNumber}</span>
                            <span className={styles.role}>
                                {msg.role === 'user' ? 'User' : 'Agent'}:
                            </span>
                            <span className={styles.content}>{msg.contentPreview}</span>
                            {onJumpToMessage && (
                                <button
                                    className={styles.jumpBtn}
                                    onClick={() => onJumpToMessage(msg.sourceMessageId ?? msg.id)}
                                    disabled={!msg.sourceMessageId}
                                    title={msg.sourceMessageId ? t('memory.jumpOriginalMessage') : t('memory.jumpUnavailable')}
                                >
                                    {t('memory.jump')}
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
