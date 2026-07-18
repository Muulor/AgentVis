/**
 * Agent Trash 永久清理确认状态。
 *
 * 将“请求确认”和“确认后执行”拆成无副作用步骤，保证打开确认弹窗本身不会调用后端。
 */

export interface PendingTrashClean {
  ids: string[];
  deleteKey: string;
}

export function createPendingTrashClean(
  ids: Iterable<string>,
  deleteKey: string
): PendingTrashClean | null {
  const requestedIds = [...ids];
  return requestedIds.length > 0 ? { ids: requestedIds, deleteKey } : null;
}

export async function executeConfirmedTrashClean(
  request: PendingTrashClean,
  cleanEntries: (ids: string[], deleteKey: string) => Promise<void>
): Promise<void> {
  await cleanEntries([...request.ids], request.deleteKey);
}
