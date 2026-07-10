/**
 * StreamingMessage - 流式消息渲染组件
 * 
 * 功能：
 * - 显示流式接收中的消息内容
 * - 打字机效果光标
 * - Planning 模式：FSM 可视化面板
 * - Chat 模式：传统流式内容显示
 * 
 * @version 1.2 - 移除遗留进度面板
 */

import { memo, useMemo, useCallback } from 'react';
import { FSMVisualizationPanel } from './fsm-visualization';
import { MarkdownRenderer } from '../file/MarkdownRenderer';
import { ChatReasoningTrace } from './ChatReasoningTrace';
import { usePreviewStore } from '@stores/previewStore';
import { wrapSvgInHtml } from '@services/preview/templateInference';
import { useI18n } from '@/i18n';
import { cx } from '@utils/classNames';
import type { ChatMode } from '@/types/chatMode';
import styles from './StreamingMessage.module.css';

// ==================== 类型定义 ====================

interface StreamingMessageProps {
    content: string;
    agentName?: string;
    mode?: ChatMode;
    contextId?: string;
    reasoningContent?: string;
}

// ==================== 工具函数 ====================

const AVATAR_COLORS = [
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

function getAvatarColor(name: string): string {
    const colors = AVATAR_COLORS;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index] ?? '#666';
}



// ==================== 组件实现 ====================

/**
 * StreamingMessage 流式消息组件
 */
export const StreamingMessage = memo(function StreamingMessage({
    content,
    agentName = 'Agent',
    mode = 'chat',
    contextId,
    reasoningContent = '',
}: StreamingMessageProps) {
    const { t } = useI18n();
    const avatarColor = useMemo(() => getAvatarColor(agentName), [agentName]);

    // 代码预览回调
    const { openPreview } = usePreviewStore();
    const handleCodePreview = useCallback(
        (code: string, language: string) => {
            // SVG 需要包一层 HTML 外壳才能在 iframe 中正确渲染
            const previewCode = language === 'svg'
                ? wrapSvgInHtml(code)
                : code;
            openPreview(previewCode, `${language.toUpperCase()} ${t('chat.preview')}`);
        },
        [openPreview, t]
    );

    // 内容为空时显示加载动画
    const isWaiting = !content;
    const hasReasoningContent = reasoningContent.trim().length > 0;

    return (
        <div className={cx(styles.streamingBubble, mode === 'planning' && styles.planningBubble)}>
            {/* 头像 */}
            <div
                className={styles.avatar}
                style={{ backgroundColor: avatarColor }}
            >
                {agentName.charAt(0).toUpperCase()}
            </div>

            <div className={styles.contentWrapper}>
                {/* 消息头部 */}
                <div className={styles.header}>
                    <span className={styles.senderName}>{agentName}</span>
                    <span className={styles.streamingIndicator}>
                        <span className={styles.dot} />
                        <span className={styles.dot} />
                        <span className={styles.dot} />
                    </span>
                </div>

                {mode === 'planning' && (
                    <FSMVisualizationPanel contextId={contextId} />
                )}

                {/* 流式内容区域 */}
                {mode === 'planning' ? (
                    // Planning 模式：无内容时显示 Working... 跳动效果
                    !content ? (
                        <div className={styles.workingIndicator}>
                            <span>Working</span>
                            <span className={styles.workingDots}>
                                <span className={styles.workingDot}>.</span>
                                <span className={styles.workingDot}>.</span>
                                <span className={styles.workingDot}>.</span>
                            </span>
                        </div>
                    ) : (
                        // 有内容时使用 Markdown 渲染
                        <div className={styles.content}>
                            <MarkdownRenderer content={content} contextId={contextId} onCodePreview={handleCodePreview} />
                            <span className={styles.cursor}>|</span>
                        </div>
                    )
                ) : (
                    // Chat 模式：传统消息框样式
                    <>
                        {hasReasoningContent && (
                            <ChatReasoningTrace
                                content={reasoningContent}
                                isStreaming
                                answerStarted={Boolean(content.trim())}
                            />
                        )}
                        {(content || !hasReasoningContent) && (
                            <div className={styles.content}>
                                {isWaiting ? (
                                    <span className={styles.typingIndicator}>
                                        <span className={styles.typingDot} />
                                        <span className={styles.typingDot} />
                                        <span className={styles.typingDot} />
                                    </span>
                                ) : content ? (
                                    <>
                                        <MarkdownRenderer content={content} contextId={contextId} onCodePreview={handleCodePreview} />
                                        <span className={styles.cursor}>|</span>
                                    </>
                                ) : null}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
});
