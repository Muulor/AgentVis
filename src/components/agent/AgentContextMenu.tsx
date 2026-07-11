import { useCallback, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '@stores/agentStore';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { useToast } from '@components/ui/Toast';
import { useI18n } from '@/i18n';
import styles from './AgentContextMenu.module.css';
import { getLogger } from '@services/logger';
import { visualEnhancementJobManager } from '@services/planning/visual-enhancer/VisualEnhancementJobManager';

const logger = getLogger('AgentContextMenu');

interface AgentContextMenuProps {
  agentId: string;
  agentName: string;
  position: { x: number; y: number };
  onClose: () => void;
}

/**
 * AgentContextMenu 组件
 *
 * Agent右键上下文菜单，支持：
 * - 重命名（内联编辑）
 * - 删除/移到回收站
 * - 点击外部区域关闭
 */
export function AgentContextMenu({ agentId, agentName, position, onClose }: AgentContextMenuProps) {
  const { t } = useI18n();
  const agents = useAgentStore((state) => state.agents);
  const updateAgent = useAgentStore((state) => state.updateAgent);
  const removeAgent = useAgentStore((state) => state.removeAgent);
  const currentAgentId = useAgentStore((state) => state.currentAgentId);
  const setCurrentAgentId = useAgentStore((state) => state.setCurrentAgentId);
  const { toast } = useToast();

  const agent = agents.find((a) => a.id === agentId);

  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(agentName);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭（排除删除确认对话框）
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showDeleteConfirm) return; // 显示确认对话框时不关闭菜单
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, showDeleteConfirm]);

  // Escape关闭
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showDeleteConfirm) {
          setShowDeleteConfirm(false);
        } else if (isRenaming) {
          setIsRenaming(false);
          setNewName(agentName);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isRenaming, agentName, onClose, showDeleteConfirm]);

  // 聚焦重命名输入框
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  // 计算菜单位置，防止超出屏幕
  const menuStyle = {
    left: Math.min(position.x, window.innerWidth - 180),
    top: Math.min(position.y, window.innerHeight - 150),
  };

  // 重命名操作
  const handleRename = useCallback(() => {
    setIsRenaming(true);
  }, []);

  // 提交重命名
  const handleRenameSubmit = useCallback(async () => {
    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName === agentName) {
      setIsRenaming(false);
      setNewName(agentName);
      return;
    }

    // 检查同 Hub 下是否有同名 Agent（排除自己）
    if (agent) {
      const sameHubAgents = agents.filter((a) => a.hubId === agent.hubId && a.id !== agentId);
      const isDuplicate = sameHubAgents.some(
        (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (isDuplicate) {
        // 重名时恢复原名称并显示提示
        toast({
          type: 'error',
          title: t('agent.context.nameConflictTitle'),
          description: t('agent.create.duplicateName'),
        });
        setNewName(agentName);
        setIsRenaming(false);
        return;
      }
    }

    try {
      // 调用Tauri命令更新Agent
      await invoke('agent_update', { id: agentId, request: { name: trimmedName } });

      // 更新Store
      updateAgent(agentId, { name: trimmedName });

      setIsRenaming(false);
      onClose();
    } catch (err) {
      logger.error('重命名Agent失败:', err);
      setNewName(agentName);
      setIsRenaming(false);
    }
  }, [newName, agentName, agentId, agent, agents, updateAgent, onClose, toast, t]);

  // 重命名输入键盘事件
  const handleRenameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleRenameSubmit();
      }
    },
    [handleRenameSubmit]
  );

  // 打开删除确认对话框
  const handleDeleteClick = useCallback(() => {
    setShowDeleteConfirm(true);
  }, []);

  // 确认删除
  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      // 调用Tauri命令删除Agent（软删除到回收站）
      await invoke('agent_delete', { id: agentId });
      visualEnhancementJobManager.cancelContext(agentId);

      // 从Store移除
      removeAgent(agentId);

      // 如果删除的是当前选中的Agent，清空选中状态
      if (currentAgentId === agentId) {
        setCurrentAgentId(null);
      }

      setShowDeleteConfirm(false);
      onClose();
    } catch (err) {
      logger.error('删除Agent失败:', err);
    } finally {
      setIsDeleting(false);
    }
  }, [agentId, removeAgent, currentAgentId, setCurrentAgentId, onClose]);

  // 取消删除
  const handleCancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
  }, []);

  if (!agent) {
    return null;
  }

  return (
    <>
      <div ref={menuRef} className={styles.contextMenu} style={menuStyle}>
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            className={styles.renameInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            maxLength={50}
          />
        ) : (
          <>
            <button className={styles.menuItem} onClick={handleRename}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M9.5 3.5l3 3M3 10.5V13h2.5L13 5.5l-3-3L3 10.5z" />
              </svg>
              {t('common.rename')}
            </button>
            <div className={styles.divider} />
            <button className={styles.menuItem} data-danger="true" onClick={handleDeleteClick}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M3 4h10M6 4V3h4v1M5 4v9h6V4" />
              </svg>
              {t('common.delete')}
            </button>
          </>
        )}
      </div>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title={t('agent.context.deleteTitle')}
        description={t('agent.context.deleteDescription', { name: agentName })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
        isLoading={isDeleting}
      />
    </>
  );
}
