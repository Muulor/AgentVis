/**
 * TaskArtifactStore 单元测试
 *
 * 覆盖核心功能：write/read/getSnapshot/clear/evict
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskArtifactStore } from '../TaskArtifactStore';

describe('TaskArtifactStore', () => {
  let store: TaskArtifactStore;

  beforeEach(() => {
    store = new TaskArtifactStore();
  });

  // ─────────────────────────────────────────────────────────
  // 基础读写
  // ─────────────────────────────────────────────────────────

  it('初始状态应为空', () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.getTotalTokens()).toBe(0);
  });

  it('write 后应能通过 getAll 读取', () => {
    store.write('web_search', '搜索结果内容', 'search_results', 'test query', 'researcher');

    expect(store.isEmpty()).toBe(false);
    expect(store.size()).toBe(1);

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.toolName).toBe('web_search');
    expect(all[0]!.content).toBe('搜索结果内容');
    expect(all[0]!.dataType).toBe('search_results');
    expect(all[0]!.sourceHint).toBe('test query');
    expect(all[0]!.createdBy).toBe('researcher');
    expect(all[0]!.estimatedTokens).toBeGreaterThan(0);
  });

  it('write 应生成唯一 key', () => {
    store.write('web_search', 'result 1', 'search_results', 'q1', 'sa');
    store.write('web_search', 'result 2', 'search_results', 'q2', 'sa');

    const all = store.getAll();
    expect(all).toHaveLength(2);
    // 两个 key 不同
    expect(all[0]!.key).not.toBe(all[1]!.key);
  });

  it('read 应返回指定 key 的 Artifact', () => {
    store.write('read', 'file content', 'file_content', '/path/to/file', 'sa');

    const all = store.getAll();
    const key = all[0]!.key;
    const artifact = store.read(key);

    expect(artifact).toBeDefined();
    expect(artifact!.content).toBe('file content');
  });

  it('read 不存在的 key 应返回 undefined', () => {
    expect(store.read('nonexistent')).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────
  // 索引
  // ─────────────────────────────────────────────────────────

  it('getIndex 应返回轻量索引（不含 content）', () => {
    store.write('web_search', 'search result content', 'search_results', 'test query', 'sa');

    const index = store.getIndex();
    expect(index).toHaveLength(1);
    expect(index[0]!.toolName).toBe('web_search');
    expect(index[0]!.sourceHint).toBe('test query');
    // 索引不包含 content 字段
    expect((index[0]! as unknown as Record<string, unknown>)['content']).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────
  // 快照（预算控制）
  // ─────────────────────────────────────────────────────────

  it('getSnapshot 应在预算充足时返回全部', () => {
    store.write('web_search', 'short content', 'search_results', 'q1', 'sa');

    const snapshot = store.getSnapshot(10000);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.index).toHaveLength(1);
    expect(snapshot.totalTokens).toBeGreaterThan(0);
  });

  it('getSnapshot 预算不足时应优先保留最新的', () => {
    // 写入多条，每条约 10 个 token
    store.write('web_search', 'A'.repeat(40), 'search_results', 'q1', 'sa');
    store.write('web_search', 'B'.repeat(40), 'search_results', 'q2', 'sa');
    store.write('web_search', 'C'.repeat(40), 'search_results', 'q3', 'sa');

    // 预算只够放 1 条（约 10 tokens）
    const snapshot = store.getSnapshot(12);
    // 索引应包含全部 3 条
    expect(snapshot.index).toHaveLength(3);
    // 但 artifacts 应只包含最新的（优先保留最新）
    expect(snapshot.artifacts.length).toBeLessThan(3);
    // 最新条目的内容应以 'C' 开头
    const latestArtifact = snapshot.artifacts[snapshot.artifacts.length - 1];
    expect(latestArtifact!.content).toMatch(/^C+/);
  });

  // ─────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────

  it('clear 应清空所有 Artifacts', () => {
    store.write('web_search', 'content', 'search_results', 'q', 'sa');
    store.write('read', 'content', 'file_content', '/path', 'sa');

    expect(store.size()).toBe(2);

    store.clear();

    expect(store.isEmpty()).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.getAll()).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────
  // FIFO 淘汰
  // ─────────────────────────────────────────────────────────

  it('超出总预算时应按 FIFO 淘汰最旧条目', () => {
    // 创建一个很小预算的 store（100 tokens = 400 字符）
    const smallStore = new TaskArtifactStore(100);

    // 写入 200 字符 = ~50 tokens
    smallStore.write('web_search', 'A'.repeat(200), 'search_results', 'q1', 'sa');
    // 写入 200 字符 = ~50 tokens（总计 ~100 tokens，刚好在预算内）
    smallStore.write('web_search', 'B'.repeat(200), 'search_results', 'q2', 'sa');

    expect(smallStore.size()).toBe(2);

    // 再写入 200 字符 = ~50 tokens（总计 ~150 tokens，超出预算）
    smallStore.write('web_search', 'C'.repeat(200), 'search_results', 'q3', 'sa');

    // 最旧的应被淘汰
    expect(smallStore.size()).toBe(2);
    const all = smallStore.getAll();
    // 不应包含第一条（A 开头的）
    expect(all[0]!.content).toMatch(/^B+/);
    expect(all[1]!.content).toMatch(/^C+/);
  });

  // ─────────────────────────────────────────────────────────
  // Token 估算
  // ─────────────────────────────────────────────────────────

  it('estimatedTokens 纯英文应按 4 字符/token 估算', () => {
    store.write('web_search', 'Hello World', 'search_results', 'q', 'sa');

    const artifact = store.getAll()[0]!;
    // "Hello World" = 11 chars (全英文), 11/4 = 2.75, ceil → 3
    expect(artifact.estimatedTokens).toBe(3);
  });

  it('estimatedTokens 中文应按 1.5 字符/token 估算', () => {
    // 7 个中文字符 → 7/1.5 = 4.67, ceil → 5
    store.write('read', '测试中文内容啊呢', 'file_content', '/path', 'sa');

    const artifact = store.getAll()[0]!;
    // "测试中文内容啊呢" = 8 个中文字符，8/1.5 = 5.33, ceil → 6
    expect(artifact.estimatedTokens).toBe(6);
  });

  it('estimatedTokens 中英混合应分别计算', () => {
    // "Hello你好" = 5 英文字符 + 2 中文字符
    // 英文: 5/4 = 1.25 → ceil = 2
    // 中文: 2/1.5 = 1.33 → ceil = 2
    // 总计: 4
    store.write('read', 'Hello你好', 'file_content', '/path', 'sa');

    const artifact = store.getAll()[0]!;
    expect(artifact.estimatedTokens).toBe(4);
  });
});
