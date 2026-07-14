import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentNavItem } from './AgentNavItem';

const mockStores = vi.hoisted(() => ({
  agent: {
    currentAgentId: null as string | null,
    setCurrentAgentId: () => undefined,
    agents: [
      {
        id: 'agent-1',
        latestMessagePreview: 'A detailed message summary for the tooltip.',
      },
    ],
  },
  chat: {
    messagesByAgent: new Map(),
    lastReadByAgent: new Map(),
    streamingByContext: new Map(),
  },
  cron: {
    enabledAgentIds: new Set<string>(),
  },
  ui: {
    isLeftPanelCollapsed: false,
  },
}));

vi.mock('@components/ui/Tooltip', () => ({
  Tooltip: ({
    children,
    content,
    multiline,
    side,
    align,
  }: {
    children: ReactNode;
    content?: ReactNode;
    multiline?: boolean;
    side?: string;
    align?: string;
  }) => (
    <>
      {children}
      <span
        data-tooltip-content={typeof content === 'string' ? content : undefined}
        data-tooltip-multiline={multiline ? 'true' : 'false'}
        data-tooltip-side={side}
        data-tooltip-align={align}
      />
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
vi.mock('@stores/cronStore', () => ({
  useCronStore: (selector: (state: typeof mockStores.cron) => unknown) => selector(mockStores.cron),
}));
vi.mock('@stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockStores.ui) => unknown) => selector(mockStores.ui),
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('./AgentContextMenu', () => ({ AgentContextMenu: () => null }));

describe('AgentNavItem tooltips', () => {
  beforeEach(() => {
    mockStores.ui.isLeftPanelCollapsed = false;
    mockStores.chat.messagesByAgent = new Map();
  });

  it('uses the shared multiline tooltip for the latest message preview', () => {
    const html = renderToStaticMarkup(<AgentNavItem agentId="agent-1" name="Lockey" />);

    expect(html).not.toContain('title=');
    expect(html).toContain('data-tooltip-content="A detailed message summary for the tooltip."');
    expect(html).toContain('data-tooltip-multiline="true"');
    expect(html).toContain('data-tooltip-side="right"');
    expect(html).toContain('data-tooltip-align="start"');
  });

  it('truncates a loaded full message to 200 Unicode characters and adds an ellipsis', () => {
    const visiblePrefix = '界'.repeat(200);
    mockStores.chat.messagesByAgent.set('agent-1', [
      {
        id: 'message-1',
        agentId: 'agent-1',
        role: 'assistant',
        content: `${visiblePrefix}尾`,
        createdAt: 1,
      },
    ]);

    const html = renderToStaticMarkup(<AgentNavItem agentId="agent-1" name="Lockey" />);

    expect(html).toContain(`data-tooltip-content="${visiblePrefix}…"`);
    expect(html).not.toContain('尾');
  });
});
