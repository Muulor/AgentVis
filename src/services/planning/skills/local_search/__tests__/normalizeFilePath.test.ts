/**
 * normalizeFilePath + getUnsupportedLanguageHint — 单元测试
 *
 * 覆盖场景：
 * 1. normalizeFilePath: Git Bash 风格路径修正
 * 2. normalizeFilePath: 已正确路径不干预
 * 3. getUnsupportedLanguageHint: 支持的扩展名返回 null
 * 4. getUnsupportedLanguageHint: 不支持的扩展名返回提示
 * 5. getUnsupportedLanguageHint: 无扩展名的文件返回提示
 */

import { describe, it, expect } from 'vitest';
import { normalizeFilePath, getUnsupportedLanguageHint } from '../tool';

describe('normalizeFilePath', () => {
  it('应修正 Git Bash 风格 /f/ 为 f:/', () => {
    expect(normalizeFilePath('/f/AgentVis/src/App.tsx')).toBe('f:/AgentVis/src/App.tsx');
  });

  it('应修正 Git Bash 风格 /c/ 为 c:/', () => {
    expect(normalizeFilePath('/c/Users/Admin/Desktop')).toBe('c:/Users/Admin/Desktop');
  });

  it('应修正大写盘符 /F/', () => {
    expect(normalizeFilePath('/F/project/src')).toBe('F:/project/src');
  });

  it('已是 Windows 绝对路径（反斜杠）不应修改', () => {
    const path = 'f:\\AgentVis\\src\\App.tsx';
    expect(normalizeFilePath(path)).toBe(path);
  });

  it('已是 Windows 绝对路径（正斜杠）不应修改', () => {
    const path = 'f:/AgentVis/src/App.tsx';
    expect(normalizeFilePath(path)).toBe(path);
  });

  it('相对路径不应修改', () => {
    expect(normalizeFilePath('src/App.tsx')).toBe('src/App.tsx');
  });

  it('以 ./ 开头的相对路径不应修改', () => {
    expect(normalizeFilePath('./src/App.tsx')).toBe('./src/App.tsx');
  });

  it('非盘符的 Linux 绝对路径不应修改', () => {
    // /usr 不是单字母后跟 /，不匹配盘符模式
    expect(normalizeFilePath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('空路径应返回原样', () => {
    expect(normalizeFilePath('')).toBe('');
  });

  it('仅盘符 /f 不应修改（缺少后续路径分隔符）', () => {
    // /f 不匹配 /X/... 模式（需要后跟 /）
    expect(normalizeFilePath('/f')).toBe('/f');
  });
});

describe('getUnsupportedLanguageHint', () => {
  it('支持的 .ts 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/App.ts')).toBeNull();
  });

  it('支持的 .tsx 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/App.tsx')).toBeNull();
  });

  it('支持的 .py 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/main.py')).toBeNull();
  });

  it('支持的 .rs 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/lib.rs')).toBeNull();
  });

  it('支持的 .css 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/styles.css')).toBeNull();
  });

  it('支持的 .json 扩展名应返回 null', () => {
    expect(getUnsupportedLanguageHint('f:/project/package.json')).toBeNull();
  });

  it('不支持的 .md 扩展名应返回提示', () => {
    const hint = getUnsupportedLanguageHint('f:/project/README.md');
    expect(hint).not.toBeNull();
    expect(hint).toContain('.md');
    expect(hint).toContain('支持');
  });

  it('不支持的 .yaml 扩展名应返回提示', () => {
    const hint = getUnsupportedLanguageHint('f:/project/config.yaml');
    expect(hint).not.toBeNull();
    expect(hint).toContain('.yaml');
  });

  it('不支持的 .html 扩展名应返回提示', () => {
    const hint = getUnsupportedLanguageHint('f:/project/index.html');
    expect(hint).not.toBeNull();
    expect(hint).toContain('.html');
  });

  it('没有扩展名的文件应返回无扩展名提示', () => {
    const hint = getUnsupportedLanguageHint('f:/project/Makefile');
    expect(hint).not.toBeNull();
    expect(hint).toContain('扩展名');
  });

  it('扩展名大写应被正确识别（大小写不敏感）', () => {
    // .TS → ts，在支持列表中
    expect(getUnsupportedLanguageHint('f:/project/App.TS')).toBeNull();
  });
});
