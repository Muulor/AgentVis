import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { HubCreateModal } from './HubCreateModal';
import { HubContextMenu } from './HubContextMenu';
import { OPEN_HUB_CREATE_EVENT } from '@components/onboarding/onboardingEvents';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';
import styles from './HubTabs.module.css';

const logger = getLogger('HubTabs');

type DropPlacement = 'before' | 'after';

function getHorizontalDropPlacement(event: React.DragEvent<HTMLElement>): DropPlacement {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
}

function getVerticalDropPlacement(event: React.DragEvent<HTMLElement>): DropPlacement {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
}

function moveItemNearTarget<T extends { id: string }>(
    items: T[],
    sourceId: string,
    targetId: string,
    placement: DropPlacement,
): T[] {
    if (sourceId === targetId) return items;

    const sourceItem = items.find((item) => item.id === sourceId);
    if (!sourceItem) return items;

    const withoutSource = items.filter((item) => item.id !== sourceId);
    const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
    if (targetIndex === -1) return items;

    const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex;
    return [
        ...withoutSource.slice(0, insertIndex),
        sourceItem,
        ...withoutSource.slice(insertIndex),
    ];
}

/**
 * Hub 标签页标签数量阈值
 * 超过此数量后，额外标签将显示在"更多"下拉菜单中
 */
const MAX_VISIBLE_TABS = 10;

/**
 * HubTabs 组件
 *
 * 顶部Hub标签页切换组件，支持：
 * - 动态渲染Hub列表
 * - 点击切换当前Hub
 * - 超过5个时显示"更多"下拉菜单
 * - 右键上下文菜单
 * - 新建Hub按钮
 */
