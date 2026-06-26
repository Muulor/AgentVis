/**
 * DependencyInstaller 单元测试
 *
 * 验证：
 * - 网络错误检测
 * - npm 包安装流程（幂等 + 错误处理）
 * - 系统工具安装流程（包管理器检测 + 安装 + 验证）
 * - Windows 安装命令构建
 */

import { describe, it, expect, vi } from 'vitest';
import {
    isNetworkRelatedError,
    isCommandAvailable,
    detectWindowsPackageManager,
    installNpmPackage,
    installSystemTool,
    isChromeForTestingInstallFailure,
} from '../DependencyInstaller';
import type { ShellExecutor } from '../DependencyInstaller';
import type { SystemToolInfo } from '../DependencyAnalyzer';

// ═══════════════════════════════════════════════════════════════
// Mock 工具
// ═══════════════════════════════════════════════════════════════

/** 创建模拟 ShellExecutor */
function createMockShell(
    responses: Record<string, { exitCode: number; stdout: string; stderr: string }>
): ShellExecutor {
    return vi.fn(async (params) => {
        // 按命令前缀匹配
        for (const [pattern, result] of Object.entries(responses)) {
            if (params.command.includes(pattern)) {
                return result;
            }
        }
        // 默认：命令不存在
            return { exitCode: 1, stdout: '', stderr: `command not found: ${String(params.command)}` };
    });
}

// ═══════════════════════════════════════════════════════════════
// isNetworkRelatedError
// ═══════════════════════════════════════════════════════════════

