import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

import { DocumentProcessingService } from '../DocumentProcessingService';

describe('DocumentProcessingService text attachment parsing', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('uses the generic file reader for markdown attachments', async () => {
        const filePath = 'C:\\Users\\Muulo\\Documents\\agnes-image-21-flash-doc.md';
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'file_read_content') {
                return '# Agnes Image 2.1 Flash\n\nModel overview content.';
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        const service = new DocumentProcessingService();
        const result = await service.processDocument(
            filePath,
            'agnes-image-21-flash-doc.md',
            'md',
            'agent-1',
            undefined,
            128
        );

        expect(result.content).toContain('Agnes Image 2.1 Flash');
        expect(result.metadata.fileType).toBe('md');
        expect(result.metadata.title).toBe('Agnes Image 2.1 Flash');
        expect(invokeMock).toHaveBeenCalledWith('file_read_content', { filePath });
        expect(invokeMock).not.toHaveBeenCalledWith('parse_txt', expect.anything());
    });

    it('uses the generic file reader for non-txt plaintext attachments', async () => {
        const filePath = 'C:\\Users\\Muulo\\Documents\\example.ts';
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'file_read_content') {
                return 'export const modelName = "Agnes Image 2.1 Flash";';
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        const service = new DocumentProcessingService();
        const result = await service.processDocument(
            filePath,
            'example.ts',
            'ts',
            'agent-1',
            undefined,
            128
        );

        expect(result.content).toContain('export const modelName');
        expect(result.metadata.fileType).toBe('ts');
        expect(invokeMock).toHaveBeenCalledWith('file_read_content', { filePath });
        expect(invokeMock).not.toHaveBeenCalledWith('parse_txt', expect.anything());
    });
});
