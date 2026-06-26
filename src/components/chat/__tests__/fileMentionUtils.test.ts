import { describe, expect, it } from 'vitest';
import {
    filterFileMentionOptions,
    findFileMentionTrigger,
    getFileMentionLabel,
    type FileMentionOption,
} from '../fileMentionUtils';

const files: FileMentionOption[] = [
    {
        id: 'file:plan',
        kind: 'file',
        label: 'plan.md',
        path: 'D:\\project\\docs\\plan.md',
        relativePath: 'docs/plan.md',
    },
    {
        id: 'folder:docs',
        kind: 'folder',
        label: 'docs',
        path: 'D:\\project\\docs',
        relativePath: 'docs',
    },
    {
        id: 'file:marketing',
        kind: 'file',
        label: 'Marketing-Ideas.md',
        path: 'D:\\project\\Marketing-Ideas.md',
        relativePath: 'Marketing-Ideas.md',
    },
];

describe('fileMentionUtils', () => {
    describe('findFileMentionTrigger', () => {
        it('detects file mentions at the beginning and after whitespace', () => {
            expect(findFileMentionTrigger('@plan', 5)).toEqual({
                start: 0,
                end: 5,
                query: 'plan',
            });
            expect(findFileMentionTrigger('see @plan', 9)).toEqual({
                start: 4,
                end: 9,
                query: 'plan',
            });
        });

        it('ignores email-like text and completed mentions', () => {
            expect(findFileMentionTrigger('me@example.com', 14)).toBeNull();
            expect(findFileMentionTrigger('@plan next', 10)).toBeNull();
        });
    });

    describe('filterFileMentionOptions', () => {
        it('matches labels and paths with separator-insensitive search', () => {
            expect(filterFileMentionOptions(files, 'marketingideas').map(file => file.label)).toEqual([
                'Marketing-Ideas.md',
            ]);
            expect(filterFileMentionOptions(files, 'docs plan').map(file => file.label)).toEqual([
                'plan.md',
            ]);
            expect(filterFileMentionOptions(files, 'docs').map(file => file.label)).toEqual([
                'plan.md',
                'docs',
            ]);
        });
    });

    it('extracts a label from windows or posix paths', () => {
        expect(getFileMentionLabel('D:\\project\\plan.md')).toBe('plan.md');
        expect(getFileMentionLabel('/tmp/report.pdf')).toBe('report.pdf');
    });
});
