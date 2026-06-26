/**
 * generateWindowsCommandHint — 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
    generateExecTimeoutGuidance,
    generateFileReadPathFailureHint,
    generateMojibakeHint,
    generateWindowsCommandHint,
} from '../tool';

describe('generateWindowsCommandHint', () => {
    it('【真实 log 复现】head 命令应返回 Select-Object 提示', () => {
        const stderr = "'head' is not recognized as an internal or external command,\noperable program or batch file.";
        const hint = generateWindowsCommandHint(stderr, 'dir /B | head -1');
        expect(hint).toContain('head');
        expect(hint).toContain('Select-Object -First N');
    });

    it('grep 命令应返回 findstr 或 Select-String 提示', () => {
        const stderr = "'grep' is not recognized as an internal or external command,\noperable program or batch file.";
        const hint = generateWindowsCommandHint(stderr, 'grep "pattern" file.txt');
        expect(hint).toContain('findstr');
        expect(hint).toContain('Select-String');
    });

    it('未在映射表中的 Linux 命令应返回通用兜底提示', () => {
        const stderr = "'htop' is not recognized as an internal or external command,\noperable program or batch file.";
        const hint = generateWindowsCommandHint(stderr, 'htop');
        expect(hint).toContain('htop');
        expect(hint).toContain('Windows');
        expect(hint).toContain('PowerShell');
    });

    it('非 "not recognized" 的错误不应返回提示', () => {
        const stderr = 'File Not Found';
        const hint = generateWindowsCommandHint(stderr, 'dir nonexistent.txt');
        expect(hint).toBeNull();
    });

    it('空 stderr 不应返回提示', () => {
        expect(generateWindowsCommandHint('', 'dir')).toBeNull();
    });

    it('cat 命令应返回 type 提示', () => {
        const stderr = "'cat' is not recognized as an internal or external command,\noperable program or batch file.";
        const hint = generateWindowsCommandHint(stderr, 'cat file.txt');
        expect(hint).toContain('type');
    });

    it('which 命令应返回 where 提示', () => {
        const stderr = "'which' is not recognized as an internal or external command,\noperable program or batch file.";
        const hint = generateWindowsCommandHint(stderr, 'which python');
        expect(hint).toContain('where');
    });
});

describe('generateFileReadPathFailureHint', () => {
    it('type 读取特殊路径失败时应提示优先使用 read 或动态定位路径', () => {
        const command = 'type "C:\\Users\\Muulo\\output\\AI Whistleblower_ They’re Hiding.md"';
        const hint = generateFileReadPathFailureHint(command, 'The system cannot find the file specified.');
        expect(hint).toContain('read');
        expect(hint).toContain('Get-ChildItem');
    });

    it('PowerShell Get-Content 直接路径失败时应提示动态定位路径', () => {
        const command = 'powershell -NoProfile -Command "Get-Content -LiteralPath \'C:\\Users\\Muulo\\output\\They\'\'re.md\'"';
        const hint = generateFileReadPathFailureHint(command, 'Get-Content : An object at the specified path does not exist, or has been filtered by the -Include or -Exclude parameter.');
        expect(hint).toContain('Get-ChildItem');
    });

    it('非文件读取命令失败时不应返回提示', () => {
        expect(generateFileReadPathFailureHint('npm test', 'The system cannot find the file specified.')).toBeNull();
    });
});

describe('generateMojibakeHint', () => {
    it('Get-Content 输出疑似 mojibake 时应提示 UTF-8 读取', () => {
        const command = 'powershell -NoProfile -Command "Get-ChildItem -Filter \'*.md\' | Get-Content -TotalCount 5"';
        const hint = generateMojibakeHint(command, 'They鈥檙e Hiding The Truth!');
        expect(hint).toContain('UTF-8');
    });

    it('普通输出不应返回编码提示', () => {
        const command = 'powershell -NoProfile -Command "Get-Content file.txt"';
        expect(generateMojibakeHint(command, 'normal output')).toBeNull();
    });
});

describe('generateExecTimeoutGuidance', () => {
    it('cargo test 超时时应提示先缩小测试并区分编译与运行卡住', () => {
        const hint = generateExecTimeoutGuidance(
            'cargo test -p daw-engine -- mixer',
            'Command execution timed out after 300 seconds'
        );

        expect(hint).toContain('cargo test');
        expect(hint).toContain('-- --list');
        expect(hint).toContain('--exact --nocapture');
        expect(hint).toContain('--no-run');
    });

    it('非 cargo test 超时时应返回通用 timeout 排查提示', () => {
        const hint = generateExecTimeoutGuidance('npm test', 'execution timed out');

        expect(hint).toContain('timeout');
        expect(hint).toContain('详细输出');
        expect(hint).not.toContain('-- --list');
    });

    it('非超时输出不应返回提示', () => {
        expect(generateExecTimeoutGuidance('cargo test', 'test failed')).toBeNull();
    });
});
