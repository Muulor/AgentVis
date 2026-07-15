import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../AgentService';

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

describe('AgentService', () => {
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
});
