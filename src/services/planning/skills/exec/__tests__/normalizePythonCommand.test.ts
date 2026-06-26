/**
 * normalizePythonCommand 路径规范化 — 单元测试
 *
 * 覆盖场景：
 * 1. 裸 python/python3 → venv 路径替换
 * 2. 带 .exe 后缀的变体
 * 3. 带引号的变体
 * 4. 已包含完整路径的命令不替换
 * 5. 非 python 开头的命令不替换
 * 6. 边界情况（空命令、仅 python 无参数等）
 */

import { describe, it, expect } from 'vitest';
import { normalizePythonCommand } from '../tool';

const VENV_PATH = 'C:\\Users\\Admin\\AppData\\Roaming\\com.agentvis.app\\runtime\\venv\\Scripts\\python.exe';

describe('normalizePythonCommand', () => {
    // ── 基本替换 ──

    it('应将裸 python + 脚本 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });

    it('应将裸 python3 + 脚本 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python3 script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });

    it('应将 python -m module 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python -m pytest tests/', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" -m pytest tests/`);
    });

    it('应将 python3 -m module 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python3 -m http.server 8000', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" -m http.server 8000`);
    });

    // ── .exe 后缀变体 ──

    it('应将 python.exe 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python.exe script.py args', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py args`);
    });

    it('应将 python3.exe 替换为 venv 路径', () => {
        const result = normalizePythonCommand('python3.exe -c "print(1)"', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" -c "print(1)"`);
    });

    // ── 带引号的变体 ──

    it('应将 "python" 带双引号变体 替换为 venv 路径', () => {
        const result = normalizePythonCommand('"python" script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });

    it('应将 "python3" 带双引号变体 替换为 venv 路径', () => {
        const result = normalizePythonCommand('"python3" script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });

    // ── 不应替换的情况 ──

    it('已包含完整路径的 python 命令不应替换', () => {
        const fullPathCmd = `"C:\\Python39\\python.exe" script.py`;
        const result = normalizePythonCommand(fullPathCmd, VENV_PATH);
        expect(result).toBe(fullPathCmd);
    });

    it('venv 完整路径的 python 命令不应替换', () => {
        const fullPathCmd = `"${VENV_PATH}" script.py`;
        const result = normalizePythonCommand(fullPathCmd, VENV_PATH);
        expect(result).toBe(fullPathCmd);
    });

    it('非 python 开头的命令不应替换', () => {
        const cmd = 'npm run python-lint';
        const result = normalizePythonCommand(cmd, VENV_PATH);
        expect(result).toBe(cmd);
    });

    it('pip 命令不应替换', () => {
        const cmd = 'pip install requests';
        const result = normalizePythonCommand(cmd, VENV_PATH);
        expect(result).toBe(cmd);
    });

    it('node 命令不应替换', () => {
        const cmd = 'node script.js';
        const result = normalizePythonCommand(cmd, VENV_PATH);
        expect(result).toBe(cmd);
    });

    it('powershell 命令中的 python 子串不应替换', () => {
        const cmd = 'powershell -Command "python script.py"';
        const result = normalizePythonCommand(cmd, VENV_PATH);
        expect(result).toBe(cmd);
    });

    // ── 边界情况 ──

    it('空命令应返回原样', () => {
        expect(normalizePythonCommand('', VENV_PATH)).toBe('');
    });

    it('venvPythonPath 为空应返回原命令', () => {
        expect(normalizePythonCommand('python script.py', '')).toBe('python script.py');
    });

    it('仅 python 无参数应替换', () => {
        const result = normalizePythonCommand('python', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}"`);
    });

    // ── 带长路径的技能包脚本 ──

    it('应正确替换技能包脚本的完整命令', () => {
        const cmd = "python \"C:/Users/Admin/AppData/Roaming/com.agentvis.app/skills/external/packages/yahoo-finance/yf.py\" fundamentals 7453.T";
        const result = normalizePythonCommand(cmd, VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" "C:/Users/Admin/AppData/Roaming/com.agentvis.app/skills/external/packages/yahoo-finance/yf.py" fundamentals 7453.T`);
    });

    // ── 大小写不敏感 ──

    it('应处理 Python 大写变体', () => {
        const result = normalizePythonCommand('Python script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });

    it('应处理 PYTHON 全大写变体', () => {
        const result = normalizePythonCommand('PYTHON script.py', VENV_PATH);
        expect(result).toBe(`"${VENV_PATH}" script.py`);
    });
});
