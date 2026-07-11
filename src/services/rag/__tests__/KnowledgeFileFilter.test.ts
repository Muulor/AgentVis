import { describe, expect, it } from 'vitest';

import {
  isAgentLogFileForKnowledge,
  getKnowledgeDocumentType,
  isCodeFileForKnowledge,
  isKnowledgeOfficeFile,
  isKnowledgeTextFile,
  shouldAutoIndexKnowledgeFile,
} from '../KnowledgeFileFilter';

describe('KnowledgeFileFilter', () => {
  it('allows document and text-like files for automatic indexing', () => {
    expect(shouldAutoIndexKnowledgeFile('D:\\AgentVis\\report.md')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/notes.txt')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/data.csv')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/slides.pptx')).toBe(true);

    expect(isKnowledgeTextFile('/tmp/notes.txt')).toBe(true);
    expect(isKnowledgeOfficeFile('/tmp/book.xlsx')).toBe(true);
    expect(isKnowledgeOfficeFile('/tmp/legacy-book.xls')).toBe(true);
    expect(getKnowledgeDocumentType('/tmp/report.markdown')).toBe('markdown');
  });

  it('blocks code files and unknown extensions from automatic indexing', () => {
    expect(isCodeFileForKnowledge('/tmp/app.ts')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/index.HTML')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/config.json')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/settings.yaml')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/settings.yam')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/pyproject.toml')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/web.config.xml')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/readme.rst')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/package-lock.json')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/notebook.ipynb')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/schema.graphql')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/main.tf')).toBe(true);
    expect(isCodeFileForKnowledge('/tmp/app.mjs')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/app.ts')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/script.py')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/query.sql')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/config.json')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/data.jsonl')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/package-lock.json')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/notebook.ipynb')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/schema.graphql')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/main.tf')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/app.mjs')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/settings.ini')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/archive.bin')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/README')).toBe(false);
  });

  it('blocks generated agent log markdown files', () => {
    expect(isAgentLogFileForKnowledge('/tmp/Agent-Log/2026-05-19_agent-log.md')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/Agent-Log/2026-05-19_agent-log.md')).toBe(false);
    expect(shouldAutoIndexKnowledgeFile('/tmp/Agent-Log/2026-05-19_agent-log.markdown')).toBe(true);
    expect(shouldAutoIndexKnowledgeFile('/tmp/Agent-Log/2026-5-19_agent-log.md')).toBe(true);
  });
});
