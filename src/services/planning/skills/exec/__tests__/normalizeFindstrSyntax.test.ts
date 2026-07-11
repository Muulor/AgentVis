/**
 * normalizeFindstrSyntax — 单元测试
 *
 * 覆盖场景：
 * 1. findstr 中 grep 风格 \| OR 语法转成空格分隔
 * 2. 真实 log 复现的失败命令
 * 3. 非 findstr 命令不干预
 * 4. findstr /r 正则模式不干预
 * 5. 已正确使用空格分隔的命令不干预
 */

import { describe, it, expect } from 'vitest';
import { normalizeFindstrSyntax } from '../tool';

describe('normalizeFindstrSyntax', () => {
  it('【真实 log 复现】应修正 grep 风格 \\| 为空格分隔', () => {
    // 经过 normalizeWindowsQuotes 处理后引号已为双引号
    const input = 'findstr /n "mixer\\|channel\\|vu-meter" "C:\\Users\\Admin\\main.css"';
    const result = normalizeFindstrSyntax(input);
    expect(result).toBe('findstr /n "mixer channel vu-meter" "C:\\Users\\Admin\\main.css"');
  });

  it('应处理两个模式的 \\| 分隔', () => {
    const input = 'findstr "foo\\|bar" file.txt';
    const result = normalizeFindstrSyntax(input);
    expect(result).toBe('findstr "foo bar" file.txt');
  });

  it('不包含 \\| 的 findstr 命令不应修改', () => {
    const input = 'findstr /n "mixer" "file.css"';
    expect(normalizeFindstrSyntax(input)).toBe(input);
  });

  it('已使用空格分隔的 findstr 命令不应修改', () => {
    const input = 'findstr /n "mixer channel vu-meter" "file.css"';
    expect(normalizeFindstrSyntax(input)).toBe(input);
  });

  it('非 findstr 命令不应修改', () => {
    const input = 'echo "foo\\|bar"';
    expect(normalizeFindstrSyntax(input)).toBe(input);
  });

  it('findstr /r 正则模式不应修改', () => {
    // /r 模式下 \| 可能有特殊含义，不干预
    const input = 'findstr /r /n "pattern\\|other" file.txt';
    expect(normalizeFindstrSyntax(input)).toBe(input);
  });

  it('空命令应返回原样', () => {
    expect(normalizeFindstrSyntax('')).toBe('');
  });

  it('大小写不敏感匹配 FINDSTR', () => {
    const input = 'FINDSTR "foo\\|bar" file.txt';
    const result = normalizeFindstrSyntax(input);
    expect(result).toBe('FINDSTR "foo bar" file.txt');
  });

  it('文件路径参数中的反斜杠不应被修改', () => {
    // 路径中的 \\ 不包含 \|，不会被匹配
    const input = 'findstr "mixer\\|channel" "C:\\Users\\Admin\\file.css"';
    const result = normalizeFindstrSyntax(input);
    // 搜索模式中的 \| 被替换，路径不受影响
    expect(result).toBe('findstr "mixer channel" "C:\\Users\\Admin\\file.css"');
  });
});
