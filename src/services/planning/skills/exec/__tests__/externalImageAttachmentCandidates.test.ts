import { describe, expect, it } from 'vitest';
import {
    extractExternalImageAttachmentCandidates,
    shouldExtractPlainTextImageAttachmentPaths,
} from '../tool';

describe('extractExternalImageAttachmentCandidates', () => {
    it('应识别 desktop-control observe 的 vision screenshot_path', () => {
        const output = JSON.stringify({
            success: true,
            data: {
                action: 'observe',
                analysis: {
                    vision: {
                        screenshot_path: 'C:/tmp/observe.png',
                    },
                },
            },
        });

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([
            {
                path: 'C:/tmp/observe.png',
                source: 'data.analysis.vision.screenshot_path',
            },
        ]);
    });

    it('应识别 desktop-control screenshot 的 data.path', () => {
        const output = JSON.stringify({
            success: true,
            data: {
                action: 'screenshot',
                path: 'capture.png',
            },
        });

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([
            {
                path: 'capture.png',
                source: 'data.path',
            },
        ]);
    });

    it('应识别显式 agentvis_context attachments 协议', () => {
        const output = JSON.stringify({
            success: true,
            agentvis_context: {
                attachments: [
                    {
                        type: 'image',
                        path: 'C:/tmp/screen.webp',
                        mimeType: 'image/webp',
                    },
                    {
                        type: 'text',
                        path: 'C:/tmp/readme.md',
                    },
                ],
            },
        });

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([
            {
                path: 'C:/tmp/screen.webp',
                mimeType: 'image/webp',
                source: 'agentvis_context.attachments',
            },
        ]);
    });

    it('应从带日志的输出中解析最后一行 JSON', () => {
        const output = [
            'starting desktop-control...',
            JSON.stringify({
                success: true,
                data: {
                    action: 'observe',
                    screenshot: {
                        path: 'observe.png',
                    },
                },
            }),
        ].join('\n');

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([
            {
                path: 'observe.png',
                source: 'data.screenshot.path',
            },
        ]);
    });

    it('同一路径通过多个字段出现时应去重', () => {
        const output = JSON.stringify({
            success: true,
            data: {
                action: 'observe',
                path: 'observe.png',
                screenshot: {
                    path: 'observe.png',
                },
            },
        });

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([
            {
                path: 'observe.png',
                source: 'data.screenshot.path',
            },
        ]);
    });

    it('should ignore plain image paths unless plaintext fallback is enabled', () => {
        const output = [
            'C:\\Users\\Muulo\\AppData\\Roaming\\com.agentvis.app\\Agent_Trash_Bin\\old.png',
            'C:\\Users\\Muulo\\AppData\\Roaming\\com.agentvis.app\\deliverables\\report.png',
        ].join('\n');

        const candidates = extractExternalImageAttachmentCandidates(output);

        expect(candidates).toEqual([]);
    });

    it('should only enable plaintext fallback for image automation commands', () => {
        const output = 'saved screenshot: C:\\tmp\\browser-screen.png';

        expect(shouldExtractPlainTextImageAttachmentPaths('browser-command.bat screenshot --annotate')).toBe(true);
        expect(shouldExtractPlainTextImageAttachmentPaths('dir /s /b "%APPDATA%\\com.agentvis.app\\*"')).toBe(false);

        const candidates = extractExternalImageAttachmentCandidates(output, {
            allowPlainTextFallback: shouldExtractPlainTextImageAttachmentPaths('browser-command.bat screenshot'),
        });

        expect(candidates).toEqual([
            {
                path: 'C:\\tmp\\browser-screen.png',
                source: 'plaintext_path',
            },
        ]);
    });
});
