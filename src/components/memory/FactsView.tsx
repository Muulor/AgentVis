/**
 * FactsView - 事实视图
 *
 * 显示事实列表，包含：
 * - 事实卡片网格
 * - 编辑 / 删除功能
 */

import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, RefreshCw } from 'lucide-react';
import styles from './FactsView.module.css';
import type { FactsViewProps, FactItem } from './types';
import type { LongTermFactCategory } from '@services/memory/types';
import { FactCard } from './FactCard';
import { FactEditModal } from './FactEditModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '@components/ui/Tooltip';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';
import { buildManualFactCreateRequest, isManualFactMetadata } from './manualFact';

const logger = getLogger('FactsView');

// 后端返回的事实格式
interface BackendMemory {
  id: string;
  agentId: string;
  layer: string;
  content: string;
  category: string | null;
  importance: number | null;
  sourceMessageIds: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export function FactsView({ agentId }: FactsViewProps) {
  const { language, t } = useI18n();
  const [facts, setFacts] = useState<FactItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 编辑模态框状态
  const [editingFact, setEditingFact] = useState<FactItem | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // 删除确认状态
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // 加载事实数据
  const loadData = useCallback(async () => {
    if (!agentId) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await invoke<BackendMemory[]>('memory_list_by_layer', {
        agentId,
        layer: 'fact',
      });

      // 🔧 按创建时间正序排列（最早在前），确保\"第1轮对话\"是最早的事实
      const sortedResult = [...result].sort((a, b) => a.createdAt - b.createdAt);

      // 转换为 UI 数据格式
      const items: FactItem[] = sortedResult.map((mem) => {
        const date = new Date(mem.createdAt);
        const timeStr = date.toLocaleString(language, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        return {
          id: mem.id,
          content: mem.content,
          category: (mem.category ?? 'interaction_signals') as LongTermFactCategory,
          sourceMessageId: mem.sourceMessageIds ?? undefined,
          sourceDescription: isManualFactMetadata(mem.metadataJson)
            ? t('memory.manuallyAddedAt', { time: timeStr })
            : t('memory.extractedAt', { time: timeStr }),
          createdAt: mem.createdAt,
          updatedAt: mem.updatedAt,
        };
      });

      setFacts(items);
    } catch (err) {
      logger.error('加载事实失败:', err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [agentId, language, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 监听事实更新事件，自动刷新列表
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ agentId: string; count: number }>(
          'memory:facts_updated',
          (event) => {
            if (event.payload.agentId === agentId) {
              logger.trace(
                `[FactsView] 收到事实更新事件，刷新列表 (新增 ${event.payload.count} 条)`
              );
              void loadData();
            }
          }
        );
      } catch {
        // 事件监听设置失败不影响主流程
      }
    };

    void setupListener();

    return () => {
      unlisten?.();
    };
  }, [agentId, loadData]);

  // 编辑事实
  const handleEdit = useCallback(
    (id: string) => {
      const fact = facts.find((f) => f.id === id);
      if (fact) {
        setEditingFact(fact);
      }
    },
    [facts]
  );

  // 新增事实
  const handleCreate = useCallback(() => {
    setIsCreateModalOpen(true);
  }, []);

  // 请求删除事实（打开确认对话框）
  const handleDeleteRequest = useCallback((id: string) => {
    setDeleteTargetId(id);
  }, []);

  // 确认删除事实（同时删除向量索引）
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetId) return;

    setIsDeleting(true);
    try {
      // 使用统一命令：同时删除记忆 + 向量索引，防止残留向量被 RAG 检索到
      await invoke('memory_delete_fact_with_vector', { id: deleteTargetId, agentId });
      setFacts((prev) => prev.filter((f) => f.id !== deleteTargetId));
      setDeleteTargetId(null);
    } catch (err) {
      logger.error('删除事实失败:', err);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTargetId, agentId]);

  // 取消删除
  const handleCancelDelete = useCallback(() => {
    setDeleteTargetId(null);
  }, []);

  // 保存编辑
  const handleSave = useCallback(
    async (id: string | null, content: string, category: LongTermFactCategory) => {
      try {
        if (!id) {
          await invoke('memory_create', {
            request: buildManualFactCreateRequest({
              agentId,
              content,
              category,
            }),
          });

          await loadData();
          setIsCreateModalOpen(false);
          return;
        }

        // 同时更新 content 和 category
        await invoke('memory_update', {
          id,
          content,
          category, // 现在后端支持 category 参数
        });

        // 更新本地状态
        setFacts((prev) =>
          prev.map((f) => (f.id === id ? { ...f, content, category, updatedAt: Date.now() } : f))
        );

        setEditingFact(null);
      } catch (err) {
        logger.error('保存事实失败:', err);
        throw err;
      }
    },
    [agentId, loadData]
  );

  // 跳转到消息
  const handleJump = useCallback((messageId: string) => {
    logger.trace('跳转到消息:', messageId);
    // TODO: 实现跳转到对话历史
  }, []);

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
        <span className={styles.title}>{t('memory.factsTitle', { count: facts.length })}</span>
        <div className={styles.headerActions}>
          <Tooltip content={t('memory.addFact')}>
            <button
              className={styles.iconBtn}
              onClick={handleCreate}
              aria-label={t('memory.addFact')}
            >
              <Plus size={14} strokeWidth={1.8} />
            </button>
          </Tooltip>
          <Tooltip content={t('common.refresh')}>
            <button className={styles.iconBtn} onClick={loadData} aria-label={t('common.refresh')}>
              <RefreshCw size={14} strokeWidth={1.8} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* 事实列表 */}
      <div className={styles.factList}>
        {facts.length === 0 ? (
          <div className={styles.empty}>{t('memory.emptyFacts')}</div>
        ) : (
          facts.map((fact) => (
            <FactCard
              key={fact.id}
              id={fact.id}
              content={fact.content}
              category={fact.category}
              sourceMessageId={fact.sourceMessageId}
              sourceDescription={fact.sourceDescription}
              createdAt={fact.createdAt}
              onEdit={handleEdit}
              onDelete={handleDeleteRequest}
              onJump={handleJump}
            />
          ))
        )}
      </div>

      {/* 编辑模态框 */}
      <FactEditModal
        isOpen={!!editingFact}
        mode="edit"
        factId={editingFact?.id ?? null}
        initialContent={editingFact?.content}
        initialCategory={editingFact?.category}
        sourceDescription={editingFact?.sourceDescription}
        onClose={() => setEditingFact(null)}
        onSave={handleSave}
      />

      {/* 新增模态框 */}
      <FactEditModal
        isOpen={isCreateModalOpen}
        mode="create"
        factId={null}
        initialContent=""
        initialCategory="preference_style"
        onClose={() => setIsCreateModalOpen(false)}
        onSave={handleSave}
      />

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={deleteTargetId !== null}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title={t('agent.context.deleteTitle')}
        description={t('memory.deleteFactConfirm')}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  );
}
