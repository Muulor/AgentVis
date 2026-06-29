import { describe, expect, it } from 'vitest';

import {
    getAttachmentKind,
    getFileTypeInfo,
    getPreviewRenderer,
    getRustParserCommand,
    isSystemVideoFile,
    shouldAutoIndexKnowledgeFile,
} from '../FileTypeRegistry';

describe('FileTypeRegistry', () => {
    it('describes attachment and parser capabilities by extension', () => {
        expect(getAttachmentKind('report.docx')).toBe('document');
        expect(getAttachmentKind('legacy-sheet.xls')).toBe('document');
        expect(getAttachmentKind('README.markdown')).toBe('document');
        expect(getAttachmentKind('debug.log')).toBe('document');
        expect(getAttachmentKind('component.vue')).toBe('document');
        expect(getAttachmentKind('schema.graphql')).toBe('document');
        expect(getAttachmentKind('notebook.ipynb')).toBe('document');
        expect(getAttachmentKind('photo.png')).toBe('image');
        expect(getAttachmentKind('archive.zip')).toBeNull();
        expect(getRustParserCommand('report.pdf')).toBe('parse_pdf');
        expect(getRustParserCommand('sheet.xls')).toBe('parse_xlsx');
    });

    it('keeps preview classification separate from knowledge indexing', () => {
        expect(getPreviewRenderer('src/App.ts')).toBe('code');
        expect(isSystemVideoFile('src/App.ts')).toBe(false);
        expect(shouldAutoIndexKnowledgeFile('src/App.ts')).toBe(false);

        expect(getPreviewRenderer('notes.md')).toBe('markdown');
        expect(shouldAutoIndexKnowledgeFile('notes.md')).toBe(true);

        expect(getPreviewRenderer('book.xls')).toBe('binaryDoc');
        expect(shouldAutoIndexKnowledgeFile('book.xls')).toBe(true);

        expect(getPreviewRenderer('config.json')).toBe('code');
        expect(shouldAutoIndexKnowledgeFile('config.json')).toBe(false);

        expect(getPreviewRenderer('schema.graphql')).toBe('code');
        expect(shouldAutoIndexKnowledgeFile('schema.graphql')).toBe(false);
    });

    it('applies filename-level knowledge exclusions', () => {
        const info = getFileTypeInfo('Agent-Log/2026-05-19_agent-log.md');

        expect(info.family).toBe('markdown');
        expect(info.preview.renderer).toBe('markdown');
        expect(info.knowledge.autoIndex).toBe(false);
    });

    it('keeps log files attachable without auto-indexing them', () => {
        const info = getFileTypeInfo('debug.log');

        expect(info.attachment.accepted).toBe(true);
        expect(info.parser.mode).toBe('text');
        expect(info.preview.renderer).toBe('plainText');
        expect(info.knowledge.autoIndex).toBe(false);
    });
});
