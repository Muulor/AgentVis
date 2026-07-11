import { useCallback } from 'react';
import { useHubStore } from '@stores/hubStore';
import { useUIStore } from '@stores/uiStore';
import { useAgentStore } from '@stores/agentStore';
import { useI18n } from '@/i18n';
import styles from './HubNavItem.module.css';

/**
 * HubNavItem 组件
 *
 * 左栏Hub讨论区入口，支持：
 * - 显示当前Hub的讨论区入口
 * - 点击进入Hub讨论视图
 * - 选中态视觉反馈
 * - 支持折叠状态
 */
export function HubNavItem() {
  const { t } = useI18n();
  const currentHubId = useHubStore((state) => state.currentHubId);
  const hubs = useHubStore((state) => state.hubs);
  const currentAgentId = useAgentStore((state) => state.currentAgentId);
  const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);
  const isCollapsed = useUIStore((state) => state.isLeftPanelCollapsed);

  // 获取当前Hub名称
  const currentHub = hubs.find((h) => h.id === currentHubId);
  const hubName = currentHub?.name ?? t('hub.defaultDiscussionName');

  // 判断是否选中Hub讨论区（没有选中Agent时）
  const isActive = currentHubId !== null && currentAgentId === null;

  // 点击进入Hub讨论区
  const handleClick = useCallback(() => {
    // 清除Agent选中状态，进入Hub讨论区
    setCurrentAgentId(null);
  }, [setCurrentAgentId]);

  return (
    <div
      className={styles.navItem}
      data-active={isActive}
      data-collapsed={isCollapsed}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className={styles.icon}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 4h12v10H6l-2 2V4z" />
        </svg>
      </div>
      {!isCollapsed && <span className={styles.label}>{hubName}</span>}
    </div>
  );
}
