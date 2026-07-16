import { describe, expect, it } from 'vitest';
import {
  buildDocumentOverviewContent,
  createDocumentOverviewChunk,
  DOCUMENT_OVERVIEW_CHUNK_INDEX,
} from '../DocumentOverviewBuilder';

describe('DocumentOverviewBuilder', () => {
  it('builds a compact document overview from headings and lead text', () => {
    const content = [
      '# AgentVis Feature Deep Dive',
      '',
      'This document summarizes AgentVis capabilities across memory, RAG, context, and skills.',
      '',
      'It is meant to answer broad product capability questions.',
      '',
      '## Memory',
      'Memory details.',
      '',
      '## Context Management',
      'Context details.',
    ].join('\n');

    const overview = buildDocumentOverviewContent({
      documentId: 'doc-features',
      content,
      metadata: {
        fileName: 'features_deep_dive.md',
      },
      childChunkCount: 4,
      parentChunkCount: 3,
    });

    expect(overview).toContain('# Document Overview');
    expect(overview).toContain('File: features_deep_dive.md');
    expect(overview).toContain('Title: AgentVis Feature Deep Dive');
    expect(overview).toContain('Chunks: 4');
    expect(overview).toContain('Sections: 3');
    expect(overview).toContain('- H2 Memory');
    expect(overview).toContain('- H2 Context Management');
    expect(overview).toContain('This document summarizes AgentVis capabilities');
  });

  it('creates a synthetic overview chunk with stable metadata boundaries', () => {
    const chunk = createDocumentOverviewChunk({
      agentId: 'agent-1',
      documentId: 'doc-features',
      content: '# AgentVis Features\n\nBroad capability overview.',
      metadata: {
        fileName: 'features_deep_dive.md',
        filePath: 'D:\\AgentVis\\docs\\features_deep_dive.md',
        documentType: 'markdown',
      },
      childChunkCount: 1,
      parentChunkCount: 1,
    });

    expect(chunk).not.toBeNull();
    expect(chunk?.id).toMatch(/^chunk_doc_overview_/);
    expect(chunk?.chunkIndex).toBe(DOCUMENT_OVERVIEW_CHUNK_INDEX);
    expect(chunk?.metadata.isDocumentOverview).toBe(true);
    expect(chunk?.metadata.fileName).toBe('features_deep_dive.md');
    expect(chunk?.metadata.parentChunkId).toBe(chunk?.id);
    expect(chunk?.content).toContain('Title: AgentVis Features');
  });

  it('does not split an emoji surrogate pair at the overview limit', () => {
    const overview = buildDocumentOverviewContent({
      documentId: 'emoji-overview',
      content: `# ${'😀'.repeat(1_000)}\n\nlead`,
      metadata: { fileName: 'emoji.md' },
      childChunkCount: 1,
      parentChunkCount: 1,
    });

    const hasUnpairedSurrogate = Array.from(overview).some((character) => {
      if (character.length !== 1) return false;
      const codeUnit = character.charCodeAt(0);
      return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
    });
    expect(hasUnpairedSurrogate).toBe(false);
  });
});
