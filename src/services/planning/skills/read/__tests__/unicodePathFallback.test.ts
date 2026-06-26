/**
 * read 工具 Unicode 视觉路径回退测试
 */

import { describe, expect, it } from 'vitest';
import {
    createVisualPathMatchKey,
    findUniqueVisualSiblingPath,
} from '../tool';

describe('createVisualPathMatchKey', () => {
    it('应将 ASCII 撇号、Unicode 右单引号和 \\u 转义视为同一视觉路径键', () => {
        expect(createVisualPathMatchKey("They're Hiding.md")).toBe(
            createVisualPathMatchKey('They’re Hiding.md')
        );
        expect(createVisualPathMatchKey('They\\u2019re Hiding.md')).toBe(
            createVisualPathMatchKey('They’re Hiding.md')
        );
    });
});

describe('findUniqueVisualSiblingPath', () => {
    const requestedPath = "C:\\Users\\Admin\\output\\AI Whistleblower_ They're Hiding.md";
    const actualName = 'AI Whistleblower_ They’re Hiding.md';

    it('应返回同目录下唯一的智能引号等价文件路径', () => {
        expect(findUniqueVisualSiblingPath(requestedPath, [actualName])).toBe(
            'C:\\Users\\Admin\\output\\AI Whistleblower_ They’re Hiding.md'
        );
    });

    it('请求路径包含字面 \\u2019 时也应能匹配真实文件名', () => {
        const escapedPath = 'C:\\Users\\Admin\\output\\AI Whistleblower_ They\\u2019re Hiding.md';
        expect(findUniqueVisualSiblingPath(escapedPath, [actualName])).toBe(
            'C:\\Users\\Admin\\output\\AI Whistleblower_ They’re Hiding.md'
        );
    });

    it('多个视觉等价候选时不应自动选择', () => {
        expect(findUniqueVisualSiblingPath(requestedPath, [
            actualName,
            'AI Whistleblower_ They‘re Hiding.md',
        ])).toBeNull();
    });
});
