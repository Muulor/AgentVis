import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { ContextPressure } from '@stores/statusStore';

import { StatusBar } from './StatusBar';

const mockStores = vi.hoisted(() => ({
  agent: {
    currentAgentId: null as string | null,
    agents: [],
  },
  chat: {
    sendingContexts: new Set<string>(),
    streamingByContext: new Map<string, { isStreaming: boolean }>(),
  },
  settings: {
    defaultProvider: 'openai',
    defaultModel: 'gpt-test',
  },
  status: {
    activeTokenContextId: 'context-1' as string | null,
    contextPressureByAgent: {} as Record<string, ContextPressure>,
    modelStatus: 'unconfigured',
    memoryStatus: 'idle',
    documentProgress: null,
    setModelStatus: () => undefined,
    setMemoryStatus: () => undefined,
  },
  imChannel: {
    connectionStates: {},
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@components/ui/Tooltip', () => ({
  Tooltip: ({
    children,
    content,
    multiline,
  }: {
    children: ReactNode;
    content?: ReactNode;
    multiline?: boolean;
  }) => (
    <>
      {children}
      <span data-tooltip-multiline={multiline ? 'true' : 'false'}>{content}</span>
    </>
  ),
}));
vi.mock('@stores/agentStore', () => ({
  useAgentStore: (selector: (state: typeof mockStores.agent) => unknown) =>
    selector(mockStores.agent),
}));
vi.mock('@stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockStores.chat) => unknown) => selector(mockStores.chat),
}));
vi.mock('@stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof mockStores.settings) => unknown) =>
    selector(mockStores.settings),
}));
vi.mock('@stores/statusStore', () => ({
  useStatusStore: (selector: (state: typeof mockStores.status) => unknown) =>
    selector(mockStores.status),
}));
vi.mock('@stores/imChannelStore', () => ({
  useImChannelStore: (selector: (state: typeof mockStores.imChannel) => unknown) =>
    selector(mockStores.imChannel),
}));

function renderStatusBar(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <StatusBar />
    </I18nProvider>
  );
}

describe('StatusBar context usage', () => {
  beforeEach(() => {
    mockStores.agent.currentAgentId = null;
    mockStores.chat.sendingContexts = new Set<string>();
    mockStores.chat.streamingByContext = new Map();
    mockStores.status.activeTokenContextId = 'context-1';
    mockStores.status.contextPressureByAgent = {};
  });

  it('shows Current Context with input, output, and window while active', () => {
    mockStores.chat.sendingContexts = new Set(['context-1']);
    mockStores.status.contextPressureByAgent['context-1'] = {
      callId: 'call-1',
      contextWindowSize: 128_000,
      currentInputTokens: 1_250,
      currentOutputTokens: 80,
      phase: 'active',
    };

    const html = renderStatusBar();

    expect(html).toContain('Current Context');
    expect(html).toContain('≈ ↓ 1.3k + ↑ 80 / 128k');
    expect(html).toContain('当前调用上下文（通用估算）：输入 1250 tokens');
    expect(html).toContain('data-tooltip-multiline="true"');
    expect(html).not.toContain('供应商 usage');
    expect(html).not.toContain('Est.TotalIn');
    expect(html).not.toContain('Est.TotalOut');
  });

  it('shows Last Context after completion and includes output in pressure ratio', () => {
    mockStores.chat.sendingContexts = new Set(['context-1']);
    mockStores.status.contextPressureByAgent['context-1'] = {
      callId: 'call-1',
      contextWindowSize: 100,
      currentInputTokens: 50,
      currentOutputTokens: 40,
      phase: 'last',
    };

    const html = renderStatusBar();

    expect(html).toContain('Last Context');
    expect(html).toContain('data-pressure="warning"');
    expect(html).toContain('≈ ↓ 50 + ↑ 40 / 100');
  });

  it('hides context usage while the task is idle', () => {
    mockStores.status.contextPressureByAgent['context-1'] = {
      callId: 'call-1',
      contextWindowSize: 128_000,
      currentInputTokens: 400,
      currentOutputTokens: 0,
      phase: 'active',
    };

    const html = renderStatusBar();

    expect(html).not.toContain('Current Context');
    expect(html).not.toContain('Last Context');
  });
});
