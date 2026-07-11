/**
 * MemoryPanel - 记忆管理面板主容器
 *
 * 放置在 Agent 设置弹窗的「记忆」标签页内，包含：
 * - Hub 隔离提示 Banner
 * - 三标签切换（短期缓冲/摘要层/事实）
 * - 对应视图组件
 */

import { useState, useCallback } from 'react';
import { emit } from '@tauri-apps/api/event';
import { CircleAlert } from 'lucide-react';
import styles from './MemoryPanel.module.css';
import type { MemoryPanelProps, MemoryTabId } from './types';
import { MEMORY_TABS } from './types';
import { ShortTermView } from './ShortTermView';
import { SummaryView } from './SummaryView';
import { FactsView } from './FactsView';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';

const logger = getLogger('MemoryPanel');

export function MemoryPanel({ agentId }: MemoryPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<MemoryTabId>('short_term');

  const getTabLabel = (tabId: MemoryTabId) => {
    switch (tabId) {
      case 'short_term':
        return t('memory.tabs.shortTerm');
      case 'summary':
        return t('memory.tabs.summary');
      case 'facts':
        return t('memory.tabs.facts');
    }
  };

  // 跳转到消息：发射事件通知主窗口
  const handleJumpToMessage = useCallback(
    async (messageId: string) => {
      logger.trace('[MemoryPanel] 请求跳转到消息:', messageId);
      try {
        // 发射事件，AgentChatView 监听此事件来处理跳转
        await emit('chat:jump_to_message', {
          messageId,
          agentId,
        });
      } catch (error) {
        logger.error('[MemoryPanel] 发射跳转事件失败:', error);
      }
    },
    [agentId]
  );

  return (
    <div className={styles.container}>
      {/* Hub 隔离提示 */}
      <div className={styles.isolationBanner}>
        <CircleAlert size={16} strokeWidth={2.2} className={styles.isolationIcon} />
        <span>{t('memory.embeddingHint')}</span>
      </div>

      {/* 标签切换 */}
      <div className={styles.tabList}>
        {MEMORY_TABS.map((tab) => (
          <button
            key={tab.id}
            className={styles.tab}
            data-active={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {getTabLabel(tab.id)}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className={styles.content}>
        {activeTab === 'short_term' && (
          <ShortTermView agentId={agentId} onJumpToMessage={handleJumpToMessage} />
        )}
        {activeTab === 'summary' && <SummaryView agentId={agentId} />}
        {activeTab === 'facts' && <FactsView agentId={agentId} />}
      </div>
    </div>
  );
}