export function HubTabs() {
    const { t } = useI18n();
    const hubs = useHubStore((state) => state.hubs);
    const currentHubId = useHubStore((state) => state.currentHubId);
    const setHubs = useHubStore((state) => state.setHubs);
    const setCurrentHubId = useHubStore((state) => state.setCurrentHubId);
    const reorderHubs = useHubStore((state) => state.reorderHubs);

    // 创建弹窗状态
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [draggedHubId, setDraggedHubId] = useState<string | null>(null);
    const [dragOverHubId, setDragOverHubId] = useState<string | null>(null);
    const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);

    useEffect(() => {
        const handleOpenCreate = () => setIsCreateModalOpen(true);

        window.addEventListener(OPEN_HUB_CREATE_EVENT, handleOpenCreate);
        return () => window.removeEventListener(OPEN_HUB_CREATE_EVENT, handleOpenCreate);
    }, []);

    // 右键菜单状态
    const [contextMenuHubId, setContextMenuHubId] = useState<string | null>(null);
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);

    // 订阅消息和已读状态，用于计算 hub 级别未读标记
    // 使用 agentHubMap 而非 agents 数组：切换 hub 后 agents 只含当前 hub 的数据，
    // agentHubMap 持久保留所有曾加载过的 agentId→hubId 映射，不受 hub 切换影响。
    const agentHubMap = useAgentStore((state) => state.agentHubMap);
    const messagesByAgent = useChatStore((state) => state.messagesByAgent);
    const lastReadByAgent = useChatStore((state) => state.lastReadByAgent);

    /**
     * 计算每个 hub 是否有未读 agent 消息
     * 规则：hub 下任意一个 agent 有未读，则该 hub 显示小圆点；
     *       只有所有 agent 都已读，小圆点才消失。
     * 当前激活 hub 无需提示（用户正在查看）。
     */
    const hubUnreadSet = useMemo<Set<string>>(() => {
        const unreadHubs = new Set<string>();
        // 遍历所有有消息记录的 agent（messagesByAgent 跨 hub 切换不会清空）
        for (const [agentId, messages] of messagesByAgent) {
            if (messages.length === 0) continue;
            const latestMsg = messages[messages.length - 1];
            if (!latestMsg) continue;
            const lastRead = lastReadByAgent.get(agentId) ?? 0;
            if (latestMsg.createdAt <= lastRead) continue;
            // 从持久 map 查出该 agent 归属的 hub
            const hubId = agentHubMap.get(agentId);
            if (!hubId || hubId === currentHubId) continue;
            unreadHubs.add(hubId);
        }
        return unreadHubs;
    }, [agentHubMap, currentHubId, messagesByAgent, lastReadByAgent]);

    // 可见标签和更多标签
    const visibleHubs = hubs.slice(0, MAX_VISIBLE_TABS);
    const moreHubs = hubs.slice(MAX_VISIBLE_TABS);


    // 切换 Agent ID 的 action（切换 Hub 时需要清空 Agent 选中态）
    const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);

    // 切换Hub
    const handleTabClick = useCallback(
        (hubId: string) => {
            // 切换到不同 Hub 时清除 Agent 选中态，否则 RightPanel 的 contextId
            // 仍指向旧 Agent，导致文件预览/Diff 面板残留（截图复现的 Bug）
            if (hubId !== currentHubId) {
                setCurrentAgentId(null);
            }
            setCurrentHubId(hubId);
        },
        [currentHubId, setCurrentHubId, setCurrentAgentId]
    );

    // 右键菜单
    const handleContextMenu = useCallback((event: React.MouseEvent, hubId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenuHubId(hubId);
        setContextMenuPosition({ x: event.clientX, y: event.clientY });
    }, []);

    const handleDropdownContextMenu = useCallback((event: React.MouseEvent, hubId: string) => {
        setIsMoreMenuOpen(false);
        handleContextMenu(event, hubId);
    }, [handleContextMenu]);

    // 关闭右键菜单
    const handleCloseContextMenu = useCallback(() => {
        setContextMenuHubId(null);
        setContextMenuPosition(null);
    }, []);

    const handleHubDragStart = useCallback((event: React.DragEvent<HTMLElement>, hubId: string) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', hubId);
        setDraggedHubId(hubId);
    }, []);

    const handleHubDragOver = useCallback((event: React.DragEvent<HTMLElement>, hubId: string) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragOverHubId(hubId);
    }, []);

    const handleHubDragLeave = useCallback((hubId: string) => {
        setDragOverHubId((current) => (current === hubId ? null : current));
    }, []);

    const handleHubDrop = useCallback(async (
        event: React.DragEvent<HTMLElement>,
        targetHubId: string,
        placement: DropPlacement,
    ) => {
        event.preventDefault();
        const sourceHubId = draggedHubId ?? event.dataTransfer.getData('text/plain');
        setDraggedHubId(null);
        setDragOverHubId(null);

        if (!sourceHubId || sourceHubId === targetHubId) return;

        const nextHubs = moveItemNearTarget(
            hubs,
            sourceHubId,
            targetHubId,
            placement,
        );
        if (nextHubs === hubs) return;

        const previousHubs = hubs;
        const orderedIds = nextHubs.map((hub) => hub.id);
        reorderHubs(orderedIds);
        setIsMoreMenuOpen(false);

        try {
            await invoke('hub_reorder', { request: { orderedIds } });
        } catch (error) {
            setHubs(previousHubs);
            logger.error('[HubTabs] Failed to persist hub order:', error);
        }
    }, [draggedHubId, hubs, reorderHubs, setHubs]);

    const handleHubDragEnd = useCallback(() => {
        setDraggedHubId(null);
        setDragOverHubId(null);
    }, []);

    return (
        <>
            <div className={styles.tabs}>
                {/* 可见标签 */}
                {visibleHubs.map((hub) => (
                    <button
                        key={hub.id}
                        className={styles.tab}
                        data-active={hub.id === currentHubId}
                        data-dragging={draggedHubId === hub.id}
                        data-drag-over={dragOverHubId === hub.id}
                        draggable
                        title={hub.name}
                        onClick={() => handleTabClick(hub.id)}
                        onContextMenu={(e) => handleContextMenu(e, hub.id)}
                        onDragStart={(e) => handleHubDragStart(e, hub.id)}
                        onDragOver={(e) => handleHubDragOver(e, hub.id)}
                        onDragLeave={() => handleHubDragLeave(hub.id)}
                        onDrop={(e) => { void handleHubDrop(e, hub.id, getHorizontalDropPlacement(e)); }}
                        onDragEnd={handleHubDragEnd}
                    >
                        <span className={styles.tabLabel}>{hub.name}</span>
                        {/* 未读 Agent 消息小圆点：当前 hub 非激活态且有任意 agent 未读时显示 */}
                        {hubUnreadSet.has(hub.id) && <span className={styles.unreadDot} aria-label={t('hub.tabs.unread')} />}
                    </button>
                ))}

                {/* 更多下拉菜单 */}
                {moreHubs.length > 0 && (
                    <DropdownMenu.Root open={isMoreMenuOpen} onOpenChange={setIsMoreMenuOpen} modal={false}>
                        <DropdownMenu.Trigger asChild>
                            <button className={styles.moreDropdown}>
                                {t('hub.tabs.more', { count: moreHubs.length })}
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginLeft: 4 }}>
                                    <path d="M3 4.5l3 3 3-3" />
                                </svg>
                            </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content className={styles.dropdownContent} sideOffset={4}>
                                {moreHubs.map((hub) => (
                                    <DropdownMenu.Item
                                        key={hub.id}
                                        className={styles.dropdownItem}
                                        data-dragging={draggedHubId === hub.id}
                                        data-drag-over={dragOverHubId === hub.id}
                                        draggable
                                        title={hub.name}
                                        onSelect={() => handleTabClick(hub.id)}
                                        onContextMenu={(e) => handleDropdownContextMenu(e, hub.id)}
                                        onDragStart={(e) => handleHubDragStart(e, hub.id)}
                                        onDragOver={(e) => handleHubDragOver(e, hub.id)}
                                        onDragLeave={() => handleHubDragLeave(hub.id)}
                                        onDrop={(e) => { void handleHubDrop(e, hub.id, getVerticalDropPlacement(e)); }}
                                        onDragEnd={handleHubDragEnd}
                                    >
                                        <span className={styles.dropdownLabel}>{hub.name}</span>
                                        {/* 折叠在更多菜单中的 hub 同样需要展示未读指示 */}
                                        {hubUnreadSet.has(hub.id) && <span className={styles.dropdownUnreadDot} aria-label={t('hub.tabs.unread')} />}
                                    </DropdownMenu.Item>
                                ))}
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                )}

                {/* 新建Hub按钮 */}
                <button className={styles.newTab} onClick={() => setIsCreateModalOpen(true)} aria-label={t('hub.tabs.newHub')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M8 3v10M3 8h10" />
                    </svg>
                </button>
            </div>

            {/* 创建Hub弹窗 */}
            <HubCreateModal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />

            {/* 右键菜单 */}
            {contextMenuHubId && contextMenuPosition && (
                <HubContextMenu
                    hubId={contextMenuHubId}
                    position={contextMenuPosition}
                    onClose={handleCloseContextMenu}
                />
            )}
        </>
    );
}
