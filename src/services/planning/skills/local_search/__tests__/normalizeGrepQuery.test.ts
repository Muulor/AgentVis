/**
 * normalizeGrepQuery + sanitizeRegexBraces — 单元测试
 *
 * 覆盖场景：
 * 1. 包含 | 管道符的 query 应自动提升 isRegex
 * 2. 包含正则转义序列（\d, \w 等）的 query 应自动提升
 * 3. 包含捕获组 (...) 的 query 应自动提升
 * 4. 已显式 isRegex=true 不干预
 * 5. 不含正则元字符的普通文本不干预
 * 6. 含 * + . 等高误判率字符不自动提升
 * 7. Rust regex 花括号兼容 — 裸 { 自动转义
 * 8. 合法量词花括号 {n}, {n,m} 保留
 */

import { describe, it, expect } from 'vitest';
import { normalizeGrepQuery, sanitizeRegexBraces } from '../tool';

describe('normalizeGrepQuery', () => {
  it('包含 | 管道符应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('foo|bar', false);
    expect(result.normalizedIsRegex).toBe(true);
    expect(result.normalizedQuery).toBe('foo|bar');
  });

  it('包含多个 | 应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('mixer|channel|vu-meter', undefined);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('包含 \\d 正则转义应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('\\d+', false);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('包含 \\w 正则转义应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('\\w+_handler', undefined);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('包含 \\s 正则转义应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('key\\s*=', false);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('包含 \\b 词边界应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('\\bfoo\\b', undefined);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('包含捕获组 (...) 应自动提升 isRegex', () => {
    const result = normalizeGrepQuery('(foo|bar)', false);
    expect(result.normalizedIsRegex).toBe(true);
  });

  it('已显式 isRegex=true 不应修改 isRegex', () => {
    const result = normalizeGrepQuery('foo|bar', true);
    expect(result.normalizedIsRegex).toBe(true);
    expect(result.normalizedQuery).toBe('foo|bar');
  });

  it('普通文本搜索（无正则元字符）不应提升', () => {
    const result = normalizeGrepQuery('handleClick', false);
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('包含 . 的文本不应自动提升（误判率高）', () => {
    const result = normalizeGrepQuery('file.txt', false);
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('包含 * 的文本不应自动提升（文件名中常见）', () => {
    const result = normalizeGrepQuery('*.css', undefined);
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('包含 + 的文本不应自动提升', () => {
    const result = normalizeGrepQuery('count+1', false);
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('空 query 应返回原样', () => {
    const result = normalizeGrepQuery('', false);
    expect(result.normalizedQuery).toBe('');
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('空 query + undefined isRegex 应返回 false', () => {
    const result = normalizeGrepQuery('', undefined);
    expect(result.normalizedIsRegex).toBe(false);
  });

  it('isRegex 为 undefined 且无正则元字符应默认 false', () => {
    const result = normalizeGrepQuery('normalText', undefined);
    expect(result.normalizedIsRegex).toBe(false);
  });

  // ==================== 花括号兼容测试 ====================

  it('【真实 log 复现】CSS 选择器正则中的裸 { 应被转义', () => {
    // 来自真实 SA 执行日志的失败命令
    const result = normalizeGrepQuery('^\\.clip\\s*{|^\\.audio-clip\\s*{', true);
    expect(result.normalizedIsRegex).toBe(true);
    // 裸 { 应被转义为 \{
    expect(result.normalizedQuery).toBe('^\\.clip\\s*\\{|^\\.audio-clip\\s*\\{');
  });

  it('自动提升时也应修正裸花括号', () => {
    // | 触发自动提升，同时 { 需要转义
    const result = normalizeGrepQuery('.foo{|.bar{', false);
    expect(result.normalizedIsRegex).toBe(true);
    expect(result.normalizedQuery).toBe('.foo\\{|.bar\\{');
  });

  it('合法量词 {3} 应保留不转义', () => {
    const result = normalizeGrepQuery('a{3}|b{2,5}', true);
    expect(result.normalizedQuery).toBe('a{3}|b{2,5}');
  });
});

describe('sanitizeRegexBraces', () => {
  it('应转义孤立的 { 为 \\{', () => {
    expect(sanitizeRegexBraces('\\s*{')).toBe('\\s*\\{');
  });

  it('应保留合法量词 {n}', () => {
    expect(sanitizeRegexBraces('a{3}')).toBe('a{3}');
  });

  it('应保留合法量词 {n,}', () => {
    expect(sanitizeRegexBraces('a{2,}')).toBe('a{2,}');
  });

  it('应保留合法量词 {n,m}', () => {
    expect(sanitizeRegexBraces('a{1,5}')).toBe('a{1,5}');
  });

  it('应转义非量词的 {xxx} 对', () => {
    // { 后面不是数字，不是合法量词，{ 被转义，} 保持不变（Rust regex 中 } 单独安全）
    expect(sanitizeRegexBraces('color: {red}')).toBe('color: \\{red}');
  });

  it('混合场景：量词保留 + 裸花括号转义', () => {
    expect(sanitizeRegexBraces('.foo{|a{3}')).toBe('.foo\\{|a{3}');
  });

  it('多个孤立 { 应全部转义', () => {
    expect(sanitizeRegexBraces('{|{|{')).toBe('\\{|\\{|\\{');
  });

  it('空字符串应返回原样', () => {
    expect(sanitizeRegexBraces('')).toBe('');
  });

  it('无花括号的正则应返回原样', () => {
    expect(sanitizeRegexBraces('foo|bar')).toBe('foo|bar');
  });
});
