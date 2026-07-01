import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;
const JSON_FENCE_PATTERN = /```json\s*\n([\s\S]*?)```/g;

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

function readSkill(relativePath: string): string {
    return readFileSync(resolve(CURRENT_DIR, relativePath), 'utf8');
}

function extractJsonFencedBlocks(markdown: string): string[] {
    return [...markdown.matchAll(JSON_FENCE_PATTERN)].map(match => (match[1] ?? '').trim());
}

describe('native skill prompt invariants', () => {
    const skills = [
        {
            name: 'read',
            path: '../read/SKILL.md',
            requiredTokens: [
                'name: read',
                'behaviorHint=\'direct\'',
                '[READ_META]',
                'hasMore=true',
                'hasMore=false',
                'startLine',
                'endLine',
                'patch search',
            ],
        },
        {
            name: 'local_search',
            path: '../local_search/SKILL.md',
            requiredTokens: [
                'name: local_search',
                'behaviorHint=\'direct\'',
                'mode: grep',
                'mode: find',
                'mode: outline',
                'mode: symbol',
                'includes',
                'symbolName',
                'absolute paths',
            ],
        },
        {
            name: 'conversation_search',
            path: '../conversation_search/SKILL.md',
            requiredTokens: [
                'name: conversation_search',
                'behaviorHint=\'direct\'',
                'current Agent only',
                'mode: "timeline"',
                'mode: "search"',
                'mode: "get"',
                'query',
                'limit',
                'offset',
                'order',
                'role',
                'startAt',
                'endAt',
                'hasMore',
                'nextOffset',
                'messageId',
                'messageIds',
            ],
        },
        {
            name: 'web_search',
            path: '../web_search/SKILL.md',
            requiredTokens: [
                'name: web_search',
                'behaviorHint=\'direct\'',
                'searchDepth: "basic"',
                '"advanced"',
                'includeContent: true',
                'maxResults',
            ],
        },
        {
            name: 'file_write',
            path: '../file_write/SKILL.md',
            requiredTokens: [
                'name: file_write',
                'mode: "patch"',
                '`"full"`',
                '`"patch"`',
                'PatchItem[]',
                '{search, replace}',
                'Every `file_write` tool call must pass a non-empty JSON argument object.',
                'Do not split related patches into multiple separate calls.',
                'combine all related edits into one `file_write` tool call',
                'POST_WRITE_VALIDATION_FAILED',
                '`.jsx`',
                '`.yaml`',
                '`.toml`',
                'cargo check --message-format=json',
                'Pyright/Mypy',
                'current-package `go test`',
                'local ESLint',
                'Do not use `exec` or a shell script to create or modify text',
            ],
        },
        {
            name: 'exec',
            path: '../exec/SKILL.md',
            requiredTokens: [
                'name: exec',
                'behaviorHint=\'direct\'',
                'behaviorHint=\'careful\'',
                'stdin is always null',
                'cmd.exe',
                'PowerShell',
                '-NoProfile',
                '-LiteralPath',
                '1200-1800',
                'use `file_write`',
                'Do not use `exec` to write text content',
            ],
        },
        {
            name: 'generate_image',
            path: '../generate_image/SKILL.md',
            requiredTokens: [
                'name: generate_image',
                'behaviorHint=\'direct\'',
                'ref_image_path',
                'ref_image_paths',
                'aspect_ratio',
                'image_size',
                'custom_name',
                'Do not rename generated image files after generation.',
                'up to 14 images',
                '`1K`, `2K`, `4K`',
                'agent_avatar.webp',
            ],
        },
        {
            name: 'cron',
            path: '../cron/SKILL.md',
            requiredTokens: [
                'name: cron',
                'behaviorHint=\'direct\'',
                '`create`',
                '`list`',
                '`update`',
                '`delete`',
                'cronExpression',
                'jobId',
                'enabled',
                'minute hour day-of-month month day-of-week',
                'self-contained',
            ],
        },
        {
            name: 'im_send',
            path: '../im_send/SKILL.md',
            requiredTokens: [
                'name: im_send',
                'behaviorHint=\'direct\'',
                '`send_text`',
                '`send_image`',
                '`send_file`',
                '`platform`',
                '`channelId`',
                '`receiveIdType`',
                '`receiveId`',
                '`botId`',
                'current IM context',
                'default Slack channel',
                'default Feishu outbound target',
            ],
        },
        {
            name: 'feishu_send',
            path: '../feishu_send/SKILL.md',
            requiredTokens: [
                'name: feishu_send',
                'behaviorHint=\'direct\'',
                '`send_text`',
                '`send_image`',
                '`send_file`',
                '`receiveIdType`',
                '`receiveId`',
                '`botId`',
                'default outbound target',
                'active Feishu chat',
                'last remembered Feishu chat',
                'Do not run the external `feishu-send` Python skill',
            ],
        },
        {
            name: 'slack_send',
            path: '../slack_send/SKILL.md',
            requiredTokens: [
                'name: slack_send',
                'behaviorHint=\'direct\'',
                '`send_text`',
                '`send_image`',
                '`send_file`',
                '`channelId`',
                '`botId`',
                'default Slack channel',
                'active Slack chat',
                'last remembered Slack chat',
                'not the deprecated `files.upload` API',
            ],
        },
    ];

    it('keeps the Batch 6 native skill docs in English', () => {
        for (const skill of skills) {
            const content = readSkill(skill.path);

            expect(content, `${skill.name} should not contain Han characters`)
                .not.toMatch(HAN_CHARACTER_PATTERN);
        }
    });

    it('preserves key tool names, parameters, modes, and return markers', () => {
        for (const skill of skills) {
            const content = readSkill(skill.path);

            for (const token of skill.requiredTokens) {
                expect(content, `${skill.name} should preserve ${token}`).toContain(token);
            }
        }
    });

    it('keeps JSON examples parseable', () => {
        const skillsWithJsonExamples = [
            { name: 'file_write', path: '../file_write/SKILL.md', count: 2 },
            { name: 'local_search', path: '../local_search/SKILL.md', count: 4 },
            { name: 'conversation_search', path: '../conversation_search/SKILL.md', count: 7 },
            { name: 'cron', path: '../cron/SKILL.md', count: 5 },
            { name: 'im_send', path: '../im_send/SKILL.md', count: 3 },
            { name: 'feishu_send', path: '../feishu_send/SKILL.md', count: 3 },
            { name: 'slack_send', path: '../slack_send/SKILL.md', count: 3 },
        ];

        for (const skill of skillsWithJsonExamples) {
            const content = readSkill(skill.path);
            const blocks = extractJsonFencedBlocks(content);

            expect(blocks, `${skill.name} JSON example count`).toHaveLength(skill.count);

            for (const block of blocks) {
                expect(() => JSON.parse(block), `${skill.name} JSON block should parse`).not.toThrow();
            }
        }
    });
});
