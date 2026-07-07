import { useCallback, useMemo, useState } from 'react';
import { Timer } from 'lucide-react';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { useCronStore } from '@stores/cronStore';
import { useUIStore } from '@stores/uiStore';
import { AgentContextMenu } from './AgentContextMenu';
import { Tooltip } from '@components/ui/Tooltip';
import { useI18n } from '@/i18n';
import styles from './AgentNavItem.module.css';

interface AgentNavItemProps {
    /** Agent ID */
    agentId: string;
    /** Agent 名称 */
    name: string;
    draggable?: boolean;
    isDragging?: boolean;
    isDragOver?: boolean;
    onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeave?: () => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd?: () => void;
}

/**
 * 根据名称生成颜色
 * 使用简单哈希算法生成一致的颜色
 */
const AVATAR_COLORS = [
    '#3F7BD9',
    '#7CB342',
    '#E0A238',
    '#4ba1c9',
    '#E34F53',
    '#7E57C2',
    '#E27A3A',
    '#21804E',
    '#6da7e1',
    '#4a8131',
    '#7D8BF4',
    '#ff9090',
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

/**
 * 获取Agent头像字母
 */
function getAvatarLetter(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '?';
    return trimmed.charAt(0).toUpperCase();
}

/**
 * AgentNavItem 组件
 *
 * 左栏Agent列表项，支持：
 * - 显示Agent头像（字母）和名称
 * - 点击切换到Agent对话视图
 * - 右键菜单（重命名/删除）
 * - 选中态视觉反馈
 * - 未读消息蓝点（右上角）
 * - Cron 定时任务图标（右下角）
 * - 支持折叠状态
 */
export function AgentNavItem({
    agentId,
    name,
    draggable,
    isDragging = false,
    isDragOver = false,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
}: AgentNavItemProps) {
    const { t } = useI18n();
    const currentAgentId = useAgentStore((state) => state.currentAgentId);
    const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);
    const isCollapsed = useUIStore((state) => state.isLeftPanelCollapsed);

    // 获取自定义头像
    const avatar = useAgentStore((state) => state.agents.find(a => a.id === agentId)?.avatar);

    // 未读消息判断：比较最新消息时间和最后查看时间
    const messagesByAgent = useChatStore((state) => state.messagesByAgent);
    const lastReadByAgent = useChatStore((state) => state.lastReadByAgent);
    const hasUnread = useMemo(() => {
        // 当前选中的 Agent 不显示未读（正在查看）
        if (currentAgentId === agentId) return false;
        const messages = messagesByAgent.get(agentId);
        if (!messages || messages.length === 0) return false;
        const latestMsg = messages[messages.length - 1];
        if (!latestMsg) return false;
        const lastRead = lastReadByAgent.get(agentId) ?? 0;
        return latestMsg.createdAt > lastRead;
    }, [agentId, currentAgentId, messagesByAgent, lastReadByAgent]);

    // Cron 定时任务指示器：检查该 Agent 是否有启用的定时任务
    const hasCronJobs = useCronStore((state) => state.enabledAgentIds.has(agentId));

    // 右键菜单状态
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    // 是否选中
    const isActive = currentAgentId === agentId;

    // 头像颜色
    const avatarColor = useMemo(() => getAvatarColor(name), [name]);

    // 头像字母
    const avatarLetter = useMemo(() => getAvatarLetter(name), [name]);

    // 点击切换Agent
    const handleClick = useCallback(() => {
        setCurrentAgentId(agentId);
    }, [agentId, setCurrentAgentId]);

    // 右键打开菜单
    const handleContextMenu = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
    }, []);

    // 关闭菜单
    const handleCloseContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    return (
        <>
            <Tooltip content={name}>
                <div
                    className={styles.navItem}
                    data-active={isActive}
                    data-collapsed={isCollapsed}
                    data-dragging={isDragging}
                    data-drag-over={isDragOver}
                    draggable={draggable}
                    onClick={handleClick}
                    onContextMenu={handleContextMenu}
                    onDragStart={onDragStart}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && handleClick()}
                >
                    {/* 头像容器（相对定位，供角标绝对定位） */}
                    <div className={styles.avatarWrapper}>
                        <div
                            className={styles.avatar}
                            style={avatar
                                ? { borderColor: avatarColor }  /* 有头像时用颜色作为边框 */
                                : { backgroundColor: avatarColor }  /* 无头像时用颜色作为背景 */
                            }
                            data-has-image={!!avatar}
                        >
                            {avatar ? (
                                <img
                                    src={`data:image/webp;base64,${avatar}`}
                                    alt={name}
                                    className={styles.avatarImg}
                                />
                            ) : (
                                avatarLetter
                            )}
                        </div>
                        {/* 未读消息蓝点（右上角） */}
                        {hasUnread && <span className={styles.unreadDot} />}
                        {/* Cron 定时任务图标（右下角） */}
                        {hasCronJobs && (
                            <span className={styles.cronBadge} aria-label={t('agent.hasEnabledCron')}>
                                <Timer size={8} />
                            </span>
                        )}
                    </div>
                    {!isCollapsed && (
                        <span className={styles.name}>{name}</span>
                    )}
                </div>
            </Tooltip>

            {/* 右键菜单 */}
            {contextMenu && (
                <AgentContextMenu
                    agentId={agentId}
                    agentName={name}
                    position={contextMenu}
                    onClose={handleCloseContextMenu}
                />
            )}
        </>
    );
}
