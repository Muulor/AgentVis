/**
 * trashListState - Agent Trash 列表 IPC 状态归一化
 *
 * 区分真实列表、后端忙碌与格式错误，并兼容开发期间旧后端返回的数组形式。
 */

export interface TrashBinListResponse<T> {
  status: 'ready' | 'busy';
  entries?: T[];
  retryAfterMs?: number;
}

export function normalizeTrashBinListResponse<T>(
  response: TrashBinListResponse<T> | T[]
): TrashBinListResponse<T> {
  if (Array.isArray(response)) {
    return { status: 'ready', entries: response };
  }
  if (response.status === 'busy') {
    return { status: 'busy', retryAfterMs: response.retryAfterMs };
  }
  if (Array.isArray(response.entries)) {
    return { status: 'ready', entries: response.entries };
  }
  throw new Error('Invalid Agent Trash list response');
}
