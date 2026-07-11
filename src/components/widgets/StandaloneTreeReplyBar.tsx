/**
 * StandaloneTreeReplyBar - standalone 决策树消息底部操作栏。
 *
 * TreeWidget 内部的“重新选择”只负责未提交前的路径重置；当 standalone tree
 * 已经触发 widget 用户消息和 Agent 回复后，本组件在气泡底部提供消息级撤回入口。
 */

import { memo, useCallback, useMemo } from 'react';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { parseWithFallback } from '@services/memory/utils/JsonParser';
import { useWidgetStore } from '@stores/widgetStore';
import { useI18n } from '@/i18n';
import { extractFencedCodeBlocks, parseWidgetLanguage, resolveWidgetType } from './widgetParsing';
import styles from './StandaloneTreeReplyBar.module.css';

interface StandaloneTreeReplyBarProps {
  messageId: string;
  contextId: string;
  content: string;
}

function makeLevelKey(baseKey: string, depth: number): string {
  return `${baseKey}:L${depth}`;
}

function makeDepthKey(baseKey: string): string {
  return `${baseKey}:depth`;
}

function makeDoneKey(baseKey: string): string {
  return `${baseKey}:done`;
}

function extractTreeBaseKeys(content: string, contextId: string): string[] {
  const baseKeys = new Set<string>();

  for (const block of extractFencedCodeBlocks(content)) {
    if (!parseWidgetLanguage(block.language).isWidget) continue;

    const parsed = parseWithFallback<Record<string, unknown>>(block.code, {
      logPrefix: '[StandaloneTreeReplyBar]',
    });
    const data = parsed.data;
    if (!parsed.success || !data) continue;
    if (resolveWidgetType(block.language, data) !== 'tree') continue;

    const title = typeof data.title === 'string' ? data.title : '';
    baseKeys.add(`tree:${contextId}:${title}`);
  }

  return Array.from(baseKeys);
}

function clearTreeSelection(baseKey: string, clearSelectionOnly: (widgetKey: string) => void) {
  clearSelectionOnly(baseKey);
  for (let i = 0; i < 10; i++) {
    clearSelectionOnly(makeLevelKey(baseKey, i));
  }
  clearSelectionOnly(makeDepthKey(baseKey));
  clearSelectionOnly(makeDoneKey(baseKey));
}

export const StandaloneTreeReplyBar = memo(function StandaloneTreeReplyBar({
  messageId,
  contextId,
  content,
}: StandaloneTreeReplyBarProps) {
  const { t } = useI18n();
  const clearSelectionOnly = useWidgetStore((s) => s.clearSelectionOnly);
  const clearSelectionAndUndo = useWidgetStore((s) => s.clearSelectionAndUndo);
  const treeBaseKeys = useMemo(() => extractTreeBaseKeys(content, contextId), [content, contextId]);
  const hasCompletedTree = useWidgetStore((s) =>
    treeBaseKeys.some((baseKey) => s.selections.get(makeDoneKey(baseKey)) === 1)
  );

  const handleReselect = useCallback(() => {
    const selections = useWidgetStore.getState().selections;
    const completedBaseKeys = treeBaseKeys.filter(
      (baseKey) => selections.get(makeDoneKey(baseKey)) === 1
    );
    const targetBaseKey = completedBaseKeys[0];
    if (!targetBaseKey) return;

    for (const baseKey of treeBaseKeys) {
      clearTreeSelection(baseKey, clearSelectionOnly);
    }
    clearSelectionAndUndo(targetBaseKey, contextId, messageId);
  }, [treeBaseKeys, clearSelectionOnly, clearSelectionAndUndo, contextId, messageId]);

  if (!hasCompletedTree) return null;

  return (
    <div className={styles.bar}>
      <div className={styles.submittedRow}>
        <span className={styles.submittedLabel}>
          <CheckCircle2 size={13} />
          {t('chat.processed')}
        </span>
        <button
          className={styles.reselectBtn}
          onClick={handleReselect}
          title={t('widgets.reselectTitle')}
        >
          <RotateCcw size={13} />
          <span>{t('widgets.reselect')}</span>
        </button>
      </div>
    </div>
  );
});
