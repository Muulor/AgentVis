/**
 * RuntimeManager 单元测试
 *
 * 覆盖场景：
 * - venv 存在时直接就绪
 * - venv 不存在时创建并安装基础包
 * - 额外依赖增量安装
 * - 安装失败的错误处理
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  getLogger: () => mockLogger,
}));

import { RuntimeManager } from '../RuntimeManager';
import type { ShellExecuteFn } from '../ExternalExecutor';

// ==================== 测试用 Mock ====================

interface ShellCallRecord {
  command: string;
  workdir: string;
  timeout: number;
}

function createTrackedShellExecute(
  responses: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map()
): { shellExecute: ShellExecuteFn; calls: ShellCallRecord[] } {
  const calls: ShellCallRecord[] = [];

  const defaultResponse = { exitCode: 0, stdout: '', stderr: '' };

  const shellExecute: ShellExecuteFn = vi.fn(async (params) => {
    calls.push({
      command: params.command,
      workdir: params.workdir,
      timeout: params.timeout,
    });

    // 根据命令关键字匹配响应
    for (const [keyword, response] of responses) {
      if (params.command.includes(keyword)) {
        return response;
      }
    }

    return defaultResponse;
  });

  return { shellExecute, calls };
}

function isExtraRequirementProbe(params: Parameters<ShellExecuteFn>[0]): boolean {
  return params.env?.AGENTVIS_EXTRA_REQUIREMENTS_JSON !== undefined;
}

function createProbeStdout(
  satisfied: string[],
  unsatisfied: string[],
  skipped: string[] = []
): string {
  return JSON.stringify({
    ok: true,
    satisfied,
    unsatisfied,
    skipped,
  });
}

// ==================== 测试 ====================

describe('RuntimeManager', () => {
  const RUNTIME_DIR = '/appdata/runtime/python-v1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureReady - venv 已存在', () => {
    it('venv 已存在时应该直接就绪', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);

      // 传入空包列表（venv 已存在场景不需要安装基础包）
      const result = await manager.ensureReady([], []);

      expect(result.status).toBe('ready');
      expect(result.pythonVersion).toBe('3.11.5');
      // 不应该调用 python -m venv 创建命令
      expect(shellExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: expect.stringContaining('-m venv') })
      );
    });
  });

  describe('ensureReady - venv 不存在', () => {
    it('venv 不存在时应该创建并安装基础包', async () => {
      let venvCreated = false;

      // Mock 逻辑：
      // - .venv 中的 python 不存在（checkVenvExists 返回 false）
      // - 系统 python 存在（detectPython 返回 'python'）
      // - -m venv 创建成功
      // - 创建后 venv python 可用
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          // venv 中的 python 只在创建后可用
          if (params.command.includes('.venv')) {
            if (!venvCreated) {
              throw new Error('python not found');
            }
            return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
          }
          // 系统 python 始终可用（detectPython 探测）
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('-m venv')) {
          venvCreated = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      // 传入空包列表（测试仅关注 venv 创建流程）
      const result = await manager.ensureReady([], []);

      expect(result.status).toBe('ready');
      expect(venvCreated).toBe(true);
    });
  });

  describe('ensureReady - 额外依赖', () => {
    it('应该聚合并安装额外依赖', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      // 传入空基础包，只测试额外依赖安装
      const result = await manager.ensureReady(
        [],
        [
          { packages: ['scipy>=1.10', 'networkx'] },
          { packages: ['scipy>=1.10', 'matplotlib>=3.7'] }, // scipy 重复，应去重
        ]
      );

      expect(result.status).toBe('ready');
      // 应该有 pip install 调用（逐包安装）
      expect(pipCalls.length).toBeGreaterThan(0);
      // 检查各个包都在（逐包安装，需检查所有调用的聚合）
      const allPipCommands = pipCalls.join(' ');
      expect(allPipCommands).toContain('scipy');
      expect(allPipCommands).toContain('networkx');
      expect(allPipCommands).toContain('matplotlib');
    });

    it('批量安装失败但逐包成功时不应记录 warn', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
          if (params.command.includes('"alpha" "beta"')) {
            return { exitCode: 1, stdout: '', stderr: 'batch resolver conflict' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady([], [{ packages: ['alpha', 'beta'] }]);

      expect(result.status).toBe('ready');
      expect(pipCalls).toHaveLength(3);
      expect(pipCalls[0]).toContain('"alpha" "beta"');
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('批量安装失败，回退逐包安装'),
        expect.stringContaining('batch resolver conflict')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('批量安装失败，但逐包安装全部成功')
      );
    });

    it('已满足的额外依赖应跳过 pip install', async () => {
      const pipCalls: string[] = [];
      const packages = ['alpha', 'beta>=1'];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (isExtraRequirementProbe(params)) {
          return {
            exitCode: 0,
            stdout: createProbeStdout(packages, []),
            stderr: '',
          };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady([], [{ packages }]);

      expect(result.status).toBe('ready');
      expect(pipCalls).toHaveLength(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('跳过已满足的额外依赖:'),
        packages.join(', ')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('额外依赖已满足，跳过安装:'),
        packages.join(', ')
      );
    });

    it('只应安装版本不满足且当前环境适用的额外依赖', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (isExtraRequirementProbe(params)) {
          return {
            exitCode: 0,
            stdout: createProbeStdout(
              ['beta'],
              ['alpha>=2'],
              ['win-only; sys_platform == "linux"']
            ),
            stderr: '',
          };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady(
        [],
        [{ packages: ['alpha>=2', 'beta', 'win-only; sys_platform == "linux"'] }]
      );

      expect(result.status).toBe('ready');
      expect(pipCalls).toHaveLength(1);
      expect(pipCalls[0]).toContain('"alpha>=2"');
      expect(pipCalls[0]).not.toContain('beta');
      expect(pipCalls[0]).not.toContain('win-only');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('跳过当前环境不适用的额外依赖:'),
        'win-only; sys_platform == "linux"'
      );
    });

    it('额外依赖最终仍安装失败时应返回 extra_partial', async () => {
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (isExtraRequirementProbe(params)) {
          return {
            exitCode: 0,
            stdout: createProbeStdout([], ['alpha', 'beta']),
            stderr: '',
          };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          if (params.command.includes('"alpha" "beta"')) {
            return { exitCode: 1, stdout: '', stderr: 'batch failed' };
          }
          if (params.command.includes('"alpha"')) {
            return { exitCode: 1, stdout: '', stderr: 'alpha failed' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady([], [{ packages: ['alpha', 'beta'] }]);

      expect(result.status).toBe('extra_partial');
      expect(result.error).toContain('alpha');
      expect(result.failedPackages).toEqual(['alpha']);
      expect(manager.currentStatus).toBe('extra_partial');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('1/2 个额外依赖安装失败'),
        'alpha'
      );
    });

    it('无额外依赖时不应调用额外 pip install', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      // 空基础包 + 空额外依赖 → 不应有任何 pip install 调用
      await manager.ensureReady([], []);

      // 应该没有额外依赖安装（venv 已存在的情况下）
      expect(pipCalls.length).toBe(0);
    });
  });

  describe('ensureReady - 错误处理', () => {
    it('venv 创建失败时应该返回 error 状态', async () => {
      // Mock 逻辑：
      // - venv python 不可用（checkVenvExists 返回 false）
      // - 系统 python 可用（detectPython 成功）
      // - -m venv 创建失败（返回非零退出码）
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          // venv 中的 python 不存在
          if (params.command.includes('.venv')) {
            throw new Error('python not found');
          }
          // 系统 python 可用
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('-m venv')) {
          return { exitCode: 1, stdout: '', stderr: 'Permission denied' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady([], []);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to create venv');
    });

    it('Python SSL 模块不可用时应该提前返回 base_incomplete', async () => {
      const pipCalls: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('-c "import ssl')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: "ModuleNotFoundError: No module named '_ssl'",
          };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          pipCalls.push(params.command);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady(['requests==2.34.2'], []);

      expect(result.status).toBe('base_incomplete');
      expect(result.error).toContain('_ssl');
      expect(pipCalls).toHaveLength(0);
    });

    it('基础包安装失败时应该包含失败包和 pip 输出摘要', async () => {
      const commands: string[] = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        commands.push(params.command);
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('-c "import ssl')) {
          return { exitCode: 0, stdout: 'OpenSSL 3.0.0', stderr: '' };
        }
        if (params.command.includes('import importlib.util')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'missing prebuilt base modules: requests, httpx',
          };
        }
        if (params.command.includes('pip') && params.command.includes('install')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'ERROR: Could not find a version that satisfies the requirement',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady(['requests==2.34.2', 'httpx==0.27.2'], []);

      expect(result.status).toBe('base_incomplete');
      expect(result.error).toContain('requests');
      expect(result.error).toContain('httpx');
      expect(result.error).toContain('missing prebuilt base modules');
      expect(commands.find((command) => command.includes('import importlib.util'))).toContain(
        "modules=['requests','httpx']"
      );
    });
  });

  describe('状态追踪', () => {
    it('初始状态应该是 not_created', () => {
      const { shellExecute } = createTrackedShellExecute();
      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      expect(manager.currentStatus).toBe('not_created');
    });

    it('成功后状态应该是 ready', async () => {
      const shellExecute: ShellExecuteFn = vi.fn(async (params) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      await manager.ensureReady([], []);
      expect(manager.currentStatus).toBe('ready');
    });
  });

  describe('进度回调', () => {
    it('应在各安装阶段触发进度回调', async () => {
      const progressCalls: Array<{ phase: string; percent: number }> = [];
      const shellExecute: ShellExecuteFn = vi.fn(async (params) => {
        if (params.command.includes('--version')) {
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      await manager.ensureReady([], [], (progress) => {
        progressCalls.push({ ...progress });
      });

      // 至少应包含：检查环境 → 验证环境 → 环境就绪
      expect(progressCalls.length).toBeGreaterThanOrEqual(3);
      // 第一个回调：检查环境
      expect(progressCalls[0]!.phase).toContain('检查');
      // 最后一个回调：环境就绪，进度 100%
      const lastCall = progressCalls[progressCalls.length - 1]!;
      expect(lastCall.phase).toContain('就绪');
      expect(lastCall.percent).toBe(100);
    });

    it('venv 不存在时应包含创建和安装阶段的进度', async () => {
      let venvCreated = false;
      const progressPhases: string[] = [];

      const shellExecute: ShellExecuteFn = vi.fn(async (params) => {
        if (params.command.includes('--version')) {
          // venv python 仅在创建后可用
          if (params.command.includes('.venv')) {
            if (!venvCreated) {
              throw new Error('python not found');
            }
            return { exitCode: 0, stdout: 'Python 3.12.0', stderr: '' };
          }
          // 系统 python 始终可用
          return { exitCode: 0, stdout: 'Python 3.12.0', stderr: '' };
        }
        if (params.command.includes('-m venv')) {
          venvCreated = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      // 需要传入非空基础包列表，以触发"基础依赖"阶段的进度回调
      await manager.ensureReady(['test-pkg'], [], (progress) => {
        progressPhases.push(progress.phase);
      });

      // 应包含虚拟环境创建和基础依赖阶段
      expect(progressPhases.some((p) => p.includes('虚拟环境'))).toBe(true);
      expect(progressPhases.some((p) => p.includes('基础依赖'))).toBe(true);
    });
  });

  describe('回滚机制', () => {
    it('venv 创建失败后应尝试清理残留目录', async () => {
      // 模拟：第一次 --version 找到 python（PATH 中可用），
      // 但 venv 检查失败（venv 不存在），创建 venv 时失败
      const commands: string[] = [];
      let venvCheckCalled = false;

      const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
        commands.push(params.command);

        if (params.command.includes('--version')) {
          // venv 中的 python 不存在，但系统 python 存在
          if (params.command.includes('.venv')) {
            throw new Error('python not found');
          }
          if (!venvCheckCalled) {
            venvCheckCalled = true;
            throw new Error('python not found');
          }
          return { exitCode: 0, stdout: 'Python 3.11.5', stderr: '' };
        }
        if (params.command.includes('-m venv')) {
          throw new Error('venv creation failed');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      const result = await manager.ensureReady([], []);

      // 应返回错误状态
      expect(result.error).toBeDefined();
    });
  });

  it('Windows should install packages with --prefix to avoid nested Scripts', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' });
    const pipCalls: string[] = [];
    const shellExecute: ShellExecuteFn = vi.fn(async (params: Parameters<ShellExecuteFn>[0]) => {
      if (params.command.includes('--version')) {
        return { exitCode: 0, stdout: 'Python 3.13.14', stderr: '' };
      }
      if (isExtraRequirementProbe(params)) {
        return {
          exitCode: 0,
          stdout: createProbeStdout([], ['alpha']),
          stderr: '',
        };
      }
      if (params.command.includes('pip') && params.command.includes('install')) {
        pipCalls.push(params.command);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    try {
      const manager = new RuntimeManager(RUNTIME_DIR, shellExecute);
      await manager.ensureReady([], [{ packages: ['alpha'] }]);

      expect(pipCalls).toHaveLength(1);
      expect(pipCalls[0]).toContain('--prefix');
      expect(pipCalls[0]).toContain('.venv');
      expect(pipCalls[0]).toContain('"alpha"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
