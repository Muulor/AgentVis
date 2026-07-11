import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MessageSquareText, Plus } from 'lucide-react';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { HubCreateModal } from './HubCreateModal';
import { HubContextMenu } from './HubContextMenu';
import { Tooltip } from '@components/ui/Tooltip';
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

function moveItemNearTarget<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
  placement: DropPlacement
): T[] {
  if (sourceId === targetId) return items;

  const sourceItem = items.find((item) => item.id === sourceId);
  if (!sourceItem) return items;

  const withoutSource = items.filter((item) => item.id !== sourceId);
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return items;

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex;
  return [...withoutSource.slice(0, insertIndex), sourceItem, ...withoutSource.slice(insertIndex)];
}

/**
 * HubTabs 组件
 *
 * 顶部Hub标签页切换组件，支持：
 * - 动态渲染Hub列表
 * - 点击切换当前Hub
 * - hover/focus 时展开横向 Hub 轨道
 * - 鼠标滚轮横向浏览更多 Hub
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
  const [isExpanded, setIsExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const activeHubRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const handleOpenCreate = () => setIsCreateModalOpen(true);

    window.addEventListener(OPEN_HUB_CREATE_EVENT, handleOpenCreate);
    return () => window.removeEventListener(OPEN_HUB_CREATE_EVENT, handleOpenCreate);
  }, []);

  // 右键菜单状态
  const [contextMenuHubId, setContextMenuHubId] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(
    null
  );

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

  // 切换 Agent ID 的 action（点击 Hub 标签进入 Hub 讨论区）
  const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);

  const currentHub = useMemo(
    () => hubs.find((hub) => hub.id === currentHubId) ?? hubs[0],
    [currentHubId, hubs]
  );

  // 展开时将当前 Hub 尽量居中，便于快速扫视左右相邻 Hub
  useEffect(() => {
    if (!isExpanded || !currentHubId) return;

    const centerActiveHub = (behavior: ScrollBehavior) => {
      const rail = railRef.current;
      const activeHub = activeHubRef.current;
      if (!rail || !activeHub) return;

      const targetLeft = activeHub.offsetLeft + activeHub.offsetWidth / 2 - rail.clientWidth / 2;
      rail.scrollTo({
        left: Math.max(0, targetLeft),
        behavior,
      });
    };

    const frameId = window.requestAnimationFrame(() => centerActiveHub('auto'));
    let delayedFrameId = 0;
    const timeoutId = window.setTimeout(() => {
      delayedFrameId = window.requestAnimationFrame(() => centerActiveHub('smooth'));
    }, 240);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(delayedFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [currentHubId, hubs.length, isExpanded]);

  // 切换Hub，并将中栏切回该 Hub 的讨论区
  const handleTabClick = useCallback(
    (hubId: string) => {
      setCurrentAgentId(null);
      setCurrentHubId(hubId);
    },
    [setCurrentHubId, setCurrentAgentId]
  );

  const handleCurrentHubClick = useCallback(() => {
    if (!currentHub) return;
    handleTabClick(currentHub.id);
  }, [currentHub, handleTabClick]);

  // 右键菜单
  const handleContextMenu = useCallback((event: React.MouseEvent, hubId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuHubId(hubId);
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

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

  const handleHubDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>, targetHubId: string, placement: DropPlacement) => {
      event.preventDefault();
      const sourceHubId = draggedHubId ?? event.dataTransfer.getData('text/plain');
      setDraggedHubId(null);
      setDragOverHubId(null);

      if (!sourceHubId || sourceHubId === targetHubId) return;

      const nextHubs = moveItemNearTarget(hubs, sourceHubId, targetHubId, placement);
      if (nextHubs === hubs) return;

      const previousHubs = hubs;
      const orderedIds = nextHubs.map((hub) => hub.id);
      reorderHubs(orderedIds);

      try {
        await invoke('hub_reorder', { request: { orderedIds } });
      } catch (error) {
        setHubs(previousHubs);
        logger.error('[HubTabs] Failed to persist hub order:', error);
      }
    },
    [draggedHubId, hubs, reorderHubs, setHubs]
  );

  const handleHubDragEnd = useCallback(() => {
    setDraggedHubId(null);
    setDragOverHubId(null);
  }, []);

  // 在展开轨道上将纵向滚轮映射为横向滚动，适配普通鼠标和触控板
  const handleRailWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isExpanded) return;

      const rail = railRef.current;
      if (!rail || rail.scrollWidth <= rail.clientWidth) return;

      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;

      event.preventDefault();
      rail.scrollLeft += delta;
    },
    [isExpanded]
  );

  const handleBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsExpanded(false);
  }, []);

  return (
    <>
      <div className={styles.tabs}>
        <div className={styles.hubActions}>
          <Tooltip content={t('hub.tabs.openDiscussion')}>
            <button
              className={styles.hubActionButton}
              onClick={handleCurrentHubClick}
              disabled={!currentHub}
              aria-label={t('hub.tabs.openDiscussion')}
            >
              <MessageSquareText size={17} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <Tooltip content={t('hub.tabs.newHub')}>
            <button
              className={styles.hubActionButton}
              onClick={() => setIsCreateModalOpen(true)}
              aria-label={t('hub.tabs.newHub')}
            >
              <Plus size={17} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </div>

        {hubs.length > 0 && (
          <div
            className={styles.switcher}
            data-expanded={isExpanded}
            onMouseEnter={() => setIsExpanded(true)}
            onMouseLeave={() => setIsExpanded(false)}
            onFocusCapture={() => setIsExpanded(true)}
            onBlurCapture={handleBlur}
          >
            {currentHub && (
              <Tooltip content={currentHub.name}>
                <button
                  className={styles.currentHub}
                  onClick={handleCurrentHubClick}
                  onContextMenu={(e) => handleContextMenu(e, currentHub.id)}
                  aria-expanded={isExpanded}
                >
                  <span className={styles.currentHubLabel}>{currentHub.name}</span>
                  <svg
                    className={styles.currentHubChevron}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M3 4.5l3 3 3-3" />
                  </svg>
                </button>
              </Tooltip>
            )}

            <div ref={railRef} className={styles.rail} onWheel={handleRailWheel}>
              {hubs.map((hub) => (
                <Tooltip key={hub.id} content={hub.name}>
                  <button
                    ref={hub.id === currentHubId ? activeHubRef : undefined}
                    className={styles.tab}
                    data-active={hub.id === currentHubId}
                    data-dragging={draggedHubId === hub.id}
                    data-drag-over={dragOverHubId === hub.id}
                    draggable
                    onClick={() => handleTabClick(hub.id)}
                    onContextMenu={(e) => handleContextMenu(e, hub.id)}
                    onDragStart={(e) => handleHubDragStart(e, hub.id)}
                    onDragOver={(e) => handleHubDragOver(e, hub.id)}
                    onDragLeave={() => handleHubDragLeave(hub.id)}
                    onDrop={(e) => {
                      void handleHubDrop(e, hub.id, getHorizontalDropPlacement(e));
                    }}
                    onDragEnd={handleHubDragEnd}
                  >
                    <span className={styles.tabLabel}>{hub.name}</span>
                    {/* 未读 Agent 消息小圆点：当前 hub 非激活态且有任意 agent 未读时显示 */}
                    {hubUnreadSet.has(hub.id) && (
                      <span className={styles.unreadDot} aria-label={t('hub.tabs.unread')} />
                    )}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
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
