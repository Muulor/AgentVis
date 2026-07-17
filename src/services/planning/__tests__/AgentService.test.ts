import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentService,
  clearAllAgentServices,
  destroyAgentService,
  getOrCreateAgentService,
} from '../AgentService';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  translate: (key: string) => key,
}));

vi.mock('@services/logger', () => ({
  getLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function markServiceProcessing(service: AgentService): { cancel: ReturnType<typeof vi.fn> } {
  const loop = { cancel: vi.fn() };
  Object.assign(service as unknown as Record<string, unknown>, {
    isProcessing: true,
    activeRunId: 1,
    activeLoop: loop,
    cancellationRequested: false,
  });
  return loop;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AgentService', () => {
  afterEach(() => {
    clearAllAgentServices();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('推理档位变化时重建缓存服务', () => {
    clearAllAgentServices();
    const recommended = getOrCreateAgentService({
      agentId: 'reasoning-agent',
      reasoningPreset: 'recommended',
    });
    const sameConfig = getOrCreateAgentService({
      agentId: 'reasoning-agent',
      reasoningPreset: 'recommended',
    });
    const high = getOrCreateAgentService({
      agentId: 'reasoning-agent',
      reasoningPreset: 'high',
    });

    expect(sameConfig).toBe(recommended);
    expect(high).not.toBe(recommended);
    clearAllAgentServices();
  });

  it('同步已存在 Session 的历史消息增强内容', () => {
    const service = new AgentService({ agentId: 'agent-1' });
    service.loadChatHistory([
      {
        role: 'user',
        content: '这本书讲的是什么',
        createdAt: 1,
      },
    ]);

    const session = service.getOrCreateSession();
    expect(session.getMessages()[0]?.content).toBe('这本书讲的是什么');

    const enhancedHistoryContent = [
      '## 历史用户附件上下文',
      '这条历史用户消息曾上传以下附件。',
      '- 夜航西飞.md (document, .md, 478KB): D:\\AgentVis\\attachments\\夜航西飞.md',
      '',
      '[附件历史上下文已按约 1600 tokens 截断；如当前请求需要完整内容，请派发 Sub-Agent 直接读取上述附件路径。]',
      '',
      '这本书讲的是什么',
    ].join('\n');

    service.loadChatHistory([
      {
        role: 'user',
        content: enhancedHistoryContent,
        createdAt: 1,
      },
      {
        role: 'assistant',
        content: '《夜航西飞》是柏瑞尔·马卡姆的回忆录。',
        createdAt: 2,
      },
    ]);

    const messages = session.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('历史用户附件上下文');
    expect(messages[0]?.content).toContain('附件历史上下文已按约');
    expect(messages[0]?.content).toContain('夜航西飞.md');
  });

  it('用空历史快照清除已存在 Session 的旧消息', () => {
    const service = new AgentService({ agentId: 'agent-1' });
    service.loadChatHistory([
      {
        role: 'user',
        content: '已被删除的旧任务',
        createdAt: 1,
      },
      {
        role: 'assistant',
        content: '已被删除的旧回复',
        createdAt: 2,
      },
    ]);

    const session = service.getOrCreateSession();
    expect(session.getMessages()).toHaveLength(2);

    service.loadChatHistory([]);

    expect(session.getMessages()).toEqual([]);
  });

  it('新请求撞上活跃 run 时不会用自己的历史快照改写旧 Session', async () => {
    const service = new AgentService({ agentId: 'history-ownership-agent' });
    const session = service.getOrCreateSession();
    session.addUserMessage('旧 run 正在使用的历史');
    markServiceProcessing(service);

    await expect(
      service.processMessage('新请求', {
        chatHistory: [{ role: 'user', content: '不应覆盖旧 Session', createdAt: 2 }],
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'agent.chat.alreadyProcessing',
    });

    service.loadChatHistory([{ role: 'user', content: '直接覆盖也应被拒绝', createdAt: 3 }]);
    expect(session.getMessages()).toHaveLength(1);
    expect(session.getMessages()[0]?.content).toBe('旧 run 正在使用的历史');
  });

  it('取消超时告警不会释放未收口 run 的处理锁', async () => {
    vi.useFakeTimers();
    const service = new AgentService({ agentId: 'slow-cancel-agent' });
    const loop = markServiceProcessing(service);

    service.cancelProcessing();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(loop.cancel).toHaveBeenCalledTimes(1);
    expect(service.getIsProcessing()).toBe(true);
    await expect(service.processMessage('新任务')).resolves.toMatchObject({
      success: false,
      error: 'agent.chat.alreadyProcessing',
    });
  });

  it('取消超时后缓存返回隔离 Session 的新服务，旧服务仍保持锁定', async () => {
    vi.useFakeTimers();
    const service = getOrCreateAgentService({ agentId: 'replace-timed-out-agent' });
    const oldSession = service.getOrCreateSession();
    oldSession.addUserMessage('未收口的旧 run');
    markServiceProcessing(service);

    service.cancelProcessing();
    await vi.advanceTimersByTimeAsync(10_000);
    const replacement = getOrCreateAgentService({ agentId: 'replace-timed-out-agent' });

    expect(replacement).not.toBe(service);
    expect(replacement.getOrCreateSession()).not.toBe(oldSession);
    expect(oldSession.getMessages()).toHaveLength(1);
    expect(service.getIsProcessing()).toBe(true);
    await expect(service.processMessage('不应在旧服务上开始')).resolves.toMatchObject({
      success: false,
      error: 'agent.chat.alreadyProcessing',
    });
  });

  it('在记忆或 RAG 等待期取消后不会继续准备 Session 或启动 AgentLoop', async () => {
    const runtimeContext = deferred<Record<string, never>>();
    const service = new AgentService({ agentId: 'cancel-before-loop-agent' });
    const loadRuntimeContext = vi.fn(() => runtimeContext.promise);
    Object.assign(service as unknown as Record<string, unknown>, { loadRuntimeContext });
    const session = service.getOrCreateSession();
    const prepareContext = vi.spyOn(session, 'prepareContext');

    const result = service.processMessage('等待中取消');
    await vi.waitFor(() => expect(loadRuntimeContext).toHaveBeenCalledTimes(1));
    service.cancelProcessing();
    runtimeContext.resolve({});

    await expect(result).resolves.toMatchObject({
      success: true,
      terminationReason: 'cancelled',
    });
    expect(prepareContext).not.toHaveBeenCalled();
    expect(service.getIsProcessing()).toBe(false);
  });

  it('取消后记忆或 RAG await 以异常收口时仍返回 cancelled 而不是失败', async () => {
    const runtimeContext = deferred<Record<string, never>>();
    const service = new AgentService({ agentId: 'cancel-rejected-runtime-agent' });
    const loadRuntimeContext = vi.fn(() => runtimeContext.promise);
    Object.assign(service as unknown as Record<string, unknown>, { loadRuntimeContext });

    const result = service.processMessage('等待中取消');
    await vi.waitFor(() => expect(loadRuntimeContext).toHaveBeenCalledTimes(1));
    service.cancelProcessing();
    runtimeContext.reject(new Error('runtime retrieval aborted'));

    await expect(result).resolves.toMatchObject({
      success: true,
      terminationReason: 'cancelled',
    });
    expect(service.getIsProcessing()).toBe(false);
  });

  it('销毁活跃缓存服务时先脱离缓存并取消，但不清空旧 run 的 Session', () => {
    vi.useFakeTimers();
    const service = getOrCreateAgentService({ agentId: 'destroy-active-agent' });
    const session = service.getOrCreateSession();
    session.addUserMessage('旧 run 正在使用的消息');
    const loop = markServiceProcessing(service);

    destroyAgentService('destroy-active-agent');

    expect(loop.cancel).toHaveBeenCalledTimes(1);
    expect(session.getMessages()).toHaveLength(1);
    expect(getOrCreateAgentService({ agentId: 'destroy-active-agent' })).not.toBe(service);
  });

  it('清空缓存时保留活跃 run 的 Session，但清空空闲服务的 Session', () => {
    vi.useFakeTimers();
    const active = getOrCreateAgentService({ agentId: 'clear-active-agent' });
    const activeSession = active.getOrCreateSession();
    activeSession.addUserMessage('活跃消息');
    const activeLoop = markServiceProcessing(active);
    const idle = getOrCreateAgentService({ agentId: 'clear-idle-agent' });
    const idleSession = idle.getOrCreateSession();
    idleSession.addUserMessage('空闲消息');

    clearAllAgentServices();

    expect(activeLoop.cancel).toHaveBeenCalledTimes(1);
    expect(activeSession.getMessages()).toHaveLength(1);
    expect(idleSession.getMessages()).toEqual([]);
  });
});
