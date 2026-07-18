import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runTrashOperation,
  TrashOperationInProgressError,
  useTrashOperationStore,
} from './trashOperationStore';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('trashOperationStore', () => {
  beforeEach(() => {
    useTrashOperationStore.setState({ activeOperation: null, settledRevision: 0 });
  });

  it('keeps an operation active while its task is pending', async () => {
    const task = deferred<string>();
    const result = runTrashOperation({ kind: 'restore', key: 'selected' }, () => task.promise);

    expect(useTrashOperationStore.getState().activeOperation).toMatchObject({
      id: expect.any(String),
      kind: 'restore',
      key: 'selected',
    });

    task.resolve('restored');
    await expect(result).resolves.toBe('restored');
  });

  it('clears the matching active operation after success', async () => {
    await expect(runTrashOperation({ kind: 'clean', key: 'batch-1' }, async () => 2)).resolves.toBe(
      2
    );

    expect(useTrashOperationStore.getState().activeOperation).toBeNull();
  });

  it('clears the matching active operation after failure', async () => {
    const failure = new Error('cleanup failed');

    await expect(
      runTrashOperation({ kind: 'clean', key: 'selected' }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(useTrashOperationStore.getState().activeOperation).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)(
    'increments the settled revision when an operation %ss',
    async (settlement) => {
      const task = deferred<undefined>();
      const operation = runTrashOperation({ kind: 'restore', key: settlement }, () => task.promise);

      if (settlement === 'resolve') {
        task.resolve(undefined);
        await operation;
      } else {
        task.reject(new Error('restore failed'));
        await expect(operation).rejects.toThrow('restore failed');
      }

      expect(useTrashOperationStore.getState().settledRevision).toBe(1);
    }
  );

  it('rejects a concurrent operation without starting its task', async () => {
    const firstTask = deferred<undefined>();
    const first = runTrashOperation({ kind: 'restore', key: 'entry-1' }, () => firstTask.promise);
    const active = useTrashOperationStore.getState().activeOperation;
    if (!active) {
      throw new Error('expected the first operation to be active');
    }
    const secondTask = vi.fn(async () => undefined);

    await expect(
      runTrashOperation({ kind: 'clean', key: 'entry-2' }, secondTask)
    ).rejects.toMatchObject({
      name: 'TrashOperationInProgressError',
      activeOperation: active,
    } satisfies Partial<TrashOperationInProgressError>);
    expect(secondTask).not.toHaveBeenCalled();
    expect(useTrashOperationStore.getState().activeOperation).toBe(active);

    firstTask.resolve(undefined);
    await first;
  });

  it.each(['resolve', 'reject'] as const)(
    'does not clear a newer operation when an older task %ss',
    async (settlement) => {
      const task = deferred<undefined>();
      const original = runTrashOperation({ kind: 'restore', key: 'old' }, () => task.promise);
      const replacement = { id: 'replacement', kind: 'clean', key: 'new' } as const;
      useTrashOperationStore.setState({ activeOperation: replacement });

      if (settlement === 'resolve') {
        task.resolve(undefined);
        await original;
      } else {
        task.reject(new Error('old operation failed'));
        await expect(original).rejects.toThrow('old operation failed');
      }

      expect(useTrashOperationStore.getState().activeOperation).toBe(replacement);
      expect(useTrashOperationStore.getState().settledRevision).toBe(0);
    }
  );
});
