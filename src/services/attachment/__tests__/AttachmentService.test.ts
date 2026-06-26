import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const setDocumentProgressMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(),
}));

vi.mock('@stores/statusStore', () => ({
    useStatusStore: {
        getState: () => ({
            setDocumentProgress: setDocumentProgressMock,
        }),
    },
}));

import { AttachmentService } from '../AttachmentService';

describe('AttachmentService document attachments', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        setDocumentProgressMock.mockReset();
    });

    it('adds markdown attachments with parsed content without using the txt parser', async () => {
        const sourcePath = 'C:\\Users\\Muulo\\Downloads\\agnes-image-21-flash-doc.md';
        const targetDir = 'D:\\AgentVis\\attachments';
        const copiedPath = `${targetDir}\\agnes-image-21-flash-doc.md`;

        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'file_get_size') {
                return 256;
            }

            if (command === 'file_copy_to_attachments') {
                return copiedPath;
            }

            if (command === 'file_read_content') {
                return '# Agnes Image 2.1 Flash\n\nMarkdown attachment content.';
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        const service = new AttachmentService();
        const attachment = await service.addAttachment(sourcePath, 'agent-1', { targetDir });

        expect(attachment.type).toBe('document');
        expect(attachment.fileExtension).toBe('md');
        expect(attachment.localPath).toBe(copiedPath);
        expect(attachment.parsedContent).toContain('Markdown attachment content');
        expect(invokeMock).toHaveBeenCalledWith('file_copy_to_attachments', {
            sourcePath,
            agentId: 'agent-1',
            targetDir,
        });
        expect(invokeMock).toHaveBeenCalledWith('file_read_content', { filePath: copiedPath });
        expect(invokeMock).not.toHaveBeenCalledWith('parse_txt', expect.anything());
    });

    it('includes attachment paths in the injected context', () => {
        const service = new AttachmentService();
        const context = service.buildAttachmentContext([
            {
                id: 'attachment-1',
                fileName: 'agnes-image-21-flash-doc.md',
                fileExtension: 'md',
                type: 'document',
                size: 256,
                localPath: 'D:\\AgentVis\\attachments\\agnes-image-21-flash-doc.md',
                originalPath: 'C:\\Users\\Muulo\\Downloads\\agnes-image-21-flash-doc.md',
                parsedContent: 'Markdown attachment content.',
                createdAt: 1,
            },
            {
                id: 'attachment-2',
                fileName: 'screenshot.png',
                fileExtension: 'png',
                type: 'image',
                size: 1024,
                localPath: 'D:\\AgentVis\\attachments\\screenshot.png',
                originalPath: 'C:\\Users\\Muulo\\Pictures\\screenshot.png',
                createdAt: 1,
            },
        ]);

        expect(context).toContain('agnes-image-21-flash-doc.md');
        expect(context).toContain('D:\\AgentVis\\attachments\\agnes-image-21-flash-doc.md');
        expect(context).toContain('screenshot.png');
        expect(context).toContain('D:\\AgentVis\\attachments\\screenshot.png');
        expect(context).toContain('Markdown attachment content.');
    });
});