describe('isNetworkRelatedError', () => {
    it('应该检测 npm 网络错误', () => {
        expect(isNetworkRelatedError('npm ERR! network request failed')).toBe(true);
        expect(isNetworkRelatedError('npm ERR! code ENOTFOUND')).toBe(true);
        expect(isNetworkRelatedError('npm ERR! fetch failed')).toBe(true);
    });

    it('应该检测通用网络错误', () => {
        expect(isNetworkRelatedError('ETIMEDOUT: connection timed out')).toBe(true);
        expect(isNetworkRelatedError('ECONNREFUSED: connection refused')).toBe(true);
        expect(isNetworkRelatedError('ECONNRESET by peer')).toBe(true);
    });

    it('应该检测 SSL 错误', () => {
        expect(isNetworkRelatedError('SSL connection error')).toBe(true);
        expect(isNetworkRelatedError('CERT_HAS_EXPIRED')).toBe(true);
    });

    it('应该检测代理错误', () => {
        expect(isNetworkRelatedError('proxy authentication required')).toBe(true);
    });

    it('非网络错误应返回 false', () => {
        expect(isNetworkRelatedError('permission denied')).toBe(false);
        expect(isNetworkRelatedError('file not found')).toBe(false);
        expect(isNetworkRelatedError('syntax error')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// isChromeForTestingInstallFailure
// ═══════════════════════════════════════════════════════════════

describe('isChromeForTestingInstallFailure', () => {
    it('detects agent-browser Chrome for Testing metadata failures', () => {
        const output = 'Failed to fetch version info: error sending request for url (https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json)';

        expect(isChromeForTestingInstallFailure('agent-browser install', output)).toBe(true);
    });

    it('treats generic network errors from agent-browser install as Chrome for Testing failures', () => {
        expect(isChromeForTestingInstallFailure('agent-browser install', 'ETIMEDOUT')).toBe(true);
    });

    it('does not classify unrelated commands as Chrome for Testing install failures', () => {
        const output = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

        expect(isChromeForTestingInstallFailure('npm install -g agent-browser', output)).toBe(false);
        expect(isChromeForTestingInstallFailure('agent-browser doctor', output)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// isCommandAvailable
// ═══════════════════════════════════════════════════════════════

describe('isCommandAvailable', () => {
    it('命令存在时应返回 true', async () => {
        const shell = createMockShell({
            // 同时覆盖 Windows（where）和 Unix（which），
            // 应对不同测试环境（jsdom vs Tauri）中 isWindowsPlatform() 的不同返回值
            'where ffmpeg': { exitCode: 0, stdout: 'C:\\tools\\ffmpeg.exe', stderr: '' },
            'which ffmpeg': { exitCode: 0, stdout: '/usr/bin/ffmpeg', stderr: '' },
        });
        const result = await isCommandAvailable('ffmpeg', shell);
        expect(result).toBe(true);
    });

    it('命令不存在时应返回 false', async () => {
        const shell = createMockShell({});
        const result = await isCommandAvailable('nonexistent', shell);
        expect(result).toBe(false);
    });

    it('shell 抛异常时应返回 false', async () => {
        const shell: ShellExecutor = vi.fn(async () => {
            throw new Error('IPC error');
        });
        const result = await isCommandAvailable('any', shell);
        expect(result).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// detectWindowsPackageManager
// ═══════════════════════════════════════════════════════════════

describe('detectWindowsPackageManager', () => {
    it('scoop 可用时应返回 scoop', async () => {
        const shell = createMockShell({
            'scoop --version': { exitCode: 0, stdout: 'v0.4.0', stderr: '' },
        });
        const result = await detectWindowsPackageManager(shell);
        expect(result?.name).toBe('scoop');
    });

    it('仅 winget 可用时应返回 winget', async () => {
        const shell = createMockShell({
            'winget --version': { exitCode: 0, stdout: 'v1.8', stderr: '' },
        });
        const result = await detectWindowsPackageManager(shell);
        expect(result?.name).toBe('winget');
    });

    it('无包管理器时应返回 null', async () => {
        const shell = createMockShell({});
        const result = await detectWindowsPackageManager(shell);
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════
// installNpmPackage
// ═══════════════════════════════════════════════════════════════

describe('installNpmPackage', () => {
    it('npm 不可用时应返回友好错误', async () => {
        const shell = createMockShell({});
        const result = await installNpmPackage('pptxgenjs', shell);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Node.js');
    });

    it('包已安装时应返回成功（幂等）', async () => {
        const shell = createMockShell({
            'where npm': { exitCode: 0, stdout: 'C:\\npm.cmd', stderr: '' },
            'which npm': { exitCode: 0, stdout: '/usr/bin/npm', stderr: '' },
            'npm list -g pptxgenjs': { exitCode: 0, stdout: 'pptxgenjs@1.0.0', stderr: '' },
        });
        const result = await installNpmPackage('pptxgenjs', shell);
        expect(result.success).toBe(true);
        expect(result.message).toContain('already installed');
    });

    it('安装成功时应返回成功', async () => {
        const shell = createMockShell({
            'where npm': { exitCode: 0, stdout: 'C:\\npm.cmd', stderr: '' },
            'which npm': { exitCode: 0, stdout: '/usr/bin/npm', stderr: '' },
            'npm install -g pptxgenjs': { exitCode: 0, stdout: 'added 1 package', stderr: '' },
        });
        const result = await installNpmPackage('pptxgenjs', shell);
        expect(result.success).toBe(true);
        expect(result.message).toContain('installed successfully');
    });

    it('网络错误时应标记为可重试', async () => {
        const shell = createMockShell({
            'where npm': { exitCode: 0, stdout: 'C:\\npm.cmd', stderr: '' },
            'which npm': { exitCode: 0, stdout: '/usr/bin/npm', stderr: '' },
            'npm install -g': { exitCode: 1, stdout: '', stderr: 'npm ERR! network request failed' },
        });
        const result = await installNpmPackage('pptxgenjs', shell);
        expect(result.success).toBe(false);
        expect(result.isNetworkError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// installSystemTool
// ═══════════════════════════════════════════════════════════════

describe('installSystemTool', () => {
    const popplerTool: SystemToolInfo = {
        command: 'pdfimages',
        packageName: 'Poppler',
        windowsInstall: 'scoop install poppler',
        macInstall: 'brew install poppler',
        linuxInstall: 'sudo apt install poppler-utils',
    };

    it('工具已安装时应返回成功（幂等）', async () => {
        const shell = createMockShell({
            'where pdfimages': { exitCode: 0, stdout: 'C:\\tools\\pdfimages.exe', stderr: '' },
            'which pdfimages': { exitCode: 0, stdout: '/usr/bin/pdfimages', stderr: '' },
        });
        const result = await installSystemTool(popplerTool, 'windows', shell);
        expect(result.success).toBe(true);
        expect(result.message).toContain('already installed');
    });

    it('Windows 无包管理器时应返回友好错误', async () => {
        const shell = createMockShell({});
        const result = await installSystemTool(popplerTool, 'windows', shell);
        expect(result.success).toBe(false);
        expect(result.message).toContain('scoop');
    });

    it('macOS 无 brew 时应返回友好错误', async () => {
        const shell = createMockShell({});
        const result = await installSystemTool(popplerTool, 'mac', shell);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Homebrew');
    });

    it('安装成功且验证通过时应返回成功', async () => {
        const callCount = { where: 0 };
        const shell: ShellExecutor = vi.fn(async (params) => {
            if (params.command.includes('where pdfimages')) {
                callCount.where++;
                // 第 1 次检测：未安装；第 2 次检测（验证）：已安装
                if (callCount.where === 1) {
                    return { exitCode: 1, stdout: '', stderr: 'not found' };
                }
                return { exitCode: 0, stdout: 'C:\\tools\\pdfimages.exe', stderr: '' };
            }
            if (params.command.includes('scoop --version')) {
                return { exitCode: 0, stdout: 'v0.4.0', stderr: '' };
            }
            if (params.command.includes('scoop install')) {
                return { exitCode: 0, stdout: 'installed poppler', stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: 'not found' };
        });

        const result = await installSystemTool(popplerTool, 'windows', shell);
        expect(result.success).toBe(true);
        expect(result.message).toContain('installed successfully');
    });

    it('网络错误时应标记为可重试', async () => {
        const shell: ShellExecutor = vi.fn(async (params) => {
            if (params.command.includes('where pdfimages')) {
                return { exitCode: 1, stdout: '', stderr: 'not found' };
            }
            if (params.command.includes('scoop --version')) {
                return { exitCode: 0, stdout: 'v0.4.0', stderr: '' };
            }
            if (params.command.includes('scoop install')) {
                return { exitCode: 1, stdout: '', stderr: 'Could not resolve host: github.com' };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
        });

        const result = await installSystemTool(popplerTool, 'windows', shell);
        expect(result.success).toBe(false);
        expect(result.isNetworkError).toBe(true);
    });

    it('Linux 应直接使用 apt 命令', async () => {
        let pdfimagesCheckCount = 0;
        const shell: ShellExecutor = vi.fn(async (params) => {
            // isCommandAvailable 检测 pdfimages
            if (params.command.includes('pdfimages') && !params.command.includes('apt')) {
                pdfimagesCheckCount++;
                // 第 1 次：安装前检测 → 未安装
                // 第 2 次：安装后验证 → 已安装
                if (pdfimagesCheckCount === 1) {
                    return { exitCode: 1, stdout: '', stderr: '' };
                }
                return { exitCode: 0, stdout: '/usr/bin/pdfimages', stderr: '' };
            }
            if (params.command.includes('sudo apt install')) {
                return { exitCode: 0, stdout: 'installed', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });

        const result = await installSystemTool(popplerTool, 'linux', shell);
        expect(result.success).toBe(true);
        // 验证使用了 apt 命令
        expect(shell).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'sudo apt install poppler-utils',
            })
        );
    });

    it('winget 返回非零 exit code 但表示已安装时应返回成功', async () => {
        const shell: ShellExecutor = vi.fn(async (params) => {
            if (params.command.includes('pdfimages') && !params.command.includes('winget')) {
                return { exitCode: 1, stdout: '', stderr: '' };
            }
            if (params.command.includes('scoop --version')) {
                return { exitCode: 1, stdout: '', stderr: '' };
            }
            if (params.command.includes('winget --version')) {
                return { exitCode: 0, stdout: 'v1.12', stderr: '' };
            }
            if (params.command.includes('winget install')) {
                return {
                    exitCode: -1978335189,
                    stdout: 'No available upgrade found.\nPackage already installed.',
                    stderr: '',
                };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
        });

        const result = await installSystemTool(popplerTool, 'windows', shell);
        expect(result.success).toBe(true);
        expect(result.message).toContain('already installed');
    });

    it('安装成功但 PATH 未刷新时仍应返回成功', async () => {
        const shell: ShellExecutor = vi.fn(async (params) => {
            // isCommandAvailable 和 isCommandAvailableWithFreshPath 都返回找不到
            if (params.command.includes('pdfimages')) {
                return { exitCode: 1, stdout: '', stderr: 'not found' };
            }
            if (params.command.includes('scoop --version')) {
                return { exitCode: 0, stdout: 'v0.4.0', stderr: '' };
            }
            if (params.command.includes('scoop install')) {
                return { exitCode: 0, stdout: 'installed', stderr: '' };
            }
            if (params.command.includes('powershell')) {
                // 刷新 PATH 后仍然找不到（极端情况）
                return { exitCode: 1, stdout: '', stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
        });

        const result = await installSystemTool(popplerTool, 'windows', shell);
        // 安装命令本身成功 → 应返回 success: true
        expect(result.success).toBe(true);
        expect(result.message).toContain('restart the app');
    });
});
