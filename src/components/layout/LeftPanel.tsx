import { useState, useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '@stores/uiStore';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { AgentNavItem, AgentCreateModal } from '@components/agent';
import { OPEN_AGENT_CREATE_EVENT } from '@components/onboarding/onboardingEvents';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';
import styles from './LeftPanel.module.css';

const logger = getLogger('LeftPanel');

type DropPlacement = 'before' | 'after';

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
 * LeftPanel 左栏导航
 *
 * 显示当前 Hub 下的 Agent 列表
 */
export function LeftPanel() {
    const { t } = useI18n();
    const isCollapsed = useUIStore((state) => state.isLeftPanelCollapsed);
    const currentHubId = useHubStore((state) => state.currentHubId);
    const agents = useAgentStore((state) => state.agents);
    const setAgents = useAgentStore((state) => state.setAgents);
    const reorderAgents = useAgentStore((state) => state.reorderAgents);

    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
    const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);

    // 过滤当前Hub的Agent
    const hubAgents = useMemo(
        () => agents.filter((a) => a.hubId === currentHubId),
        [agents, currentHubId],
    );

    // 打开创建Agent弹窗
    const handleAddAgent = useCallback(() => {
        setIsCreateModalOpen(true);
    }, []);

    useEffect(() => {
        window.addEventListener(OPEN_AGENT_CREATE_EVENT, handleAddAgent);
        return () => window.removeEventListener(OPEN_AGENT_CREATE_EVENT, handleAddAgent);
    }, [handleAddAgent]);

    const handleAgentDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, agentId: string) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', agentId);
        setDraggedAgentId(agentId);
    }, []);

    const handleAgentDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, agentId: string) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragOverAgentId(agentId);
    }, []);

    const handleAgentDragLeave = useCallback((agentId: string) => {
        setDragOverAgentId((current) => (current === agentId ? null : current));
    }, []);

    const handleAgentDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>, targetAgentId: string) => {
        event.preventDefault();
        const sourceAgentId = draggedAgentId ?? event.dataTransfer.getData('text/plain');
        setDraggedAgentId(null);
        setDragOverAgentId(null);

        if (!currentHubId || !sourceAgentId || sourceAgentId === targetAgentId) return;

        const nextHubAgents = moveItemNearTarget(
            hubAgents,
            sourceAgentId,
            targetAgentId,
            getVerticalDropPlacement(event),
        );
        if (nextHubAgents === hubAgents) return;

        const previousAgents = agents;
        const orderedIds = nextHubAgents.map((agent) => agent.id);
        reorderAgents(currentHubId, orderedIds);

        try {
            await invoke('agent_reorder', {
                request: {
                    hubId: currentHubId,
                    orderedIds,
                },
            });
        } catch (error) {
            setAgents(previousAgents);
            logger.error('[LeftPanel] Failed to persist agent order:', error);
        }
    }, [agents, currentHubId, draggedAgentId, hubAgents, reorderAgents, setAgents]);

    const handleAgentDragEnd = useCallback(() => {
        setDraggedAgentId(null);
        setDragOverAgentId(null);
    }, []);

    return (
        <>
            <nav className={styles.leftPanel} data-collapsed={isCollapsed}>
                {/* 新建 Agent 按钮 */}
                <button className={styles.addAgent} onClick={handleAddAgent}>
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M10 5v10M5 10h10" />
                    </svg>
                    {!isCollapsed && <span>{t('layout.newAgent')}</span>}
                </button>

                {/* Agent 列表 - 动态渲染 */}
                <div className={styles.agentList}>
                    {hubAgents.map((agent) => (
                        <AgentNavItem
                            key={agent.id}
                            agentId={agent.id}
                            name={agent.name}
                            draggable
                            isDragging={draggedAgentId === agent.id}
                            isDragOver={dragOverAgentId === agent.id}
                            onDragStart={(event) => handleAgentDragStart(event, agent.id)}
                            onDragOver={(event) => handleAgentDragOver(event, agent.id)}
                            onDragLeave={() => handleAgentDragLeave(agent.id)}
                            onDrop={(event) => { void handleAgentDrop(event, agent.id); }}
                            onDragEnd={handleAgentDragEnd}
                        />
                    ))}
                </div>
            </nav>

            {/* 创建Agent弹窗 */}
            <AgentCreateModal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />
        </>
    );
}

