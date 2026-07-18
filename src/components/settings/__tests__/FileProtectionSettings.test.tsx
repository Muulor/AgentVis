import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { ToastProvider } from '@components/ui/Toast';
import { runTrashOperation, useTrashOperationStore } from '@stores/trashOperationStore';
import { FileProtectionSettings } from '../FileProtectionSettings';
import { createPendingTrashClean, executeConfirmedTrashClean } from '../trashCleanConfirmation';
import { normalizeTrashBinListResponse } from '../trashListState';

vi.mock('@components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content?: ReactNode }) => (
    <span data-tooltip={content ?? ''}>{children}</span>
  ),
}));

const trashEntry = {
  id: 'entry-1',
  originalPath: 'E:\\ANIMA_v1',
  trashPath: 'C:\\AgentTrash\\entry-1',
  deletedAt: '2026-07-18T10:00:00.000Z',
  command: 'rmdir /s /q E:\\ANIMA_v1',
  batchId: 'batch-1',
  isDirectory: true,
  originalExists: false,
  trashExists: true,
};

describe('Agent Trash list response', () => {
  it('normalizes structured ready and busy responses without turning busy into an empty list', () => {
    expect(normalizeTrashBinListResponse({ status: 'ready', entries: [trashEntry] })).toEqual({
      status: 'ready',
      entries: [trashEntry],
    });
    expect(normalizeTrashBinListResponse({ status: 'busy', retryAfterMs: 750 })).toEqual({
      status: 'busy',
      retryAfterMs: 750,
    });
  });

  it('accepts the legacy array response during a mixed frontend/backend development session', () => {
    expect(normalizeTrashBinListResponse([trashEntry])).toEqual({
      status: 'ready',
      entries: [trashEntry],
    });
  });

  it('rejects a malformed ready response', () => {
    expect(() => normalizeTrashBinListResponse({ status: 'ready' })).toThrow(
      'Invalid Agent Trash list response'
    );
  });
});

describe('Agent Trash permanent-clean confirmation', () => {
  it('keeps the cleanup request inert until the confirm handler executes it', async () => {
    const selectedIds = new Set(['entry-1', 'entry-2']);
    const request = createPendingTrashClean(selectedIds, 'selected');
    const cleanEntries = vi.fn(async () => undefined);

    expect(request).not.toBeNull();
    expect(cleanEntries).not.toHaveBeenCalled();

    selectedIds.clear();
    expect(request?.ids).toEqual(['entry-1', 'entry-2']);

    await executeConfirmedTrashClean(request!, cleanEntries);
    expect(cleanEntries).toHaveBeenCalledTimes(1);
    expect(cleanEntries).toHaveBeenCalledWith(['entry-1', 'entry-2'], 'selected');
  });

  it('does not create a confirmation request without selected entries', () => {
    expect(createPendingTrashClean([], 'selected')).toBeNull();
  });
});

describe('FileProtectionSettings long operation state', () => {
  beforeEach(() => {
    useTrashOperationStore.setState({ activeOperation: null, settledRevision: 0 });
  });

  it('shows background restore progress instead of a false empty state after remount', async () => {
    let finishRestore!: () => void;
    const restorePending = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const operation = runTrashOperation({ kind: 'restore', key: 'selected' }, () => restorePending);
    const serverState = useTrashOperationStore.getInitialState();
    const previousServerState = {
      activeOperation: serverState.activeOperation,
      settledRevision: serverState.settledRevision,
    };
    Object.assign(serverState, {
      activeOperation: useTrashOperationStore.getState().activeOperation,
      settledRevision: useTrashOperationStore.getState().settledRevision,
    });

    try {
      const html = renderToStaticMarkup(
        <I18nProvider>
          <ToastProvider>
            <FileProtectionSettings />
          </ToastProvider>
        </I18nProvider>
      );

      expect(html).toContain('正在恢复选中的文件。可以关闭设置，恢复会在后台继续。');
      expect(html).not.toContain('暂无可恢复的 Agent 删除记录');
      expect(html).toContain('data-disabled="true"');
    } finally {
      Object.assign(serverState, previousServerState);
      finishRestore();
      await operation;
    }
  });
});
