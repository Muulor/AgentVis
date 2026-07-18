/**
 * trashOperationStore - Agent Trash 长任务生命周期协调
 *
 * 在设置页卸载后继续跟踪恢复/清理操作，并以操作 ID 防止并发任务或过期任务清理
 * 当前活动状态。
 */

import { create } from 'zustand';

export type TrashOperationKind = 'restore' | 'clean';

export interface ActiveTrashOperation {
  id: string;
  kind: TrashOperationKind;
  key: string;
}

export interface TrashOperationRequest {
  kind: TrashOperationKind;
  key: string;
}

type TrashOperationTask<T> = () => Promise<T> | T;

interface TrashOperationState {
  activeOperation: ActiveTrashOperation | null;
  settledRevision: number;
  runOperation: <T>(operation: TrashOperationRequest, task: TrashOperationTask<T>) => Promise<T>;
}

export class TrashOperationInProgressError extends Error {
  readonly activeOperation: ActiveTrashOperation;

  constructor(activeOperation: ActiveTrashOperation) {
    super('trash_operation_in_progress');
    this.name = 'TrashOperationInProgressError';
    this.activeOperation = activeOperation;
  }
}

function createOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `trash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useTrashOperationStore = create<TrashOperationState>((set, get) => ({
  activeOperation: null,
  settledRevision: 0,

  runOperation: async (operation, task) => {
    const current = get().activeOperation;
    if (current) {
      throw new TrashOperationInProgressError(current);
    }

    const id = createOperationId();
    set({ activeOperation: { id, ...operation } });

    try {
      return await task();
    } finally {
      set((state) =>
        state.activeOperation?.id === id
          ? {
              activeOperation: null,
              settledRevision: state.settledRevision + 1,
            }
          : state
      );
    }
  },
}));

export function runTrashOperation<T>(
  operation: TrashOperationRequest,
  task: TrashOperationTask<T>
): Promise<T> {
  return useTrashOperationStore.getState().runOperation(operation, task);
}
