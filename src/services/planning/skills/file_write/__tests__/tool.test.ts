import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: vi.fn(),
  fastApplyService: {
    generateDiff: vi.fn(),
    applyAll: vi.fn(),
  },
  ragService: {
    deleteDocumentIndex: vi.fn(),
    indexDocument: vi.fn(),
  },
  agentState: {
    agents: [] as Array<{
      id: string;
      knowledgePaths: string | null;
      autoIndexDeliverables?: boolean | null;
    }>,
    updateAgent: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: mocks.emit,
}));

vi.mock('../../../../fast-apply/FastApplyService', () => ({
  fastApplyService: mocks.fastApplyService,
}));

vi.mock('@services/rag', () => ({
  getRagService: () => mocks.ragService,
}));

vi.mock('../../../../../stores/agentStore', () => ({
  useAgentStore: {
    getState: () => mocks.agentState,
  },
}));

import { fileWriteTool } from '../tool';

describe('file_write tool', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.emit.mockReset();
    mocks.fastApplyService.generateDiff.mockReset();
    mocks.fastApplyService.applyAll.mockReset();
    mocks.ragService.deleteDocumentIndex.mockReset();
    mocks.ragService.indexDocument.mockReset();
    mocks.ragService.indexDocument.mockResolvedValue(3);
    mocks.agentState.agents = [
      {
        id: 'agent-1',
        knowledgePaths: null,
        autoIndexDeliverables: null,
      },
    ];
    mocks.agentState.updateAgent.mockReset();
    mocks.agentState.updateAgent.mockImplementation(
      (id: string, data: { knowledgePaths?: string | null }) => {
        mocks.agentState.agents = mocks.agentState.agents.map((agent) =>
          agent.id === id ? { ...agent, ...data } : agent
        );
      }
    );
  });

  it('writes and auto-indexes backend-staged large content by reference without requiring inline content', async () => {
    const stagedContent = '# Large UI Spec\n\n'.repeat(2000);

    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'file_write_staged_tool_arg_to_path') {
        return {
          success: true,
          filePath: args.path as string,
          backupPath: null,
          bytesWritten: 90000,
          existedBefore: false,
        };
      }
      if (command === 'file_read_content') {
        return stagedContent;
      }
      if (command === 'agent_update') {
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await fileWriteTool.execute(
      {
        path: 'ui-spec.md',
        contentRef: 'agentvis-large-tool-00000000-0000-4000-8000-000000000000.txt',
      },
      {
        workdir: 'D:\\AgentVis',
        agentId: 'agent-1',
      }
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('90000');
    expect(result.data).toMatchObject({
      type: 'file_write_create',
      bytesWritten: 90000,
    });
    expect(mocks.invoke).toHaveBeenCalledWith('file_write_staged_tool_arg_to_path', {
      path: 'D:\\AgentVis\\ui-spec.md',
      refId: 'agentvis-large-tool-00000000-0000-4000-8000-000000000000.txt',
      createBackup: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith('file_read_content', {
      filePath: 'D:\\AgentVis\\ui-spec.md',
    });
    expect(mocks.agentState.updateAgent).toHaveBeenCalledWith('agent-1', {
      knowledgePaths: JSON.stringify(['D:\\AgentVis\\ui-spec.md']),
    });
    expect(mocks.ragService.deleteDocumentIndex).toHaveBeenCalledWith(
      'agent-1',
      'D:\\AgentVis\\ui-spec.md'
    );
    expect(mocks.ragService.indexDocument).toHaveBeenCalledWith(
      'agent-1',
      'D:\\AgentVis\\ui-spec.md',
      stagedContent,
      expect.objectContaining({
        fileName: 'ui-spec.md',
        filePath: 'D:\\AgentVis\\ui-spec.md',
        documentType: 'markdown',
      })
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      'file:deliverable_created',
      expect.objectContaining({
        agentId: 'agent-1',
        fileName: 'ui-spec.md',
      })
    );
  });

  it('writes code deliverables without syncing them to the knowledge base', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'file_write_to_path') {
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await fileWriteTool.execute(
      {
        path: 'src/app.ts',
        mode: 'full',
        content: 'export const answer = 42;\n',
      },
      {
        workdir: 'D:\\AgentVis',
        agentId: 'agent-1',
      }
    );

    expect(result.success).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('file_write_to_path', {
      path: 'D:\\AgentVis\\src/app.ts',
      content: 'export const answer = 42;\n',
      createBackup: false,
    });
    expect(mocks.agentState.updateAgent).not.toHaveBeenCalled();
    expect(mocks.ragService.deleteDocumentIndex).not.toHaveBeenCalled();
    expect(mocks.ragService.indexDocument).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(
      'file:deliverable_created',
      expect.objectContaining({
        agentId: 'agent-1',
        fileName: 'app.ts',
      })
    );
  });

  it('falls back to overwrite when smart merge output differs from intended Rust lib.rs content', async () => {
    const originalContent = [
      'pub mod midi_engine {',
      '    pub mod transport;',
      '}',
      '',
      'pub mod audio_decoder;',
      'pub mod audio_engine;',
      'pub mod transport;',
      'pub mod mixer;',
      '',
    ].join('\n');
    const intendedContent = [
      'pub mod midi_engine {',
      '    pub mod transport;',
      '}',
      '',
      'pub mod audio_decoder;',
      'pub mod audio_engine;',
      'pub mod transport;',
      'pub mod clip_manager;',
      'pub mod mixer;',
      '',
    ].join('\n');
    const wrongMergeContent = [
      'pub mod midi_engine {',
      '    pub mod transport;',
      'pub mod clip_manager;',
      '}',
      '',
      'pub mod audio_decoder;',
      'pub mod audio_engine;',
      'pub mod transport;',
      'pub mod mixer;',
      '',
    ].join('\n');

    const written: Array<{ path: string; content: string; createBackup: boolean }> = [];
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'file_read_content') {
        return originalContent;
      }
      if (command === 'file_write_to_path') {
        written.push({
          path: args.path as string,
          content: args.content as string,
          createBackup: args.createBackup as boolean,
        });
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    mocks.fastApplyService.generateDiff.mockReturnValue({
      oldContent: originalContent,
      newContent: intendedContent,
      hasChanges: true,
      hunks: [
        {
          oldStart: 4,
          oldLines: 4,
          newStart: 4,
          newLines: 5,
          lines: [
            { type: 'context', content: 'pub mod audio_decoder;' },
            { type: 'context', content: 'pub mod audio_engine;' },
            { type: 'context', content: 'pub mod transport;' },
            { type: 'add', content: 'pub mod clip_manager;' },
            { type: 'context', content: 'pub mod mixer;' },
          ],
        },
      ],
    });
    mocks.fastApplyService.applyAll.mockResolvedValue({
      newContent: wrongMergeContent,
      batchResult: {
        documentId: 'D:\\Daw\\src/lib.rs',
        results: [],
        successCount: 1,
        failedCount: 0,
        pendingCount: 0,
      },
    });

    const result = await fileWriteTool.execute(
      {
        path: 'src/lib.rs',
        mode: 'full',
        content: intendedContent,
      },
      {
        workdir: 'D:\\Daw',
      }
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      type: 'file_write_overwrite',
      newContent: intendedContent,
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.content).toBe(intendedContent);
    expect(written[0]!.content).not.toBe(wrongMergeContent);
    expect(written[0]!.createBackup).toBe(true);
    expect(mocks.fastApplyService.applyAll).toHaveBeenCalledOnce();
  });
});
